// Helpers shared by the single-channel (pipeline.ts) and split-screen
// (pipeline-split.ts) transcode pipelines. The two pipelines keep separate
// decode/compose loops on purpose - those access patterns differ - but the
// muxer plumbing and a few tiny utilities are identical, so they live here.

import { throwIfCancelled } from "../abort-signals.js";
import {
    AudioSample,
    AudioSampleSink,
    AudioSampleSource,
    CanvasSource,
    EncodedAudioPacketSource,
    type EncodedPacket,
    EncodedPacketSink,
    Input,
    Mp4OutputFormat,
    Output,
    StreamTarget,
    VideoSampleSource,
    type AudioCodec,
} from "mediabunny";

import { createLogger } from "../log.js";
import type { VideoEncodingDiagnostics } from "./encoder-diagnostics.js";
import { h264EncodingConfig } from "./h264-encoding.js";
import { createExportHeartbeat } from "./export-heartbeat.js";
import { isSourceReadError } from "../source-read-error.js";
import { getInputTimeOrigin } from "../media-time.js";
import type { AudioTrackFormat } from "../export-range.js";
import { type AdpcmAudioReader, openAdpcmAudioAuto } from "./adpcm-audio.js";
import { createEncodeAudioSource, resolveEncodeAudioCodec } from "./capabilities.js";
import {
    type AudioRangeCursor,
    getPrimaryAudioTrackWithPackets,
    MIN_PARTIAL_AUDIO_FEED_SEC,
    resolveReadableAudioPlan,
} from "./audio-export-support.js";
import { createRetryingBlobSource } from "../retrying-blob-source.js";
import { VIDEO_INPUT_FORMATS } from "../video-formats.js";
import { drawMapOverlay } from "./map-overlay.js";
import type {
    CapturedMoovBytes,
    HardwareAccelerationResolver,
    OverlayMapPipelineOpts,
    TranscodeProgress,
    TranscodeResult,
} from "./types.js";

const log = createLogger("transcode:finalize");

/**
 * Bitrate (kbit/s) an output actually came out at, for the done-line next to the
 * requested figure. Includes the audio track and container overhead, so it reads
 * slightly above the video-only request even on a perfect match - it is a
 * "did the encoder land anywhere near what we asked" signal, not a measurement.
 * 0 for a zero-length output.
 */
export function achievedKbps(sizeBytes: number, durationSec: number): number {
    if (!(durationSec > 0.001)) return 0;
    return Math.round((sizeBytes * 8) / durationSec / 1000);
}

// Prefer copies for common source codecs; the actual packet/configuration must
// still pass the muxer probe (e.g. AAC Main is readable but not copyable).
const PASSTHROUGH_AUDIO_CODECS: readonly AudioCodec[] = ["aac", "mp3"];

/**
 * How the re-encode export will handle audio for a range, decided once from the
 * first audio-bearing segment's probe. Three shapes:
 *  - "passthrough": the source is an already-MP4-muxable codec (AAC/MP3) and the
 *    export is real-time, so we stream-copy the encoded packets - no decode, no
 *    re-encode, no audio ENCODER needed (this is what makes audio survive on a
 *    codec-stripped Chromium that cannot encode AAC). See feedSegmentAudioCopy.
 *  - "encode": the source must be decoded and re-encoded - IMA-ADPCM (we decode
 *    it ourselves; adpcmReader non-null), or a readable-but-not-passthrough codec
 *    (rare). `codec` is the chosen encode codec (aac, or opus fallback).
 *  - "skip": no audio track is added; the reason determines the warning.
 */
export type AudioPlan =
    | { mode: "passthrough"; codec: AudioCodec; source: EncodedAudioPacketSource }
    | {
          mode: "encode";
          codec: AudioCodec;
          source: AudioSampleSource;
          silenceFormat: SilenceFormat;
          adpcmReader: AdpcmAudioReader | null;
      }
    | { mode: "skip"; reason: "unsupported" | "no-encoder" };

/** An AudioPlan that actually produces an output track (passthrough or encode) -
 *  i.e. AudioPlan minus the "skip" case. The pipelines store this after handling
 *  skip, so the per-segment feed dispatch narrows to passthrough vs encode
 *  without TS seeing the field-less skip variant. */
export type ActiveAudioPlan = Exclude<AudioPlan, { mode: "skip" }>;

/**
 * Decides the AudioPlan for a re-encode range from the probe of the first
 * audio-bearing segment. Shared by the single-channel and split-screen pipelines
 * so the passthrough-vs-encode-vs-drop decision lives in one place.
 *
 * `allowPassthrough` is the speed gate: stream-copy keeps the source packet
 * timestamps, so it is only valid at real time (1x). At a timelapse speed audio
 * is dropped upstream anyway, but the gate keeps this correct if that ever
 * changes. `firstHasDecoderConfig` (from probeAudioUniformity) reports whether the
 * first audio-bearing track actually carries a decoder config; a readable codec
 * without one cannot be stream-copied. Readable tracks are checked against the
 * muxer, then a real decoded sample before choosing re-encoding. Caller still
 * owns addAudioTrack() and the segment feed loop.
 */
export async function resolveAudioPlan(
    probeFormat: AudioTrackFormat,
    firstFile: File,
    allowPassthrough: boolean,
    firstHasDecoderConfig: boolean,
    opts: { input?: Input; signal?: AbortSignal } = {},
): Promise<AudioPlan> {
    throwIfCancelled(opts.signal);
    // IMA-ADPCM (Mio/Navman): mediabunny reports no codec. Decode it ourselves,
    // then re-encode - so this path needs an audio encoder.
    if (probeFormat.codec === null) {
        const adpcmReader = await openAdpcmAudioAuto(firstFile);
        if (!adpcmReader) return { mode: "skip", reason: "unsupported" };
        const codec = await resolveEncodeAudioCodec();
        if (!codec) return { mode: "skip", reason: "no-encoder" };
        return {
            mode: "encode",
            codec,
            source: createEncodeAudioSource(codec),
            silenceFormat: { sampleRate: adpcmReader.sampleRate, numberOfChannels: adpcmReader.channels },
            adpcmReader,
        };
    }
    if (!firstHasDecoderConfig) return { mode: "skip", reason: "unsupported" };
    const input =
        opts.input ??
        new Input({ source: createRetryingBlobSource(firstFile, opts.signal), formats: VIDEO_INPUT_FORMATS });
    try {
        const track = await input.getPrimaryAudioTrack();
        if (!track) return { mode: "skip", reason: "unsupported" };
        const plan = await resolveReadableAudioPlan(
            track,
            allowPassthrough && PASSTHROUGH_AUDIO_CODECS.includes(probeFormat.codec),
            opts.signal,
        );
        return plan.mode === "encode" ? { ...plan, adpcmReader: null } : plan;
    } finally {
        if (!opts.input) input.dispose();
    }
}

export interface AudioPlanSetup {
    /** Active plan (encode/passthrough), or null when audio was dropped or absent. */
    audioPlan: ActiveAudioPlan | null;
    /** Audio requested but segments mix formats - dropped, surfaced to the user. */
    audioDroppedHeterogeneous: boolean;
    /** Audio requested but no encoder and not stream-copyable - dropped, surfaced. */
    audioDroppedNoEncoder: boolean;
    /** Audio could neither be copied nor decoded by the available decoder. */
    audioDroppedUnsupported: boolean;
}

/**
 * Turns a probeAudioUniformity result into the audio decision shared by both
 * pipelines: heterogeneous audio is dropped, a uniform audio-bearing set gets a
 * resolved plan (passthrough/encode/skip) whose track is added to `out`. This is
 * the audio-orchestration block that was otherwise copy-pasted between the
 * single-channel and split pipelines. The probe itself stays in each caller
 * (single-channel reuses its firstInput; split opens Inputs lazily), which also
 * keeps this module free of a value import of probeAudioUniformity from export.js
 * - that would close an export -> pipeline -> pipeline-common cycle.
 *
 * @param allowPassthrough - true only at speed 1 (passthrough is real-time only).
 */
export async function applyAudioPlan(
    out: Output,
    probe: { uniform: boolean; format: AudioTrackFormat | null; firstHasDecoderConfig: boolean },
    firstFile: File,
    allowPassthrough: boolean,
    opts: { input?: Input; signal?: AbortSignal } = {},
): Promise<AudioPlanSetup> {
    const setup: AudioPlanSetup = {
        audioPlan: null,
        audioDroppedHeterogeneous: false,
        audioDroppedNoEncoder: false,
        audioDroppedUnsupported: false,
    };
    if (!probe.uniform) {
        setup.audioDroppedHeterogeneous = true;
        log.warn("mixed audio formats across segments, exporting without audio");
        return setup;
    }
    if (!probe.format) {
        log.info("audio requested but no audio track in any source segment, skipping");
        return setup;
    }
    const plan = await resolveAudioPlan(probe.format, firstFile, allowPassthrough, probe.firstHasDecoderConfig, opts);
    if (plan.mode === "skip") {
        if (plan.reason === "no-encoder") {
            setup.audioDroppedNoEncoder = true;
            log.warn("no audio encoder available, exporting without audio");
        } else {
            setup.audioDroppedUnsupported = true;
            log.warn("audio cannot be copied or decoded, exporting without audio");
        }
        return setup;
    }
    setup.audioPlan = plan;
    out.addAudioTrack(plan.source);
    log.debug("audio plan", {
        mode: plan.mode,
        outputCodec: plan.codec,
        sourceCodec: probe.format.codec ?? "ima-adpcm",
    });
    return setup;
}

/**
 * Audio format used to fill gaps with silence. Mutable on purpose: it tracks the
 * first decoded sample's ACTUAL format (see feedSegmentAudio). The container
 * probe (probeAudioUniformity) can misreport it - HE-AAC/SBR decodes at a
 * different rate than its AudioSpecificConfig declares - so silence keyed off the
 * probe would mismatch the real samples and trip the source's input-constancy
 * guard. The pipelines init it from the probe (the best guess before any sample
 * is decoded) and pass the same object to every feedSegmentAudio call.
 */
export interface SilenceFormat {
    sampleRate: number;
    numberOfChannels: number;
}

/** Options shared by feedSegmentAudio and openSegmentAudioCursor. */
export interface SegmentAudioOptions {
    audioSource: AudioSampleSource;
    input: Input;
    startInFile: number;
    fileDurationSec: number;
    segBaseOutSec: number;
    silenceFormat: SilenceFormat;
    signal: AbortSignal;
    fileName: string;
    onTruncated: () => void;
}

/**
 * Feeds one segment's audio to the AAC source, mapping source-file time onto the
 * output timeline (samples land at segBaseOutSec + their offset from
 * startInFile). The source's `transform` resamples each native sample to 48k/2.
 * A segment with no audio, including an audio track without packets, is filled
 * with explicit silence. mediabunny's audio sources pad a gap only when the
 * next sample arrives, as one buffer spanning the whole gap, and never pad the
 * track end; chunked silence keeps memory bounded, lets the muxer keep draining
 * the video, and ends a trailing audio-less segment with its video. A WebCodecs
 * decode error on a damaged tail ends this segment's audio gracefully
 * (onTruncated) rather than aborting the whole export, matching the video
 * loops' tolerant drive.
 *
 * silenceFormat is a SHARED MUTABLE holder (see SilenceFormat). On the first real
 * decoded sample this updates it to the sample's actual format, so silence for
 * later gaps matches the real samples - the source guard rejects a mid-track
 * input-format change, and silence is just another input fed before the
 * transform. (A leading audio-less segment, before any sample is decoded, still
 * uses the probe format; the only residual mismatch is HE-AAC source + a LEADING
 * gap, doubly rare and a loud failure, not silent corruption.)
 *
 * Caller owns `input` (open + dispose).
 */
export async function feedSegmentAudio(opts: SegmentAudioOptions & { endInFile: number }): Promise<void> {
    const cursor = await openSegmentAudioCursor({ ...opts, decodeEndInFile: opts.endInFile });
    try {
        await cursor.finish(opts.endInFile);
    } finally {
        await cursor.close();
    }
}

/**
 * Incremental form of feedSegmentAudio for a stream-copy export, whose segment
 * end is known only after its video walk. Cursor times are file times, like
 * startInFile. `decodeEndInFile` bounds decoding when the end is known up front;
 * without it the decoder reads ahead toward the file end, a few packets past
 * what the cursor consumes, until `finish` or `close` stops it.
 *
 * Caller owns `input` and must `close` the cursor if it does not `finish` it.
 */
export async function openSegmentAudioCursor(
    opts: SegmentAudioOptions & { decodeEndInFile?: number },
): Promise<AudioRangeCursor> {
    const { audioSource, input, startInFile, segBaseOutSec, silenceFormat, signal, fileName, onTruncated } = opts;
    const audioTrack = await getPrimaryAudioTrackWithPackets(input);
    if (!audioTrack) return openSilenceCursor(audioSource, startInFile, segBaseOutSec, silenceFormat, signal);

    const origin = await getInputTimeOrigin(input);
    const rangeStart = startInFile + origin;
    const fileEnd = opts.fileDurationSec + origin;
    const decodeEnd = opts.decodeEndInFile === undefined ? Infinity : opts.decodeEndInFile + origin;
    const audioIter = new AudioSampleSink(audioTrack).samples(rangeStart, decodeEnd)[Symbol.asyncIterator]();
    const decodeProgress: DecodeProgress = {
        startTimestamp: rangeStart,
        // An unbounded decode is a decode to the file end, the only place where
        // nextTolerant accepts a damaged tail.
        endTimestamp: Number.isFinite(decodeEnd) ? decodeEnd : fileEnd,
        fileEndTimestamp: fileEnd,
        lastSampleEnd: null,
    };
    // The decoded sample that reaches past the last feedBefore limit, with the
    // frames of it already fed. Its rest waits for a later limit or finish.
    let pending: PartlyFedSample | null = null;
    let isExhausted = false;
    let isClosed = false;

    const pull = async (): Promise<PartlyFedSample | null> => {
        if (pending) {
            const current = pending;
            pending = null;
            return current;
        }
        if (isExhausted) return null;
        const next = await nextTolerant(audioIter, decodeProgress);
        if (!next.done) return { sample: next.value, fedFrames: 0 };
        isExhausted = true;
        if (next.truncated) {
            onTruncated();
            log.warn("audio decode stopped early", { file: fileName, err: next.error });
        }
        return null;
    };

    // Feeds frames [fromFrame, toFrame) of `sample` that start at or after
    // rangeStart. The caller closes the sample.
    const feedFrames = async (sample: AudioSample, fromFrame: number, toFrame: number): Promise<void> => {
        throwIfCancelled(signal);
        // Track the real decoded format so silence for later gaps matches it
        // (the container probe can misreport HE-AAC/SBR - see SilenceFormat).
        if (
            sample.sampleRate !== silenceFormat.sampleRate ||
            sample.numberOfChannels !== silenceFormat.numberOfChannels
        ) {
            silenceFormat.sampleRate = sample.sampleRate;
            silenceFormat.numberOfChannels = sample.numberOfChannels;
        }
        const firstFrame = Math.max(fromFrame, frameAt(sample, rangeStart));
        const endFrame = Math.min(toFrame, sample.numberOfFrames);
        if (endFrame <= firstFrame) return;
        const trimmed = firstFrame > 0 || endFrame < sample.numberOfFrames ? sample.trim(firstFrame, endFrame) : sample;
        // The source reads the sample throughout its (awaited) add, so closing
        // only after it resolves is safe.
        try {
            trimmed.setTimestamp(Math.max(0, segBaseOutSec + trimmed.timestamp - rangeStart));
            await audioSource.add(trimmed);
        } finally {
            if (trimmed !== sample) trimmed.close();
        }
    };

    const close = async (): Promise<void> => {
        if (isClosed) return;
        isClosed = true;
        pending?.sample.close();
        pending = null;
        await audioIter.return?.();
    };

    return {
        async feedBefore(untilInFile) {
            const until = untilInFile + origin;
            while (!isClosed) {
                const current = await pull();
                if (!current) return;
                const { sample } = current;
                const untilFrame = frameAt(sample, until);
                if (untilFrame < sample.numberOfFrames) {
                    // The limit falls inside this sample. Codec frames are short
                    // enough to wait whole, but PCM decodes one container chunk
                    // per sample, and a file may store its whole track as one
                    // chunk. Feed a long enough head so the video keeps draining.
                    pending = current;
                    if ((untilFrame - current.fedFrames) / sample.sampleRate >= MIN_PARTIAL_AUDIO_FEED_SEC) {
                        await feedFrames(sample, current.fedFrames, untilFrame);
                        current.fedFrames = untilFrame;
                    }
                    return;
                }
                try {
                    await feedFrames(sample, current.fedFrames, sample.numberOfFrames);
                } finally {
                    sample.close();
                }
            }
        },
        async finish(endInFile) {
            const rangeEnd = endInFile + origin;
            decodeProgress.endTimestamp = rangeEnd;
            try {
                while (!isClosed) {
                    const current = await pull();
                    if (!current) break;
                    try {
                        if (current.sample.timestamp >= rangeEnd) break;
                        await feedFrames(current.sample, current.fedFrames, frameAt(current.sample, rangeEnd));
                    } finally {
                        current.sample.close();
                    }
                }
            } finally {
                await close();
            }
        },
        close,
    };
}

interface PartlyFedSample {
    sample: AudioSample;
    fedFrames: number;
}

/**
 * Index of the first frame of `sample` that starts at or after `timestamp`,
 * clamped to the sample. Splitting, trimming and finishing share this rounding
 * so consecutive pieces of one sample neither overlap nor leave gaps.
 */
function frameAt(sample: AudioSample, timestamp: number): number {
    const frame = Math.ceil((timestamp - sample.timestamp) * sample.sampleRate - 1e-6);
    return Math.min(sample.numberOfFrames, Math.max(0, frame));
}

/**
 * Cursor for a segment without decodable audio. Silence advances in whole
 * emitSilence chunks before `finish`, which adds the exact remainder, so the
 * segment gets the same frame count as one emitSilence call over its range.
 */
export function openSilenceCursor(
    audioSource: AudioSampleSource,
    startInFile: number,
    segBaseOutSec: number,
    silenceFormat: SilenceFormat,
    signal: AbortSignal,
): AudioRangeCursor {
    // The format cannot change inside this segment: only decoded samples update it.
    const { sampleRate, numberOfChannels } = silenceFormat;
    const chunkFrames = silenceChunkFrames(sampleRate);
    let emittedFrames = 0;
    const emitTo = async (endFrame: number): Promise<void> => {
        if (endFrame <= emittedFrames) return;
        await emitSilenceFrames(
            audioSource,
            segBaseOutSec,
            emittedFrames,
            endFrame,
            sampleRate,
            numberOfChannels,
            signal,
        );
        emittedFrames = endFrame;
    };
    let isClosed = false;
    return {
        async feedBefore(untilInFile) {
            if (isClosed || chunkFrames <= 0) return;
            const untilFrame = Math.floor((untilInFile - startInFile) * sampleRate);
            await emitTo(emittedFrames + Math.floor((untilFrame - emittedFrames) / chunkFrames) * chunkFrames);
        },
        async finish(endInFile) {
            if (isClosed) return;
            isClosed = true;
            await emitTo(Math.floor((endInFile - startInFile) * sampleRate));
        },
        async close() {
            isClosed = true;
        },
    };
}

/**
 * IMA-ADPCM counterpart of feedSegmentAudio: feeds one segment's audio when the
 * source codec is the Mio/Navman ADPCM that mediabunny cannot read. `reader` is
 * this segment's decoder (the caller reuses the probed audio-bearing file's
 * reader and opens other files separately); null means the segment has
 * no ADPCM audio, so its span is filled with silence to keep A/V aligned.
 *
 * Decodes the file-time range [startInFile, endInFile) to PCM-s16 and feeds it to
 * the AAC source at segBaseOutSec on the output timeline; the source's transform
 * resamples 32 kHz -> 48 kHz before the AAC encode. Mirrors feedSegmentAudio's
 * silence/alignment contract so the two audio paths are interchangeable.
 */
export async function feedSegmentAudioAdpcm(opts: {
    audioSource: AudioSampleSource;
    reader: AdpcmAudioReader | null;
    startInFile: number;
    endInFile: number;
    segBaseOutSec: number;
    silenceFormat: SilenceFormat;
    signal: AbortSignal;
}): Promise<void> {
    const { audioSource, reader, startInFile, endInFile, segBaseOutSec, silenceFormat, signal } = opts;
    if (!reader) {
        await emitSilence(
            audioSource,
            segBaseOutSec,
            endInFile - startInFile,
            silenceFormat.sampleRate,
            silenceFormat.numberOfChannels,
            signal,
        );
        return;
    }
    await reader.feedRange(audioSource, startInFile, endInFile, segBaseOutSec, signal);
}

/**
 * Copies AAC/MP3 onto the segment's video timeline, preserving any initial audio
 * delay. Encoded packets cannot be trimmed, so boundary overlaps are omitted
 * rather than shifting all later audio and accumulating drift across files.
 * An audio-less segment leaves a gap. The caller owns the input and carries
 * the last emitted end and decoder-config state across segments.
 */
export async function feedSegmentAudioCopy(opts: {
    audioSource: EncodedAudioPacketSource;
    input: Input;
    startInFile: number;
    endInFile: number;
    segBaseOutSec: number;
    audioLastEndSec: number;
    pushDecoderConfig: boolean;
    signal: AbortSignal;
    onTruncated: () => void;
}): Promise<{ audioLastEndSec: number; configPushed: boolean }> {
    const { audioSource, input, startInFile, endInFile, segBaseOutSec, signal, onTruncated } = opts;
    const audioTrack = await input.getPrimaryAudioTrack();
    // No audio in this segment: leave a gap, keep the timeline where it was.
    if (!audioTrack) return { audioLastEndSec: opts.audioLastEndSec, configPushed: false };

    const decoderConfig = opts.pushDecoderConfig ? await audioTrack.getDecoderConfig() : null;
    const sink = new EncodedPacketSink(audioTrack);
    const origin = await getInputTimeOrigin(input);
    const rangeStart = startInFile + origin;
    const rangeEnd = endInFile + origin;

    // A track can begin after the in-point; null means there is no earlier
    // packet, not that the track is empty.
    let startPacket: EncodedPacket | null;
    try {
        startPacket = (await sink.getPacket(rangeStart)) ?? (await sink.getFirstPacket());
    } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        if (isSourceReadError(err)) throw err;
        onTruncated();
        return { audioLastEndSec: opts.audioLastEndSec, configPushed: false };
    }
    if (!startPacket) return { audioLastEndSec: opts.audioLastEndSec, configPushed: false };

    let lastEnd = opts.audioLastEndSec;
    let configPushed = false;
    let pkt: EncodedPacket | null = startPacket;
    while (pkt) {
        throwIfCancelled(signal);
        if (pkt.timestamp >= rangeEnd) break;
        const timestamp = segBaseOutSec + pkt.timestamp - rangeStart;
        // Encoded boundary packets cannot be trimmed. Omit an overlapping packet
        // instead of moving all later audio and accumulating drift at every file.
        if (timestamp >= lastEnd - 1e-6) {
            const shifted = pkt.clone({ timestamp: Math.max(0, timestamp) });
            const meta =
                opts.pushDecoderConfig && !configPushed ? { decoderConfig: decoderConfig ?? undefined } : undefined;
            await audioSource.add(shifted, meta);
            if (opts.pushDecoderConfig && !configPushed) configPushed = true;
            lastEnd = shifted.timestamp + shifted.duration;
        }
        try {
            pkt = await sink.getNextPacket(pkt);
        } catch (err) {
            if (err instanceof Error && err.name === "AbortError") throw err;
            if (isSourceReadError(err)) throw err;
            onTruncated();
            break;
        }
    }
    return { audioLastEndSec: lastEnd, configPushed };
}

/**
 * The acceleration a pipeline creates its video encoder with: the late
 * resolver's answer when the caller supplied one (see
 * HardwareAccelerationResolver), otherwise the fixed output preference.
 * Rechecks cancellation because the wait can outlast an abort that the
 * resolver itself did not observe.
 */
export async function resolveVideoEncoderAcceleration(
    resolveHardwareAcceleration: HardwareAccelerationResolver | undefined,
    outputPreference: HardwareAcceleration | undefined,
    signal: AbortSignal,
): Promise<HardwareAcceleration | undefined> {
    if (!resolveHardwareAcceleration) return outputPreference;
    const hardwareAcceleration = await resolveHardwareAcceleration();
    throwIfCancelled(signal);
    return hardwareAcceleration;
}

/**
 * H.264 source bound to the composition canvas: the encode loop calls
 * `add(timestamp, duration)` and mediabunny captures the canvas state at that
 * call (no per-frame VideoSample to allocate and close). Used wherever every
 * frame is composited - the split pipeline, and single-channel exports that
 * paint anything on top of the video.
 */
export function createH264VideoSource(
    canvas: OffscreenCanvas,
    bitrate: number,
    diagnostics: VideoEncodingDiagnostics,
    hardwareAcceleration: HardwareAcceleration = "no-preference",
): CanvasSource {
    return new CanvasSource(canvas, {
        ...h264EncodingConfig(bitrate, hardwareAcceleration),
        onEncoderConfig: diagnostics.onEncoderConfig,
        onEncodedPacket: diagnostics.onEncodedPacket,
    });
}

/**
 * H.264 source fed whole VideoSamples. Same encoder config as the canvas
 * flavour; the difference is upstream - a decoded frame that needs no
 * compositing can go to the encoder as-is, skipping the decode -> RGBA canvas ->
 * capture round trip (two colour conversions and a texture copy per frame). The
 * caller wraps its canvas in a VideoSample for the frames that DO need
 * compositing, which is exactly what CanvasSource does internally.
 */
export function createH264SampleSource(
    bitrate: number,
    diagnostics: VideoEncodingDiagnostics,
    hardwareAcceleration: HardwareAcceleration = "no-preference",
): VideoSampleSource {
    return new VideoSampleSource({
        ...h264EncodingConfig(bitrate, hardwareAcceleration),
        onEncoderConfig: diagnostics.onEncoderConfig,
        onEncodedPacket: diagnostics.onEncodedPacket,
    });
}

/**
 * Awaits a map-snapshot promise and paints the bitmap. Owns the shared
 * failure policy both pipelines must agree on:
 *  - AbortError is rethrown (cancellation belongs to the caller);
 *  - any other failure returns true ("disable the map overlay for the rest of
 *    the run") - the overlay is opt-in cosmetic, losing a 4-minute export to
 *    a tile-server hiccup is a bad trade.
 * The bitmap is NOT closed here: it belongs to the pipeline's reusing
 * snapshotter (map-snapshot-camera.ts), which may hand the same bitmap to
 * several frames and releases it itself.
 */
export async function consumeMapSnapshot(
    ctx: OffscreenCanvasRenderingContext2D,
    widthPx: number,
    heightPx: number,
    mapOpts: OverlayMapPipelineOpts,
    snapPromise: Promise<ImageBitmap>,
    framesDone: number,
): Promise<boolean> {
    try {
        const bitmap = await snapPromise;
        drawMapOverlay(ctx, bitmap, widthPx, heightPx, mapOpts);
        return false;
    } catch (mapErr) {
        if (mapErr instanceof Error && mapErr.name === "AbortError") throw mapErr;
        log.warn("map overlay disabled after snapshot failure", { err: String(mapErr), framesDone });
        return true;
    }
}

/** Rounds to 2 decimals - for human-readable seconds in log lines. */
export function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/** Result of nextTolerant: a value, or a graceful end that may be a decode
 *  truncation (truncated=true) rather than a clean end-of-stream. */
export type TolerantNext<T> =
    | { done: false; value: T }
    | { done: true; truncated: false }
    | { done: true; truncated: true; error: string };

export interface DecodeProgress {
    startTimestamp: number;
    endTimestamp: number;
    fileEndTimestamp: number;
    lastSampleEnd: number | null;
    segmentIndex?: number;
    slot?: number;
    /** Source seconds between consecutive yielded samples when the iterator
     *  decodes only selected frames (timelapse, see timelapse-decode.ts). A
     *  dense decode would have reached up to this much further before the
     *  same failure, all of it frames the selection drops anyway, so the
     *  tolerated tail grows by it. Absent for a dense decode. */
    sparseSpacingSec?: number;
}

// Bound tolerated loss; a decoder error alone does not prove a damaged GOP.
const MAX_DECODE_TAIL_LOSS_SEC = 2;

/** Accepts only a small missing tail at the physical file end. Runtime decoder
 * failures elsewhere must not silently discard the rest of a segment. */
export async function nextTolerant<T extends { timestamp: number; duration: number }>(
    iterator: AsyncIterator<T>,
    progress: DecodeProgress,
): Promise<TolerantNext<T>> {
    try {
        const r = await iterator.next();
        if (r.done) return { done: true, truncated: false };
        progress.lastSampleEnd = r.value.timestamp + r.value.duration;
        return { done: false, value: r.value };
    } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        if (isSourceReadError(err)) throw err;
        const lastEnd = progress.lastSampleEnd;
        const remaining = lastEnd === null ? Infinity : progress.fileEndTimestamp - lastEnd;
        const maxLoss =
            Math.min(MAX_DECODE_TAIL_LOSS_SEC, (progress.endTimestamp - progress.startTimestamp) * 0.1) +
            (progress.sparseSpacingSec ?? 0);
        const isDecodeError = err instanceof Error && err.name === "EncodingError";
        const isSmallTail =
            lastEnd !== null &&
            Number.isFinite(lastEnd) &&
            lastEnd > progress.startTimestamp &&
            Number.isFinite(remaining) &&
            remaining >= 0 &&
            remaining <= maxLoss &&
            Math.abs(progress.endTimestamp - progress.fileEndTimestamp) < 0.001;
        if (!isDecodeError || !isSmallTail) {
            log.error("decode failed before a recoverable tail", {
                ...progress,
                errKind: err instanceof Error ? err.name : "unknown",
                err: err instanceof Error ? err.message : String(err),
            });
            throw err;
        }
        return { done: true, truncated: true, error: err.message };
    }
}

/** Cancels the muxer output, swallowing any error - used on abort/failure
 *  paths where the original error (or AbortError) is what we care about. */
async function cancelOutputQuietly(out: Output): Promise<void> {
    try {
        await out.cancel();
    } catch {
        /* ignore */
    }
}

/**
 * Discards a partial output on a failed or cancelled transcode: aborts the
 * writable FIRST, then cancels the muxer. The order is the point - Output.cancel()
 * closes its target, and for an FSA-backed sink close means COMMIT: a
 * minutes-long flush of a moov-less, unplayable file over the destination the
 * user picked. Aborting first drops the temp file and turns that close into a
 * no-op. Both steps swallow their errors - the caller rethrows the original
 * failure (or AbortError), which is the only one worth surfacing.
 */
export async function discardOutputQuietly(out: Output, writable: FileSystemWritableFileStream): Promise<void> {
    try {
        await writable.abort("transcode failed or cancelled");
    } catch {
        /* writable already terminal */
    }
    await cancelOutputQuietly(out);
}

// Silence is emitted in 100 ms samples so encoder backpressure applies and
// memory stays bounded.
const SILENCE_CHUNK_SEC = 0.1;

function silenceChunkFrames(sampleRate: number): number {
    return Math.floor(sampleRate * SILENCE_CHUNK_SEC);
}

/**
 * Emits silence into audioSource - a sequence of zero-filled AudioSamples of
 * durationSec starting at offsetSec in the output timeline, in 100 ms chunks.
 * Both pipelines call this for a segment whose source has no audio track, to
 * keep A/V in sync.
 */
export async function emitSilence(
    audioSource: AudioSampleSource,
    offsetSec: number,
    durationSec: number,
    sampleRate: number,
    channels: number,
    signal: AbortSignal,
): Promise<void> {
    await emitSilenceFrames(
        audioSource,
        offsetSec,
        0,
        Math.floor(durationSec * sampleRate),
        sampleRate,
        channels,
        signal,
    );
}

/**
 * Emits silent frames [fromFrame, toFrame) of a span that starts at offsetSec.
 * Frame indexes, rather than seconds, let consecutive calls continue one span
 * without rounding gaps or overlaps.
 */
async function emitSilenceFrames(
    audioSource: AudioSampleSource,
    offsetSec: number,
    fromFrame: number,
    toFrame: number,
    sampleRate: number,
    channels: number,
    signal: AbortSignal,
): Promise<void> {
    const framesPerChunk = silenceChunkFrames(sampleRate);
    if (framesPerChunk <= 0) return;
    // Every sample is read-only silence; its backing storage can be shared.
    const data = new Float32Array(framesPerChunk * channels);
    for (let frame = fromFrame; frame < toFrame; frame += framesPerChunk) {
        throwIfCancelled(signal);
        const thisFrames = Math.min(framesPerChunk, toFrame - frame);
        const sample = new AudioSample({
            data: thisFrames === framesPerChunk ? data : data.subarray(0, thisFrames * channels),
            // Interleaved f32 (all zeros). sampleRate/channels match the real
            // source samples (caller passes the probed format), so the source's
            // input-constancy guard sees one uniform format across silence and
            // audio; the layout (f32 vs planar) is abstracted by the encoder.
            format: "f32",
            numberOfChannels: channels,
            sampleRate,
            timestamp: offsetSec + frame / sampleRate,
        });
        try {
            await audioSource.add(sample);
        } finally {
            sample.close();
        }
    }
}

/**
 * Builds the throttled "transcoding" progress callback shared by both
 * pipelines. The returned function reports at most once per 200 ms (unless
 * force=true) and computes ETA from the average frame time since creation, so
 * it must be created right before the encode loop starts (its internal clock
 * baseline is the moment of the call). Also owns the worker-side export
 * heartbeat - progress calls are the one place both pipelines already deliver
 * framesDone and bytesWritten.
 */
export function createTranscodeProgressReporter(
    framesTotal: number,
    onProgress: (p: TranscodeProgress) => void,
): (framesDone: number, bytesWritten: number, force: boolean) => void {
    let lastProgressMs = 0;
    const startMs = performance.now();
    const heartbeat = createExportHeartbeat(createLogger("transcode"));
    return (framesDone, bytesWritten, force) => {
        heartbeat(framesDone, bytesWritten);
        const now = performance.now();
        if (!force && now - lastProgressMs < 200) return;
        lastProgressMs = now;
        const elapsed = now - startMs;
        const eta = framesDone < 30 ? -1 : Math.round(((framesTotal - framesDone) * elapsed) / framesDone / 1000);
        onProgress({
            stage: "transcoding",
            stageProgress: framesDone / framesTotal,
            totalProgress: framesDone / framesTotal,
            framesDone,
            framesTotal,
            etaSec: eta,
            bytesWritten,
        });
    };
}

/**
 * Shared finalize epilogue for both pipelines: re-checks abort (cancelling the
 * output and throwing AbortError), emits the two "finalizing" progress ticks
 * around out.finalize(), and returns the TranscodeResult. Callers log their
 * own done-line (logger name and durationSec source differ) after this returns.
 */
export async function finalizeTranscodeOutput(opts: {
    out: Output;
    writable: FileSystemWritableFileStream;
    signal: AbortSignal;
    onProgress: (p: TranscodeProgress) => void;
    framesDone: number;
    framesTotal: number;
    getBytesWritten: () => number;
    durationSec: number;
}): Promise<TranscodeResult> {
    const { out, writable, signal, onProgress, framesDone, framesTotal, getBytesWritten, durationSec } = opts;

    if (signal.aborted) {
        await discardOutputQuietly(out, writable);
        throw new DOMException("aborted", "AbortError");
    }

    if (framesDone === 0) {
        await discardOutputQuietly(out, writable);
        throw new Error("no video frames could be exported");
    }

    onProgress({
        stage: "finalizing",
        stageProgress: 0,
        totalProgress: framesDone / framesTotal,
        framesDone,
        framesTotal,
        etaSec: 0,
        bytesWritten: getBytesWritten(),
    });

    // Breadcrumbs around finalize: encoder flush + moov write + writable close
    // all happen inside out.finalize(). Pairing these two lines (with the
    // elapsed ms) lets a "stuck at Finalizing" report show whether finalize
    // even returned - i.e. moov+close completed - or hung. The actual close
    // watchdog lives in the writable wrapper (writable-finalize.ts).
    const finalizeStartMs = performance.now();
    log.debug("finalize start", { framesDone, bytesWritten: getBytesWritten() });
    try {
        await out.finalize();
    } catch (err) {
        await discardOutputQuietly(out, writable);
        throw err;
    }
    const bytesWritten = getBytesWritten();
    log.info("finalize done", { framesDone, bytesWritten, ms: Math.round(performance.now() - finalizeStartMs) });

    onProgress({
        stage: "finalizing",
        stageProgress: 1,
        totalProgress: 1,
        framesDone,
        framesTotal,
        etaSec: 0,
        bytesWritten,
    });

    return { durationSec, sizeBytes: bytesWritten, framesEncoded: framesDone };
}

/**
 * Builds the mediabunny Output that streams the muxed MP4 into writable in
 * 4 MiB chunks, counting bytes as they go. onBytesWritten is called with each
 * chunk's size and position AFTER the write resolves. The position lets callers
 * measure file length without counting rewritten MP4 headers twice.
 *
 * byteLength is captured before write: the worker bridge transfers ownership
 * of full chunk buffers, detaching them from this scope.
 */
export function createMp4StreamOutput(
    writable: FileSystemWritableFileStream,
    signal: AbortSignal,
    onBytesWritten: (sizeBytes: number, position: number) => void,
    // Optional moov capture (fires inside finalize, when the moov box is
    // written). The pipelines relay it in TranscodeResult so the GPMF
    // post-process can skip re-reading the finished file.
    onMoov?: (bytes: Uint8Array, position: number) => void,
): Output {
    const targetWritable = new WritableStream<{ type: "write"; position: number; data: Uint8Array }>({
        async write(chunk) {
            throwIfCancelled(signal);
            const sizeBytes = chunk.data.byteLength;
            await writable.write({
                type: "write",
                position: chunk.position,
                data: chunk.data as Uint8Array<ArrayBuffer>,
            });
            onBytesWritten(sizeBytes, chunk.position);
        },
        async close() {
            await writable.close();
        },
        async abort(reason) {
            try {
                await writable.abort(reason);
            } catch {
                /* ignore */
            }
        },
    });

    return new Output({
        format: new Mp4OutputFormat({ fastStart: false, onMoov }),
        target: new StreamTarget(targetWritable, { chunked: true, chunkSize: 4 * 1024 * 1024 }),
    });
}

/** Per-run muxer accounting shared by both pipelines. Rewritten headers count
 * toward file extent once; captured moov bytes outlive the muxer's callback. */
export function createTranscodeOutput(writable: FileSystemWritableFileStream, signal: AbortSignal) {
    let bytesWritten = 0;
    let capturedMoov: CapturedMoovBytes | undefined;
    const out = createMp4StreamOutput(
        writable,
        signal,
        (sizeBytes, position) => {
            bytesWritten = Math.max(bytesWritten, position + sizeBytes);
        },
        (bytes, position) => {
            capturedMoov = { position, bytes: bytes.slice() };
        },
    );
    return {
        out,
        get bytesWritten(): number {
            return bytesWritten;
        },
        get capturedMoov(): CapturedMoovBytes | undefined {
            return capturedMoov;
        },
    };
}

/** Publish the completed preparation stage before starting either muxer. */
export async function startTranscodeOutput(
    out: Output,
    onProgress: (progress: TranscodeProgress) => void,
    framesTotal: number,
): Promise<void> {
    onProgress({
        stage: "preparing",
        stageProgress: 1,
        totalProgress: 0,
        framesDone: 0,
        framesTotal,
        etaSec: -1,
        bytesWritten: 0,
    });
    await out.start();
}

/**
 * Awaits every task, then rethrows the first rejection. Used to run a segment's
 * video and audio producers concurrently: Promise.all would surface the first
 * failure while the other task is still reading the segment's inputs (which the
 * caller's finally is about to dispose), and would leave its rejection
 * unhandled. Settling both first costs nothing on the happy path - both tasks
 * observe the same AbortSignal.
 */
export async function joinAllOrThrowFirst<T>(tasks: ReadonlyArray<Promise<T>>): Promise<T[]> {
    const results = await Promise.allSettled(tasks);
    const values: T[] = [];
    for (const r of results) {
        if (r.status === "rejected") throw r.reason;
        values.push(r.value);
    }
    return values;
}

/**
 * True when a decoded frame is already exactly the output frame, so it can go to
 * the encoder untouched instead of through the composition canvas.
 *
 * All four dimensions are compared, not just the display pair: a non-square
 * pixel aspect (coded != display), rotation or reflection is applied by
 * VideoSample.draw, and an encoder fed the raw frame would silently drop it -
 * the export would come out squashed or sideways. Callers must separately
 * establish that nothing is painted on top (overlays, watermark, blur, crop).
 */
export function frameNeedsNoComposite(
    frame: {
        rotation: number;
        flip: boolean;
        codedWidth: number;
        codedHeight: number;
        displayWidth: number;
        displayHeight: number;
    },
    outputW: number,
    outputH: number,
): boolean {
    return (
        frame.rotation === 0 &&
        !frame.flip &&
        frame.codedWidth === outputW &&
        frame.codedHeight === outputH &&
        frame.displayWidth === outputW &&
        frame.displayHeight === outputH
    );
}

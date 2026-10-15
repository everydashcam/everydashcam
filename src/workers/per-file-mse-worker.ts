// Worker for the per-file MSE backend: owns mediabunny demux + fragmented MP4
// mux + the feed loop. Main thread (src/per-file-mse.ts) owns only
// MediaSource and SourceBuffer.
//
// Why: profiling cold-start TS attach showed ~100% main thread busy time in
// mediabunny operations (readSection 49%, addEncodedVideoPacket 18%, our
// feedVideo 15%, markNextPacket 15%) for 5+ seconds. With a saturated main
// thread, MediaSource.sourceopen / SourceBuffer.updateend events sit in the
// event loop queue and do not dispatch, producing visible 4-10 sec playback
// start latency on TS and hev1 HEVC files. Moving the CPU work off the main
// thread lets these events fire on time.
//
// Protocol: see per-file-mse-protocol.ts (alongside this file).

import {
    AudioSampleSource,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    Mp4OutputFormat,
    Output,
    StreamTarget,
    type AudioCodec,
    type EncodedPacket,
    type InputAudioTrack,
    type InputVideoTrack,
    type TransformationMatrix,
    type VideoCodec,
} from "mediabunny";
import { createLogger } from "../log.js";
import { getInputTimeOrigin } from "../media-time.js";
import { cleanHvccDescription, hasVideoContent } from "../hevc-remux.js";
import { type AdpcmAudioReader, openAdpcmAudioAuto } from "../transcode/adpcm-audio.js";
import { createEncodeAudioSource, resolveEncodeAudioCodec } from "../transcode/capabilities.js";
import { createBlobSource } from "../blob-source.js";
import { VIDEO_INPUT_FORMATS } from "../video-formats.js";
import {
    MSE_NOTIFY_DROP_AUDIO,
    MSE_NOTIFY_ERROR,
    MSE_NOTIFY_FEED_DONE,
    MSE_NOTIFY_INIT_SEGMENT,
    MSE_NOTIFY_MEDIA_SEGMENT,
    MSE_NOTIFY_SEEK,
    MSE_NOTIFY_SEEK_DONE,
    MSE_NOTIFY_START_FEED,
    MSE_NOTIFY_TICK,
    MSE_REQUEST_INIT,
    type AdpcmPlaybackCodec,
    type ErrorNotificationData,
    type FeedDoneNotificationData,
    type InitRequestData,
    type InitResult,
    type InitSegmentNotificationData,
    type MediaSegmentNotificationData,
    type SeekDoneNotificationData,
    type SeekNotificationData,
    type StartFeedNotificationData,
    type TickNotificationData,
} from "./per-file-mse-protocol.js";
import { createWorkerServer, type WorkerScopeEndpoint } from "./_protocol/worker-server.js";
import { readVideoFragmentMetadata, readVideoTrackMetadata } from "./mse-fragment-metadata.js";

const log = createLogger("worker:per-file-mse");

// Baseline buffer-ahead in video seconds at playbackRate=1x. Worker pauses
// the feed while (feedEmittedUpToSec - currentTime) >= effective target. At
// higher playback rates the SAME wall-clock cushion requires N times more
// video seconds buffered - waitForBufferRoom scales this by playbackRate.
const BASE_BUFFER_AHEAD_SEC = 8;

// Hard cap on the scaled target. Above this the SourceBuffer quota (~50 MB
// desktop, ~12-50 MB mobile) becomes the dominant risk even on moderate
// bitrate; the adaptive bitrate-driven cap (BUFFER_AHEAD_QUOTA_BUDGET_BYTES
// / measuredBytesPerSec) further reduces it on high-bitrate files such as
// Juscar 4K HEVC TS (~5.8 MB/s).
const MAX_BUFFER_AHEAD_SEC = 20;

// Memory budget the worker is allowed to keep ahead of currentTime in
// SourceBuffer-equivalent bytes. Chrome's SB quota is ~50 MB on desktop; we
// reserve ~20 MB for the behind-window + the trim-loop jitter window + the
// worker's own appendQueue, and use the remaining ~30 MB to bound how far
// the feed can run ahead at the current measured bitrate.
const BUFFER_AHEAD_QUOTA_BUDGET_BYTES = 30 * 1024 * 1024;

// Lower bound for the adaptive cap so very high bitrate files do not
// collapse the cushion to zero (which would stall playback hard).
// At 5.8 MB/sec that's ~2.6 sec of ahead - tight but workable.
const MIN_ADAPTIVE_AHEAD_SEC = 2.5;

// Normal frame/codec padding differences fit inside the playback cushion.
const AUDIO_TAIL_TOLERANCE_SEC = 0.25;

// Backpressure is event-driven via feedWaiters: when MSE_NOTIFY_TICK lands
// (periodic 200 ms from main + out-of-band on every SourceBuffer updateend)
// or the audio feed advances, waitForBufferRoom re-evaluates instead of
// polling on a setTimeout. Saves the up-to-200-ms latency on updateend - on
// 8x playback that is ~1.6 sec of video the feed used to sit idle waiting
// for the next poll.

// Baseline appendQueue ceiling at 1x. Scaled by playbackRate for the same
// reason as the buffer target: at 8x, mediabunny output emits fragments
// roughly 8x faster, so a fixed-size queue starves the feed loop with
// "queue full" pauses while wall-clock SB ingestion has not actually fallen
// behind. One fMP4 fragment is one appendBuffer op; ELITE 9 4K HEVC
// fragments are ~7 MB so 12 ops = ~80 MB pending - which is also why
// MAX_APPEND_QUEUE_CAP is bounded.
const BASE_MAX_APPEND_QUEUE_LEN = 12;
const MAX_APPEND_QUEUE_CAP = 48;

declare const self: WorkerScopeEndpoint;

// Worker state. One worker = one backend = one file.
// Long-lived (set once at init, kept across seeks):
let workerFile: File | null = null;
let input: Input | null = null;
let videoTrack: InputVideoTrack | null = null;
let audioTrack: InputAudioTrack | null = null;
let videoCodec: VideoCodec | null = null;
let audioCodec: AudioCodec | null = null;
let videoDecoderConfig: VideoDecoderConfig | null = null;
let audioDecoderConfig: AudioDecoderConfig | null = null;
let audioConfigPrimingPacket: EncodedPacket | undefined;
let videoTransformationMatrix: TransformationMatrix | undefined;
let startSec = 0;
let sourceTimeOrigin = 0;
// IMA-ADPCM transcode mode (Mio/Navman): mediabunny cannot read the audio, so
// we decode it ourselves and re-encode. When set, audioTrack/audioCodec stay
// null and the audio half of the feed runs through adpcmReader instead.
let transcodeAdpcmAudio = false;
// Encode codec for the ADPCM transcode, picked at init from the main thread's
// MSE-playable preference list and the worker's encode capability. null means
// that no codec satisfies both halves, so playback continues without audio.
let adpcmEncodeCodec: "aac" | "opus" | null = null;
let adpcmReader: AdpcmAudioReader | null = null;
// Set by MSE_NOTIFY_DROP_AUDIO: main found the chosen audio codec not
// MSE-playable on this browser and rebuilt the SourceBuffer video-only, so the
// Output must skip the audio track. Read in startNewFeedCycle.
let dropAudio = false;

/**
 * Per-feed-cycle state. A new instance is created on initial start-feed and
 * on each seek. The old cycle's references stay alive in its runFeed
 * closures - so a still-running stale feed cannot pollute the new cycle's
 * pendingSegment / feedEmittedUpToSec / output. This decoupling is what lets
 * onSeek hand off to the new cycle WITHOUT awaiting feed shutdown (the
 * slow path that previously tripped a 2-sec ack timeout when two channels
 * seeked at once).
 */
interface FeedCycle {
    /** Cycle id assigned by main in start-feed. Worker echoes it in every
     * segment / seek-done message so main can ignore data emitted by a
     * cancelled previous cycle whose callbacks ran after the new cycle
     * already took over. */
    id: number;
    /** startSec at the time this cycle was created. Used as a FLOOR for
     * the currentTime value in backpressure: a stale tick reporting
     * pre-seek currentTime (which can happen between the seek arriving
     * and main's video.currentTime = target write) would otherwise drag
     * lastTick.currentTime back below the new target, making
     * ahead = feedEmittedUpToSec - lastTick.currentTime balloon past
     * the scaled target and freeze the feed indefinitely. */
    startTimestamp: number;
    abort: AbortController;
    output: Output;
    videoSource: EncodedVideoPacketSource;
    // EncodedAudioPacketSource for stream-copy (AAC/etc), AudioSampleSource for
    // the ADPCM transcode path. null when the file has no usable audio.
    audioSource: EncodedAudioPacketSource | AudioSampleSource | null;
    /** moof/ftyp etc bytes accumulated before the matching mdat/moov flush. */
    pendingSegment: Uint8Array[];
    pendingSegmentLen: number;
    /** Video PTS reached by completed fragments sent to the main thread. */
    feedEmittedUpToSec: number;
    /** If true, the first media segment also emits "seek-done" to main. */
    postSeekFirstMediaPending: boolean;
    /**
     * Adaptive bitrate estimate, cycle-scoped so a stale aborted cycle's late
     * mdat callback mutates its own dead cycle, not the new one. bytesEmitted
     * tallies moof+mdat bytes; mediaSecondsCovered tracks the max
     * feedEmittedUpToSec advance since the cycle started. waitForBufferRoom derives
     * the per-bitrate buffer-ahead cap from these two.
     */
    bytesEmitted: number;
    mediaSecondsCovered: number;
    /**
     * Highest audio timestamp the stream-copy audio feed has handed to the
     * muxer, and whether that feed has finished. feedVideo never adds a
     * packet past this mark (waitForBufferRoom): the fragmented muxer
     * finalizes a fragment only when every open track has a sample queued
     * past the keyframe that closes it, so video that outruns the audio
     * reader leaves fragments unflushed while feedEmittedUpToSec - the only
     * thing the ahead-window sees - stands still, and the feed reads the
     * whole file into the muxer (seen on 2-channel MPEG-TS: a 135 s burst
     * into the SourceBuffer and QuotaExceededError). Infinity when audio is
     * absent or transcoded, since those paths cannot starve the muxer.
     */
    audioFedUpToSec: number;
    audioFeedDone: boolean;
}

let currentCycle: FeedCycle | null = null;

// Last tick info from main, used for backpressure.
let lastTick = { currentTime: 0, appendQueueLen: 0, playbackRate: 1, appendPaused: false };
let failed = false;

// One-shot resolvers waiting for the next feed signal: an MSE_NOTIFY_TICK
// or audio-feed progress. Filled by waitForFeedSignal, drained by
// wakeFeedWaiters. Abort also resolves them (the consumer then sees
// signal.aborted and exits). Using a Set so a waiter that's already been
// resolved by a signal cannot be double-resolved by a subsequent abort.
const feedWaiters = new Set<() => void>();

function wakeFeedWaiters(): void {
    if (feedWaiters.size === 0) return;
    const fired = Array.from(feedWaiters);
    feedWaiters.clear();
    for (const w of fired) w();
}

function waitForFeedSignal(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const fire = () => {
            feedWaiters.delete(fire);
            signal.removeEventListener("abort", fire);
            resolve();
        };
        feedWaiters.add(fire);
        signal.addEventListener("abort", fire, { once: true });
    });
}

// All state-mutating handlers (start-feed and seek) must run one
// at a time. Without this gate, fast chart-drag seeks fan out into concurrent
// onSeek invocations: the second cancel() throws "Output has already been
// canceled", the second nullifies an output that a parallel onStartFeed just
// created, and SourceBuffer ends up empty while feedEmittedUpToSec runs off
// past the end of the file. tick is left out of the gate - it is a pure
// state write and we want it to land synchronously even while a long
// operation (e.g. waiting on feedDonePromise) is mid-flight.
let opQueue: Promise<unknown> = Promise.resolve();
function serialize(fn: () => Promise<void>): void {
    // Notifications have no reply; the main thread needs a failure signal
    // when setup throws before a feed exists or its seek would wait forever.
    opQueue = opQueue.then(fn).catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
        fail("feed-setup-threw", error);
    });
}

// init is request/reply (main awaits codecMime + hasAudio before opening
// MediaSource). Everything else is fire-and-forget; the per-cycle id +
// the internal serialize() gate keep ordering correct without acks.
//
// init handler runs OUTSIDE serialize() - it is the first op, has no prior
// state to fight with, and a future "init while previous backend mid-tear-
// down" would already be impossible because the main side disposes the
// whole worker before constructing a new backend.
const server = createWorkerServer(self, {
    onRequest: async (type, data, ctx): Promise<InitResult> => {
        if (type !== MSE_REQUEST_INIT) {
            throw new Error(`unknown request type: ${type}`);
        }
        const req = data as InitRequestData;
        return await onInit(
            req.file,
            req.startSec,
            req.transcodeAdpcmAudio ?? false,
            req.adpcmPlaybackCodecs ?? ["aac", "opus"],
            ctx.signal,
        );
    },
    onNotification: (type, data) => {
        switch (type) {
            case MSE_NOTIFY_START_FEED:
                serialize(() => onStartFeed((data as StartFeedNotificationData).cycleId));
                return;
            case MSE_NOTIFY_DROP_AUDIO:
                // Pure state write, like TICK: main sends it before start-feed
                // (which IS serialized), so the flag is set before the Output is
                // built. No need to enter the serialize gate.
                dropAudio = true;
                return;
            case MSE_NOTIFY_TICK: {
                // Outside the serialization gate: a stale tick during a long
                // op (seek cancel + restart) is still useful info, and we do
                // not want to delay backpressure updates behind unrelated
                // pending operations.
                const tick = data as TickNotificationData;
                lastTick = {
                    currentTime: tick.currentTime,
                    appendQueueLen: tick.appendQueueLen,
                    playbackRate: tick.playbackRate,
                    appendPaused: tick.appendPaused ?? false,
                };
                // Wake anyone parked in waitForBufferRoom so they re-evaluate
                // against the fresh currentTime / appendQueueLen / rate.
                wakeFeedWaiters();
                return;
            }
            case MSE_NOTIFY_SEEK: {
                const seek = data as SeekNotificationData;
                serialize(() => onSeek(seek.startSec, seek.cycleId));
                return;
            }
        }
    },
});

function fail(reason: string, error?: unknown): void {
    if (failed) return;
    failed = true;
    if (currentCycle) {
        currentCycle.abort.abort();
        void currentCycle.output.cancel().catch((error) => log.debug("failed output cleanup threw", error));
    }
    input?.dispose();
    input = null;
    const message = error instanceof Error ? error.message : error !== undefined ? String(error) : undefined;
    log.warn(`worker fail: ${reason}${message ? `: ${message}` : ""}`, {
        file: workerFile?.name,
        reason,
        error: message,
    });
    const ntf: ErrorNotificationData = { reason, message };
    server.notify(MSE_NOTIFY_ERROR, ntf);
}

/**
 * Reads metadata from the source file. Mirrors PerFileMseBackend.attach()
 * metadata phase but stays in the worker: opens mediabunny Input, fetches
 * video/audio decoder configs, builds the codec mime, returns it to the
 * caller as the "init" request result.
 *
 * Errors here are thrown rather than reported via fail() so that init's
 * request promise rejects on the main side. fail() still exists for
 * runtime failures during the feed loop, which are out-of-band push events.
 */
/** MP4 (RFC 6381) audio codec parameter for the chosen encode codec, used to
 *  build the SourceBuffer mime. AAC is AAC-LC (mp4a.40.2): the encode target is
 *  pinned to 48 kHz / stereo / 128 kbps (AUDIO_TARGET_*), which keeps mediabunny
 *  on AAC-LC rather than HE-AAC v1 (mp4a.40.5). */
function adpcmAudioMimeParam(codec: "aac" | "opus"): string {
    return codec === "aac" ? "mp4a.40.2" : "opus";
}

async function onInit(
    file: File,
    initialStartSec: number,
    wantTranscodeAudio: boolean,
    adpcmPlaybackCodecs: readonly AdpcmPlaybackCodec[],
    signal: AbortSignal,
): Promise<InitResult> {
    workerFile = file;
    startSec = Math.max(0, initialStartSec);
    input = new Input({ source: await createBlobSource(file), formats: VIDEO_INPUT_FORMATS });
    const openedInput = input;
    const abortInput = () => openedInput.dispose();
    signal.addEventListener("abort", abortInput, { once: true });
    try {
        signal.throwIfAborted();
        sourceTimeOrigin = await getInputTimeOrigin(input);
        const vt = await input.getPrimaryVideoTrack();
        if (!vt) throw new Error("no-video-track");
        videoTrack = vt;
        videoCodec = (await vt.getCodec()) as VideoCodec;
        videoTransformationMatrix = await vt.getTransformationMatrix();
        const videoCodecParamRaw = await vt.getCodecParameterString();
        if (!videoCodecParamRaw) throw new Error("no-video-codec-param");

        // hev1 -> hvc1: Chrome MSE and native <video> only accept hvc1 for HEVC;
        // some firmware (BlackVue ELITE 9, Vantrue N2X) writes hev1. Mediabunny
        // always remuxes to hvc1, so the swap is safe.
        const videoCodecParam = videoCodecParamRaw.startsWith("hev1.")
            ? `hvc1.${videoCodecParamRaw.slice(5)}`
            : videoCodecParamRaw;

        let vdc = await vt.getDecoderConfig();
        if (!vdc) throw new Error("no-video-decoder-config");
        const cleanedDesc = videoCodec === "hevc" ? cleanHvccDescription(vdc.description) : vdc.description;
        if (cleanedDesc !== vdc.description) {
            vdc = { ...vdc, description: cleanedDesc };
            log.info("hvcC cleaned of invalid NAL arrays", { file: file.name });
        }
        videoDecoderConfig = vdc;

        let audioCodecParam: string | null = null;
        try {
            if (wantTranscodeAudio) {
                // IMA-ADPCM (Mio/Navman): bypass mediabunny's audio track entirely - it
                // cannot read the codec. We decode the ADPCM ourselves and re-encode.
                // openAdpcmAudio re-reads the moov + chunk table; null means the file is
                // not actually the ADPCM form we handle, in which case we just play video
                // without audio.
                adpcmReader = await openAdpcmAudioAuto(file);
                if (
                    adpcmReader &&
                    !hasPlaybackAudioTail(await vt.computeDuration(), adpcmReader.totalFrames / adpcmReader.sampleRate)
                ) {
                    adpcmReader = null;
                }
                if (adpcmReader) {
                    // Main has already filtered this preference list by what its MSE
                    // can play. Chromium/Firefox prefer the original, proven Opus path;
                    // Safari supplies AAC because it rejects Opus-in-MP4. The worker
                    // then picks the first candidate it can actually encode.
                    adpcmEncodeCodec = await resolveEncodeAudioCodec(adpcmPlaybackCodecs);
                    if (adpcmEncodeCodec) {
                        transcodeAdpcmAudio = true;
                        audioCodecParam = adpcmAudioMimeParam(adpcmEncodeCodec);
                        log.info("audio: transcoding IMA-ADPCM", {
                            file: file.name,
                            encodeCodec: adpcmEncodeCodec,
                            channels: adpcmReader.channels,
                            sampleRate: adpcmReader.sampleRate,
                        });
                    } else {
                        log.warn("audio is IMA-ADPCM but no audio encoder available, dropping audio", {
                            file: file.name,
                        });
                    }
                } else {
                    log.warn("ADPCM audio unavailable for playback, dropping audio", { file: file.name });
                }
            } else {
                let at = await input.getPrimaryAudioTrack();
                if (at) {
                    const [videoEnd, audioEnd] = await Promise.all([vt.computeDuration(), at.computeDuration()]);
                    if (!hasPlaybackAudioTail(videoEnd, audioEnd)) at = null;
                }
                if (at) {
                    const ac = await at.getCodec();
                    const acParam = await at.getCodecParameterString();
                    const adc = await at.getDecoderConfig();
                    if (ac && acParam && adc && new Mp4OutputFormat().getSupportedAudioCodecs().includes(ac)) {
                        // Some codecs carry muxing metadata in their first packet instead
                        // of decoderConfig. Keep it ready before start() on every cycle.
                        const primer = await new EncodedPacketSink(at).getFirstPacket();
                        if (primer) {
                            audioTrack = at;
                            audioCodec = ac;
                            audioCodecParam = acParam;
                            audioDecoderConfig = adc;
                            audioConfigPrimingPacket = primer;
                        } else {
                            log.warn("audio track has no readable packets, dropping audio", { file: file.name });
                        }
                    } else {
                        // Audio track present but codec params unparseable - drop audio.
                        // Silent video beats a black screen.
                        log.warn("audio track cannot be copied to mp4, dropping audio", { file: file.name, codec: ac });
                    }
                }
            }
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof Error && error.name === "AbortError") throw error;
            // Commit no partial audio state after a failed read or encoder probe.
            audioTrack = null;
            audioCodec = null;
            audioDecoderConfig = null;
            audioConfigPrimingPacket = undefined;
            audioCodecParam = null;
            adpcmReader = null;
            adpcmEncodeCodec = null;
            transcodeAdpcmAudio = false;
            log.warn("audio setup failed, keeping video-only playback", {
                file: file.name,
                error: error instanceof Error ? error.message : String(error),
            });
        }

        const videoOnlyMime = `video/mp4; codecs="${videoCodecParam}"`;
        const codecMime = audioCodecParam ? `video/mp4; codecs="${videoCodecParam},${audioCodecParam}"` : videoOnlyMime;
        signal.throwIfAborted();
        return {
            codecMime,
            videoOnlyMime,
            hasAudio: audioTrack !== null || transcodeAdpcmAudio,
            audioTranscoded: transcodeAdpcmAudio,
        };
    } catch (error) {
        openedInput.dispose();
        input = null;
        throw error;
    } finally {
        signal.removeEventListener("abort", abortInput);
    }
}

function hasPlaybackAudioTail(videoEnd: number, audioEnd: number): boolean {
    if (videoEnd - audioEnd <= AUDIO_TAIL_TOLERANCE_SEC) return true;
    // MSE intersects audio/video buffered ranges until endOfStream. A short
    // audio tail stalls playback before the bounded video feed can reach EOF.
    log.warn("audio ends before video, keeping video-only playback", {
        reason: "audio-ends-before-video",
        videoEndSec: videoEnd,
        audioEndSec: audioEnd,
    });
    return false;
}

/**
 * Worker-side equivalent of PerFileMseBackend.startNewFeed: creates a fresh
 * mediabunny Output and starts the feed loop. Called once from start-feed and
 * once after each onSeek (which arms postSeekFirstMediaPending on the new cycle).
 *
 * The cycle's accumulate/flush callbacks are CLOSURES over the cycle's own
 * pendingSegment - this matters when a stale feed from a previous cycle
 * still has mediabunny callbacks queued: those reference the OLD cycle's
 * accumulator, not the new one, so they cannot pollute the new init/media
 * segments.
 */
async function startNewFeedCycle(cycleId: number, armSeekDone: boolean): Promise<void> {
    if (failed) return;
    if (!videoTrack || !videoCodec || !videoDecoderConfig) {
        return fail("startNewFeed-missing-state");
    }

    const cycle: FeedCycle = {
        id: cycleId,
        startTimestamp: startSec,
        abort: new AbortController(),
        // Filled below - non-null after this function returns successfully.
        output: null as unknown as Output,
        videoSource: null as unknown as EncodedVideoPacketSource,
        audioSource: null,
        pendingSegment: [],
        pendingSegmentLen: 0,
        feedEmittedUpToSec: startSec,
        postSeekFirstMediaPending: armSeekDone,
        // Fresh per cycle: a seek to a different segment of the file may
        // legitimately have a different bitrate, so the estimate rebases.
        bytesEmitted: 0,
        mediaSecondsCovered: 0,
        // runFeed lowers this to the primer's timestamp when it starts a
        // stream-copy audio feed; every other audio path leaves video ungated.
        audioFedUpToSec: Number.POSITIVE_INFINITY,
        audioFeedDone: true,
    };

    cycle.videoSource = new EncodedVideoPacketSource(videoCodec);
    // Transcode path: a sample source that WebCodecs-encodes our decoded PCM to
    // the chosen codec (AAC or Opus). Stream-copy path: an encoded-packet source
    // for the container's own audio codec. Both are added to the same fragmented
    // Output below. dropAudio (main found the codec not MSE-playable) forces a
    // video-only track set so the moov matches main's video-only SourceBuffer.
    cycle.audioSource = dropAudio
        ? null
        : transcodeAdpcmAudio && adpcmReader && adpcmEncodeCodec
          ? createEncodeAudioSource(adpcmEncodeCodec)
          : audioCodec
            ? new EncodedAudioPacketSource(audioCodec)
            : null;

    // Cycle-local accumulator. Closure over the cycle object: if a new
    // cycle takes over later, the old output's still-pending callbacks
    // mutate the OLD cycle.pendingSegment, never the new one.
    const isStale = (): boolean => cycle.abort.signal.aborted || failed;
    const accumulate = (data: Uint8Array) => {
        // Abort can race mediabunny's output callbacks after a seek. Check
        // before allocating/copying so stale boxes do not consume memory.
        if (isStale()) return;
        const copy = new Uint8Array(data.length);
        copy.set(data);
        cycle.pendingSegment.push(copy);
        cycle.pendingSegmentLen += copy.length;
    };

    /**
     * Single-allocation merge of pending + trailing into one new Uint8Array,
     * then ownership-transfer to main via Transferable. Avoids the double-
     * copy (one in accumulate, one in mergePending) the earlier version had.
     */
    const mergeAndFlush = (trailing: Uint8Array): Uint8Array => {
        const total = cycle.pendingSegmentLen + trailing.length;
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of cycle.pendingSegment) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }
        merged.set(trailing, offset);
        cycle.pendingSegment = [];
        cycle.pendingSegmentLen = 0;
        return merged;
    };

    const flushAsInit = (data: Uint8Array) => {
        // Guard before merge and ownership transfer; an aborted cycle must not
        // spend work constructing bytes that main will discard by cycle id.
        if (isStale()) return;
        const merged = mergeAndFlush(data);
        const ntf: InitSegmentNotificationData = { cycleId: cycle.id, bytes: merged };
        server.notify(MSE_NOTIFY_INIT_SEGMENT, ntf, [merged.buffer]);
    };

    let outputVideoTrack: ReturnType<typeof readVideoTrackMetadata> | null = null;
    let fragmentVideoMetadata: ReturnType<typeof readVideoFragmentMetadata> | null = null;
    const flushAsMedia = (data: Uint8Array) => {
        if (isStale()) return;
        if (!fragmentVideoMetadata) throw new Error("media fragment has no parsed video metadata");
        const merged = mergeAndFlush(data);
        // Bitrate sample, cycle-scoped. mediaSecondsCovered tracks the maximum
        // feedEmittedUpToSec advance since this cycle started; bytes tally includes
        // mp4 box overhead (moof + mdat). waitForBufferRoom uses these two to
        // derive an adaptive cap. Writing to cycle (not a module global) means a
        // stale aborted output's late callback cannot skew the new cycle's tally.
        cycle.bytesEmitted += merged.length;
        const emittedVideo = fragmentVideoMetadata.endSec !== null;
        if (fragmentVideoMetadata.endSec !== null) {
            cycle.feedEmittedUpToSec = Math.max(cycle.feedEmittedUpToSec, fragmentVideoMetadata.endSec);
        }
        const cycleElapsed = cycle.feedEmittedUpToSec - cycle.startTimestamp;
        if (cycleElapsed > cycle.mediaSecondsCovered) {
            cycle.mediaSecondsCovered = cycleElapsed;
        }
        const videoKeyframeTimestamps = fragmentVideoMetadata.keyframeTimestamps;
        fragmentVideoMetadata = null;
        const mediaNtf: MediaSegmentNotificationData = { cycleId: cycle.id, bytes: merged, videoKeyframeTimestamps };
        server.notify(MSE_NOTIFY_MEDIA_SEGMENT, mediaNtf, [merged.buffer]);
        if (cycle.postSeekFirstMediaPending && emittedVideo) {
            cycle.postSeekFirstMediaPending = false;
            const seekDoneNtf: SeekDoneNotificationData = { cycleId: cycle.id };
            server.notify(MSE_NOTIFY_SEEK_DONE, seekDoneNtf);
        }
    };

    // Output uses a no-op WritableStream; fragments arrive via the
    // onFtyp/onMoov/onMoof/onMdat callbacks.
    const noopWritable = new WritableStream<{ type: "write"; data: Uint8Array; position: number }>({
        write() {
            /* no-op: data goes through callbacks */
        },
        close() {
            /* no-op */
        },
    });
    cycle.output = new Output({
        format: new Mp4OutputFormat({
            fastStart: "fragmented",
            // 0: each keyframe starts a new fragment. Critical for files with
            // infrequent keyframes such as BlackVue ELITE 9 (GOP ~10 s). With
            // a larger value mediabunny accumulates a multi-MB fragment before
            // emitting, which would overflow appendBuffer quota on the main
            // side. Per-fragment moof overhead is negligible (~344 bytes).
            minimumFragmentDuration: 0,
            onFtyp: accumulate,
            onMoov: (data) => {
                outputVideoTrack = readVideoTrackMetadata(data);
                flushAsInit(data);
            },
            onMoof: (data) => {
                if (!outputVideoTrack) throw new Error("media fragment precedes video track metadata");
                fragmentVideoMetadata = readVideoFragmentMetadata(data, outputVideoTrack);
                accumulate(data);
            },
            onMdat: flushAsMedia,
        }),
        target: new StreamTarget(noopWritable),
    });
    cycle.output.addVideoTrack(cycle.videoSource, { transformationMatrix: videoTransformationMatrix });
    if (cycle.audioSource) {
        // Keep the track set stable even when a seek has no remaining audio packets.
        cycle.output.addAudioTrack(
            cycle.audioSource,
            audioDecoderConfig
                ? { decoderConfig: audioDecoderConfig, primingPacket: audioConfigPrimingPacket }
                : undefined,
        );
    }

    try {
        await cycle.output.start();
    } catch (e) {
        return fail("output-start-threw", e);
    }
    if (cycle.abort.signal.aborted || failed) return;

    currentCycle = cycle;
    // Fire and forget; runFeed catches its own errors and surfaces via fail().
    // A stray .catch guards against any uncaught reject becoming an
    // unhandledRejection in the worker.
    runFeed(cycle).catch((e) => log.warn("runFeed unexpected throw", e));
}

async function onStartFeed(cycleId: number): Promise<void> {
    if (failed) return;
    // Initial start: no prior cycle, no seek-done expectation.
    await startNewFeedCycle(cycleId, false);
}

/**
 * In-backend reseek. One step: abort the current feed, start a brand-new
 * cycle from newStartSec. The new cycle is armed to emit "seek-done" once
 * its first media segment is posted - that is the moment when main can set
 * video.currentTime to the target without snapping to 0.
 *
 * Why single-step (no ack round-trip): the only thing the previous two-phase
 * design was protecting against was stale old-cycle segments polluting
 * SourceBuffer. With cycleId on every emitted segment and cycleId filtering
 * on main, stale segments are dropped on arrival; coordinating with main on
 * "I've stopped emitting" is unnecessary. Single-step removes a 2-sec
 * timeout window during which the user saw their seek bail silently if the
 * worker was momentarily busy.
 *
 * Input stays alive across seeks - on MPEG-TS mediabunny's first metadata
 * read on a new Input would cost PMT + first PES IO again.
 */
async function onSeek(newStartSec: number, newCycleId: number): Promise<void> {
    if (failed) return;
    if (!input || !videoTrack) {
        log.debug("seek before init - ignoring", { newStartSec });
        return;
    }
    const target = Math.max(0, newStartSec);

    const oldCycle = currentCycle;
    currentCycle = null;
    if (oldCycle) {
        try {
            oldCycle.abort.abort();
        } catch {
            /* ignore */
        }
        // Release boxes copied before abort. Any later callback sees the
        // aborted signal before copying or merging more bytes.
        oldCycle.pendingSegment = [];
        oldCycle.pendingSegmentLen = 0;
        // Fire-and-forget cancel. The outer try guards against a sync throw
        // from cancel() if the output already finalized (natural feed-done
        // before this seek arrived); .catch on the returned promise only
        // handles async rejections.
        try {
            oldCycle.output.cancel().catch(() => undefined);
        } catch {
            /* already finalized */
        }
    }

    startSec = target;
    // Anticipate the new playback position. Without this, lastTick.currentTime
    // sits at the pre-seek value (e.g. 60 s) while feedEmittedUpToSec for the new
    // cycle immediately jumps to target+ε (e.g. 187 s) on the first packet.
    // ahead = 127 s >> target, feed waits, mediabunny gets no packets,
    // no fragment, no seek-done. Resetting unblocks the gate; real ticks
    // from main (sent after main sets video.currentTime = target)
    // overwrite this stub.
    lastTick.currentTime = target;

    // Start the new cycle right away. armSeekDone=true so its first media
    // segment fires "seek-done" back to main.
    await startNewFeedCycle(newCycleId, true);
}

/**
 * Feed loop. Video and audio feed in parallel after an audio primer ensures
 * the first push to mediabunny output emits an init segment containing both
 * tracks. All cycle-scoped state (output, videoSource, audioSource, pending
 * accumulator, feedEmittedUpToSec) is reached only via the `cycle` parameter -
 * a stale runFeed from a previous cycle therefore cannot touch the new one.
 */
async function runFeed(cycle: FeedCycle): Promise<void> {
    const signal = cycle.abort.signal;
    const target = cycle.startTimestamp;
    const sourceTarget = target + sourceTimeOrigin;
    if (!videoTrack || !videoCodec || !videoDecoderConfig) {
        fail("runFeed-missing-state");
        return;
    }
    try {
        const videoSink = new EncodedPacketSink(videoTrack);
        // verifyKeyPackets bitstream-checks each candidate instead of trusting the
        // container's key flag. Some MPEG-TS cameras (e.g. Rexing) mark every PES
        // packet as a random-access point, so without this getKeyPacket could land
        // on a non-IDR frame and the player would decode garbage until the next
        // real keyframe. Costs a small bitstream read per candidate; the feed reads
        // the data anyway. (mediabunny issue #414 - not fixed in the demuxer by
        // design; this option is the intended fix.)
        let startKey = await videoSink.getKeyPacket(sourceTarget, { verifyKeyPackets: true });
        if (!startKey) {
            // A composition timeline can begin with an audio-only gap. Use
            // the first verified video keyframe when the target precedes it.
            const first = await videoSink.getFirstPacket({ verifyKeyPackets: true });
            if (first && first.type === "key") startKey = first;
        }
        if (signal.aborted) return;
        if (!startKey) {
            fail("no-video-keyframe");
            return;
        }

        let firstAudio: EncodedPacket | null = null;
        let audioSinkForPrimer: EncodedPacketSink | null = null;
        if (audioTrack && cycle.audioSource && audioDecoderConfig) {
            audioSinkForPrimer = new EncodedPacketSink(audioTrack);
            firstAudio = await audioSinkForPrimer.getPacket(sourceTarget);
            if (!firstAudio) firstAudio = await audioSinkForPrimer.getFirstPacket();
        }
        if (signal.aborted) return;

        // The same file must keep the same timeline before and after a seek.
        const framePtsOffset = -sourceTimeOrigin;

        // Build the feed set. In all cases the FIRST audio sample must reach the
        // muxer before the first video packet: mediabunny emits the init segment
        // (moov) on the first fragment, and a video-first order ships moov with
        // video-only, after which MSE rejects audio segments ("Initialization
        // segment misses expected ... track"). So audio is primed first, then
        // video starts.
        const promises: Promise<void>[] = [];
        if (transcodeAdpcmAudio && adpcmReader && cycle.audioSource) {
            // Transcode: decode ADPCM -> PCM, re-encode (AAC/Opus). Kick off the
            // whole-file feed and gate the video feed on its first emitted
            // sample (onFirstEmit) so the audio track lands in the moov.
            const audioSource = cycle.audioSource as AudioSampleSource;
            const reader = adpcmReader;
            let resolvePrimed: () => void = () => {};
            const primed = new Promise<void>((resolve) => {
                resolvePrimed = resolve;
            });
            const audioFeed = (async () => {
                try {
                    await reader.feedToEnd(audioSource, target, framePtsOffset, signal, resolvePrimed);
                } catch (e) {
                    if (!signal.aborted) fail("audio-transcode-threw", e);
                } finally {
                    if (!signal.aborted) audioSource.close();
                    // Never leave the video feed blocked: onFirstEmit does not
                    // fire if the range is empty (e.g. a seek past audio end) or
                    // the feed threw before its first sample.
                    resolvePrimed();
                }
            })();
            await primed;
            if (signal.aborted) return;
            promises.push(audioFeed);
        } else if (audioSinkForPrimer && audioTrack && cycle.audioSource && audioDecoderConfig && firstAudio) {
            // Stream-copy: prime with the first encoded packet + decoder config.
            const audioSource = cycle.audioSource as EncodedAudioPacketSource;
            const adjusted =
                framePtsOffset !== 0
                    ? firstAudio.clone({ timestamp: firstAudio.timestamp + framePtsOffset })
                    : firstAudio;
            let primedAudioFirstPacket: EncodedPacket | null = null;
            try {
                await audioSource.add(adjusted, { decoderConfig: audioDecoderConfig });
                primedAudioFirstPacket = firstAudio;
            } catch (e) {
                if (!signal.aborted) fail("audio-primer-threw", e);
            }
            if (signal.aborted) return;
            if (primedAudioFirstPacket) {
                cycle.audioFedUpToSec = adjusted.timestamp;
                cycle.audioFeedDone = false;
                promises.push(feedAudio(cycle, audioTrack, framePtsOffset, primedAudioFirstPacket));
            }
        } else if (cycle.audioSource) {
            cycle.audioSource.close();
        }

        promises.push(feedVideo(cycle, videoSink, startKey, videoDecoderConfig, framePtsOffset));
        await Promise.all(promises);
        if (signal.aborted) return;

        try {
            await cycle.output.finalize();
        } catch (e) {
            if (!signal.aborted) fail("output-finalize-threw", e);
            return;
        }
        if (signal.aborted) return;
        const ntf: FeedDoneNotificationData = { cycleId: cycle.id };
        server.notify(MSE_NOTIFY_FEED_DONE, ntf);
    } catch (e) {
        if (signal.aborted) return;
        fail("runFeed-uncaught", e);
    }
}

async function feedVideo(
    cycle: FeedCycle,
    sink: EncodedPacketSink,
    startKey: EncodedPacket,
    vdc: VideoDecoderConfig,
    framePtsOffset: number,
): Promise<void> {
    const signal = cycle.abort.signal;
    let configPushed = false;
    let pkt: EncodedPacket | null = startKey;
    while (pkt) {
        if (signal.aborted) return;
        if (!hasVideoContent(pkt)) {
            pkt = await sink.getNextPacket(pkt, { verifyKeyPackets: true });
            continue;
        }
        const adjustedTs = pkt.timestamp + framePtsOffset;
        await waitForBufferRoom(cycle, adjustedTs);
        if (signal.aborted) return;
        const adjusted = framePtsOffset !== 0 ? pkt.clone({ timestamp: adjustedTs }) : pkt;
        const meta = configPushed ? undefined : { decoderConfig: vdc };
        try {
            await cycle.videoSource.add(adjusted, meta);
        } catch (e) {
            if (signal.aborted) return;
            fail("video-add-threw", e);
            return;
        }
        if (signal.aborted) return;
        configPushed = true;
        // verifyKeyPackets: bitstream-check the key/delta flag of each fed packet,
        // matching the seek-anchor check above. Some MPEG-TS cameras (Rexing, #414)
        // mark every PES as a random-access point; trusting that flag makes
        // mediabunny start a fragment on a non-IDR packet, so the player decodes
        // garbage until the next real keyframe. The feed reads the data anyway, so
        // this costs CPU, not IO.
        pkt = await sink.getNextPacket(pkt, { verifyKeyPackets: true });
    }
}

async function feedAudio(
    cycle: FeedCycle,
    track: InputAudioTrack,
    framePtsOffset: number,
    primedFirstPacket: EncodedPacket,
): Promise<void> {
    const signal = cycle.abort.signal;
    const sink = new EncodedPacketSink(track);
    // feedAudio only runs for the stream-copy path, where audioSource is an
    // EncodedAudioPacketSource (the transcode path uses feedToEnd instead).
    const audioSource = cycle.audioSource as EncodedAudioPacketSource;
    // Resume from the NEXT packet; the primer (in runFeed) already pushed
    // the first one and passed decoderConfig.
    //
    // Audio runs WITHOUT a waitForBufferRoom gate. Reason: mediabunny Output
    // muxes video+audio into one interleaved fMP4 stream and will not flush
    // a fragment until both tracks have packets up to the fragment boundary.
    // If both feed loops shared the same backpressure gate keyed on
    // feedEmittedUpToSec (advanced only by video), audio would wait for video
    // to make room, video would wait for buffered to grow, buffered would
    // not grow because Output cannot flush without audio - classic three-way
    // deadlock.
    //
    // Letting audio race ahead is safe: audio is small (typical AAC ~32 kbps
    // = 1.2 MB for a 5 min clip) and audioSource.add accepts packets without
    // blocking on video. Output emits fragments paced by video keyframes;
    // audio sits in its internal queue until then. The dependency runs the
    // other way: video must not outrun THIS loop (cycle.audioFedUpToSec), or
    // the same flush rule leaves the muxer holding every video packet it is
    // given while the ahead-window never closes.
    try {
        let pkt: EncodedPacket | null = await sink.getNextPacket(primedFirstPacket);
        while (pkt) {
            if (signal.aborted) return;
            const adjusted = framePtsOffset !== 0 ? pkt.clone({ timestamp: pkt.timestamp + framePtsOffset }) : pkt;
            try {
                await audioSource.add(adjusted);
            } catch (e) {
                if (signal.aborted) return;
                fail("audio-add-threw", e);
                return;
            }
            if (adjusted.timestamp > cycle.audioFedUpToSec) {
                cycle.audioFedUpToSec = adjusted.timestamp;
                wakeFeedWaiters();
            }
            pkt = await sink.getNextPacket(pkt);
        }
    } finally {
        // Release video packets waiting past the last audio sample (the tail
        // tolerance in hasPlaybackAudioTail) before the muxer learns the
        // track is closed; a closed track no longer blocks fragment flushes.
        cycle.audioFeedDone = true;
        wakeFeedWaiters();
        // A live fragmented muxer waits for every open track before flushing.
        if (!signal.aborted) audioSource.close();
    }
}

/**
 * Gate on completed fragments, not packets still buffered inside the muxer.
 * A GOP must reach its next keyframe before MSE can receive any of its data;
 * stopping inside that GOP would wait for playback that cannot start yet.
 *
 * The one packet-level rule is the audio lead: a video packet is handed over
 * only once the audio feed has passed its timestamp (or finished), so every
 * keyframe can close the fragment before it - see FeedCycle.audioFedUpToSec.
 */
async function waitForBufferRoom(cycle: FeedCycle, packetTimestampSec: number): Promise<void> {
    const signal = cycle.abort.signal;
    while (!signal.aborted) {
        if (!cycle.audioFeedDone && cycle.audioFedUpToSec <= packetTimestampSec) {
            await waitForFeedSignal(signal);
            continue;
        }
        // Floor currentTime at cycle.startTimestamp. Between worker's
        // onSeek and main's video.currentTime = target write, a tick
        // can arrive carrying the pre-seek currentTime; without the
        // floor it would set ahead to feedEmittedUpToSec - oldCurrentTime
        // (large positive value) and freeze the feed.
        const effectiveCurrentTime = Math.max(lastTick.currentTime, cycle.startTimestamp);
        const ahead = cycle.feedEmittedUpToSec - effectiveCurrentTime;
        const rate = Math.max(1, lastTick.playbackRate);
        let targetAhead = Math.min(BASE_BUFFER_AHEAD_SEC * rate, MAX_BUFFER_AHEAD_SEC);
        // Adaptive cap: after at least 1 sec of media covered, derive a
        // per-bitrate ceiling so high-bitrate files (Juscar 4K HEVC TS
        // ~5.8 MB/s) cannot fill the SourceBuffer quota. Without this,
        // a fixed 20-sec cap pushes ~116 MB into SB and triggers
        // QuotaExceededError → backend fail → "unsupported" overlay.
        if (cycle.mediaSecondsCovered > 1 && cycle.bytesEmitted > 0) {
            const bytesPerSec = cycle.bytesEmitted / cycle.mediaSecondsCovered;
            const adaptiveCap = BUFFER_AHEAD_QUOTA_BUDGET_BYTES / bytesPerSec;
            targetAhead = Math.max(MIN_ADAPTIVE_AHEAD_SEC, Math.min(targetAhead, adaptiveCap));
        }
        const targetQueueLen = Math.min(Math.ceil(BASE_MAX_APPEND_QUEUE_LEN * rate), MAX_APPEND_QUEUE_CAP);
        const bufferedEnough = ahead >= targetAhead;
        const queueFull = lastTick.appendPaused || lastTick.appendQueueLen >= targetQueueLen;
        if (!bufferedEnough && !queueFull) return;
        await waitForFeedSignal(signal);
    }
}

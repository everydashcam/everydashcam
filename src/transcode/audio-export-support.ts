import {
    AudioSampleSink,
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    Mp4OutputFormat,
    Output,
    PCM_AUDIO_CODECS,
    type AudioCodec,
    type AudioSampleSource,
    type EncodedPacket,
    type Input,
    type InputAudioTrack,
} from "mediabunny";
import { throwIfCancelled } from "../abort-signals.js";
import { createLogger } from "../log.js";
import { isSourceReadError } from "../source-read-error.js";
import { createEncodeAudioSource, resolveEncodeAudioCodec } from "./capabilities.js";

const log = createLogger("audio-export");

export type ReadableAudioPlan =
    | {
          mode: "passthrough";
          codec: AudioCodec;
          source: EncodedAudioPacketSource;
          decoderConfig: AudioDecoderConfig;
      }
    | {
          mode: "encode";
          codec: "aac" | "opus";
          source: AudioSampleSource;
          silenceFormat: { sampleRate: number; numberOfChannels: number };
      }
    | { mode: "skip"; reason: "unsupported" | "no-encoder" };

/**
 * Audio of one source segment fed progressively alongside a stream-copied
 * video walk. The muxer holds every packet of one track until the other track
 * reaches its timestamp, so feeding a whole segment's video before its audio
 * queues that video in memory. Times use the clock of the function that opened
 * the cursor.
 *
 * `feedBefore` feeds only audio that `finish` would also feed for any end at or
 * above `untilSec`, so callers keep every `untilSec` at or below the later
 * `finish` end. It may stop short by up to one decoded sample or read batch;
 * repeated or decreasing values are no-ops. `finish` feeds the rest up to
 * `endSec` and releases the reader. `close` releases it without feeding more;
 * it is idempotent and also safe after `finish`.
 */
export interface AudioRangeCursor {
    feedBefore(untilSec: number): Promise<void>;
    finish(endSec: number): Promise<void>;
    close(): Promise<void>;
}

/**
 * Shortest part of a long audio sample or PCM packet that is fed ahead of its
 * end to keep up with the video walk. Longer than ordinary codec frames, so
 * those reach the muxer or encoder whole; short enough that little copied video
 * waits in the muxer for the rest.
 */
export const MIN_PARTIAL_AUDIO_FEED_SEC = 0.25;

/** Byte layout of PCM audio, used to split a packet at frame boundaries. */
export interface PcmLayout {
    bytesPerFrame: number;
    sampleRate: number;
}

/**
 * The frame layout of a PCM codec, or null for compressed audio, whose packets
 * cannot be split. mediabunny reads each PCM container chunk as one packet, and
 * a file may store a whole track as one chunk.
 */
export function getPcmLayout(codec: AudioCodec, decoderConfig: AudioDecoderConfig): PcmLayout | null {
    if (!(PCM_AUDIO_CODECS as readonly string[]).includes(codec)) return null;
    const bitsPerSample = codec === "ulaw" || codec === "alaw" ? 8 : Number(/^pcm-[suf](\d+)/.exec(codec)?.[1]);
    if (!Number.isInteger(bitsPerSample) || bitsPerSample % 8 !== 0) return null;
    if (decoderConfig.numberOfChannels < 1 || decoderConfig.sampleRate <= 0) return null;
    return {
        bytesPerFrame: (bitsPerSample / 8) * decoderConfig.numberOfChannels,
        sampleRate: decoderConfig.sampleRate,
    };
}

/** Frames of one PCM packet due for copying; see nextPcmPiece. */
export interface PcmPiece {
    /** First frame of the piece within the packet. */
    fromFrame: number;
    /** Frame after the piece's last one. */
    toFrame: number;
    /** Source time of the piece's first frame. */
    startSec: number;
    /** Whether the piece reaches the packet's end, consuming the packet. */
    isTail: boolean;
}

/**
 * The next frames of a PCM packet to copy before `untilSec`, continuing after
 * `copiedFrames`, or null when nothing is due yet. A PCM packet is a whole
 * container chunk, possibly the whole track; copied whole, it would leave the
 * muxer holding every video packet until the next audio packet. During the
 * video walk a head shorter than MIN_PARTIAL_AUDIO_FEED_SEC waits for a later
 * limit. At the segment end every frame before the limit is due, so the copied
 * audio ends with the video instead of running to the chunk's end.
 */
export function nextPcmPiece(
    packet: { timestamp: number; byteLength: number },
    layout: PcmLayout,
    copiedFrames: number,
    untilSec: number,
    isSegmentEnd: boolean,
): PcmPiece | null {
    const frameCount = Math.floor(packet.byteLength / layout.bytesPerFrame);
    let toFrame = frameCount;
    const untilFrame = Math.ceil((untilSec - packet.timestamp) * layout.sampleRate - 1e-6);
    if (untilFrame < frameCount) {
        if (untilFrame <= copiedFrames) return null;
        if (!isSegmentEnd && (untilFrame - copiedFrames) / layout.sampleRate < MIN_PARTIAL_AUDIO_FEED_SEC) return null;
        toFrame = untilFrame;
    }
    return {
        fromFrame: copiedFrames,
        toFrame,
        startSec: packet.timestamp + copiedFrames / layout.sampleRate,
        isTail: toFrame >= frameCount,
    };
}

/**
 * A clone of `packet` carrying `piece` at `timestamp`. Its duration counts the
 * piece's frames: Matroska may omit a PCM block's duration, and the MP4 muxer
 * derives it the same way. A tail keeps the packet's trailing bytes, so a
 * packet copied in one piece stays byte-identical.
 */
export function clonePcmPiece(
    packet: EncodedPacket,
    layout: PcmLayout,
    piece: PcmPiece,
    timestamp: number,
): EncodedPacket {
    const duration = (piece.toFrame - piece.fromFrame) / layout.sampleRate;
    if (piece.fromFrame === 0 && piece.isTail) return packet.clone({ timestamp, duration });
    return packet.clone({
        data: packet.data.subarray(
            piece.fromFrame * layout.bytesPerFrame,
            piece.isTail ? packet.byteLength : piece.toFrame * layout.bytesPerFrame,
        ),
        timestamp,
        duration,
    });
}

/**
 * The input's primary audio track when it has at least one packet, else null.
 * A track can keep a valid sample entry with an empty sample table: phantom-track
 * repair (src/repair/phantom-track.ts) empties an audio track whose data was
 * never written. Such a file has no sound, so it must neither define the
 * export's audio format nor be decoded as an audio segment. Packet metadata
 * comes from the sample index, so this does not read media data and works for
 * codecs mediabunny cannot name (IMA ADPCM).
 */
export async function getPrimaryAudioTrackWithPackets(input: Input): Promise<InputAudioTrack | null> {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const firstPacket = await new EncodedPacketSink(track).getFirstPacket({ metadataOnly: true });
    return firstPacket ? track : null;
}

/**
 * A container's broad codec name does not establish muxer support: mediabunny
 * reads AAC Main (mp4a.40.1), but its MP4 writer rejects that profile. Probe the
 * actual first packet and configuration in a disposable output, before opening
 * the real output. This follows the installed muxer's rules without copying its
 * codec-string allowlist or requiring a decoder for packet copies.
 */
export async function resolveReadableAudioPlan(
    track: InputAudioTrack,
    allowCopy: boolean,
    signal?: AbortSignal,
): Promise<ReadableAudioPlan> {
    throwIfCancelled(signal);
    const codec = await track.getCodec();
    const decoderConfig = codec ? await track.getDecoderConfig() : null;
    throwIfCancelled(signal);
    if (!codec || !decoderConfig) return { mode: "skip", reason: "unsupported" };

    if (allowCopy && new Mp4OutputFormat().getSupportedAudioCodecs().includes(codec)) {
        // Source reads stay outside the muxer catch: card failures must abort,
        // never turn a requested soundtrack into an apparently successful skip.
        const packet = await new EncodedPacketSink(track).getFirstPacket();
        throwIfCancelled(signal);
        if (!packet) return { mode: "skip", reason: "unsupported" };
        const output = new Output({ target: new BufferTarget(), format: new Mp4OutputFormat() });
        const source = new EncodedAudioPacketSource(codec);
        output.addAudioTrack(source);
        try {
            await output.start();
            await source.add(packet.clone({ timestamp: 0 }), { decoderConfig });
            throwIfCancelled(signal);
            return { mode: "passthrough", codec, source: new EncodedAudioPacketSource(codec), decoderConfig };
        } catch (err) {
            rethrowReadOrAbort(err, signal);
            log.warn("audio cannot be copied to mp4, checking decoder", {
                codec: decoderConfig.codec,
                err: String(err),
            });
        } finally {
            await output.cancel();
        }
    }

    // A working encoder alone is insufficient. Decode a real sample before
    // committing the audio track, including on platforms with optimistic probes.
    // TODO: verify a bounded Web Audio AAC Main decoder on a real NIO sample;
    // WebCodecs rejects this profile in Chromium and no software decoder is bundled.
    try {
        const canDecode = await track.canDecode();
        throwIfCancelled(signal);
        if (!canDecode) return { mode: "skip", reason: "unsupported" };
        // Opus pre-skip can place the first decoded sample after the first
        // packet's timestamp. Read the sample itself instead of seeking there;
        // returning from the loop also releases the iterator's prefetched data.
        for await (const sample of new AudioSampleSink(track).samples()) {
            try {
                throwIfCancelled(signal);
                const silenceFormat = { sampleRate: sample.sampleRate, numberOfChannels: sample.numberOfChannels };
                const encodeCodec = await resolveEncodeAudioCodec();
                throwIfCancelled(signal);
                if (!encodeCodec) return { mode: "skip", reason: "no-encoder" };
                return {
                    mode: "encode",
                    codec: encodeCodec,
                    source: createEncodeAudioSource(encodeCodec),
                    silenceFormat,
                };
            } finally {
                sample.close();
            }
        }
        throwIfCancelled(signal);
        return { mode: "skip", reason: "unsupported" };
    } catch (err) {
        rethrowReadOrAbort(err, signal);
        log.warn("audio cannot be decoded, exporting without audio", { codec: decoderConfig.codec, err: String(err) });
        return { mode: "skip", reason: "unsupported" };
    }
}

function rethrowReadOrAbort(err: unknown, signal: AbortSignal | undefined): void {
    throwIfCancelled(signal);
    if (err instanceof Error && err.name === "AbortError") throw err;
    if (isSourceReadError(err)) throw err;
}

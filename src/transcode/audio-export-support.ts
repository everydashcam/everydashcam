import {
    AudioSampleSink,
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    Mp4OutputFormat,
    Output,
    type AudioCodec,
    type AudioSampleSource,
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

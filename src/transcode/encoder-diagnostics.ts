import type { VideoEncodingConfig } from "../mediabunny.js";
import { createLogger } from "../log.js";

const log = createLogger("transcode:encoder");

export interface VideoEncodingDiagnostics {
    onEncoderConfig: NonNullable<VideoEncodingConfig["onEncoderConfig"]>;
    onEncodedPacket: NonNullable<VideoEncodingConfig["onEncodedPacket"]>;
    summarize(): {
        encoderConfigCount: number;
        videoPackets: number;
        videoKeyPackets: number;
        videoBytes: number;
        videoDurationSec: number;
        videoBitrateKbps: number | null;
        videoTargetRatio: number | null;
        encodedCodec: string | null;
        encodedWidth: number | null;
        encodedHeight: number | null;
    };
}

/** Counts packet metadata without retaining video bytes or logging in the encode loop. */
export function createVideoEncodingDiagnostics(): VideoEncodingDiagnostics {
    let encoderConfigCount = 0;
    let requestedBitrate: number | undefined;
    let videoPackets = 0;
    let videoKeyPackets = 0;
    let videoBytes = 0;
    let firstTimestamp = Infinity;
    let lastEnd = -Infinity;
    let encodedCodec: string | null = null;
    let encodedWidth: number | null = null;
    let encodedHeight: number | null = null;

    return {
        onEncoderConfig(config) {
            encoderConfigCount++;
            requestedBitrate = config.bitrate;
            // Mediabunny invokes this before isConfigSupported, not after configure.
            log.info("video encoder config requested", {
                encoderConfigCount,
                codec: config.codec,
                width: config.width,
                height: config.height,
                framerate: config.framerate ?? null,
                bitrate: config.bitrate ?? null,
                bitrateMode: config.bitrateMode ?? "variable",
                latencyMode: config.latencyMode ?? "quality",
                hardwareAcceleration: config.hardwareAcceleration ?? "no-preference",
                avcFormat: config.avc?.format ?? null,
            });
        },
        onEncodedPacket(packet, meta) {
            videoPackets++;
            if (packet.type === "key") videoKeyPackets++;
            videoBytes += packet.byteLength;
            firstTimestamp = Math.min(firstTimestamp, packet.timestamp);
            lastEnd = Math.max(lastEnd, packet.timestamp + packet.duration);
            if (meta?.decoderConfig) {
                encodedCodec = meta.decoderConfig.codec;
                encodedWidth = meta.decoderConfig.codedWidth ?? null;
                encodedHeight = meta.decoderConfig.codedHeight ?? null;
            }
        },
        summarize() {
            const duration = videoPackets > 0 ? lastEnd - firstTimestamp : 0;
            const bitrate = duration > 0 ? (videoBytes * 8) / duration : null;
            return {
                encoderConfigCount,
                videoPackets,
                videoKeyPackets,
                videoBytes,
                videoDurationSec: Number(duration.toFixed(6)),
                videoBitrateKbps: bitrate === null ? null : Math.round(bitrate / 1000),
                videoTargetRatio:
                    bitrate !== null && requestedBitrate ? Number((bitrate / requestedBitrate).toFixed(3)) : null,
                encodedCodec,
                encodedWidth,
                encodedHeight,
            };
        },
    };
}

import { CanvasSource, Mp4OutputFormat, NullTarget, Output } from "../mediabunny.js";
import { createLogger } from "../log.js";
import { h264EncodingConfig } from "./h264-encoding.js";
import { createEncoderProbeScene } from "./encoder-probe-scene.js";
import {
    hasPoorEncoderQuality,
    isEncoderBitrateSuspicious,
    luminanceSquaredError,
    shouldProbeEncoderResponse,
    shouldUseSoftwareEncoder,
    type EncoderProbeConfig,
    type EncoderProbeMeasurement,
    type EncoderProbeResult,
} from "./encoder-probe-result.js";

const PROBE_SECONDS = 2;
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;
const log = createLogger("transcode:encoder-probe");

interface ProbeEncoding {
    measurement: EncoderProbeMeasurement;
    packets: { chunk: EncodedVideoChunk; config?: VideoDecoderConfig }[];
}

async function encodeScene(
    config: EncoderProbeConfig,
    hardwareAcceleration: HardwareAcceleration,
    signal: AbortSignal,
): Promise<ProbeEncoding> {
    const start = performance.now();
    const scene = createEncoderProbeScene(config.width, config.height);
    const expectedFrames = Math.round(PROBE_SECONDS * config.frameRate);
    const packets: ProbeEncoding["packets"] = [];
    let bytes = 0;
    let frames = 0;
    let firstTimestamp = Infinity;
    let lastEnd = -Infinity;
    const source = new CanvasSource(scene.canvas, {
        ...h264EncodingConfig(config.bitrate, hardwareAcceleration),
        onEncodedPacket(packet, metadata) {
            bytes += packet.byteLength;
            frames++;
            firstTimestamp = Math.min(firstTimestamp, packet.timestamp);
            lastEnd = Math.max(lastEnd, packet.timestamp + packet.duration);
            if (bytes <= MAX_RETAINED_BYTES)
                packets.push({ chunk: packet.toEncodedVideoChunk(), config: metadata?.decoderConfig });
            else packets.length = 0;
        },
    });
    const output = new Output({ format: new Mp4OutputFormat(), target: new NullTarget() });
    output.addVideoTrack(source, { frameRate: config.frameRate });
    try {
        await output.start();
        for (let i = 0; i < expectedFrames; i++) {
            signal.throwIfAborted();
            scene.draw(i / config.frameRate);
            await source.add(i / config.frameRate, 1 / config.frameRate);
        }
        await output.finalize();
        signal.throwIfAborted();
        const duration = frames > 0 ? lastEnd - firstTimestamp : 0;
        return {
            packets,
            measurement: {
                bitrate: duration > 0 ? (bytes * 8) / duration : 0,
                frames,
                expectedFrames,
                duration,
                elapsedMs: performance.now() - start,
                psnr: null,
            },
        };
    } finally {
        if (output.state !== "finalized" && output.state !== "canceled") await output.cancel();
    }
}

async function measureQuality(
    encoded: ProbeEncoding,
    config: EncoderProbeConfig,
    signal: AbortSignal,
): Promise<number | null> {
    if (encoded.packets.length !== encoded.measurement.expectedFrames || typeof VideoDecoder === "undefined")
        return null;
    const firstConfig = encoded.packets[0]?.config;
    if (!firstConfig || !(await VideoDecoder.isConfigSupported(firstConfig)).supported) return null;
    const scene = createEncoderProbeScene(config.width, config.height);
    const reference = scene.canvas.getContext("2d", { alpha: false });
    const size = Math.min(256, config.width, config.height);
    const patch = new OffscreenCanvas(size, size);
    const decoded = patch.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!reference || !decoded) return null;
    const targets = new Set(
        [0.4, 0.65, 0.9].map((fraction) => Math.floor(encoded.measurement.expectedFrames * fraction)),
    );
    const errors = new Map<number, number>();
    let failure: unknown;
    let decodedFrames = 0;
    const decoder = new VideoDecoder({
        output(frame) {
            decodedFrames++;
            try {
                const index = Math.round((frame.timestamp * config.frameRate) / 1e6);
                if (!targets.has(index) || frame.displayWidth !== config.width || frame.displayHeight !== config.height)
                    return;
                scene.draw(index / config.frameRate);
                let error = 0;
                // Full-resolution patches preserve the texture that downscaling would hide.
                for (const fraction of [0.2, 0.5, 0.8]) {
                    const x = Math.floor((config.width - size) * fraction);
                    const y = Math.floor((config.height - size) * fraction);
                    decoded.drawImage(frame, x, y, size, size, 0, 0, size, size);
                    error += luminanceSquaredError(
                        reference.getImageData(x, y, size, size).data,
                        decoded.getImageData(0, 0, size, size).data,
                    );
                }
                errors.set(index, error / 3);
            } catch (err) {
                failure = err;
            } finally {
                frame.close();
            }
        },
        error(err) {
            failure = err;
        },
    });
    try {
        for (const packet of encoded.packets) {
            signal.throwIfAborted();
            if (failure) throw failure;
            if (packet.config) decoder.configure(packet.config);
            decoder.decode(packet.chunk);
            if (decoder.decodeQueueSize > 8) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await decoder.flush();
        signal.throwIfAborted();
        if (failure) throw failure;
        if (errors.size !== targets.size || decodedFrames !== encoded.measurement.expectedFrames) return null;
        const mse = [...errors.values()].reduce((sum, error) => sum + error, 0) / errors.size;
        return 10 * Math.log10((255 * 255) / Math.max(mse, 1e-9));
    } finally {
        if (decoder.state !== "closed") decoder.close();
    }
}

export async function probeEncoder(config: EncoderProbeConfig, signal: AbortSignal): Promise<EncoderProbeResult> {
    const result: EncoderProbeResult = {
        hardwareAcceleration: "no-preference",
        reason: "inconclusive",
        standard: null,
        software: null,
        response: null,
    };
    signal.throwIfAborted();
    // A bounded diagnostic must not allocate an arbitrarily large custom output.
    if (config.width * config.height > 16_777_216 || typeof OffscreenCanvas === "undefined") return result;
    const standard = await encodeScene(config, "no-preference", signal);
    result.standard = standard.measurement;
    if (!isEncoderBitrateSuspicious(standard.measurement, config.bitrate)) {
        if (standard.measurement.frames === standard.measurement.expectedFrames && standard.measurement.bitrate > 0)
            result.reason = "healthy";
        return result;
    }
    standard.measurement.psnr = await measureQuality(standard, config, signal);
    standard.packets.length = 0;
    if (!hasPoorEncoderQuality(standard.measurement)) return result;
    const software = await encodeScene(config, "prefer-software", signal);
    result.software = software.measurement;
    software.measurement.psnr = await measureQuality(software, config, signal);
    software.packets.length = 0;
    if (shouldUseSoftwareEncoder(standard.measurement, software.measurement, config.bitrate)) {
        result.hardwareAcceleration = "prefer-software";
        result.reason = "confirmed";
    } else if (shouldProbeEncoderResponse(standard.measurement, software.measurement, config.bitrate)) {
        const higherConfig = { ...config, bitrate: config.bitrate * 2 };
        try {
            const higher = await encodeScene(higherConfig, "no-preference", signal);
            result.response = { bitrate: higherConfig.bitrate, measurement: higher.measurement };
            higher.measurement.psnr = await measureQuality(higher, higherConfig, signal);
            if (shouldUseSoftwareEncoder(standard.measurement, software.measurement, config.bitrate, result.response)) {
                result.hardwareAcceleration = "prefer-software";
                result.reason = "unresponsive";
            }
        } catch (err) {
            signal.throwIfAborted();
            if (err instanceof Error && err.name === "AbortError") throw err;
            // Rejecting the higher test bitrate says nothing about the usable original request.
            log.warn("encoder bitrate response trial unavailable", {
                ...higherConfig,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return result;
}

import { Quality, type VideoEncodingConfig } from "../mediabunny.js";

/** Keep support checks, the trial encode and both export sources in agreement. */
export function h264EncodingConfig(
    bitrate: number,
    hardwareAcceleration: HardwareAcceleration = "no-preference",
): VideoEncodingConfig {
    return {
        codec: "avc",
        // Size estimates and device limits require a bitrate, not a fixed quantizer.
        quality: new Quality({ bitrate, bitrateMode: "variable" }),
        keyFrameInterval: 2,
        sizeChangeBehavior: "deny",
        // Batch exports must keep every frame, even when encoding falls behind.
        latencyMode: "quality",
        hardwareAcceleration,
    };
}

import { createFrameSampler } from "./frame-sampling.js";

export type DetectionQuality = "fast" | "balanced" | "thorough";

export const DETECTION_QUALITIES: readonly DetectionQuality[] = ["fast", "balanced", "thorough"];
export const DETECTION_QUALITY_DEFAULT: DetectionQuality = "balanced";

/** Discovery cadence only. Positive samples seed bidirectional tracking;
 *  objects appearing entirely between samples can still be missed. */
export function detectionSampleIntervalSec(quality: DetectionQuality): number {
    switch (quality) {
        case "fast":
            return 1;
        case "balanced":
            return 0.25;
        case "thorough":
            return 0;
    }
}

/** Select source frames on a fixed discovery grid, including the first and
 *  final displayed frames. Create one sampler per source segment. The first
 *  frame may precede a fractional trim; it fills the initial grid position.
 *  Schedule from the anchor, not the previous selected frame, so frame-rate
 *  rounding cannot progressively reduce the requested discovery cadence. */
export function createDetectionSampler(
    quality: DetectionQuality,
    anchorSec: number,
): (contentSec: number, isLastFrame?: boolean) => boolean {
    if (!Number.isFinite(anchorSec)) throw new Error("detection sampling anchor is invalid");
    const sample = createFrameSampler(detectionSampleIntervalSec(quality), anchorSec);
    return (contentSec, isLastFrame = false): boolean => {
        if (!Number.isFinite(contentSec)) throw new Error("detection sampling timestamp is invalid");
        return sample(contentSec, isLastFrame);
    };
}

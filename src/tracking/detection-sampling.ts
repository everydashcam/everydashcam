import { createFrameSampler } from "./frame-sampling.js";

export type DetectionQuality = "fast" | "balanced" | "thorough";

export const DETECTION_QUALITIES: readonly DetectionQuality[] = ["fast", "balanced", "thorough"];
export const DETECTION_QUALITY_DEFAULT: DetectionQuality = "balanced";

/** Sparse modes track between checkpoints. Thorough detection copies adjacent
 * boxes onto unchecked frames, bounding inference to 30 scans per second. */
export function detectionSampleIntervalSec(quality: DetectionQuality): number {
    switch (quality) {
        case "fast":
            return 1;
        case "balanced":
            return 0.25;
        case "thorough":
            return 1 / 30;
    }
}

/** Select source frames on a fixed discovery grid, including the first and
 *  final displayed frames. Anchor to the source video's first timestamp, never
 *  the export trim or a partial decode window. The first frame may precede a
 *  fractional trim; it fills the initial grid position.
 *  Schedule from the anchor, not the previous selected frame, so frame-rate
 *  rounding cannot progressively reduce the requested discovery cadence. */
export function createDetectionSampler(
    quality: DetectionQuality,
    anchorSec: number,
): (contentSec: number, isLastFrame?: boolean) => boolean {
    if (!Number.isFinite(anchorSec)) throw new Error("detection sampling anchor is invalid");
    const intervalSec = detectionSampleIntervalSec(quality);
    const sample = createFrameSampler(intervalSec, anchorSec);
    return (contentSec, isLastFrame = false): boolean => {
        if (!Number.isFinite(contentSec)) throw new Error("detection sampling timestamp is invalid");
        return sample(contentSec, isLastFrame);
    };
}

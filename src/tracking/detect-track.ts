import { rectangleIou } from "../rectangle-geometry.js";
// Shared normalized geometry and output types for automatic detection and
// manual Follow. Automatic confirmation lives in detection-propagation.ts;
// Follow accumulates tracker observations through track-observations.ts.

import type { CropRect } from "../transcode/compose.js";

/** One emitted keyframe, normalized frame coords, coverage-padded by the caller. */
export interface TrackKeyframe {
    contentSec: number;
    rect: CropRect;
}

/** An accepted detector seed and its bounded mask, ready to become an auto
 * blur region. Hit counts and scores retain detector evidence for diagnostics. */
export interface DetectedTrack {
    startSec: number;
    endSec: number;
    keyframes: TrackKeyframe[];
    detHits: number;
    bestScore: number;
}

/** Intersection-over-union of two normalized rects (0..1). */
export function iou(a: CropRect, b: CropRect): number {
    return rectangleIou(a.xPct, a.yPct, a.wPct, a.hPct, b.xPct, b.yPct, b.wPct, b.hPct);
}

/** Keeps every observed change. Only stationary interiors can be removed without
 *  shifting the mask off a small target or erasing a brief reversal. */
export function appendTrackKeyframe(keyframes: TrackKeyframe[], contentSec: number, rect: CropRect): void {
    const last = keyframes[keyframes.length - 1];
    if (last && contentSec < last.contentSec) throw new Error("track keyframes must be time ordered");
    if (last?.contentSec === contentSec) {
        last.rect = { ...rect };
    } else {
        keyframes.push({ contentSec, rect: { ...rect } });
    }
    // Keep the predecessor of the current frame so a same-timestamp correction
    // cannot interpolate back across a long hold.
    const n = keyframes.length;
    if (
        n >= 4 &&
        sameRect(keyframes[n - 4]!.rect, keyframes[n - 3]!.rect) &&
        sameRect(keyframes[n - 3]!.rect, keyframes[n - 2]!.rect)
    ) {
        keyframes.splice(n - 3, 1);
    }
}

function sameRect(a: CropRect, b: CropRect): boolean {
    return a.xPct === b.xPct && a.yPct === b.yPct && a.wPct === b.wPct && a.hPct === b.hPct;
}

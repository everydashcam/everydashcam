import type { DetectedTrack } from "./detect-track.js";
import type { SeedDetection } from "./detection-propagation.js";
import type { DetectionQuality } from "./detection-sampling.js";
import { type TimeInterval, unionIntervals } from "./interval-set.js";
import type { SourceFrameTiming } from "./propagated-track.js";

/** Scheduled scans bound both neighboring trajectories, including tracked
 * observations on the boundary frame even when the scan itself is empty. */
export interface DetectionCheckpoint extends SourceFrameTiming {
    /** Original source PTS for resuming decode without a content-time round trip. */
    sourceTimestamp: number;
    seeds: SeedDetection[];
    tracks: DetectedTrack[];
    /** Failed tracker updates with no eligible same-frame recovery. */
    uncertainFrames?: SourceFrameTiming[];
}

/** Plain, completed evidence for one source ownership window and detector kind.
 * The client owns source identity; no decoded pixels or live trackers survive. */
export interface DetectionAnalysis {
    bounds: TimeInterval;
    quality: DetectionQuality;
    threshold: number;
    checkpoints: DetectionCheckpoint[];
    sourceFrames: SourceFrameTiming[];
}

export interface DetectionReusePlan {
    intervals: TimeInterval[];
    retained: DetectionCheckpoint[];
}

/** A seed depends on its two adjacent checkpoints. The first and last scans
 * can be forced off-grid endpoints, so neither they nor their neighbors are
 * reusable. Revisit the bordering retained scan to terminate new trajectories;
 * its own trajectory stays cached. This also handles sliding/disjoint ranges. */
export function planDetectionReuse(cached: DetectionAnalysis | undefined, bounds: TimeInterval): DetectionReusePlan {
    const checkpoints = cached?.checkpoints ?? [];
    const retained = checkpoints.filter((_checkpoint, index) => {
        if (index < 2 || index >= checkpoints.length - 2) return false;
        const before = checkpoints[index - 1]!;
        const after = checkpoints[index + 1]!;
        return before.contentSec >= bounds.startSec && after.contentSec + after.durationSec <= bounds.endSec;
    });
    if (!retained.length) return { intervals: [{ ...bounds }], retained };
    const first = retained[0]!;
    const nextFrame = cached!.sourceFrames.find((frame) => frame.contentSec > first.contentSec);
    // An overlapping boundary frame cannot be split at the next timestamp:
    // that would shorten the preceding trajectory's verified checkpoint hold.
    // Recompute the whole range to preserve the same masks as a fresh analysis.
    if (nextFrame && first.contentSec + first.durationSec > nextFrame.contentSec + 1e-6)
        return { intervals: [{ ...bounds }], retained: [] };
    return {
        intervals: unionIntervals([
            {
                startSec: bounds.startSec,
                endSec: Math.min(first.contentSec + first.durationSec, nextFrame?.contentSec ?? bounds.endSec),
            },
            { startSec: retained[retained.length - 1]!.contentSec, endSec: bounds.endSec },
        ]),
        retained,
    };
}

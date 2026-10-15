import { unionIntervals } from "./interval-set.js";

export interface DetectionFinding {
    startSec: number;
    endSec: number;
    seekSec: number;
}

/** A section is continuous time with at least one active mask. Object identity,
 * camera, detector kind and file boundaries do not split navigation sections.
 * Only the review intervals are merged; every original mask remains intact. */
export function groupDetectionFindings(items: readonly DetectionFinding[]): DetectionFinding[] {
    const seeks = new Map<number, number>();
    for (const item of items) {
        if (item.endSec <= item.startSec) continue;
        // Simultaneous findings can come from cameras with different frame
        // durations. The earliest interior target remains in every first frame.
        seeks.set(item.startSec, Math.min(seeks.get(item.startSec) ?? Infinity, item.seekSec));
    }
    return unionIntervals(items).map(({ startSec, endSec }) => ({ startSec, endSec, seekSec: seeks.get(startSec)! }));
}

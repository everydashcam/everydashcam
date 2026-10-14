// Exact time-interval arithmetic for the detector's shared decoding windows.

export interface TimeInterval {
    startSec: number;
    endSec: number;
}

/** Sorted union of overlapping or touching intervals. Preserve every gap:
 *  even a sub-frame interval can contain a displayed frame needing analysis. */
export function unionIntervals(intervals: readonly TimeInterval[]): TimeInterval[] {
    const sorted = intervals
        .filter((intervalItem) => intervalItem.endSec - intervalItem.startSec > 0)
        .sort((a, b) => a.startSec - b.startSec);
    const out: TimeInterval[] = [];
    for (const intervalItem of sorted) {
        const last = out[out.length - 1];
        if (last && intervalItem.startSec <= last.endSec) {
            last.endSec = Math.max(last.endSec, intervalItem.endSec);
        } else {
            out.push({ ...intervalItem });
        }
    }
    return out;
}

/** Summed length of a normalized interval list. */
export function totalIntervalSec(intervals: readonly TimeInterval[]): number {
    let total = 0;
    for (const intervalItem of intervals) total += Math.max(0, intervalItem.endSec - intervalItem.startSec);
    return total;
}

const TIMESTAMP_EPSILON_SEC = 1e-6;
export const PROPAGATION_INTERVAL_SEC = 1 / 15;

/** Use source timestamps in either direction to schedule tracker inference;
 * skipped frames still retain mask coverage. */
export function isPropagationUpdateDue(previousSec: number, contentSec: number): boolean {
    return Math.abs(contentSec - previousSec) + TIMESTAMP_EPSILON_SEC >= PROPAGATION_INTERVAL_SEC;
}

/** Select at most one source frame per call on an anchored time grid. The first
 * frame always fills the initial position; force includes an off-grid endpoint.
 * Missing ticks are skipped, never replayed. Callers own duplicate-frame policy. */
export function createFrameSampler(
    intervalSec: number,
    anchorSec: number,
): (contentSec: number, force?: boolean) => boolean {
    if (!Number.isFinite(anchorSec)) throw new Error("frame sampling anchor is invalid");
    if (!Number.isFinite(intervalSec) || intervalSec < 0) throw new Error("frame sampling interval is invalid");
    let first = true;
    let nextSampleSec = anchorSec;
    return (contentSec, force = false): boolean => {
        if (!Number.isFinite(contentSec)) throw new Error("frame sampling timestamp is invalid");
        if (intervalSec === 0) return true;
        if (!first && !force && contentSec + TIMESTAMP_EPSILON_SEC < nextSampleSec) return false;
        first = false;
        const nextIndex = Math.max(1, Math.floor((contentSec - anchorSec + TIMESTAMP_EPSILON_SEC) / intervalSec) + 1);
        nextSampleSec = anchorSec + nextIndex * intervalSec;
        return true;
    };
}

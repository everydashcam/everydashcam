// Decode failures in the last moments of a clip. Dashcams cut files on power
// loss, so the final GOP of the last clip of a trip is often truncated; the
// hardware decoder then fails a second or two before the indexed duration.
// Retrying at that position replays the same broken bytes, and a retry that
// gives up strands the player just short of the clip end - no 'ended', no
// advance to the next clip, no loop. Such a failure is treated as the end of
// the clip instead.

/** Seconds before the indexed clip end within which a decode failure counts as
 *  the clip having ended rather than as a transient fault. Generous enough for
 *  a truncated multi-second GOP, small enough that a genuine mid-clip fault
 *  still gets its retry. */
export const CLIP_TAIL_TOLERANCE_SEC = 2;

/**
 * Whether a decode failure at `positionSec` lies in the clip tail. Needs a
 * finite, positive duration; otherwise the failure is an ordinary one.
 */
export function isClipTailFailure(positionSec: number, durationSec: number | null | undefined): boolean {
    if (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec <= 0) return false;
    if (!Number.isFinite(positionSec)) return false;
    return positionSec >= durationSec - CLIP_TAIL_TOLERANCE_SEC;
}

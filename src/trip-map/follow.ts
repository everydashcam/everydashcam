// Camera rule while the library is still being read: the map keeps every track
// in frame, but moves only when a new trip no longer fits. Tracks landing inside
// the frame just appear. The first user touch ends following until the "show
// all trips" button turns it back on.

/** A rectangle in screen pixels of the map container. */
export interface ScreenBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** Padding of the fly-to when the tracks outgrow the frame. */
export const FOLLOW_FIT_PADDING_PX = 70;
export const FOLLOW_FIT_DURATION_MS = 450;
/**
 * The tracks still "fit" while they stay this far inside the frame edges. A
 * smaller margin than the fly-to padding, so a slightly grown box does not move
 * the camera on every new trip.
 */
const FOLLOW_FIT_INSET_PX = 24;

export interface FollowDecisionInput {
    /** Following is on: no user touch since the last "show all". */
    isFollowing: boolean;
    /** The camera has framed tracks at least once since following started. */
    hasFramed: boolean;
    /** All drawable tracks on screen, or null when there is nothing to frame. */
    tracksOnScreen: ScreenBox | null;
    viewportWidth: number;
    viewportHeight: number;
}

/** Whether the camera should fly to the full set of tracks now. */
export function shouldReframe(input: FollowDecisionInput): boolean {
    if (!input.isFollowing || !input.tracksOnScreen) return false;
    if (!input.hasFramed) return true;
    return !boxFitsView(input.tracksOnScreen, input.viewportWidth, input.viewportHeight);
}

function boxFitsView(box: ScreenBox, width: number, height: number): boolean {
    return (
        box.minX >= FOLLOW_FIT_INSET_PX &&
        box.minY >= FOLLOW_FIT_INSET_PX &&
        box.maxX <= width - FOLLOW_FIT_INSET_PX &&
        box.maxY <= height - FOLLOW_FIT_INSET_PX
    );
}

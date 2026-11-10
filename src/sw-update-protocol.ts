// The waiting worker is always the next release, so it must keep accepting this
// request. A request it does not recognise goes unanswered; the window then
// reloads without activating the update and loses its open recordings.
//
// `reason` and "declined" let a later worker refuse a request the page made by
// itself: such page code runs on the transition from one release to the next,
// so the next release cannot fix it, and only the waiting worker's answer can
// stop it. A worker may answer "declined" only to `reason: "auto"`. It must
// never decline a request with `reason: "user"` or without a reason: pages
// released before this field send none, and to them an unknown answer means a
// reload without the update. Pages of this release send only "user", and its
// worker never declines.
export const UPDATE_MESSAGE = "everydashcam:update-v1";
export type UpdateReason = "user" | "auto";
export type UpdateResult = "updating" | "otherWindows" | "declined";
export interface UpdateRequest {
    type: typeof UPDATE_MESSAGE;
    /** Absent in requests from pages released before the automatic restart. */
    reason?: UpdateReason;
}

export function isUpdateRequest(value: unknown): value is UpdateRequest {
    return typeof value === "object" && value !== null && (value as { type?: unknown }).type === UPDATE_MESSAGE;
}

export function isUpdateResult(value: unknown): value is UpdateResult {
    return value === "updating" || value === "otherWindows" || value === "declined";
}

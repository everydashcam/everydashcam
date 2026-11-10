// The waiting worker is always the next release, so it must keep accepting this
// request. A request it does not recognise goes unanswered, and the window stays
// open instead of restarting.
export const UPDATE_MESSAGE = "everydashcam:update-v1";
export type UpdateResult = "updating" | "otherWindows";
export interface UpdateRequest {
    type: typeof UPDATE_MESSAGE;
}

export function isUpdateRequest(value: unknown): value is UpdateRequest {
    return typeof value === "object" && value !== null && (value as { type?: unknown }).type === UPDATE_MESSAGE;
}

export function isUpdateResult(value: unknown): value is UpdateResult {
    return value === "updating" || value === "otherWindows";
}

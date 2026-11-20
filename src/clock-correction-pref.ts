// User preference: a manual shift of the camera clock, in whole minutes.
// For cameras set to the wrong zone or a missed DST change. displayTzSec
// (trips.ts) applies it, so every surface that shows the camera clock agrees.
// GPS time shown in the viewer's own zone (a trip without a camera zone) is
// left alone: it is already real local time.
//
// Storage: localStorage["everydashcam:clock-correction-minutes"]. Subscribers
// re-render views that keep camera-clock times on screen.

import { readLocalStorage, writeLocalStorage } from "./local-storage.js";
import { createSubscribers } from "./subscribers.js";

const STORAGE_KEY = "everydashcam:clock-correction-minutes";
/** A full day either way covers any zone error plus a wrong date setting. */
export const MAX_CLOCK_CORRECTION_MIN = 24 * 60;

const listeners = createSubscribers("clock-correction");
let cachedMinutes: number | null = null;

function isValidCorrection(minutes: number): boolean {
    return Number.isInteger(minutes) && Math.abs(minutes) <= MAX_CLOCK_CORRECTION_MIN;
}

/** Current correction in minutes; 0 when nothing valid is stored. */
export function getClockCorrectionMin(): number {
    if (cachedMinutes === null) {
        const stored = Number(readLocalStorage(STORAGE_KEY));
        cachedMinutes = isValidCorrection(stored) ? stored : 0;
    }
    return cachedMinutes;
}

/** Stores the correction and notifies subscribers. Ignores non-integer or
 *  out-of-range values and unchanged ones, so callers can pass raw input. */
export function setClockCorrectionMin(minutes: number): void {
    if (!isValidCorrection(minutes) || getClockCorrectionMin() === minutes) return;
    cachedMinutes = minutes;
    writeLocalStorage(STORAGE_KEY, String(minutes));
    listeners.emit();
}

/** Calls `listener` after the correction changed; returns an unsubscribe function. */
export function subscribeClockCorrectionChange(listener: () => void): () => void {
    return listeners.subscribe(listener);
}

export function _resetForTests(): void {
    cachedMinutes = null;
    listeners.clear();
}

// Preferences of the map of all trips. The map's own buttons and the settings
// toggles write the same values, so a change in one place shows in the other.

import { readLocalStorageJson, writeLocalStorageJson } from "../local-storage.js";
import { createSubscribers } from "../subscribers.js";

export interface TripMapPreferences {
    /** The map fills the viewer while no trip is open. */
    isShownWithoutTrip: boolean;
    /** The user's trip markers are drawn on the map. */
    shouldShowMarkers: boolean;
}

const DEFAULT_PREFERENCES: Readonly<TripMapPreferences> = {
    isShownWithoutTrip: true,
    shouldShowMarkers: true,
};
const STORAGE_KEY = "everydashcam:tripMap";
let sessionPreferences: TripMapPreferences | null = null;
type Listener = (preferences: TripMapPreferences) => void;
const listeners = createSubscribers<Parameters<Listener>>("trip-map");

function normalizePreferences(value: unknown): TripMapPreferences {
    if (typeof value !== "object" || value === null) return { ...DEFAULT_PREFERENCES };
    const candidate = value as { isShownWithoutTrip?: unknown; shouldShowMarkers?: unknown };
    return {
        isShownWithoutTrip:
            typeof candidate.isShownWithoutTrip === "boolean"
                ? candidate.isShownWithoutTrip
                : DEFAULT_PREFERENCES.isShownWithoutTrip,
        shouldShowMarkers:
            typeof candidate.shouldShowMarkers === "boolean"
                ? candidate.shouldShowMarkers
                : DEFAULT_PREFERENCES.shouldShowMarkers,
    };
}

export function getTripMapPreferences(): TripMapPreferences {
    sessionPreferences ??= normalizePreferences(readLocalStorageJson(STORAGE_KEY));
    return { ...sessionPreferences };
}

export function setTripMapPreferences(preferences: TripMapPreferences): void {
    const next = normalizePreferences(preferences);
    const current = getTripMapPreferences();
    if (current.isShownWithoutTrip === next.isShownWithoutTrip && current.shouldShowMarkers === next.shouldShowMarkers)
        return;
    sessionPreferences = next;
    writeLocalStorageJson(STORAGE_KEY, next);
    listeners.emitWith(() => [{ ...next }]);
}

export function subscribeTripMapPreferences(listener: Listener): () => void {
    return listeners.subscribe(listener);
}

export function _resetForTests(): void {
    sessionPreferences = null;
    listeners.clear();
}

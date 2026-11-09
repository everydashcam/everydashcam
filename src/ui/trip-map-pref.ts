// Preferences of the map of all trips. The map's close button and the settings
// toggle write the same value, so turning the map off in one place shows in the
// other.

import { readLocalStorageJson, writeLocalStorageJson } from "../local-storage.js";
import { createSubscribers } from "../subscribers.js";

export interface TripMapPreferences {
    /** The map fills the viewer while no trip is open. */
    isShownWithoutTrip: boolean;
}

const DEFAULT_PREFERENCES: Readonly<TripMapPreferences> = {
    isShownWithoutTrip: true,
};
const STORAGE_KEY = "everydashcam:tripMap";
let sessionPreferences: TripMapPreferences | null = null;
type Listener = (preferences: TripMapPreferences) => void;
const listeners = createSubscribers<Parameters<Listener>>("trip-map");

function normalizePreferences(value: unknown): TripMapPreferences {
    if (typeof value !== "object" || value === null) return { ...DEFAULT_PREFERENCES };
    const candidate = value as { isShownWithoutTrip?: unknown };
    return {
        isShownWithoutTrip:
            typeof candidate.isShownWithoutTrip === "boolean"
                ? candidate.isShownWithoutTrip
                : DEFAULT_PREFERENCES.isShownWithoutTrip,
    };
}

export function getTripMapPreferences(): TripMapPreferences {
    sessionPreferences ??= normalizePreferences(readLocalStorageJson(STORAGE_KEY));
    return { ...sessionPreferences };
}

export function setTripMapPreferences(preferences: TripMapPreferences): void {
    const next = normalizePreferences(preferences);
    if (getTripMapPreferences().isShownWithoutTrip === next.isShownWithoutTrip) return;
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

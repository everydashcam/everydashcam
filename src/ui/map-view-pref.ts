import { createSubscribers } from "../subscribers.js";
import { readLocalStorageJson, writeLocalStorageJson } from "../local-storage.js";
export const MAP_STYLE_PRESETS = ["classic", "road", "minimal"] as const;
export type MapStylePreset = (typeof MAP_STYLE_PRESETS)[number];

export const MAP_THEME_CHOICES = ["auto", "light", "dark"] as const;
export type MapThemeChoice = (typeof MAP_THEME_CHOICES)[number];

export interface MapViewPreferences {
    style: MapStylePreset;
    theme: MapThemeChoice;
    buildings3d: boolean;
}

const DEFAULT_PREFERENCES: Readonly<MapViewPreferences> = {
    style: "classic",
    theme: "auto",
    buildings3d: true,
};
const STORAGE_KEY = "everydashcam:mapView";
let sessionPreferences: MapViewPreferences | null = null;
type Listener = (preferences: MapViewPreferences) => void;
const listeners = createSubscribers<Parameters<Listener>>("map-view");

function normalizePreferences(value: unknown): MapViewPreferences {
    if (typeof value !== "object" || value === null) return { ...DEFAULT_PREFERENCES };
    const candidate = value as { style?: unknown; theme?: unknown; buildings3d?: unknown };
    return {
        style: MAP_STYLE_PRESETS.find((preset) => preset === candidate.style) ?? DEFAULT_PREFERENCES.style,
        theme: MAP_THEME_CHOICES.find((theme) => theme === candidate.theme) ?? DEFAULT_PREFERENCES.theme,
        buildings3d:
            typeof candidate.buildings3d === "boolean" ? candidate.buildings3d : DEFAULT_PREFERENCES.buildings3d,
    };
}

function readStoredPreferences(): MapViewPreferences {
    return normalizePreferences(readLocalStorageJson(STORAGE_KEY));
}

export function getMapViewPreferences(): MapViewPreferences {
    sessionPreferences ??= readStoredPreferences();
    return { ...sessionPreferences };
}

export function setMapViewPreferences(preferences: MapViewPreferences): void {
    const next = normalizePreferences(preferences);
    const current = getMapViewPreferences();
    if (current.style === next.style && current.theme === next.theme && current.buildings3d === next.buildings3d)
        return;
    sessionPreferences = next;
    writeLocalStorageJson(STORAGE_KEY, next);
    listeners.emitWith(() => [{ ...next }]);
}

export function subscribeMapViewPreferences(listener: Listener): () => void {
    return listeners.subscribe(listener);
}

export function _resetForTests(): void {
    sessionPreferences = null;
    listeners.clear();
}

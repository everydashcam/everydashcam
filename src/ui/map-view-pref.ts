import type { MapShape } from "../transcode/types.js";
import { getMapProvider } from "./map-provider.js";
import { MAP_PROVIDER_REGISTRY } from "./map-provider-registry.js";
import { RADAR_THEMES, radarTheme, shapeForMapTheme } from "../map-radar.js";
import { createSubscribers } from "../subscribers.js";
import { readLocalStorageJson, writeLocalStorageJson } from "../local-storage.js";
export const MAP_STYLE_PRESETS = ["classic", "road", "minimal"] as const;
export type MapStylePreset = (typeof MAP_STYLE_PRESETS)[number];

export const MAP_THEMES = ["light", "dark", ...RADAR_THEMES] as const;
export const MAP_THEME_CHOICES = ["auto", ...MAP_THEMES] as const;
export type MapThemeChoice = (typeof MAP_THEME_CHOICES)[number];

export interface MapViewPreferences {
    style: MapStylePreset;
    theme: MapThemeChoice;
    miniMapShape: MapShape;
    rasterMiniMapShape?: MapShape;
    buildings3d: boolean;
}

const DEFAULT_PREFERENCES: Readonly<MapViewPreferences> = {
    style: "classic",
    theme: "auto",
    miniMapShape: "rect",
    buildings3d: true,
};
const STORAGE_KEY = "everydashcam:mapView";
let sessionPreferences: MapViewPreferences | null = null;
type Listener = (preferences: MapViewPreferences) => void;
const listeners = createSubscribers<Parameters<Listener>>("map-view");

function normalizePreferences(value: unknown): MapViewPreferences {
    if (typeof value !== "object" || value === null) return { ...DEFAULT_PREFERENCES };
    const candidate = value as {
        style?: unknown;
        theme?: unknown;
        miniMapShape?: unknown;
        rasterMiniMapShape?: unknown;
        buildings3d?: unknown;
    };
    const theme = MAP_THEME_CHOICES.find((item) => item === candidate.theme) ?? DEFAULT_PREFERENCES.theme;
    const rasterShape = candidate.rasterMiniMapShape;
    return {
        style: MAP_STYLE_PRESETS.find((preset) => preset === candidate.style) ?? DEFAULT_PREFERENCES.style,
        theme,
        miniMapShape:
            candidate.miniMapShape === "circle" || candidate.miniMapShape === "rect"
                ? candidate.miniMapShape
                : shapeForMapTheme(theme, DEFAULT_PREFERENCES.miniMapShape),
        ...(rasterShape === "circle" || rasterShape === "rect" ? { rasterMiniMapShape: rasterShape } : {}),
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

export function viewerRadarTheme(provider = getMapProvider()) {
    return MAP_PROVIDER_REGISTRY[provider].usesSelectedTheme ? radarTheme(getMapViewPreferences().theme) : undefined;
}

export function viewerMiniMapShape(): MapShape {
    const prefs = getMapViewPreferences();
    return MAP_PROVIDER_REGISTRY[getMapProvider()].usesSelectedTheme
        ? prefs.miniMapShape
        : (prefs.rasterMiniMapShape ?? "rect");
}

export function setViewerMiniMapShape(shape: MapShape): void {
    const key = MAP_PROVIDER_REGISTRY[getMapProvider()].usesSelectedTheme ? "miniMapShape" : "rasterMiniMapShape";
    setMapViewPreferences({ ...getMapViewPreferences(), [key]: shape });
}

export function setMapViewPreferences(preferences: MapViewPreferences): void {
    const next = normalizePreferences(preferences);
    const current = getMapViewPreferences();
    if (current.theme !== next.theme) next.miniMapShape = shapeForMapTheme(next.theme, next.miniMapShape);
    if (
        current.miniMapShape === next.miniMapShape &&
        current.rasterMiniMapShape === next.rasterMiniMapShape &&
        current.style === next.style &&
        current.theme === next.theme &&
        current.buildings3d === next.buildings3d
    )
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

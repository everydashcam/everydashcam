import type { MapShape } from "../transcode/types.js";
import { getMapProvider } from "./map-provider.js";
import { MAP_PROVIDER_REGISTRY } from "./map-provider-registry.js";
import { RADAR_THEMES, radarTheme, shapeForMapTheme } from "../map-radar.js";
import { createSubscribers } from "../subscribers.js";
import { readLocalStorageJson, writeLocalStorageJson } from "../local-storage.js";
import type { I18nKey } from "../i18n/keys.js";
export const MAP_STYLE_PRESETS = ["classic", "road", "minimal"] as const;
export type MapStylePreset = (typeof MAP_STYLE_PRESETS)[number];

/** Palettes in the order every picker lists them. */
export const MAP_THEMES = ["light", "dark", ...RADAR_THEMES, "neon"] as const;
export const MAP_THEME_CHOICES = ["auto", ...MAP_THEMES] as const;
export type MapThemeChoice = (typeof MAP_THEME_CHOICES)[number];

/** Viewer settings and the export panel name the same choices the same way. */
export const MAP_STYLE_PRESET_LABEL_KEYS = {
    classic: "settings.map.style.classic",
    road: "settings.map.style.road",
    minimal: "settings.map.style.minimal",
} as const satisfies Record<MapStylePreset, I18nKey>;

export const MAP_THEME_LABEL_KEYS = {
    auto: "settings.map.theme.auto",
    light: "settings.map.theme.light",
    dark: "settings.map.theme.dark",
    "la-92": "settings.map.theme.la-92",
    "miami-86": "settings.map.theme.miami-86",
    "tuner-04": "settings.map.theme.tuner-04",
    neon: "settings.map.theme.neon",
} as const satisfies Record<MapThemeChoice, I18nKey>;

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

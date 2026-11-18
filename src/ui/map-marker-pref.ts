import { radarTheme, type RadarTheme } from "../map-radar.js";
import { viewerRadarTheme } from "./map-view-pref.js";
import { createSubscribers } from "../subscribers.js";
import { readLocalStorageJson, writeLocalStorageJson, removeLocalStorage } from "../local-storage.js";
export const MAP_MARKER_SHAPES = ["arrow", "sedan", "suv", "motorcycle", "van", "truck"] as const;

export type MapMarkerShape = (typeof MAP_MARKER_SHAPES)[number];

export const MAP_MARKER_SIZES = ["small", "medium", "large"] as const;

export type MapMarkerSize = (typeof MAP_MARKER_SIZES)[number];

export const MAP_MARKER_SIZE_PX = {
    small: 36,
    medium: 44,
    large: 52,
} as const satisfies Record<MapMarkerSize, number>;

export interface MapMarkerAppearance {
    shape: MapMarkerShape;
    color: string;
    size: MapMarkerSize;
}

export const DEFAULT_MAP_MARKER_APPEARANCE: Readonly<MapMarkerAppearance> = {
    shape: "arrow",
    color: "#ff9000",
    size: "medium",
};

export const RADAR_MARKER_APPEARANCE: Readonly<MapMarkerAppearance> = {
    shape: "arrow",
    color: "#f4f4f2",
    size: "medium",
};

export function markerForMapTheme(map: {
    theme: string;
    marker: MapMarkerAppearance;
    gameMarkers?: Partial<Record<RadarTheme, MapMarkerAppearance>>;
}): MapMarkerAppearance {
    const game = radarTheme(map.theme);
    return game ? (map.gameMarkers?.[game] ?? RADAR_MARKER_APPEARANCE) : map.marker;
}

const STORAGE_KEY = "everydashcam:mapMarker";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const sessionAppearances = new Map<string, MapMarkerAppearance>();
type Listener = (appearance: MapMarkerAppearance) => void;
const listeners = createSubscribers<Parameters<Listener>>("map-marker");

function isMapMarkerShape(value: unknown): value is MapMarkerShape {
    return typeof value === "string" && (MAP_MARKER_SHAPES as readonly string[]).includes(value);
}

function isMapMarkerSize(value: unknown): value is MapMarkerSize {
    return typeof value === "string" && (MAP_MARKER_SIZES as readonly string[]).includes(value);
}

function normalizeColor(value: unknown, fallback: string): string {
    return typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

export function normalizeMapMarkerAppearance(
    value: unknown,
    fallback = DEFAULT_MAP_MARKER_APPEARANCE,
): MapMarkerAppearance {
    if (typeof value !== "object" || value === null) return { ...fallback };
    const candidate = value as { shape?: unknown; color?: unknown; size?: unknown };
    return {
        shape: isMapMarkerShape(candidate.shape) ? candidate.shape : fallback.shape,
        color: normalizeColor(candidate.color, fallback.color),
        size: isMapMarkerSize(candidate.size) ? candidate.size : fallback.size,
    };
}

function markerStorageKey(theme: string): string {
    const game = radarTheme(theme);
    return game ? `${STORAGE_KEY}:${game}` : STORAGE_KEY;
}

export function getMapMarkerAppearance(theme: string = viewerRadarTheme() ?? "light"): MapMarkerAppearance {
    const key = markerStorageKey(theme);
    let appearance = sessionAppearances.get(key);
    if (!appearance) {
        const fallback = radarTheme(theme) ? RADAR_MARKER_APPEARANCE : DEFAULT_MAP_MARKER_APPEARANCE;
        appearance = normalizeMapMarkerAppearance(readLocalStorageJson(key), fallback);
        sessionAppearances.set(key, appearance);
    }
    return { ...appearance };
}

export function setMapMarkerAppearance(appearance: MapMarkerAppearance): void {
    const next = normalizeMapMarkerAppearance(appearance);
    const current = getMapMarkerAppearance();
    if (current.shape === next.shape && current.color === next.color && current.size === next.size) return;
    const key = markerStorageKey(viewerRadarTheme() ?? "light");
    sessionAppearances.set(key, next);
    writeLocalStorageJson(key, next);
    listeners.emitWith(() => [{ ...next }]);
}

export function subscribeMapMarkerAppearance(listener: Listener): () => void {
    return listeners.subscribe(listener);
}

export function mapMarkerAppearanceKey(appearance: MapMarkerAppearance): string {
    return `${appearance.shape}:${appearance.color.toLowerCase()}`;
}

export function mapMarkerSizeScale(size: MapMarkerSize): number {
    return MAP_MARKER_SIZE_PX[size] / MAP_MARKER_SIZE_PX.medium;
}

export function _resetForTests(): void {
    for (const key of sessionAppearances.keys()) removeLocalStorage(key);
    sessionAppearances.clear();
    listeners.clear();
    removeLocalStorage(STORAGE_KEY);
}

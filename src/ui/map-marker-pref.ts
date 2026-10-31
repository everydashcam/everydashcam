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

const STORAGE_KEY = "everydashcam:mapMarker";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

let sessionAppearance: MapMarkerAppearance | null = null;
type Listener = (appearance: MapMarkerAppearance) => void;
const listeners = createSubscribers<Parameters<Listener>>("map-marker");

function isMapMarkerShape(value: unknown): value is MapMarkerShape {
    return typeof value === "string" && (MAP_MARKER_SHAPES as readonly string[]).includes(value);
}

function isMapMarkerSize(value: unknown): value is MapMarkerSize {
    return typeof value === "string" && (MAP_MARKER_SIZES as readonly string[]).includes(value);
}

function normalizeColor(value: unknown): string {
    return typeof value === "string" && HEX_COLOR.test(value)
        ? value.toLowerCase()
        : DEFAULT_MAP_MARKER_APPEARANCE.color;
}

export function normalizeMapMarkerAppearance(value: unknown): MapMarkerAppearance {
    if (typeof value !== "object" || value === null) return { ...DEFAULT_MAP_MARKER_APPEARANCE };
    const candidate = value as { shape?: unknown; color?: unknown; size?: unknown };
    return {
        shape: isMapMarkerShape(candidate.shape) ? candidate.shape : DEFAULT_MAP_MARKER_APPEARANCE.shape,
        color: normalizeColor(candidate.color),
        size: isMapMarkerSize(candidate.size) ? candidate.size : DEFAULT_MAP_MARKER_APPEARANCE.size,
    };
}

function readStoredAppearance(): MapMarkerAppearance {
    return normalizeMapMarkerAppearance(readLocalStorageJson(STORAGE_KEY));
}

export function getMapMarkerAppearance(): MapMarkerAppearance {
    sessionAppearance ??= readStoredAppearance();
    return { ...sessionAppearance };
}

export function setMapMarkerAppearance(appearance: MapMarkerAppearance): void {
    const next = normalizeMapMarkerAppearance(appearance);
    const current = getMapMarkerAppearance();
    if (current.shape === next.shape && current.color === next.color && current.size === next.size) return;
    sessionAppearance = next;
    writeLocalStorageJson(STORAGE_KEY, next);
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
    sessionAppearance = null;
    listeners.clear();
    removeLocalStorage(STORAGE_KEY);
}

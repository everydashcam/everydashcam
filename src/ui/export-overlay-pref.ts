// Browser persistence for the export overlay constructor. The persisted shape
// deliberately contains only overlay controls; trip range, output settings,
// cameras and blur zones keep their existing per-trip/session lifecycles.

import { readLocalStorageJson, removeLocalStorage, writeLocalStorageJson } from "../local-storage.js";
import { MAP_MARKER_SHAPES, MAP_MARKER_SIZES, type MapMarkerAppearance } from "./map-marker-pref.js";
import type { OverlayMapProviderPreference } from "./map-provider.js";
import type { OverlayMapState, OverlayPreferences, OverlayTextState } from "./export-state.js";

export const OVERLAY_PREFERENCES_STORAGE_KEY = "everydashcam:export:overlays";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const OVERLAY_STYLES = ["min", "card", "bold"] as const;
const MAP_SHAPES = ["rect", "circle"] as const;
const MAP_PROVIDERS: readonly OverlayMapProviderPreference[] = __PORTABLE__
    ? ["route-only", "openfreemap", "osm-vector"]
    : ["openfreemap", "osm-vector"];
const MAP_THEMES = ["light", "dark", "neon"] as const;
const MAP_LABEL_SIZES = [100, 125, 150, 200] as const;
const MAP_LABEL_DENSITIES = ["standard", "more", "max"] as const;
const MAP_MODES = ["north", "chase"] as const;

function record(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
    return allowed.includes(value as T) ? (value as T) : fallback;
}

function finiteInRange(value: unknown, fallback: number, min: number, max: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function color(value: unknown, fallback: string): string {
    return typeof value === "string" && HEX_COLOR.test(value) ? value : fallback;
}

function normalizeText(value: unknown, fallback: OverlayTextState): OverlayTextState {
    const candidate = record(value);
    if (!candidate) return { ...fallback };
    return {
        enabled: bool(candidate.enabled, fallback.enabled),
        xPct: finiteInRange(candidate.xPct, fallback.xPct, 0, 1),
        yPct: finiteInRange(candidate.yPct, fallback.yPct, 0, 1),
        scalePct: finiteInRange(candidate.scalePct, fallback.scalePct, 50, 200),
    };
}

function normalizeMarker(value: unknown, fallback: MapMarkerAppearance): MapMarkerAppearance {
    const candidate = record(value);
    if (!candidate) return { ...fallback };
    return {
        shape: oneOf(candidate.shape, MAP_MARKER_SHAPES, fallback.shape),
        color: color(candidate.color, fallback.color).toLowerCase(),
        size: oneOf(candidate.size, MAP_MARKER_SIZES, fallback.size),
    };
}

function normalizeMap(value: unknown, fallback: OverlayMapState): OverlayMapState {
    const candidate = record(value);
    if (!candidate) return { ...fallback, marker: { ...fallback.marker } };
    return {
        enabled: bool(candidate.enabled, fallback.enabled),
        provider: oneOf(candidate.provider, MAP_PROVIDERS, fallback.provider),
        xPct: finiteInRange(candidate.xPct, fallback.xPct, 0, 1),
        yPct: finiteInRange(candidate.yPct, fallback.yPct, 0, 1),
        scalePct: finiteInRange(candidate.scalePct, fallback.scalePct, 50, 200),
        zoomKm: finiteInRange(candidate.zoomKm, fallback.zoomKm, 0.1, 10),
        shape: oneOf(candidate.shape, MAP_SHAPES, fallback.shape),
        theme: oneOf(candidate.theme, MAP_THEMES, fallback.theme),
        labelScalePct: oneOf(candidate.labelScalePct, MAP_LABEL_SIZES, fallback.labelScalePct),
        labelDensity: oneOf(candidate.labelDensity, MAP_LABEL_DENSITIES, fallback.labelDensity),
        marker: normalizeMarker(candidate.marker, fallback.marker),
        mode: oneOf(candidate.mode, MAP_MODES, fallback.mode),
        pitchDeg: finiteInRange(candidate.pitchDeg, fallback.pitchDeg, 0, 70),
        adaptiveZoom: bool(candidate.adaptiveZoom, fallback.adaptiveZoom),
    };
}

/** Restores valid fields independently so a newly added or corrupt field falls
 *  back without discarding the rest of the user's layout. */
export function normalizeOverlayPreferences(value: unknown, defaults: OverlayPreferences): OverlayPreferences {
    const candidate = record(value);
    if (!candidate) return cloneOverlayPreferences(defaults);
    return {
        overlayStyle: oneOf(candidate.overlayStyle, OVERLAY_STYLES, defaults.overlayStyle),
        overlayAccent: color(candidate.overlayAccent, defaults.overlayAccent),
        overlayScrim: bool(candidate.overlayScrim, defaults.overlayScrim),
        overlaySpeed: normalizeText(candidate.overlaySpeed, defaults.overlaySpeed),
        overlayCoords: normalizeText(candidate.overlayCoords, defaults.overlayCoords),
        overlayMap: normalizeMap(candidate.overlayMap, defaults.overlayMap),
        overlayClock: normalizeText(candidate.overlayClock, defaults.overlayClock),
        overlayCompass: normalizeText(candidate.overlayCompass, defaults.overlayCompass),
        overlayGforce: normalizeText(candidate.overlayGforce, defaults.overlayGforce),
        overlayDistance: normalizeText(candidate.overlayDistance, defaults.overlayDistance),
        overlayGraph: normalizeText(candidate.overlayGraph, defaults.overlayGraph),
    };
}

export function cloneOverlayPreferences(preferences: OverlayPreferences): OverlayPreferences {
    return {
        overlayStyle: preferences.overlayStyle,
        overlayAccent: preferences.overlayAccent,
        overlayScrim: preferences.overlayScrim,
        overlaySpeed: { ...preferences.overlaySpeed },
        overlayCoords: { ...preferences.overlayCoords },
        overlayMap: { ...preferences.overlayMap, marker: { ...preferences.overlayMap.marker } },
        overlayClock: { ...preferences.overlayClock },
        overlayCompass: { ...preferences.overlayCompass },
        overlayGforce: { ...preferences.overlayGforce },
        overlayDistance: { ...preferences.overlayDistance },
        overlayGraph: { ...preferences.overlayGraph },
    };
}

export function overlayPreferencesKey(preferences: OverlayPreferences): string {
    return JSON.stringify(preferences);
}

export function readStoredOverlayPreferences(defaults: OverlayPreferences): OverlayPreferences {
    return normalizeOverlayPreferences(readLocalStorageJson(OVERLAY_PREFERENCES_STORAGE_KEY), defaults);
}

/** Default layouts need no storage entry. This also makes Reset remove the
 *  preference instead of leaving a redundant copy that could mask new defaults. */
export function persistOverlayPreferences(current: OverlayPreferences, defaults: OverlayPreferences): void {
    if (overlayPreferencesKey(current) === overlayPreferencesKey(defaults)) {
        removeLocalStorage(OVERLAY_PREFERENCES_STORAGE_KEY);
    } else {
        writeLocalStorageJson(OVERLAY_PREFERENCES_STORAGE_KEY, current);
    }
}

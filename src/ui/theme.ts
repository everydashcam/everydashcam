// Theme colors: single place that reads --dc-* CSS variables for consumers that do not
// understand CSS (canvas, MapLibre paint, Chart.js dataset colors, inline SVG).
// Cache is invalidated via refreshThemeColors() on prefers-color-scheme change.
//
// state.chart is touched here intentionally - refreshThemeColors rewrites scale/dataset colors
// of the live chart. When chart moves to its own module, replace direct access with a callback or event.

import { readLocalStorage, writeLocalStorage } from "../local-storage.js";
import { createSubscribers } from "../subscribers.js";
import type { EventKind } from "../events.js";

import { state } from "./state.js";
import { getMapViewPreferences } from "./map-view-pref.js";

export type MapTheme = "light" | "dark";

/**
 * Which base-map style.json to load. Superset of MapTheme: the live app map only
 * ever uses light/dark, but the export "map overlay" lets
 * the user pick "neon" too - a semi-transparent black slot with orange-glowing
 * roads/buildings/cities, independent of the app theme. Kept separate from
 * MapTheme so currentMapTheme()'s contract (it returns the effective map theme,
 * never "neon") stays honest.
 */
export type MapStyleId = MapTheme | "neon";

/** UX-24: user theme choice. "auto" follows OS (default), "light"/"dark" is an explicit override. */
export type ThemeChoice = "auto" | "light" | "dark";

const THEME_STORAGE_KEY = "dc-theme";
let userThemeChoice: ThemeChoice = "auto";

function isThemeChoice(s: string | null): s is ThemeChoice {
    return s === "auto" || s === "light" || s === "dark";
}

/** Reads the stored theme choice from localStorage. Returns "auto" when nothing is stored or localStorage is unavailable. */
export function loadStoredTheme(): ThemeChoice {
    const v = readLocalStorage(THEME_STORAGE_KEY);
    return isThemeChoice(v) ? v : "auto";
}

/**
 * Applies the chosen theme: sets the class on <html>, persists to localStorage,
 * invalidates the theme cache. Does not reload the map style - that is the caller's
 * responsibility (see app.ts) because the map may not exist yet on first init.
 */
export function applyTheme(choice: ThemeChoice): void {
    userThemeChoice = choice;
    writeLocalStorage(THEME_STORAGE_KEY, choice);
    if (typeof document !== "undefined") {
        const root = document.documentElement;
        root.classList.remove("dc-light", "dc-dark");
        if (choice === "light") root.classList.add("dc-light");
        else if (choice === "dark") root.classList.add("dc-dark");
        // auto - both classes removed; media-queries take over.
    }
    refreshThemeColors();
}

/** The interface preference; the map can use its own independent palette. */
export function getThemeChoice(): ThemeChoice {
    return userThemeChoice;
}

/** The map follows the interface unless its own palette is explicitly chosen. */
export function currentMapTheme(): MapTheme {
    const mapTheme = getMapViewPreferences().theme;
    if (mapTheme !== "auto") return mapTheme;
    if (userThemeChoice === "dark") return "dark";
    if (userThemeChoice === "light") return "light";
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
        return "dark";
    }
    return "light";
}

const MAP_COLORS = {
    light: { background: "#f5f4ef", trackVeil: "rgba(245,244,239,0.45)", markerStroke: "#0e0e0e" },
    dark: { background: "#14171c", trackVeil: "rgba(20,23,28,0.45)", markerStroke: "#fff" },
} as const;

/** Map overlays use the basemap palette even when the interface has a different theme. */
export function mapThemeColors(theme: MapTheme): (typeof MAP_COLORS)[MapTheme] {
    return MAP_COLORS[theme];
}

/** Reads a CSS variable value (--fg-dim, --border, etc.) from :root computed style. CSS variable values may include leading spaces. */
export function getCssVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Appends an 8-bit hex alpha to a hex color, producing a valid #rrggbbaa.
 *
 * Robust to the production CSS minifier shortening #rrggbb -> #rgb (e.g.
 * #000000 -> #000): a naive `${color}b8` on a shortened #000 yields the invalid
 * 5-digit #000b8, which maplibre rejects with a hard error (breaking the trail
 * overlay on every dark-theme trip load) and chart.js silently renders wrong.
 * A 3-digit shorthand is expanded to 6 digits first; anything else (already
 * 6-digit, rgb(), etc.) passes through unchanged.
 */
export function withAlpha(color: string, alphaHex: string): string {
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color.trim());
    const base = short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : color.trim();
    return `${base}${alphaHex}`;
}

/**
 * Color cache for consumers that need concrete hex strings (canvas, inline SVG, MapLibre paint, Chart.js datasets).
 * These consumers do not understand CSS variables. Tokens are read once on first access and
 * invalidated on prefers-color-scheme change via refreshThemeColors().
 */
interface ThemeColors {
    track: [string, string, string, string, string]; // --dc-track-1..5 (slow → fast gradient)
    trackOutline: string;
    trackHalo: string;
    chartSpeed: string; // --dc-blue
    chartAccel: string; // --dc-orange
    chartCursor: string; // --dc-red
    chartGrid: string; // --border (axis-grid + zoom-overlay border)
    chartTickText: string; // --fg-dim
    eventBrake: string; // --dc-red
    markerStart: string; // --dc-green
    markerEnd: string; // --dc-red
    markerStroke: string; // --dc-marker-stroke (#fff on dark / #0E0E0E on light)
    // Inferred event strip bars (under the chart). Match canonical signal
    // colors used elsewhere - red for brake, yellow for turn (caution),
    // green for accel (go), dim fg for stop.
    inferredStop: string;
    inferredBrake: string;
    inferredTurn: string;
    inferredAccel: string;
    // Recording-mode timeline bands (chart.ts): low-alpha full-height tints
    // behind the plot marking non-normal footage. event = violet, parking =
    // cool blue, manual = neutral grey. Alpha is baked in at ~10% so the speed
    // curve, gridlines, hover cursor and event markers stay readable on top.
    // Composed from --dc-* tokens, read again on every theme change.
    bandEvent: string;
    bandParking: string;
    bandManual: string;
}

let _themeColors: ThemeColors | null = null;

/** Listeners notified after the cache is invalidated and Chart.js scales
 *  are updated. Used by canvas-based renderers that need to redraw with
 *  fresh colors on theme change - they cannot watch a CSS variable directly. */
type ThemeChangeListener = () => void;
const themeChangeListeners = createSubscribers<Parameters<ThemeChangeListener>>("theme");

export function subscribeThemeChange(handler: ThemeChangeListener): () => void {
    return themeChangeListeners.subscribe(handler);
}

export function themeColors(): ThemeColors {
    if (_themeColors) return _themeColors;
    const border = getCssVar("--border");
    _themeColors = {
        track: [
            getCssVar("--dc-track-1"),
            getCssVar("--dc-track-2"),
            getCssVar("--dc-track-3"),
            getCssVar("--dc-track-4"),
            getCssVar("--dc-track-5"),
        ],
        trackOutline: getCssVar("--dc-track-outline"),
        trackHalo: getCssVar("--dc-track-halo"),
        chartSpeed: getCssVar("--dc-blue"),
        chartAccel: getCssVar("--dc-orange"),
        chartCursor: getCssVar("--dc-red"),
        chartGrid: border,
        chartTickText: getCssVar("--fg-dim"),
        eventBrake: getCssVar("--dc-red"),
        markerStart: getCssVar("--dc-green"),
        markerEnd: getCssVar("--dc-red"),
        markerStroke: getCssVar("--dc-marker-stroke"),
        // Read through the semantic --ev-* aliases so the light-theme override
        // (--ev-stop = --dc-stone-3) flows through automatically. Direct
        // physical tokens would freeze the strip on the dark palette.
        inferredStop: getCssVar("--ev-stop"),
        inferredBrake: getCssVar("--ev-brake"),
        inferredTurn: getCssVar("--ev-turn"),
        inferredAccel: getCssVar("--ev-accel"),
        // ~10% alpha (0x1a = 26/255): a full-height wash that reads as a tint,
        // not a fill. Event recordings take violet, the one hue the timeline
        // leaves free: red is braking in the driving lanes, orange the |G|
        // curve and the selection tint. Parking reuses the info blue, manual
        // the dim-fg grey.
        bandEvent: withAlpha(getCssVar("--dc-violet"), "1a"),
        bandParking: withAlpha(getCssVar("--dc-blue"), "1a"),
        bandManual: withAlpha(getCssVar("--fg-dim"), "1a"),
    };
    return _themeColors;
}

/**
 * Clears the cache and pushes new colors to the live chart.
 * Triggered by the matchMedia listener on prefers-color-scheme change.
 * Map markers update naturally on the next refreshMap (trip change) - no ad-hoc SVG DOM traversal here.
 */
export function refreshThemeColors(): void {
    _themeColors = null;
    const tc = themeColors();
    if (state.chart) {
        const opts = state.chart.options as unknown as {
            scales: Record<
                string,
                { ticks?: { color?: string }; grid?: { color?: string }; title?: { color?: string } }
            >;
        };
        const xScale = opts.scales.x;
        if (xScale?.ticks) xScale.ticks.color = tc.chartTickText;
        if (xScale?.grid) xScale.grid.color = withAlpha(tc.chartGrid, "55");
        const ySpeed = opts.scales.ySpeed;
        if (ySpeed?.ticks) ySpeed.ticks.color = tc.chartSpeed;
        if (ySpeed?.grid) ySpeed.grid.color = withAlpha(tc.chartGrid, "33");
        if (ySpeed?.title) ySpeed.title.color = tc.chartSpeed;
        const yAccel = opts.scales.yAccel;
        if (yAccel?.ticks) yAccel.ticks.color = tc.chartAccel;
        if (yAccel?.title) yAccel.title.color = tc.chartAccel;
        // Dataset borderColor / backgroundColor from the same cache.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const datasets = (state.chart.data as any).datasets as Array<{
            borderColor?: string;
            backgroundColor?: string;
        }>;
        if (datasets[0]) {
            datasets[0].borderColor = tc.chartSpeed;
            datasets[0].backgroundColor = withAlpha(tc.chartSpeed, "33");
        }
        if (datasets[1]) {
            datasets[1].borderColor = tc.chartAccel;
        }
        state.chart.update("none");
    }
    // Notify canvas-based renderers (inferred event strip, etc.) that
    // cached colors changed. Chart.js gets fresh colors via the block above;
    // standalone canvases redraw themselves from themeColors().
    themeChangeListeners.emit();
}

/** Map polyline segment color by speed (km/h). Hotter color = faster, familiar from heat maps. */
export function speedKmhToColor(kmh: number): string {
    const t = themeColors().track;
    // 5-stop gradient --dc-track-1..5.
    if (kmh < 20) return t[0]; // blue: standstill/traffic jam
    if (kmh < 50) return t[1]; // green: yard/slow urban
    if (kmh < 80) return t[2]; // yellow: normal urban
    if (kmh < 110) return t[3]; // orange: highway
    return t[4]; // red: very fast
}

/** Event marker colors for the chart canvas. Mirrors --ev-* CSS variables (canvas cannot read CSS vars). Palette must stay in sync with tooltip styles that use those variables. */
export function eventColors(): Record<EventKind, string> {
    return { brake: themeColors().eventBrake };
}

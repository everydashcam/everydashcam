// Single source of truth for the burned-in telemetry overlay styling, in the
// worker's canvas-2D vocabulary (no CSS tokens, no DOM). The UI preview calls
// the SAME draw code into a canvas over the player, so what the user arranges
// matches the encoded frame (there is one rendering path, not a CSS mirror).
//
// Three style systems, from the export-overlay design handoff:
//   - "min"  - text only, drop-shadow for legibility (the default; reproduces
//              the pre-telemetry plate-less look).
//   - "card" - each widget on a dark translucent plate with a hairline border.
//   - "bold" - speed becomes a huge accent readout with a hazard stripe; the
//              rest go semibold with a drop-shadow.
// Only the self-hosted families (Inter variable, JetBrains Mono variable) are
// used; CSP is font-src 'self', so no design-mock display face is pulled in.

import { createLogger } from "../log.js";
import type { OverlayStyleId } from "./types.js";
import { type FontSpec, loadFontsIntoScope } from "./worker-fonts.js";

const log = createLogger("transcode:overlay-fonts");

// Font family fallback chains. Weights are baked into ctx.font per call.
// The brand display face is not used here: numeric readouts use the monospace
// face, so no overlay widget needs it (the watermark still loads it on its own).
const FONT_INTER = `"Inter", system-ui, sans-serif`;
const FONT_MONO = `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace`;

/** A color role that resolves to the run's accent at draw time. */
export type StyleColor = string | "accent";

/**
 * Resolved appearance of one style. Drawing code reads these instead of
 * branching on the style id, so adding a style is one table entry. Colors are
 * literal rgba/hex except where "accent" defers to the per-run accent.
 */
export interface StyleChrome {
    /** Plate fill behind a widget. null = no plate (text + shadow only). */
    plate: string | null;
    /** Hairline border stroked around the plate. null = no border. */
    plateBorder: string | null;
    /** Soft drop-shadow on text (legibility without a plate). */
    shadow: boolean;
    /** Big numeric value font family + weight. */
    numFont: string;
    numWeight: string;
    /** Unit suffix / coordinate / clock-secondary font family + weight. */
    readFont: string;
    readWeight: string;
    /** Main value color. */
    valueColor: StyleColor;
    /** Unit suffix color (km/h, mi). */
    unitColor: StyleColor;
    /** Secondary line color (clock time line below the date). */
    secondaryColor: string;
    /** Hemisphere key color for the coordinate widget (N/E/S/W letters). */
    coordKeyColor: StyleColor;
    /** Speed becomes the hero readout - oversized, accent-colored, with a hazard
     *  stripe down its left edge (the "bold" signature). Other widgets ignore it. */
    heroSpeed: boolean;
    /** Dial ring fill (compass / G-force). */
    dialFill: string;
    /** Dial ring stroke. */
    dialStroke: StyleColor;
}

export const STYLE_CHROME: Record<OverlayStyleId, StyleChrome> = {
    min: {
        plate: null,
        plateBorder: null,
        shadow: true,
        // Numeric readouts use the monospace face in every style: its fixed
        // advance keeps a changing digit count from shifting the value (the
        // width reserve handles the plate/unit, this handles per-digit jitter).
        numFont: FONT_MONO,
        numWeight: "700",
        readFont: FONT_MONO,
        readWeight: "500",
        valueColor: "#FFFFFF",
        unitColor: "accent",
        secondaryColor: "rgba(255,255,255,0.72)",
        coordKeyColor: "accent",
        heroSpeed: false,
        dialFill: "rgba(0,0,0,0.28)",
        dialStroke: "rgba(255,255,255,0.5)",
    },
    card: {
        // The mock's backdrop blur is intentionally dropped: a canvas burn
        // cannot backdrop-blur cheaply, and preview == burn must hold (CLAUDE.md).
        // A slightly darker translucent plate carries the same legibility.
        plate: "rgba(10,10,10,0.62)",
        plateBorder: "rgba(255,255,255,0.13)",
        shadow: false,
        numFont: FONT_MONO,
        numWeight: "700",
        readFont: FONT_MONO,
        readWeight: "500",
        valueColor: "#FFFFFF",
        unitColor: "accent",
        secondaryColor: "rgba(255,255,255,0.72)",
        coordKeyColor: "accent",
        heroSpeed: false,
        dialFill: "rgba(10,10,10,0.62)",
        dialStroke: "rgba(255,255,255,0.2)",
    },
    bold: {
        plate: null,
        plateBorder: null,
        shadow: true,
        numFont: FONT_MONO,
        numWeight: "800",
        readFont: FONT_INTER,
        readWeight: "600",
        valueColor: "#FFFFFF",
        unitColor: "accent",
        secondaryColor: "rgba(255,255,255,0.8)",
        coordKeyColor: "accent",
        heroSpeed: true,
        dialFill: "rgba(0,0,0,0.32)",
        dialStroke: "accent",
    },
};

/** Resolves a StyleColor against the run accent. */
export function resolveStyleColor(c: StyleColor, accent: string): string {
    return c === "accent" ? accent : c;
}

/** Builds a canvas font string. */
export function composeFont(weight: string, px: number, family: string): string {
    return `${weight} ${Math.max(8, Math.round(px))}px ${family}`;
}

// --- Worker font loading -------------------------------------------------
// In a Worker there is no document and @font-face from the main thread's CSS
// does NOT apply; FontFaceSet is available via self.fonts but starts empty, so
// canvas text falls back to a system font. We construct FontFace objects from
// the self-hosted woff2 files and add them to the worker's font set. Which
// SUBSETS to load depends on the overlay locale: Latin always (digits, "GPS",
// km/h and the Latin-script locales) plus Cyrillic for ru. zh/ja/ko fall
// back to English text upstream (no CJK glyph in these fonts), so Latin covers
// them too. Failure is non-fatal: we log at info and let the fallback draw.

/** Script the overlay locale needs - selects the font subsets to load. */
export type OverlayLocaleScript = "latin" | "cyrillic";

// Stable public/ URLs (served at origin root by Vite, unhashed). The variable
// weight ranges ("100 900" Inter, "100 800" JetBrains Mono) cover every weight
// the styles bake into ctx.font.
const LATIN_FONTS: FontSpec[] = [
    { family: "Inter", weight: "100 900", url: "/fonts/inter-var-latin.woff2" },
    { family: "Inter", weight: "100 900", url: "/fonts/inter-var-latin-ext.woff2" },
    { family: "JetBrains Mono", weight: "100 800", url: "/fonts/jetbrains-mono-var-latin.woff2" },
    { family: "JetBrains Mono", weight: "100 800", url: "/fonts/jetbrains-mono-var-latin-ext.woff2" },
];

// Portable overlays use the fixed edition locale; other locales never request Cyrillic.
const CYRILLIC_FONTS: FontSpec[] =
    __PORTABLE__ && __PORTABLE_LOCALE__ !== "ru"
        ? []
        : [
              { family: "Inter", weight: "100 900", url: "/fonts/inter-var-cyrillic.woff2" },
              { family: "Inter", weight: "100 900", url: "/fonts/inter-var-cyrillic-ext.woff2" },
              { family: "JetBrains Mono", weight: "100 800", url: "/fonts/jetbrains-mono-var-cyrillic.woff2" },
              { family: "JetBrains Mono", weight: "100 800", url: "/fonts/jetbrains-mono-var-cyrillic-ext.woff2" },
          ];

// Cached per script: one run uses a single locale, but a later export in another
// language must load its subset without discarding the first run's cache.
const overlayFontsPromises = new Map<OverlayLocaleScript, Promise<void>>();

/**
 * Registers the overlay fonts for `script` into the current scope's FontFaceSet
 * (worker: self.fonts; main thread: document.fonts) and waits for them to load.
 * Idempotent per script (cached promise). "cyrillic" loads the Latin subsets too
 * (numbers, "GPS" and Latin-unit locales still draw Latin glyphs). Call before
 * the first frame rasterization when any non-watermark overlay is enabled; the
 * system-font fallback for the first frame would otherwise get cached for the
 * whole encode.
 *
 * Defensive throughout: a missing FontFaceSet, a missing FontFace constructor
 * (very old engines), or a failed fetch all degrade to the ctx.font fallback
 * chain rather than throwing - overlays are cosmetic and must never abort an
 * export.
 */
export function ensureOverlayFontsReady(script: OverlayLocaleScript = "latin"): Promise<void> {
    const cached = overlayFontsPromises.get(script);
    if (cached) return cached;
    const specs = script === "cyrillic" ? [...LATIN_FONTS, ...CYRILLIC_FONTS] : LATIN_FONTS;
    const promise = (async () => {
        await loadFontsIntoScope(specs);
        log.debug("overlay fonts ready", { script });
    })();
    overlayFontsPromises.set(script, promise);
    return promise;
}

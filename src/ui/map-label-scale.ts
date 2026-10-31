// Map label size: the user preference and the style transform applying it.
//
// MapLibre has no global text-scale knob - label sizes are baked into each
// style layer's layout["text-size"]. We fetch the style JSON ourselves
// (loadMapStyle in map.ts), so the viewer scales a CLONE of the cached style
// right before setStyle; the cache itself stays pristine, because the export
// snapshotter reads the same cache and applies its own independent factor
// (exportPanelState.overlayMap.labelScalePct).

import { readLocalStorage, writeLocalStorage } from "../local-storage.js";
import type { StyleSpecification } from "maplibre-gl";

import type { I18nKey } from "../i18n/keys.js";

/** Scale presets offered in settings. 1 = the style's own sizes. */
export const MAP_LABEL_SCALE_VALUES = [1, 1.25, 1.5, 2] as const;

export type MapLabelScale = (typeof MAP_LABEL_SCALE_VALUES)[number];

const STORAGE_KEY = "everydashcam:mapLabelScale";
let sessionLabelScale: MapLabelScale | null = null;

function isMapLabelScale(value: number): value is MapLabelScale {
    return (MAP_LABEL_SCALE_VALUES as readonly number[]).includes(value);
}

/** Stored label-scale preference for the live viewer maps; 1 when unset or
 *  the stored value is not one of the presets. */
export function getMapLabelScale(): MapLabelScale {
    if (sessionLabelScale !== null) return sessionLabelScale;
    const raw = readLocalStorage(STORAGE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return isMapLabelScale(parsed) ? parsed : 1;
}

/** Persists the label-scale preference. The caller re-applies the style to the
 *  live maps (reapplyMapLabelPrefs in map.ts) - there are no subscribers. */
export function setMapLabelScale(scale: MapLabelScale): void {
    sessionLabelScale = scale;
    writeLocalStorage(STORAGE_KEY, String(scale));
}

/** Street-name visibility presets: how aggressively road names are shown. */
export const STREET_LABEL_DENSITY_VALUES = ["standard", "more", "max"] as const;

export type StreetLabelDensity = (typeof STREET_LABEL_DENSITY_VALUES)[number];

const DENSITY_STORAGE_KEY = "everydashcam:streetLabelDensity";
let sessionStreetLabelDensity: StreetLabelDensity | null = null;

// Per level: how much denser a road name repeats along its line (spacing
// multiplier) and how many zoom levels earlier the road-name layers turn on.
// A minzoom pushed below the tile data's own availability is a harmless no-op,
// so the deltas do not need to know where the data actually starts.
const DENSITY_TUNING: Record<StreetLabelDensity, { spacingFactor: number; minzoomDelta: number }> = {
    standard: { spacingFactor: 1, minzoomDelta: 0 },
    more: { spacingFactor: 0.6, minzoomDelta: 1 },
    max: { spacingFactor: 0.35, minzoomDelta: 2 },
};

/** i18n keys for the density preset labels - shared by the map gear popover
 *  and the export overlay inspector so the two segments read identically. */
export const STREET_LABEL_DENSITY_LABEL_KEYS = {
    standard: "settings.map.streetNames.standard",
    more: "settings.map.streetNames.more",
    max: "settings.map.streetNames.max",
} as const satisfies Record<StreetLabelDensity, I18nKey>;

function isStreetLabelDensity(value: string): value is StreetLabelDensity {
    return (STREET_LABEL_DENSITY_VALUES as readonly string[]).includes(value);
}

/** Stored street-name density preference for the live viewer maps; "standard"
 *  when unset or the stored value is not one of the presets. */
export function getStreetLabelDensity(): StreetLabelDensity {
    if (sessionStreetLabelDensity !== null) return sessionStreetLabelDensity;
    const raw = readLocalStorage(DENSITY_STORAGE_KEY);
    return raw !== null && isStreetLabelDensity(raw) ? raw : "standard";
}

/** Persists the street-name density preference. The caller re-applies the
 *  style to the live maps (reapplyMapLabelPrefs in map.ts). */
export function setStreetLabelDensity(density: StreetLabelDensity): void {
    sessionStreetLabelDensity = density;
    writeLocalStorage(DENSITY_STORAGE_KEY, density);
}

export function _resetForTests(): void {
    sessionLabelScale = null;
    sessionStreetLabelDensity = null;
}

/**
 * Scales one text-size value. Zoom-driven values must keep "interpolate"/"step"
 * at the top level (MapLibre rejects a wrapping ["*", factor, expr]), so the
 * numeric OUTPUTS are scaled in place while the zoom breakpoints stay put.
 * An unrecognized expression is returned unchanged - an unscaled label beats a
 * style that fails to render.
 */
function scaleTextSizeValue(value: unknown, factor: number): unknown {
    if (typeof value === "number") return value * factor;
    if (Array.isArray(value)) {
        // ["interpolate", interp, input, stop1, out1, stop2, out2, ...]:
        // outputs sit at even indices from 4 on.
        if (value[0] === "interpolate") {
            return value.map((item, i) => (i >= 4 && i % 2 === 0 ? scaleTextSizeValue(item, factor) : item));
        }
        // ["step", input, out0, stop1, out1, ...]: outputs at even indices from 2 on.
        if (value[0] === "step") {
            return value.map((item, i) => (i >= 2 && i % 2 === 0 ? scaleTextSizeValue(item, factor) : item));
        }
        return value;
    }
    // Legacy zoom function: {base?, stops: [[zoom, size], ...]}.
    if (typeof value === "object" && value !== null && Array.isArray((value as { stops?: unknown }).stops)) {
        const fn = value as { stops: unknown[] };
        return {
            ...fn,
            stops: fn.stops.map((pair) =>
                Array.isArray(pair) && pair.length === 2 ? [pair[0], scaleTextSizeValue(pair[1], factor)] : pair,
            ),
        };
    }
    return value;
}

// Below ~2 glyph widths MapLibre is collision-bound anyway; a lower spacing
// only burns placement work without adding visible labels.
const MIN_SYMBOL_SPACING_PX = 60;

/**
 * Multiplies a line-placed symbol layer's symbol-spacing in place,
 * synthesizing the style-spec default of 250 when absent. Point-placed layers
 * are left alone (spacing has no effect there); an expression-valued spacing
 * is left unscaled - an unadjusted label beats a style that fails to render.
 */
function scaleLineSymbolSpacing(layout: Record<string, unknown>, factor: number): void {
    const placement = layout["symbol-placement"];
    // Enum "line"/"line-center", or a zoom expression that can evaluate to a
    // line placement (the road shields' ["step", ["zoom"], "point", 11, "line"]).
    const canBeLinePlaced = placement === "line" || placement === "line-center" || Array.isArray(placement);
    if (!canBeLinePlaced) return;
    const current = layout["symbol-spacing"] ?? 250;
    if (typeof current !== "number") return;
    layout["symbol-spacing"] = Math.max(MIN_SYMBOL_SPACING_PX, Math.round(current * factor));
}

/**
 * Returns a deep clone of `style` with every symbol layer's text-size
 * multiplied by `factor`. factor === 1 returns the input untouched (same
 * reference), so the default costs nothing. Every text layer in our shipped
 * styles carries an explicit text-size (asserted by the colocated test), so
 * the MapLibre default of 16 never needs synthesizing here.
 *
 * Line-placed text also gets its symbol-spacing divided by the same factor:
 * bigger text fits along a road segment less often and collides more, so
 * without compensation larger labels would show up RARER than standard ones.
 */
export function scaleStyleTextSizes(style: StyleSpecification, factor: number): StyleSpecification {
    if (factor === 1) return style;
    const clone = structuredClone(style);
    for (const layer of clone.layers) {
        if (layer.type !== "symbol" || !layer.layout) continue;
        const layout = layer.layout as Record<string, unknown>;
        if (layout["text-size"] === undefined) continue;
        layout["text-size"] = scaleTextSizeValue(layout["text-size"], factor);
        scaleLineSymbolSpacing(layout, 1 / factor);
    }
    return clone;
}

/**
 * Returns a clone of `style` where road names repeat more densely along their
 * lines and their layers turn on earlier by zoom. "standard" returns the
 * input untouched (same reference). Road-name layers are identified by their
 * vector source-layer: "transportation_name" for OpenMapTiles and
 * "street_labels" for Shortbread. Place/POI labels stay at the style's own
 * density.
 */
export function applyStreetLabelDensity(style: StyleSpecification, density: StreetLabelDensity): StyleSpecification {
    if (density === "standard") return style;
    const { spacingFactor, minzoomDelta } = DENSITY_TUNING[density];
    const clone = structuredClone(style);
    for (const layer of clone.layers) {
        if (
            layer.type !== "symbol" ||
            (layer["source-layer"] !== "transportation_name" && layer["source-layer"] !== "street_labels")
        )
            continue;
        if (typeof layer.minzoom === "number") {
            layer.minzoom = Math.max(0, layer.minzoom - minzoomDelta);
        }
        if (layer.layout) {
            scaleLineSymbolSpacing(layer.layout as Record<string, unknown>, spacingFactor);
        }
    }
    return clone;
}

/**
 * Applies every stored viewer label preference (text scale, then street-name
 * density) to the style. Both at their defaults return the input untouched -
 * the call sites pass the shared style cache, which must stay pristine.
 */
export function applyViewerLabelPrefs(style: StyleSpecification): StyleSpecification {
    return applyStreetLabelDensity(scaleStyleTextSizes(style, getMapLabelScale()), getStreetLabelDensity());
}

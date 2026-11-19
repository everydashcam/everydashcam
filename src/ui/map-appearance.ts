// How a map looks, and the one way that look becomes a MapLibre style. The
// viewer maps and the export overlay keep their own stored values, but every
// surface composes its style here, so a palette, preset or label size means the
// same in the player and in the saved video.

import type { StyleSpecification } from "maplibre-gl";

import { radarTheme } from "../map-radar.js";
import {
    applyStreetLabelDensity,
    getMapLabelScale,
    getStreetLabelDensity,
    scaleStyleTextSizes,
    type StreetLabelDensity,
} from "./map-label-scale.js";
import { getMapProvider, type MapProvider } from "./map-provider.js";
import { MAP_PROVIDER_REGISTRY } from "./map-provider-registry.js";
import { applyMapStylePreset, radarBaseStyle, readableRadarThemeMap } from "./map-style-preset.js";
import { getMapViewPreferences, type MapStylePreset } from "./map-view-pref.js";
import { currentMapTheme, isTranslucentMapTheme, mapThemeColors, type MapTheme } from "./theme.js";

export interface MapAppearance {
    /** The palette of the base style the caller loaded. */
    theme: MapTheme;
    preset: MapStylePreset;
    /** Multiplier of the style's own label sizes; 1 keeps them. */
    labelScale: number;
    labelDensity: StreetLabelDensity;
}

/**
 * Where a style is drawn. "mini" (the player inset) and "export" (the inset
 * burned into video) are small maps over footage; "main", "trips" and "preview"
 * fill a pane of their own.
 */
export type MapStyleSurface = "main" | "trips" | "preview" | "mini" | "export";

export function isInsetMapSurface(surface: MapStyleSurface): boolean {
    return surface === "mini" || surface === "export";
}

/** Changes exactly when composeMapStyle would return a different style for the same base and surface. */
export function mapAppearanceKey(appearance: MapAppearance): string {
    return `${appearance.theme}|${appearance.preset}|${appearance.labelScale}|${appearance.labelDensity}`;
}

/**
 * The viewer's appearance for `provider`. Providers that ignore the selected
 * palette (raster tiles) render as the light palette for overlay purposes and
 * never receive radar or translucent-palette rules.
 */
export function viewerMapAppearance(provider: MapProvider = getMapProvider()): MapAppearance {
    const preferences = getMapViewPreferences();
    return {
        theme: MAP_PROVIDER_REGISTRY[provider].usesSelectedTheme ? currentMapTheme() : "light",
        preset: preferences.style,
        labelScale: getMapLabelScale(),
        labelDensity: getStreetLabelDensity(),
    };
}

// Preset and label rules deep-clone a large style. Several viewer maps take the
// same style at once, so the last result per base is reused; the base object
// identity changes whenever the style cache refetches.
const labelledStyles = new WeakMap<StyleSpecification, { key: string; style: StyleSpecification }>();

function labelledStyle(base: StyleSpecification, appearance: MapAppearance): StyleSpecification {
    const key = mapAppearanceKey(appearance);
    const cached = labelledStyles.get(base);
    if (cached?.key === key) return cached.style;
    const style = applyStreetLabelDensity(
        scaleStyleTextSizes(applyMapStylePreset(base, appearance.preset), appearance.labelScale),
        appearance.labelDensity,
    );
    labelledStyles.set(base, { key, style });
    return style;
}

function withOpaqueBackground(style: StyleSpecification, color: string): StyleSpecification {
    return {
        ...style,
        layers: style.layers.map((layer) =>
            layer.type === "background" ? { ...layer, paint: { ...layer.paint, "background-color": color } } : layer,
        ),
    };
}

/**
 * Returns the style `surface` shows for `appearance`, built from the pristine
 * cached `base` of `appearance.theme`. The base is never modified, and default
 * settings on a full-size surface return it unchanged. Every surface applies
 * the preset and label settings first; insets then reduce a radar palette to
 * its moving-radar basemap, while full-size surfaces keep radar street names
 * readable and give a translucent palette an opaque ground.
 */
export function composeMapStyle(
    base: StyleSpecification,
    appearance: MapAppearance,
    surface: MapStyleSurface,
): StyleSpecification {
    const style = labelledStyle(base, appearance);
    const radar = radarTheme(appearance.theme);
    if (isInsetMapSurface(surface)) return radar ? radarBaseStyle(style, radar) : style;
    if (radar) return surface === "main" ? readableRadarThemeMap(style) : style;
    return isTranslucentMapTheme(appearance.theme)
        ? withOpaqueBackground(style, mapThemeColors(appearance.theme).background)
        : style;
}

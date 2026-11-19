import type {
    ExpressionSpecification,
    LayerSpecification,
    StyleSpecification,
    SymbolLayerSpecification,
} from "maplibre-gl";

import { radarSpec, type RadarTheme } from "../map-radar.js";
import type { MapStylePreset } from "./map-view-pref.js";

const ROAD_HIDDEN = new Set(["poi", "address", "context-label", "landuse", "boundary"]);
const MINIMAL_HIDDEN = new Set([...ROAD_HIDDEN, "poi-driver", "park", "landcover", "water-label"]);

const DRIVING_ROAD_CLASSES = [
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "minor",
    "residential",
    "living_street",
    "unclassified",
    "service",
    "road",
    "busway",
    "bus_guideway",
    "raceway",
];

function layerRole(layer: LayerSpecification): string | undefined {
    const metadata: unknown = layer.metadata;
    if (!metadata || typeof metadata !== "object") return undefined;
    if ("everydashcam:role" in metadata && typeof metadata["everydashcam:role"] === "string") {
        return metadata["everydashcam:role"];
    }
    // A controlling released worker can still serve cached styles.
    if ("dashcamigo:role" in metadata && typeof metadata["dashcamigo:role"] === "string") {
        return metadata["dashcamigo:role"];
    }
    return undefined;
}

/** Keep transport geometry and labels identical while reducing the surrounding
 * context. Unknown layers survive, including the final raster fallback. */
export function applyMapStylePreset(style: StyleSpecification, preset: MapStylePreset): StyleSpecification {
    if (preset === "classic") return style;
    const hidden = preset === "minimal" ? MINIMAL_HIDDEN : ROAD_HIDDEN;
    const clone = structuredClone(style);
    clone.layers = clone.layers.filter((layer) => {
        const role = layerRole(layer);
        return (
            role === undefined ||
            (!hidden.has(role) && !(preset === "road" && role === "park" && layer.type === "line"))
        );
    });
    if (preset === "road") {
        for (const layer of clone.layers) {
            const role = layerRole(layer);
            if (layer.type === "fill" && (role === "park" || role === "landcover")) {
                layer.paint = { ...layer.paint, "fill-opacity": 0.22 };
            }
        }
    }
    return clone;
}

export function isStreetNameLayer(layer: LayerSpecification): boolean {
    return layer.type === "symbol" && (layer.id.startsWith("highway-name-") || layer.id === "osm-street-labels");
}

/** The large map of a radar theme uses quieter geometry beneath the street names. Keep
 * viewer text scale, street density and any reduced-context preset in effect. */
export function readableRadarThemeMap(style: StyleSpecification): StyleSpecification {
    const layers: LayerSpecification[] = [];
    const streets: SymbolLayerSpecification[] = [];
    for (const layer of style.layers) {
        const role = layerRole(layer);
        if (layer.type === "symbol" && isStreetNameLayer(layer)) {
            streets.push({
                ...layer,
                layout: {
                    ...layer.layout,
                    "text-offset": [0, -0.85],
                    "text-padding": 4,
                    "text-pitch-alignment": "viewport",
                },
                paint: { ...layer.paint, "text-halo-width": 1.8, "text-halo-blur": 0.25 },
            });
        } else if (
            layer.type === "line" &&
            (layer["source-layer"] === "transportation" || layer["source-layer"] === "streets")
        ) {
            const opacity = layer.paint?.["line-opacity"] ?? 1;
            // Retain the existing tunnel opacity and the hierarchy of overpasses.
            if (typeof opacity !== "number" && !Array.isArray(opacity)) {
                layers.push(layer);
                continue;
            }
            layers.push({
                ...layer,
                paint: {
                    ...layer.paint,
                    "line-opacity": [
                        "*",
                        opacity,
                        [
                            "match",
                            ["get", layer["source-layer"] === "streets" ? "kind" : "class"],
                            ["path", "track", "footway", "cycleway", "bridleway", "steps", "service", "pedestrian"],
                            0.24,
                            ["minor", "residential", "living_street", "unclassified"],
                            0.62,
                            1,
                        ],
                    ],
                },
            });
        } else if (layer.type === "fill" && (role === "building" || role === "park" || role === "landcover")) {
            const opacity = layer.paint?.["fill-opacity"] ?? 1;
            const cap = role === "building" ? 0.36 : 0.56;
            layers.push(
                typeof opacity === "number"
                    ? { ...layer, paint: { ...layer.paint, "fill-opacity": Math.min(opacity, cap) } }
                    : layer,
            );
        } else if (layer.type === "symbol" && (role === "poi" || role === "poi-driver")) {
            layers.push({ ...layer, minzoom: Math.max(layer.minzoom ?? 0, role === "poi-driver" ? 16 : 17) });
        } else {
            layers.push(layer);
        }
    }
    // Later symbol layers get first choice of collision space.
    return { ...style, layers: [...layers, ...streets] };
}

/** A moving radar shows roads and terrain. Nearby addresses, street names and
 * POI icons compete with the route at this size. Only the basemap is filtered. */
export function radarBaseStyle(style: StyleSpecification, radar: RadarTheme): StyleSpecification {
    const layers: LayerSpecification[] = [];
    for (const layer of style.layers) {
        const role = layerRole(layer);
        if (layer.type === "symbol" || role === "poi" || role === "poi-driver") continue;
        if (
            radarSpec(radar).basemap === "full" ||
            layer.type === "background" ||
            layer.type === "raster" ||
            role === "water" ||
            (layer.type === "fill" && role === "park")
        ) {
            layers.push(layer);
        } else if (layer.type === "line" && role === "transport") {
            const sourceLayer = layer["source-layer"];
            if (sourceLayer !== "transportation" && sourceLayer !== "streets") continue;
            // Dashed layers only carry trails and railways, which driving radar omits.
            const metadata = layer.metadata as Record<string, unknown> | undefined;
            if (metadata?.["everydashcam:road-kind"] === "dashed") continue;
            // Both local vector styles use expression filters for roads. Keep their crossing and zoom
            // rules while omitting trails and railways from the driving radar.
            layers.push({
                ...layer,
                filter: [
                    "all",
                    (layer.filter as ExpressionSpecification | undefined) ?? true,
                    ["in", ["get", sourceLayer === "streets" ? "kind" : "class"], ["literal", DRIVING_ROAD_CLASSES]],
                ],
            });
        }
    }
    return { ...style, layers };
}

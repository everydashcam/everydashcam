// Compact Shortbread styles for the official OSM vector fallback, plus the
// final standard raster fallback. They intentionally use no remote glyphs or
// sprites: MapLibre renders labels with the self-hosted Inter webfont and the
// browser's system fallback for scripts Inter does not cover.

import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";

import radarPalettes from "./map-radar-palettes.json";
import { RADAR_THEMES, type RadarTheme } from "../map-radar.js";
import type { MapStyleId } from "./theme.js";
import type { MapProvider } from "./map-provider.js";

const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';
export const OSM_SHORTBREAD_SOURCE_ID = "osm-shortbread";
export const OSM_SHORTBREAD_BUILDING_SOURCE_LAYER = "buildings";

interface Palette {
    /** Opt-in geometry of radar palettes; see scripts/_map-style-palettes.mjs. */
    geometry?: { fillsGround: boolean; outlinedRoads: boolean };
    sand?: string;
    bridgeCasing?: string;
    roadInterior?: string;
    service?: string;
    transportArea?: string;
    background: string;
    water: string;
    waterLine: string;
    park: string;
    forest: string;
    site: string;
    building: string;
    buildingOutline: string;
    boundary: string;
    path: string;
    rail: string;
    roadCasing: string;
    roadMinor: string;
    roadMajor: string;
    motorway: string;
    label: string;
    labelMinor: string;
    labelHalo: string;
    waterLabel: string;
}

function radarPalette(theme: RadarTheme): Palette {
    const { geometry, colors } = radarPalettes[theme];
    return {
        ...colors,
        geometry,
        roadMinor: colors.minor,
        roadMajor: colors.primary,
        site: colors.landuse,
        labelHalo: colors.halo,
    };
}

const PALETTES: Record<MapStyleId, Palette> = {
    ...(Object.fromEntries(RADAR_THEMES.map((theme) => [theme, radarPalette(theme)])) as Record<RadarTheme, Palette>),
    light: {
        background: "#f5f4ef",
        water: "#a8d1e7",
        waterLine: "#7db6d2",
        park: "#dce8cc",
        forest: "#cfe1c3",
        site: "#eee9df",
        building: "#ded8ce",
        buildingOutline: "#c9c1b5",
        boundary: "#9c7c9d",
        path: "#c7b9a7",
        rail: "#8b8580",
        roadCasing: "#d2c7b8",
        roadMinor: "#ffffff",
        roadMajor: "#ffe6a5",
        motorway: "#f4a6a1",
        label: "#3e3b38",
        labelMinor: "#5f5a54",
        labelHalo: "#f8f7f3",
        waterLabel: "#397e9e",
    },
    dark: {
        background: "#14171c",
        water: "#182438",
        waterLine: "#263b58",
        park: "#15261c",
        forest: "#112117",
        site: "#171717",
        building: "#222226",
        buildingOutline: "#303037",
        boundary: "#725d77",
        path: "#504a43",
        rail: "#79757a",
        roadCasing: "#111114",
        roadMinor: "#303035",
        roadMajor: "#5b513b",
        motorway: "#744447",
        label: "#dedde0",
        labelMinor: "#aaa8ad",
        labelHalo: "#111113",
        waterLabel: "#6b9bc4",
    },
    neon: {
        background: "rgba(0,0,0,0.5)",
        water: "rgba(10,18,34,0.55)",
        waterLine: "#5b6d8b",
        park: "rgba(35,28,13,0.5)",
        forest: "rgba(30,25,12,0.5)",
        site: "rgba(24,18,12,0.45)",
        building: "rgba(255,144,0,0.05)",
        buildingOutline: "#ff9000",
        boundary: "#8c5b31",
        path: "#6e4c2e",
        rail: "#b26d2c",
        roadCasing: "#2c1708",
        roadMinor: "#9a5417",
        roadMajor: "#d77312",
        motorway: "#ff941f",
        label: "#ffc16f",
        labelMinor: "#d99a51",
        labelHalo: "#160d08",
        waterLabel: "#7f93b5",
    },
};

function nameExpression(): ExpressionSpecification {
    return ["coalesce", ["get", "name"], ["get", "name_en"], ""];
}

function lineWidth(low: number, high: number): ExpressionSpecification {
    return ["interpolate", ["linear"], ["zoom"], 5, low, 14, high];
}

function roadLineWidth(low: number, high: number): ExpressionSpecification {
    // Shortbread represents *_link roads as kind=<parent class> + link=true.
    // Full-width links turn interchanges into solid blobs in the mini-map.
    return [
        "interpolate",
        ["linear"],
        ["zoom"],
        5,
        ["*", low, ["case", ["==", ["get", "link"], true], 0.72, 1]],
        14,
        ["*", high, ["case", ["==", ["get", "link"], true], 0.72, 1]],
    ];
}

function roadCasingWidthAtZoom(
    motorway: number,
    primary: number,
    secondary: number,
    minor: number,
): ExpressionSpecification {
    const classWidth: ExpressionSpecification = [
        "case",
        ["==", ["get", "kind"], "motorway"],
        motorway,
        ["in", ["get", "kind"], ["literal", ["trunk", "primary"]]],
        primary,
        ["in", ["get", "kind"], ["literal", ["secondary", "tertiary"]]],
        secondary,
        minor,
    ];
    return ["*", classWidth, ["case", ["==", ["get", "link"], true], 0.72, 1]];
}

function roadCasingWidth(): ExpressionSpecification {
    // A single width made residential streets nearly as wide as motorways and
    // filled city blocks at z12-14. Preserve a compact visual hierarchy.
    return [
        "interpolate",
        ["linear"],
        ["zoom"],
        5,
        roadCasingWidthAtZoom(1.4, 1.2, 1, 0.8),
        14,
        roadCasingWidthAtZoom(5.8, 4.8, 4.2, 3.2),
    ];
}

function shortbreadLayers(theme: MapStyleId): LayerSpecification[] {
    const p = PALETTES[theme];
    const source = OSM_SHORTBREAD_SOURCE_ID;
    const groundSand = p.geometry?.fillsGround ? p.sand : undefined;
    const roadInterior = p.geometry?.outlinedRoads ? p.roadInterior : undefined;
    const layers: LayerSpecification[] = [
        { id: "osm-bg", type: "background", paint: { "background-color": p.background } },
        { id: "osm-ocean", type: "fill", source, "source-layer": "ocean", paint: { "fill-color": p.water } },
        ...(groundSand
            ? ([
                  {
                      id: "osm-urban-land",
                      type: "fill",
                      source,
                      "source-layer": "land",
                      filter: [
                          "in",
                          ["get", "kind"],
                          ["literal", ["residential", "commercial", "industrial", "retail"]],
                      ],
                      metadata: { "everydashcam:role": "landuse" },
                      paint: { "fill-color": p.site },
                  },
                  {
                      id: "osm-sand",
                      type: "fill",
                      source,
                      "source-layer": "land",
                      filter: ["in", ["get", "kind"], ["literal", ["sand", "beach", "bare_rock"]]],
                      paint: { "fill-color": groundSand },
                  },
              ] satisfies LayerSpecification[])
            : []),
        {
            id: "osm-water",
            type: "fill",
            source,
            "source-layer": "water_polygons",
            paint: { "fill-color": p.water },
        },
        {
            id: "osm-land-forest",
            type: "fill",
            source,
            "source-layer": "land",
            filter: ["in", ["get", "kind"], ["literal", ["forest", "wood", "scrub", "grass", "meadow"]]],
            paint: { "fill-color": p.forest, "fill-opacity": 0.8 },
        },
        {
            id: "osm-sites",
            type: "fill",
            source,
            "source-layer": "sites",
            paint: { "fill-color": p.site, "fill-opacity": 0.75 },
        },
        {
            id: "osm-land-park",
            type: "fill",
            source,
            "source-layer": "land",
            metadata: { "everydashcam:role": "park" },
            filter: [
                "in",
                ["get", "kind"],
                ["literal", ["park", "garden", "recreation_ground", "village_green", "cemetery"]],
            ],
            paint: { "fill-color": p.park, "fill-opacity": 0.85 },
        },
        {
            id: "osm-buildings",
            type: "fill",
            source,
            "source-layer": OSM_SHORTBREAD_BUILDING_SOURCE_LAYER,
            minzoom: 14,
            paint: { "fill-color": p.building, "fill-outline-color": p.buildingOutline },
        },
        {
            id: "osm-boundaries",
            type: "line",
            source,
            "source-layer": "boundaries",
            minzoom: 2,
            paint: {
                "line-color": p.boundary,
                "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.5, 10, 1.5],
                "line-dasharray": [3, 2],
                "line-opacity": 0.75,
            },
        },
        {
            id: "osm-water-lines",
            type: "line",
            source,
            "source-layer": "water_lines",
            minzoom: 9,
            paint: { "line-color": p.waterLine, "line-width": lineWidth(0.5, 2.5) },
        },
        {
            id: "osm-street-polygons",
            type: "fill",
            source,
            "source-layer": "street_polygons",
            minzoom: 11,
            paint: { "fill-color": p.transportArea ?? p.roadMinor, "fill-opacity": 0.8 },
        },
        {
            id: "osm-paths",
            type: "line",
            source,
            "source-layer": "streets",
            minzoom: 12,
            filter: [
                "in",
                ["get", "kind"],
                ["literal", ["path", "footway", "cycleway", "bridleway", "steps", "track"]],
            ],
            paint: { "line-color": p.path, "line-width": lineWidth(0.4, 1.5), "line-dasharray": [2, 1] },
        },
        {
            id: "osm-rail",
            type: "line",
            source,
            "source-layer": "streets",
            minzoom: 8,
            filter: [
                "in",
                ["get", "kind"],
                ["literal", ["rail", "narrow_gauge", "tram", "light_rail", "funicular", "monorail"]],
            ],
            paint: { "line-color": p.rail, "line-width": lineWidth(0.5, 2), "line-dasharray": [3, 2] },
        },
        {
            id: "osm-roads-casing",
            type: "line",
            source,
            "source-layer": "streets",
            filter: [
                "in",
                ["get", "kind"],
                [
                    "literal",
                    [
                        "motorway",
                        "trunk",
                        "primary",
                        "secondary",
                        "tertiary",
                        "residential",
                        "living_street",
                        "unclassified",
                        "service",
                        "pedestrian",
                        "busway",
                        "bus_guideway",
                        "road",
                    ],
                ],
            ],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": roadInterior
                    ? [
                          "match",
                          ["get", "kind"],
                          ["motorway", "trunk"],
                          p.motorway,
                          ["primary", "secondary", "tertiary"],
                          p.roadMajor,
                          "service",
                          p.service ?? p.roadMinor,
                          p.roadMinor,
                      ]
                    : p.bridgeCasing
                      ? ["case", ["==", ["get", "bridge"], true], p.bridgeCasing, p.roadCasing]
                      : p.roadCasing,
                "line-width": roadCasingWidth(),
            },
        },
        {
            id: "osm-roads-minor",
            type: "line",
            source,
            "source-layer": "streets",
            filter: [
                "in",
                ["get", "kind"],
                [
                    "literal",
                    [
                        "residential",
                        "living_street",
                        "unclassified",
                        "service",
                        "pedestrian",
                        "busway",
                        "bus_guideway",
                        "road",
                    ],
                ],
            ],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": roadInterior ?? p.roadMinor, "line-width": roadLineWidth(0.5, 2.4) },
        },
        {
            id: "osm-roads-major",
            type: "line",
            source,
            "source-layer": "streets",
            filter: ["in", ["get", "kind"], ["literal", ["trunk", "primary", "secondary", "tertiary"]]],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": roadInterior ?? p.roadMajor, "line-width": roadLineWidth(0.7, 3.6) },
        },
        {
            id: "osm-motorways",
            type: "line",
            source,
            "source-layer": "streets",
            filter: ["==", ["get", "kind"], "motorway"],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": roadInterior ?? p.motorway, "line-width": roadLineWidth(0.9, 4.6) },
        },
        {
            id: "osm-ferries",
            type: "line",
            source,
            "source-layer": "ferries",
            minzoom: 10,
            paint: { "line-color": p.waterLine, "line-width": 1.5, "line-dasharray": [3, 2] },
        },
        {
            id: "osm-oneway",
            type: "symbol",
            source,
            "source-layer": "streets",
            minzoom: 16,
            filter: ["==", ["get", "oneway"], true],
            layout: {
                "symbol-placement": "line",
                "symbol-spacing": 160,
                "text-field": ["case", ["==", ["get", "oneway_reverse"], true], "◀", "▶"],
                "text-font": ["Inter"],
                "text-size": 10,
                "text-rotation-alignment": "map",
                "text-keep-upright": false,
            },
            paint: { "text-color": p.labelMinor, "text-halo-color": p.labelHalo, "text-halo-width": 1 },
        },
        ...(["addresses", "pois"] as const).map(
            (sourceLayer): LayerSpecification => ({
                id: `osm-addresses-${sourceLayer}`,
                type: "symbol",
                source,
                "source-layer": sourceLayer,
                minzoom: 17,
                metadata: { "everydashcam:role": "address" },
                filter: ["has", "housenumber"],
                layout: {
                    "text-field": ["to-string", ["get", "housenumber"]],
                    "text-font": ["Inter"],
                    "text-size": 10,
                    "text-padding": 2,
                },
                paint: { "text-color": p.labelMinor, "text-halo-color": p.labelHalo, "text-halo-width": 1 },
            }),
        ),
        {
            id: "osm-poi-landmark",
            type: "symbol",
            source,
            "source-layer": "pois",
            minzoom: 14,
            metadata: { "everydashcam:role": "poi" },
            filter: [
                "all",
                ["has", "name"],
                [
                    "any",
                    ["in", ["get", "amenity"], ["literal", ["hospital", "school", "college", "library", "townhall"]]],
                    ["in", ["get", "tourism"], ["literal", ["museum", "attraction"]]],
                    ["==", ["get", "leisure"], "stadium"],
                    ["has", "shop"],
                ],
            ],
            layout: { "text-field": nameExpression(), "text-font": ["Inter"], "text-size": 11, "text-padding": 3 },
            paint: { "text-color": p.labelMinor, "text-halo-color": p.labelHalo, "text-halo-width": 1.2 },
        },
        {
            id: "osm-poi-driver",
            type: "symbol",
            source,
            "source-layer": "pois",
            minzoom: 14,
            metadata: { "everydashcam:role": "poi-driver" },
            filter: [
                "all",
                ["has", "name"],
                ["in", ["get", "amenity"], ["literal", ["fuel", "parking", "parking_entrance"]]],
            ],
            layout: { "text-field": nameExpression(), "text-font": ["Inter"], "text-size": 11, "text-padding": 3 },
            paint: { "text-color": p.label, "text-halo-color": p.labelHalo, "text-halo-width": 1.2 },
        },
        {
            id: "osm-water-labels",
            type: "symbol",
            source,
            "source-layer": "water_polygons_labels",
            minzoom: 7,
            layout: { "text-field": nameExpression(), "text-font": ["Inter"], "text-size": 12 },
            paint: { "text-color": p.waterLabel, "text-halo-color": p.labelHalo, "text-halo-width": 1 },
        },
        {
            id: "osm-water-line-labels",
            type: "symbol",
            source,
            "source-layer": "water_lines_labels",
            minzoom: 12,
            layout: {
                "symbol-placement": "line",
                "symbol-spacing": 450,
                "text-field": nameExpression(),
                "text-font": ["Inter"],
                "text-size": 11,
            },
            paint: { "text-color": p.waterLabel, "text-halo-color": p.labelHalo, "text-halo-width": 1 },
        },
        {
            id: "osm-street-labels",
            type: "symbol",
            source,
            "source-layer": "street_labels",
            minzoom: 11,
            layout: {
                "symbol-placement": "line",
                "symbol-spacing": 350,
                "text-field": nameExpression(),
                "text-font": ["Inter"],
                "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 14, 13],
                "text-max-angle": 35,
            },
            paint: { "text-color": p.labelMinor, "text-halo-color": p.labelHalo, "text-halo-width": 1.2 },
        },
        {
            id: "osm-road-refs",
            type: "symbol",
            source,
            "source-layer": "street_labels",
            minzoom: 10,
            filter: ["has", "ref"],
            layout: {
                "symbol-placement": "line",
                "symbol-spacing": 350,
                "text-field": ["get", "ref"],
                "text-font": ["Inter"],
                "text-size": 10,
                "text-rotation-alignment": "viewport",
            },
            paint: { "text-color": p.label, "text-halo-color": p.labelHalo, "text-halo-width": 1.5 },
        },
        {
            id: "osm-place-labels",
            type: "symbol",
            source,
            "source-layer": "place_labels",
            minzoom: 4,
            layout: {
                "text-field": nameExpression(),
                "text-font": ["Inter"],
                "text-size": ["interpolate", ["linear"], ["zoom"], 4, 11, 8, 14, 14, 17],
                "text-max-width": 9,
            },
            paint: { "text-color": p.label, "text-halo-color": p.labelHalo, "text-halo-width": 1.5 },
        },
        {
            id: "osm-boundary-labels",
            type: "symbol",
            source,
            "source-layer": "boundary_labels",
            maxzoom: 7,
            layout: {
                "text-field": nameExpression(),
                "text-font": ["Inter"],
                "text-size": ["interpolate", ["linear"], ["zoom"], 1, 11, 6, 15],
                "text-transform": "uppercase",
                "text-letter-spacing": 0.08,
            },
            paint: { "text-color": p.label, "text-halo-color": p.labelHalo, "text-halo-width": 1.5 },
        },
        {
            id: "osm-public-transport-labels",
            type: "symbol",
            source,
            "source-layer": "public_transport",
            minzoom: 13,
            layout: { "text-field": nameExpression(), "text-font": ["Inter"], "text-size": 10 },
            paint: { "text-color": p.labelMinor, "text-halo-color": p.labelHalo, "text-halo-width": 1 },
        },
    ];
    // Separate render groups preserve crossings even though road classes are
    // painted in separate layers. Shortbread 1.0 provides boolean flags.
    const roads = layers.filter((layer) => layer.type === "line" && layer["source-layer"] === "streets");
    const firstRoad = layers.findIndex((layer) => layer.id === roads[0]?.id);
    const roadGroups: LayerSpecification[] = [];
    for (const crossing of ["tunnel", "surface", "bridge"] as const) {
        for (const road of roads) {
            if (road.type !== "line") continue;
            const filter: ExpressionSpecification =
                crossing === "tunnel"
                    ? ["==", ["get", "tunnel"], true]
                    : crossing === "bridge"
                      ? ["all", ["==", ["get", "bridge"], true], ["!=", ["get", "tunnel"], true]]
                      : ["all", ["!=", ["get", "bridge"], true], ["!=", ["get", "tunnel"], true]];
            roadGroups.push({
                ...road,
                id: crossing === "surface" ? road.id : `${road.id}-${crossing}`,
                // These locally authored filters use expression syntax; the
                // generic layer type also permits incompatible legacy filters.
                filter: ["all", (road.filter as ExpressionSpecification | undefined) ?? true, filter],
                paint: crossing === "tunnel" ? { ...road.paint, "line-opacity": 0.65 } : road.paint,
            });
        }
    }
    layers.splice(firstRoad, roads.length, ...roadGroups);
    const roles: Record<string, string> = {
        ocean: "water",
        water_polygons: "water",
        water_lines: "water",
        land: "landcover",
        sites: "landuse",
        buildings: "building",
        boundaries: "boundary",
        boundary_labels: "boundary",
        streets: "transport",
        street_polygons: "transport",
        ferries: "transport",
        water_polygons_labels: "water-label",
        water_lines_labels: "water-label",
        street_labels: "transport-label",
        place_labels: "place-label",
        public_transport: "poi",
    };
    for (const layer of layers) {
        if (layer.metadata) continue;
        const role = "source-layer" in layer ? roles[layer["source-layer"] ?? ""] : "background";
        layer.metadata = { "everydashcam:role": role };
    }
    return layers;
}

export function createFallbackMapStyle(
    provider: Extract<MapProvider, "osm-vector" | "osm-raster">,
    theme: MapStyleId,
): StyleSpecification {
    if (provider === "osm-raster") {
        return {
            version: 8,
            name: "OpenStreetMap Standard fallback",
            sources: {
                "osm-raster": {
                    type: "raster",
                    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
                    tileSize: 256,
                    maxzoom: 19,
                    attribution: OSM_ATTRIBUTION,
                },
            },
            layers: [{ id: "osm-raster", type: "raster", source: "osm-raster" }],
        };
    }
    return {
        version: 8,
        name: `OpenStreetMap Shortbread ${theme} fallback`,
        sources: {
            [OSM_SHORTBREAD_SOURCE_ID]: {
                type: "vector",
                tiles: ["https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt"],
                minzoom: 0,
                maxzoom: 14,
                attribution: OSM_ATTRIBUTION,
            },
        },
        layers: shortbreadLayers(theme),
    };
}

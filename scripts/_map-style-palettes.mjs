// Geometry and label placement live in light.json; palettes recolour it. A
// radar palette may opt into the geometry flags in map-radar-palettes.json,
// which only add ground cover or outline roads. No palette may drop a bridge,
// road number or building merely because the UI theme changed.

import radarPalettes from "../src/ui/map-radar-palettes.json" with { type: "json" };
import { roadColorExpression, roadWidth } from "./_map-road-layers.mjs";

export const MAP_SDF_ICONS = ["arrow", "circle_11_black", "airport_11"];

const DARK = {
    background: "#14171c",
    water: "#20374a",
    waterLine: "#36566d",
    waterLabel: "#87b6d2",
    park: "#263b2c",
    parkOutline: "#405d43",
    forest: "#203629",
    landuse: "#20242b",
    building: "#303640",
    buildingOutline: "#434b57",
    boundary: "#80708c",
    roadCasing: "#15181d",
    bridgeCasing: "#76808b",
    minor: "#59616b",
    service: "#505861",
    secondary: "#9c9874",
    primary: "#b09a72",
    motorway: "#bd8890",
    path: "#938776",
    transportArea: "#252930",
    rail: "#868b94",
    label: "#e4e8ed",
    labelMinor: "#b4beca",
    halo: "#14171c",
    poi: "#aec5db",
    driverPoi: "#e1c78e",
};

const NEON = {
    background: "rgba(0,0,0,0.5)",
    water: "rgba(10,18,34,0.55)",
    waterLine: "#445675",
    waterLabel: "#8dabc6",
    park: "rgba(30,32,18,0.12)",
    parkOutline: "#64572f",
    forest: "rgba(28,31,16,0.12)",
    landuse: "rgba(30,24,18,0.1)",
    building: "rgba(255,144,0,0.05)",
    buildingOutline: "#b76a16",
    boundary: "#76532e",
    roadCasing: "#663608",
    bridgeCasing: "#a86212",
    minor: "#b35e00",
    service: "#995309",
    secondary: "#e89532",
    primary: "#ffb347",
    motorway: "#ffd9a0",
    path: "#936125",
    transportArea: "rgba(255,144,0,0.06)",
    rail: "#8a6337",
    label: "#ffe6c2",
    labelMinor: "#e5be87",
    halo: "#271605",
    poi: "#be9a66",
    driverPoi: "#ffd9a0",
};

const VARIANTS = {
    dark: { name: "Classic Dark", geometry: {}, colors: DARK },
    neon: { name: "Neon", geometry: {}, colors: NEON },
    ...radarPalettes,
};
export const MAP_STYLE_VARIANTS = Object.keys(VARIANTS);

function lineColor(layer, palette, geometry) {
    const kind = layer.metadata?.["everydashcam:road-kind"];
    if (kind) return roadColorExpression(palette, kind, geometry.outlinedRoads);
    const id = layer.id;
    if (layer["source-layer"] === "waterway" || id === "road_ferry") return palette.waterLine;
    if (layer["source-layer"] === "boundary") return palette.boundary;
    if (layer["source-layer"] === "park") return palette.parkOutline;
    if (id.includes("rail")) return palette.rail;
    if (id.includes("casing")) return id.startsWith("bridge_") ? palette.bridgeCasing : palette.roadCasing;
    if (id.includes("path")) return palette.path;
    if (id.includes("motorway")) return palette.motorway;
    if (id.includes("trunk_primary")) return palette.primary;
    if (id.includes("secondary_tertiary")) return palette.secondary;
    if (id.includes("service_track")) return palette.service;
    return palette.minor;
}

function usesSdfIcon(value) {
    if (Array.isArray(value)) return value.some(usesSdfIcon);
    return MAP_SDF_ICONS.includes(value);
}

export function createMapStyleVariant(light, theme) {
    const { name, geometry, colors: palette } = VARIANTS[theme];
    const style = structuredClone(light);
    style.name = `everydashcam ${name}`;
    style.sprite = "/styles/sprite/sprite";
    style.metadata = { ...style.metadata, "everydashcam:theme": theme };
    // fillsGround: a radar map has no empty background. Urban land and natural
    // ground (grass, farmland, sand, rock) are painted at every zoom.
    if (geometry.fillsGround) {
        // Urban areas extend down to street zoom. Parks and beaches inside
        // their boundaries must still paint on top.
        const residential = style.layers.findIndex((layer) => layer.id === "landuse_residential");
        const [urban] = style.layers.splice(residential, 1);
        style.layers.splice(
            style.layers.findIndex((layer) => layer.id === "park"),
            0,
            urban,
        );
    }
    for (const layer of style.layers) {
        layer.paint ??= {};
        const p = layer.paint;
        const role = layer.metadata?.["everydashcam:role"];
        if (layer.type === "background") p["background-color"] = palette.background;
        if (layer.type === "line") {
            p["line-color"] = lineColor(layer, palette, geometry);
            const roadKind = layer.metadata?.["everydashcam:road-kind"];
            if (geometry.outlinedRoads && (roadKind === "fill" || roadKind === "dashed")) {
                p["line-width"] = roadWidth(roadKind, 0.78);
            }
            if (
                theme === "neon" &&
                roadKind === "casing" &&
                layer.metadata?.["everydashcam:road-level"] === 0 &&
                layer.metadata?.["everydashcam:road-crossing"] === "surface"
            ) {
                p["line-color"] = "#ff9000";
                p["line-blur"] = 2;
                p["line-opacity"] = 0.5;
            }
        }
        if (layer.type === "fill") {
            const colors = {
                water: "water",
                park: "park",
                landcover: "forest",
                landuse: "landuse",
                building: "building",
                transport: "transportArea",
            };
            const color = colors[role];
            if (!color) throw new Error(`unclassified fill layer: ${layer.id}`);
            p["fill-color"] = palette[color];
            if (geometry.fillsGround && layer.id === "landcover_wood") {
                layer.filter = ["in", ["get", "class"], ["literal", ["wood", "grass", "farmland", "sand", "rock"]]];
                p["fill-color"] = [
                    "match",
                    ["get", "class"],
                    ["sand", "rock"],
                    palette.sand,
                    "wood",
                    palette.forest,
                    palette.park,
                ];
                p["fill-opacity"] = 1;
            }
            if (geometry.fillsGround && layer.id === "landuse_residential") {
                delete layer.maxzoom;
                layer.filter = [
                    "in",
                    ["get", "class"],
                    ["literal", ["residential", "commercial", "industrial", "retail"]],
                ];
            }
            if (p["fill-outline-color"] !== undefined) {
                p["fill-outline-color"] = role === "building" ? palette.buildingOutline : palette.parkOutline;
            }
        }
        if (layer.type === "symbol") {
            // Shield bitmaps carry light backgrounds in every palette.
            const hasShield = layer.id.includes("shield");
            const color =
                role === "water-label"
                    ? palette.waterLabel
                    : role === "poi-driver"
                      ? palette.driverPoi
                      : role === "poi"
                        ? palette.poi
                        : role === "address" || role === "context-label"
                          ? palette.labelMinor
                          : palette.label;
            if (layer.layout?.["text-field"] !== undefined) {
                p["text-color"] = hasShield ? "#273443" : color;
                p["text-halo-color"] = hasShield ? "#ffffff" : palette.halo;
            }
            // These atlas entries are SDF; bitmap shields retain their colors.
            if (usesSdfIcon(layer.layout?.["icon-image"])) {
                p["icon-color"] = palette.label;
                p["icon-halo-color"] = palette.halo;
                p["icon-halo-width"] = 1;
            }
        }
    }
    if (theme === "neon") {
        // The export overlay needs transparency and a quiet background; road
        // geometry, one-way arrows and road/place labels remain shared.
        const hiddenRoles = new Set(["landuse", "landcover", "park", "boundary", "poi", "address", "context-label"]);
        style.layers = style.layers.filter((layer) => !hiddenRoles.has(layer.metadata?.["everydashcam:role"]));
    }
    return style;
}

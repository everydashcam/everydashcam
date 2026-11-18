import { featureFilter, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import { MAP_THEMES } from "./map-view-pref.js";
import { applyMapStylePreset } from "./map-style-preset.js";
import {
    createFallbackMapStyle,
    OSM_SHORTBREAD_BUILDING_SOURCE_LAYER,
    OSM_SHORTBREAD_SOURCE_ID,
} from "./osm-fallback-style.js";
import type { MapStyleId } from "./theme.js";

const ALL_STYLES = [...MAP_THEMES, "neon"] as const;

describe("OSM fallback styles", () => {
    it.each<MapStyleId>(ALL_STYLES)("builds a valid %s Shortbread style", (theme) => {
        const style = createFallbackMapStyle("osm-vector", theme);
        expect(validateStyleMin(style)).toEqual([]);
        expect(style.glyphs).toBeUndefined();
        expect(style.sprite).toBeUndefined();
        expect(style.sources).toHaveProperty(OSM_SHORTBREAD_SOURCE_ID);
        expect(style.layers.some((layer) => "source-layer" in layer && layer["source-layer"] === "street_labels")).toBe(
            true,
        );
        expect(
            style.layers.some(
                (layer) => "source-layer" in layer && layer["source-layer"] === OSM_SHORTBREAD_BUILDING_SOURCE_LAYER,
            ),
        ).toBe(true);
        for (const layer of style.layers) {
            if (layer.type === "symbol") expect(layer.layout?.["text-size"], layer.id).toBeDefined();
        }
    });

    it.each(["san-andreas", "vice-city", "underground-2"] as const)("paints water above urban land in %s", (theme) => {
        const ids = createFallbackMapStyle("osm-vector", theme).layers.map((layer) => layer.id);
        expect(ids).toContain("osm-urban-land");
        expect(ids.indexOf("osm-water")).toBeGreaterThan(ids.indexOf("osm-urban-land"));
    });

    it("builds a valid standard raster style", () => {
        const style = createFallbackMapStyle("osm-raster", "dark");
        expect(validateStyleMin(style)).toEqual([]);
        expect(style.layers).toEqual([{ id: "osm-raster", type: "raster", source: "osm-raster" }]);
    });

    it.each<MapStyleId>(ALL_STYLES)("keeps Shortbread park context in the %s road preset", (theme) => {
        // Shortbread 1.0 puts parks and cemeteries in land, campuses and parking in sites.
        // https://shortbread-tiles.org/schema/1.0/#land-use-land-cover-buildings
        const matchingFills = (style: StyleSpecification, sourceLayer: string, kind: string) =>
            style.layers.filter(
                (layer) =>
                    layer.type === "fill" &&
                    layer["source-layer"] === sourceLayer &&
                    featureFilter(layer.filter, layer.id).filter({ zoom: 16 }, { type: 3, properties: { kind } }),
            );
        const classic = createFallbackMapStyle("osm-vector", theme);
        const road = applyMapStylePreset(classic, "road");
        const minimal = applyMapStylePreset(classic, "minimal");
        for (const kind of ["park", "garden", "cemetery"]) {
            const original = matchingFills(classic, "land", kind);
            const muted = matchingFills(road, "land", kind);
            expect(original, `${kind}: classic renders land polygons`).toHaveLength(1);
            expect(muted, `${kind}: road keeps park context`).toHaveLength(1);
            expect(muted[0]?.metadata).toEqual({ "everydashcam:role": "park" });
            expect(matchingFills(minimal, "land", kind), `${kind}: minimal removes park context`).toEqual([]);
        }
        expect(matchingFills(classic, "sites", "parking").map((layer) => layer.metadata)).toEqual([
            { "everydashcam:role": "landuse" },
        ]);
        expect(matchingFills(classic, "sites", "school").map((layer) => layer.metadata)).toEqual([
            { "everydashcam:role": "landuse" },
        ]);
    });

    it("keeps Shortbread roads compact and scales link roads down", () => {
        const style = createFallbackMapStyle("osm-vector", "light");
        const layer = style.layers.find((candidate) => candidate.id === "osm-motorways");

        expect(layer?.type).toBe("line");
        if (layer?.type !== "line") throw new Error("motorway layer missing");
        expect(layer.paint?.["line-width"]).toEqual([
            "interpolate",
            ["linear"],
            ["zoom"],
            5,
            ["*", 0.9, ["case", ["==", ["get", "link"], true], 0.72, 1]],
            14,
            ["*", 4.6, ["case", ["==", ["get", "link"], true], 0.72, 1]],
        ]);
    });

    it("separates tunnels, surface roads and bridges before painting road classes", () => {
        const style = createFallbackMapStyle("osm-vector", "light");
        const matches = (properties: Record<string, string | boolean>) =>
            style.layers.filter(
                (layer) =>
                    layer.type === "line" &&
                    layer["source-layer"] === "streets" &&
                    featureFilter(layer.filter, layer.id).filter({ zoom: 16 }, { type: 2, properties }),
            );
        const tunnel = matches({ kind: "motorway", tunnel: true });
        const surface = matches({ kind: "motorway" });
        const bridge = matches({ kind: "residential", bridge: true });
        expect(tunnel.map((layer) => layer.id)).toEqual(["osm-roads-casing-tunnel", "osm-motorways-tunnel"]);
        expect(surface.map((layer) => layer.id)).toEqual(["osm-roads-casing", "osm-motorways"]);
        expect(bridge.map((layer) => layer.id)).toEqual(["osm-roads-casing-bridge", "osm-roads-minor-bridge"]);
        expect(style.layers.indexOf(tunnel.at(-1)!)).toBeLessThan(style.layers.indexOf(surface[0]!));
        expect(style.layers.indexOf(surface.at(-1)!)).toBeLessThan(style.layers.indexOf(bridge[0]!));
    });

    it("reads named driver stops from Shortbread amenity fields", () => {
        const style = createFallbackMapStyle("osm-vector", "light");
        const layer = style.layers.find((candidate) => candidate.id === "osm-poi-driver");
        if (layer?.type !== "symbol") throw new Error("driver POIs missing");
        const matches = featureFilter(layer.filter, layer.id).filter;
        expect(matches({ zoom: 16 }, { type: 1, properties: { amenity: "fuel", name: "Station" } })).toBe(true);
        expect(matches({ zoom: 16 }, { type: 1, properties: { amenity: "parking", name: "Car park" } })).toBe(true);
        expect(matches({ zoom: 16 }, { type: 1, properties: { shop: "supermarket", name: "Shop" } })).toBe(false);
    });
});

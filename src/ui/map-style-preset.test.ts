import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createExpression, featureFilter, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import { applyMapStylePreset, isStreetNameLayer, radarBaseStyle, readableRadarThemeMap } from "./map-style-preset.js";
import { MAP_THEMES, type MapStylePreset } from "./map-view-pref.js";
import { createFallbackMapStyle } from "./osm-fallback-style.js";

const ALL_STYLES = MAP_THEMES;

function loadStyle(theme: string): StyleSpecification {
    return JSON.parse(
        readFileSync(join(__dirname, "../../public/styles", `${theme}.json`), "utf8"),
    ) as StyleSpecification;
}

function role(layer: LayerSpecification): string | undefined {
    return (layer.metadata as Record<string, string> | undefined)?.["everydashcam:role"];
}

function matchingRoads(
    style: StyleSpecification,
    properties: Record<string, string | number | boolean | null>,
    zoom = 16,
): string[] {
    return style.layers
        .filter(
            (layer) =>
                layer.type === "line" &&
                layer["source-layer"] === "transportation" &&
                (layer.minzoom ?? 0) <= zoom &&
                (layer.maxzoom ?? 24) > zoom &&
                featureFilter(layer.filter, layer.id).filter({ zoom }, { type: 2, properties }),
        )
        .map((layer) => layer.id);
}

describe("map style presets", () => {
    it.each(ALL_STYLES)("applies presets to a cached %s style with legacy metadata", (theme) => {
        const original = loadStyle(theme);
        const cached = structuredClone(original);
        for (const layer of cached.layers) {
            layer.metadata = { "dashcamigo:role": role(layer) };
        }
        const content = (style: StyleSpecification) => style.layers.map(({ metadata: _metadata, ...layer }) => layer);
        for (const preset of ["classic", "road", "minimal"] satisfies MapStylePreset[]) {
            expect(content(applyMapStylePreset(cached, preset)), preset).toEqual(
                content(applyMapStylePreset(original, preset)),
            );
        }
    });

    for (const theme of ALL_STYLES) {
        for (const provider of ["openfreemap", "osm-vector"] as const) {
            const original = provider === "openfreemap" ? loadStyle(theme) : createFallbackMapStyle(provider, theme);
            it(`${provider} ${theme} preserves transport and landmarks while reducing context`, () => {
                const untouched = structuredClone(original);
                const essential = (style: StyleSpecification) =>
                    style.layers.filter((layer) =>
                        ["transport", "transport-label", "place-label", "water", "building"].includes(
                            role(layer) ?? "",
                        ),
                    );
                for (const preset of ["classic", "road", "minimal"] satisfies MapStylePreset[]) {
                    const style = applyMapStylePreset(original, preset);
                    expect(validateStyleMin(style), preset).toEqual([]);
                    expect(essential(style), `${preset}: roads and nearby landmarks survive`).toEqual(
                        essential(original),
                    );
                    if (preset !== "classic") {
                        expect(style.layers.some((layer) => role(layer) === "poi" || role(layer) === "address")).toBe(
                            false,
                        );
                    }
                    if (preset === "minimal") {
                        expect(
                            style.layers.some((layer) =>
                                ["poi-driver", "landcover", "park", "landuse", "boundary"].includes(role(layer) ?? ""),
                            ),
                        ).toBe(false);
                    } else {
                        expect(style.layers.some((layer) => role(layer) === "poi-driver")).toBe(true);
                    }
                }
                expect(original).toEqual(untouched);
                expect(applyMapStylePreset(original, "classic")).toBe(original);
            });
        }
    }

    for (const theme of ["la-92", "miami-86", "tuner-04"] as const) {
        it.each(["openfreemap", "osm-vector"] as const)(
            `draws street names above every other layer on the large ${theme} %s map`,
            (provider) => {
                const base = provider === "openfreemap" ? loadStyle(theme) : createFallbackMapStyle(provider, theme);
                const original = structuredClone(base);
                const result = readableRadarThemeMap(base);
                expect(validateStyleMin(result)).toEqual([]);
                const firstStreet = result.layers.findIndex(isStreetNameLayer);
                expect(firstStreet).toBeGreaterThan(0);
                expect(result.layers.slice(firstStreet).every(isStreetNameLayer)).toBe(true);
                expect(base).toEqual(original);
            },
        );
    }

    it.each(["openfreemap", "osm-vector"] as const)(
        "keeps driving roads and drops paths on the %s Tuner 04 radar",
        (provider) => {
            const style =
                provider === "openfreemap" ? loadStyle("tuner-04") : createFallbackMapStyle(provider, "tuner-04");
            const radar = radarBaseStyle(style, "tuner-04");
            expect(validateStyleMin(radar)).toEqual([]);
            const roads = radar.layers.filter((layer) => layer.type === "line" && role(layer) === "transport");
            const matches = (kind: string) =>
                roads.some(
                    (layer) =>
                        "filter" in layer &&
                        featureFilter(layer.filter, layer.id).filter(
                            { zoom: 16 },
                            { type: 2, properties: { class: kind, kind } },
                        ),
                );
            expect(matches("service")).toBe(true);
            expect(matches("path")).toBe(false);
            expect(matches("rail")).toBe(false);
        },
    );

    it("makes road context quieter and minimal removes it without altering the cache", () => {
        const original = loadStyle("light");
        const road = applyMapStylePreset(original, "road");
        const minimal = applyMapStylePreset(original, "minimal");
        expect(road.layers.length).toBeLessThan(original.layers.length);
        expect(minimal.layers.length).toBeLessThan(road.layers.length);
        const park = road.layers.find((layer) => layer.id === "park");
        expect(park?.type).toBe("fill");
        if (park?.type !== "fill") throw new Error("park fill missing");
        expect(park.paint?.["fill-opacity"]).toBe(0.22);
        expect(original.layers.find((layer) => layer.id === "park")).not.toEqual(park);
    });

    it("keeps the standard raster fallback available in every preset", () => {
        const raster = createFallbackMapStyle("osm-raster", "light");
        for (const preset of ["classic", "road", "minimal"] satisfies MapStylePreset[]) {
            expect(applyMapStylePreset(raster, preset)).toEqual(raster);
        }
    });
});

describe("shared OpenMapTiles cartography", () => {
    it("keeps light and dark content and placement identical", () => {
        const content = (style: StyleSpecification) => style.layers.map(({ paint: _paint, ...layer }) => layer);
        expect(content(loadStyle("dark"))).toEqual(content(loadStyle("light")));
    });

    it("only requests road shields for a present reference with a supported length", () => {
        const style = loadStyle("light");
        for (const [id, network] of [
            ["highway-shield-non-us", "de:national"],
            ["highway-shield-us-interstate", "us-interstate"],
            ["road_shield_us", "us-highway"],
        ]) {
            const layer = style.layers.find((candidate) => candidate.id === id);
            if (layer?.type !== "symbol") throw new Error("road shield missing");
            const matches = featureFilter(layer.filter, layer.id).filter;
            for (const properties of [
                { network },
                { network, ref_length: 1 },
                { network, ref: null, ref_length: 1 },
                { network, ref: "", ref_length: 0 },
                { network, ref: "1", ref_length: null },
                { network, ref: "1" },
            ]) {
                expect(matches({ zoom: 16 }, { type: 2, properties }), `${id}: absent ref`).toBe(false);
            }
            expect(matches({ zoom: 16 }, { type: 2, properties: { network, ref: "1", ref_length: 1 } }), id).toBe(true);
        }
    });

    it.each(ALL_STYLES)("resolves every supported road shield against the sprite atlas in %s", (theme) => {
        const style = loadStyle(theme);
        for (const scale of ["", "@2x"]) {
            const atlas: unknown = JSON.parse(
                readFileSync(join(__dirname, `../../public/styles/sprite/sprite${scale}.json`), "utf8"),
            );
            if (!atlas || typeof atlas !== "object") throw new Error("sprite atlas is invalid");
            const images = Object.keys(atlas);
            for (const [id, network] of [
                ["highway-shield-non-us", "de:national"],
                ["highway-shield-us-interstate", "us-interstate"],
                ["road_shield_us", "us-highway"],
                ["road_shield_us", "us-state"],
            ] as const) {
                const layer = style.layers.find((candidate) => candidate.id === id);
                if (layer?.type !== "symbol") throw new Error("road shield missing");
                const expression = createExpression(layer.layout?.["icon-image"], "road shield");
                if (expression.result !== "success") throw new Error("road shield expression is invalid");
                for (let length = 1; length <= 6; length++) {
                    const feature = {
                        type: 2 as const,
                        properties: { network, ref: "1".repeat(length), ref_length: length },
                    };
                    expect(featureFilter(layer.filter, layer.id).filter({ zoom: 16 }, feature)).toBe(true);
                    const image = String(expression.value.evaluate({ zoom: 16 }, feature, {}, undefined, images));
                    expect(images, `${scale} ${network} reference length ${length}: ${image}`).toContain(image);
                    if (length <= 3 && network !== "de:national") expect(image).toBe(`${network}_${length}`);
                }
            }
        }
    });

    it.each(ALL_STYLES)("renders bridges above surface roads and tunnels in %s", (theme) => {
        const style = loadStyle(theme);
        const tunnel = matchingRoads(style, { class: "motorway", brunnel: "tunnel", layer: -1, ramp: 0 });
        const surface = matchingRoads(style, { class: "motorway", layer: 0, ramp: 0 });
        const bridge = matchingRoads(style, { class: "minor", brunnel: "bridge", layer: 1, ramp: 0 });
        expect(tunnel).toEqual(["road-level--1-tunnel-casing", "road-level--1-tunnel-fill"]);
        expect(surface).toEqual(["road-level-0-surface-casing", "road-level-0-surface-fill"]);
        expect(bridge).toEqual(["road-level-1-bridge-casing", "road-level-1-bridge-fill"]);
        const index = (id: string) => style.layers.findIndex((layer) => layer.id === id);
        expect(Math.max(...tunnel.map(index))).toBeLessThan(Math.min(...surface.map(index)));
        expect(Math.max(...surface.map(index))).toBeLessThan(Math.min(...bridge.map(index)));
        expect(matchingRoads(style, { class: "minor", brunnel: "tunnel", ramp: 0 })).toEqual([
            "road-level--1-tunnel-casing",
            "road-level--1-tunnel-fill",
        ]);
        expect(matchingRoads(style, { class: "primary", brunnel: "bridge", ramp: 1 })).toEqual([
            "road-level-1-bridge-casing",
            "road-level-1-bridge-fill",
        ]);
    });

    it.each(ALL_STYLES)("finishes lower bridge fills before higher bridge casings in %s", (theme) => {
        const style = loadStyle(theme);
        const lower = matchingRoads(style, { class: "motorway", brunnel: "bridge", layer: 1 });
        const upper = matchingRoads(style, { class: "minor", brunnel: "bridge", layer: 2 });
        expect(lower).toHaveLength(2);
        expect(upper).toHaveLength(2);
        const paintOrder = [...lower, ...upper].map((id) => style.layers.findIndex((layer) => layer.id === id));
        expect(paintOrder).toEqual([...paintOrder].sort((a, b) => a - b));
        expect(upper[0]).toBe("road-level-2-bridge-casing");
        expect(lower[1]).toBe("road-level-1-bridge-fill");
    });

    it("routes missing, null, fractional and extreme levels into one render group", () => {
        const style = loadStyle("light");
        expect(matchingRoads(style, { class: "minor", brunnel: "bridge" })).toEqual([
            "road-level-1-bridge-casing",
            "road-level-1-bridge-fill",
        ]);
        expect(matchingRoads(style, { class: "motorway", brunnel: "tunnel" })).toEqual([
            "road-level--1-tunnel-casing",
            "road-level--1-tunnel-fill",
        ]);
        expect(matchingRoads(style, { class: "minor", brunnel: "bridge", layer: null })).toEqual([
            "road-level-1-bridge-casing",
            "road-level-1-bridge-fill",
        ]);
        for (const layer of [-9, -5.1, -3, 2.6, 3, 5.1, 9]) {
            const group = layer < 0 ? "below" : "above";
            expect(matchingRoads(style, { class: "minor", brunnel: "bridge", layer }), String(layer)).toEqual([
                `road-level-${group}-all-casing`,
                `road-level-${group}-all-fill`,
            ]);
        }
        expect(matchingRoads(style, { class: "primary", layer: 2.3 })).toEqual([
            "road-level-2-surface-casing",
            "road-level-2-surface-fill",
        ]);
    });

    it("keeps roads legible and ramps narrower at playback zooms", () => {
        const style = loadStyle("light");
        const layer = style.layers.find((candidate) => candidate.id === "road-level-0-surface-fill");
        if (layer?.type !== "line") throw new Error("surface road fill missing");
        const expression = createExpression(layer.paint?.["line-width"], "road width");
        if (expression.result !== "success") throw new Error("road width expression is invalid");
        const width = (zoom: number, roadClass: string, ramp = 0): number =>
            expression.value.evaluate({ zoom }, { type: 2, properties: { class: roadClass, ramp } }) as number;
        expect(width(12, "motorway")).toBeCloseTo(3.6, 4);
        expect(width(15, "minor")).toBeGreaterThan(3);
        expect(width(15, "minor")).toBeLessThan(width(15, "motorway"));
        expect(width(18, "motorway")).toBeGreaterThan(11);
        expect(width(18, "motorway")).toBeLessThan(13);
        expect(width(15, "motorway", 1)).toBeLessThan(width(15, "motorway"));
    });

    it("enables local roads, paths and rail only at their deliberate zoom thresholds", () => {
        const style = loadStyle("light");
        for (const [roadClass, zoom, expectedLayers] of [
            ["motorway", 5, 2],
            ["secondary", 7, 2],
            ["minor", 12, 2],
            ["rail", 13, 1],
            ["path", 14, 1],
            ["transit", 14, 1],
            ["service", 15, 2],
            ["track", 15, 2],
        ] as const) {
            expect(matchingRoads(style, { class: roadClass }, zoom - 1), roadClass).toHaveLength(0);
            expect(matchingRoads(style, { class: roadClass }, zoom), roadClass).toHaveLength(expectedLayers);
        }
    });

    it.each(ALL_STYLES)("keeps drivable roads off line-dasharray so they use the plain line shader in %s", (theme) => {
        const style = loadStyle(theme);
        const solidRoads = style.layers.filter((layer) => layer.type === "line" && layer.id.startsWith("road-level-"));
        expect(solidRoads.length).toBeGreaterThan(0);
        for (const layer of solidRoads) {
            expect(layer.type === "line" && layer.paint?.["line-dasharray"], layer.id).toBeUndefined();
        }
        expect(matchingRoads(style, { class: "path", brunnel: "tunnel", layer: -1 }, 15)).toEqual([
            "road-dashed-tunnel-fill",
        ]);
        expect(matchingRoads(style, { class: "rail", layer: 0 }, 15)).toEqual(["road-dashed-surface-fill"]);
        expect(matchingRoads(style, { class: "rail", brunnel: "bridge", layer: 1 }, 15)).toEqual([
            "road-level-1-bridge-casing",
            "road-dashed-bridge-fill",
        ]);
    });

    it.each(ALL_STYLES)("paints trails and rail between road casings and fills in %s", (theme) => {
        const style = loadStyle(theme);
        const index = (id: string) => style.layers.findIndex((layer) => layer.id === id);
        const dashed = (properties: Record<string, string | number>) =>
            matchingRoads(style, { class: "rail", ...properties }, 15).filter((id) => id.startsWith("road-dashed-"));
        // A footway crossing a street stays under the street fill but above its casing.
        expect(index("road-level-0-surface-casing")).toBeLessThan(index("road-dashed-surface-fill"));
        expect(index("road-dashed-surface-fill")).toBeLessThan(index("road-level-0-surface-fill"));
        expect(index("road-level--1-tunnel-casing")).toBeLessThan(index("road-dashed-tunnel-fill"));
        expect(index("road-dashed-tunnel-fill")).toBeLessThan(index("road-level--1-tunnel-fill"));
        // A rail bridge stays under a flyover one level above it.
        expect(index("road-dashed-bridge-fill")).toBeLessThan(index("road-level-2-bridge-casing"));
        // Every dashed bridge paints after its own casing.
        for (const layer of [-1, 0, 1, 2]) {
            const ids = matchingRoads(style, { class: "rail", brunnel: "bridge", layer }, 15);
            expect(ids, String(layer)).toHaveLength(2);
            expect(ids[0], String(layer)).toBe(`road-level-${layer}-bridge-casing`);
        }
        // Each dashed feature belongs to exactly one dashed group at any level.
        for (const layer of [-6, -3, -2, -1, 0, 1, 2, 3, 6]) {
            for (const brunnel of ["tunnel", "bridge", "none"]) {
                expect(dashed({ brunnel, layer }), `${brunnel} ${layer}`).toHaveLength(1);
            }
        }
    });

    it.each(ALL_STYLES)("keeps flat buildings at street zoom and below symbols in %s", (theme) => {
        const style = loadStyle(theme);
        const buildingIndex = style.layers.findIndex((layer) => layer.id === "building");
        const building = style.layers[buildingIndex]!;
        expect(building.type).toBe("fill");
        expect(building.maxzoom ?? 24).toBeGreaterThan(20);
        expect(buildingIndex).toBeLessThan(style.layers.findIndex((layer) => layer.type === "symbol"));
    });

    it("adds named driver stops and addresses without promoting all POIs", () => {
        const style = loadStyle("light");
        const driver = style.layers.find((layer) => layer.id === "poi-driver");
        if (driver?.type !== "symbol") throw new Error("driver POIs missing");
        const matches = featureFilter(driver.filter, driver.id).filter;
        expect(matches({ zoom: 16 }, { type: 1, properties: { class: "fuel", name: "Station" } })).toBe(true);
        expect(
            matches({ zoom: 16 }, { type: 1, properties: { class: "car", subclass: "parking", name: "Car park" } }),
        ).toBe(true);
        expect(matches({ zoom: 16 }, { type: 1, properties: { class: "shop", name: "Shop" } })).toBe(false);
        expect(style.layers.some((layer) => role(layer) === "address")).toBe(true);
    });
});

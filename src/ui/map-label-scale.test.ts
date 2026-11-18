// Pins the label-scale transform against the REAL shipped styles: every
// text-size form that exists in public/styles/*.json (plain number, legacy
// stops function, interpolate expression) must scale its size outputs while
// zoom breakpoints stay put - MapLibre rejects a zoom expression that is not
// top-level interpolate/step, so a wrong shape here kills the whole style.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { StyleSpecification } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    _resetForTests,
    applyStreetLabelDensity,
    applyViewerLabelPrefs,
    getMapLabelScale,
    getStreetLabelDensity,
    scaleStyleTextSizes,
    setMapLabelScale,
    setStreetLabelDensity,
} from "./map-label-scale.js";

const STYLE_NAMES = ["light", "dark", "neon", "san-andreas", "vice-city", "underground-2"] as const;

function loadStyle(name: string): StyleSpecification {
    const raw = readFileSync(join(__dirname, "..", "..", "public", "styles", `${name}.json`), "utf8");
    return JSON.parse(raw) as StyleSpecification;
}

describe("map label preferences", () => {
    beforeEach(() => _resetForTests());
    afterEach(() => {
        _resetForTests();
        vi.unstubAllGlobals();
    });

    it("applies the current choices when storage writes fail", () => {
        vi.stubGlobal("localStorage", {
            getItem: () => null,
            setItem: () => {
                throw new DOMException("storage full", "QuotaExceededError");
            },
        });
        setMapLabelScale(2);
        setStreetLabelDensity("max");

        expect(getMapLabelScale()).toBe(2);
        expect(getStreetLabelDensity()).toBe("max");
        const style = loadStyle("light");
        expect(applyViewerLabelPrefs(style)).toEqual(applyStreetLabelDensity(scaleStyleTextSizes(style, 2), "max"));
    });

    it("restores stored preferences before a session choice", () => {
        const stored = new Map([
            ["everydashcam:mapLabelScale", "1.5"],
            ["everydashcam:streetLabelDensity", "more"],
        ]);
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => stored.get(key) ?? null,
        });

        expect(getMapLabelScale()).toBe(1.5);
        expect(getStreetLabelDensity()).toBe("more");
    });
});

/** Flattens one text-size value into its size outputs (the numbers that must
 *  scale) and its zoom breakpoints (the numbers that must not). */
function splitSizesAndZooms(value: unknown): { sizes: number[]; zooms: number[] } {
    if (typeof value === "number") return { sizes: [value], zooms: [] };
    if (Array.isArray(value) && value[0] === "interpolate") {
        const tail = value.slice(3);
        return {
            sizes: tail.filter((_, i) => i % 2 === 1).filter((v): v is number => typeof v === "number"),
            zooms: tail.filter((_, i) => i % 2 === 0).filter((v): v is number => typeof v === "number"),
        };
    }
    const stops = (value as { stops?: [number, number][] }).stops;
    if (Array.isArray(stops)) {
        return { sizes: stops.map((p) => p[1]), zooms: stops.map((p) => p[0]) };
    }
    return { sizes: [], zooms: [] };
}

describe("scaleStyleTextSizes", () => {
    it("returns the same reference untouched for factor 1", () => {
        const style = loadStyle("light");
        expect(scaleStyleTextSizes(style, 1)).toBe(style);
    });

    for (const name of STYLE_NAMES) {
        it(`scales every text size in ${name}.json and leaves zoom breakpoints alone`, () => {
            const original = loadStyle(name);
            const scaled = scaleStyleTextSizes(original, 1.5);
            expect(scaled, "must be a clone, the cached style stays pristine").not.toBe(original);

            let textLayers = 0;
            for (let i = 0; i < original.layers.length; i++) {
                const before = original.layers[i]!;
                const after = scaled.layers[i]!;
                const beforeSize = (before.layout as Record<string, unknown> | undefined)?.["text-size"];
                const afterSize = (after.layout as Record<string, unknown> | undefined)?.["text-size"];
                if (beforeSize === undefined) {
                    expect(afterSize, `${before.id}: layer without text-size stays untouched`).toBeUndefined();
                    continue;
                }
                textLayers++;
                const b = splitSizesAndZooms(beforeSize);
                const a = splitSizesAndZooms(afterSize);
                expect(a.sizes.length, `${before.id}: every size output survives`).toBe(b.sizes.length);
                expect(b.sizes.length, `${before.id}: the splitter recognized the shape`).toBeGreaterThan(0);
                for (let s = 0; s < b.sizes.length; s++) {
                    expect(a.sizes[s]!, `${before.id}: size output ${s}`).toBeCloseTo(b.sizes[s]! * 1.5, 6);
                }
                expect(a.zooms, `${before.id}: zoom breakpoints must not move`).toEqual(b.zooms);
            }
            // Plausibility: the styles genuinely carry label layers - a transform
            // over zero layers would vacuously pass everything above.
            expect(textLayers, "style has text layers").toBeGreaterThan(10);
        });

        it(`every text layer in ${name}.json has an explicit text-size (default-16 never needs scaling)`, () => {
            const style = loadStyle(name);
            const relyingOnDefault = style.layers.filter(
                (l) =>
                    l.type === "symbol" &&
                    (l.layout as Record<string, unknown> | undefined)?.["text-field"] !== undefined &&
                    (l.layout as Record<string, unknown> | undefined)?.["text-size"] === undefined,
            );
            expect(relyingOnDefault.map((l) => l.id)).toEqual([]);
        });
    }

    it("scales step-expression outputs but not its input breakpoints", () => {
        const style = {
            version: 8,
            sources: {},
            layers: [
                {
                    id: "t",
                    type: "symbol",
                    layout: { "text-size": ["step", ["zoom"], 10, 14, 12] },
                },
            ],
        } as unknown as StyleSpecification;
        const scaled = scaleStyleTextSizes(style, 2);
        expect((scaled.layers[0]!.layout as Record<string, unknown>)["text-size"]).toEqual([
            "step",
            ["zoom"],
            20,
            14,
            24,
        ]);
    });

    for (const name of STYLE_NAMES) {
        it(`compensates line-label spacing in ${name}.json (bigger text fits rarer without it)`, () => {
            const original = loadStyle(name);
            const scaled = scaleStyleTextSizes(original, 2);
            let lineLabelLayers = 0;
            for (let i = 0; i < original.layers.length; i++) {
                const before = original.layers[i]!;
                const after = scaled.layers[i]!;
                const layoutBefore = (before.layout ?? {}) as Record<string, unknown>;
                const layoutAfter = (after.layout ?? {}) as Record<string, unknown>;
                if (before.type !== "symbol" || layoutBefore["text-size"] === undefined) continue;
                const placement = layoutBefore["symbol-placement"];
                const isLinePlaced = placement === "line" || placement === "line-center" || Array.isArray(placement);
                if (!isLinePlaced) {
                    expect(layoutAfter["symbol-spacing"], `${before.id}: point-label spacing untouched`).toEqual(
                        layoutBefore["symbol-spacing"],
                    );
                    continue;
                }
                lineLabelLayers++;
                // 250 = the style-spec default synthesized when absent; 60 = the
                // transform's floor (mirrored here, not imported - the floor is
                // part of the pinned contract).
                const base = typeof layoutBefore["symbol-spacing"] === "number" ? layoutBefore["symbol-spacing"] : 250;
                expect(layoutAfter["symbol-spacing"], `${before.id}: spacing divides by the factor`).toBe(
                    Math.max(60, Math.round(base / 2)),
                );
            }
            expect(lineLabelLayers, "style has line-placed text layers").toBeGreaterThan(0);
        });
    }

    it("leaves an unrecognized expression unchanged instead of corrupting it", () => {
        const weird = ["match", ["get", "class"], "motorway", 14, 10];
        const style = {
            version: 8,
            sources: {},
            layers: [{ id: "t", type: "symbol", layout: { "text-size": weird } }],
        } as unknown as StyleSpecification;
        const scaled = scaleStyleTextSizes(style, 2);
        expect((scaled.layers[0]!.layout as Record<string, unknown>)["text-size"]).toEqual(weird);
    });
});

describe("applyStreetLabelDensity", () => {
    it("returns the same reference untouched for standard", () => {
        const style = loadStyle("light");
        expect(applyStreetLabelDensity(style, "standard")).toBe(style);
    });

    for (const name of STYLE_NAMES) {
        it(`densifies only road-name layers in ${name}.json and leaves the rest alone`, () => {
            const original = loadStyle(name);
            const dense = applyStreetLabelDensity(original, "more");
            expect(dense, "must be a clone, the cached style stays pristine").not.toBe(original);

            let roadNameLayers = 0;
            for (let i = 0; i < original.layers.length; i++) {
                const before = original.layers[i]! as {
                    id: string;
                    type: string;
                    minzoom?: number;
                    "source-layer"?: string;
                    layout?: Record<string, unknown>;
                };
                const after = dense.layers[i]! as typeof before;
                if (before.type !== "symbol" || before["source-layer"] !== "transportation_name") {
                    expect(after, `${before.id}: non-road layer untouched`).toEqual(before);
                    continue;
                }
                roadNameLayers++;
                if (typeof before.minzoom === "number") {
                    expect(after.minzoom, `${before.id}: turns on one zoom earlier`).toBeCloseTo(before.minzoom - 1, 6);
                }
                const placement = before.layout?.["symbol-placement"];
                const isLinePlaced = placement === "line" || placement === "line-center" || Array.isArray(placement);
                if (isLinePlaced) {
                    // 250/60 mirror the transform's default and floor (see the
                    // spacing-compensation test above).
                    const base =
                        typeof before.layout?.["symbol-spacing"] === "number" ? before.layout["symbol-spacing"] : 250;
                    expect(after.layout?.["symbol-spacing"], `${before.id}: names repeat denser`).toBe(
                        Math.max(60, Math.round(base * 0.6)),
                    );
                }
            }
            // Plausibility: a transform over zero road-name layers would
            // vacuously pass everything above.
            expect(roadNameLayers, "style has road-name layers").toBeGreaterThan(0);
        });
    }
});

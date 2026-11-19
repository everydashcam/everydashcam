import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import { composeMapStyle, mapAppearanceKey, type MapAppearance, type MapStyleSurface } from "./map-appearance.js";
import { isStreetNameLayer } from "./map-style-preset.js";
import { mapThemeColors, type MapTheme } from "./theme.js";

const FULL_SURFACES = ["main", "trips", "preview"] as const satisfies readonly MapStyleSurface[];
const INSET_SURFACES = ["mini", "export"] as const satisfies readonly MapStyleSurface[];

function loadStyle(theme: MapTheme): StyleSpecification {
    return JSON.parse(
        readFileSync(join(__dirname, "../../public/styles", `${theme}.json`), "utf8"),
    ) as StyleSpecification;
}

function appearance(theme: MapTheme, overrides: Partial<MapAppearance> = {}): MapAppearance {
    return { theme, preset: "classic", labelScale: 1, labelDensity: "standard", ...overrides };
}

function role(layer: LayerSpecification): string | undefined {
    return (layer.metadata as Record<string, string> | undefined)?.["everydashcam:role"];
}

function backgroundColor(style: StyleSpecification): unknown {
    const background = style.layers.find((layer) => layer.type === "background");
    return background?.type === "background" ? background.paint?.["background-color"] : undefined;
}

describe("composeMapStyle", () => {
    it("draws the player inset and the exported inset from the same rules", () => {
        for (const theme of ["light", "neon", "la-92", "tuner-04"] as const) {
            const base = loadStyle(theme);
            const choice = appearance(theme, { preset: "minimal", labelScale: 1.5, labelDensity: "more" });
            expect(composeMapStyle(base, choice, "export"), theme).toEqual(composeMapStyle(base, choice, "mini"));
        }
    });

    it("applies the viewer's context preset to the exported map", () => {
        const base = loadStyle("light");
        const minimal = composeMapStyle(base, appearance("light", { preset: "minimal" }), "export");
        expect(validateStyleMin(minimal)).toEqual([]);
        expect(minimal.layers.some((layer) => ["poi", "park", "landuse"].includes(role(layer) ?? ""))).toBe(false);
        const classic = composeMapStyle(base, appearance("light"), "export");
        expect(classic.layers.some((layer) => role(layer) === "poi")).toBe(true);
    });

    it("scales labels on every surface without touching the cached base", () => {
        const base = loadStyle("dark");
        const untouched = structuredClone(base);
        const sizeOf = (style: StyleSpecification) =>
            style.layers.find((layer) => layer.id === "highway-name-major")?.layout;
        for (const surface of [...FULL_SURFACES, ...INSET_SURFACES]) {
            const scaled = composeMapStyle(base, appearance("dark", { labelScale: 2 }), surface);
            expect(sizeOf(scaled), surface).not.toEqual(sizeOf(base));
        }
        expect(base).toEqual(untouched);
    });

    it("returns the cached base itself for default settings on a full-size map", () => {
        const base = loadStyle("light");
        for (const surface of FULL_SURFACES) expect(composeMapStyle(base, appearance("light"), surface)).toBe(base);
    });

    it("gives neon an opaque ground only where no video shows through", () => {
        const base = loadStyle("neon");
        const translucent = backgroundColor(base);
        for (const surface of FULL_SURFACES) {
            const style = composeMapStyle(base, appearance("neon"), surface);
            expect(validateStyleMin(style), surface).toEqual([]);
            expect(backgroundColor(style), surface).toBe(mapThemeColors("neon").background);
        }
        for (const surface of INSET_SURFACES) {
            expect(backgroundColor(composeMapStyle(base, appearance("neon"), surface)), surface).toBe(translucent);
        }
        expect(backgroundColor(base)).toBe(translucent);
    });

    it("reduces a radar palette to the radar basemap on insets only", () => {
        const base = loadStyle("miami-86");
        for (const surface of INSET_SURFACES) {
            const style = composeMapStyle(base, appearance("miami-86"), surface);
            expect(
                style.layers.some((layer) => layer.type === "symbol"),
                surface,
            ).toBe(false);
        }
        const main = composeMapStyle(base, appearance("miami-86"), "main");
        const firstStreet = main.layers.findIndex(isStreetNameLayer);
        expect(firstStreet).toBeGreaterThan(0);
        expect(main.layers.slice(firstStreet).every(isStreetNameLayer)).toBe(true);
        expect(composeMapStyle(base, appearance("miami-86"), "trips").layers.some(isStreetNameLayer)).toBe(true);
    });

    it("keys appearances by every setting that changes the composed style", () => {
        const keys = new Set(
            [
                appearance("light"),
                appearance("dark"),
                appearance("light", { preset: "road" }),
                appearance("light", { labelScale: 1.25 }),
                appearance("light", { labelDensity: "max" }),
            ].map(mapAppearanceKey),
        );
        expect(keys.size).toBe(5);
    });
});

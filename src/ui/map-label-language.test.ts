import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createExpression, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { ExpressionSpecification, StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import type { Lang } from "../i18n/index.js";
import { localizeMapLabels, mapLabelNameExpression, type MapNameSchema } from "./map-label-language.js";
import { createFallbackMapStyle, OSM_SHORTBREAD_SOURCE_ID } from "./osm-fallback-style.js";

type Properties = Record<string, string>;

function evaluate(expression: unknown, properties: Properties): unknown {
    const compiled = createExpression(expression, "label name");
    if (compiled.result !== "success") throw new Error(JSON.stringify(compiled.value));
    return compiled.value.evaluate({ zoom: 15 }, { type: 1, properties });
}

function label(lang: Lang, schema: MapNameSchema, properties: Properties): unknown {
    return evaluate(mapLabelNameExpression(lang, schema), properties);
}

function loadStyle(theme: string): StyleSpecification {
    return JSON.parse(
        readFileSync(join(__dirname, "../../public/styles", `${theme}.json`), "utf8"),
    ) as StyleSpecification;
}

const MOSCOW = { name: "Тверская улица", "name:latin": "Tverskaya ulitsa" };
const KYIV = { name: "вулиця Хрещатик", "name:latin": "vulytsia Khreshchatyk" };
const TOKYO = { name: "明治通り", "name:latin": "Meiji-dori" };
const BERLIN = { name: "Unter den Linden", "name:latin": "Unter den Linden" };
const PARIS = { name: "Rue de Rivoli", "name:latin": "Rue de Rivoli", "name:en": "Rivoli Street" };
const SEOUL = { name: "세종대로", "name:latin": "Sejong-daero" };

describe("map label language on OpenMapTiles", () => {
    it.each([
        ["ru", MOSCOW, "Тверская улица"],
        ["ru", { ...MOSCOW, "name:ru": "Тверская ул." }, "Тверская ул."],
        ["ru", KYIV, "вулиця Хрещатик"],
        ["ru", TOKYO, "Meiji-dori"],
        ["ru", BERLIN, "Unter den Linden"],
        ["ru", { name: "25-летия Октября", "name:latin": "25-letiya Oktyabrya" }, "25-летия Октября"],
        ["en", MOSCOW, "Tverskaya ulitsa"],
        ["en", PARIS, "Rivoli Street"],
        ["de", PARIS, "Rue de Rivoli"],
        ["ja", TOKYO, "明治通り"],
        ["ja", MOSCOW, "Tverskaya ulitsa"],
        ["ko", SEOUL, "세종대로"],
        ["zh", TOKYO, "明治通り"],
        ["zh", SEOUL, "Sejong-daero"],
    ] as const)("labels in %s: %j -> %s", (lang, properties, expected) => {
        expect(label(lang, "openmaptiles", properties)).toBe(expected);
    });

    it("falls back to the local name without a Latin form", () => {
        expect(label("en", "openmaptiles", { name: "Тверская улица" })).toBe("Тверская улица");
        expect(label("en", "openmaptiles", {})).toBe("");
    });
});

describe("map label language on Shortbread", () => {
    it.each([
        ["ru", { name: "Тверская улица", name_en: "Tverskaya Street" }, "Тверская улица"],
        ["ru", { name: "明治通り", name_en: "Meiji Street" }, "Meiji Street"],
        ["en", { name: "Тверская улица", name_en: "Tverskaya Street" }, "Tverskaya Street"],
        ["de", { name: "Rue de Rivoli", name_en: "Rivoli Street", name_de: "Rivolistraße" }, "Rivolistraße"],
        ["fr", { name: "Unter den Linden", name_en: "Under the Lindens" }, "Unter den Linden"],
        ["fr", { name: "Тверская улица", name_en: "Tverskaya Street" }, "Tverskaya Street"],
    ] as const)("labels in %s: %j -> %s", (lang, properties, expected) => {
        expect(label(lang, "shortbread", properties)).toBe(expected);
    });
});

describe("localizeMapLabels", () => {
    it("rewrites every name label of the OpenFreeMap style and leaves numbers and refs alone", () => {
        const style = loadStyle("light");
        const original = structuredClone(style);
        const result = localizeMapLabels(style, "ru");
        expect(validateStyleMin(result)).toEqual([]);
        const expected = mapLabelNameExpression("ru", "openmaptiles");
        const fields = new Map(
            result.layers.flatMap((layer) =>
                layer.type === "symbol" && layer.layout?.["text-field"] !== undefined
                    ? [[layer.id, layer.layout["text-field"]] as const]
                    : [],
            ),
        );
        for (const id of ["label_city", "highway-name-minor", "water_name_line_label", "poi-driver", "airport"]) {
            expect(fields.get(id), id).toEqual(expected);
        }
        expect(fields.get("housenumber")).toEqual(["to-string", ["get", "housenumber"]]);
        expect(fields.get("highway-shield-non-us")).toEqual(["to-string", ["get", "ref"]]);
        expect(style).toEqual(original);
    });

    it("reads Shortbread fields on the OSM fallback and keeps one-way arrows", () => {
        const style = createFallbackMapStyle("osm-vector", "light");
        if (!style) throw new Error("osm-vector fallback style missing");
        const result = localizeMapLabels(style, "en");
        expect(validateStyleMin(result)).toEqual([]);
        const expected: ExpressionSpecification = mapLabelNameExpression("en", "shortbread");
        const named = result.layers.filter(
            (layer) =>
                layer.type === "symbol" &&
                layer.source === OSM_SHORTBREAD_SOURCE_ID &&
                JSON.stringify(layer.layout?.["text-field"]) === JSON.stringify(expected),
        );
        expect(named.length).toBeGreaterThan(3);
        const unchanged = result.layers.filter(
            (layer) =>
                layer.type === "symbol" && JSON.stringify(layer.layout?.["text-field"]).includes("oneway_reverse"),
        );
        expect(unchanged).toHaveLength(1);
    });
});

// One rule for every map label that shows a feature name, in every palette and
// on every surface that loads a style through loadMapStyle: the name in the
// interface language; otherwise the local name when it is written in the
// interface's script (OSM often tags Moscow streets with a Russian name but no
// name:ru); otherwise a Latin form; otherwise the local name.

import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";

import type { Lang } from "../i18n/index.js";
import { OSM_SHORTBREAD_SOURCE_ID } from "./osm-fallback-style.js";

/** OpenFreeMap serves OpenMapTiles fields; the OSM fallback serves Shortbread. */
export type MapNameSchema = "openmaptiles" | "shortbread";

type CharRange = readonly [first: string, last: string];

const LATIN: readonly CharRange[] = [
    ["A", "Z"],
    ["a", "z"],
    ["À", "ɏ"],
    ["Ḁ", "ỿ"],
];
const HAN: readonly CharRange[] = [
    ["㐀", "䶿"],
    ["一", "鿿"],
];

const SCRIPT_RANGES: Record<Lang, readonly CharRange[]> = {
    en: LATIN,
    de: LATIN,
    es: LATIN,
    fr: LATIN,
    pl: LATIN,
    pt: LATIN,
    ru: [["Ѐ", "ԯ"]],
    // Kana, then Han: Japanese readers can read Chinese place names too.
    ja: [["぀", "ヿ"], ...HAN],
    ko: [
        ["ᄀ", "ᇿ"],
        ["㄰", "㆏"],
        ["가", "힯"],
    ],
    zh: HAN,
};

// Names often start with digits or punctuation ("25-летия Октября"), so the
// script check looks at the first few characters instead of only the first.
const SCRIPT_PROBE_LENGTH = 4;

// Shortbread carries translated names for English and German only.
const SHORTBREAD_TRANSLATIONS: ReadonlySet<Lang> = new Set(["en", "de"]);

function writtenInScript(lang: Lang): ExpressionSpecification {
    const name: ExpressionSpecification = ["to-string", ["get", "name"]];
    const probes: ExpressionSpecification[] = [];
    for (let index = 0; index < SCRIPT_PROBE_LENGTH; index++) {
        const char: ExpressionSpecification = ["slice", name, index, index + 1];
        for (const [first, last] of SCRIPT_RANGES[lang]) {
            probes.push(["all", [">=", char, first], ["<=", char, last]]);
        }
    }
    return ["any", ...probes];
}

/** The label text of a named feature for the given interface language and tile schema. */
export function mapLabelNameExpression(lang: Lang, schema: MapNameSchema): ExpressionSpecification {
    const translated =
        schema === "openmaptiles" ? `name:${lang}` : SHORTBREAD_TRANSLATIONS.has(lang) ? `name_${lang}` : undefined;
    const latin = schema === "openmaptiles" ? "name:latin" : "name_en";
    const untranslated: ExpressionSpecification = [
        "case",
        writtenInScript(lang),
        ["get", "name"],
        ["has", latin],
        ["get", latin],
        ["coalesce", ["get", "name"], ""],
    ];
    return translated ? ["case", ["has", translated], ["get", translated], untranslated] : untranslated;
}

function readsFeatureName(layer: LayerSpecification): boolean {
    const field = layer.type === "symbol" ? layer.layout?.["text-field"] : undefined;
    // House numbers, road refs and one-way arrows never read a name property.
    return field !== undefined && JSON.stringify(field).includes('["get","name');
}

/**
 * Returns a copy of the style whose name labels follow the interface language.
 * Layers on the Shortbread source read Shortbread fields, all others
 * OpenMapTiles fields. The input style is not modified.
 */
export function localizeMapLabels(style: StyleSpecification, lang: Lang): StyleSpecification {
    const expressions = {
        openmaptiles: mapLabelNameExpression(lang, "openmaptiles"),
        shortbread: mapLabelNameExpression(lang, "shortbread"),
    };
    return {
        ...style,
        layers: style.layers.map((layer) => {
            if (layer.type !== "symbol" || !readsFeatureName(layer)) return layer;
            const schema = layer.source === OSM_SHORTBREAD_SOURCE_ID ? "shortbread" : "openmaptiles";
            return { ...layer, layout: { ...layer.layout, "text-field": expressions[schema] } };
        }),
    };
}

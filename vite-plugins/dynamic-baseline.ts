// Replaces magic placeholders in index.html with content derived from
// SEO_LOCALES (and env vars) at transform time. Keeps multiple lists /
// secrets in lock-step instead of independent hardcoded copies:
//
//  1. Inline bootstrap script lang-detect array - was `["de","en","es",...]`,
//     becomes `__DC_LANGS__` placeholder filled at build/serve.
//  2. hreflang cluster (12 alternates + x-default) - was 13 hardcoded <link>
//     tags, becomes a single `<!--__DC_HREFLANG__-->` comment marker that
//     expands into the full block.
//  3. og:locale:alternate cluster (11 tags) - was 11 hardcoded <meta> tags,
//     becomes `<!--__DC_OG_LOCALE_ALTERNATES__-->` marker.
//
// Source of truth: src/i18n/seo-config.ts SEO_LOCALES.
//
// Why a separate plugin (not folded into seo-prerender):
//  - seo-prerender runs apply: "build" closeBundle - too late, html-minifier
//    has already removed the comment markers.
//  - This plugin's transformIndexHtml hook runs with order: "pre" so the
//    output goes through minifier next. Markers expand to real HTML BEFORE
//    minification, so the minified result has the full block.
//  - The CSP-hash plugin (cspHashPlugin) sees the final bootstrap content
//    and computes its hash correctly. Order: cspHashPlugin is last in
//    vite.config.ts.
//
// Hook applies to both dev (`apply: serve`) and build - in dev the locale
// homepages aren't navigable yet (separate dev-middleware would be needed),
// but the bootstrap script and base hreflang still need to be correct so a
// JS-disabled crawler / view-source check on the dev URL sees a valid graph.

import type { Plugin } from "vite";
import {
    SEO_LOCALES,
    getDefaultSeoLocale,
    getIndexableSeoLocales,
} from "../src/i18n/seo-config.js";
import { renderSeoAlternates } from "./seo-alternates.js";

// Build the full hreflang link block - one <link> per hreflang code of each
// indexable locale (generic aliases like "pt" emit an extra link to the
// same URL) plus x-default → default locale's home (/en/). Uniform
// "English variant" policy across the whole graph; the root stub does not
// appear in hreflang at all (it's a redirect-only page).
function buildHreflangHtml(): string {
    return renderSeoAlternates();
}

// Build the og:locale:alternate cluster for the default-locale baseline.
// Lists every locale EXCEPT the default - the per-locale prerender plugin
// rebuilds this for each locale's HTML.
function buildOgLocaleAlternatesHtml(): string {
    const indexable = getIndexableSeoLocales();
    const defaultLang = getDefaultSeoLocale().lang;
    const lines = indexable
        .filter((loc) => loc.lang !== defaultLang)
        .map((loc) => `    <meta property="og:locale:alternate" content="${loc.ogLocale}">`);
    return lines.join("\n");
}

// JSON array literal of language codes, formatted for inlining into the
// bootstrap script. ["de","en",...] - no whitespace, smallest minified form.
function buildLangsLiteral(): string {
    return JSON.stringify(SEO_LOCALES.map((l) => l.lang));
}

export function dynamicBaselinePlugin(): Plugin {
    return {
        name: "everydashcam-dynamic-baseline",
        // Run on both dev and build so the served index.html in dev is also
        // consistent with SEO_LOCALES (otherwise a developer testing a 13th
        // locale would see stale 12-locale baseline in the browser).
        transformIndexHtml: {
            order: "pre",
            handler(html: string) {
                let out = html;

                // 1. Bootstrap script language list. We replace the placeholder
                // token, not the array literal, so the source file does not
                // need to track the list of locales twice. replaceAll covers
                // duplicates (otherwise a stray copy would survive minification
                // and ship as broken JS `var K=__DC_LANGS__`).
                if (!out.includes("__DC_LANGS__")) {
                    throw new Error(
                        "dynamic-baseline: __DC_LANGS__ placeholder not found in index.html bootstrap - " +
                            "the inline-script must reference __DC_LANGS__ where it builds its supported-langs array",
                    );
                }
                out = out.replaceAll("__DC_LANGS__", buildLangsLiteral());

                // 2. hreflang cluster. Comment marker expands to the full
                // block. Marker must exist in source - throw loudly if missing
                // (silent skip would ship a page with zero hreflang). Using
                // replaceAll so accidental duplicates of the marker do not
                // survive into the minifier (which would strip them as
                // comments, leaving the second hreflang cluster missing).
                if (!out.includes("<!--__DC_HREFLANG__-->")) {
                    throw new Error(
                        "dynamic-baseline: <!--__DC_HREFLANG__--> marker not found in index.html - " +
                            "the marker is required so the hreflang cluster stays in sync with SEO_LOCALES",
                    );
                }
                out = out.replaceAll("<!--__DC_HREFLANG__-->", buildHreflangHtml());

                // 3. og:locale:alternate cluster.
                if (!out.includes("<!--__DC_OG_LOCALE_ALTERNATES__-->")) {
                    throw new Error(
                        "dynamic-baseline: <!--__DC_OG_LOCALE_ALTERNATES__--> marker not found in index.html - " +
                            "the marker is required so the og:locale:alternate cluster stays in sync with SEO_LOCALES",
                    );
                }
                out = out.replaceAll("<!--__DC_OG_LOCALE_ALTERNATES__-->", buildOgLocaleAlternatesHtml());

                // Defence in depth: nothing in our placeholder vocabulary
                // should survive to the minifier. If any __DC_ token leaks
                // through (e.g. a new placeholder was added to index.html
                // without a matching handler here), fail the build now -
                // otherwise the bug surfaces as `var K=__DC_LANGS__` syntax
                // error at runtime, which is much harder to diagnose.
                if (out.includes("__DC_")) {
                    const sample = out.match(/__DC_[A-Z_]+/);
                    throw new Error(
                        `dynamic-baseline: leftover __DC_ placeholder after expansion (${sample?.[0] ?? "unknown"}) - ` +
                            "the placeholder vocabulary is out of sync between index.html and dynamic-baseline.ts",
                    );
                }

                return out;
            },
        },
    };
}

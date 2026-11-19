// Tests for the competitor "alternative-to" pages build surface: sitemap
// entries (complete hreflang graph, trailing slashes), the dev/route matcher,
// and locale parity. Mirrors the vendor-pages assertions in
// seo-prerender-build.test.ts.

import { describe, expect, it } from "vitest";

import { assertAltLocaleParity, getAlternativeSitemapEntries, getAlternativeSlugs, matchAlternativeRoute } from "../../vite-plugins/alternative-pages.js";
import { getHreflangCodes, getIndexableSeoLocales } from "./seo-config.js";

describe("alternative sitemap entries", () => {
    const entries = getAlternativeSitemapEntries();
    const indexable = getIndexableSeoLocales();
    const slugCount = getAlternativeSlugs().length;

    it("omits lastmod when per-URL source history is unavailable", () => {
        expect(entries.every((entry) => entry.lastmod === undefined)).toBe(true);
    });

    it("includes an /alternatives/ index entry for every indexable locale", () => {
        const indexEntries = entries.filter((e) => /\/alternatives\/$/.test(e.loc));
        expect(indexEntries.length).toBe(indexable.length);
    });

    it("includes every competitor page × every indexable locale", () => {
        const compEntries = entries.filter((e) => /\/alternatives\/[^/]+\/$/.test(e.loc));
        expect(compEntries.length).toBe(slugCount * indexable.length);
    });

    it("every entry URL ends with '/' (Cloudflare Pages trailing-slash invariant)", () => {
        for (const entry of entries) {
            expect(entry.loc, `entry ${entry.loc} must end with slash`).toMatch(/\/$/);
            for (const alt of Object.values(entry.alternates)) {
                expect(alt, `alternate ${alt} must end with slash`).toMatch(/\/$/);
            }
            expect(entry.xDefaultUrl, `x-default ${entry.xDefaultUrl}`).toMatch(/\/$/);
        }
    });

    it("every entry has alternates for every hreflang code incl. generic aliases (complete bidirectional graph)", () => {
        const expectedHreflangs = new Set(indexable.flatMap((l) => getHreflangCodes(l)));
        for (const entry of entries) {
            expect(new Set(Object.keys(entry.alternates)), `alternates for ${entry.loc}`).toEqual(expectedHreflangs);
        }
    });

    it("generic pt alias targets the same URL as pt-BR in every entry", () => {
        for (const entry of entries) {
            expect(entry.alternates.pt, `pt alias for ${entry.loc}`).toBeDefined();
            expect(entry.alternates.pt).toBe(entry.alternates["pt-BR"]);
        }
    });

    it("alternates for a competitor page target the SAME competitor across locales", () => {
        const enTelemetry = entries.find((e) => e.loc === "https://everydashcam.app/en/alternatives/telemetry-overlay/");
        expect(enTelemetry).toBeDefined();
        expect(enTelemetry?.alternates.de).toMatch(/\/de\/alternatives\/telemetry-overlay\/$/);
        expect(enTelemetry?.alternates.ja).toBe("https://everydashcam.app/ja/alternatives/telemetry-overlay/");
        expect(enTelemetry?.xDefaultUrl).toBe("https://everydashcam.app/en/alternatives/telemetry-overlay/");
    });
});

describe("matchAlternativeRoute", () => {
    it("matches the locale-prefixed hub", () => {
        expect(matchAlternativeRoute("/en/alternatives/")).toEqual({ kind: "index", lang: "en" });
        expect(matchAlternativeRoute("/de/alternatives/")).toEqual({ kind: "index", lang: "de" });
    });

    it("matches a locale-less hub as English", () => {
        expect(matchAlternativeRoute("/alternatives/")).toEqual({ kind: "index", lang: "en" });
    });

    it("matches a competitor page and resolves the competitor", () => {
        const m = matchAlternativeRoute("/ru/alternatives/camgeoplayer/");
        expect(m?.kind).toBe("competitor");
        expect(m && m.kind === "competitor" && m.lang).toBe("ru");
        expect(m && m.kind === "competitor" && m.competitor.slug).toBe("camgeoplayer");
    });

    it("returns null for an unknown competitor slug", () => {
        expect(matchAlternativeRoute("/en/alternatives/does-not-exist/")).toBeNull();
    });

    it("does not route the pruned competitor pages", () => {
        for (const slug of ["registratorviewer", "vlc", "navitel-dvr-player", "dashware", "racerender"]) {
            expect(matchAlternativeRoute(`/en/alternatives/${slug}/`), slug).toBeNull();
        }
    });

    it("returns null for paths outside the /alternatives/ space and for too-deep paths", () => {
        expect(matchAlternativeRoute("/en/cameras/70mai/")).toBeNull();
        expect(matchAlternativeRoute("/en/alternatives/dashcam-viewer/extra/")).toBeNull();
        expect(matchAlternativeRoute("/")).toBeNull();
    });
});

describe("alternative-pages locale parity", () => {
    it("has labels, index and every competitor's content for every indexable locale", () => {
        // Same guard the build runs in closeBundle: every indexable locale must
        // have chrome labels, hub copy, and per-competitor content (hand-written
        // en/ru or machine-translated community), with comparison rows whose
        // count and marks match English. Throws with the offending list otherwise.
        expect(() => assertAltLocaleParity()).not.toThrow();
    });
});

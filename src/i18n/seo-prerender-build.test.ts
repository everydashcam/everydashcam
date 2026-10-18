// Tests for the SEO build pipeline. Run rendering in-memory (no file IO)
// by directly invoking the helpers exported from seo-prerender.ts on a
// representative source HTML fragment.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dynamicBaselinePlugin } from "../../vite-plugins/dynamic-baseline.js";
import { getAlternativeSitemapEntries, matchAlternativeRoute, renderAlternativePage, renderAlternativesIndexPage } from "../../vite-plugins/alternative-pages.js";
import { getFeatureSitemapEntries, matchFeatureRoute, renderFeaturePage } from "../../vite-plugins/feature-pages.js";
import { stringifyJsonLd } from "../../vite-plugins/html-utils.js";
import { addNoIndexHeader, applyLocale, getPrerenderLocales, getSeoLocales } from "../../vite-plugins/seo-prerender.js";
import { SUPPORTED_BRANDS, getAllBrandsCommaSeparated, getLandingBrands } from "../../vite-plugins/supported-brands.js";
import { getVendorSitemapEntries, matchVendorRoute, renderCamerasIndexPage, renderVendorPage } from "../../vite-plugins/vendor-pages.js";
import { SEO_LOCALES, getHreflangCodes, getIndexableSeoLocales } from "./seo-config.js";

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("addNoIndexHeader", () => {
    it("keeps security headers and noindex together in the single global Pages rule", () => {
        const source = readFileSync(new URL("../../public/_headers", import.meta.url), "utf8");
        const output = addNoIndexHeader(source);
        expect([...output.matchAll(/^\/\*$/gm)]).toHaveLength(1);
        const global = output.split(/^\/\*$/m)[1]!.split(/^\/\S/m)[0]!;
        expect(global).toContain("  X-Robots-Tag: noindex\n");
        for (const header of ["Content-Security-Policy", "Strict-Transport-Security", "X-Frame-Options", "Cross-Origin-Opener-Policy"]) {
            const original = source.split("\n").find((line) => line.startsWith(`  ${header}:`));
            expect(original, `${header} exists in the source policy`).toBeDefined();
            expect(global).toContain(original!);
        }
        expect(output.split(/^\/\*$/m)[0]).toBe(source.split(/^\/\*$/m)[0]);
    });

    it("rejects missing or duplicate global rules instead of shadowing the policy", () => {
        expect(() => addNoIndexHeader("/assets/*\n  Cache-Control: immutable\n")).toThrow("exactly one global headers rule");
        expect(() => addNoIndexHeader("/*\n  X-Frame-Options: DENY\n/*\n  X-Robots-Tag: noindex\n")).toThrow("exactly one global headers rule");
    });
});

describe("getPrerenderLocales", () => {
    it("returns one entry per indexable locale", () => {
        const locales = getPrerenderLocales();
        expect(locales.length).toBe(getIndexableSeoLocales().length);
    });

    it("backwards-compat alias getSeoLocales matches", () => {
        expect(getSeoLocales().length).toBe(getPrerenderLocales().length);
    });

    it("every entry has an og title and description (either from override or derived)", () => {
        for (const loc of getPrerenderLocales()) {
            expect(loc.ogTitle.length).toBeGreaterThan(0);
            expect(loc.ogDescription.length).toBeGreaterThan(0);
            expect(loc.twitterDescription.length).toBeGreaterThan(0);
        }
    });

    it("derived og title strips the site-name tail when present", () => {
        // For locales without hand-written overrides, og title should be
        // page.title minus the " | everydashcam" SERP tail. Check at least one
        // locale where derivation kicks in (de has no OG_OVERRIDES entry).
        const de = getPrerenderLocales().find((l) => l.seo.lang === "de");
        expect(de).toBeDefined();
        expect(de?.ogTitle.includes(" | everydashcam"), "OG title must not carry the SERP site-name tail").toBe(false);
    });
});

describe("vendor sitemap entries", () => {
    const entries = getVendorSitemapEntries();
    const indexable = getIndexableSeoLocales();

    it("omits lastmod when per-URL source history is unavailable", () => {
        expect(entries.every((entry) => entry.lastmod === undefined)).toBe(true);
    });

    it("includes /cameras/ index entry for every indexable locale", () => {
        // 10 indexable locales × 1 /cameras/ index = 10 entries.
        const indexEntries = entries.filter((e) => /\/cameras\/$/.test(e.loc));
        expect(indexEntries.length).toBe(indexable.length);
    });

    it("includes exactly the configured locale set for every vendor", () => {
        const vendorEntries = entries.filter((e) => /\/cameras\/[^/]+\/$/.test(e.loc));
        const expectedCount = getLandingBrands().reduce((count, brand) => count + brand.locales.length, 0);
        expect(vendorEntries.length).toBe(expectedCount);
    });

    it("every entry URL ends with '/' (Cloudflare Pages trailing-slash invariant)", () => {
        for (const entry of entries) {
            expect(entry.loc, `entry ${entry.loc} must end with slash`).toMatch(/\/$/);
            for (const alt of Object.values(entry.alternates)) {
                expect(alt, `alternate ${alt} must end with slash`).toMatch(/\/$/);
            }
        }
    });

    it("camera hubs have the complete hreflang graph", () => {
        const expectedHreflangs = new Set(indexable.flatMap((l) => getHreflangCodes(l)));
        for (const entry of entries.filter((candidate) => /\/cameras\/$/.test(candidate.loc))) {
            const got = new Set(Object.keys(entry.alternates));
            expect(got, `alternates for ${entry.loc}`).toEqual(expectedHreflangs);
        }
    });

    it("vendor hreflang graphs contain only that brand's published locales", () => {
        for (const brand of getLandingBrands()) {
            const expectedHreflangs = new Set(indexable.filter((locale) => brand.locales.includes(locale.lang)).flatMap((locale) => getHreflangCodes(locale)));
            const vendorEntries = entries.filter((entry) => entry.loc.endsWith(`/cameras/${brand.slug}/`));
            expect(vendorEntries.length).toBe(brand.locales.length);
            for (const entry of vendorEntries) {
                expect(new Set(Object.keys(entry.alternates)), `alternates for ${entry.loc}`).toEqual(expectedHreflangs);
            }
        }
    });

    it("generic pt alias targets the same URL as pt-BR whenever Portuguese is published", () => {
        // pt-BR carries the extraHreflangs ["pt"] alias - both codes must
        // resolve to the /pt/ variant of the SAME page, never diverge.
        for (const entry of entries) {
            if (entry.alternates["pt-BR"]) {
                expect(entry.alternates.pt, `pt alias for ${entry.loc}`).toBe(entry.alternates["pt-BR"]);
            } else {
                expect(entry.alternates.pt, `unexpected pt alias for ${entry.loc}`).toBeUndefined();
            }
        }
    });

    it("omits retired low-signal locale pages", () => {
        const urls = new Set(entries.map((entry) => entry.loc));
        expect(urls.has("https://everydashcam.app/pt/cameras/blackvue/")).toBe(false);
        expect(urls.has("https://everydashcam.app/ko/cameras/garmin/")).toBe(false);
        expect(urls.has("https://everydashcam.app/pt/cameras/vantrue/")).toBe(false);
        expect(urls.has("https://everydashcam.app/pt/cameras/thinkware/")).toBe(false);
    });

    it("alternates for vendor pages target the SAME vendor across locales (not site root)", () => {
        // Pick the 70mai entry from the EN locale; its de alternate must be
        // /de/cameras/70mai/, not /de/. English now lives under /en/ like
        // every other locale, not at /.
        const enVendor = entries.find((e) => e.loc === "https://everydashcam.app/en/cameras/70mai/");
        expect(enVendor).toBeDefined();
        expect(enVendor?.alternates.de).toMatch(/\/de\/cameras\/70mai\/$/);
        expect(enVendor?.alternates.ja).toBe("https://everydashcam.app/ja/cameras/70mai/");
    });
});

describe("hreflang graph completeness", () => {
    it("hreflang values across SEO_LOCALES are unique, generic aliases included", () => {
        // Aliases live in the same namespace as primary codes - a duplicate
        // (e.g. two locales both claiming "pt") would make the cluster
        // ambiguous for crawlers.
        const hreflangs = SEO_LOCALES.flatMap((l) => getHreflangCodes(l));
        expect(new Set(hreflangs).size).toBe(hreflangs.length);
    });

    it("every locale has a non-empty urlSegment - root is a redirect stub, not a locale", () => {
        for (const loc of SEO_LOCALES) {
            expect(loc.urlSegment, `${loc.lang} must have non-empty urlSegment`).not.toBe("");
        }
    });
});

// Minimal HTML fragment that mimics the post-minification baseline. Mirrors
// the structure index.html ships: <html lang>, canonical, content-language,
// hreflang + x-default, og:locale + og:locale:alternate, og:* / twitter:*
// meta with content tags, WebApplication JSON-LD anchored by id, FAQ JSON-LD,
// one data-i18n element, one data-i18n-attr element, one /cameras/ link.
// Kept here (not in a fixture file) so a single test can verify all rewrites.
function buildMinimalBaseline(jsonLdTags = { open: "script", close: "script" }): string {
    return [
        '<!doctype html><html lang="en"><head>',
        '<link href="https://everydashcam.app/" rel="canonical">',
        '<meta content="en-US" http-equiv="content-language">',
        // hreflang block - matches the attribute order html-minifier-terser
        // produces (href, rel, hreflang) in the real dist/ output.
        '<link href="https://everydashcam.app/de/" rel="alternate" hreflang="de">',
        '<link href="https://everydashcam.app/" rel="alternate" hreflang="en">',
        '<link href="https://everydashcam.app/ru/" rel="alternate" hreflang="ru">',
        '<link href="https://everydashcam.app/" rel="alternate" hreflang="x-default">',
        // og + twitter
        '<meta content="https://everydashcam.app/" property="og:url">',
        '<meta content="Old EN title" property="og:title">',
        '<meta content="Old EN description" property="og:description">',
        '<meta content="https://everydashcam.app/og-cover.png" property="og:image">',
        '<meta content="en_US" property="og:locale">',
        '<meta content="ru_RU" property="og:locale:alternate">',
        '<meta content="de_DE" property="og:locale:alternate">',
        '<meta name="twitter:title" content="Old EN title">',
        '<meta name="twitter:description" content="Old EN twitter">',
        '<meta name="twitter:image" content="https://everydashcam.app/og-cover.png">',
        // WebApplication JSON-LD with explicit id
        `<${jsonLdTags.open} id="webapp-jsonld" type="application/ld+json">{"@context":"https://schema.org","@type":"WebApplication","description":"OLD EN","url":"https://everydashcam.app/","inLanguage":["en","ru"],"featureList":["x"]}</${jsonLdTags.close}>`,
        `<${jsonLdTags.open} id="website-jsonld" type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","@id":"https://everydashcam.app/#website","name":"everydashcam","url":"https://everydashcam.app/"}</${jsonLdTags.close}>`,
        // FAQ JSON-LD (different id, should not be confused with WebApp)
        '<script id="faq-jsonld" type="application/ld+json">{"@type":"FAQPage","mainEntity":[]}</script>',
        "</head><body>",
        '<a href="/cameras/70mai/">vendor chip</a>',
        '<a href="/cameras/blackvue/">partially localized vendor</a>',
        '<a href="/cameras/">camera hub</a>',
        '<h1 data-i18n="page.title">EN literal</h1>',
        '<meta content="EN-only-fallback" data-i18n-attr="content:meta.description" name="description">',
        // i18n dictionary data island - empty in the baseline, filled per locale.
        '<script id="dc-i18n" type="application/json"></script>',
        "</body></html>",
    ].join("");
}

describe("applyLocale", () => {
    const ru = getPrerenderLocales().find((l) => l.seo.lang === "ru");
    if (!ru) throw new Error("test setup: ru locale missing from getPrerenderLocales");

    const out = applyLocale(buildMinimalBaseline(), ru, {});

    it("flips <html lang> to the target locale", () => {
        expect(out).toContain('<html data-prerendered lang="ru">');
    });

    it("rewrites canonical to the self-referencing locale URL", () => {
        expect(out).toMatch(/<link[^>]*href="https:\/\/everydashcam\.app\/ru\/"[^>]*rel="canonical"/);
    });

    it("rewrites og:url to the self-referencing locale URL", () => {
        expect(out).toMatch(/<meta[^>]*content="https:\/\/everydashcam\.app\/ru\/"[^>]*property="og:url"/);
    });

    it("rewrites content-language to BCP47 hyphen form", () => {
        expect(out).toMatch(/<meta[^>]*content="ru-RU"[^>]*http-equiv="content-language"/);
    });

    it("rewrites og:locale to the BCP47 underscore form for self", () => {
        expect(out).toMatch(/<meta[^>]*content="ru_RU"[^>]*property="og:locale">/);
    });

    it("rebuilds og:locale:alternate listing N-1 other locales (no self)", () => {
        const alts = [...out.matchAll(/<meta[^>]*property="og:locale:alternate"[^>]*>/g)];
        const indexable = getIndexableSeoLocales();
        expect(alts.length).toBe(indexable.length - 1);
        // self (ru_RU) must not appear in alternates
        expect(alts.every((m) => !m[0].includes("ru_RU"))).toBe(true);
        // every other locale must appear once
        for (const loc of indexable) {
            if (loc.lang === "ru") continue;
            expect(alts.some((m) => m[0].includes(loc.ogLocale))).toBe(true);
        }
    });

    it("rebuilds the hreflang cluster to the full graph + x-default", () => {
        const links = [...out.matchAll(/<link[^>]*\bhreflang="([^"]+)"[^>]*>/g)];
        const hreflangs = links.map((m) => m[1]);
        // every hreflang code (generic aliases included) appears exactly once
        for (const loc of getIndexableSeoLocales()) {
            for (const code of getHreflangCodes(loc)) {
                expect(hreflangs.filter((h) => h === code).length, `code ${code}`).toBe(1);
            }
        }
        expect(hreflangs).toContain("x-default");
    });

    it("generic pt alias link targets the same URL as the pt-BR link", () => {
        const links = [...out.matchAll(/<link[^>]*\bhreflang="([^"]+)"[^>]*\bhref="([^"]+)"[^>]*>/g)].map((m) => [m[1], m[2]] as const);
        const byCode = new Map(links);
        expect(byCode.get("pt")).toBeDefined();
        expect(byCode.get("pt")).toBe(byCode.get("pt-BR"));
    });

    it("rewrites WebApplication JSON-LD description, url, inLanguage, featureList", () => {
        const match = /<script[^>]*id="webapp-jsonld"[^>]*>([\s\S]*?)<\/script>/.exec(out);
        expect(match).not.toBeNull();
        const payload = JSON.parse(match![1]!);
        expect(payload.description).toBe(ru.dict["meta.description"]);
        expect(payload.url).toBe("https://everydashcam.app/ru/");
        expect(payload["@id"]).toBe("https://everydashcam.app/#webapp");
        expect(payload.isPartOf).toEqual({ "@id": "https://everydashcam.app/#website" });
        expect(payload.inLanguage).toEqual(getIndexableSeoLocales().map((l) => l.hreflang));
        // featureList: existing capability entries are preserved verbatim, a
        // single "vendor support" entry is appended/rewritten from SUPPORTED_BRANDS.
        expect(payload.featureList).toContain("x");
        const vendorLine = payload.featureList.find((s: unknown) => typeof s === "string" && s.endsWith("vendor support"));
        expect(vendorLine).toBeDefined();
        // Vendor line must include the full SUPPORTED_BRANDS list.
        expect(vendorLine).toMatch(/70mai.*Viofo.*BlackVue.*Vantrue.*Thinkware.*REDTIGER.*Botslab.*DATAKAM/);
    });

    it("keeps WebSite JSON-LD on the locale's canonical origin", () => {
        const match = /<script[^>]*id="website-jsonld"[^>]*>([\s\S]*?)<\/script>/.exec(out);
        expect(match).not.toBeNull();
        const payload = JSON.parse(match![1]!);
        expect(payload["@id"]).toBe("https://everydashcam.app/#website");
        expect(payload.url).toBe("https://everydashcam.app/");
    });

    it("does not touch FAQ JSON-LD's @type (only id=webapp-jsonld is rewritten)", () => {
        const match = /<script[^>]*id="faq-jsonld"[^>]*>([\s\S]*?)<\/script>/.exec(out);
        expect(match).not.toBeNull();
        const payload = JSON.parse(match![1]!);
        expect(payload["@type"]).toBe("FAQPage");
    });

    it("replaces data-i18n textContent with dictionary value", () => {
        // The h1 carried "EN literal" in the baseline; for ru it must be the
        // dict's page.title (which we don't hardcode here, just assert non-EN).
        expect(out).not.toContain("EN literal</h1>");
        expect(out).toContain(`>${ru.dict["page.title"]}</h1>`);
    });

    it("rewrites internal /cameras/ links to /ru/cameras/", () => {
        expect(out).toContain('href="/ru/cameras/70mai/"');
        expect(out).toContain('href="/ru/cameras/blackvue/"');
        expect(out).toContain('href="/ru/cameras/"');
        expect(out).not.toContain('href="/cameras/70mai/"');
    });

    it("includes the camera catalog link label in FAQ JSON-LD", () => {
        const match = /<script[^>]*id="faq-jsonld"[^>]*>([\s\S]*?)<\/script>/.exec(out);
        expect(match).not.toBeNull();
        const payload = JSON.parse(match![1]!);
        const item = payload.mainEntity.find((candidate: { name?: string }) => candidate.name === ru.dict["landing.faq.q2"]);
        expect(item?.acceptedAnswer?.text).toBe(`${ru.dict["landing.faq.a2.before"]}${ru.dict["landing.faq.a2.link"]}${ru.dict["landing.faq.a2.after"]}`);
    });

    it("applies the OG description override to og:description / twitter:description", () => {
        // og:description / twitter:description must end up as the locale's
        // purpose-built social-card copy (OG_OVERRIDES for ru), not the generic
        // dict["meta.description"]. ru has an override, so the two differ.
        expect(ru.ogDescription).not.toBe(ru.dict["meta.description"]);
        expect(out).toContain(`content="${ru.ogDescription}" property="og:description"`);
        expect(out).toContain(`name="twitter:description" content="${ru.twitterDescription}"`);
    });

    it("OG override wins even when og:description carries data-i18n-attr (swap-order regression guard)", () => {
        // Reproduces the index.html shape that caused the bug: og:description with
        // data-i18n-attr="content:meta.description". The data-i18n-attr swap runs
        // first and rewrites content to dict["meta.description"]; the OG override
        // must run AFTER it and win. If the override ever moves back before the
        // swap, content reverts to meta.description and this assertion fails.
        const baseline = buildMinimalBaseline().replace('<meta content="Old EN description" property="og:description">', '<meta content="Old EN description" property="og:description" data-i18n-attr="content:meta.description">');
        const localized = applyLocale(baseline, ru, {});
        expect(localized).toContain(`content="${ru.ogDescription}" property="og:description"`);
    });

    it.each(["primary", "mirror"] as const)("respects the %s profile when options.noIndex is false or omitted", (profile) => {
        vi.stubEnv("DEPLOYMENT_PROFILE", profile);
        vi.stubEnv("SEO_CUTOVER", "0");
        vi.stubEnv("SEO_MIRROR_CONFIG", JSON.stringify({ origin: "https://mirror.example.test", localeSegments: ["de"], rootLocaleSegment: "de" }));
        for (const options of [{}, { noIndex: false }]) {
            const localized = applyLocale(buildMinimalBaseline(), ru, options);
            expect(localized.includes('name="robots" content="noindex, nofollow"')).toBe(profile === "mirror");
            expect(localized.includes('name="robots" content="max-image-preview:large"')).toBe(profile === "primary");
        }
    });

    it("injects noindex meta-robots when options.noIndex is true", () => {
        const withNoIndex = applyLocale(buildMinimalBaseline(), ru, { noIndex: true });
        expect(withNoIndex).toMatch(/<head><meta name="robots" content="noindex, nofollow">/);
    });
});

describe("applyLocale on default (en) locale", () => {
    const en = getPrerenderLocales().find((l) => l.seo.lang === "en");
    if (!en) throw new Error("test setup: en locale missing");

    it("rewrites /cameras/ links with the /en/ prefix like any other locale", () => {
        const out = applyLocale(buildMinimalBaseline(), en, {});
        // Since English moved to /en/, vendor chip links must carry the
        // /en/ prefix just like /de/cameras/... or /ja/cameras/...
        expect(out).toContain('href="/en/cameras/70mai/"');
        expect(out).not.toContain('href="/cameras/70mai/"');
    });

    it("canonical points at /en/, the English locale's home", () => {
        const out = applyLocale(buildMinimalBaseline(), en, {});
        expect(out).toMatch(/<link[^>]*href="https:\/\/everydashcam\.app\/en\/"[^>]*rel="canonical"/);
    });

    it("hreflang x-default points at the default locale's home (/en/), not at the root stub", () => {
        const out = applyLocale(buildMinimalBaseline(), en, {});
        // Uniform "English variant" x-default policy - homepage hreflang
        // x-default targets /en/ same as sub-page x-default targets
        // /en/cameras/<slug>/. Earlier policy pointed homepage x-default
        // at "/", which is a content-less redirect stub and a poor
        // fallback target for crawlers that follow x-default.
        expect(out).toMatch(/<link[^>]*hreflang="x-default"[^>]*href="https:\/\/everydashcam\.app\/en\/"/);
    });
});

describe("applyLocale camera link fallbacks", () => {
    const pt = getPrerenderLocales().find((locale) => locale.seo.lang === "pt");
    if (!pt) throw new Error("test setup: pt locale missing");

    const out = applyLocale(buildMinimalBaseline(), pt, {});

    it("keeps available brands in the current locale", () => {
        expect(out).toContain('href="/pt/cameras/70mai/"');
        expect(out).toContain('href="/pt/cameras/"');
    });

    it("routes brands without a localized page to English", () => {
        expect(out).toContain('href="/en/cameras/blackvue/"');
        expect(out).not.toContain('href="/pt/cameras/blackvue/"');
    });
});

describe("mirror JSON-LD ownership", () => {
    const de = getPrerenderLocales().find((locale) => locale.seo.lang === "de");
    if (!de) throw new Error("test setup: de locale missing");

    it.each([
        { open: "script", close: "script" },
        { open: "SCRIPT", close: "script" },
        { open: "script", close: "SCRIPT" },
        { open: "ScRiPt", close: "sCrIpT" },
    ])("rewrites linked JSON-LD inside <$open> and </$close> for the locale and canonical origin", (tags) => {
        vi.stubEnv("DEPLOYMENT_PROFILE", "mirror");
        vi.stubEnv("SEO_CUTOVER", "1");
        vi.stubEnv(
            "SEO_MIRROR_CONFIG",
            JSON.stringify({
                origin: "https://mirror.example.test",
                localeSegments: ["de"],
                rootLocaleSegment: "de",
            }),
        );

        const out = applyLocale(buildMinimalBaseline(tags), de, {});
        const webappMatch = /<script[^>]*id="webapp-jsonld"[^>]*>([\s\S]*?)<\/script>/i.exec(out);
        const websiteMatch = /<script[^>]*id="website-jsonld"[^>]*>([\s\S]*?)<\/script>/i.exec(out);
        expect(webappMatch).not.toBeNull();
        expect(websiteMatch).not.toBeNull();
        const webapp = JSON.parse(webappMatch![1]!);
        const website = JSON.parse(websiteMatch![1]!);
        expect(webapp["@id"]).toBe("https://mirror.example.test/#webapp");
        expect(webapp.description).toBe(de.dict["meta.description"]);
        expect(webapp.url).toBe("https://mirror.example.test/de/");
        expect(webapp.isPartOf).toEqual({ "@id": "https://mirror.example.test/#website" });
        expect(website["@id"]).toBe("https://mirror.example.test/#website");
        expect(website.url).toBe("https://mirror.example.test/");
    });
});

describe("regional page emitters", () => {
    const regionalOrigin = "https://regional.example.test";
    const primaryOrigin = "https://everydashcam.app";
    const locales = getIndexableSeoLocales();

    function configure(profile: "primary" | "mirror"): void {
        vi.stubEnv("DEPLOYMENT_PROFILE", profile);
        vi.stubEnv("SEO_CUTOVER", "1");
        vi.stubEnv(
            "SEO_MIRROR_CONFIG",
            JSON.stringify({
                origin: regionalOrigin,
                rootLocaleSegment: "de",
                localeSegments: locales.map((locale) => locale.urlSegment),
                regionalHreflangs: Object.fromEntries(locales.map((locale) => [locale.urlSegment, `${locale.lang === "zh" ? "zh-Hans" : locale.lang}-CA`])),
            }),
        );
    }

    function graph(html: string): Record<string, string> {
        return Object.fromEntries([...html.matchAll(/<link\b[^>]*hreflang="([^"]+)"[^>]*href="([^"]+)"[^>]*>/g)].map((match) => [match[1]!, match[2]!]));
    }

    function render(path: string): string {
        const home = getPrerenderLocales().find((locale) => path === `/${locale.seo.urlSegment}/`);
        if (home) return applyLocale(buildMinimalBaseline(), home, {});
        const vendor = matchVendorRoute(path);
        if (vendor) return vendor.kind === "index" ? renderCamerasIndexPage(vendor.lang, {}) : renderVendorPage(vendor.vendor, vendor.lang, {});
        const alternative = matchAlternativeRoute(path);
        if (alternative) return alternative.kind === "index" ? renderAlternativesIndexPage(alternative.lang, {}) : renderAlternativePage(alternative.competitor, alternative.lang, {});
        const feature = matchFeatureRoute(path);
        if (feature) return renderFeaturePage(feature.page, feature.lang, {});
        throw new Error(`unrecognized test route ${path}`);
    }

    it.each(["/de/", "/de/cameras/", "/ru/cameras/garmin/", "/en/cameras/navitel/", "/fr/alternatives/", "/en/alternatives/dashcam-viewer/", "/pt/combine-dashcam-cameras-into-one-video/"])("emits reciprocal regional search signals for %s", (path) => {
        configure("primary");
        const primary = render(path);
        const primaryGraph = graph(primary);
        const sitemap = [...getVendorSitemapEntries(), ...getAlternativeSitemapEntries(), ...getFeatureSitemapEntries()];
        const entry = sitemap.find((candidate) => candidate.loc === `${primaryOrigin}${path}`);
        if (entry) expect(primaryGraph).toEqual({ ...entry.alternates, "x-default": entry.xDefaultUrl });
        configure("mirror");
        const mirror = render(path);
        expect(graph(mirror)).toEqual(primaryGraph);
        expect(primaryGraph["x-default"]).toBe(`${primaryOrigin}${path.replace(/^\/[^/]+\//, "/en/")}`);
        const mirrorEntry = [...getVendorSitemapEntries(), ...getAlternativeSitemapEntries(), ...getFeatureSitemapEntries()].find((candidate) => candidate.loc === `${regionalOrigin}${path}`);
        if (entry) expect(mirrorEntry).toMatchObject({ alternates: entry.alternates, xDefaultUrl: entry.xDefaultUrl });
        for (const [html, origin] of [
            [primary, primaryOrigin],
            [mirror, regionalOrigin],
        ]) {
            const canonicalTag = html!.match(/<link\b[^>]*rel="canonical"[^>]*>/)?.[0];
            expect(canonicalTag).toContain(`href="${origin}${path}"`);
            const ogTag = html!.match(/<meta\b[^>]*property="og:url"[^>]*>/)?.[0];
            expect(ogTag).toContain(`content="${origin}${path}"`);
            expect(html).not.toMatch(/name="(?:robots|googlebot|yandex)"[^>]*content="[^"]*noindex/);
            for (const script of html!.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
                const payload = JSON.parse(script[1]!);
                if (payload["@type"] === "BreadcrumbList") {
                    for (const item of payload.itemListElement) expect(item.item).toMatch(new RegExp(`^${origin}/`));
                }
                if (payload["@type"] === "WebApplication") expect(payload.url).toBe(`${origin}${path}`);
            }
        }
    });

    it("keeps missing vendor translations absent on both hosts", () => {
        configure("mirror");
        const html = render("/en/cameras/navitel/");
        const links = graph(html);
        expect(Object.keys(links).sort()).toEqual(["en", "en-CA", "pl", "pl-CA", "ru", "ru-CA", "x-default"]);
        expect(links.de).toBeUndefined();
        expect(links["de-CA"]).toBeUndefined();
        expect(matchVendorRoute("/de/cameras/navitel/")).toBeNull();
    });

    it("emits only the current host's canonical URLs from every sitemap family", () => {
        for (const profile of ["primary", "mirror"] as const) {
            configure(profile);
            const origin = profile === "primary" ? primaryOrigin : regionalOrigin;
            const entries = [...getVendorSitemapEntries(), ...getAlternativeSitemapEntries(), ...getFeatureSitemapEntries()];
            for (const entry of entries) {
                expect(entry.loc.startsWith(`${origin}/`)).toBe(true);
                expect(Object.values(entry.alternates)).toContain(entry.loc);
                expect(entry.xDefaultUrl.startsWith(`${primaryOrigin}/en/`)).toBe(true);
            }
        }
    });
});

// Throw-on-missing-anchor guards. Each rewrite function in seo-prerender uses
// a specific anchor in the baseline HTML; if the anchor disappears the rewrite
// would silently degrade SEO. Plugins throw instead - these tests pin that
// contract.
describe("applyLocale throws when baseline is missing required anchors", () => {
    const ru = getPrerenderLocales().find((l) => l.seo.lang === "ru");
    if (!ru) throw new Error("test setup: ru locale missing");

    function baselineWithout(...removeRes: RegExp[]): string {
        let html = buildMinimalBaseline();
        for (const re of removeRes) html = html.replace(re, "");
        return html;
    }

    it("throws when hreflang block is absent", () => {
        // Note: don't put `\b` after the closing quote of "alternate" - that
        // boundary doesn't match (both `"` and the following space are
        // non-word chars). The applyLocale regex itself has the same fix.
        const html = baselineWithout(/<link[^>]*\brel="alternate"[^>]*\bhreflang="[^"]+"[^>]*>/gi);
        expect(() => applyLocale(html, ru, {})).toThrow(/hreflang/);
    });

    it("throws when og:locale:alternate tags are absent", () => {
        const html = baselineWithout(/<meta[^>]*\bproperty="og:locale:alternate"[^>]*>/gi);
        expect(() => applyLocale(html, ru, {})).toThrow(/og:locale:alternate/);
    });

    it('throws when <script id="webapp-jsonld"> is absent', () => {
        const html = buildMinimalBaseline().replace(/<script[^>]*id="webapp-jsonld"[^>]*>[\s\S]*?<\/script>/, "");
        expect(() => applyLocale(html, ru, {})).toThrow(/webapp-jsonld/);
    });

    it('throws when <script id="website-jsonld"> is absent', () => {
        const html = buildMinimalBaseline().replace(/<script[^>]*id="website-jsonld"[^>]*>[\s\S]*?<\/script>/, "");
        expect(() => applyLocale(html, ru, {})).toThrow(/website-jsonld/);
    });

    it('throws when the <script id="dc-i18n"> data island is absent', () => {
        const html = buildMinimalBaseline().replace(/<script[^>]*id="dc-i18n"[^>]*>[\s\S]*?<\/script>/, "");
        expect(() => applyLocale(html, ru, {})).toThrow(/dc-i18n/);
    });
});

describe("applyLocale bakes the i18n dictionary island", () => {
    const ru = getPrerenderLocales().find((l) => l.seo.lang === "ru");
    if (!ru) throw new Error("test setup: ru locale missing");

    it("round-trips the complete dictionary and escapes script-closing values", () => {
        const dict = { ...ru.dict, "buckets.today": "</script><img src=x>" };
        const out = applyLocale(buildMinimalBaseline(), { ...ru, dict }, {});
        const match = out.match(/<script[^>]*id="dc-i18n"[^>]*>([\s\S]*?)<\/script>/);
        expect(match, "dc-i18n island must be present after applyLocale").not.toBeNull();
        expect(match![1]).not.toContain("<");
        expect(JSON.parse(match![1]!)).toEqual(dict);
    });
});

// rewriteFeatureList is exercised indirectly through applyLocale on
// baselines with various featureList shapes. Tests the contract: vendor
// support entries are rewritten to the current SUPPORTED_BRANDS list,
// duplicates are dropped, capability entries survive, non-Array → single
// brands line, missing entry → appended.
describe("WebApplication featureList rewriting", () => {
    const ru = getPrerenderLocales().find((l) => l.seo.lang === "ru");
    if (!ru) throw new Error("test setup: ru locale missing");

    function baselineWithFeatureList(featureList: unknown): string {
        const jsonLd = {
            "@context": "https://schema.org",
            "@type": "WebApplication",
            description: "OLD",
            url: "https://everydashcam.app/",
            inLanguage: ["en"],
            featureList,
        };
        return buildMinimalBaseline().replace(/<script[^>]*id="webapp-jsonld"[^>]*>[\s\S]*?<\/script>/, `<script id="webapp-jsonld" type="application/ld+json">${JSON.stringify(jsonLd)}</script>`);
    }

    function getFeatureList(out: string): unknown[] {
        const m = /<script[^>]*id="webapp-jsonld"[^>]*>([\s\S]*?)<\/script>/.exec(out);
        if (!m) throw new Error("no webapp-jsonld in output");
        return JSON.parse(m[1]!).featureList;
    }

    it("preserves capability entries and rewrites the vendor-support line", () => {
        const out = applyLocale(baselineWithFeatureList(["Plays MP4", "GPS map", "old vendor list vendor support"]), ru, {});
        const fl = getFeatureList(out);
        expect(fl).toContain("Plays MP4");
        expect(fl).toContain("GPS map");
        const vendorLine = fl.find((s): s is string => typeof s === "string" && s.endsWith("vendor support"));
        expect(vendorLine).toContain(getAllBrandsCommaSeparated());
        expect(fl.length).toBe(3); // no append, replaced in place
    });

    it("deduplicates multiple vendor-support entries", () => {
        const out = applyLocale(baselineWithFeatureList(["A vendor support", "B vendor support"]), ru, {});
        const fl = getFeatureList(out);
        // Only ONE vendor-support line should remain (deduped).
        const vendorLines = fl.filter((s): s is string => typeof s === "string" && s.endsWith("vendor support"));
        expect(vendorLines.length).toBe(1);
    });

    it("is case-insensitive for vendor-support suffix", () => {
        const out = applyLocale(baselineWithFeatureList(["X VENDOR SUPPORT"]), ru, {});
        const fl = getFeatureList(out);
        // Mixed-case entry should be replaced (not appended-to).
        expect(fl.length).toBe(1);
        expect(fl[0]).toContain(getAllBrandsCommaSeparated());
    });

    it("appends a vendor-support entry when none exists", () => {
        const out = applyLocale(baselineWithFeatureList(["Plays MP4", "GPS map"]), ru, {});
        const fl = getFeatureList(out);
        expect(fl.length).toBe(3);
        expect(fl[fl.length - 1]).toContain(getAllBrandsCommaSeparated());
    });

    it("returns single-entry list when featureList is not an array", () => {
        const out = applyLocale(baselineWithFeatureList("not an array"), ru, {});
        const fl = getFeatureList(out);
        expect(fl.length).toBe(1);
        expect(fl[0]).toContain(getAllBrandsCommaSeparated());
    });

    it("preserves non-string entries unchanged (schema.org allows objects)", () => {
        const out = applyLocale(baselineWithFeatureList([{ "@type": "Thing", name: "Capability" }, "A vendor support"]), ru, {});
        const fl = getFeatureList(out);
        // Non-string entry should survive.
        const obj = fl.find((e) => typeof e === "object" && e !== null);
        expect(obj).toEqual({ "@type": "Thing", name: "Capability" });
    });
});

// dynamic-baseline plugin: unit-test the transformIndexHtml handler directly.
// The handler is a pure function of the input HTML, so we can call it via
// the Plugin object and assert on its output.
describe("dynamic-baseline transformIndexHtml", () => {
    const plugin = dynamicBaselinePlugin();

    function runHandler(html: string): string {
        const t = plugin.transformIndexHtml;
        if (typeof t !== "object" || t === null || !("handler" in t)) {
            throw new Error("test setup: transformIndexHtml is not the object-with-handler form");
        }
        // ctx is unused by our handler, pass undefined cast.
        const result = (t.handler as (h: string) => string | Promise<string>)(html);
        if (typeof result !== "string") {
            throw new Error("test setup: handler returned non-string (Promise?)");
        }
        return result;
    }

    const MIN_BASELINE = ["<html><head>", "<script>var K=__DC_LANGS__;</script>", "<!--__DC_HREFLANG__-->", '<meta property="og:locale" content="en_US">', "<!--__DC_OG_LOCALE_ALTERNATES__-->", "</head></html>"].join("");

    it("replaces __DC_LANGS__ with JSON array of locale codes", () => {
        const out = runHandler(MIN_BASELINE);
        expect(out).not.toContain("__DC_LANGS__");
        // Output should contain a JSON array with all locale codes.
        for (const loc of SEO_LOCALES) {
            expect(out).toContain(`"${loc.lang}"`);
        }
    });

    it("expands hreflang marker to the full graph + x-default, generic aliases included", () => {
        const out = runHandler(MIN_BASELINE);
        expect(out).not.toContain("<!--__DC_HREFLANG__-->");
        for (const loc of getIndexableSeoLocales()) {
            for (const code of getHreflangCodes(loc)) {
                expect(out).toContain(`hreflang="${code}"`);
            }
        }
        expect(out).toContain('hreflang="x-default"');
    });

    it("expands og:locale:alternate marker to N-1 locales (skips default)", () => {
        const out = runHandler(MIN_BASELINE);
        expect(out).not.toContain("<!--__DC_OG_LOCALE_ALTERNATES__-->");
        // og:locale:alternate cluster covers every NON-default indexable locale.
        for (const loc of getIndexableSeoLocales()) {
            if (loc.urlSegment === "") continue;
            expect(out).toContain(`content="${loc.ogLocale}"`);
        }
    });

    it("throws when __DC_LANGS__ placeholder is missing", () => {
        const html = MIN_BASELINE.replace("__DC_LANGS__", "[]");
        expect(() => runHandler(html)).toThrow(/__DC_LANGS__/);
    });

    it("throws when __DC_HREFLANG__ marker is missing", () => {
        const html = MIN_BASELINE.replace("<!--__DC_HREFLANG__-->", "");
        expect(() => runHandler(html)).toThrow(/__DC_HREFLANG__/);
    });

    it("throws when __DC_OG_LOCALE_ALTERNATES__ marker is missing", () => {
        const html = MIN_BASELINE.replace("<!--__DC_OG_LOCALE_ALTERNATES__-->", "");
        expect(() => runHandler(html)).toThrow(/__DC_OG_LOCALE_ALTERNATES__/);
    });

    it("throws when an unknown __DC_ token survives expansion (vocabulary drift)", () => {
        const html = `${MIN_BASELINE}<!--__DC_FUTURE_PLACEHOLDER__-->`;
        expect(() => runHandler(html)).toThrow(/__DC_/);
    });
});

// matchVendorRoute: URL parser for the dev middleware. Pure function, easy
// to unit-test. The dev server relies on these branches to decide between
// rendering a vendor page, a /cameras/ index, or falling through to SPA.
describe("matchVendorRoute", () => {
    it("returns null for root and empty paths", () => {
        expect(matchVendorRoute("/")).toBeNull();
        expect(matchVendorRoute("")).toBeNull();
        expect(matchVendorRoute("//")).toBeNull();
    });

    it("returns null for bare locale homepage (handled by i18n-prerender, not vendor-pages)", () => {
        expect(matchVendorRoute("/de/")).toBeNull();
        expect(matchVendorRoute("/ru/")).toBeNull();
    });

    it("matches /cameras/ as the EN section index", () => {
        const result = matchVendorRoute("/cameras/");
        expect(result?.kind).toBe("index");
        expect(result?.lang).toBe("en");
    });

    it("matches /<lang>/cameras/ as a localized section index", () => {
        const ru = matchVendorRoute("/ru/cameras/");
        expect(ru?.kind).toBe("index");
        expect(ru?.lang).toBe("ru");

        const ja = matchVendorRoute("/ja/cameras/");
        expect(ja?.kind).toBe("index");
        expect(ja?.lang).toBe("ja");
    });

    it("matches /cameras/<slug>/ as an EN vendor page", () => {
        const result = matchVendorRoute("/cameras/70mai/");
        expect(result?.kind).toBe("vendor");
        expect(result?.lang).toBe("en");
        if (result?.kind === "vendor") {
            expect(result.vendor.slug).toBe("70mai");
        }
    });

    it("matches /<lang>/cameras/<slug>/ as a localized vendor page", () => {
        const result = matchVendorRoute("/de/cameras/blackvue/");
        expect(result?.kind).toBe("vendor");
        expect(result?.lang).toBe("de");
        if (result?.kind === "vendor") {
            expect(result.vendor.slug).toBe("blackvue");
        }
    });

    it("matches new vendor pages only in their configured locales", () => {
        expect(matchVendorRoute("/en/cameras/nextbase/")?.kind).toBe("vendor");
        expect(matchVendorRoute("/pl/cameras/navitel/")?.kind).toBe("vendor");
        expect(matchVendorRoute("/de/cameras/mio/")?.kind).toBe("vendor");
        expect(matchVendorRoute("/ru/cameras/navman/")?.kind).toBe("vendor");
        expect(matchVendorRoute("/es/cameras/nextbase/")?.kind).toBe("vendor");
        expect(matchVendorRoute("/de/cameras/navitel/")).toBeNull();
        expect(matchVendorRoute("/de/cameras/navman/")).toBeNull();
        expect(matchVendorRoute("/en/cameras/mivue/")).toBeNull();
    });

    it("does not match retired locale variants of existing vendors", () => {
        expect(matchVendorRoute("/pt/cameras/blackvue/")).toBeNull();
        expect(matchVendorRoute("/ko/cameras/garmin/")).toBeNull();
        expect(matchVendorRoute("/pt/cameras/vantrue/")).toBeNull();
        expect(matchVendorRoute("/pt/cameras/thinkware/")).toBeNull();
    });

    it("returns null for unknown vendor slugs", () => {
        expect(matchVendorRoute("/cameras/unknown-vendor/")).toBeNull();
        expect(matchVendorRoute("/de/cameras/random/")).toBeNull();
    });

    it("returns null for paths deeper than /<lang>/cameras/<slug>/", () => {
        expect(matchVendorRoute("/cameras/70mai/extra/")).toBeNull();
        expect(matchVendorRoute("/de/cameras/blackvue/something/")).toBeNull();
    });

    it("returns null for non-cameras paths (handled by i18n-prerender or SPA)", () => {
        expect(matchVendorRoute("/privacy.html")).toBeNull();
        expect(matchVendorRoute("/sitemap.xml")).toBeNull();
        expect(matchVendorRoute("/de/random/")).toBeNull();
    });

    it("collapses double-slash in path (filter drops empties)", () => {
        // /cameras//70mai/ → segments ["cameras", "70mai"] - still resolves.
        // This is a dev-only quirk; CF Pages would canonicalize in prod.
        const result = matchVendorRoute("/cameras//70mai/");
        expect(result?.kind).toBe("vendor");
    });
});

// JSON-LD payloads are embedded inside <script type="application/ld+json">.
// JSON.stringify alone does NOT escape "</script>" inside string values, so if
// a dict or vendor template ever contains that literal, the embedded payload
// would prematurely close the script tag and break the page. stringifyJsonLd
// is the defensive wrapper; verify it does the right thing.
describe("stringifyJsonLd", () => {
    it("escapes < to keep </script> from breaking out of the surrounding tag", () => {
        const out = stringifyJsonLd({ name: "broken </script><img onerror=alert(1)>" });
        expect(out).not.toContain("</script>");
        expect(out).toContain("\\u003c/script>");
    });

    it("escapes every < occurrence, not just the first", () => {
        const out = stringifyJsonLd({ a: "<b>", c: "<d>" });
        expect(out.includes("<")).toBe(false);
    });

    it("round-trips through JSON.parse to the original value", () => {
        const value = { name: "</script>", arr: ["<x>", "y"] };
        const out = stringifyJsonLd(value);
        expect(JSON.parse(out)).toEqual(value);
    });

    it("leaves payloads without < untouched (still valid JSON)", () => {
        const out = stringifyJsonLd({ "@context": "https://schema.org", name: "70mai" });
        expect(out).toBe('{"@context":"https://schema.org","name":"70mai"}');
    });
});

// SUPPORTED_BRANDS / VENDORS cross-check is a build-time assertion in
// vendorPagesPlugin.closeBundle. Verify the assertion's positive case here.
describe("SUPPORTED_BRANDS landing brands match VENDORS", () => {
    it("every brand with hasLandingPage=true has a matching VendorContent block", () => {
        // Each landing brand's slug appears in getVendorSitemapEntries() output,
        // which iterates over VENDORS internally. If a brand is in
        // SUPPORTED_BRANDS as hasLandingPage but missing in VENDORS, sitemap
        // would not contain its URL. After the /en/ migration English vendor
        // pages live at /en/cameras/<slug>/ - we look there instead of the
        // pre-migration /cameras/<slug>/ path.
        const entries = getVendorSitemapEntries();
        for (const brand of SUPPORTED_BRANDS) {
            if (!brand.hasLandingPage) continue;
            const expectedUrl = `https://everydashcam.app/en/cameras/${brand.slug}/`;
            expect(entries.some((e) => e.loc === expectedUrl)).toBe(true);
        }
    });

    it("publishes every dedicated brand page in English as the common fallback", () => {
        for (const brand of getLandingBrands()) {
            expect(brand.locales, `${brand.slug} English baseline`).toContain("en");
        }
    });
});

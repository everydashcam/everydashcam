import { describe, expect, it } from "vitest";
import {
    PRIMARY_SITE_ORIGIN,
    canonicalLocaleUrl,
    canonicalProfileForLocale,
    localeNeedsYandexNoIndex,
    mirrorRootLocaleSegment,
    parseDeploymentProfile,
    profileOwnsLocale,
    profileRequiresGlobalNoIndex,
    resolveSeoDeploymentContext,
    searchIndexingMeta,
    type SeoDeploymentContext,
} from "../../vite-plugins/deployment-profile.js";
import { buildSeoAlternates } from "../../vite-plugins/seo-alternates.js";
import { getIndexableSeoLocales, getSeoLocaleByLang } from "./seo-config.js";

const mirror = {
    origin: "https://mirror.example.test",
    localeSegments: ["de"],
    rootLocaleSegment: "de",
} as const;
const primaryBefore: SeoDeploymentContext = { profile: "primary", seoCutover: false, mirror };
const mirrorBefore: SeoDeploymentContext = { profile: "mirror", seoCutover: false, mirror };
const primaryAfter: SeoDeploymentContext = { profile: "primary", seoCutover: true, mirror };
const mirrorAfter: SeoDeploymentContext = { profile: "mirror", seoCutover: true, mirror };
const en = getSeoLocaleByLang("en")!;
const mirrored = getSeoLocaleByLang("de")!;

describe("deployment profile", () => {
    it("defaults to primary and rejects unknown values", () => {
        expect(parseDeploymentProfile(undefined)).toBe("primary");
        expect(parseDeploymentProfile("primary")).toBe("primary");
        expect(parseDeploymentProfile("mirror")).toBe("mirror");
        expect(() => parseDeploymentProfile("regional")).toThrow(/DEPLOYMENT_PROFILE/);
    });

    it("reads mirror ownership only from build-time JSON", () => {
        expect(
            resolveSeoDeploymentContext({
                DEPLOYMENT_PROFILE: "mirror",
                SEO_CUTOVER: "1",
                SEO_MIRROR_CONFIG: JSON.stringify(mirror),
            }),
        ).toEqual(mirrorAfter);
        expect(() => resolveSeoDeploymentContext({ DEPLOYMENT_PROFILE: "mirror" })).toThrow(/SEO_MIRROR_CONFIG/);
    });

    it("rejects malformed origins, unknown locales and ambiguous cutover values", () => {
        expect(() =>
            resolveSeoDeploymentContext({
                DEPLOYMENT_PROFILE: "mirror",
                SEO_MIRROR_CONFIG: JSON.stringify({ ...mirror, origin: "https://mirror.example.test/path" }),
            }),
        ).toThrow(/origin/);
        expect(() =>
            resolveSeoDeploymentContext({
                DEPLOYMENT_PROFILE: "mirror",
                SEO_MIRROR_CONFIG: JSON.stringify({
                    ...mirror,
                    localeSegments: ["not-a-shipped-locale"],
                    rootLocaleSegment: "not-a-shipped-locale",
                }),
            }),
        ).toThrow(/unknown URL segments/);
        expect(() => resolveSeoDeploymentContext({ SEO_CUTOVER: "yes" })).toThrow(/SEO_CUTOVER/);
    });

    it("keeps every canonical on primary until cutover", () => {
        expect(canonicalLocaleUrl(en, "", mirrorBefore)).toBe(`${PRIMARY_SITE_ORIGIN}/en/`);
        expect(canonicalLocaleUrl(mirrored, "cameras/70mai/", mirrorBefore)).toBe(`${PRIMARY_SITE_ORIGIN}/de/cameras/70mai/`);
        expect(profileRequiresGlobalNoIndex(mirrorBefore)).toBe(true);
        expect(profileRequiresGlobalNoIndex(primaryBefore)).toBe(false);
    });

    it("moves only configured locale segments after cutover", () => {
        expect(canonicalLocaleUrl(mirrored, "", primaryAfter)).toBe(`${mirror.origin}/de/`);
        expect(canonicalLocaleUrl(en, "", mirrorAfter)).toBe(`${PRIMARY_SITE_ORIGIN}/en/`);
        expect(canonicalProfileForLocale(mirrored, primaryAfter)).toBe("mirror");
        expect(canonicalProfileForLocale(en, mirrorAfter)).toBe("primary");
    });

    it("assigns reciprocal Yandex noindex only to the duplicate profile", () => {
        expect(profileOwnsLocale(mirrored, primaryAfter)).toBe(false);
        expect(localeNeedsYandexNoIndex(mirrored, primaryAfter)).toBe(true);
        expect(localeNeedsYandexNoIndex(en, primaryAfter)).toBe(false);
        expect(profileOwnsLocale(mirrored, mirrorAfter)).toBe(true);
        expect(localeNeedsYandexNoIndex(mirrored, mirrorAfter)).toBe(false);
        expect(localeNeedsYandexNoIndex(en, mirrorAfter)).toBe(true);
    });

    it("gets the mirror root locale from the private build config", () => {
        expect(mirrorRootLocaleSegment(mirrorAfter)).toBe("de");
    });
});

describe("regional deployment policy", () => {
    const locales = getIndexableSeoLocales();
    const regionalMirror = {
        origin: "https://regional.example.test",
        localeSegments: locales.map((locale) => locale.urlSegment),
        rootLocaleSegment: "de",
        regionalHreflangs: Object.fromEntries(locales.map((locale) => [locale.urlSegment, `${new Intl.Locale(locale.hreflang).language}${new Intl.Locale(locale.hreflang).script ? `-${new Intl.Locale(locale.hreflang).script}` : ""}-CA`])),
    };
    const context = (profile: "primary" | "mirror", seoCutover = true): SeoDeploymentContext => resolveSeoDeploymentContext({ DEPLOYMENT_PROFILE: profile, SEO_CUTOVER: String(seoCutover), SEO_MIRROR_CONFIG: JSON.stringify(regionalMirror) });
    const parse = (config: unknown) => resolveSeoDeploymentContext({ SEO_MIRROR_CONFIG: JSON.stringify(config) });

    it.each(["primary", "mirror"] as const)("keeps all %s locales self-canonical and indexable after regional cutover", (profile) => {
        const deployment = context(profile);
        const origin = profile === "primary" ? PRIMARY_SITE_ORIGIN : regionalMirror.origin;
        for (const locale of locales) {
            expect(canonicalLocaleUrl(locale, "cameras/", deployment)).toBe(`${origin}/${locale.urlSegment}/cameras/`);
            expect(profileOwnsLocale(locale, deployment)).toBe(true);
            expect(localeNeedsYandexNoIndex(locale, deployment)).toBe(false);
            expect(searchIndexingMeta(locale, false, deployment)).not.toContain("noindex");
            expect(searchIndexingMeta(locale, true, deployment)).toContain("noindex, nofollow");
        }
        expect(profileRequiresGlobalNoIndex(deployment)).toBe(false);
    });

    it("keeps the mirror canary out of the search graph before cutover", () => {
        for (const profile of ["primary", "mirror"] as const) {
            const deployment = context(profile, false);
            expect(canonicalLocaleUrl(mirrored, "", deployment)).toBe(`${PRIMARY_SITE_ORIGIN}/de/`);
            expect(Object.values(buildSeoAlternates("", locales, deployment).alternates).every((url) => url.startsWith(`${PRIMARY_SITE_ORIGIN}/`))).toBe(true);
            expect(searchIndexingMeta(mirrored, false, deployment).includes("noindex")).toBe(profile === "mirror");
        }
    });

    it("emits an identical graph on both hosts with primary aliases and regional pairs", () => {
        const primary = buildSeoAlternates("cameras/", locales, context("primary"));
        expect(buildSeoAlternates("cameras/", locales, context("mirror"))).toEqual(primary);
        expect(primary.xDefaultUrl).toBe(`${PRIMARY_SITE_ORIGIN}/en/cameras/`);
        expect(primary.alternates.pt).toBe(`${PRIMARY_SITE_ORIGIN}/pt/cameras/`);
        expect(primary.alternates["pt-BR"]).toBe(primary.alternates.pt);
        expect(primary.alternates["pt-CA"]).toBe(`${regionalMirror.origin}/pt/cameras/`);
        expect(primary.alternates["zh-Hans"]).toBe(`${PRIMARY_SITE_ORIGIN}/zh/cameras/`);
        expect(primary.alternates["zh-Hans-CA"]).toBe(`${regionalMirror.origin}/zh/cameras/`);
        expect(primary.alternates.zh).toBeUndefined();
        expect(Object.keys(primary.alternates)).toHaveLength(locales.length * 2 + 1);
    });

    it("restricts both hosts to a page's published translations", () => {
        const { alternates, xDefaultUrl } = buildSeoAlternates("cameras/example/", [en, mirrored], context("mirror"));
        expect(Object.keys(alternates).sort()).toEqual(["de", "de-CA", "en", "en-CA"]);
        expect(xDefaultUrl).toBe(`${PRIMARY_SITE_ORIGIN}/en/cameras/example/`);
        expect(() => buildSeoAlternates("", [mirrored], context("primary"))).toThrow(/default locale/);
    });

    it("preserves legacy ownership graphs and the standalone primary build", () => {
        const graph = buildSeoAlternates("", [en, mirrored], primaryAfter);
        expect(graph.alternates).toEqual({ en: `${PRIMARY_SITE_ORIGIN}/en/`, de: `${mirror.origin}/de/` });
        expect(buildSeoAlternates("", [en, mirrored], mirrorAfter)).toEqual(graph);
        const standalone = resolveSeoDeploymentContext({});
        expect(canonicalLocaleUrl(mirrored, "", standalone)).toBe(`${PRIMARY_SITE_ORIGIN}/de/`);
        expect(buildSeoAlternates("", [en], standalone)).toEqual({ alternates: { en: `${PRIMARY_SITE_ORIGIN}/en/` }, xDefaultUrl: `${PRIMARY_SITE_ORIGIN}/en/` });
    });

    it("requires an explicit complete regional map and matching locale availability", () => {
        expect(parse(regionalMirror).mirror).toEqual(regionalMirror);
        const { zh: _zh, ...missing } = regionalMirror.regionalHreflangs;
        for (const config of [
            { ...regionalMirror, regionalHreflangs: null },
            { ...regionalMirror, regionalHreflangs: [] },
            { ...regionalMirror, regionalHreflangs: missing },
            { ...regionalMirror, regionalHreflangs: { ...regionalMirror.regionalHreflangs, extra: "en-US" } },
            { ...regionalMirror, localeSegments: ["en"], rootLocaleSegment: "en" },
            { ...regionalMirror, localeSegments: [...regionalMirror.localeSegments, "en"] },
        ]) {
            expect(() => parse(config)).toThrow(/regionalHreflangs|regional mode/);
        }
    });

    it.each(["de", "de-ca", "de-XX", "de-EU", "de-UK", "de-AC", "de-XK", "de-419", "de-Latn-CA", "en-CA", "de-CA-u-ca-gregory"])("rejects invalid language, script or region in %s", (code) => {
        expect(() => parse({ ...regionalMirror, regionalHreflangs: { ...regionalMirror.regionalHreflangs, de: code } })).toThrow(/regionalHreflangs/);
    });

    it("rejects missing or changed Chinese script and codes already claimed by primary", () => {
        for (const code of ["zh-CA", "zh-Hant-CA"]) {
            expect(() => parse({ ...regionalMirror, regionalHreflangs: { ...regionalMirror.regionalHreflangs, zh: code } })).toThrow(/language and script/);
        }
        expect(() => parse({ ...regionalMirror, regionalHreflangs: { ...regionalMirror.regionalHreflangs, pt: "pt-BR" } })).toThrow(/duplicate hreflang/);
        expect(() => buildSeoAlternates("", [en, en], context("mirror"))).toThrow(/duplicate hreflang/);
    });
});

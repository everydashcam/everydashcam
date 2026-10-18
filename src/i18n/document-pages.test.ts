import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { getDocumentSitemapEntries, readDocumentSources, renderDocumentPage, renderDocumentStub } from "../../vite-plugins/document-pages.js";
import type { SeoDeploymentContext } from "../../vite-plugins/deployment-profile.js";
import { getIndexableSeoLocales } from "./seo-config.js";

const sources = readDocumentSources();
const locales = getIndexableSeoLocales();
const mirror = {
    origin: "https://mirror.example.test",
    localeSegments: locales.map((locale) => locale.urlSegment),
    rootLocaleSegment: "ru",
    regionalHreflangs: Object.fromEntries(locales.map((locale) => [locale.urlSegment, locale.lang === "zh" ? "zh-Hans-CH" : `${locale.lang}-CH`])),
};
const context: SeoDeploymentContext = { profile: "mirror", seoCutover: true, mirror };

function documentRuntime(pathname: string, search: string, attributes: Record<string, string>, stored: Record<string, string> = {}) {
    let redirected: string | undefined;
    const root = { lang: pathname.split("/")[1] ?? "en", getAttribute: (key: string) => attributes[key] ?? null };
    runInNewContext(readFileSync("public/doc-lang.js", "utf8"), {
        document: { documentElement: root, querySelectorAll: () => [] },
        window: {
            location: {
                pathname,
                search,
                hash: "#details",
                replace: (url: string) => {
                    redirected = url;
                },
            },
        },
        navigator: { language: "de-DE" },
        localStorage: {
            getItem: (key: string) => stored[key] ?? null,
            setItem: (key: string, value: string) => {
                stored[key] = value;
            },
        },
        URLSearchParams,
    });
    return { redirected, lang: root.lang };
}

describe("localized standalone documents", () => {
    it("publishes one existing article per URL with local metadata and same-host navigation", () => {
        for (const source of sources) {
            for (const locale of source.locales) {
                const html = renderDocumentPage(source, locale, { deployment: context });
                const url = `${mirror.origin}/${locale.urlSegment}/${source.slug}/`;
                expect(html.match(/<article\b/g), `${source.slug}/${locale.lang}`).toHaveLength(1);
                expect(html).toContain(`<article data-lang="${locale.lang}">`);
                expect(html).not.toMatch(/<article[^>]*\bhidden/);
                expect(html).toContain(`<html lang="${locale.lang}"`);
                expect(html).toContain(`<link rel="canonical" href="${url}">`);
                expect(html).toContain(`<meta property="og:url" content="${url}">`);
                expect(html).not.toContain("noindex");
                expect(html).not.toContain("?lang=en");
                expect(html).not.toContain('href="https://everydashcam.app">');
                expect(html).toContain(`href="/en/${source.slug}/"`);
                expect(html).toContain(`hreflang="en-CH" href="${mirror.origin}/en/${source.slug}/"`);
                const title = source.articles.get(locale.lang)!.match(/<h1>([^<]+)<\/h1>/)![1];
                expect(html).toContain(`<title>${title} | everydashcam</title>`);
                const description = html.match(/<meta name="description" content="([^"]+)"/)![1]!;
                expect(description.length).toBeGreaterThan(20);
                if (locale.lang !== "en") expect(description).not.toBe(renderDocumentPage(source, source.locales.find((item) => item.lang === "en")!).match(/<meta name="description" content="([^"]+)"/)![1]);
            }
        }
    });

    it("advertises only available document translations", () => {
        const source = sources[0]!;
        const available = source.locales.filter((locale) => locale.lang === "en" || locale.lang === "ru");
        const limited = { ...source, locales: available, articles: new Map([...source.articles].filter(([lang]) => lang === "en" || lang === "ru")) };
        const html = renderDocumentPage(limited, available[0]!, { deployment: context });
        expect(html).not.toContain('hreflang="de"');
        expect(html).not.toContain('data-set-lang="de"');
        expect(html).toContain('hreflang="ru-CH"');
        expect(() => renderDocumentPage(limited, locales.find((locale) => locale.lang === "de")!)).toThrow(/unavailable translation/);
    });

    it("turns old URLs into same-host English fallbacks outside the language graph", () => {
        for (const source of sources) {
            const html = renderDocumentStub(source, { deployment: context });
            expect(html).toContain(`rel="canonical" href="${mirror.origin}/en/${source.slug}/"`);
            expect(html).toContain(`http-equiv="refresh" content="0; url=/en/${source.slug}/"`);
            expect(html).not.toContain("hreflang=");
            expect(html).not.toContain("<article");
            expect(html).not.toContain("noindex");
            expect(renderDocumentStub(source, { noIndex: true, deployment: context })).toContain('content="noindex, nofollow"');
        }
        const entries = getDocumentSitemapEntries();
        expect(entries).toHaveLength(sources.reduce((sum, source) => sum + source.locales.length, 0));
        expect(entries.every((entry) => /\/[a-z]{2}\/(privacy|terms|add-my-camera)\/$/.test(entry.loc))).toBe(true);
        expect(entries.every((entry) => !("lastmod" in entry))).toBe(true);
    });

    it("honors legacy query then saved language and preserves unrelated URL details", () => {
        const attributes = { "data-doc-slug": "privacy", "data-doc-locales": "en,ru,de", "data-doc-redirect": "true" };
        expect(documentRuntime("/privacy", "?lang=ru&from=old", attributes, { "everydashcam:doc-lang": "en" }).redirected).toBe("/ru/privacy/?from=old#details");
        expect(documentRuntime("/privacy", "", attributes, { "everydashcam:doc-lang": "ru" }).redirected).toBe("/ru/privacy/#details");
        expect(documentRuntime("/privacy", "?lang=fr", attributes).redirected).toBe("/de/privacy/#details");
    });

    it("keeps explicit localized documents fixed despite a conflicting query and preference", () => {
        const stored = { "everydashcam:doc-lang": "en" };
        expect(documentRuntime("/ru/privacy/", "?lang=en", { "data-doc-slug": "privacy", "data-doc-locales": "en,ru" }, stored)).toEqual({ redirected: undefined, lang: "ru" });
        expect(stored["everydashcam:doc-lang"]).toBe("ru");
    });
});

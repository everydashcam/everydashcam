import { beforeAll, describe, expect, it } from "vitest";
import { getAlternativeSitemapEntries, matchAlternativeRoute, renderAlternativePage, renderAlternativesIndexPage } from "../../vite-plugins/alternative-pages.js";
import { getFeatureSitemapEntries, matchFeatureRoute, renderFeaturePage } from "../../vite-plugins/feature-pages.js";
import { renderBreadcrumbs } from "../../vite-plugins/seo-navigation.js";
import { getVendorSitemapEntries, matchVendorRoute, renderCamerasIndexPage, renderVendorPage } from "../../vite-plugins/vendor-pages.js";
import { getIndexableSeoLocales } from "./seo-config.js";

interface BreadcrumbList {
    "@type": string;
    itemListElement: Array<{ position: number; name: string; item: string }>;
}

function renderSurface(path: string): string {
    const vendor = matchVendorRoute(path);
    if (vendor) return vendor.kind === "index" ? renderCamerasIndexPage(vendor.lang, {}) : renderVendorPage(vendor.vendor, vendor.lang, {});
    const alternative = matchAlternativeRoute(path);
    if (alternative) return alternative.kind === "index" ? renderAlternativesIndexPage(alternative.lang, {}) : renderAlternativePage(alternative.competitor, alternative.lang, {});
    const feature = matchFeatureRoute(path);
    if (feature) return renderFeaturePage(feature.page, feature.lang, {});
    throw new Error(`no SEO surface for ${path}`);
}

function decodeText(text: string): string {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");
}

const entries = [...getVendorSitemapEntries(), ...getAlternativeSitemapEntries(), ...getFeatureSitemapEntries()];
const surfaces = new Map<string, string>();

beforeAll(() => {
    for (const entry of entries) {
        const path = new URL(entry.loc).pathname;
        surfaces.set(path, renderSurface(path));
    }
});

describe("SEO surface navigation", () => {
    it("helps visitors choose cameras using real model families instead of untranslated GPS descriptions", () => {
        for (const locale of getIndexableSeoLocales()) {
            const html = surfaces.get(`/${locale.urlSegment}/cameras/`)!;
            const cards = [...html.matchAll(/<a class="vp-vendor-card" href="([^"]+)">([\s\S]*?)<\/a>/g)];
            expect(cards.length, locale.lang).toBeGreaterThan(0);
            for (const [, path, card] of cards) {
                const route = matchVendorRoute(path!);
                if (route?.kind !== "vendor") throw new Error(`camera card has no vendor page: ${path}`);
                const hints = [...card!.matchAll(/<span class="vp-vendor-card-hint">([^<]+)<\/span>/g)].map((match) => decodeText(match[1]!));
                expect(hints.length, path).toBe(1);
                const displayedModels = hints[0]!.split(" · ");
                expect(displayedModels.length, path).toBeGreaterThan(0);
                for (const model of displayedModels) expect(route.vendor.models, path).toContain(model);
            }
        }
    });

    it("connects every published page to its hierarchy with visible breadcrumbs that match JSON-LD", () => {
        for (const entry of entries) {
            const html = surfaces.get(new URL(entry.loc).pathname)!;
            const breadcrumbHtml = /<nav class="vp-breadcrumbs"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1];
            expect(breadcrumbHtml, entry.loc).toBeDefined();
            const documents = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]!) as BreadcrumbList);
            const breadcrumb = documents.find((document) => document["@type"] === "BreadcrumbList");
            expect(breadcrumb, entry.loc).toBeDefined();
            const items = breadcrumb!.itemListElement;
            expect(items.length, entry.loc).toBeGreaterThanOrEqual(2);
            expect(items.at(-1)?.item, entry.loc).toBe(entry.loc);
            expect([...breadcrumbHtml!.matchAll(/<li>/g)].length, entry.loc).toBe(items.length);
            for (const [index, item] of items.entries()) {
                expect(item.position, entry.loc).toBe(index + 1);
                expect(decodeText(breadcrumbHtml!), entry.loc).toContain(`>${item.name}</`);
                if (index < items.length - 1) {
                    expect(breadcrumbHtml, entry.loc).toContain(`href="${new URL(item.item).pathname}"`);
                }
            }
            expect(decodeText(breadcrumbHtml!), entry.loc).toContain(`<span aria-current="page">${items.at(-1)?.name}</span>`);
        }
    });

    it("offers ordinary same-origin language links for exactly the published page variants", () => {
        for (const entry of entries) {
            const path = new URL(entry.loc).pathname;
            const html = surfaces.get(path)!;
            const navigation = /<nav class="vp-languages"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1];
            expect(navigation, path).toBeDefined();
            const links = [...navigation!.matchAll(/<a href="([^"]+)" hreflang="([^"]+)" lang="([^"]+)"([^>]*)>([^<]+)<\/a>/g)];
            const published = new Set(Object.values(entry.alternates).map((url) => new URL(url).pathname));
            expect(new Set(links.map((link) => link[1])), path).toEqual(published);
            expect(links.length, path).toBe(published.size);
            for (const [, href, hreflang, lang, , label] of links) {
                expect(href, path).toMatch(/^\/(?!\/)/);
                expect(href, path).toBe(new URL(entry.alternates[hreflang!]!).pathname);
                expect(lang, path).toBe(hreflang);
                expect(label?.trim().length, path).toBeGreaterThan(1);
                expect(href?.endsWith("/"), path).toBe(true);
            }
            const currentLinks = links.filter((link) => link[4]?.includes('aria-current="page"'));
            expect(currentLinks.length, path).toBe(1);
            expect(currentLinks[0]?.[1], path).toBe(path);
        }
    });

    it("keeps content pages free of application scripts and unused font preloads", () => {
        for (const entry of entries) {
            const html = surfaces.get(new URL(entry.loc).pathname)!;
            expect(html, entry.loc).not.toMatch(/<script[^>]*\bsrc=/);
            expect(html, entry.loc).not.toMatch(/<link[^>]*\brel="preload"[^>]*\bas="font"/);
        }
    });

    it("keeps the breadcrumb hierarchy on the visitor's mirror and escapes visible names", () => {
        const { html, jsonLd } = renderBreadcrumbs("en", [
            { name: 'Home & "player"', url: "https://everydashcam.app/en/" },
            { name: "<Camera>", url: "https://mirror.example/en/cameras/" },
        ]);
        expect(html).toContain('href="/en/"');
        expect(html).not.toContain('href="https://');
        expect(html).toContain('Home &amp; "player"');
        expect(html).toContain("&lt;Camera&gt;");
        expect(JSON.parse(jsonLd).itemListElement[1].item).toBe("https://mirror.example/en/cameras/");
    });
});

import { describe, expect, it } from "vitest";
import { SUPPORTED_BRANDS } from "../../vite-plugins/supported-brands.js";
import { getVendorSitemapEntries, matchVendorRoute, renderCamerasIndexPage, renderVendorPage } from "../../vite-plugins/vendor-pages.js";
import { getIndexableSeoLocales } from "./seo-config.js";

describe("supported camera catalog", () => {
    it("shows every registered brand once in every locale with matching structured data", () => {
        for (const locale of getIndexableSeoLocales()) {
            const html = renderCamerasIndexPage(locale.lang, {});
            const names = [...html.matchAll(/<span class="vp-vendor-card-name">([^<]+)<\/span>/g)].map((match) => match[1]);
            expect(names.length, locale.lang).toBe(SUPPORTED_BRANDS.length);
            expect(names, locale.lang).toEqual(SUPPORTED_BRANDS.map((brand) => brand.displayName));
            expect([...html.matchAll(/<ul class="vp-vendor-grid">/g)], locale.lang).toHaveLength(1);
            const documents = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]!));
            const collection = documents.find((document) => document["@type"] === "CollectionPage");
            expect(collection.mainEntity.numberOfItems, locale.lang).toBe(names.length);
            expect(
                collection.mainEntity.itemListElement.map((item: { name: string }) => item.name),
                locale.lang,
            ).toEqual(names);
            for (const item of collection.mainEntity.itemListElement) {
                expect(names, locale.lang).toContain(item.name);
                const target = new URL(item.url);
                if (target.hash) expect(html, item.url).toContain(`id="${target.hash.slice(1)}"`);
                else expect(matchVendorRoute(target.pathname)?.kind, item.url).toBe("vendor");
            }
        }
    });

    it("labels English links when a brand has no page in the catalog language", () => {
        for (const locale of getIndexableSeoLocales()) {
            const html = renderCamerasIndexPage(locale.lang, {});
            for (const brand of SUPPORTED_BRANDS) {
                if (!brand.hasLandingPage) continue;
                const targetLang = brand.locales.includes(locale.lang) ? locale.lang : "en";
                const href = `/${targetLang}/cameras/${brand.slug}/`;
                expect(html, `${locale.lang}: ${brand.displayName}`).toContain(`href="${href}"`);
                if (targetLang !== locale.lang) {
                    expect(html).toContain(`class="vp-catalog-english" href="${href}" hreflang="en"`);
                }
                expect(matchVendorRoute(href)?.kind).toBe("vendor");
            }
        }
    });

    it("keeps recording caveats without presenting sample models as a compatibility list", () => {
        const html = renderCamerasIndexPage("pt", {});
        const card = (slug: string) => new RegExp(`<li id="camera-${slug}">([\\s\\S]*?)</li>`).exec(html)?.[1];
        expect(card("avylet")).not.toContain("A1");
        expect(card("avylet")).toContain("Requer receptor GPS");
        expect(card("datakam")).toContain("GPS em gravações exportadas");
        expect(card("botslab")).not.toContain("G300H Pro");
        expect(card("izeeker")).not.toContain("iD300");
        expect(card("izeeker")).toContain("Vídeo e GPS");
        expect(card("hp")).not.toContain("f969x");
        expect(card("hp")).toContain("Reprodução de vídeo");
        expect(card("hp")).not.toContain("Vídeo e GPS");
        expect(card("ibox")).not.toContain("iCON");
        expect(card("ibox")).not.toContain("RoadScan");
    });

    it("retains verified GPS support on cards that link to English guidance", () => {
        const html = renderCamerasIndexPage("pt", {});
        for (const slug of ["blackvue", "vantrue", "thinkware", "nextbase", "redtiger", "navitel", "mio-mivue", "navman-mivue", "ddpai", "blackview", "innovv", "xega", "aspiring"]) {
            const card = new RegExp(`<li id="camera-${slug}">([\\s\\S]*?)</li>`).exec(html)?.[1];
            expect(card, slug).toContain("Vídeo e GPS");
            expect(card, slug).toContain('hreflang="en"');
        }
        for (const slug of ["fitcamx", "hp", "jooyfact", "rexing", "e-ace", "fujida", "gku"]) {
            const card = new RegExp(`<li id="camera-${slug}">([\\s\\S]*?)</li>`).exec(html)?.[1];
            expect(card, slug).toContain("Reprodução de vídeo");
            expect(card, slug).not.toContain("Vídeo e GPS");
        }
        const garmin = /<li id="camera-garmin">([\s\S]*?)<\/li>/.exec(renderCamerasIndexPage("ko", {}))?.[1];
        expect(garmin).toContain("영상 재생");
        expect(garmin).not.toContain("영상 및 GPS");
    });

    it("connects every published camera page to its catalog and retains the app destination", () => {
        for (const entry of getVendorSitemapEntries()) {
            const path = new URL(entry.loc).pathname;
            const route = matchVendorRoute(path);
            if (route?.kind !== "vendor") continue;
            const html = renderVendorPage(route.vendor, route.lang, {});
            const catalog = renderCamerasIndexPage(route.lang, {});
            expect(catalog, path).toContain(`href="${path}"`);
            expect(html, path).toContain(`href="/${route.lang}/cameras/"`);
            expect(html, path).toContain(`href="/${route.lang}/?vendor=${route.vendor.slug}"`);
            expect(html, path).not.toContain('class="vp-facts"');
            expect(html, path).not.toMatch(/\{(?:vendor|layout|filename|codec|container)\}/);
            const relatedBrands = [...html.matchAll(/href="\/[^/]+\/cameras\/[^/]+\/"/g)];
            // Language links can point only to translations of this same brand.
            expect(
                relatedBrands.every(([anchor]) => anchor.endsWith(`/${route.vendor.slug}/"`)),
                path,
            ).toBe(true);
        }
    });

    it("limits new GPS promises to the recording evidence", () => {
        const page = (slug: string) => {
            const route = matchVendorRoute(`/en/cameras/${slug}/`);
            if (route?.kind !== "vendor") throw new Error(`missing camera page: ${slug}`);
            return renderVendorPage(route.vendor, "en", {});
        };
        expect(page("avylet")).toContain("optional GPS receiver");
        expect(page("datakam")).toContain("exported recording layout");
        expect(page("sony")).toContain(".LOG");
        expect(page("botslab")).toContain("GPS.TXT");
        expect(page("hp")).toContain("do not contain readable GPS");
        for (const slug of ["hp", "jooyfact", "rexing"]) {
            expect(page(slug)).not.toContain('href="/en/add-data-overlay-to-dashcam-video/"');
            expect(page(slug)).not.toContain('href="/en/combine-dashcam-cameras-into-one-video/"');
        }
        expect(page("fitcamx")).not.toContain('href="/en/add-data-overlay-to-dashcam-video/"');
        expect(page("fitcamx")).toContain('href="/en/combine-dashcam-cameras-into-one-video/"');
        for (const slug of ["avylet", "sony", "hp"]) {
            expect(matchVendorRoute(`/de/cameras/${slug}/`)).toBeNull();
            const route = matchVendorRoute(`/en/cameras/${slug}/`);
            if (route?.kind !== "vendor") throw new Error(`missing camera page: ${slug}`);
            const html = renderVendorPage(route.vendor, "en", {});
            expect(html).toContain(`hreflang="ru" href="https://everydashcam.app/ru/cameras/${slug}/"`);
            expect(html).not.toContain('hreflang="de"');
        }
    });

    it("requires reviewed copy for every published language instead of a generic fallback", () => {
        for (const entry of getVendorSitemapEntries()) {
            const route = matchVendorRoute(new URL(entry.loc).pathname);
            if (route?.kind !== "vendor") continue;
            expect(route.vendor.locales[route.lang], entry.loc).toBeDefined();
            expect(Object.values(route.vendor.locales[route.lang]!), entry.loc).not.toContain("");
        }
        const route = matchVendorRoute("/de/cameras/70mai/");
        if (route?.kind !== "vendor") throw new Error("missing German camera page");
        const incomplete = { ...route.vendor, locales: { ...route.vendor.locales } };
        delete incomplete.locales.de;
        expect(() => renderVendorPage(incomplete, "de", {})).toThrow("missing reviewed copy");
    });

    it("retains essential companion-file guidance in all published translations", () => {
        const requiredFiles: Record<string, string[]> = {
            comtec: ["EG-1", ".TS", "Movie", "Front", "Rear"],
            "70mai": ["GPSData*.txt", "A510"],
            blackvue: [".gps", ".3gf", "DR550GW-2CH", "DR900X Plus"],
            gopro: ["HERO5", "HERO6", "HERO7", "HERO8", "MAX"],
            mio: [".NMEA", "FILE…F.mp4", "FILE…R.mp4"],
            navman: [".NMEA"],
            botslab: ["GPS.TXT", "360CARDVR/REC"],
            sony: [".LOG"],
            escort: [".map"],
            ddpai: ["203gps", ".gpx", ".git", "USB", "Z60 Pro"],
            ibox: ["RoadScan 2K", "RoadScan 4K", "F", "R"],
            redtiger: ["F17", "Video_Front", "Video_Inside", "Video_Rear"],
            xega: ["InternalView", "ExteriorView"],
            blackview: ["X5S PRO", ".TS", "F", "R"],
            innovv: ["N2", "K3", ".TS"],
            aspiring: ["Expert 9", ".TS"],
            jooyfact: ["A1", ".MOV"],
            rexing: ["SC4KS", ".TS"],
        };
        for (const entry of getVendorSitemapEntries()) {
            const route = matchVendorRoute(new URL(entry.loc).pathname);
            if (route?.kind !== "vendor") continue;
            const content = route.vendor.locales[route.lang]!;
            for (const term of requiredFiles[route.vendor.slug] ?? []) {
                expect(`${content.modelsCompat} ${content.formatIntro}`, entry.loc).toContain(term);
            }
        }
    });

    it("does not turn model lineups into confirmed recording compatibility", () => {
        for (const slug of ["garmin", "fitcamx", "compartir"]) {
            const route = matchVendorRoute(`/en/cameras/${slug}/`);
            if (route?.kind !== "vendor") throw new Error(`missing camera page: ${slug}`);
            const html = renderVendorPage(route.vendor, "en", {});
            expect(route.vendor.models).toEqual([]);
            expect(html).not.toContain('class="vp-models"');
            if (slug !== "compartir") expect(html).not.toContain('href="/en/add-data-overlay-to-dashcam-video/"');
        }
        const redtiger = matchVendorRoute("/en/cameras/redtiger/");
        if (redtiger?.kind !== "vendor") throw new Error("missing REDTIGER page");
        const html = renderVendorPage(redtiger.vendor, "en", {});
        expect(html).toContain("older encrypted F7N GPS format is not readable");
        expect(html).not.toContain("F77");
    });
});

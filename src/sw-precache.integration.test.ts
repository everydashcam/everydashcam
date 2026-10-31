import { createHash } from "node:crypto";
// Integration test for the precache injection pipeline. Reads the built
// artifacts and asserts:
//
//   1. The manifest the plugin builds from the real dist/ covers every emitted
//      JS/CSS file and local map style/sprite dependencies, including the actual
//      /en/ boot graph, while fonts and decorative media stay cache-as-used.
//      A code dependency missing from the precache is an
//      offline failure visible only in the field.
//
//   2. All prerendered locale shells (/<lang>/) are in the manifest.
//
//   3. The manifest and tracker URLs evaluated from the minified dist/sw.js
//      match the final artifacts. This also catches invalid JavaScript and
//      placeholders left behind by the build pipeline.
//
// Like csp-hash.integration.test.ts this runs against artifacts on disk: it
// needs `npm run build` first. Missing dist/ skips locally but THROWS in CI.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { SEO_LOCALES } from "./i18n/seo-config.js";
import { collectPrecacheEntries } from "../vite-plugins/sw-precache.js";
import { computeTrackerAssets } from "../vite-plugins/tracker-assets.js";

const DIST_DIR = resolve(__dirname, "..", "dist");
const EN_HTML = resolve(DIST_DIR, "en", "index.html");
const SW = resolve(DIST_DIR, "sw.js");

const hasDist = existsSync(EN_HTML) && existsSync(SW);
if (!hasDist && process.env.CI) {
    throw new Error(
        "sw-precache integration: dist/en/index.html or dist/sw.js missing in CI - run `npm run build` first",
    );
}
const itIf = hasDist ? it : it.skip;

// Root-relative asset URLs the /en/ shell needs to boot: the entry <script>,
// every <link rel=modulepreload>, and the stylesheet.
function bootAssetsOf(html: string): string[] {
    const out: string[] = [];
    const script = html.match(/<script\b[^>]*\bsrc="(\/assets\/[^"]+)"/i);
    if (script?.[1]) out.push(script[1]);
    for (const m of html.matchAll(/<link\b[^>]*\bhref="(\/assets\/[^"]+\.js)"[^>]*\bmodulepreload/gi)) {
        if (m[1]) out.push(m[1]);
    }
    // modulepreload attribute order is not guaranteed - also match rel-first.
    for (const m of html.matchAll(/<link\b[^>]*\bmodulepreload\b[^>]*\bhref="(\/assets\/[^"]+\.js)"/gi)) {
        if (m[1]) out.push(m[1]);
    }
    for (const m of html.matchAll(/<link\b[^>]*\bhref="(\/assets\/[^"]+\.css)"/gi)) {
        if (m[1]) out.push(m[1]);
    }
    return [...new Set(out)];
}

function injectedValues(): { manifest: unknown; trackerUrls: unknown } {
    return runInNewContext(
        `${readFileSync(SW, "utf-8")}\n;({ manifest: PRECACHE_MANIFEST, trackerUrls: TRACKER_ASSET_URLS });`,
        {
            URL,
            self: { location: { origin: "https://everydashcam.app" }, addEventListener() {} },
        },
    );
}

describe("sw-precache integration: manifest covers the real boot graph", () => {
    const segments = SEO_LOCALES.map((locale) => locale.urlSegment);
    let entries: ReturnType<typeof collectPrecacheEntries>;
    let urls: Set<string>;
    let injected: ReturnType<typeof injectedValues>;

    beforeAll(() => {
        if (!hasDist) return;
        entries = collectPrecacheEntries(DIST_DIR, segments);
        urls = new Set(entries.map((entry) => entry.url));
        injected = injectedValues();
    });

    itIf("every /en/ boot asset (entry, preloads, css) is in the precache manifest", () => {
        const boot = bootAssetsOf(readFileSync(EN_HTML, "utf-8"));
        expect(boot.length, "parsed at least the entry script + css from /en/").toBeGreaterThanOrEqual(2);
        for (const asset of boot) {
            expect(urls.has(asset), `boot asset ${asset} must be precached`).toBe(true);
        }
    });

    itIf("every emitted JS/CSS file is in the precache manifest", () => {
        const assets = readdirSync(resolve(DIST_DIR, "assets"), { recursive: true, encoding: "utf8" })
            .filter((file) => /\.(?:m?js|css)$/.test(file))
            .map((file) => file.replaceAll("\\", "/"));
        expect(assets.length, "dist/assets has emitted JS/CSS").toBeGreaterThan(0);
        for (const asset of assets) {
            expect(urls.has(`/assets/${asset}`), `code asset /assets/${asset} must be precached`).toBe(true);
        }
    });

    itIf("all local map styles and sprite variants are available before opening the map", () => {
        const styles = readdirSync(resolve(DIST_DIR, "styles"), { recursive: true, encoding: "utf8" })
            .filter((file) => /\.(?:json|png)$/.test(file))
            .map((file) => file.replaceAll("\\", "/"));
        expect(
            styles.some((file) => file.endsWith(".json")),
            "local map style JSON exists",
        ).toBe(true);
        expect(
            styles.some((file) => file.endsWith("@2x.png")),
            "high-density map sprite exists",
        ).toBe(true);
        for (const file of styles) {
            expect(
                [...urls].some((url) => url.startsWith("/styles/") && url.endsWith(`/${file}`)),
                `map dependency /styles/${file} must be precached`,
            ).toBe(true);
        }
    });

    itIf("hosted map styles preserve the readable source data without its formatting", () => {
        const sourceDir = resolve(DIST_DIR, "..", "public", "styles");
        const styles = readdirSync(sourceDir).filter((file) => file.endsWith(".json"));
        expect(styles.length, "readable map styles exist").toBeGreaterThan(0);
        for (const file of styles) {
            const original = JSON.parse(readFileSync(resolve(sourceDir, file), "utf8")) as Record<string, unknown>;
            const url = [...urls].find((url) => url.startsWith("/styles/") && url.endsWith(`/${file}`))!;
            const emitted = readFileSync(resolve(DIST_DIR, url.slice(1)), "utf8");
            const style = JSON.parse(emitted) as Record<string, unknown>;
            expect(emitted, `${file} ships as compact JSON`).toBe(JSON.stringify(style));
            if (typeof original.sprite === "string" && original.sprite.startsWith("/styles/")) {
                expect(style.sprite).toMatch(/^\/styles\/[a-f0-9]{16}\/sprite\/sprite$/);
                for (const suffix of [".json", ".png", "@2x.json", "@2x.png"]) {
                    expect(existsSync(resolve(DIST_DIR, `${String(style.sprite).slice(1)}${suffix}`))).toBe(true);
                }
                original.sprite = style.sprite;
            }
            expect(style, `${file} retains its layers, expressions and external URLs`).toEqual(original);
        }
    });

    itIf("self-hosted fonts stay out of the precache manifest", () => {
        const fonts = readdirSync(resolve(DIST_DIR, "fonts"));
        expect(fonts.length, "dist/fonts has self-hosted fonts").toBeGreaterThan(0);
        for (const f of fonts) {
            expect(urls.has(`/fonts/${f}`), `font /fonts/${f} must stay cache-as-used`).toBe(false);
        }
    });

    itIf("all prerendered locale shells are in the precache manifest", () => {
        for (const url of ["/", ...segments.map((segment) => `/${segment}/`)]) {
            expect(
                entries.find((entry) => entry.url === url),
                `shell ${url} must carry its build identity`,
            ).toMatchObject({
                htmlRevision: expect.stringMatching(/^[0-9a-f]{16}$/),
            });
        }
    });

    itIf("the injected manifest contains every final artifact and its current content revision", () => {
        expect(injected.manifest).toEqual(entries);
    });

    itIf("the injected tracker URLs match the emitted runtime and model bytes", () => {
        const root = resolve(DIST_DIR, "..");
        const assets = computeTrackerAssets("build", root);
        expect(injected.trackerUrls).toEqual(assets.urls);
        for (const url of assets.urls) {
            const emitted = readFileSync(resolve(DIST_DIR, url.slice(1)));
            expect(emitted.equals(assets.files.get(url)!), `tracker asset ${url} matches its snapshot`).toBe(true);
            expect(emitted.length, `tracker asset ${url} fits Cloudflare Pages`).toBeLessThanOrEqual(25 * 1024 * 1024);
        }
        for (const runtime of Object.values(assets.app.ort)) {
            const wasm = runtime.wasm;
            if (!("parts" in wasm)) continue;
            const assembled = Buffer.concat(
                wasm.parts.map((part) => readFileSync(resolve(DIST_DIR, part.url.slice(1)))),
            );
            expect(assembled.length).toBe(wasm.bytes);
            for (const part of wasm.parts) {
                expect(createHash("sha256").update(assets.files.get(part.url)!).digest("hex")).toBe(part.sha256);
            }
        }
    });
});

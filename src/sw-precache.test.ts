// Unit test for the precache-manifest builder (vite-plugins/sw-precache.ts).
//
// Hermetic: builds a synthetic dist/ tree in a temp dir and asserts
// collectPrecacheEntries picks up exactly the functional code graph and locale
// shells, and nothing else. A missing entry/lazy chunk in the manifest is an
// offline failure that only shows up in the field, so this is the cheap gate
// that catches a scan-scope regression at build time.

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectPrecacheEntries, stampPrecacheShells } from "../vite-plugins/sw-precache.js";

const created: string[] = [];

afterAll(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe("stampPrecacheShells", () => {
    it("stamps a stable build identity while revisions hash the final shell bytes", () => {
        const root = "<html><head><title>root</title></head><body>root</body></html>";
        const en = "<html><head><title>en</title></head><body>en</body></html>";
        const dir = makeDist({ "index.html": root, "en/index.html": en, "assets/app.js": "// app" });
        stampPrecacheShells(dir, ["en"]);
        const first = collectPrecacheEntries(dir, ["en"]);
        for (const [url, file, source] of [
            ["/", "index.html", root],
            ["/en/", "en/index.html", en],
        ] as const) {
            const entry = first.find((item) => item.url === url);
            const stamped = readFileSync(join(dir, file));
            expect(entry?.htmlRevision).toBe(createHash("sha256").update(source).digest("hex").slice(0, 16));
            expect(stamped.toString()).toContain(`<meta name="dc-precache-revision" content="${entry?.htmlRevision}">`);
            expect(entry?.revision).toBe(createHash("sha256").update(stamped).digest("hex").slice(0, 16));
        }
        expect(first.find((entry) => entry.url === "/assets/app.js")?.htmlRevision).toBeUndefined();
        stampPrecacheShells(dir, ["en"]);
        expect(collectPrecacheEntries(dir, ["en"])).toEqual(first);

        writeFileSync(
            join(dir, "en/index.html"),
            readFileSync(join(dir, "en/index.html"), "utf8").replace("<body>en", "<body>changed"),
        );
        stampPrecacheShells(dir, ["en"]);
        const updated = collectPrecacheEntries(dir, ["en"]).find((entry) => entry.url === "/en/");
        expect(updated?.htmlRevision).not.toBe(first.find((entry) => entry.url === "/en/")?.htmlRevision);
        expect(readFileSync(join(dir, "en/index.html"), "utf8").match(/name="dc-precache-revision"/g)).toHaveLength(1);
    });

    it("rejects an incomplete shell before publishing an unverifiable precache", () => {
        const dir = makeDist({ "index.html": "<html>no head</html>" });
        expect(() => stampPrecacheShells(dir, [])).toThrow(/no closing head tag/);
    });
});

// Build a synthetic dist/ tree. `files` maps a dist-relative path to its
// content; parent dirs are created as needed. Returns the temp dist dir.
function makeDist(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "dc-sw-"));
    created.push(dir);
    for (const [rel, content] of Object.entries(files)) {
        const full = join(dir, rel);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, content);
    }
    return dir;
}

// A realistic-enough tree: app code + presentation assets + two locale shells
// and a stub, plus the SEO/marketing noise that must stay OUT.
function realisticDist(): string {
    return makeDist({
        "assets/index-AAAA1111.js": "// entry",
        "assets/index-BBBB2222.css": "/* css */",
        "assets/maplibre-CCCC3333.js": "// maplibre",
        "assets/ingest-worker-DDDD.js": "// worker",
        "assets/workers/nested-worker-EEEE.js": "// nested worker",
        "assets/workers/module-worker-FFFF.mjs": "// module worker",
        "assets/credits/maplibre.svg": "<svg/>",
        "assets/landing-image.png": "PNG",
        "assets/ort-runtime.wasm": "WASM",
        "fonts/inter-var-latin.woff2": "FONT",
        "fonts/chakra-petch-700-latin.woff2": "FONT2",
        "styles/light.json": '{"version":8}',
        "styles/dark.json": '{"version":8,"sprite":"/styles/sprite/sprite"}',
        "styles/sprite/sprite.json": "{}",
        "styles/sprite/sprite.png": "PNG",
        "styles/sprite/sprite@2x.json": "{}",
        "styles/sprite/sprite@2x.png": "PNG2",
        "en/index.html": "<html>en</html>",
        "ru/index.html": "<html>ru</html>",
        "index.html": "<html>stub</html>",
        "manifest.webmanifest": "{}",
        "favicon.svg": "<svg/>",
        "favicon-192.png": "PNG",
        "icon-maskable-512.png": "PNG",
        // Noise - must NOT be precached:
        "og-cover.png": "PNG",
        "pwa-install-card-wide.png": "PNG",
        "privacy.html": "<html>privacy redirect</html>",
        "en/privacy/index.html": "<html>privacy</html>",
        "ru/terms/index.html": "<html>terms</html>",
        "en/add-my-camera/index.html": "<html>camera help</html>",
        "robots.txt": "noindex",
        "sitemap.xml": "<urlset/>",
        "styles/README.md": "style attribution",
        "en/cameras/70mai/index.html": "<html>vendor</html>",
        "sw.js": "// the SW itself must not precache itself",
    });
}

describe("collectPrecacheEntries", () => {
    it("includes functional code, local map styles and sprites, locale shells and the root stub", () => {
        const dir = realisticDist();
        const urls = collectPrecacheEntries(dir, ["en", "ru"]).map((e) => e.url);

        expect(urls).toEqual([
            "/",
            "/assets/index-AAAA1111.js",
            "/assets/index-BBBB2222.css",
            "/assets/ingest-worker-DDDD.js",
            "/assets/maplibre-CCCC3333.js",
            "/assets/workers/module-worker-FFFF.mjs",
            "/assets/workers/nested-worker-EEEE.js",
            "/en/",
            "/ru/",
            "/styles/dark.json",
            "/styles/light.json",
            "/styles/sprite/sprite.json",
            "/styles/sprite/sprite.png",
            "/styles/sprite/sprite@2x.json",
            "/styles/sprite/sprite@2x.png",
        ]);
    });

    it("excludes fonts, media, install metadata, SEO pages and the SW itself", () => {
        const dir = realisticDist();
        const urls = new Set(collectPrecacheEntries(dir, ["en", "ru"]).map((e) => e.url));

        for (const out of [
            "/assets/credits/maplibre.svg",
            "/assets/landing-image.png",
            "/assets/ort-runtime.wasm",
            "/fonts/inter-var-latin.woff2",
            "/fonts/chakra-petch-700-latin.woff2",
            "/manifest.webmanifest",
            "/favicon.svg",
            "/favicon-192.png",
            "/icon-maskable-512.png",
            "/og-cover.png",
            "/pwa-install-card-wide.png",
            "/privacy.html",
            "/robots.txt",
            "/sitemap.xml",
            "/styles/README.md",
            "/en/cameras/70mai/",
            "/en/cameras/70mai/index.html",
            "/sw.js",
        ]) {
            expect(urls.has(out), `${out} must NOT be precached`).toBe(false);
        }
    });

    it("excludes .wasm from the shell (runtime lazy download, not app code)", () => {
        // The ~13 MB onnxruntime wasm is emitted into /assets by the bundler but
        // loaded from /ort/ at runtime; precaching the /assets duplicate only
        // bloats the shell and races eviction. Functional JS/CSS stay in.
        const dir = makeDist({
            "assets/index-AAAA1111.js": "// entry",
            "assets/ort-wasm-simd-threaded-Cpm-ox6i.wasm": "WASM",
            "en/index.html": "<html>en</html>",
            "index.html": "<html>stub</html>",
        });
        const urls = new Set(collectPrecacheEntries(dir, ["en"]).map((e) => e.url));
        expect(urls.has("/assets/index-AAAA1111.js")).toBe(true);
        expect(urls.has("/assets/ort-wasm-simd-threaded-Cpm-ox6i.wasm")).toBe(false);
    });

    it("uses the trailing-slash navigation form for locale shells, not index.html", () => {
        const dir = realisticDist();
        const urls = new Set(collectPrecacheEntries(dir, ["en", "ru"]).map((e) => e.url));
        expect(urls.has("/en/")).toBe(true);
        expect(urls.has("/en/index.html")).toBe(false);
    });

    it("gives every entry a 16-hex content revision, and the revision tracks content", () => {
        const a = collectPrecacheEntries(makeDist({ "en/index.html": "v1", "index.html": "x", "assets/x.js": "x" }), [
            "en",
        ]);
        const enA = a.find((e) => e.url === "/en/");
        expect(enA?.revision).toMatch(/^[0-9a-f]{16}$/);

        const b = collectPrecacheEntries(makeDist({ "en/index.html": "v2", "index.html": "x", "assets/x.js": "x" }), [
            "en",
        ]);
        const enB = b.find((e) => e.url === "/en/");
        // Same path, different content -> different revision (drives reconcile).
        expect(enB?.revision).not.toBe(enA?.revision);
    });

    it("returns entries sorted by url (deterministic injection output)", () => {
        const urls = collectPrecacheEntries(realisticDist(), ["en", "ru"]).map((e) => e.url);
        const sorted = [...urls].sort();
        expect(urls).toEqual(sorted);
    });

    it("updates a stable map asset revision when its bytes change", () => {
        const dir = realisticDist();
        const before = collectPrecacheEntries(dir, ["en", "ru"]);
        writeFileSync(join(dir, "styles/dark.json"), '{"version":8,"name":"new style"}');
        const after = collectPrecacheEntries(dir, ["en", "ru"]);
        expect(after.find((entry) => entry.url === "/styles/dark.json")?.revision).not.toBe(
            before.find((entry) => entry.url === "/styles/dark.json")?.revision,
        );
        expect(after.filter((entry) => entry.url !== "/styles/dark.json")).toEqual(
            before.filter((entry) => entry.url !== "/styles/dark.json"),
        );
    });

    it("throws when a prerendered locale shell is missing (incomplete build)", () => {
        const dir = makeDist({ "en/index.html": "en", "index.html": "stub", "assets/x.js": "x" });
        // "de" has no shell in this tree.
        expect(() => collectPrecacheEntries(dir, ["en", "de"])).toThrow(/de\/index\.html missing/);
    });

    it("throws when the root stub is missing", () => {
        const dir = makeDist({ "en/index.html": "en", "assets/x.js": "x" });
        expect(() => collectPrecacheEntries(dir, ["en"])).toThrow(/index\.html missing/);
    });
});

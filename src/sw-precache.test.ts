import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectPrecacheEntries, stampPrecacheShells } from "../vite-plugins/sw-precache.js";

const created: string[] = [];
afterAll(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
});
const html = (body: string) => `<html><head><title>app</title></head><body>${body}</body></html>`;
function makeDist(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "dc-sw-"));
    created.push(dir);
    for (const [rel, content] of Object.entries(files)) {
        const full = join(dir, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
    }
    return dir;
}

describe("Workbox precache manifest", () => {
    it("includes the complete code/map/shell graph and excludes optional or unrelated resources", async () => {
        const required = {
            "assets/app-AAAA1111.js": "app",
            "assets/app-BBBB2222.css": "css",
            "assets/workers/lazy.mjs": "lazy",
            "styles/abc/light.json": "{}",
            "styles/abc/sprite/sprite.json": "{}",
            "styles/abc/sprite/sprite.png": "png",
            "styles/abc/sprite/sprite@2x.json": "{}",
            "styles/abc/sprite/sprite@2x.png": "png2",
            "index.html": html("root"),
            "en/index.html": html("en"),
            "ru/index.html": html("ru"),
        };
        const dir = makeDist({
            ...required,
            "assets/hero.png": "png",
            "assets/runtime.wasm": "wasm",
            "fonts/inter.woff2": "font",
            "ort/runtime.wasm": "wasm",
            "models/model.onnx": "model",
            "styles/README.md": "readme",
            "manifest.webmanifest": "{}",
            "favicon.svg": "svg",
            "sw.js": "worker",
            "en/privacy/index.html": html("privacy"),
            "en/cameras/model/index.html": html("camera"),
        });
        stampPrecacheShells(dir, ["en", "ru"]);
        const entries = await collectPrecacheEntries(dir, ["en", "ru"]);
        expect(entries.map((entry) => entry.url).sort()).toEqual(
            Object.keys(required)
                .map((file) => `/${file.replace(/index\.html$/, "")}`)
                .sort(),
        );
        for (const entry of entries) {
            if (entry.url.endsWith("/")) {
                expect(entry.integrity).toBeUndefined();
                expect(readFileSync(join(dir, `${entry.url}index.html`), "utf8")).toContain(
                    `content="${entry.revision}"`,
                );
            } else {
                const bytes = readFileSync(join(dir, entry.url));
                expect(entry.integrity).toBe(`sha256-${createHash("sha256").update(bytes).digest("base64")}`);
                expect(entry.revision).toBe(createHash("sha256").update(bytes).digest("hex").slice(0, 16));
            }
        }
    });

    it("stamps shell identity deterministically and changes it when shell content changes", async () => {
        const original = html("en");
        const dir = makeDist({ "index.html": html("root"), "en/index.html": original, "assets/app.js": "code" });
        stampPrecacheShells(dir, ["en"]);
        const first = await collectPrecacheEntries(dir, ["en"]);
        expect(first.find((entry) => entry.url === "/en/")?.revision).toBe(
            createHash("sha256").update(original).digest("hex").slice(0, 16),
        );
        stampPrecacheShells(dir, ["en"]);
        expect(await collectPrecacheEntries(dir, ["en"])).toEqual(first);
        writeFileSync(
            join(dir, "en/index.html"),
            readFileSync(join(dir, "en/index.html"), "utf8").replace("<body>en", "<body>changed"),
        );
        stampPrecacheShells(dir, ["en"]);
        const after = await collectPrecacheEntries(dir, ["en"]);
        expect(after.find((entry) => entry.url === "/en/")?.revision).not.toBe(
            first.find((entry) => entry.url === "/en/")?.revision,
        );
        expect(readFileSync(join(dir, "en/index.html"), "utf8").match(/name="dc-precache-revision"/g)).toHaveLength(1);
    });

    it("allows code above Workbox's default 2 MiB cutoff", async () => {
        const dir = makeDist({ "index.html": html("root"), "assets/large.js": "x".repeat(2 * 1024 * 1024 + 1) });
        stampPrecacheShells(dir, []);
        expect((await collectPrecacheEntries(dir, [])).map((entry) => entry.url)).toContain("/assets/large.js");
    });

    it("fails when a shell, its marker, or the application code is missing", async () => {
        const dir = makeDist({ "index.html": html("root"), "assets/app.js": "code" });
        await expect(collectPrecacheEntries(dir, ["en"])).rejects.toThrow("en/index.html missing");
        await expect(collectPrecacheEntries(dir, [])).rejects.toThrow("no build marker");
        const empty = makeDist({ "index.html": html("root") });
        stampPrecacheShells(empty, []);
        await expect(collectPrecacheEntries(empty, [])).rejects.toThrow("no JavaScript");
    });

    it("rejects invalid shell markup before publication", () => {
        const dir = makeDist({ "index.html": "<html>no head</html>" });
        expect(() => stampPrecacheShells(dir, [])).toThrow("no closing head tag");
    });
});

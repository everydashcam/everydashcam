import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collectDeploymentAssets } from "../vite-plugins/deployment-assets.js";
import {
    legacyAssetUrls,
    parseDeploymentAssets,
    retainDeploymentAssets,
} from "../scripts/retain-deployment-assets.mts";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
});
function release(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "dc-release-"));
    roots.push(root);
    for (const [name, bytes] of Object.entries(files)) {
        const path = join(root, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
    }
    const manifest = collectDeploymentAssets(root);
    writeFileSync(join(root, "deployment-assets.json"), JSON.stringify(manifest));
    return { root, manifest };
}
function serve(previous: ReturnType<typeof release>, corrupt = false) {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: URL) => {
            const name = input.pathname.slice(1);
            if (name === "sw.js")
                return new Response(
                    `const PRECACHE_MANIFEST=${JSON.stringify(previous.manifest.files)};const TRACKER_ASSET_URLS=[];`,
                );
            const bytes = readFileSync(join(previous.root, name));
            return new Response(corrupt && name !== "deployment-assets.json" ? "corrupt" : bytes, {
                headers: { "content-type": "application/octet-stream" },
            });
        }),
    );
}
it("keeps only the current and previous release across A to B to C and a rollback", async () => {
    const a = release({ "assets/a.js": "a", "ort/a.wasm": "wa", "index.html": "a-shell" });
    const b = release({ "assets/b.js": "b", "models/b.onnx": "mb", "index.html": "b-shell" });
    serve(a);
    expect(await retainDeploymentAssets(b.root, "https://example.test")).toBe(2);
    expect(readFileSync(join(b.root, "index.html"), "utf8")).toBe("b-shell");
    expect(JSON.parse(readFileSync(join(b.root, "deployment-assets.json"), "utf8"))).toEqual(b.manifest);
    const c = release({ "assets/c.js": "c", "ort/c.wasm": "wc" });
    serve(b);
    await retainDeploymentAssets(c.root, "https://example.test");
    expect(() => readFileSync(join(c.root, "assets/a.js"))).toThrow();
    expect(readFileSync(join(c.root, "models/b.onnx"), "utf8")).toBe("mb");
    const rollback = release({ "assets/b.js": "b", "models/b.onnx": "mb" });
    serve(c);
    await retainDeploymentAssets(rollback.root, "https://example.test");
    expect(readFileSync(join(rollback.root, "ort/c.wasm"), "utf8")).toBe("wc");
});
it("rejects corrupt previous bytes and content changing under an immutable URL", async () => {
    const a = release({ "assets/a.js": "a" });
    const b = release({ "assets/b.js": "b" });
    serve(a, true);
    await expect(retainDeploymentAssets(b.root, "https://example.test")).rejects.toThrow("integrity mismatch");
    const conflict = release({ "assets/a.js": "different" });
    serve(a);
    await expect(retainDeploymentAssets(conflict.root, "https://example.test")).rejects.toThrow("collision");
});
it("extracts legacy asset literals without executing a worker", () => {
    const source =
        'const PRECACHE_MANIFEST=[{url:`/en/`,revision:`abc`},{url:`/assets/a.js`,revision:`abc`}];const TRACKER_ASSET_URLS=["/ort/1.31.1/a.wasm","/models/a.onnx"];throw new Error("do not execute")';
    expect(legacyAssetUrls(source)).toEqual(["/assets/a.js", "/ort/1.31.1/a.wasm", "/models/a.onnx"]);
});
it.each(["/assets/../../private/file", "//evil.test/a.js", "/assets/a.js?other", "/sw.js"])(
    "rejects an unsafe manifest URL %s",
    (url) => {
        expect(() =>
            parseDeploymentAssets({
                schema: 1,
                files: [{ url, bytes: 1, sha256: createHash("sha256").update("a").digest("hex") }],
            }),
        ).toThrow();
    },
);

it("drops the carried older generation when a recovery artifact is deployed again", async () => {
    const a = release({ "assets/a.js": "a" });
    const b = release({ "assets/b.js": "b" });
    serve(a);
    await retainDeploymentAssets(b.root, "https://example.test");
    const c = release({ "assets/c.js": "c" });
    serve(c);
    await retainDeploymentAssets(b.root, "https://example.test");
    expect(() => readFileSync(join(b.root, "assets/a.js"))).toThrow();
    expect(readFileSync(join(b.root, "assets/c.js"), "utf8")).toBe("c");
});

it("reads combined declarations emitted by the published Oxc minifier", () => {
    expect(
        legacyAssetUrls(
            "const PRECACHE_MANIFEST=[{url:`/assets/a.js`,revision:`abc`}],TRACKER_ASSET_URLS=[`/models/a.onnx`],SCHEMA=`v4`;",
        ),
    ).toEqual(["/assets/a.js", "/models/a.onnx"]);
});

it("rejects a published worker and manifest from different releases", async () => {
    const current = release({ "assets/current.js": "current" });
    const previous = release({ "assets/previous.js": "previous" });
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async (url: URL) =>
                new Response(
                    url.pathname === "/sw.js"
                        ? 'const PRECACHE_MANIFEST=[{url:"/assets/other.js"}];const TRACKER_ASSET_URLS=[];'
                        : JSON.stringify(previous.manifest),
                ),
        ),
    );
    await expect(retainDeploymentAssets(current.root, "https://example.test")).rejects.toThrow("disagree");
});

it("allows an initial deployment when neither metadata nor a worker exists", async () => {
    const current = release({ "assets/current.js": "current" });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 404 })),
    );
    expect(await retainDeploymentAssets(current.root, "https://example.test")).toBe(0);
    expect(readFileSync(join(current.root, "assets/current.js"), "utf8")).toBe("current");
});

it("retains bundled images and sprite notices without source maps or HTML", () => {
    const current = release({
        "assets/car-ABCDEFGH.webp": "image",
        "assets/credits/library.svg": "unversioned logo",
        "assets/viewer-hash.js": "code",
        "assets/viewer-hash.js.map": "source map",
        "assets/page.html": "shell",
        "styles/hash/sprite/NOTICE.txt": "sprite notice",
    });
    expect(current.manifest.files.map((file) => file.url)).toEqual([
        "/assets/car-ABCDEFGH.webp",
        "/assets/viewer-hash.js",
        "/styles/hash/sprite/NOTICE.txt",
    ]);
});

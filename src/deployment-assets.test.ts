import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collectDeploymentAssets } from "../vite-plugins/deployment-assets.js";
import { parseDeploymentAssets, retainDeploymentAssets } from "../scripts/retain-deployment-assets.mts";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
function release(files: Record<string, string>, publicUrls: string[] = []) {
    const root = mkdtempSync(join(tmpdir(), "dc-release-"));
    roots.push(root);
    for (const [name, bytes] of Object.entries(files)) {
        const path = join(root, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
    }
    const urls = Object.keys(files)
        .filter((name) => /^(?:assets|ort|models|styles)\//.test(name) && !/\.(?:map|html)$/.test(name))
        .map((name) => `/${name}`)
        .filter((url) => !publicUrls.includes(url));
    const manifest = collectDeploymentAssets(root, urls, publicUrls);
    writeFileSync(join(root, "deployment-assets.json"), JSON.stringify(manifest));
    return { root, manifest };
}
function serve(previous: ReturnType<typeof release>, corrupt = false) {
    const fetch = vi.fn(async (input: URL) => {
        const name = input.pathname.slice(1);
        const bytes = readFileSync(join(previous.root, name));
        return new Response(corrupt && name !== "deployment-assets.json" ? "corrupt" : bytes, {
            headers: { "content-type": "application/octet-stream" },
        });
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
}
it("keeps only the current and previous release across A to B to C and a rollback", async () => {
    const a = release({ "assets/a.js": "a", "ort/a.wasm": "wa", "index.html": "a-shell" });
    const b = release({ "assets/b.js": "b", "models/b.onnx": "mb", "index.html": "b-shell" });
    serve(a);
    expect(await retainDeploymentAssets(b.root, "https://example.test")).toEqual({
        copied: 2,
        hasPreviousManifest: true,
    });
    expect(readFileSync(join(b.root, "index.html"), "utf8")).toBe("b-shell");
    expect(JSON.parse(readFileSync(join(b.root, "deployment-assets.json"), "utf8"))).toEqual({
        ...b.manifest,
        retainedFiles: a.manifest.files,
        publication: "complete",
    });
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

it("protects both generations of an interrupted publication and bounds the next complete release", async () => {
    const a = release({ "assets/a.js": "a" });
    const b = release({ "assets/b.js": "b" });
    serve(a);
    await retainDeploymentAssets(b.root, "https://example.test");
    const interrupted = JSON.parse(readFileSync(join(b.root, "deployment-assets.json"), "utf8"));
    interrupted.publication = "publishing";
    writeFileSync(join(b.root, "deployment-assets.json"), JSON.stringify(interrupted));

    const c = release({ "assets/c.js": "c" });
    serve(b);
    expect(await retainDeploymentAssets(c.root, "https://example.test")).toEqual({
        copied: 2,
        hasPreviousManifest: true,
    });
    expect(readFileSync(join(c.root, "assets/a.js"), "utf8")).toBe("a");
    expect(readFileSync(join(c.root, "assets/b.js"), "utf8")).toBe("b");
    expect(JSON.parse(readFileSync(join(c.root, "deployment-assets.json"), "utf8")).publication).toBe("complete");

    const d = release({ "assets/d.js": "d" });
    serve(c);
    await retainDeploymentAssets(d.root, "https://example.test");
    expect(readFileSync(join(d.root, "assets/c.js"), "utf8")).toBe("c");
    expect(() => readFileSync(join(d.root, "assets/a.js"))).toThrow();
    expect(() => readFileSync(join(d.root, "assets/b.js"))).toThrow();
});

it("rejects incomplete publication metadata and overlapping inventories", () => {
    const { manifest } = release({ "assets/a.js": "a" });
    expect(() => parseDeploymentAssets({ ...manifest, publication: "unknown" })).toThrow("publication state");
    expect(() => parseDeploymentAssets({ ...manifest, publication: "publishing" })).toThrow("retained asset inventory");
    expect(() => parseDeploymentAssets({ ...manifest, retainedFiles: manifest.files })).toThrow("overlaps");
    expect(() =>
        parseDeploymentAssets({
            schema: 1,
            files: [],
            retainedFiles: manifest.files,
            publicAssetUrls: ["/assets/a.js"],
        }),
    ).toThrow("public asset declared immutable");
});

it("keeps the predecessor when the completed generation is retried with reordered metadata", async () => {
    const a = release({ "assets/a.js": "a" });
    const b = release({ "assets/b.js": "b", "models/b.onnx": "model-b" });
    serve(a);
    await retainDeploymentAssets(b.root, "https://example.test");
    const retry = release({ "assets/b.js": "b", "models/b.onnx": "model-b" });
    retry.manifest.files.reverse();
    writeFileSync(join(retry.root, "deployment-assets.json"), JSON.stringify(retry.manifest));
    serve(b);
    expect(await retainDeploymentAssets(retry.root, "https://example.test")).toEqual({
        copied: 1,
        hasPreviousManifest: true,
    });
    expect(readFileSync(join(retry.root, "assets/a.js"), "utf8")).toBe("a");
    expect(JSON.parse(readFileSync(join(retry.root, "deployment-assets.json"), "utf8")).retainedFiles).toEqual(
        a.manifest.files,
    );
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

it("reports that no previous assets can be retained when a published manifest is missing", async () => {
    const current = release({ "assets/current.js": "current" });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 404 })),
    );
    expect(await retainDeploymentAssets(current.root, "https://example.test")).toEqual({
        copied: 0,
        hasPreviousManifest: false,
    });
    expect(readFileSync(join(current.root, "assets/current.js"), "utf8")).toBe("current");
});

it("retains bundled images and sprite notices without source maps or HTML", () => {
    const current = release(
        {
            "assets/car.webp": "image",
            "assets/credits/library.svg": "unversioned logo",
            "assets/viewer-hash.js": "code",
            "assets/viewer-hash.js.map": "source map",
            "assets/page.html": "shell",
            "styles/hash/sprite/NOTICE.txt": "sprite notice",
        },
        ["/assets/credits/library.svg"],
    );
    expect(current.manifest.files.map((file) => file.url)).toEqual([
        "/assets/car.webp",
        "/assets/viewer-hash.js",
        "/styles/hash/sprite/NOTICE.txt",
    ]);
});

it("collects emitted names without guessing hashes in public filenames", () => {
    const current = release(
        {
            "assets/car.webp": "bundled media",
            "assets/mark-maskable.svg": "public icon",
            "assets/logo-ads-1200.png": "public banner",
        },
        ["/assets/mark-maskable.svg", "/assets/logo-ads-1200.png"],
    );
    expect(current.manifest.files.map((file) => file.url)).toEqual(["/assets/car.webp"]);
});

it("updates stable public files misclassified by an older manifest", async () => {
    const previous = release({ "assets/old.js": "old", "assets/mark-maskable.svg": "old icon" });
    delete previous.manifest.publicAssetUrls;
    writeFileSync(join(previous.root, "deployment-assets.json"), JSON.stringify(previous.manifest));
    const current = release({ "assets/new.js": "new", "assets/mark-maskable.svg": "new icon" }, [
        "/assets/mark-maskable.svg",
    ]);
    const fetch = serve(previous);
    expect(await retainDeploymentAssets(current.root, "https://example.test")).toEqual({
        copied: 1,
        hasPreviousManifest: true,
    });
    expect(readFileSync(join(current.root, "assets/mark-maskable.svg"), "utf8")).toBe("new icon");
    expect(fetch.mock.calls.some(([url]) => url.pathname === "/assets/mark-maskable.svg")).toBe(false);
});

it("retries transient metadata errors before retaining assets", async () => {
    vi.useFakeTimers();
    const previous = release({ "assets/old.js": "old" });
    const current = release({ "assets/new.js": "new" });
    const fetch = serve(previous);
    fetch.mockRejectedValueOnce(new TypeError("network unavailable"));
    fetch.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    const pending = retainDeploymentAssets(current.root, "https://example.test");
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ copied: 1, hasPreviousManifest: true });
    expect(fetch.mock.calls.filter(([url]) => url.pathname === "/deployment-assets.json")).toHaveLength(3);
});

it("retries an interrupted asset body", async () => {
    vi.useFakeTimers();
    const previous = release({ "assets/old.js": "old" });
    const current = release({ "assets/new.js": "new" });
    const fetch = serve(previous);
    const implementation = fetch.getMockImplementation()!;
    let interrupted = false;
    fetch.mockImplementation(async (url) => {
        if (url.pathname === "/assets/old.js" && !interrupted) {
            interrupted = true;
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.error(new TypeError("reset"));
                    },
                }),
            );
        }
        return implementation(url);
    });
    const pending = retainDeploymentAssets(current.root, "https://example.test");
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ copied: 1, hasPreviousManifest: true });
    expect(fetch.mock.calls.filter(([url]) => url.pathname === "/assets/old.js")).toHaveLength(2);
});

it("stops retrying after three transient errors without changing the artifact", async () => {
    vi.useFakeTimers();
    const current = release({ "assets/current.js": "current" });
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const original = readFileSync(join(current.root, "deployment-assets.json"), "utf8");
    const pending = expect(retainDeploymentAssets(current.root, "https://example.test")).rejects.toThrow("503");
    await vi.runAllTimersAsync();
    await pending;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(readFileSync(join(current.root, "deployment-assets.json"), "utf8")).toBe(original);
});

it("does not retry permanent HTTP errors or corrupt assets", async () => {
    const previous = release({ "assets/old.js": "old" });
    const current = release({ "assets/new.js": "new" });
    const fetch = serve(previous);
    fetch.mockImplementationOnce(async () => new Response(null, { status: 403 }));
    await expect(retainDeploymentAssets(current.root, "https://example.test")).rejects.toThrow("403");
    expect(fetch).toHaveBeenCalledTimes(1);
    const corrupt = serve(previous, true);
    await expect(retainDeploymentAssets(current.root, "https://example.test")).rejects.toThrow("integrity mismatch");
    expect(corrupt.mock.calls.filter(([url]) => url.pathname === "/assets/old.js")).toHaveLength(1);
});

it("requires current metadata when reusing an old recovery artifact", async () => {
    const old = release({ "assets/old.js": "old" });
    delete old.manifest.publicAssetUrls;
    writeFileSync(join(old.root, "deployment-assets.json"), JSON.stringify(old.manifest));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(retainDeploymentAssets(old.root, "https://example.test")).rejects.toThrow("rebuild recovery artifact");
    expect(fetch).not.toHaveBeenCalled();
});

it("preserves a recovery artifact when a later asset fails validation", async () => {
    const old = release({ "assets/carried.js": "carried" });
    const current = release({ "assets/current.js": "current" });
    serve(old);
    await retainDeploymentAssets(current.root, "https://example.test");
    const original = readFileSync(join(current.root, "deployment-assets.json"), "utf8");
    const previous = release({ "assets/a.js": "first", "assets/z.js": "last" });
    const fetch = serve(previous);
    const implementation = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url) =>
        url.pathname === "/assets/z.js" ? new Response("corrupt") : implementation(url),
    );
    await expect(retainDeploymentAssets(current.root, "https://example.test")).rejects.toThrow("integrity mismatch");
    expect(readFileSync(join(current.root, "assets/carried.js"), "utf8")).toBe("carried");
    expect(() => readFileSync(join(current.root, "assets/a.js"))).toThrow();
    expect(readFileSync(join(current.root, "deployment-assets.json"), "utf8")).toBe(original);
});

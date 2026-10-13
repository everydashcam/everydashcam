// Real service-worker cache and network failures are part of these assertions.
// Use the same explicit offline routing as offline.spec.ts so controlled fetches
// can reach Cache Storage while every network request is blocked.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { rolldown } from "rolldown";
import { computeTrackerAssets } from "../../vite-plugins/tracker-assets.js";
import { presetLocalStorage, REPO_ROOT } from "./_fixtures.js";

const assets = computeTrackerAssets("build").app;
const runtime = assets.ort.webgpu;
const harnessUrl = "/assets/ort-test-harness.js";
const bundleUrl = runtime.moduleUrl.replace(/[^/]+$/, "ort.webgpu.min.mjs");
let harness: string;

test.use({ serviceWorkers: "allow" });

test.beforeAll(async () => {
    const bundle = await rolldown({
        input: resolve(REPO_ROOT, "tests/helpers/ort-harness.ts"),
        platform: "browser",
        resolve: { extensionAlias: { ".js": [".ts", ".js"] } },
        plugins: [
            {
                name: "ort-test-runtime",
                resolveId(source) {
                    if (source.startsWith("onnxruntime-web/")) return { id: bundleUrl, external: true };
                },
            },
        ],
    });
    try {
        const output = await bundle.generate({ format: "es", codeSplitting: false });
        const chunk = output.output.find((entry) => entry.type === "chunk");
        if (!chunk) throw new Error("ort harness bundle missing");
        harness = chunk.code;
    } finally {
        await bundle.close();
    }
});

async function runInference(page: Page) {
    return page.evaluate(
        async ({ harnessUrl, runtime, modelUrl }) => {
            const worker = new Worker(harnessUrl, { type: "module" });
            try {
                return await new Promise<{
                    ok: boolean;
                    error?: string;
                    outputs?: Record<string, { dims: number[]; finite: boolean }>;
                    reusedOutputs?: Record<string, { dims: number[]; finite: boolean }>;
                    binaryReleased?: boolean;
                    loadedBinaryBytes?: number;
                    retainedBinaryBytes?: number;
                }>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("ort inference timeout")), 30_000);
                    worker.onmessage = (event) => {
                        clearTimeout(timer);
                        resolve(event.data);
                    };
                    worker.onerror = (event) => {
                        clearTimeout(timer);
                        reject(new Error(event.message));
                    };
                    worker.postMessage({ assets: runtime, modelUrl });
                });
            } finally {
                worker.terminate();
            }
        },
        { harnessUrl, runtime, modelUrl: new URL(assets.models.tracker, "http://localhost:4173").href },
    );
}

test("split asyncify WASM runs real inference offline and repairs incomplete or corrupt caches", {
    tag: ["@golden-blur", "@golden-offline"],
}, async ({ page, context }) => {
    test.setTimeout(120_000);
    if (!("parts" in runtime.wasm)) throw new Error("this regression requires a split runtime");
    const parts = runtime.wasm.parts;
    expect(parts.length).toBeGreaterThan(1);
    await presetLocalStorage(page, { lang: "en" });
    await context.route(/^https?:\/\//, async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== "http://localhost:4173") return route.abort();
        if (url.pathname === harnessUrl) return route.fulfill({ contentType: "text/javascript", body: harness });
        if (url.pathname === bundleUrl)
            return route.fulfill({
                contentType: "text/javascript",
                body: readFileSync(resolve(REPO_ROOT, "node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs")),
            });
        return route.continue();
    });
    await page.goto("/en/");
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    // Match the production consent gate: it warms the module and every piece
    // from the controlled main thread before starting an inference worker.
    await page.evaluate(
        async (urls) => Promise.all(urls.map(async (url) => (await fetch(url)).arrayBuffer())),
        [...parts.map((part) => part.url), runtime.moduleUrl, assets.models.tracker],
    );
    const online = await runInference(page);
    expect(online.ok, online.error).toBe(true);
    expect(online.binaryReleased).toBe(true);
    expect(online.loadedBinaryBytes, "the runtime is assembled only once for both sessions").toBe(runtime.wasm.bytes);
    expect(online.retainedBinaryBytes, "Emscripten's retained views must no longer hold the source binary").toBe(0);
    expect(Object.keys(online.outputs!)).toEqual(["output1", "output2", "output3"]);
    expect(Object.values(online.outputs!).every((output) => output.finite)).toBe(true);
    expect(online.reusedOutputs, "a new session can infer after the source binary is released").toEqual(online.outputs);
    await expect
        .poll(() =>
            page.evaluate(
                async (urls) => {
                    const cache = await caches.open("everydashcam-tracker-v3");
                    return Promise.all(urls.map(async (url) => !!(await cache.match(url))));
                },
                parts.map((part) => part.url),
            ),
        )
        .toEqual(parts.map(() => true));

    const cachedUrls = [harnessUrl, bundleUrl, runtime.moduleUrl, assets.models.tracker];
    await expect
        .poll(() =>
            page.evaluate(
                async (urls) => Promise.all(urls.map(async (url) => !!(await caches.match(url, { ignoreVary: true })))),
                cachedUrls,
            ),
        )
        .toEqual(cachedUrls.map(() => true));

    const blocked: string[] = [];
    const blockNetwork = (route: import("@playwright/test").Route) => {
        blocked.push(route.request().url());
        return route.abort("internetdisconnected");
    };
    await context.route(/^https?:\/\//, blockNetwork);
    const offline = await runInference(page);
    expect(offline, `a fresh worker uses cached bytes; network misses: ${blocked.join(", ")}`).toEqual(online);

    await page.evaluate(async (url) => (await caches.open("everydashcam-tracker-v3")).delete(url), parts[1]!.url);
    const missing = await runInference(page);
    expect(missing.ok, "partial cache must never count as a usable runtime").toBe(false);
    await context.unroute(/^https?:\/\//, blockNetwork);
    expect(await runInference(page), "reconnection repairs the missing piece").toEqual(online);

    await page.evaluate(async (url) => {
        const cache = await caches.open("everydashcam-tracker-v3");
        await cache.put(
            url,
            new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/octet-stream" } }),
        );
    }, parts[0]!.url);
    expect(await runInference(page), "checksum failure bypasses and repairs the poisoned cache").toEqual(online);
    await expect
        .poll(() =>
            page.evaluate(async (url) => {
                const cached = await (await caches.open("everydashcam-tracker-v3")).match(url);
                return cached ? (await cached.arrayBuffer()).byteLength : 0;
            }, parts[0]!.url),
        )
        .toBe(parts[0]!.bytes);
    await context.route(/^https?:\/\//, blockNetwork);
    expect(await runInference(page), "the repaired bytes remain usable offline").toEqual(online);
});

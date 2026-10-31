import { computeTrackerAssets } from "../../vite-plugins/tracker-assets.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let origin: string;
test.use({ serviceWorkers: "allow" });
test.beforeAll(async () => {
    server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false }, logLevel: "error" });
    await server.listen();
    origin = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
});
test.afterAll(async () => {
    await server?.close();
});

test("retires an installed dev worker before loading the app without clearing preferences", async ({
    page,
    context,
}) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
        addEventListener("dc:ready", () => {
            document.documentElement.dataset.testAppReady = "true";
        });
    });
    const installedWorker = async (route: import("@playwright/test").Route) =>
        route.fulfill({ contentType: "text/javascript", body: readFileSync(resolve("public/sw.js")) });
    await context.route(`${origin}/sw.js`, installedWorker);
    await page.route(`${origin}/setup`, (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><title>setup</title>" }),
    );
    await page.goto(`${origin}/setup`);
    await page.evaluate(async () => {
        await navigator.serviceWorker.register("/sw.js");
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.evaluate(async () => {
        localStorage.setItem("everydashcam:lang", "en");
        localStorage.setItem("preserve-dev-preference", "selected");
        const cache = await caches.open("everydashcam-runtime-v3");
        await cache.put(
            "/src/app.ts",
            new Response('throw new Error("stale dev module executed")', {
                headers: { "content-type": "text/javascript" },
            }),
        );
    });
    await context.unroute(`${origin}/sw.js`, installedWorker);
    await page.goto(`${origin}/`);
    // The input exists in static HTML, including the page about to reload.
    // Runtime readiness proves migration and the final app import have finished.
    await expect(page.locator("html")).toHaveAttribute("data-test-app-ready", "true");
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("preserve-dev-preference"))).toBe("selected");
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    expect(errors).toEqual([]);
});

test("runs verified ONNX inference directly through the development server", async ({ page }) => {
    test.setTimeout(120_000);
    const assets = computeTrackerAssets("serve").app;
    await page.goto(`${origin}/`);
    const result = await page.evaluate(async (assets) => {
        const worker = new Worker("/tests/helpers/ort-harness.ts", { type: "module" });
        try {
            return await new Promise<{
                ok: boolean;
                error?: string;
                binaryReleased?: boolean;
                outputs?: Record<string, { finite: boolean }>;
            }>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("dev inference timed out")), 60_000);
                worker.onmessage = (event) => {
                    clearTimeout(timer);
                    resolve(event.data);
                };
                worker.onerror = (event) => {
                    clearTimeout(timer);
                    reject(new Error(event.message));
                };
                worker.postMessage({ assets: assets.ort.webgpu, modelUrl: assets.models.tracker.url });
            });
        } finally {
            worker.terminate();
        }
    }, assets);
    expect(result.ok, result.error).toBe(true);
    expect(result.binaryReleased).toBe(true);
    expect(Object.values(result.outputs!).every((output) => output.finite)).toBe(true);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
});

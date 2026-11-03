// Exercise real ORT thread pools through WASM Follow and WebGPU detection.
// A child blocked by COEP or silently stalled before initialization must
// recover once on a fresh single-threaded tracker worker.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import type { Locator, Page } from "@playwright/test";

import type reliabilityFixture from "../testdata/tracker-reliability/reliability.json";
import {
    DESKTOP,
    expect,
    gotoApp,
    hasWebGpuAdapter,
    loadTrip,
    openExport,
    pausePlayback,
    presetLocalStorage,
    REPO_ROOT,
    test as base,
} from "./_fixtures.js";

const reliability = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "tests/testdata/tracker-reliability/reliability.json"), "utf8"),
) as typeof reliabilityFixture;

type ThreadStartup = "healthy" | "blocked" | "hung";
type OrtRuntime = "wasm" | "webgpu";

const contentTypes: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
};

const test = base.extend<{ threadStartup: ThreadStartup; ortRuntime: OrtRuntime }>({
    threadStartup: ["healthy", { option: true }],
    ortRuntime: ["wasm", { option: true }],
    baseURL: async ({ threadStartup, ortRuntime }, use) => {
        const dist = resolve(REPO_ROOT, "dist");
        const runtimeChunk =
            ortRuntime === "wasm"
                ? /\/assets\/ort\.wasm\.bundle\.min-[^/]+\.js$/
                : /\/assets\/ort\.webgpu\.bundle\.min-[^/]+\.js$/;
        // Nested pthread initial loads bypass Playwright routing. Serve the
        // actual build with headers that reach every generation of workers.
        const server = createServer((request, response) => {
            response.setHeader("cache-control", "no-store");
            response.setHeader("cross-origin-opener-policy", "same-origin");
            response.setHeader("cross-origin-embedder-policy", "require-corp");
            try {
                const pathname = decodeURIComponent(new URL(request.url!, "http://localhost").pathname);
                const relative = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
                const filename = resolve(dist, `.${relative}`);
                if (!filename.startsWith(`${dist}${sep}`)) throw new Error("path outside dist");
                let body: Buffer | string = readFileSync(filename);
                if (runtimeChunk.test(pathname)) {
                    if (threadStartup === "blocked") response.removeHeader("cross-origin-embedder-policy");
                    if (threadStartup === "hung") {
                        // The tracker imports normally; only its actual child
                        // waits forever, leaving ORT's startup timer to recover.
                        body = `if (globalThis.name?.startsWith("em-pthread")) await new Promise(() => {});\n${body.toString()}`;
                    }
                }
                response.setHeader("content-type", contentTypes[extname(relative)] ?? "application/octet-stream");
                response.end(body);
            } catch {
                response.writeHead(404, { "content-type": "text/plain" });
                response.end("missing");
            }
        });
        await new Promise<void>((done, reject) => {
            server.once("error", reject);
            server.listen(0, "localhost", done);
        });
        try {
            await use(`http://localhost:${(server.address() as AddressInfo).port}`);
        } finally {
            await new Promise<void>((done) => {
                server.close(() => done());
                server.closeAllConnections();
            });
        }
    },
});

test.use({ serviceWorkers: "block" });

function observeTrackerWorkers(page: Page): string[] {
    const workers: string[] = [];
    page.on("worker", (worker) => {
        if (/\/assets\/tracker-worker-[^/]+\.js$/.test(worker.url())) workers.push(worker.url());
    });
    return workers;
}

async function openIsolatedApp(page: Page): Promise<void> {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page, "en");
    expect(await page.evaluate(() => self.crossOriginIsolated), "the page can use threads").toBe(true);
    expect(
        await page.evaluate(() => navigator.hardwareConcurrency),
        "the runner can start an ORT thread pool",
    ).toBeGreaterThan(3);
}

async function readFallbackLogs(page: Page) {
    return page.evaluate(() =>
        window.__everydashcam
            .dumpLog()
            .filter(
                (record) => (record as { msg?: string }).msg === "tracker threads failed to start; using one thread",
            ),
    );
}

async function startFollow(page: Page): Promise<Locator> {
    const scenario = reliability.scenarios.find((item) => item.id === "smooth-occlusion")!;
    const target = scenario.frames[0]!.targetRect;
    await openIsolatedApp(page);
    await page
        .locator("#file-input")
        .setInputFiles(resolve(REPO_ROOT, "tests/testdata/tracker-reliability", scenario.name));
    const trip = page.locator("li.trip:not(.unindexed-note)");
    await expect(trip).toHaveCount(1);
    await trip.click();
    await pausePlayback(page);
    await page.evaluate(async () => {
        const video = window.__everydashcam.dom.player;
        const shown = new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve()));
        video.currentTime = 0;
        await shown;
    });
    await openExport(page);
    await page.locator(".export-panel__blur-add-btn").click();
    const layer = page.locator('.video-tile[data-channel="front"] .blur-draw-layer');
    await expect(layer).toBeVisible();
    const bounds = (await layer.boundingBox())!;
    await page.mouse.move(bounds.x + target.xPct * bounds.width, bounds.y + target.yPct * bounds.height);
    await page.mouse.down();
    await page.mouse.move(
        bounds.x + (target.xPct + target.wPct) * bounds.width,
        bounds.y + (target.yPct + target.hPct) * bounds.height,
        { steps: 6 },
    );
    await page.mouse.up();

    const follow = page.locator(".export-panel__blur-follow-btn");
    await follow.click();
    await page.locator(".export-panel__blur-tracker").getByRole("button", { name: "Download & follow" }).click();
    return follow;
}

for (const { startup, title } of [
    { startup: "healthy", title: "Follow keeps a healthy thread pool without falling back" },
    { startup: "blocked", title: "Follow falls back to one thread when the thread pool cannot start" },
    { startup: "hung", title: "Follow falls back to one thread when a thread silently stalls" },
] as const) {
    test.describe(startup, () => {
        test.use({ threadStartup: startup, ortRuntime: "wasm" });
        test(title, async ({ page, browserName }) => {
            test.skip(browserName !== "chromium", "thread-pool regression coverage uses Chromium here");
            test.setTimeout(180_000);
            const workers = observeTrackerWorkers(page);
            const follow = await startFollow(page);
            // A recovered pass must reach the same result as a healthy thread pool.
            await expect(page.locator(".export-panel__blur-row-state.is-warn")).toHaveText("Check the ending", {
                timeout: 120_000,
            });
            await expect(follow).toHaveAttribute("aria-pressed", "true");
            const fallbackLogs = await readFallbackLogs(page);
            expect(workers, "only a failed pool replaces the tracker worker").toHaveLength(
                startup === "healthy" ? 1 : 2,
            );
            expect(fallbackLogs, "a failed pool falls back exactly once").toHaveLength(startup === "healthy" ? 0 : 1);
            if (startup === "blocked") {
                expect(
                    fallbackLogs[0],
                    "the child error reaches the startup guard before the ORT timeout",
                ).toMatchObject({
                    ctx: { err: "ort thread failed to start" },
                });
            }
            if (startup === "hung") {
                expect(
                    fallbackLogs[0],
                    "a silent child is recovered through the runtime startup timeout",
                ).toMatchObject({
                    ctx: { err: expect.stringContaining("initializing failed due to timeout") },
                });
            }
        });
    });
}

test.describe("WebGPU runtime", () => {
    test.use({ threadStartup: "blocked", ortRuntime: "webgpu" });
    test("WebGPU plate detection falls back to one thread when the asyncify thread pool cannot start", async ({
        page,
        browserName,
    }) => {
        test.skip(browserName !== "chromium", "thread-pool regression coverage uses Chromium here");
        test.setTimeout(180_000);
        const workers = observeTrackerWorkers(page);
        await openIsolatedApp(page);
        test.skip(!(await hasWebGpuAdapter(page)), "WebGPU adapter unavailable - detection is WebGPU-only");
        await loadTrip(page);
        await pausePlayback(page);
        await openExport(page);
        const plates = page.locator("#export-panel-blur-plates");
        await plates.check();
        const strip = page.locator(".export-panel__blur-detect-strip");
        await strip.getByRole("button", { name: "Download & scan" }).click();
        // The public synthetic trip contains no plates. Reaching its empty result
        // proves the replacement worker really ran the WebGPU detection pass.
        await expect(page.locator(".export-panel__blur-detect-status")).toHaveText("Sections with plates: 0", {
            timeout: 120_000,
        });
        await expect(strip).toBeHidden();
        await expect(plates).toBeChecked();
        expect(workers, "the failed asyncify pool replaces the tracker worker exactly once").toHaveLength(2);
        expect(await readFallbackLogs(page), "the asyncify child error reaches the startup guard").toMatchObject([
            { ctx: { err: "ort thread failed to start" } },
        ]);
    });
});

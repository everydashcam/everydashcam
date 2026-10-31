// Follow on a cross-origin isolated page whose ORT threads cannot start. Each
// thread is a module worker of the runtime chunk, and an isolated worker
// refuses a nested worker script without COEP, so serving that one chunk
// without COEP blocks every thread while the runtime itself still imports.
// ORT then never finishes starting; the pass must fall back to one thread on
// a fresh worker instead of hanging until the inactivity timeout.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type reliabilityFixture from "../testdata/tracker-reliability/reliability.json";
import {
    DESKTOP,
    expect,
    gotoApp,
    openExport,
    pausePlayback,
    presetLocalStorage,
    REPO_ROOT,
    test,
} from "./_fixtures.js";

const reliability = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "tests/testdata/tracker-reliability/reliability.json"), "utf8"),
) as typeof reliabilityFixture;

test.use({ serviceWorkers: "block" });

test("Follow falls back to one thread when the thread pool cannot start", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "isolation through routed headers is Chromium-specific here");
    test.setTimeout(180_000);
    const runtimeChunk = /\/assets\/ort\.wasm\.bundle\.min-[^/]+\.js$/;
    await page.route(
        (url) => url.origin === "http://localhost:4173",
        async (route) => {
            const response = await route.fetch();
            const headers: Record<string, string> = {
                ...response.headers(),
                "cross-origin-opener-policy": "same-origin",
            };
            if (!runtimeChunk.test(route.request().url())) headers["cross-origin-embedder-policy"] = "require-corp";
            await route.fulfill({ response, headers });
        },
    );

    const scenario = reliability.scenarios.find((item) => item.id === "smooth-occlusion")!;
    const target = scenario.frames[0]!.targetRect;
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page, "en");
    expect(await page.evaluate(() => self.crossOriginIsolated), "the page can use threads").toBe(true);
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
    // The same outcome as the multithreaded pass on this scenario, reached
    // after the thread pool's start budget ran out.
    await expect(page.locator(".export-panel__blur-row-state.is-warn")).toHaveText("Check the ending", {
        timeout: 120_000,
    });
    await expect(follow).toHaveAttribute("aria-pressed", "true");
    expect(
        await page.evaluate(() =>
            window.__everydashcam
                .dumpLog()
                .some(
                    (record) =>
                        (record as { msg?: string }).msg === "tracker threads failed to start; using one thread",
                ),
        ),
        "the first worker tried threads and the retry ran on one",
    ).toBe(true);
});

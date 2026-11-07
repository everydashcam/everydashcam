import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { pausePlayback, presetLocalStorage } from "../e2e/_fixtures.js";
import { openPortable, test } from "./_fixtures.js";

test("plays and seeks a preallocated TS recording with GPS from a file URL", async ({ page }, info) => {
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("ts-trailer"));
    const fixture = readFileSync(resolve("src/parsers/__fixtures__/ligogps-trailer-ts/real-anonymized-paired.TS"));
    await page.locator("#file-input").setInputFiles({
        name: "20261008_095348_f.ts",
        mimeType: "video/mp2t",
        buffer: Buffer.concat([fixture, Buffer.alloc(40 * 1024 * 1024)]),
    });
    const trip = page.locator("li.trip:not(.unindexed-note)");
    await expect(trip).toHaveCount(1);
    await trip.click();
    await expect(page.locator("#trip-analysis-status")).toBeHidden();
    await expect(page.locator(".player-no-gps")).toBeHidden();
    await expect(page.locator("#player-chart-canvas")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.trips[0]!.records.length)).toBe(60);
    const video = page.locator(".video-tile.active video:not(.preload-slot)");
    await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
        .toBeGreaterThanOrEqual(2);
    await pausePlayback(page);
    await page.locator("#player-mini-progress").focus();
    await page.keyboard.press("Home");
    await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => !element.seeking && element.currentTime < 0.1))
        .toBe(true);
    await page.locator("#player-play").click();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.2);
});

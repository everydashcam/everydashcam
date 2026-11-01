import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DESKTOP, REPO_ROOT, expect, gotoApp, pausePlayback, presetLocalStorage, test } from "./_fixtures.js";

test.describe("TS trailer recording ingest", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
    });

    for (const [dialect, stamp, suffix] of [
        ["count", "20260904_202849", ""],
        ["count", "20260904_235813", "_SOS"],
        ["empty", "20260902_174435", "_PARK"],
        ["empty-capacity", "20260904_205125", ""],
        ["unknown-suffix", "20260904_205125", ""],
        ["paired", "20261008_095348_", ""],
    ]) {
        test(`indexes and plays both channels with ${dialect} trailing bytes in ${stamp}${suffix}`, async ({
            page,
        }) => {
            const fixture = readFileSync(
                path.join(
                    REPO_ROOT,
                    `src/parsers/__fixtures__/ligogps-trailer-ts/real-anonymized-${dialect === "unknown-suffix" ? "empty-capacity" : dialect}.TS`,
                ),
            );
            const buffer =
                dialect === "unknown-suffix"
                    ? Buffer.concat([fixture.subarray(0, -36), Buffer.alloc(1000, 0xa5)])
                    : dialect === "paired"
                      ? Buffer.concat([fixture, Buffer.alloc(40 * 1024 * 1024)])
                      : fixture;
            const files = ["F", "R"].map((channel) => ({
                name: `${stamp}${channel}${suffix}.ts`,
                mimeType: "video/mp2t",
                buffer,
            }));
            // Playwright limits the combined in-memory upload to 50 MB.
            const inputs =
                dialect === "paired"
                    ? files.map(({ name, buffer }) => {
                          const target = test.info().outputPath("inputs", name);
                          mkdirSync(path.dirname(target), { recursive: true });
                          writeFileSync(target, buffer);
                          return target;
                      })
                    : files;
            await page.locator("#file-input").setInputFiles(inputs);
            const trips = page.locator("li.trip:not(.unindexed-note)");
            await expect(trips).toHaveCount(1);
            await expect(page.locator('[data-trip-filter-kind="unknown"]')).toHaveCount(0);
            if (suffix === "_SOS") {
                await page.locator("#trip-filter-toggle").click();
                await page.locator('[data-trip-filter-toggle="event"]').click();
                await expect(trips).toHaveCount(1);
                await expect(page.locator('[data-trip-filter-kind="normal"]')).toBeHidden();
                await page.locator("#trip-filter-reset").click();
                await expect(trips).toHaveCount(1);
            }
            await trips.first().click();
            for (const channel of ["front", "rear"]) {
                await expect(page.locator(`#video-grid .video-tile[data-channel="${channel}"]`)).toBeVisible();
            }
            await expect
                .poll(() =>
                    page.evaluate(() => {
                        const state = window.__everydashcam.state;
                        return state.trips[state.active!.trip]!.records.length;
                    }),
                )
                .toBe(dialect === "empty" || dialect === "empty-capacity" || dialect === "unknown-suffix" ? 0 : 60);
            await expect
                .poll(() =>
                    page
                        .locator("#video-grid .video-tile:not([hidden]) > video:not(.preload-slot):not(.tile-blur-bg)")
                        .evaluateAll(
                            (videos: HTMLVideoElement[]) =>
                                videos.length === 2 && videos.every((video) => video.readyState >= 2),
                        ),
                )
                .toBe(true);
            await pausePlayback(page);
            await page.locator("#player-mini-progress").focus();
            await page.keyboard.press("Home");
            await expect
                .poll(() =>
                    page
                        .locator(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)")
                        .evaluate(
                            (video: HTMLVideoElement) =>
                                !video.seeking && video.readyState >= 2 && video.currentTime < 0.1,
                        ),
                )
                .toBe(true);
            await page.locator("#player-play").click();
            await expect
                .poll(() =>
                    page
                        .locator("#video-grid .video-tile:not([hidden]) > video:not(.preload-slot):not(.tile-blur-bg)")
                        .evaluateAll(
                            (videos: HTMLVideoElement[]) =>
                                videos.length === 2 &&
                                videos.every((video) => video.readyState >= 2 && video.currentTime > 0.2),
                        ),
                )
                .toBe(true);
        });
    }
});

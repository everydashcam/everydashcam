import { readFileSync } from "node:fs";
import path from "node:path";
import { DESKTOP, REPO_ROOT, expect, gotoApp, presetLocalStorage, test } from "./_fixtures.js";

test("opens INNOVV N2 front and rear together with GPS", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page, "en");
    await page.locator("#file-input").setInputFiles(
        ["F", "R"].map((channel) => ({
            name: `20260926_132423_${channel}.ts`,
            mimeType: "video/mp2t",
            buffer: readFileSync(
                path.join(REPO_ROOT, `src/parsers/__fixtures__/viidure-ts/20260926_132423_${channel}.TS`),
            ),
        })),
    );
    const trips = page.locator("li.trip:not(.unindexed-note)");
    await expect(trips).toHaveCount(1);
    await trips.first().click();
    for (const channel of ["front", "rear"]) {
        await expect(page.locator(`#video-grid .video-tile[data-channel="${channel}"]`)).toBeVisible();
    }
    await expect
        .poll(() =>
            page.evaluate(() => {
                const state = window.__everydashcam.state;
                const records = state.trips[state.active!.trip]!.records;
                return (
                    records.length > 0 &&
                    records.every(
                        (r) =>
                            r.lat === 52 && r.lon === -1 && r.unixSeconds >= Date.UTC(2026, 8, 26, 12, 24, 23) / 1000,
                    )
                );
            }),
        )
        .toBe(true);
    await expect
        .poll(() =>
            page
                .locator("#video-grid .video-tile:not([hidden]) > video:not(.preload-slot)")
                .evaluateAll(
                    (videos: HTMLVideoElement[]) =>
                        videos.length === 2 && videos.every((video) => video.readyState >= 2),
                ),
        )
        .toBe(true);
});

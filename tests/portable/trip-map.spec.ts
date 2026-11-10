import { type Page, expect } from "@playwright/test";

import { presetLocalStorage } from "../e2e/_fixtures.js";
import { EAST_ROAD, NORTH_ROAD, removeTripLibraries, writeTripLibrary } from "../e2e/_trip-library.js";
import { isPortableMapRequest, openPortable, test } from "./_fixtures.js";

test.afterAll(removeTripLibraries);

/** The map of all trips draws its routes on a style without remote sources. */
async function expectLocalTripRoutes(page: Page): Promise<void> {
    await expect
        .poll(() =>
            page.evaluate(() => {
                const map = window.__everydashcam.state.tripMap;
                if (!map?.isStyleLoaded() || !map.getLayer("trip-map-lines-core")) return false;
                return (
                    map.queryRenderedFeatures({ layers: ["trip-map-lines-core"] }).length > 0 &&
                    Object.values(map.getStyle().sources).every((source) => source.type === "geojson")
                );
            }),
        )
        .toBe(true);
}

test("draws the map of all trips from local routes when every provider fails", async ({ page, requests }, info) => {
    // No recovery probes during the test: only the map's own loads count.
    await page.clock.install();
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("trip-map"));
    await page
        .locator("#folder-input")
        .setInputFiles(writeTripLibrary({ roads: [EAST_ROAD, NORTH_ROAD], withoutGps: 1 }));
    await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });

    await expect(page.locator("#trip-map-state")).toBeVisible();
    await expectLocalTripRoutes(page);
    await expect(page.locator("#trip-map-counter-text")).toHaveText("2 of 3 on the map");
    await expect.poll(() => requests.filter(isPortableMapRequest).length).toBeGreaterThan(0);
    const attempts = requests.filter(isPortableMapRequest).length;

    // A map shown again keeps the known failure; retries belong to recovery.
    for (let round = 0; round < 2; round++) {
        await page.locator("#trip-map-close").click();
        await expect(page.locator("#trip-map-state")).toBeHidden();
        await page.locator('[data-action="show-trip-map"]').click();
        await expectLocalTripRoutes(page);
    }
    expect(requests.filter(isPortableMapRequest).length).toBe(attempts);
});

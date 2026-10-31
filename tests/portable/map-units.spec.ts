import { expect, loadTrip, pausePlayback, presetLocalStorage } from "../e2e/_fixtures.js";
import { openPortable, test } from "./_fixtures.js";

test("map scale follows saved and changed units on a file origin", async ({ page }, info) => {
    await presetLocalStorage(page, {
        preferences: { "everydashcam:units": "imperial", "everydashcam:mapProvider": "route-only" },
    });
    await openPortable(page, info.outputPath("map-units"));
    await loadTrip(page);
    await pausePlayback(page);
    await page.locator(".mini-map").click();
    const scale = page.locator(".map-wrap .maplibregl-ctrl-scale");
    await expect(scale).toBeVisible();
    await expect(scale).toHaveText(/\b(?:ft|mi)$/);

    await page.locator("#settings-btn").click();
    await page.locator("#settings-units-select").selectOption("metric");
    await page.locator("#settings-modal-close").click();
    await expect(scale).toHaveText(/\b(?:m|km)$/);
});

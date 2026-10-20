import { DESKTOP, gotoApp, presetLocalStorage, test } from "./_fixtures.js";
import { checkLigoGpsTsPes } from "./_ligogps-ts-pes.js";

test.describe("enciphered LigoGPS PES recording", () => {
    test.use({ viewerMap: "route-only" });

    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
    });

    for (const [label, withTxt] of [
        ["the TXT log", true],
        ["the enciphered PES alone", false],
    ] as const) {
        test(`indexes, seeks and plays the recording with GPS from ${label}`, async ({ page }) => {
            await checkLigoGpsTsPes(page, withTxt);
        });
    }
});

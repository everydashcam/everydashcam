import { DESKTOP, gotoApp, presetLocalStorage, test } from "./_fixtures.js";
import { checkClockCorrection } from "./_clock-correction.js";

test.use({ viewport: DESKTOP, viewerMap: "route-only", reducedMotion: "reduce" });

test("clock correction updates the camera clock surfaces while paused", async ({ page }) => {
    await presetLocalStorage(page);
    await gotoApp(page, "en");
    await checkClockCorrection(page);
});

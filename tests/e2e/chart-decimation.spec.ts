import { verifyChartDecimation } from "./_chart-decimation.js";
import { DESKTOP, gotoApp, presetLocalStorage, test } from "./_fixtures.js";

test.use({ viewerMap: "route-only" });

test("dense chart keeps estimated speeds and GPS breaks across zoom and rebuild", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await presetLocalStorage(page);
    await gotoApp(page, "en");
    await verifyChartDecimation(page);
});

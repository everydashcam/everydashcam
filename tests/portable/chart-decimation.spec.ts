import { verifyChartDecimation } from "../e2e/_chart-decimation.js";
import { DESKTOP, presetLocalStorage } from "../e2e/_fixtures.js";
import { openPortable, test } from "./_fixtures.js";

test("dense chart keeps estimated speeds and GPS breaks on a file origin", async ({ page }, info) => {
    await page.setViewportSize(DESKTOP);
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("chart-decimation"));
    await verifyChartDecimation(page);
});

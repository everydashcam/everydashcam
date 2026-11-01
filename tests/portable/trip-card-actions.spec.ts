import { SAMPLE_70MAI, loadTrip, presetLocalStorage } from "../e2e/_fixtures.js";
import { checkCollapsedCompactTripActions, checkTripCardActions } from "../e2e/_trip-card-actions.js";
import { openPortable, test } from "./_fixtures.js";

test("local HTML keeps all trip card actions clickable at their edges", async ({ page }, info) => {
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("card-actions"));
    await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
    await checkTripCardActions(page);
});

test("local HTML keeps compact row actions hidden with the trip list", async ({ page }, info) => {
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("compact-card-actions"));
    await loadTrip(page, SAMPLE_70MAI);
    await checkCollapsedCompactTripActions(page);
});

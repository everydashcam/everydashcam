import { SAMPLE_70MAI, presetLocalStorage } from "../e2e/_fixtures.js";
import { checkTripCardActions } from "../e2e/_trip-card-actions.js";
import { openPortable, test } from "./_fixtures.js";

test("local HTML keeps all trip card actions clickable at their edges", async ({ page }, info) => {
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("card-actions"));
    await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
    await checkTripCardActions(page);
});

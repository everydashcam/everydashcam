import { presetLocalStorage } from "../e2e/_fixtures.js";
import { checkNovatekTsSpeed } from "../e2e/_novatek-ts-speed.js";
import { openPortable, test } from "./_fixtures.js";

test("COMTEC EG-1 keeps km/h when opened from a file URL", async ({ page }, info) => {
    await presetLocalStorage(page);
    await page.addInitScript(() => localStorage.setItem("everydashcam:units", "metric"));
    await openPortable(page, info.outputPath("novatek-ts"));
    await checkNovatekTsSpeed(page);
});

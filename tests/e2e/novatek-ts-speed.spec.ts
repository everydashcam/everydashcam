import { gotoApp, presetLocalStorage, test } from "./_fixtures.js";
import { checkNovatekTsSpeed } from "./_novatek-ts-speed.js";

test.use({ viewerMap: "route-only" });

test("COMTEC EG-1 shows km/h through GPS ingest and the player", async ({ page }) => {
    await presetLocalStorage(page);
    await page.addInitScript(() => localStorage.setItem("everydashcam:units", "metric"));
    await gotoApp(page, "en");
    await checkNovatekTsSpeed(page);
});

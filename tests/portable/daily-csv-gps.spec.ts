import { checkDailyCsvGps, checkPartialDailyCsvGps } from "../e2e/_daily-csv-gps.js";
import { DESKTOP, presetLocalStorage } from "../e2e/_fixtures.js";
import { openPortable, test } from "./_fixtures.js";

test.use({ viewport: DESKTOP, locale: "de-DE", timezoneId: "Europe/Moscow", reducedMotion: "reduce" });

test("file-origin daily DAT logs supply GPS for normal and event recordings", async ({ page }, info) => {
    await presetLocalStorage(page);
    await page.addInitScript(() => {
        window.addEventListener("dc:ready", () => window.__everydashcam.setMapProvider("route-only"), { once: true });
    });
    await openPortable(page, info.outputPath("viewer"));
    await checkDailyCsvGps(page, info.outputPath("card"));
});

for (const selection of ["leaf-folders", "card-fragments"] as const) {
    test(`file-origin daily DAT GPS survives ${selection} selections`, async ({ page }, info) => {
        await presetLocalStorage(page);
        await page.addInitScript(() => {
            window.addEventListener("dc:ready", () => window.__everydashcam.setMapProvider("route-only"), {
                once: true,
            });
        });
        await openPortable(page, info.outputPath("viewer"));
        await checkPartialDailyCsvGps(page, info.outputPath("partial"), selection);
    });
}

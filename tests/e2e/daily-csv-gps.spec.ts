import { checkDailyCsvGps, checkPartialDailyCsvGps } from "./_daily-csv-gps.js";
import { DESKTOP, gotoApp, presetLocalStorage, test } from "./_fixtures.js";

test.use({
    viewport: DESKTOP,
    viewerMap: "route-only",
    locale: "de-DE",
    timezoneId: "Europe/Moscow",
    reducedMotion: "reduce",
});

test("daily DAT logs supply GPS for normal and event recordings", async ({ page }, info) => {
    await presetLocalStorage(page);
    await gotoApp(page, "en");
    await checkDailyCsvGps(page, info.outputPath("card"));
});

for (const selection of ["leaf-folders", "card-fragments"] as const) {
    test(`daily DAT GPS survives ${selection} selections`, async ({ page }, info) => {
        await presetLocalStorage(page);
        await gotoApp(page, "en");
        await checkPartialDailyCsvGps(page, info.outputPath("partial"), selection);
    });
}

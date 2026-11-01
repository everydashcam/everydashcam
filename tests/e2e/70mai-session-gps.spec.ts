import {
    check70maiDatedGps,
    check70maiDatedGpsIncremental,
    check70maiHiddenGps,
    check70maiSessionGps,
} from "./_70mai-session-gps.js";
import { DESKTOP, gotoApp, presetLocalStorage, test } from "./_fixtures.js";

test.use({ viewport: DESKTOP, viewerMap: "route-only", timezoneId: "Europe/Moscow" });

test("imports a 70mai log from the supported .GPS layout", async ({ page }, info) => {
    await presetLocalStorage(page);
    await gotoApp(page);
    await check70maiHiddenGps(page, info.outputPath("card"));
});

test("binds a dated 70mai .GPS log to normal and event clips", async ({ page }, info) => {
    await presetLocalStorage(page);
    await gotoApp(page);
    await check70maiDatedGps(page, info.outputPath("card"));
});

test("keeps dated 70mai GPS when the first log row is malformed", async ({ page }, info) => {
    await presetLocalStorage(page);
    await gotoApp(page);
    await check70maiDatedGps(page, info.outputPath("card"), true);
});

for (const hasInitialVideo of [false, true]) {
    test(`binds later videos after importing a dated 70mai log ${hasInitialVideo ? "with a normal clip" : "alone"}`, async ({
        page,
    }, info) => {
        await presetLocalStorage(page);
        await gotoApp(page);
        await check70maiDatedGpsIncremental(page, info.outputPath("card"), hasInitialVideo);
    });
}

for (const withGps of [true, false]) {
    test(`70mai A500S card ${withGps ? "uses its root session log" : "plays without a GPS log"}`, async ({
        page,
    }, info) => {
        await presetLocalStorage(page);
        await gotoApp(page);
        await check70maiSessionGps(page, info.outputPath("cards"), withGps);
    });
}

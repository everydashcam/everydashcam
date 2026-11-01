import {
    check70maiDatedGps,
    check70maiDatedGpsIncremental,
    check70maiHiddenGps,
    check70maiSessionGps,
} from "../e2e/_70mai-session-gps.js";
import { presetLocalStorage } from "../e2e/_fixtures.js";
import { openPortable, test } from "./_fixtures.js";

test.use({ timezoneId: "Europe/Moscow" });

test("file-origin import reads a 70mai log from the supported .GPS layout", async ({ page }, info) => {
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("viewer"));
    await check70maiHiddenGps(page, info.outputPath("card"));
});

test("file-origin import binds a dated 70mai .GPS log to normal and event clips", async ({ page }, info) => {
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("viewer"));
    await check70maiDatedGps(page, info.outputPath("card"));
});

test("file-origin import keeps dated 70mai GPS when the first log row is malformed", async ({ page }, info) => {
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("viewer"));
    await check70maiDatedGps(page, info.outputPath("card"), true);
});

for (const hasInitialVideo of [false, true]) {
    test(`file-origin import binds later videos after a dated 70mai log ${hasInitialVideo ? "with a normal clip" : "alone"}`, async ({
        page,
    }, info) => {
        await presetLocalStorage(page);
        await openPortable(page, info.outputPath("viewer"));
        await check70maiDatedGpsIncremental(page, info.outputPath("card"), hasInitialVideo);
    });
}

for (const withGps of [true, false]) {
    test(`70mai A500S file-origin card ${withGps ? "uses its root session log" : "plays without a GPS log"}`, async ({
        page,
    }, info) => {
        await presetLocalStorage(page);
        await openPortable(page, info.outputPath("viewer"));
        await check70maiSessionGps(page, info.outputPath("cards"), withGps);
    });
}

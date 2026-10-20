import { check70maiSessionGps } from "./_70mai-session-gps.js";
import { DESKTOP, gotoApp, presetLocalStorage, test } from "./_fixtures.js";

test.use({ viewport: DESKTOP, viewerMap: "route-only", timezoneId: "Europe/Moscow" });

for (const withGps of [true, false]) {
    test(`70mai A500S card ${withGps ? "uses its root session log" : "plays without a GPS log"}`, async ({
        page,
    }, info) => {
        await presetLocalStorage(page);
        await gotoApp(page);
        await check70maiSessionGps(page, info.outputPath("cards"), withGps);
    });
}

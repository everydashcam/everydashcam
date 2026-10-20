import { check70maiCameraTimezone } from "./_70mai-session-gps.js";
import { DESKTOP, gotoApp, presetLocalStorage, test } from "./_fixtures.js";

test.use({ viewport: DESKTOP, viewerMap: "route-only", timezoneId: "Asia/Almaty", reducedMotion: "reduce" });

for (const locale of ["en", "ru"]) {
    test(`camera time zones recover directory GPS independently of track shifts in ${locale}`, async ({
        page,
    }, info) => {
        await presetLocalStorage(page, { lang: locale });
        await gotoApp(page, locale);
        await check70maiCameraTimezone(page, info.outputPath("cards"), info.outputPath("screenshots"));
    });
}

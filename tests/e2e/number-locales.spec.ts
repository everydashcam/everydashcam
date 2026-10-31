import { DESKTOP, gotoApp, loadTrip, pausePlayback, presetLocalStorage, test } from "./_fixtures.js";
import { verifyLocalizedNumbers } from "./_pointer-gestures.js";

test.use({ viewerMap: "route-only", viewport: DESKTOP, locale: "de-DE" });
for (const locale of ["en", "ru"] as const) {
    test(`file sizes and distance use the ${locale} page locale`, async ({ page }) => {
        await presetLocalStorage(page, { preferences: { "everydashcam:units": "metric" } });
        await gotoApp(page, locale);
        await loadTrip(page);
        await pausePlayback(page);
        await verifyLocalizedNumbers(page, locale);
    });
}

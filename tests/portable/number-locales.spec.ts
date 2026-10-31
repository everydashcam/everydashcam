import { DESKTOP, loadTrip, pausePlayback, presetLocalStorage } from "../e2e/_fixtures.js";
import { verifyLocalizedNumbers } from "../e2e/_pointer-gestures.js";
import { openPortable, test } from "./_fixtures.js";

test.use({ viewport: DESKTOP });
for (const locale of ["en", "ru"] as const) {
    test(`file-origin numbers use the embedded ${locale} locale`, async ({ page }, info) => {
        await presetLocalStorage(page, {
            preferences: { "everydashcam:units": "metric", "everydashcam:mapProvider": "route-only" },
        });
        await openPortable(page, info.outputPath(`numbers-${locale}`), locale);
        await loadTrip(page);
        await pausePlayback(page);
        await verifyLocalizedNumbers(page, locale);
    });
}

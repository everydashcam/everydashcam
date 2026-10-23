import { checkZeroGps } from "./_zero-gps.js";
import { DESKTOP, gotoApp, presetLocalStorage, test } from "./_fixtures.js";

test.use({ viewport: DESKTOP, viewerMap: "route-only", reducedMotion: "reduce" });

for (const coordinate of ["latitude", "longitude"] as const) {
    test(`ignores missing-signal (0, 0) positions while keeping zero ${coordinate} fixes`, async ({ page }, info) => {
        await presetLocalStorage(page);
        await gotoApp(page);
        await checkZeroGps(page, info.outputPath("card"), coordinate);
    });
}

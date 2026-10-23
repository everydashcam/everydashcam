import { checkZeroGps } from "../e2e/_zero-gps.js";
import { presetLocalStorage } from "../e2e/_fixtures.js";
import { openPortable, test } from "./_fixtures.js";

test.use({ reducedMotion: "reduce" });

for (const coordinate of ["latitude", "longitude"] as const) {
    test(`file-origin map ignores (0, 0) while keeping zero ${coordinate} fixes`, async ({ page }, info) => {
        await presetLocalStorage(page);
        await page.addInitScript(() => {
            window.addEventListener("dc:ready", () => window.__everydashcam.setMapProvider("route-only"), {
                once: true,
            });
        });
        await openPortable(page, info.outputPath("viewer"));
        await checkZeroGps(page, info.outputPath("card"), coordinate);
    });
}

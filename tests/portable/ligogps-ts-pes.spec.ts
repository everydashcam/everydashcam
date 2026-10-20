import { presetLocalStorage } from "../e2e/_fixtures.js";
import { checkLigoGpsTsPes } from "../e2e/_ligogps-ts-pes.js";
import { openPortable, test } from "./_fixtures.js";

for (const [label, withTxt] of [
    ["the TXT log", true],
    ["the enciphered PES alone", false],
] as const) {
    test(`indexes, seeks and plays LigoGPS with ${label} from a file URL`, async ({ page }, info) => {
        await presetLocalStorage(page);
        await page.addInitScript(() => {
            window.addEventListener("dc:ready", () => window.__everydashcam.setMapProvider("route-only"), {
                once: true,
            });
        });
        await openPortable(page, info.outputPath("ligogps-ts-pes"));
        await checkLigoGpsTsPes(page, withTxt);
    });
}

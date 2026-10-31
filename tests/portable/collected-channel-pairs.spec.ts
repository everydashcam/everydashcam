import { COLLECTED_CHANNEL_PAIRS } from "../../src/parsers/__fixtures__/supported-gps/grouping-cases.js";
import { checkCollectedChannelPair } from "../e2e/_collected-channel-pairs.js";
import { DESKTOP, presetLocalStorage } from "../e2e/_fixtures.js";
import { openPortable, test } from "./_fixtures.js";

test.use({ viewport: DESKTOP, reducedMotion: "reduce", timezoneId: "Europe/Moscow" });

for (const pair of COLLECTED_CHANNEL_PAIRS) {
    test(`${pair.model} file-origin channels pair by recording`, async ({ page }, info) => {
        await presetLocalStorage(page);
        await page.addInitScript(() => {
            window.addEventListener("dc:ready", () => window.__everydashcam.setMapProvider("route-only"), {
                once: true,
            });
        });
        await openPortable(page, info.outputPath("viewer"));
        await checkCollectedChannelPair(page, info, pair, "folder");
    });
}

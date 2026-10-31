import { COLLECTED_CHANNEL_PAIRS } from "../../src/parsers/__fixtures__/supported-gps/grouping-cases.js";
import { checkCollectedChannelPair } from "./_collected-channel-pairs.js";
import { DESKTOP, gotoApp, presetLocalStorage, test } from "./_fixtures.js";

test.use({ viewport: DESKTOP, viewerMap: "route-only", reducedMotion: "reduce", timezoneId: "Europe/Moscow" });

for (const pair of COLLECTED_CHANNEL_PAIRS) {
    for (const selection of ["folder", "files"] as const) {
        test(`${pair.model} channels pair by recording from a ${selection} selection`, async ({ page }, info) => {
            await presetLocalStorage(page);
            await gotoApp(page, "en");
            await checkCollectedChannelPair(page, info, pair, selection);
        });
    }
}

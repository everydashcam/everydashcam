import { presetLocalStorage } from "../e2e/_fixtures.js";
import { checkClockCorrection } from "../e2e/_clock-correction.js";
import { openPortable, test } from "./_fixtures.js";

test("clock correction works and persists from a file URL", async ({ page }, info) => {
    await presetLocalStorage(page, { preferences: { "everydashcam:mapProvider": "route-only" } });
    await openPortable(page, info.outputPath("viewer"), "ru");
    await checkClockCorrection(page);
});

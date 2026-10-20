import { check70maiCameraTimezone } from "../e2e/_70mai-session-gps.js";
import { presetLocalStorage } from "../e2e/_fixtures.js";
import { openPortable, test } from "./_fixtures.js";

test.use({ timezoneId: "Asia/Almaty", reducedMotion: "reduce" });

test("camera time zones restore directory GPS and persist from a file URL", async ({ page }, info) => {
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("viewer"));
    await check70maiCameraTimezone(page, info.outputPath("cards"));
});

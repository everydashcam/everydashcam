import { checkPairedMediaBlur, checkPairedMediaTail } from "./_paired-media-tail.js";
import { canEncodeHighProfileH264, gotoApp, installExportCapture, presetLocalStorage, test } from "./_fixtures.js";

test.use({ viewerMap: "route-only", timezoneId: "UTC" });

test("plays and seeks the complete paired recording despite a sibling GPS clock offset", async ({ page }) => {
    await presetLocalStorage(page);
    await gotoApp(page);
    await checkPairedMediaTail(page);
});

test("previews and exports rear masks on paired media time and keeps the tail editable", async ({ page }) => {
    test.setTimeout(120_000);
    await presetLocalStorage(page);
    await installExportCapture(page);
    await gotoApp(page);
    test.skip(!(await canEncodeHighProfileH264(page)), "WebCodecs High-profile H.264 encode unavailable");
    await checkPairedMediaBlur(page);
});

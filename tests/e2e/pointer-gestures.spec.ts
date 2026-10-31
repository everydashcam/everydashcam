import { gotoApp, loadTrip, pausePlayback, presetLocalStorage, test } from "./_fixtures.js";
import { verifyLostPointerCapture, verifyTouchGestures } from "./_pointer-gestures.js";

test.use({ viewerMap: "route-only", hasTouch: true, viewport: { width: 1024, height: 768 } });
test.beforeEach(async ({ page }) => {
    await presetLocalStorage(page);
    await gotoApp(page);
    await loadTrip(page);
    await pausePlayback(page);
});

test("tablet touch resizes the sidebar and pinches video and timeline", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "real multi-touch injection uses Chromium CDP");
    await verifyTouchGestures(page);
});

test("lost pointer capture settles sidebar and mini-map drags", async ({ page }) => {
    await verifyLostPointerCapture(page);
});

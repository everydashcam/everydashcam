import { loadTrip, pausePlayback, presetLocalStorage } from "../e2e/_fixtures.js";
import { verifyLostPointerCapture, verifyTouchGestures } from "../e2e/_pointer-gestures.js";
import { openPortable, test } from "./_fixtures.js";

test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } });
test("file-origin touch gestures and capture cleanup share the viewer behavior", async ({ page }, info) => {
    await presetLocalStorage(page, { preferences: { "everydashcam:mapProvider": "route-only" } });
    await openPortable(page, info.outputPath("gestures"));
    await loadTrip(page);
    await pausePlayback(page);
    await verifyTouchGestures(page);
    await verifyLostPointerCapture(page);
});

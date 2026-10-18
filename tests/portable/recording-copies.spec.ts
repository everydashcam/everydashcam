import { presetLocalStorage } from "../e2e/_fixtures.js";
import {
    checkAddedCopies,
    checkBatchCopies,
    checkBlackVueCopies,
    checkCopyGpxPreview,
    checkLateCopyGps,
} from "../e2e/_recording-copies.js";
import { openPortable, test } from "./_fixtures.js";

test.use({ reducedMotion: "reduce" });

test.beforeEach(async ({ page }, info) => {
    await presetLocalStorage(page);
    await page.addInitScript(() => {
        localStorage.setItem("everydashcam:hotkeys:seekStepSec", "0.5");
        window.addEventListener("dc:ready", () => window.__everydashcam.setMapProvider("route-only"), { once: true });
    });
    await openPortable(page, info.outputPath("recording-copies"));
});

for (const order of ["normal-first", "event-first"] as const) {
    test(`file URL combines 70mai recording copies in one ${order} import`, async ({ page }) => {
        await checkBatchCopies(page, order);
    });

    test(`file URL retains position and notes when adding 70mai copies ${order}`, async ({ page }) => {
        await checkAddedCopies(page, order);
    });
}

test("file URL attaches a later normal-named GPS log to retained event recordings", async ({ page }) => {
    await checkLateCopyGps(page);
});

test("file URL recovers malformed GPS recording names after combining normal and event copies", async ({ page }) => {
    await checkLateCopyGps(page, true);
});

test("file URL marks an existing BlackVue normal recording as an event when adding its copy", async ({ page }) => {
    await checkBlackVueCopies(page);
});

test("file URL assigns loose GPX against the trip formed by an event copy", async ({ page }) => {
    await checkCopyGpxPreview(page, false);
});

test("file URL cancelling loose GPX keeps pending copy modes and aliases out of live trips", async ({ page }) => {
    await checkCopyGpxPreview(page, true);
});

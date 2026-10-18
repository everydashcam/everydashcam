import { DESKTOP, gotoApp, presetLocalStorage, test } from "./_fixtures.js";
import {
    checkAddedCopies,
    checkBatchCopies,
    checkBlackVueCopies,
    checkCopyGpxPreview,
    checkLateCopyGps,
} from "./_recording-copies.js";

test.use({ viewerMap: "route-only", reducedMotion: "reduce" });

test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await presetLocalStorage(page);
    await page.addInitScript(() => localStorage.setItem("everydashcam:hotkeys:seekStepSec", "0.5"));
    await gotoApp(page);
});

for (const order of ["normal-first", "event-first"] as const) {
    test(`combines 70mai recording copies in one ${order} import`, async ({ page }) => {
        await checkBatchCopies(page, order);
    });

    test(`retains position and notes when adding 70mai copies ${order}`, async ({ page }) => {
        await checkAddedCopies(page, order);
    });
}

test("attaches a later normal-named GPS log to retained event recordings", async ({ page }) => {
    await checkLateCopyGps(page);
});

test("recovers malformed GPS recording names after combining normal and event copies", async ({ page }) => {
    await checkLateCopyGps(page, true);
});

test("marks an existing BlackVue normal recording as an event when adding its copy", async ({ page }) => {
    await checkBlackVueCopies(page);
});

test("assigns loose GPX against the trip formed by an event copy", async ({ page }) => {
    await checkCopyGpxPreview(page, false);
});

test("cancelling loose GPX import keeps pending copy modes and aliases out of live trips", async ({ page }) => {
    await checkCopyGpxPreview(page, true);
});

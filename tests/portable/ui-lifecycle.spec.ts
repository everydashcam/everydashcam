import { presetLocalStorage } from "../e2e/_fixtures.js";
import { verifyModalIsolation, verifyModalNotifications, verifyPopoverOwnership } from "../e2e/_ui-lifecycle.js";
import { openPortable, test } from "./_fixtures.js";

test.beforeEach(async ({ page }, info) => {
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("ui-lifecycle"));
});

test("file-origin dialogs preserve Tab order and background isolation", async ({ page }) => {
    await verifyModalIsolation(page);
});

test("file-origin notifications remain accessible through nested dialogs", async ({ page }) => {
    await verifyModalNotifications(page);
});

test("file-origin menus share dismissal and focus ownership", async ({ page }) => {
    // Portable embeds one locale and deliberately omits the language switcher.
    await verifyPopoverOwnership(page, "#player-view-menu");
});

import { gotoApp, presetLocalStorage, test } from "./_fixtures.js";
import { verifyModalIsolation, verifyPopoverOwnership } from "./_ui-lifecycle.js";

test.beforeEach(async ({ page }) => {
    await presetLocalStorage(page);
    await gotoApp(page, "en");
});

test("dialogs preserve native Tab order and isolate nested backgrounds", async ({ page }) => {
    await verifyModalIsolation(page);
});

test("menus share dismissal and focus ownership", async ({ page }) => {
    await verifyPopoverOwnership(page);
});

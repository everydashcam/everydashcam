import { expect, gotoApp, loadTrip, pausePlayback, presetLocalStorage, test } from "./_fixtures.js";
import { verifyModalIsolation, verifyModalNotifications, verifyPopoverOwnership } from "./_ui-lifecycle.js";

test.beforeEach(async ({ page }) => {
    await presetLocalStorage(page);
    await gotoApp(page, "en");
});

test("dialogs preserve native Tab order and isolate nested backgrounds", { tag: "@webkit-ui" }, async ({ page }) => {
    await verifyModalIsolation(page);
});

test("notifications stay accessible and dismissible through nested dialogs", { tag: "@webkit-ui" }, async ({
    page,
}) => {
    await verifyModalNotifications(page);
});

test("menus share dismissal and focus ownership", { tag: "@webkit-ui" }, async ({ page }) => {
    await verifyPopoverOwnership(page);
});

test.describe("settings opened from the narrow touch toolbar", () => {
    // Settings is the last optional action to collapse. Exercise the toolbar's
    // overflow path below that breakpoint rather than assuming phone width
    // alone hides its highest-priority action.
    test.use({ hasTouch: true, viewport: { width: 240, height: 640 } });

    test("returns focus to the visible overflow trigger after settings and reset cancellation", {
        tag: "@webkit-ui",
    }, async ({ page }) => {
        await loadTrip(page);
        await pausePlayback(page);
        const settingsButton = page.locator("#settings-btn");
        const overflow = page.locator("#topbar-overflow");
        await expect(settingsButton).toHaveAttribute("data-overflow-hidden", "true");
        await expect(settingsButton).toBeHidden();
        for (const openReset of [false, true]) {
            await overflow.click();
            await page.locator("#topbar-overflow-menu").getByRole("button", { name: "Settings", exact: true }).click();
            await expect(page.locator("#settings-modal-header-close")).toBeFocused();
            if (openReset) {
                await page.locator("#settings-reset-btn").click();
                await expect(page.locator("#reset-confirm-cancel")).toBeFocused();
                await page.locator("#reset-confirm-cancel").click();
                await expect(page.locator("#settings-modal-header-close")).toBeFocused();
            }
            await page.keyboard.press("Escape");
            await expect(page.locator("#settings-modal")).toBeHidden();
            await expect(overflow).toBeFocused();
        }
    });
});

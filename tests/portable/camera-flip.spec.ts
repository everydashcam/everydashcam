import { expect } from "@playwright/test";
import { SAMPLE_70MAI, loadTrip, pausePlayback, presetLocalStorage } from "../e2e/_fixtures.js";
import { omitModernBrowserApis } from "../helpers/legacy-browser-apis.js";
import { openPortable, test } from "./_fixtures.js";

test("camera menus retain keyboard dismissal without Popover API on file origins", async ({ page }, info) => {
    await omitModernBrowserApis(page);
    await presetLocalStorage(page);
    await page.addInitScript(() => {
        window.addEventListener("dc:ready", () => window.__everydashcam.setMapProvider("route-only"), { once: true });
    });
    await openPortable(page, info.outputPath("camera-flip"));
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    const front = page.locator('.video-tile[data-channel="front"]');
    const button = front.locator(".camera-settings-button");
    const menu = page.locator("#camera-settings-front");
    await button.focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu).toBeVisible();
    await expect(page.getByRole("menuitemcheckbox", { name: "Flip horizontally" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(front).toHaveClass(/camera-flipped/);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute("aria-expanded", "false");
});

import { expect } from "@playwright/test";
import { cameraFlipToggle, openCamerasMenu } from "../e2e/_cameras.js";
import { SAMPLE_70MAI, loadTrip, pausePlayback, presetLocalStorage } from "../e2e/_fixtures.js";
import { omitModernBrowserApis } from "../helpers/legacy-browser-apis.js";
import { openPortable, test } from "./_fixtures.js";

test("the View menu reflects a camera on file origins without newer APIs", async ({ page }, info) => {
    await omitModernBrowserApis(page);
    await presetLocalStorage(page);
    await page.addInitScript(() => {
        window.addEventListener("dc:ready", () => window.__everydashcam.setMapProvider("route-only"), { once: true });
    });
    await openPortable(page, info.outputPath("camera-flip"));
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    const front = page.locator('.video-tile[data-channel="front"]');
    await openCamerasMenu(page);
    const toggle = cameraFlipToggle(page, "front", "horizontal");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(front).toHaveClass(/camera-flipped/);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator("#player-view-menu-popover")).toBeHidden();
    await expect(page.locator("#player-view-menu")).toBeFocused();
});

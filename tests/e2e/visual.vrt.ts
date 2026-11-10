// Pixel-diff visual regression (run via playwright.vrt.config.ts, NOT the e2e
// gate). Snapshots only DETERMINISTIC surfaces; the nondeterministic map canvas
// and video frames are masked. Catches CSS/layout regressions that the
// behavior-asserting e2e suite and the eyeball screenshots both miss.
//
// Baselines are platform-specific - see the header in playwright.vrt.config.ts
// for the Docker command to regenerate Linux baselines for CI.

import { DESKTOP, MOBILE, expect, gotoApp, loadTrip, openExport, presetLocalStorage, test } from "./_fixtures.js";
import { EAST_ROAD, NORTH_ROAD, writeTripLibrary } from "./_trip-library.js";

// Fonts are self-hosted; wait for them so text metrics are stable before a shot.
async function settle(page: import("@playwright/test").Page): Promise<void> {
    await page.evaluate(() => document.fonts.ready);
}

test.describe("visual regression", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
    });

    test("landing - desktop", async ({ page }) => {
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await expect(page.locator("#landing")).toBeVisible();
        await settle(page);
        // The footer build id changes with every commit - masked, or the
        // snapshot is nondeterministic build-to-build.
        await expect(page).toHaveScreenshot("landing-desktop.png", {
            fullPage: true,
            mask: [page.locator("#footer-version")],
        });
    });

    test("landing - mobile", async ({ page }) => {
        await page.setViewportSize(MOBILE);
        await gotoApp(page, "en");
        await expect(page.locator("#landing")).toBeVisible();
        await settle(page);
        // Same footer build-id mask as the desktop shot.
        await expect(page).toHaveScreenshot("landing-mobile.png", {
            fullPage: true,
            mask: [page.locator("#footer-version")],
        });
    });

    test("settings modal", async ({ page }) => {
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await page.locator("#settings-btn").click();
        const modal = page.locator("#settings-modal");
        await expect(modal).toBeVisible();
        await settle(page);
        await expect(modal).toHaveScreenshot("settings-modal.png");
    });

    test("hotkeys modal", async ({ page }) => {
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await loadTrip(page);
        await page.keyboard.press("?");
        const modal = page.locator("#hotkeys-modal");
        await expect(modal).toBeVisible();
        await settle(page);
        await expect(modal).toHaveScreenshot("hotkeys-modal.png");
    });

    test("GPS synchronization modal", async ({ page }) => {
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await loadTrip(page);
        await page.locator("#gps-sync-pill").click();
        const modal = page.locator("#gps-sync-modal");
        await expect(modal).toBeVisible();
        await settle(page);
        await expect(modal).toHaveScreenshot("gps-sync-modal.png");
    });

    test.describe("map of all trips (map canvas masked)", () => {
        test.use({ viewerMap: "route-only" });

        async function openLibrary(page: import("@playwright/test").Page): Promise<void> {
            await gotoApp(page, "en");
            const library = writeTripLibrary({ roads: [EAST_ROAD, NORTH_ROAD], withoutGps: 1, hasDeferredGps: true });
            await page.locator("#folder-input").setInputFiles(library);
            await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });
            await expect
                .poll(() => page.evaluate(() => window.__everydashcam.state.recordingAnalysisProgress))
                .toBeNull();
        }

        test("desktop with the reading panel", async ({ page }) => {
            await page.setViewportSize(DESKTOP);
            await openLibrary(page);
            await expect(page.locator("#trip-map-counter-text")).toHaveText("2 of 4 on the map");
            await page.locator("#trip-map-counter").click();
            await expect(page.locator("#trip-map-read-now")).toBeVisible();
            await settle(page);
            await expect(page.locator("#trip-map-state")).toHaveScreenshot("trip-map-desktop.png", {
                mask: [page.locator("#trip-map .maplibregl-canvas-container")],
            });
        });

        test("phone map tab with its sheet", async ({ page }) => {
            await page.setViewportSize(MOBILE);
            await openLibrary(page);
            await page.locator("#trip-view-map").click();
            await expect(page.locator("#trip-map-panel #trip-map-state")).toBeVisible();
            await expect(page.locator("#trip-map-counter-text")).toHaveText("2 of 4 on the map");
            await settle(page);
            await expect(page.locator("#sidebar")).toHaveScreenshot("trip-map-phone.png", {
                mask: [page.locator("#trip-map .maplibregl-canvas-container")],
            });
        });
    });

    test("export panel options (video grid masked)", async ({ page }) => {
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await loadTrip(page);
        await openExport(page, false);
        const panel = page.locator("#export-panel");
        await expect(panel).toBeVisible();
        await settle(page);
        // The panel embeds the live multichannel preview (nondeterministic video
        // frames) - mask it so only the controls/layout are compared.
        await expect(panel).toHaveScreenshot("export-panel.png", {
            mask: [page.locator("#video-grid")],
        });
    });
});

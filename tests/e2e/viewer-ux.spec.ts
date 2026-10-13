import {
    DESKTOP,
    MOBILE,
    SAMPLE_70MAI,
    SAMPLE_NOGPS,
    boxOf,
    expect,
    gotoApp,
    loadTrip,
    openExport,
    presetLocalStorage,
    test,
} from "./_fixtures.js";

for (const locale of ["ru", "de"]) {
    test(`camera controls stay reachable beside the export panel in ${locale}`, async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, locale);
        await loadTrip(page, SAMPLE_70MAI);
        await page.locator("#player-export").click();
        await expect(page.locator("#export-panel")).toBeVisible();

        for (const width of [1024, 768]) {
            await page.setViewportSize({ width, height: 900 });
            const camera = page.locator('.top-panel__channel-chip[data-channel="interior"] input');
            await camera.click({ trial: true });
            const panel = await boxOf(page, "#top-panel");
            for (const chip of await page.locator(".top-panel__channel-chip").all()) {
                const bounds = await chip.boundingBox();
                expect(bounds).not.toBeNull();
                expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
            }
            await camera.uncheck();
            await expect(camera).not.toBeChecked();
            await camera.check();
            await expect(camera).toBeChecked();
        }
    });
}

for (const viewport of [MOBILE, { width: 844, height: 390 }, { width: 568, height: 320 }]) {
    test(`export actions leave playback controls usable at ${viewport.width}px`, async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(viewport);
        await gotoApp(page);
        await loadTrip(page, SAMPLE_70MAI);
        await openExport(page, false);
        await page.locator(".viewer").evaluate((viewer) => {
            viewer.scrollTop = 0;
        });
        if (viewport.height < 360) {
            await page.locator("#player-bar").evaluate((bar) => {
                bar.scrollIntoView({ block: "start" });
            });
        }
        const play = page.locator("#player-play");
        await play.click({ trial: true });
        const bar = await boxOf(page, "#player-bar");
        const actions = await boxOf(page, ".export-panel__actions");
        expect(bar.y + bar.height).toBeLessThanOrEqual(actions.y + 1);
        await play.click();
        await expect(play).toHaveAttribute("data-paused", "false");
    });
}

for (const viewport of [DESKTOP, MOBILE, { width: 360, height: 800 }, { width: 844, height: 390 }]) {
    test(`save remains reachable while editing at ${viewport.width}px`, async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(viewport);
        await gotoApp(page);
        await loadTrip(page, SAMPLE_70MAI);
        await openExport(page, false);
        await expect(page.locator(".export-panel__disclosure[open]")).toHaveCount(viewport === DESKTOP ? 2 : 0);
        const save = page.locator("#export-panel-save-btn");
        await expect(save).toBeInViewport();
        const initial = await boxOf(page, "#export-panel-save-btn");
        expect(initial.y + initial.height).toBeLessThanOrEqual(viewport.height);
        await page.locator(".export-panel__disclosure > summary").last().click();
        await expect(save).toBeInViewport();
        await page.locator("#export-panel-back-to-trim").click();
        await expect(page.locator("#export-trim-bar input").first()).toBeFocused();
        await expect(page.locator("#export-trim-bar")).toBeInViewport();
        await expect(save).toBeInViewport();
        await page.screenshot({ path: `tests/e2e/screenshots/viewer-ux-export-${viewport.width}.png` });
    });
}

test("trip metadata counts every camera file and mobile cameras start collapsed", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(MOBILE);
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await expect(page.locator(".trip-meta-text").first()).toContainText("6 files · 3 cameras");
    await expect(page.locator("#top-panel-controls")).not.toHaveAttribute("open");
    await page.locator("#top-panel-controls-summary").click();
    await expect(page.locator(".top-panel__channel-include").first()).toHaveAccessibleName(/preview and saved video/);
    await page.locator(".top-panel__channel-include").last().uncheck();
    await expect(page.locator(".top-panel__channel-include:checked")).toHaveCount(2);
    await expect(page.locator("#top-panel-controls-summary")).toHaveText("2 cameras");
    await page.locator("#mobile-view-map").click();
    await expect(page.locator("#player-wrap")).toHaveClass(/map-expanded/);
    await page.locator("#mobile-view-video").click();
    await expect(page.locator("#player-wrap")).not.toHaveClass(/map-expanded/);
});

test("no-GPS recordings explain the missing route and retain a usable timeline", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(MOBILE);
    await gotoApp(page);
    await loadTrip(page, SAMPLE_NOGPS);
    await expect(page.locator(".player-no-gps")).toBeVisible();
    await expect(page.locator("#mobile-view-map")).toBeDisabled();
    await expect(page.locator("#mobile-view-events")).toBeDisabled();
    await openExport(page, false);
    await expect(page.locator("#export-trim-bar")).toBeVisible();
    await expect(page.locator("#export-panel-save-btn")).toBeEnabled();
});

test("settings can be closed from the header after scrolling to the last setting", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(MOBILE);
    await gotoApp(page);
    await page.locator("#settings-btn").click();
    await page.locator("#settings-modal-close").scrollIntoViewIfNeeded();
    await expect(page.locator("#settings-modal-header-close")).toBeInViewport();
    await page.locator("#settings-modal-header-close").click();
    await expect(page.locator("#settings-modal")).toBeHidden();
});

test("mobile event list opens a clip around the selected event", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(MOBILE);
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await openExport(page, false);
    const start = page.locator('.export-trim-bar__input[data-range-edge="start"]');
    const end = page.locator('.export-trim-bar__input[data-range-edge="end"]');
    const fullEnd = await end.inputValue();
    await start.fill("0:02");
    await start.press("Enter");
    await expect(start).toHaveValue("0:02");
    // Public fixtures contain no detected events; use the same event seam as the popup coverage.
    await page.evaluate(() => {
        const state = window.__everydashcam.state;
        const trip = state.trips[state.active!.trip]!;
        trip.events.push({ kind: "brake", unixSeconds: trip.startUtc + 2, relSec: 2, severity: 0.42, recordIndex: 0 });
    });
    await page.locator("#export-panel-close").click();
    await page.locator("#mobile-view-events").click();
    await expect(page.locator("#mobile-events-list")).toContainText("0:02 · Event");
    await page.locator("#mobile-events-list").getByRole("button", { name: "Save clip ±10s" }).click();
    await expect(start).toHaveValue("0:00");
    await expect(end).toHaveValue(fullEnd);
    await expect(page.locator("#export-panel-save-btn")).toBeInViewport();
});

import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

import {
    DESKTOP,
    MOBILE_LANDSCAPE,
    SAMPLE_70MAI,
    boxOf,
    expect,
    gotoApp,
    loadTrip,
    masterVideoTime,
    pausePlayback,
    presetLocalStorage,
    test,
} from "./_fixtures.js";

test.use({ viewerMap: "route-only" });

async function startLoopingPlayback(page: Page): Promise<void> {
    await pausePlayback(page);
    await page.keyboard.press("r");
    await expect(page.locator("#player-loop")).toHaveAttribute("aria-label", "Loop on");
    await page.locator("#player-mini-progress").focus();
    await page.keyboard.press("Home");
    const master = page.locator(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)");
    await expect
        .poll(() =>
            master.evaluate(
                (video: HTMLVideoElement) => video.readyState >= 2 && !video.seeking && video.currentTime < 0.1,
            ),
        )
        .toBe(true);
    await page.locator("#player-play").click();
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "false");
}

async function disableNativeFullscreen(page: Page): Promise<void> {
    await page.addInitScript(() => {
        Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: undefined });
        Object.defineProperty(Document.prototype, "fullscreenEnabled", { configurable: true, get: () => false });
    });
}

async function enterFullscreen(page: Page): Promise<void> {
    await activateFullscreenEntry(page);
    await expect(page.locator("#player-wrap")).toHaveClass(/player-expanded/);
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe("player-wrap");
}

async function activateFullscreenEntry(page: Page, touch = false): Promise<void> {
    let entry = page.locator("#player-fullscreen");
    if (!(await entry.isVisible())) {
        const label = (await entry.getAttribute("aria-label")) ?? "";
        expect(label).not.toBe("");
        const overflow = page.locator("#player-overflow");
        if (touch) await overflow.tap();
        else await overflow.click();
        entry = page.locator("#player-overflow-menu").getByRole("button", { name: label, exact: true });
        await expect(entry).toBeVisible();
    }
    if (touch) await entry.tap();
    else await entry.click();
}

async function moveAwayFromControls(page: Page): Promise<void> {
    const frame = await boxOf(page, ".video-frame");
    const timeline = await boxOf(page, "#player-chart");
    // In landscape, stacked controls can cover the middle of the video.
    const exposedBottom = Math.min(frame.y + frame.height, timeline.y);
    expect(exposedBottom).toBeGreaterThan(frame.y);
    const x = frame.x + frame.width / 2;
    const y = (frame.y + exposedBottom) / 2;
    await page.mouse.move(x, y);
    await expect
        .poll(() =>
            page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".video-frame")), { x, y }),
        )
        .toBe(true);
}

async function setPanelsBelow(page: Page, enabled: boolean): Promise<void> {
    await page.locator("#player-view-menu").click();
    const option = page.locator("[data-fullscreen-panels-below]");
    await expect(option).toBeVisible();
    await expect(option).toHaveAttribute("role", "menuitemcheckbox");
    if ((await option.getAttribute("aria-checked")) !== String(enabled)) await option.click();
    await expect(option).toHaveAttribute("aria-checked", String(enabled));
    await expect(option).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#player-view-menu")).toBeFocused();
}

async function expectPanelsBelowGeometry(page: Page): Promise<void> {
    await expect(page.locator("#player-wrap")).toHaveClass(/player-panels-below/);
    await expect(page.locator("#player-controls-pin")).toBeHidden();
    for (const selector of [
        ".video-frame",
        "#player-mini-progress",
        "#player-play",
        "#player-view-menu",
        "#player-fullscreen-exit",
    ]) {
        await expect(page.locator(selector)).toBeVisible();
    }
    await expect(async () => {
        const frame = await boxOf(page, ".video-frame");
        expect(frame.width, "video keeps a usable width").toBeGreaterThan(50);
        expect(frame.height, "video keeps a usable height").toBeGreaterThan(50);
        const tiles = await page.locator("#video-grid .video-tile:not([hidden])").evaluateAll((elements) =>
            elements.map((element) => {
                const bounds = element.getBoundingClientRect();
                return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom };
            }),
        );
        expect(tiles.length).toBeGreaterThan(0);
        for (const tile of tiles) {
            expect(tile.x, "camera fits the video area left").toBeGreaterThanOrEqual(frame.x - 1);
            expect(tile.y, "camera fits the video area top").toBeGreaterThanOrEqual(frame.y - 1);
            expect(tile.right, "camera fits the video area right").toBeLessThanOrEqual(frame.x + frame.width + 1);
            expect(tile.bottom, "camera fits the video area bottom").toBeLessThanOrEqual(frame.y + frame.height + 1);
        }
        const viewport = page.viewportSize()!;
        for (const selector of [
            "#player-mini-progress",
            "#player-play",
            "#player-view-menu",
            "#player-fullscreen-exit",
        ]) {
            const bounds = await boxOf(page, selector);
            const overlapWidth = Math.min(frame.x + frame.width, bounds.x + bounds.width) - Math.max(frame.x, bounds.x);
            const overlapHeight =
                Math.min(frame.y + frame.height, bounds.y + bounds.height) - Math.max(frame.y, bounds.y);
            expect(Math.min(overlapWidth, overlapHeight), `${selector} stays outside the video`).toBeLessThanOrEqual(1);
            expect(bounds.x, `${selector} fits the viewport left`).toBeGreaterThanOrEqual(-1);
            expect(bounds.y, `${selector} fits the viewport top`).toBeGreaterThanOrEqual(-1);
            expect(bounds.x + bounds.width, `${selector} fits the viewport right`).toBeLessThanOrEqual(
                viewport.width + 1,
            );
            expect(bounds.y + bounds.height, `${selector} fits the viewport bottom`).toBeLessThanOrEqual(
                viewport.height + 1,
            );
        }
        const timeline = await boxOf(page, "#player-mini-progress");
        expect(timeline.y, "timeline is below the full video area").toBeGreaterThanOrEqual(frame.y + frame.height - 1);
    }).toPass({ timeout: 5000 });
}

test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await presetLocalStorage(page);
});

for (const copy of [
    {
        locale: "en",
        enter: "Full screen",
        exit: "Exit full screen",
        shortExit: "Exit",
        panelsBelow: "Video above panels",
    },
    {
        locale: "ru",
        enter: "На весь экран",
        exit: "Выйти из полного экрана",
        shortExit: "Выйти",
        panelsBelow: "Видео над панелями",
    },
]) {
    test(`fullscreen has a visible entry and a distinct exit in ${copy.locale}`, async ({ page }) => {
        await gotoApp(page, copy.locale);
        await loadTrip(page, SAMPLE_70MAI);
        await pausePlayback(page);
        const entry = page.locator("#player-fullscreen");
        const exit = page.locator("#player-fullscreen-exit");
        const actions = page.locator(".player-fullscreen-actions");
        await expect(page.locator("#player-bar #player-fullscreen")).toBeVisible();
        await expect(entry).toHaveAccessibleName(copy.enter);
        await expect(entry.locator(".fullscreen-label")).toBeHidden();
        await expect(entry.locator(".fullscreen-enter-icon")).toBeVisible();
        await expect(entry.locator(".fullscreen-exit-icon")).toBeHidden();
        await expect(actions).toBeHidden();
        await expect(exit).toBeHidden();
        const barBounds = await boxOf(page, "#player-bar");
        const entryBounds = await boxOf(page, "#player-fullscreen");
        expect(entryBounds.x).toBeGreaterThanOrEqual(barBounds.x);
        expect(entryBounds.y).toBeGreaterThanOrEqual(barBounds.y);
        expect(entryBounds.x + entryBounds.width).toBeLessThanOrEqual(barBounds.x + barBounds.width);
        expect(entryBounds.y + entryBounds.height).toBeLessThanOrEqual(barBounds.y + barBounds.height);
        await enterFullscreen(page);
        await expect(entry).toBeHidden();
        await expect(actions).toBeVisible();
        await expect(actions.locator("#player-fullscreen-exit")).toBeVisible();
        await expect(exit).toHaveAccessibleName(copy.exit);
        await expect(exit.locator(".fullscreen-label")).toHaveText(copy.shortExit);
        await expect(exit.locator(".fullscreen-enter-icon")).toBeHidden();
        await expect(exit.locator(".fullscreen-exit-icon")).toBeVisible();
        await page.locator("#player-view-menu").click();
        await expect(page.locator("[data-fullscreen-panels-below]")).toHaveAccessibleName(copy.panelsBelow);
        await page.keyboard.press("Escape");
        await exit.click();
        await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded/);
        await expect(entry).toHaveAccessibleName(copy.enter);
        await expect(entry).toBeFocused();
        await expect(actions).toBeHidden();
        await expect(page.locator("#player-controls-pin")).toBeHidden();
    });
}

test("fullscreen keeps a separate detail view and restores the paused recording", async ({ page }) => {
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await page.locator("#player-view-menu").click();
    await page.locator('.view-menu-row[data-panel="readout"]').click();
    await page.locator("#player-view-menu").click();
    await expect(page.locator("#player-chart-canvas")).toBeVisible();
    await expect(page.locator("#player-readout")).toBeHidden();
    const time = await masterVideoTime(page);
    const camera = await page.locator(".video-tile.active").getAttribute("data-channel");
    const normalPreferences = await page.evaluate(() => localStorage.getItem("dc.viewer.panels"));

    await enterFullscreen(page);
    await expect(page.locator("#player-chart-canvas")).toBeHidden();
    await expect(page.locator("#player-readout")).toBeHidden();
    await expect(page.locator("#player-mini-progress")).toBeVisible();
    await page.locator("#player-view-menu").click();
    await expect(page.locator('.view-menu-row[data-panel="strip"]')).toHaveAttribute("aria-checked", "false");
    await page.locator('.view-menu-row[data-panel="readout"]').click();
    await page.locator("#player-view-menu").click();
    await expect(page.locator("#player-readout")).toBeVisible();
    await expect(page.locator("#player-chart-canvas")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("dc.viewer.panels"))).toBe(normalPreferences);

    // Browser-owned exit drives fullscreenchange without using our exit button.
    await page.evaluate(() => document.exitFullscreen());
    await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded/);
    await expect(page.locator("#player-chart-canvas")).toBeVisible();
    await expect(page.locator("#player-readout")).toBeHidden();
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "true");
    expect(await masterVideoTime(page)).toBeCloseTo(time, 2);
    await expect(page.locator(".video-tile.active")).toHaveAttribute("data-channel", camera ?? "");

    await enterFullscreen(page);
    await expect(page.locator("#player-chart-canvas")).toBeHidden();
    await expect(page.locator("#player-readout")).toBeVisible();
});

test("paused fullscreen keeps controls visible beyond the idle deadline", async ({ page }) => {
    await page.clock.install();
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await enterFullscreen(page);
    await moveAwayFromControls(page);
    // The idle deadline itself is under test.
    await page.clock.fastForward(1300);
    await expect(page.locator("#player-wrap")).toHaveClass(/controls-visible/);
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "true");
});

test("pinning and an open menu keep fullscreen controls available during playback", async ({ page }) => {
    await page.clock.install();
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await startLoopingPlayback(page);
    await enterFullscreen(page);
    const player = page.locator("#player-wrap");
    const pin = page.locator("#player-controls-pin");
    await expect(pin).toHaveAccessibleName("Keep controls visible");
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await expect(pin).toHaveAccessibleName("Keep controls visible");
    await moveAwayFromControls(page);
    await page.clock.fastForward(1300);
    await expect(player).toHaveClass(/controls-visible/);
    await pin.click();
    await moveAwayFromControls(page);
    await page.clock.fastForward(800);
    await expect(player).toHaveClass(/controls-visible/);
    await page.clock.fastForward(500);
    await expect(player).not.toHaveClass(/controls-visible/);
    await page.keyboard.press("Tab");
    await expect(player).toHaveClass(/controls-visible/);
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "false");
    await page.locator("#player-speed").click();
    await moveAwayFromControls(page);
    await page.clock.fastForward(1300);
    await expect(page.locator("#player-speed-menu")).toBeVisible();
    await expect(player).toHaveClass(/controls-visible/);
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "false");
});

for (const method of ["button", "shortcut"]) {
    test(`saving a clip by ${method} exits fullscreen into a visible editor`, async ({ page }) => {
        await gotoApp(page);
        await loadTrip(page, SAMPLE_70MAI);
        await pausePlayback(page);
        const time = await masterVideoTime(page);
        await enterFullscreen(page);
        if (method === "button") await page.locator("#player-export").click();
        else await page.keyboard.press("e");
        await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded/);
        await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
        await expect(page.locator("#export-panel")).toBeVisible();
        const panel = await boxOf(page, "#export-panel");
        expect(panel.x).toBeGreaterThanOrEqual(0);
        expect(panel.y + panel.height).toBeLessThanOrEqual(DESKTOP.height);
        expect(await masterVideoTime(page)).toBeCloseTo(time, 2);
    });
}

for (const mode of ["native button", "native shortcut", "viewport"]) {
    test(`the clip editor preserves its range and settings across ${mode} fullscreen`, async ({ page }) => {
        if (mode === "viewport") await disableNativeFullscreen(page);
        await gotoApp(page);
        await loadTrip(page, SAMPLE_70MAI);
        await pausePlayback(page);
        await page.locator("#player-export").click();
        const panel = page.locator("#export-panel");
        await expect(panel).toBeVisible();
        const start = page.locator('.export-trim-bar__input[data-range-edge="start"]');
        await start.fill("00:01");
        await start.press("Enter");
        const rangeStart = await start.inputValue();
        const quality = page.locator('.export-panel__radio input[value="low"]');
        await quality.check();
        const time = await masterVideoTime(page);
        await expect(page.locator("#player-fullscreen")).toBeEnabled();
        if (mode === "native shortcut") {
            await page.locator("#player-play").focus();
            await page.keyboard.press("f");
        } else {
            await activateFullscreenEntry(page);
        }
        const player = page.locator("#player-wrap");
        await expect(player).toHaveClass(/player-expanded/);
        await expect(panel).toBeHidden();
        await expect(page.locator("#export-trim-bar")).toBeHidden();
        const bounds = await boxOf(page, "#player-wrap");
        expect(bounds.x).toBe(0);
        expect(bounds.width).toBe(DESKTOP.width);
        expect(bounds.height).toBe(DESKTOP.height);
        if (mode !== "viewport") {
            await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe("player-wrap");
        }
        if (mode === "viewport") await page.keyboard.press("Escape");
        else if (mode === "native shortcut") await page.keyboard.press("f");
        else await page.locator("#player-fullscreen-exit").click();
        await expect(player).not.toHaveClass(/player-expanded/);
        await expect(panel).toBeVisible();
        await expect(page.locator("#export-trim-bar")).toBeVisible();
        await expect(start).toHaveValue(rangeStart);
        await expect(quality).toBeChecked();
        expect(await masterVideoTime(page)).toBeCloseTo(time, 2);
    });
}

test.describe("touch fullscreen", () => {
    test.use({ hasTouch: true, isMobile: true });

    for (const viewport of [MOBILE_LANDSCAPE, { width: 320, height: 568 }]) {
        test(`exit stays fully on screen at ${viewport.width} by ${viewport.height}`, async ({ page }) => {
            await page.setViewportSize(viewport);
            await gotoApp(page, "ru");
            await page.locator(".lang-banner-dismiss").click();
            await loadTrip(page, SAMPLE_70MAI);
            await pausePlayback(page);
            const entry = page.locator("#player-fullscreen");
            if (viewport.width === 320) {
                await expect(entry).toBeHidden();
                await expect(entry).toHaveAttribute("data-overflow-hidden", "true");
            }
            await expect(page.locator(".player-fullscreen-actions")).toBeHidden();
            await activateFullscreenEntry(page, true);
            await expect(page.locator("#player-wrap")).toHaveClass(/player-expanded/);
            await expect(entry).toBeHidden();
            const exit = await boxOf(page, "#player-fullscreen-exit");
            expect(exit.x).toBeGreaterThanOrEqual(0);
            expect(exit.y).toBeGreaterThanOrEqual(0);
            expect(exit.x + exit.width).toBeLessThanOrEqual(viewport.width);
            expect(exit.y + exit.height).toBeLessThanOrEqual(viewport.height);
            await expect(page.locator("#player-fullscreen-exit")).toHaveAccessibleName("Выйти из полного экрана");
            if (viewport.width === 320) {
                await page.locator("#player-overflow").tap();
                const menu = page.locator("#player-overflow-menu");
                await expect(menu).toBeVisible();
                await expect(menu.getByRole("button", { name: "На весь экран", exact: true })).toHaveCount(0);
            }
            await page.locator("#player-fullscreen-exit").tap();
            await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded/);
            await expect(page.locator(".player-fullscreen-actions")).toBeHidden();
            await expect(page.locator("#player-overflow-menu")).toBeHidden();
            const returnFocus = (await entry.isVisible()) ? entry : page.locator("#player-overflow");
            await expect(returnFocus).toBeFocused();
            if (viewport.width === 320) {
                await activateFullscreenEntry(page, true);
                await expect(page.locator("#player-wrap")).toHaveClass(/player-expanded/);
                await page.locator("#player-fullscreen-exit").tap();
                await expect(returnFocus).toBeFocused();
            }
        });
    }

    test("the first tap reveals hidden controls without pausing the recording", async ({ page }) => {
        await page.clock.install();
        await page.setViewportSize(MOBILE_LANDSCAPE);
        await gotoApp(page);
        // A single-camera tap normally toggles playback; multichannel taps only route audio.
        // Keep clip endings outside the idle-controls interaction under test.
        await page
            .locator("#file-input")
            .setInputFiles(
                fileURLToPath(
                    new URL(
                        "../testdata/asymmetric-channels/ExteriorView/260101/120000_123_025_D.mp4",
                        import.meta.url,
                    ),
                ),
            );
        await page.locator("li.trip:not(.unindexed-note)").first().click();
        await startLoopingPlayback(page);
        await activateFullscreenEntry(page, true);
        const player = page.locator("#player-wrap");
        await expect(player).toHaveClass(/player-expanded/);
        // Expansion can place controls under the setup's synthetic mouse pointer.
        await moveAwayFromControls(page);
        await page.clock.fastForward(1300);
        await expect(player).not.toHaveClass(/controls-visible/);
        const video = await boxOf(page, ".video-tile.active");
        await page.touchscreen.tap(video.x + video.width / 2, video.y + video.height / 2);
        await expect(player).toHaveClass(/controls-visible/);
        await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "false");
        await page.clock.fastForward(1300);
        await expect(player).not.toHaveClass(/controls-visible/);
        await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "false");
    });
});

test("a browser without fullscreen offers an expanded player with button and Escape exits", async ({ page }) => {
    await disableNativeFullscreen(page);
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    const player = page.locator("#player-wrap");
    const button = page.locator("#player-fullscreen");
    const exit = page.locator("#player-fullscreen-exit");
    await expect(button).toHaveAccessibleName("Expand player");
    await button.click();
    await expect(player).toHaveClass(/player-expanded/);
    await expect(button).toBeHidden();
    await expect(exit).toHaveAccessibleName("Back to viewer");
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    const expanded = await boxOf(page, "#player-wrap");
    expect(expanded.x).toBe(0);
    expect(expanded.y).toBe(0);
    expect(expanded.width).toBe(DESKTOP.width);
    expect(expanded.height).toBe(DESKTOP.height);
    await page.keyboard.press("Escape");
    await expect(player).not.toHaveClass(/player-expanded/);
    await expect(button).toBeFocused();
    await button.click();
    await expect(player).toHaveClass(/player-expanded/);
    await exit.click();
    await expect(player).not.toHaveClass(/player-expanded/);
    await expect(button).toHaveAccessibleName("Expand player");
    await expect(button).toBeFocused();
    await expect(page.locator(".player-fullscreen-actions")).toBeHidden();
});

test("a rejected fullscreen request leaves the viewer usable and explains how to retry", async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(Element.prototype, "requestFullscreen", {
            configurable: true,
            value: () => Promise.reject(new DOMException("fullscreen request denied", "NotAllowedError")),
        });
    });
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await page.locator("#player-fullscreen").click();
    await expect(page.locator("#toast-container")).toContainText("Couldn’t open full screen. Try again.");
    await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded/);
    await expect(page.locator("#player-fullscreen")).toHaveAccessibleName("Full screen");
    await expect(page.locator("#player-chart-canvas")).toBeVisible();
    await expect(page.locator("#player-readout")).toBeVisible();
    await page.locator("#player-play").click();
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "false");
});

test("a rejected exit keeps controls available and prevents a hidden clip editor", async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(Document.prototype, "exitFullscreen", {
            configurable: true,
            value: () => Promise.reject(new DOMException("fullscreen exit denied", "InvalidStateError")),
        });
    });
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await enterFullscreen(page);
    await page.locator("#player-fullscreen-exit").click();
    await expect(page.locator("#player-fullscreen-hint")).toHaveText("Couldn’t leave full screen. Try again.");
    await expect(page.locator("#player-wrap")).toHaveClass(/player-expanded/);
    await expect(page.locator("#player-wrap")).toHaveClass(/controls-visible/);
    await page.keyboard.press("e");
    await expect(page.locator("#export-panel")).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe("player-wrap");
    await setPanelsBelow(page, true);
    await page.locator("#player-fullscreen-exit").click();
    await expect(page.locator("#player-fullscreen-hint")).toBeVisible();
    await expect(page.locator("#player-fullscreen-hint")).toHaveText("Couldn’t leave full screen. Try again.");
    await expect(page.locator("#player-wrap")).toHaveClass(/player-panels-below/);
});

test("double-clicking another camera changes fullscreen without changing playback or audio", async ({ page }) => {
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    const audio = page.locator(".top-panel__audio-select");
    const camera = await audio.inputValue();
    expect(camera).not.toBe("rear");
    const time = await masterVideoTime(page);
    const rear = page.locator('.video-tile[data-channel="rear"] video:not(.preload-slot):not(.tile-blur-bg)');
    await rear.dblclick();
    await expect(page.locator("#player-wrap")).toHaveClass(/player-expanded/);
    // Survive the single-click delay so a deferred audio swap cannot pass unnoticed.
    await page.waitForTimeout(350);
    await expect(audio).toHaveValue(camera);
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "true");
    expect(await masterVideoTime(page)).toBeCloseTo(time, 2);
    await rear.dblclick();
    await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded/);
    await page.waitForTimeout(350);
    await expect(audio).toHaveValue(camera);
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "true");
});

test("expanded fallback contains modal focus and restores the viewer scroll and focus", async ({ page }) => {
    await disableNativeFullscreen(page);
    await page.setViewportSize({ width: 600, height: 390 });
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    const viewer = page.locator(".viewer");
    await viewer.evaluate((element) => {
        element.scrollTop = 120;
    });
    await page.locator("#player-speed").focus();
    const scrollTop = await viewer.evaluate((element) => element.scrollTop);
    expect(scrollTop, "the viewer must have a real scroll position to restore").toBeGreaterThan(0);
    await page.keyboard.press("f");
    const player = page.locator("#player-wrap");
    await expect(player).toHaveClass(/player-expanded/);
    await page.locator("#player-controls-pin").focus();
    await page.keyboard.press("Shift+Tab");
    expect(await player.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("?");
    const modal = page.locator("#hotkeys-modal");
    await expect(modal).toBeVisible();
    await expect(player.locator("#hotkeys-modal")).toBeVisible();
    await page.keyboard.press("Tab");
    expect(await modal.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    await expect(player).toHaveClass(/player-expanded/);
    await page.keyboard.press("Escape");
    await expect(player).not.toHaveClass(/player-expanded/);
    await expect(page.locator("#player-speed")).toBeFocused();
    expect(await viewer.evaluate((element) => element.scrollTop)).toBeCloseTo(scrollTop, 0);
});

test("expanded fallback isolates fixed banners while an existing GPS dialog stays interactive", async ({ page }) => {
    await disableNativeFullscreen(page);
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await page.locator("#gps-sync-pill").click();
    const dialog = page.locator("#gps-sync-modal");
    await expect(dialog).toHaveClass(/is-modeless/);
    const banner = page.locator("#support-banner");
    await banner.evaluate((element: HTMLElement) => {
        element.hidden = false;
    });
    await expect(banner).toHaveCSS("position", "fixed");
    await expect(banner).toBeVisible();
    const close = page.locator("#support-banner-close");
    // Role locators infer semantics from the DOM and still match inert nodes.
    const accessibility = await page.context().newCDPSession(page);
    const accessibleCopyCount = async (): Promise<number> => {
        const { nodes } = await accessibility.send("Accessibility.getFullAXTree");
        return nodes.filter(
            (node) => !node.ignored && node.role?.value === "button" && node.name?.value === "Copy link",
        ).length;
    };
    await expect.poll(accessibleCopyCount).toBe(1);
    const topbar = page.locator(".topbar");
    await topbar.evaluate((element: HTMLElement) => {
        element.inert = true;
    });

    await page.locator("#player-fullscreen").click();
    const player = page.locator("#player-wrap");
    await expect(player).toHaveClass(/player-expanded/);
    await expect(banner).toHaveAttribute("inert", "");
    await expect.poll(accessibleCopyCount).toBe(0);
    await expect(player.locator("#gps-sync-modal")).toBeVisible();
    await expect(dialog).not.toHaveAttribute("inert");
    const timezone = page.locator("#gps-sync-timezone-select");
    await expect(timezone).toBeFocused();
    await page.locator("#support-banner-close").evaluate((element) => element.focus());
    await expect(timezone).toBeFocused();
    const offset = page.locator("#gps-sync-offset-input");
    await offset.fill("1");
    await offset.press("Enter");
    await expect(page.locator("#gps-sync-reset")).toBeEnabled();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(player).toHaveClass(/player-expanded/);
    await page.keyboard.press("Escape");
    await expect(player).not.toHaveClass(/player-expanded/);
    await expect(banner).not.toHaveAttribute("inert");
    await expect(topbar).toHaveAttribute("inert", "");
    await expect.poll(accessibleCopyCount).toBe(1);
    await close.click();
    await expect(banner).toBeHidden();
    await accessibility.detach();
});

test("fallback Escape closes each open player menu before leaving the expanded view", async ({ page }) => {
    await disableNativeFullscreen(page);
    await page.setViewportSize({ width: 320, height: 568 });
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await activateFullscreenEntry(page);
    const player = page.locator("#player-wrap");
    await expect(player).toHaveClass(/player-expanded/);
    const speed = page.locator("#player-speed");
    await speed.click();
    await expect(page.locator("#player-speed-menu")).toBeVisible();
    // Escape from the trigger must also respect the open menu.
    await speed.focus();
    await page.keyboard.press("Escape");
    await expect(page.locator("#player-speed-menu")).toBeHidden();
    await expect(speed).toBeFocused();
    await expect(player).toHaveClass(/player-expanded/);
    await page.locator("#player-overflow").click();
    await expect(page.locator("#player-overflow-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#player-overflow-menu")).toBeHidden();
    await expect(player).toHaveClass(/player-expanded/);
    await page.keyboard.press("Escape");
    await expect(player).not.toHaveClass(/player-expanded/);
    await expect(page.locator("#player-overflow")).toBeFocused();
});

test("video above panels preserves the recording and remembers either choice after reload", async ({ page }) => {
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await page.locator(".top-panel__audio-select").selectOption("rear");
    const master = page.locator(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)");
    await master.hover();
    await page.mouse.wheel(0, -120);
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.videoZoom.scale)).toBeGreaterThan(1);
    const context = await page.evaluate(() => ({
        composition: window.__everydashcam.state.composition,
        zoom: window.__everydashcam.state.videoZoom.scale,
        preferences: localStorage.getItem("dc.viewer.panels"),
    }));
    const time = await masterVideoTime(page);
    const videos = await page.evaluateHandle(() =>
        [...document.querySelectorAll<HTMLVideoElement>("#video-grid video")].map((video) => ({
            video,
            src: video.currentSrc,
        })),
    );
    await page.locator("#player-view-menu").click();
    await expect(page.locator("[data-fullscreen-panels-below]")).toBeHidden();
    await page.keyboard.press("Escape");
    await enterFullscreen(page);
    await expect(page.locator("#player-wrap")).not.toHaveClass(/player-panels-below/);
    await setPanelsBelow(page, true);
    await expectPanelsBelowGeometry(page);
    await expect(page.locator("#player-chart-canvas")).toBeHidden();
    await expect(page.locator("#player-readout")).toBeHidden();
    expect(
        await videos.evaluate((original) =>
            original.every(({ video, src }) => video.isConnected && video.currentSrc === src),
        ),
    ).toBe(true);
    expect(
        await page.evaluate(() => ({
            composition: window.__everydashcam.state.composition,
            zoom: window.__everydashcam.state.videoZoom.scale,
            preferences: localStorage.getItem("dc.viewer.panels"),
        })),
    ).toEqual(context);
    expect(await masterVideoTime(page)).toBeCloseTo(time, 2);
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "true");

    await page.evaluate(() => document.exitFullscreen());
    await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded|player-panels-below/);
    await enterFullscreen(page);
    await expectPanelsBelowGeometry(page);
    await page.locator("#player-fullscreen-exit").click();
    await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded/);
    await enterFullscreen(page);
    await expectPanelsBelowGeometry(page);
    await page.keyboard.press("f");
    await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded/);
    await page.reload();
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await enterFullscreen(page);
    await expectPanelsBelowGeometry(page);
    await page.locator("#player-view-menu").click();
    await expect(page.locator("[data-fullscreen-panels-below]")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await setPanelsBelow(page, false);
    await page.locator("#player-fullscreen-exit").click();
    await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded/);
    await page.reload();
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await enterFullscreen(page);
    await expect(page.locator("#player-wrap")).not.toHaveClass(/player-panels-below/);
    await page.locator("#player-view-menu").click();
    await expect(page.locator("[data-fullscreen-panels-below]")).toHaveAttribute("aria-checked", "false");
});

for (const storage of ["invalid", "blocked"] as const) {
    test(`video above panels stays usable when its stored preference is ${storage}`, async ({ page }) => {
        await page.addInitScript((storage) => {
            const key = "everydashcam:player:panelsBelow";
            if (storage === "invalid") {
                localStorage.setItem(key, "true");
                return;
            }
            const read = Storage.prototype.getItem;
            const write = Storage.prototype.setItem;
            Storage.prototype.getItem = function (name) {
                if (name === key) throw new DOMException("storage is blocked", "SecurityError");
                return read.call(this, name);
            };
            Storage.prototype.setItem = function (name, value) {
                if (name === key) throw new DOMException("storage is blocked", "SecurityError");
                write.call(this, name, value);
            };
        }, storage);
        await gotoApp(page);
        await loadTrip(page, SAMPLE_70MAI);
        await pausePlayback(page);
        await enterFullscreen(page);
        await expect(page.locator("#player-wrap")).not.toHaveClass(/player-panels-below/);
        await page.locator("#player-view-menu").click();
        await expect(page.locator("[data-fullscreen-panels-below]")).toHaveAttribute("aria-checked", "false");
        await page.keyboard.press("Escape");
        await setPanelsBelow(page, true);
        await expectPanelsBelowGeometry(page);
        await page.locator("#player-fullscreen-exit").click();
        await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded/);
        await enterFullscreen(page);
        await expectPanelsBelowGeometry(page);
        if (storage === "blocked") {
            await page.locator("#player-fullscreen-exit").click();
            await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded/);
            await page.reload();
            await loadTrip(page, SAMPLE_70MAI);
            await pausePlayback(page);
            await enterFullscreen(page);
            await expect(page.locator("#player-wrap")).not.toHaveClass(/player-panels-below/);
        }
    });
}

test("video above panels keeps stable geometry through playback and restores pinning and idle controls", async ({
    page,
}) => {
    await page.clock.install();
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await startLoopingPlayback(page);
    await enterFullscreen(page);
    const player = page.locator("#player-wrap");
    const pin = page.locator("#player-controls-pin");
    await pin.click();
    await setPanelsBelow(page, true);
    await expectPanelsBelowGeometry(page);
    const frame = await boxOf(page, ".video-frame");
    const expectStable = async (): Promise<void> => {
        await expect(player).toHaveClass(/controls-visible/);
        await expect(player).not.toHaveCSS("cursor", "none");
        const current = await boxOf(page, ".video-frame");
        for (const key of ["x", "y", "width", "height"] as const) expect(current[key]).toBeCloseTo(frame[key], 1);
    };
    await moveAwayFromControls(page);
    await page.clock.fastForward(1300);
    await expectStable();
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "false");
    await page.locator("#player-play").click();
    await expectStable();
    await page.mouse.move(frame.x + 10, frame.y + 10);
    await page.clock.fastForward(1300);
    await expectStable();
    await page.locator("#player-play").click();
    await expectStable();
    await setPanelsBelow(page, false);
    await expect(pin).toBeVisible();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await expect(player).toHaveClass(/controls-visible/);
    await pin.click();
    await moveAwayFromControls(page);
    await page.clock.fastForward(1300);
    await expect(player).not.toHaveClass(/controls-visible/);
});

for (const viewport of [DESKTOP, { width: 320, height: 568 }, { width: 844, height: 300 }]) {
    test(`video above panels fits selected panels and a large map at ${viewport.width} by ${viewport.height}`, async ({
        page,
    }, info) => {
        await page.setViewportSize(viewport);
        const safeArea = viewport.width === 320 ? await page.context().newCDPSession(page) : null;
        await safeArea?.send("Emulation.setSafeAreaInsetsOverride", {
            insets: { top: 20, bottom: 24, left: 8, right: 8 },
        });
        await disableNativeFullscreen(page);
        await gotoApp(page);
        await loadTrip(page, SAMPLE_70MAI);
        await pausePlayback(page);
        await activateFullscreenEntry(page);
        await setPanelsBelow(page, true);
        await expectPanelsBelowGeometry(page);
        const initial = await boxOf(page, ".video-frame");
        const initialPanelContent = await page.locator(".player-panels").evaluate((element) => element.scrollHeight);
        await page.locator("#player-view-menu").click();
        for (const panel of ["chart", "strip", "readout"]) {
            const row = page.locator(`.view-menu-row[data-panel="${panel}"]`);
            await expect(row).toHaveAttribute("aria-checked", "false");
            await row.click();
            await expect(row).toHaveAttribute("aria-checked", "true");
        }
        await page.keyboard.press("Escape");
        await expectPanelsBelowGeometry(page);
        await expect(page.locator("#player-chart-canvas")).toBeVisible();
        await expect(page.locator("#player-readout")).toBeVisible();
        const withPanels = await boxOf(page, ".video-frame");
        expect(withPanels.height, "selected panels never enlarge the video area").toBeLessThanOrEqual(initial.height);
        expect(
            await page.locator(".player-panels").evaluate((element) => element.scrollHeight),
            "selected panels reserve space",
        ).toBeGreaterThan(initialPanelContent);
        await page.locator("#player-view-menu").click();
        await page.locator('[data-map-mode="large"]').click();
        await page.keyboard.press("Escape");
        await expect(page.locator("#player-wrap")).toHaveClass(/map-expanded/);
        await expect(page.locator("body")).not.toHaveClass(/map-morphing/);
        await expectPanelsBelowGeometry(page);
        await expect(page.locator(".map-wrap")).toBeVisible();
        const map = await boxOf(page, ".map-wrap");
        const frame = await boxOf(page, ".video-frame");
        const overlapWidth = Math.min(map.x + map.width, frame.x + frame.width) - Math.max(map.x, frame.x);
        const overlapHeight = Math.min(map.y + map.height, frame.y + frame.height) - Math.max(map.y, frame.y);
        expect(Math.min(overlapWidth, overlapHeight), "large map has a separate area").toBeLessThanOrEqual(1);
        if (safeArea) {
            for (const selector of ["#player-play", "#player-view-menu", "#player-fullscreen-exit"]) {
                const bounds = await boxOf(page, selector);
                expect(bounds.x, `${selector} clears the left safe area`).toBeGreaterThanOrEqual(8);
                expect(bounds.y, `${selector} clears the top safe area`).toBeGreaterThanOrEqual(20);
                expect(bounds.x + bounds.width, `${selector} clears the right safe area`).toBeLessThanOrEqual(
                    viewport.width - 8,
                );
                expect(bounds.y + bounds.height, `${selector} clears the bottom safe area`).toBeLessThanOrEqual(
                    viewport.height - 24,
                );
            }
        }
        if (viewport.height === 300) {
            const panels = page.locator(".player-panels");
            expect(await panels.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
            await panels.evaluate((element) => {
                element.scrollTop = element.scrollHeight;
            });
            await expectPanelsBelowGeometry(page);
            const scrubber = await boxOf(page, "#player-mini-progress");
            expect(
                await page.evaluate(
                    ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest("#player-mini-progress")),
                    {
                        x: scrubber.x + scrubber.width / 2,
                        y: scrubber.y + scrubber.height / 2,
                    },
                ),
                "scrolled panels leave the scrubber reachable",
            ).toBe(true);
        }
        await page.screenshot({ path: info.outputPath("video-above-panels.png") });
        await page.keyboard.press("Escape");
        await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded/);
        await safeArea?.detach();
    });
}

test("video above panels preserves editor range, composition, overlays, crop and blur editing", async ({ page }) => {
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await page.locator("#player-export").click();
    const start = page.locator('.export-trim-bar__input[data-range-edge="start"]');
    const end = page.locator('.export-trim-bar__input[data-range-edge="end"]');
    await start.fill("00:01");
    await start.press("Enter");
    await end.fill("00:03");
    await end.press("Enter");
    const range = [await start.inputValue(), await end.inputValue()];
    await page.locator('.export-panel__radio input[value="low"]').check();
    await page.locator(".top-panel__audio-select").selectOption("rear");
    await page.locator("#export-panel-ov-speed").check();
    await page.locator("#export-panel-ov-coords").check();
    await page.locator('.video-tile[data-channel="front"]').dblclick();
    await expect(page.locator(".crop-editor")).toBeVisible();
    await page.locator('.crop-aspect-btn[data-preset="1:1"]').click();
    await page.locator(".crop-done-btn").click();
    await page.locator(".export-panel__blur-add-btn").click();
    const draw = await boxOf(page, '.video-tile[data-channel="front"] .blur-draw-layer');
    await page.mouse.move(draw.x + draw.width * 0.4, draw.y + draw.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(draw.x + draw.width * 0.6, draw.y + draw.height * 0.6, { steps: 6 });
    await page.mouse.up();
    const blur = page.locator('.video-tile[data-channel="front"] .blur-box:not([hidden])');
    await expect(blur).toBeVisible();
    const composition = await page.evaluate(() => window.__everydashcam.state.composition);
    const time = await masterVideoTime(page);
    await enterFullscreen(page);
    await setPanelsBelow(page, true);
    await expectPanelsBelowGeometry(page);
    await expect(page.locator("#export-panel")).toBeHidden();
    await expect(page.locator("#export-trim-bar")).toBeHidden();
    await expect(page.locator("#player-speed-overlay")).toBeVisible();
    await expect(page.locator("#player-coords-overlay")).toBeVisible();
    await expect(blur).toBeVisible();
    const overlay = await boxOf(page, "#player-overlay-frame");
    const grid = await boxOf(page, "#video-grid");
    expect(overlay.width).toBeCloseTo(grid.width, 0);
    expect(overlay.height).toBeCloseTo(grid.height, 0);
    await setPanelsBelow(page, false);
    await setPanelsBelow(page, true);
    expect(await page.evaluate(() => window.__everydashcam.state.composition)).toEqual(composition);
    expect(await masterVideoTime(page)).toBeCloseTo(time, 2);
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "true");
    // The center belongs to the blur box, whose double-click keeps editing blur.
    await page.locator('.video-tile[data-channel="front"]').dblclick({ position: { x: 40, y: 40 } });
    await expect(page.locator(".crop-editor")).toBeVisible();
    const handle = await boxOf(page, ".crop-handle--br");
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 30, handle.y - 30, { steps: 6 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.__everydashcam.state.composition)).not.toEqual(composition);
    await page.locator(".crop-done-btn").click();
    await expect(blur).toBeVisible();
    const beforeBlur = await blur.boundingBox();
    expect(beforeBlur).not.toBeNull();
    await blur.hover();
    await page.mouse.down();
    await page.mouse.move(beforeBlur!.x + beforeBlur!.width / 2 + 20, beforeBlur!.y + beforeBlur!.height / 2, {
        steps: 6,
    });
    await page.mouse.up();
    await expect.poll(async () => (await blur.boundingBox())!.x).not.toBeCloseTo(beforeBlur!.x, 0);
    await page.locator('.video-tile[data-channel="interior"]').click();
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.composition.audioChannel)).toBe("interior");
    const editedComposition = await page.evaluate(() => window.__everydashcam.state.composition);
    const readBlurPlacement = () =>
        blur.evaluate((element) => {
            const tile = element.closest<HTMLElement>(".video-tile")!;
            const video = tile.querySelector<HTMLVideoElement>("video:not(.preload-slot):not(.tile-blur-bg)")!;
            const composition = window.__everydashcam.state.composition;
            const crop = composition.perSlotCrops[composition.channelOrder.indexOf("front")]!;
            const aspect = ((video.videoWidth / video.videoHeight) * crop.wPct) / crop.hPct;
            const tileRect = tile.getBoundingClientRect();
            const rect = element.getBoundingClientRect();
            const width = Math.min(tileRect.width, tileRect.height * aspect);
            const height = width / aspect;
            return {
                x: (rect.x - tileRect.x - (tileRect.width - width) / 2) / width,
                y: (rect.y - tileRect.y - (tileRect.height - height) / 2) / height,
                width: rect.width / width,
                height: rect.height / height,
            };
        });
    const editedBlur = await readBlurPlacement();
    await page.locator("#player-fullscreen-exit").click();
    await expect(page.locator("#export-panel")).toBeVisible();
    await expect(start).toHaveValue(range[0]!);
    await expect(end).toHaveValue(range[1]!);
    await expect(page.locator('.export-panel__radio input[value="low"]')).toBeChecked();
    await expect(page.locator("#export-panel-ov-speed")).toBeChecked();
    await expect(page.locator("#export-panel-ov-coords")).toBeChecked();
    expect(await page.evaluate(() => window.__everydashcam.state.composition)).toEqual(editedComposition);
    // ResizeObserver schedules blur geometry for the next animation frame;
    // the export controls can already be visible before that paint completes.
    await expect.poll(readBlurPlacement).toEqual({
        x: expect.closeTo(editedBlur.x, 2),
        y: expect.closeTo(editedBlur.y, 2),
        width: expect.closeTo(editedBlur.width, 2),
        height: expect.closeTo(editedBlur.height, 2),
    });
    await page.locator(".export-panel__crop-btn").click();
    await expect(page.locator(".crop-editor")).toBeVisible();
});

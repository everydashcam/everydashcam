import type { Page } from "@playwright/test";
import {
    DESKTOP,
    MOBILE,
    MOBILE_LANDSCAPE,
    boxOf,
    expect,
    gotoApp,
    loadTrip,
    pausePlayback,
    presetLocalStorage,
    shot,
    test,
} from "./_fixtures.js";
import { expectResetHitArea } from "./_pointer-gestures.js";

test.use({ viewerMap: "route-only", reducedMotion: "reduce" });

const zoomScale = (page: Page) => page.evaluate(() => window.__everydashcam.state.videoZoom.scale);

async function zoomVideo(page: Page): Promise<void> {
    const video = page.locator(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)");
    await video.scrollIntoViewIfNeeded();
    // Find exposed video, since the map and camera thumbnails occupy different
    // parts of the frame on narrow, wide and fullscreen layouts.
    const point = await video.evaluate((element) => {
        const tile = element.parentElement!.getBoundingClientRect();
        for (const [fx, fy] of [
            [0.5, 0.7],
            [0.5, 0.5],
            [0.25, 0.8],
            [0.75, 0.5],
        ]) {
            const x = tile.left + tile.width * fx!;
            const y = tile.top + tile.height * fy!;
            if (document.elementFromPoint(x, y) === element) return { x, y };
        }
        return null;
    });
    expect(point, "the active video has an exposed zoom target").not.toBeNull();
    await page.mouse.move(point!.x, point!.y);
    // Narrow layouts deliberately reserve an unmodified wheel for page scroll.
    await page.keyboard.down("Control");
    try {
        await page.mouse.wheel(0, -240);
    } finally {
        await page.keyboard.up("Control");
    }
    await expect.poll(() => zoomScale(page)).toBeGreaterThan(1);
    await expectResetHitArea(page.locator(".zoom-badge"));
    // Reset detaches the duplicate decoder; wait for its first frame before
    // reviewing another zoom screenshot, especially with WebKit's async load.
    await expect
        .poll(() =>
            page.locator("#video-minimap-video").evaluate((preview: HTMLVideoElement) => {
                const master = document.querySelector<HTMLVideoElement>(
                    ".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)",
                )!;
                return (
                    preview.readyState >= 2 &&
                    !preview.seeking &&
                    Math.abs(preview.currentTime - master.currentTime) < 0.1
                );
            }),
        )
        .toBe(true);
}

async function resetAtEdge(page: Page, edge: "right" | "bottom", touch = false): Promise<void> {
    const reset = page.locator(".zoom-badge");
    await expectResetHitArea(reset);
    const box = await boxOf(page, ".zoom-badge");
    const position =
        edge === "right" ? { x: box.width - 2, y: box.height / 2 } : { x: box.width / 2, y: box.height - 2 };
    if (touch) await reset.tap({ position });
    else await reset.click({ position });
    await expect.poll(() => zoomScale(page)).toBe(1);
    await expect(reset).toHaveCount(0);
}

test("zoom reset edges stay reachable with a default, dragged and restored GPS map", { tag: "@webkit-ui" }, async ({
    page,
    browserName,
}) => {
    await page.setViewportSize(DESKTOP);
    await presetLocalStorage(page, { theme: "dark" });
    await gotoApp(page, "en");
    await loadTrip(page);
    await pausePlayback(page);
    const map = page.locator("#mini-map");
    await expect(map).toBeVisible();

    await zoomVideo(page);
    await shot(page, `zoom-reset-desktop-default-${browserName}`);
    await resetAtEdge(page, "bottom");
    await zoomVideo(page);

    const before = await boxOf(page, "#mini-map");
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 35, { steps: 6 });
    await page.mouse.up();
    const moved = await boxOf(page, "#mini-map");
    expect(moved.x - before.x, "the GPS map remains draggable while zoomed").toBeCloseTo(60, 0);
    expect(moved.y - before.y).toBeCloseTo(35, 0);
    await expect(page.locator("#player-wrap")).not.toHaveClass(/map-expanded/);
    await resetAtEdge(page, "right");

    await page.reload();
    await loadTrip(page);
    await pausePlayback(page);
    await expect.poll(async () => (await boxOf(page, "#mini-map")).x).toBeCloseTo(moved.x, 0);
    await expect.poll(async () => (await boxOf(page, "#mini-map")).y).toBeCloseTo(moved.y, 0);
    await zoomVideo(page);
    await shot(page, `zoom-reset-desktop-restored-${browserName}`);

    // Raising the reset control must leave the map's own controls usable.
    await map.click();
    await expect(page.locator("#player-wrap")).toHaveClass(/map-expanded/);
    await page.locator("#map-collapse").click();
    await expect(map).toBeVisible();
    await expectResetHitArea(page.locator(".zoom-badge"));
    await page.locator("#mini-map-close").click();
    await expect(map).toBeHidden();
    await resetAtEdge(page, "bottom");
});

test.describe("touch layouts", () => {
    test.use({ hasTouch: true });

    test("Russian tablet reset stays tappable after entering and leaving fullscreen", { tag: "@webkit-ui" }, async ({
        page,
        browserName,
    }) => {
        await page.setViewportSize({ width: 1024, height: 768 });
        await presetLocalStorage(page, {
            theme: "light",
            preferences: { "everydashcam:sidebar-width": "390" },
        });
        await gotoApp(page, "ru");
        await loadTrip(page);
        await pausePlayback(page);
        await zoomVideo(page);
        await expect(page.locator(".zoom-badge")).toHaveAccessibleName("Сбросить зум");
        const reset = await boxOf(page, ".zoom-badge");
        expect(reset.height, "tablet reset keeps a full touch target").toBeGreaterThanOrEqual(44);
        await shot(page, `zoom-reset-tablet-ru-light-${browserName}`);
        await resetAtEdge(page, "right", true);

        // The public shortcut works even when the entry button is in overflow.
        await page.keyboard.press("f");
        await expect(page.locator("#player-wrap")).toHaveClass(/player-expanded/);
        await zoomVideo(page);
        await shot(page, `zoom-reset-tablet-fullscreen-${browserName}`);
        await resetAtEdge(page, "bottom", true);
        await page.locator("#player-fullscreen-exit").tap();
        await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded/);
        await zoomVideo(page);
        await resetAtEdge(page, "bottom", true);
    });

    test("phone reset stays tappable in portrait and short landscape", { tag: "@webkit-ui" }, async ({
        page,
        browserName,
    }) => {
        await page.setViewportSize(MOBILE);
        await presetLocalStorage(page, { theme: "dark" });
        await gotoApp(page, "en");
        await loadTrip(page);
        await pausePlayback(page);
        for (const [name, viewport] of [
            ["portrait", MOBILE],
            ["landscape", MOBILE_LANDSCAPE],
        ] as const) {
            await page.setViewportSize(viewport);
            await expect(page.locator("#mini-map")).toBeHidden();
            await zoomVideo(page);
            const reset = await boxOf(page, ".zoom-badge");
            expect(reset.height, "phone reset keeps a full touch target").toBeGreaterThanOrEqual(44);
            await shot(page, `zoom-reset-phone-${name}-${browserName}`);
            await resetAtEdge(page, "bottom", true);
        }
    });
});

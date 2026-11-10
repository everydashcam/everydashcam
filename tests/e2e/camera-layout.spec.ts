// Camera layout in the viewer: the two arrangement modes, the divider between
// the main camera and the smaller ones, overlay windows, the V/N/Shift+N shortcuts,
// placeholders for a camera without footage, and the phone frame height.

import type { Page } from "@playwright/test";
import { createMseFixture } from "../helpers/mse-fixtures.js";
import {
    DESKTOP,
    MOBILE,
    MOBILE_LANDSCAPE,
    SAMPLE_70MAI,
    SAMPLE_NOGPS,
    boxOf,
    expect,
    gotoApp,
    loadTrip,
    pausePlayback,
    presetLocalStorage,
    shot,
    test,
} from "./_fixtures.js";
import {
    chooseArrangementMode,
    closeCamerasMenu,
    makeMainFromMenu,
    openCamerasMenu,
    setOverlayAllowed,
    visibleCameraOrder,
} from "./_cameras.js";

interface TileBox {
    channel: string;
    role: string;
    overlay: boolean;
    absent: boolean;
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Visible tiles relative to the grid's top-left corner. */
async function tileBoxes(page: Page): Promise<TileBox[]> {
    return page.locator("#video-grid > .video-tile:not([hidden])").evaluateAll((tiles: HTMLElement[]) => {
        const grid = tiles[0]!.parentElement!.getBoundingClientRect();
        return tiles.map((tile) => {
            const r = tile.getBoundingClientRect();
            return {
                channel: tile.dataset.channel ?? "",
                role: tile.dataset.role ?? "",
                overlay: tile.classList.contains("tile-overlay"),
                absent: tile.classList.contains("tile-absent"),
                x: r.x - grid.x,
                y: r.y - grid.y,
                w: r.width,
                h: r.height,
            };
        });
    });
}

function overlapArea(a: TileBox, b: TileBox): number {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

function expectNoOverlap(boxes: TileBox[]): void {
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            expect(overlapArea(boxes[i]!, boxes[j]!), `${boxes[i]!.channel} and ${boxes[j]!.channel}`).toBeLessThan(1);
        }
    }
}

async function expectInsideGrid(page: Page, boxes: TileBox[]): Promise<void> {
    const grid = await boxOf(page, "#video-grid");
    for (const b of boxes) {
        expect(b.x, `${b.channel} left`).toBeGreaterThanOrEqual(-0.5);
        expect(b.y, `${b.channel} top`).toBeGreaterThanOrEqual(-0.5);
        expect(b.x + b.w, `${b.channel} right`).toBeLessThanOrEqual(grid.width + 0.5);
        expect(b.y + b.h, `${b.channel} bottom`).toBeLessThanOrEqual(grid.height + 0.5);
    }
}

function expectNear(actual: number, expected: number, label: string, tolerance = 2): void {
    expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
}

function thumbSize(boxes: TileBox[], strip: string | null): number {
    const thumb = boxes.find((b) => b.role === "thumb")!;
    return strip === "right" ? thumb.w : thumb.h;
}

test.describe("camera layout on a three-camera trip", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
        await gotoApp(page);
        await loadTrip(page, SAMPLE_70MAI);
        await pausePlayback(page);
    });

    test("main mode gives the main camera the most room with the others beside it", async ({ page }) => {
        const grid = page.locator("#video-grid");
        await expect(grid).toHaveAttribute("data-mode", "main");
        expect(["bottom", "right"]).toContain(await grid.getAttribute("data-strip"));
        const boxes = await tileBoxes(page);
        expect(boxes).toHaveLength(3);
        expectNoOverlap(boxes);
        await expectInsideGrid(page, boxes);
        const main = boxes.find((b) => b.role === "main")!;
        expect(main.channel).toBe((await visibleCameraOrder(page))[0]);
        for (const thumb of boxes.filter((b) => b.role === "thumb")) {
            expect(main.w * main.h, `main is larger than ${thumb.channel}`).toBeGreaterThan(thumb.w * thumb.h * 4);
            expect(thumb.overlay).toBe(false);
        }
        await shot(page, "camera-layout-01-main");
    });

    test("equal mode gives every camera the same size; V switches back", async ({ page }) => {
        await chooseArrangementMode(page, "equal");
        const boxes = await tileBoxes(page);
        expect(boxes.map((b) => b.role)).toEqual(["equal", "equal", "equal"]);
        expectNoOverlap(boxes);
        await expectInsideGrid(page, boxes);
        for (const b of boxes) {
            expectNear(b.w, boxes[0]!.w, `${b.channel} width`);
            expectNear(b.h, boxes[0]!.h, `${b.channel} height`);
        }
        await expect(page.locator(".camera-divider")).toBeHidden();
        await shot(page, "camera-layout-02-equal");

        await page.keyboard.press("v");
        await expect(page.locator("#video-grid")).toHaveAttribute("data-mode", "main");
    });

    test("N hands the main place to every camera in turn", async ({ page }) => {
        const first = await visibleCameraOrder(page);
        const seen: string[] = [first[0]!];
        for (let press = 0; press < first.length; press++) {
            await page.keyboard.press("n");
            await expect
                .poll(() => visibleCameraOrder(page).then((order) => order[0]))
                .toBe(first[(press + 1) % first.length]);
            const main = page.locator(`.video-tile[data-channel="${first[(press + 1) % first.length]}"]`);
            await expect(main).toHaveAttribute("data-role", "main");
            seen.push((await visibleCameraOrder(page))[0]!);
        }
        expect(new Set(seen).size).toBe(first.length);
        expect(await visibleCameraOrder(page)).toEqual(first);
    });

    test("Shift+N undoes N and then hands the main place to the previous camera", async ({ page }) => {
        const first = await visibleCameraOrder(page);
        expect(first.length, "a three-camera trip").toBeGreaterThan(2);
        await page.keyboard.press("n");
        await expect.poll(() => visibleCameraOrder(page).then((order) => order[0])).toBe(first[1]);
        await page.keyboard.press("Shift+N");
        await expect.poll(() => visibleCameraOrder(page)).toEqual(first);
        await page.keyboard.press("Shift+N");
        const previous = first.at(-1)!;
        await expect.poll(() => visibleCameraOrder(page).then((order) => order[0])).toBe(previous);
        await expect(page.locator(`.video-tile[data-channel="${previous}"]`)).toHaveAttribute("data-role", "main");
    });

    test("the divider resizes the smaller cameras, survives a reload and resets on double-click", async ({ page }) => {
        const divider = page.locator(".camera-divider");
        await expect(divider).toBeVisible();
        const strip = await page.locator("#video-grid").getAttribute("data-strip");
        const before = thumbSize(await tileBoxes(page), strip);
        const box = await boxOf(page, ".camera-divider");
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        // Toward the main camera: the strip grows.
        if (strip === "right") await page.mouse.move(cx - 80, cy, { steps: 8 });
        else await page.mouse.move(cx, cy - 60, { steps: 8 });
        await page.mouse.up();
        const grown = thumbSize(await tileBoxes(page), strip);
        expect(grown, "the smaller cameras grow").toBeGreaterThan(before + 20);
        const scale = await page.evaluate(() => window.__everydashcam.state.composition.thumbScale);
        expect(scale).not.toBeNull();
        expectNoOverlap(await tileBoxes(page));
        await shot(page, "camera-layout-03-divider");

        await page.reload();
        await loadTrip(page, SAMPLE_70MAI);
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.composition.thumbScale)).toBe(scale);
        await expect.poll(async () => Math.abs(thumbSize(await tileBoxes(page), strip) - grown)).toBeLessThanOrEqual(2);

        await page.locator(".camera-divider").dblclick();
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.composition.thumbScale)).toBeNull();
        await expect
            .poll(async () => Math.abs(thumbSize(await tileBoxes(page), strip) - before))
            .toBeLessThanOrEqual(2);
    });

    test("the divider moves with the keyboard", async ({ page }) => {
        const divider = page.locator(".camera-divider");
        const strip = await page.locator("#video-grid").getAttribute("data-strip");
        const before = Number(await divider.getAttribute("aria-valuenow"));
        await divider.focus();
        await page.keyboard.press(strip === "right" ? "ArrowLeft" : "ArrowUp");
        await expect.poll(async () => Number(await divider.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
        await page.keyboard.press("Home");
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.composition.thumbScale)).toBeNull();
    });

    test("with overlay allowed, the smaller cameras sit over the main one and drag around it", async ({ page }) => {
        // A frame close to 16:9 has no room beside a 16:9 main camera: a strip
        // would cost it about a third of its area, so the engine takes the
        // overlay once it may.
        await setOverlayAllowed(page, true);
        await expect(page.locator("#video-grid .video-tile.tile-overlay")).toHaveCount(2);
        const boxes = await tileBoxes(page);
        const main = boxes.find((b) => b.role === "main")!;
        const windows = boxes.filter((b) => b.overlay);
        for (const w of windows) expect(overlapArea(main, w), `${w.channel} sits over the main`).toBeGreaterThan(0);
        expectNoOverlap(windows);
        await shot(page, "camera-layout-04-overlay");

        const moved = windows[0]!;
        const grid = await boxOf(page, "#video-grid");
        const startX = grid.x + moved.x + moved.w / 2;
        const startY = grid.y + moved.y + moved.h / 2;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX - 120, startY - 60, { steps: 8 });
        await page.mouse.up();
        await expect
            .poll(() =>
                page.evaluate(
                    (channel) =>
                        window.__everydashcam.state.composition.overlayPositions[
                            channel as "front" | "rear" | "interior"
                        ] ?? null,
                    moved.channel,
                ),
            )
            .not.toBeNull();
        const after = (await tileBoxes(page)).find((b) => b.channel === moved.channel)!;
        expect(after.x).toBeLessThan(moved.x - 40);
        // The drag's release is not a click that makes the window main.
        await page.waitForTimeout(350);
        expect((await visibleCameraOrder(page))[0]).toBe(main.channel);
    });
});

test("double-clicking the video/map splitter fits the video column to its cameras", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await page.locator(".mini-map").click();
    await expect(page.locator("#player-wrap")).toHaveClass(/map-expanded/);
    // The widest map leaves a narrow video column with empty bands above and
    // below the cameras.
    const splitter = page.locator("#video-map-resize");
    await splitter.focus();
    await page.keyboard.press("Home");
    const freeSpace = async (): Promise<{ side: number; vertical: number }> => {
        const boxes = await tileBoxes(page);
        const grid = await boxOf(page, "#video-grid");
        const left = Math.min(...boxes.map((b) => b.x));
        const right = Math.max(...boxes.map((b) => b.x + b.w));
        const top = Math.min(...boxes.map((b) => b.y));
        const bottom = Math.max(...boxes.map((b) => b.y + b.h));
        return { side: Math.round(grid.width - (right - left)), vertical: Math.round(grid.height - (bottom - top)) };
    };
    await expect.poll(async () => (await freeSpace()).vertical).toBeGreaterThan(40);
    await splitter.dblclick();
    // The video column takes the width its cameras fill at this height.
    await expect
        .poll(
            async () => {
                const space = await freeSpace();
                return Math.max(space.side, space.vertical);
            },
            { message: "the cameras fill the video column" },
        )
        .toBeLessThanOrEqual(3);
    const map = await boxOf(page, ".map-wrap");
    expect(map.width, "the map keeps its floor").toBeGreaterThanOrEqual(220);
    const saved = Number(await page.evaluate(() => localStorage.getItem("everydashcam:map-pct")));
    expect(saved, "the fitted width persists").toBeGreaterThan(15);
    expect(saved).toBeLessThan(70);
    await shot(page, "camera-layout-07-splitter-fit");
});

test("on a phone the video area is as tall as the cameras need", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(MOBILE);
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    for (const mode of ["main", "equal"] as const) {
        if (mode === "equal") await chooseArrangementMode(page, "equal");
        await expect
            .poll(
                async () => {
                    const boxes = await tileBoxes(page);
                    const frame = await boxOf(page, "#video-grid");
                    const bottom = Math.max(...boxes.map((b) => b.y + b.h));
                    const top = Math.min(...boxes.map((b) => b.y));
                    return Math.round(frame.height - (bottom - top));
                },
                { message: `${mode}: no empty band above or below the cameras` },
            )
            .toBeLessThanOrEqual(2);
        expectNoOverlap(await tileBoxes(page));
        await shot(page, `camera-layout-05-mobile-${mode}`);
    }
});

test("in a short landscape the cameras stay above the controls on the first screen", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(MOBILE_LANDSCAPE);
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    for (const mode of ["main", "equal"] as const) {
        if (mode === "equal") {
            await chooseArrangementMode(page, "equal");
            await closeCamerasMenu(page);
        }
        const boxes = await tileBoxes(page);
        const grid = await boxOf(page, "#video-grid");
        const bar = await boxOf(page, ".player-bar");
        const bottom = grid.y + Math.max(...boxes.map((b) => b.y + b.h));
        expect(bottom, `${mode}: the cameras end above the controls`).toBeLessThanOrEqual(bar.y + 0.5);
        expectNoOverlap(boxes);
        await shot(page, `camera-layout-08-landscape-${mode}`);
    }
});

test("the View menu starts with the cameras on a multi-camera trip", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await page.locator("#player-view-menu").click();
    const dialog = page.getByRole("dialog", { name: "View" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("group", { name: "Cameras" })).toBeVisible();
    // The dialog takes focus on its first control: the checked layout.
    await expect(page.locator('[data-camera-mode="main"]')).toBeFocused();
    const cameras = await boxOf(page, "#player-cameras-section");
    const panels = await boxOf(page, '.view-menu-row[data-panel="chart"]');
    expect(cameras.y + cameras.height, "cameras come before the panels").toBeLessThanOrEqual(panels.y);
    // A stray arrow only moves focus; Space inside the dialog picks the
    // control rather than toggling playback.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-camera-mode="equal"]')).toBeFocused();
    await expect(page.locator("#video-grid")).toHaveAttribute("data-mode", "main");
    await page.keyboard.press("Space");
    await expect(page.locator("#video-grid")).toHaveAttribute("data-mode", "equal");
    await expect(page.locator('[data-camera-mode="equal"]'), "focus follows the choice").toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator('[data-camera-mode="main"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#video-grid")).toHaveAttribute("data-mode", "main");
    await page.locator('.view-menu-row[data-panel="chart"]').focus();
    await page.keyboard.press("Space");
    await expect(page.locator('.view-menu-row[data-panel="chart"]')).toHaveAttribute("aria-checked", "false");
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "true");
    await page.keyboard.press("Space");
    await expect(page.locator('.view-menu-row[data-panel="chart"]')).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator("#player-view-menu")).toBeFocused();
});

test("a single-camera trip lists its camera with only the reflection in the View menu", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await loadTrip(page, SAMPLE_NOGPS);
    await pausePlayback(page);
    await page.locator("#player-view-menu").click();
    await expect(page.getByRole("dialog", { name: "View" })).toBeVisible();
    const section = page.locator("#player-cameras-section");
    await expect(section).toBeVisible();
    await expect(section.locator(".cameras-menu__camera")).toHaveCount(1);
    await expect(
        section.locator(
            "[data-camera-mode], .cameras-menu__handle, .cameras-menu__visible, .cameras-menu__main, .cameras-menu__audio",
        ),
    ).toHaveCount(0);
    await expect(section.locator(".cameras-menu__flip-axis").first()).toBeFocused();
});

test.describe("on a touch phone", () => {
    test.use({ hasTouch: true, isMobile: true });

    test("the cameras carry only their names", async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(MOBILE);
        await gotoApp(page);
        await loadTrip(page, SAMPLE_70MAI);
        await pausePlayback(page);
        const tiles = page.locator("#video-grid > .video-tile:not([hidden])");
        const count = await tiles.count();
        expect(count).toBeGreaterThan(1);
        await expect(tiles.locator("button:visible")).toHaveCount(0);
        await expect(tiles.locator(".channel-label:visible")).toHaveCount(count);
        await shot(page, "camera-layout-09-touch-tiles");
    });

    // 360 px is a common narrow Android width: the menu is capped by the
    // screen there and the longest Russian names wrap instead of fitting.
    for (const width of [MOBILE.width, 360]) {
        test(`the cameras menu keeps whole camera names next to the reflection toggles at ${width} px`, async ({
            page,
        }) => {
            await presetLocalStorage(page, { lang: "ru" });
            await page.setViewportSize({ width, height: MOBILE.height });
            await gotoApp(page, "ru");
            await loadTrip(page, SAMPLE_70MAI);
            await pausePlayback(page);
            await openCamerasMenu(page);
            const names = page.locator("#player-cameras-section .cameras-menu__name");
            await expect(names).toHaveCount(3);
            const clipped = await names.evaluateAll((elements) =>
                elements
                    .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
                    .map((el) => el.textContent),
            );
            expect(clipped, "names cut by the row").toEqual([]);
            const toggles = page.locator("#player-cameras-section .cameras-menu__flip-axis");
            for (const toggle of await toggles.all()) await expect(toggle).toBeInViewport({ ratio: 1 });
            await shot(page, `camera-layout-10-touch-menu-ru-${width}`);
        });
    }
});

/** A front camera recording 6 s and a rear camera that stops after 2.4 s. */
async function openShortRearTrip(page: Page): Promise<void> {
    const clips = await Promise.all([
        createMseFixture({ gopCount: 6 }),
        createMseFixture({ gopCount: 6, gopDurationSec: 0.4 }),
    ]);
    await page.locator("#file-input").setInputFiles(
        ["20260904_202849F", "20260904_202849R"].map((name, index) => ({
            name: `${name}.MP4`,
            mimeType: "video/mp4",
            buffer: Buffer.from(clips[index]!),
        })),
    );
    const trips = page.locator("li.trip:not(.unindexed-note)");
    await expect(trips).toHaveCount(1);
    await trips.first().locator(".trip-title").click();
    await expect(page.locator('.video-tile[data-channel="rear"]')).toBeVisible();
    await pausePlayback(page);
}

async function seekTripTo(page: Page, seconds: number, totalSec: number): Promise<void> {
    const bar = await boxOf(page, "#player-mini-progress");
    await page.mouse.click(bar.x + (bar.width * seconds) / totalSec, bar.y + bar.height / 2);
}

test("a camera without footage keeps its place with a placeholder and lends out the main place", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await openShortRearTrip(page);
    const front = page.locator('.video-tile[data-channel="front"]');
    const rear = page.locator('.video-tile[data-channel="rear"]');
    const message = rear.locator(".tile-absent-msg");

    await seekTripTo(page, 1, 6);
    await expect(rear).not.toHaveClass(/\btile-absent\b/);
    await expect(message).toBeHidden();
    const placed = await tileBoxes(page);

    // Past the rear clip and its short last-frame hold.
    await seekTripTo(page, 5.5, 6);
    await expect(rear).toHaveClass(/\btile-absent\b/);
    await expect(message).toBeVisible();
    await expect(message).toHaveText("No recording at this moment");
    const geometry = (boxes: TileBox[]) =>
        boxes.map(({ channel, role, x, y, w, h }) => ({ channel, role, x, y, w, h }));
    expect(geometry(await tileBoxes(page)), "the placeholder keeps the camera's place").toEqual(geometry(placed));
    await shot(page, "camera-layout-06-placeholder");

    // The chosen main camera has no footage now: the front camera stands in.
    await makeMainFromMenu(page, "rear");
    expect(await visibleCameraOrder(page)).toEqual(["rear", "front"]);
    await expect(front).toHaveAttribute("data-role", "main");
    await expect(rear).toHaveAttribute("data-role", "thumb");
    await expect(page.locator(".video-tile.active")).toHaveAttribute("data-channel", "front");
    // A click on the placeholder neither hands it the main place nor
    // toggles playback.
    const paused = () =>
        page.evaluate(
            () => document.querySelector<HTMLVideoElement>(".video-tile.active video:not(.preload-slot)")!.paused,
        );
    expect(await paused()).toBe(true);
    await rear.click();
    await page.waitForTimeout(350);
    await expect(front).toHaveAttribute("data-role", "main");
    expect(await paused(), "the placeholder click leaves playback alone").toBe(true);

    // Back where the rear camera records, it takes its main place again.
    await seekTripTo(page, 1, 6);
    await expect(rear).toHaveAttribute("data-role", "main");
    await expect(rear).not.toHaveClass(/\btile-absent\b/);
    await expect(page.locator(".video-tile.active")).toHaveAttribute("data-channel", "rear");
});

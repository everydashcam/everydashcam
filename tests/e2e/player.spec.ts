// Player controls and timeline interactions on a loaded multichannel trip.
// Fail-loud, web-first assertions so a regression turns the test red.

import type { Page } from "@playwright/test";

import {
    DESKTOP,
    MOBILE,
    SAMPLE_70MAI,
    SAMPLE_NOGPS,
    boxOf,
    expect,
    gotoApp,
    loadTrip,
    masterVideoTime,
    openExport,
    pausePlayback,
    presetLocalStorage,
    shot,
    test,
} from "./_fixtures.js";

test.describe.configure({ mode: "parallel" });

// Mirrors the mini-map drag geometry in ui/map.ts (padding around the widget
// inside its frame, and the movement that turns a press into a drag). Copied,
// not imported: both live inside the module's DOM-singleton graph, and the
// suite stays black-box against the built app.
const MINIMAP_FRAME_PADDING_PX = 16;
const MINIMAP_DRAG_THRESHOLD_PX = 5;

async function chartWindow(page: Page): Promise<{ min: number; max: number; duration: number; zoomed: boolean }> {
    return page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const st = (window as any).__everydashcam.state;
        const trip = st.active ? st.trips[st.active.trip] : null;
        if (!st.chart || !trip) throw new Error("chart window unavailable");
        return {
            min: st.chart.scales.x.min as number,
            max: st.chart.scales.x.max as number,
            duration: trip.timeline.contentDurationSec as number,
            zoomed: st.chartZoomed as boolean,
        };
    });
}

/** Seek through the public scrubber and wait for the media seek itself, not
 * merely for currentTime to read zero. A cross-file seek swaps in a fresh
 * <video> whose currentTime starts at zero before its source is playable; that
 * transient value used to let play/pause tests click into an in-flight attach. */
async function seekToTripStart(page: Page): Promise<void> {
    await page.locator("#player-mini-progress").focus();
    await page.keyboard.press("Home");
    const master = page.locator(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)");
    await expect
        .poll(
            () =>
                master.evaluate(
                    (video: HTMLVideoElement) =>
                        video.currentSrc !== "" && video.readyState >= 2 && !video.seeking && video.currentTime < 0.1,
                ),
            { message: "Home must land on a playable first frame" },
        )
        .toBe(true);
}

/** Whether the zoom preview canvas holds a drawn, opaque video frame. */
async function minimapPainted(page: Page): Promise<boolean> {
    return page.locator("#video-minimap-canvas").evaluate((canvas: HTMLCanvasElement) => {
        if (canvas.width === 0 || canvas.height === 0) return false;
        const pixel = canvas.getContext("2d")!.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
        return pixel[3] === 255;
    });
}

async function minimapBackingWidth(page: Page): Promise<number> {
    return page.locator("#video-minimap-canvas").evaluate((canvas: HTMLCanvasElement) => canvas.width);
}

async function wheelVideoZoom(page: Page, deltaY: number): Promise<void> {
    await page.locator(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)").hover();
    await page.mouse.wheel(0, deltaY);
}

test.describe("player", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);
    });

    test("play/pause control toggles the playing state", { tag: "@golden-playback" }, async ({ page }) => {
        const play = page.locator("#player-play");
        // The four-second fixture can finish while a busy full-suite worker is
        // still settling setup. A click at that point exercises the asynchronous
        // restart-from-end path, not the ordinary play toggle this test names.
        // Pause and seek to a known non-terminal frame before checking both
        // transitions so worker scheduling cannot change the branch under test.
        await pausePlayback(page);
        await seekToTripStart(page);

        await play.click();
        await expect(play).toHaveAttribute("data-paused", "false");
        await play.click();
        await expect(play).toHaveAttribute("data-paused", "true");
        await shot(page, "player-01-playpause");
    });

    test("wheel zoom-out releases the zoom preview and zoom-in mirrors the video again", async ({ page }) => {
        await pausePlayback(page);
        await seekToTripStart(page);
        const master = page.locator(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)");
        // Keep the short fixture away from a file boundary during UI assertions.
        await master.evaluate(async (video: HTMLVideoElement) => {
            video.playbackRate = 0.25;
            video.muted = true;
            await video.play();
        });
        await wheelVideoZoom(page, -120);
        await expect(page.locator("#video-minimap")).toBeVisible();
        await expect.poll(() => minimapPainted(page)).toBe(true);

        await wheelVideoZoom(page, 120);
        await expect(page.locator("#video-minimap")).toBeHidden();
        expect(await minimapBackingWidth(page), "zoom-out releases the preview canvas").toBe(0);
        expect(
            await master.evaluate((video: HTMLVideoElement) => video.paused),
            "zoom-out keeps the main video playing",
        ).toBe(false);

        await wheelVideoZoom(page, -120);
        await expect(page.locator("#video-minimap")).toBeVisible();
        await expect.poll(() => minimapPainted(page)).toBe(true);
        expect(
            await page.locator("#video-minimap video").count(),
            "the preview mirrors the master instead of adding a decoder",
        ).toBe(0);
    });

    test("export releases the zoom preview and permits zooming again on close", async ({ page }) => {
        await pausePlayback(page);
        await seekToTripStart(page);
        await wheelVideoZoom(page, -120);
        await expect(page.locator("#video-minimap")).toBeVisible();
        await expect.poll(() => minimapPainted(page)).toBe(true);

        await openExport(page, false);
        await expect(page.locator("#video-minimap")).toBeHidden();
        expect(await minimapBackingWidth(page), "export releases the preview canvas").toBe(0);

        await page.locator("#export-panel-close").click();
        await expect(page.locator("#video-minimap")).toBeHidden();
        expect(await page.evaluate(() => window.__everydashcam.state.videoZoom.scale)).toBe(1);
        await wheelVideoZoom(page, -120);
        await expect(page.locator("#video-minimap")).toBeVisible();
        await expect.poll(() => minimapPainted(page)).toBe(true);
        expect(await page.evaluate(() => window.__everydashcam.dom.player.paused)).toBe(true);
    });

    test("frame-step buttons step the paused player frame by frame, both ways", { tag: "@golden-playback" }, async ({
        page,
    }) => {
        const play = page.locator("#player-play");
        await pausePlayback(page);

        // Measure the master tile only - a frame step is defined off it (see
        // masterVideoTime). Math.max over every tile flakes: slaves drift ahead
        // during playback and the first step re-syncs them down below the drift.
        const time = () => masterVideoTime(page);

        // This fixture is only four seconds long and can reach its end while a
        // busy browser finishes viewer setup. Put the paused playhead at a known
        // frame with the scrubber's public keyboard control; forward stepping at
        // the clamped trip end is correctly a no-op.
        await seekToTripStart(page);

        // The fixture is 30 fps, so a step is 1/30s. Each step is an async seek;
        // fire them one-settled-at-a-time rather than hammering three at once. A
        // slow software decoder (Linux CI's H.264) coalesces back-to-back seeks
        // into fewer frames, so unsynchronized clicks flake. A held gesture uses
        // one elapsed-time-derived absolute target; separate clicks intentionally
        // retain one-relative-step semantics, so settle each before sending next.
        const t0 = await time();
        const fwd = page.locator("#player-step-fwd");
        let prev = t0;
        for (let step = 1; step <= 3; step++) {
            await fwd.click();
            // Wait for this step to land before the next. Half a frame is the
            // floor: a step from a sub-frame position snaps to the next frame
            // boundary, which is always > 0 but can be < 1/30.
            await expect
                .poll(time, { message: `forward step ${step} must advance a frame` })
                .toBeGreaterThan(prev + 0.5 / 30);
            prev = await time();
        }
        const t3 = prev;
        // 3 steps advanced ~3 frames; the lower bound (2.5 frames) tolerates
        // seek rounding, the upper bound catches a step that degenerated into a
        // whole-second seek.
        expect(t3 - t0, "3 forward steps must advance ~3 frames").toBeGreaterThan(2.5 / 30);
        expect(t3 - t0, "3 frame steps must stay a micro-seek, not a jump").toBeLessThan(1);

        await page.locator("#player-step-back").click();
        await expect.poll(time, { message: "a back step must rewind" }).toBeLessThan(t3);
        // Stepping must not resume playback.
        await expect(play).toHaveAttribute("data-paused", "true");
    });

    test("frame-step while playing pauses first; holding auto-repeats", async ({ page }) => {
        const play = page.locator("#player-play");
        // The fixture is only four seconds long and may reach EOF while a busy
        // full-suite worker finishes setup. Starting from EOF takes the
        // asynchronous restart path, so establish a known non-terminal frame
        // before asserting the ordinary playing -> frame-step transition.
        await pausePlayback(page);
        await seekToTripStart(page);

        await play.click();
        await expect(play).toHaveAttribute("data-paused", "false");

        const fwd = page.locator("#player-step-fwd");
        await fwd.click();
        await expect(play, "step while playing must pause, not seek under playback").toHaveAttribute(
            "data-paused",
            "true",
        );

        const time = () => masterVideoTime(page);
        const t0 = await time();
        // Hold the button past the repeat delay: pointerdown steps once
        // immediately, then the auto-repeat must contribute more steps. A 1.2s
        // hold = 1 + ~(1200-400)/150 ≈ 6 steps of 1/30s; require > 3 frames so
        // a repeat that never started (one step = 1/30) fails loudly without
        // making CI timing precision the gate.
        const box = await boxOf(page, "#player-step-fwd");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(1200);
        await page.mouse.up();
        await expect
            .poll(time, { message: "a >1s hold must auto-repeat (3+ frames), not step once" })
            .toBeGreaterThan(t0 + 3.5 / 30);
    });

    test("speed menu changes the playback rate label", async ({ page }) => {
        const speedBtn = page.locator("#player-speed");
        const before = (await speedBtn.innerText()).trim();
        await speedBtn.click();
        await expect(page.locator("#player-speed-menu")).toBeVisible();
        const opt2x = page.locator('#player-speed-menu [data-rate="2"]');
        await expect(opt2x).toBeVisible();
        await opt2x.click();
        await expect(speedBtn).not.toHaveText(before);
    });

    test("loop button toggles aria-pressed", async ({ page }) => {
        const loop = page.locator("#player-loop");
        await expect(loop).toBeVisible();
        const before = await loop.getAttribute("aria-pressed");
        await loop.click();
        await expect(loop).not.toHaveAttribute("aria-pressed", before ?? "");
    });

    test("capture button downloads a JPEG frame", async ({ page }) => {
        // The viewer can appear before the initial video attachment settles.
        // Capture a paused, playable frame outside any source/seek transition.
        await pausePlayback(page);
        await seekToTripStart(page);

        const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
        await page.locator("#player-capture").click();
        const dl = await downloadPromise;
        expect(dl.suggestedFilename()).toMatch(/\.(jpe?g|png)$/i);
    });

    test("tile click swaps the audio source", async ({ page }) => {
        const rearTile = page.locator('.video-tile[data-channel="rear"]');
        await expect(rearTile).toBeVisible();
        await rearTile.click();
        await expect(page.locator(".top-panel__audio-select")).toHaveValue("rear");
        await shot(page, "player-02-audio-swap");
    });

    test("dragging a tile by its grip inserts it into the drop slot", async ({ page }) => {
        const front = page.locator('.video-tile[data-channel="front"]');
        const rear = page.locator('.video-tile[data-channel="rear"]');
        const interior = page.locator('.video-tile[data-channel="interior"]');
        await expect(front).toHaveAttribute("data-slot", "0");
        await expect(rear).toHaveAttribute("data-slot", "1");
        await expect(interior).toHaveAttribute("data-slot", "2");

        const handle = await boxOf(page, '.video-tile[data-channel="front"] .tile-drag-handle');
        const target = await boxOf(page, '.video-tile[data-channel="interior"]');
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await page.mouse.down();
        // Two hops so the ghost + placeholder appear mid-gesture.
        await page.mouse.move(handle.x + 40, handle.y + 40, { steps: 4 });
        await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
        await expect(page.locator(".tile-drag-ghost")).toBeVisible();
        await expect(page.locator('.video-tile[data-channel="interior"] .tile-drop-placeholder')).toBeVisible();
        await shot(page, "player-03-tile-reorder");
        await page.mouse.up();

        // Insert (not swap): rear -> primary, interior -> slot 1, front -> slot 2.
        await expect(rear).toHaveAttribute("data-slot", "0");
        await expect(interior).toHaveAttribute("data-slot", "1");
        await expect(front).toHaveAttribute("data-slot", "2");
        await expect(page.locator(".tile-drag-ghost")).toHaveCount(0);
        await expect(page.locator(".tile-drop-placeholder")).toHaveCount(0);
    });

    test("dragging a top-panel chip reorders channels", async ({ page }) => {
        const chips = page.locator(".top-panel__channel-chip");
        await expect(chips).toHaveCount(3);
        const firstCh = await chips.first().getAttribute("data-channel");

        const front = await boxOf(page, '.top-panel__channel-chip[data-channel="front"]');
        const interior = await boxOf(page, '.top-panel__channel-chip[data-channel="interior"]');
        await page.mouse.move(front.x + front.width / 2, front.y + front.height / 2);
        await page.mouse.down();
        await page.mouse.move(front.x + front.width / 2 + 8, front.y + front.height / 2, { steps: 3 });
        await page.mouse.move(interior.x + interior.width / 2, interior.y + interior.height / 2, { steps: 8 });
        await expect(page.locator(".chip-drag-ghost")).toBeVisible();
        await expect(page.locator('.top-panel__channel-chip[data-channel="interior"]')).toHaveClass(/drop-before/);
        await page.mouse.up();

        await expect(chips.first()).not.toHaveAttribute("data-channel", firstCh ?? "");
        await expect(page.locator(".chip-drag-ghost")).toHaveCount(0);
    });

    test("mini-map drag moves it and persists the position", async ({ page }) => {
        // The widget is anchored to its frame's top-left and its drag offset is
        // clamped to 0..range, so how far it CAN travel depends on the frame the
        // current layout gives it. Measure the room that is actually there and
        // drag into it - a fixed pixel delta silently gets eaten by the clamp
        // (dragging left from the anchor moves nothing at all) and the assertion
        // then reads as a product bug instead of a miscalibrated gesture.
        const room = await page.evaluate((padPx) => {
            const mini = document.querySelector<HTMLElement>(".mini-map");
            const frame = mini?.parentElement;
            if (!mini || !frame) return null;
            const m = mini.getBoundingClientRect();
            const f = frame.getBoundingClientRect();
            return { right: f.right - padPx - m.right, down: f.bottom - padPx - m.bottom };
        }, MINIMAP_FRAME_PADDING_PX);
        expect(room, ".mini-map must be mounted inside a frame").not.toBeNull();

        // Down-right is the direction with headroom. Cap the request by the room
        // so the expected delta is exactly what the clamp will allow.
        const dx = Math.max(0, Math.min(120, Math.floor(room?.right ?? 0)));
        const dy = Math.max(0, Math.min(80, Math.floor(room?.down ?? 0)));
        expect(dx + dy, "the layout must leave room to drag the mini-map into").toBeGreaterThan(
            MINIMAP_DRAG_THRESHOLD_PX,
        );

        const before = await boxOf(page, ".mini-map");
        const grabX = before.x + before.width / 2;
        const grabY = before.y + before.height / 2;
        await page.mouse.move(grabX, grabY);
        await page.mouse.down();
        await page.mouse.move(grabX + dx, grabY + dy, { steps: 10 });
        await page.mouse.up();

        // Position persisted to localStorage (survives reload) AND the widget
        // actually followed the pointer.
        const persisted = await page.evaluate(() => localStorage.getItem("everydashcam:minimap-pos"));
        expect(persisted, "mini-map position must be persisted after a drag").not.toBeNull();
        const after = await boxOf(page, ".mini-map");
        // Subpixel layout only, so a couple of px of slack - not a "did it move
        // at all" threshold: the widget must land where the pointer left it.
        expect(Math.abs(after.x - before.x - dx), "mini-map must follow the pointer horizontally").toBeLessThanOrEqual(
            2,
        );
        expect(Math.abs(after.y - before.y - dy), "mini-map must follow the pointer vertically").toBeLessThanOrEqual(2);
        await shot(page, "player-04-minimap-moved");
    });

    test("View exposes off, mini and large map states with shared-element transitions", async ({ page }) => {
        const body = page.locator("body");
        const player = page.locator("#player-wrap");
        const miniMap = page.locator("#mini-map");
        const largeMap = page.locator(".map-wrap");
        const mode = (name: "off" | "mini" | "large") => page.locator(`[data-map-mode="${name}"]`);
        const waitForMorph = async (): Promise<void> => {
            await expect(body).toHaveClass(/map-morphing/);
            await expect(body).not.toHaveClass(/map-morphing/);
        };
        const expectSurfacePainted = async (surface: ReturnType<typeof page.locator>): Promise<void> => {
            await expect(surface).toBeVisible();
            await expect.poll(() => surface.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
            expect(await surface.evaluate((element) => element.getAnimations().length)).toBe(0);
        };

        const miniMarkerWidth = await miniMap
            .locator(".car-marker__canvas")
            .evaluate((element) => Number.parseFloat(getComputedStyle(element).width));
        expect(miniMarkerWidth, "the default marker stays proportional to the mini-map").toBeCloseTo(26.4, 1);

        await page.locator("#player-view-menu").click();
        await expect(mode("mini")).toHaveAttribute("aria-checked", "true");

        await mode("large").click();
        await expect(player).toHaveClass(/map-expanded/);
        await waitForMorph();
        await expectSurfacePainted(largeMap);
        await expect(mode("large")).toHaveAttribute("aria-checked", "true");

        await mode("mini").click();
        await expect(player).not.toHaveClass(/map-expanded/);
        await waitForMorph();
        await expectSurfacePainted(miniMap);
        await expect(mode("mini")).toHaveAttribute("aria-checked", "true");

        await mode("off").click();
        await waitForMorph();
        await expect(miniMap).toBeHidden();
        await expect(mode("off")).toHaveAttribute("aria-checked", "true");

        await mode("large").click();
        await expect(page.locator(".map-morph-portal")).toBeVisible();
        await waitForMorph();
        await expect(player).toHaveClass(/map-expanded/);
        await expectSurfacePainted(largeMap);
        await expect(mode("large")).toHaveAttribute("aria-checked", "true");

        // Reuse both MapLibre containers once more. A finished WAAPI effect with
        // fill:forwards used to leave the old source at computed opacity:0, so
        // layout assertions passed while the repeated map render was blank.
        await mode("mini").click();
        await waitForMorph();
        await expectSurfacePainted(miniMap);
        await shot(page, "player-05-view-map-modes");
    });

    test("View restores the saved large map mode after reload", async ({ page }) => {
        await page.locator("#player-view-menu").click();
        await page.locator('[data-map-mode="large"]').click();
        await expect(page.locator("body")).not.toHaveClass(/map-morphing/);
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const stored = JSON.parse(localStorage.getItem("dc.viewer.panels") ?? "{}") as {
                        mapMode?: string;
                    };
                    return stored.mapMode;
                }),
            )
            .toBe("large");

        await page.reload();
        await loadTrip(page, SAMPLE_70MAI);
        await expect(page.locator("#player-wrap")).toHaveClass(/map-expanded/);
        await expect
            .poll(() => page.evaluate(() => window.__everydashcam.state.map?.getPitch() ?? 0))
            .toBeGreaterThan(20);
        await page.locator("#player-view-menu").click();
        await expect(page.locator('[data-map-mode="large"]')).toHaveAttribute("aria-checked", "true");
    });

    test("chase is the default follow mode: expanding the big map tilts it", async ({ page }) => {
        const pitch = () =>
            page.evaluate(() => {
                const w = window as unknown as { __everydashcam?: { state?: { map?: { getPitch?: () => number } } } };
                return w.__everydashcam?.state?.map?.getPitch?.() ?? 0;
            });
        // Chase is the default. Expanding the big map (the follow control lives
        // there) engages it: the camera tilts and the chase sub-controls show.
        await page.locator(".mini-map").click();
        const chaseBtn = page.locator('.map-follow-seg[data-follow-mode="chase"]');
        await expect(chaseBtn).toBeVisible();
        await expect(chaseBtn).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator("#map-chase-controls")).toBeVisible();
        await expect.poll(pitch).toBeGreaterThan(20);
        await shot(page, "player-09-chase-mode");

        // Switching to plain follow un-tilts back to flat and hides the controls.
        await page.locator('.map-follow-seg[data-follow-mode="follow"]').click();
        await expect(page.locator("#map-chase-controls")).toBeHidden();
        await expect.poll(pitch).toBeLessThan(2);

        // Re-selecting chase re-tilts and re-reveals the controls.
        await chaseBtn.click();
        await expect(page.locator("#map-chase-controls")).toBeVisible();
        await expect.poll(pitch).toBeGreaterThan(20);
    });

    test("map gear popover changes and persists the label-size preference", async ({ page }) => {
        // The gear lives on the expanded map's controls column.
        await page.locator(".mini-map").click();
        const toggle = page.locator("#map-settings-toggle");
        const popover = page.locator("#map-settings-popover");
        await expect(toggle).toBeVisible();
        await expect(popover).toBeHidden();

        const scaleSeg = popover.locator("#map-label-scale-segment");
        const namesSeg = popover.locator("#map-street-names-segment");
        const markerControl = popover.locator('[data-marker-control="map-popover"]');
        await toggle.click();
        await expect(popover).toBeVisible();
        expect(
            await popover.evaluate((element) => Math.ceil(element.getBoundingClientRect().height)),
            "the point-of-use map settings should stay compact enough to avoid a tall flyout",
        ).toBeLessThanOrEqual(320);
        await expect(markerControl.locator('button[data-marker-shape="arrow"]')).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        await expect(markerControl.locator('button[data-marker-shape="arrow"] canvas')).toHaveAttribute(
            "data-marker-render-key",
            /^arrow:/,
        );
        await expect(markerControl.locator('button[data-marker-shape="truck"] canvas')).toHaveAttribute(
            "data-marker-render-key",
            /^truck:/,
        );
        expect(
            await markerControl
                .locator("button[data-marker-color]")
                .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
            "quick colors follow common car colors before the brand default",
        ).toEqual(["White", "Black", "Gray", "Silver", "Blue", "Red", "Green", "Orange"]);
        const customColor = await boxOf(page, "#map-popover-marker-color");
        const markerSizes = await boxOf(page, '[data-marker-control="map-popover"] .map-marker-control__size-segment');
        const overlapWidth =
            Math.min(customColor.x + customColor.width, markerSizes.x + markerSizes.width) -
            Math.max(customColor.x, markerSizes.x);
        const overlapHeight =
            Math.min(customColor.y + customColor.height, markerSizes.y + markerSizes.height) -
            Math.max(customColor.y, markerSizes.y);
        expect(overlapWidth <= 0 || overlapHeight <= 0, "custom color and marker sizes do not overlap").toBe(true);
        await shot(page, "player-10-map-marker-popover");
        await expect(scaleSeg.locator('button[aria-pressed="true"]'), "default size preset is pressed").toHaveText(
            "100%",
        );
        await expect(namesSeg.locator('button[aria-pressed="true"]'), "default density preset is pressed").toHaveText(
            "Standard",
        );

        // Picking presets applies them but keeps the popover open - the user
        // compares variants against the live map behind it.
        await page.evaluate(() => {
            const { state } = window.__everydashcam;
            state.followMode = "off";
            state.map!.jumpTo({ center: [65, 45], zoom: 17, bearing: 20 });
        });
        await scaleSeg.getByRole("button", { name: "150%" }).click();
        await namesSeg.getByRole("button", { name: "More" }).click();
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.mapReady)).toBe(true);
        const camera = await page.evaluate(() => {
            const map = window.__everydashcam.state.map!;
            return {
                lon: map.getCenter().lng,
                lat: map.getCenter().lat,
                zoom: map.getZoom(),
                bearing: map.getBearing(),
            };
        });
        expect(camera.lon).toBeCloseTo(65);
        expect(camera.lat).toBeCloseTo(45);
        expect(camera.zoom).toBeCloseTo(17);
        expect(camera.bearing).toBeCloseTo(20);
        await markerControl.locator('button[data-marker-shape="suv"]').click();
        await markerControl.locator('button[data-marker-color="#2f7ee6"]').click();
        await markerControl.locator('button[data-marker-size="large"]').click();
        await expect(popover).toBeVisible();
        await expect(markerControl.locator('button[data-marker-shape="sedan"] canvas')).toHaveCSS("width", "52px");
        await expect(scaleSeg.locator('button[aria-pressed="true"]')).toHaveText("150%");
        await expect(namesSeg.locator('button[aria-pressed="true"]')).toHaveText("More");
        const stored = await page.evaluate(() => ({
            labelScale: localStorage.getItem("everydashcam:mapLabelScale"),
            streetNames: localStorage.getItem("everydashcam:streetLabelDensity"),
            marker: JSON.parse(localStorage.getItem("everydashcam:mapMarker") ?? "null"),
        }));
        expect(stored, "preferences must survive to the next session").toEqual({
            labelScale: "1.5",
            streetNames: "more",
            marker: { shape: "suv", color: "#2f7ee6", size: "large" },
        });
        await expect(page.locator("#mini-map .car-marker__canvas")).toHaveAttribute(
            "data-marker-render-key",
            "suv:#2f7ee6:overhead",
        );
        await expect(page.locator(".map-wrap .car-marker__canvas")).toHaveAttribute(
            "data-marker-render-key",
            "suv:#2f7ee6",
        );
        expect(
            await page
                .locator("#mini-map .car-marker")
                .evaluate((element) => element.style.getPropertyValue("--map-marker-size")),
        ).toBe("52px");

        // Escape closes; reopening reflects the stored preferences.
        await page.keyboard.press("Escape");
        await expect(popover).toBeHidden();
        await toggle.click();
        await expect(scaleSeg.locator('button[aria-pressed="true"]')).toHaveText("150%");
        await expect(namesSeg.locator('button[aria-pressed="true"]')).toHaveText("More");
        await expect(markerControl.locator('button[data-marker-shape="suv"]')).toHaveAttribute("aria-pressed", "true");
        await expect(markerControl.locator('button[data-marker-size="large"]')).toHaveAttribute("aria-pressed", "true");

        // A click on the map outside the popover closes it.
        const video = await boxOf(page, ".video-frame");
        await page.mouse.click(video.x + video.width / 2, video.y + video.height / 2);
        await expect(popover).toBeHidden();
    });

    test("map gear popover stays inside a narrow map pane", async ({ page }) => {
        // .map-wrap clips at overflow:hidden, so a popover past the pane edge
        // is silently cut - the regression this guards is a preset row wider
        // than the pane at the splitter's minimum.
        await page.locator(".mini-map").click();
        await page.locator("#video-map-resize").focus();
        await page.keyboard.press("End"); // End = narrowest map (MAP_PCT_MIN)
        await page.locator("#map-settings-toggle").click();
        const popover = page.locator("#map-settings-popover");
        await expect(popover).toBeVisible();
        const pane = await boxOf(page, ".map-wrap");
        const pop = await boxOf(page, "#map-settings-popover");
        expect(pop.x + pop.width, "popover right edge inside the clipping pane").toBeLessThanOrEqual(
            pane.x + pane.width,
        );
        expect(pop.y + pop.height, "popover bottom edge inside the clipping pane").toBeLessThanOrEqual(
            pane.y + pane.height,
        );
        // Presets stay clickable in the fallback layout.
        const scaleSeg = popover.locator("#map-label-scale-segment");
        await scaleSeg.getByRole("button", { name: "200%" }).click();
        await expect(scaleSeg.locator('button[aria-pressed="true"]')).toHaveText("200%");
    });

    test("manual zoom on the chase map keeps speed-adaptive zoom on", async ({ page }) => {
        await page.locator(".mini-map").click(); // expand -> chase (default) engaged
        const adaptive = page.locator("#map-chase-adaptive");
        await expect(adaptive).toBeVisible();
        await expect(adaptive).toHaveAttribute("aria-pressed", "true"); // default on
        // A user wheel-zoom now only pauses auto-follow for the grace window; it
        // must NOT disable adaptive zoom (which re-applies on resume). The toggle
        // stays the user's deliberate switch, untouched by a stray gesture.
        const map = await boxOf(page, "#map");
        await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
        await page.mouse.wheel(0, -240);
        await expect(adaptive).toHaveAttribute("aria-pressed", "true");
        // The explicit toggle still works.
        await adaptive.click();
        await expect(adaptive).toHaveAttribute("aria-pressed", "false");
    });

    test("chart hover shows the hover cursor", async ({ page }) => {
        const chart = await boxOf(page, "#player-chart-canvas");
        // Two moves near the top edge (clear of the strip overlay below) so the
        // rAF-throttled mousemove handler sees a transition.
        await page.mouse.move(chart.x + 30, chart.y + 5);
        await page.mouse.move(chart.x + 60, chart.y + 20);
        await expect(page.locator("#player-chart-hover-cursor")).not.toHaveAttribute("hidden", "");
        await shot(page, "player-05-chart-hover");
    });

    test("chart wheel-zoom re-anchors the playhead", async ({ page }) => {
        // Seek to mid-trip so the playhead sits away from the left edge (a t=0
        // playhead could map to the same edge pixel after zoom).
        const bar = await boxOf(page, "#player-mini-progress");
        await page.mouse.click(bar.x + bar.width * 0.5, bar.y + bar.height / 2);
        const playhead = page.locator("#player-chart-playhead");
        const before = await playhead.evaluate((el) => (el as HTMLElement).style.left);
        expect(before, "playhead must have a position before zoom").not.toBe("");

        const chart = await boxOf(page, "#player-chart");
        await page.mouse.move(chart.x + chart.width * 0.78, chart.y + chart.height * 0.4);
        for (let i = 0; i < 4; i++) {
            await page.mouse.wheel(0, -200);
        }
        await expect.poll(() => playhead.evaluate((el) => (el as HTMLElement).style.left)).not.toBe(before);
    });

    test("timeline zoom controls show both directions and reflect their limits", async ({ page }) => {
        const overview = page.locator("#player-chart-overview");
        const zoomOut = page.locator("#player-chart-zoom-out");
        const zoomIn = page.locator("#player-chart-zoom-in");
        const reset = page.locator("#player-chart-overview-reset");
        const status = page.locator("#player-chart-zoom-status");
        const factor = page.locator("#player-chart-zoom-factor");
        const range = page.locator("#player-chart-zoom-range");

        // The navigator is a persistent map of the trip, including at full view.
        await expect(overview).toBeVisible();
        const overviewAtFull = await boxOf(page, "#player-chart-overview");
        const playerChartAtFull = await boxOf(page, "#player-chart");
        const desktopRowOverflow = await page.locator("#player-chart-zoom-row").evaluate((el) => ({
            clientWidth: el.clientWidth,
            scrollWidth: el.scrollWidth,
        }));
        expect(overviewAtFull.height, "fine-pointer navigator height").toBeCloseTo(24, 0);
        expect(
            Math.abs(overviewAtFull.x + overviewAtFull.width / 2 - (playerChartAtFull.x + playerChartAtFull.width / 2)),
            "desktop navigator stays centered on the whole chart",
        ).toBeLessThanOrEqual(1);
        expect(overviewAtFull.width, "desktop navigator keeps a usable width").toBeGreaterThan(40);
        expect(desktopRowOverflow.scrollWidth, "desktop zoom row has no horizontal overflow").toBeLessThanOrEqual(
            desktopRowOverflow.clientWidth + 1,
        );
        await expect(zoomOut).toBeVisible();
        await expect(zoomIn).toBeVisible();
        await expect(zoomOut, "full view cannot zoom out any farther").toBeDisabled();
        await expect(zoomIn).toBeEnabled();
        await expect(reset).toBeHidden();
        await expect(reset).toBeDisabled();
        await expect(reset).toHaveAttribute("aria-hidden", "true");
        await expect(status).toBeHidden();

        const fullRangeText = (await range.textContent())?.trim() ?? "";
        expect(fullRangeText, "the hidden full-view status is already synchronized").toMatch(
            /^\d{2}:\d{2}:\d{2}–\d{2}:\d{2}:\d{2}$/,
        );

        const zoomOutAtFull = await boxOf(page, "#player-chart-zoom-out");
        const zoomInAtFull = await boxOf(page, "#player-chart-zoom-in");

        const full = await chartWindow(page);
        expect(full.zoomed).toBe(false);
        await zoomIn.click();
        await expect
            .poll(async () => {
                const view = await chartWindow(page);
                return view.max - view.min;
            })
            .toBeLessThan(full.max - full.min);
        await expect(zoomOut).toBeEnabled();
        await expect(reset).toBeVisible();
        await expect(reset).toHaveAccessibleName("Full view");
        await expect(reset).toHaveText("Full view");
        await expect(reset).toBeEnabled();
        await expect(reset).not.toHaveAttribute("aria-hidden", "true");
        await expect(status).toBeVisible();

        const factorText = (await factor.textContent())?.trim() ?? "";
        const rangeText = (await range.textContent())?.trim() ?? "";
        expect(factorText).toMatch(/^\d+(?:\.\d+)?×$/);
        expect(Number.parseFloat(factorText), "zoom status reports magnification above full view").toBeGreaterThan(1);
        expect(rangeText, "zoom status reports the visible clock range").toMatch(
            /^\d{2}:\d{2}:\d{2}–\d{2}:\d{2}:\d{2}$/,
        );
        expect(rangeText, "zooming changes the visible clock range").not.toBe(fullRangeText);
        const statusTitle = (await status.getAttribute("title")) ?? "";
        const statusAria = (await status.getAttribute("aria-label")) ?? "";
        for (const value of [statusTitle, statusAria]) {
            expect(value).toContain(factorText);
            expect(value).toContain(rangeText);
        }

        // Reset owns a concealed slot at full view. Revealing it must not resize
        // the navigator or move the two zoom buttons under the pointer.
        const overviewZoomed = await boxOf(page, "#player-chart-overview");
        const resetZoomed = await boxOf(page, "#player-chart-overview-reset");
        const zoomOutZoomed = await boxOf(page, "#player-chart-zoom-out");
        const zoomInZoomed = await boxOf(page, "#player-chart-zoom-in");
        expect(Math.abs(overviewZoomed.x - overviewAtFull.x), "overview keeps its x position").toBeLessThanOrEqual(1);
        expect(Math.abs(overviewZoomed.width - overviewAtFull.width), "overview keeps its width").toBeLessThanOrEqual(
            1,
        );
        expect(Math.abs(zoomOutZoomed.x - zoomOutAtFull.x), "zoom-out keeps its x position").toBeLessThanOrEqual(1);
        expect(Math.abs(zoomInZoomed.x - zoomInAtFull.x), "zoom-in keeps its x position").toBeLessThanOrEqual(1);
        expect(resetZoomed.x + resetZoomed.width, "Full view sits before zoom-out").toBeLessThanOrEqual(
            zoomOutZoomed.x + 1,
        );

        // Narrow layouts keep the factor visible and collapse only the visual
        // range. Assistive text and the native tooltip retain the full context.
        await page.setViewportSize(MOBILE);
        try {
            await expect(status).toBeVisible();
            await expect(factor).toBeVisible();
            await expect(range).toBeHidden();
            await expect(status).toHaveAttribute("title", statusTitle);
            await expect(status).toHaveAttribute("aria-label", statusAria);
        } finally {
            await page.setViewportSize(DESKTOP);
        }

        await reset.focus();
        await page.keyboard.press("Enter");
        await expect.poll(async () => (await chartWindow(page)).zoomed).toBe(false);
        await expect(status).toBeHidden();
        await expect(reset).toBeHidden();
        await expect(reset).toBeDisabled();
        await expect(reset).toHaveAttribute("aria-hidden", "true");
        await expect(zoomIn, "keyboard reset keeps focus in the zoom controls").toBeFocused();

        // A matching step in the other direction is reversible, without needing
        // the separate Full view reset.
        await page.keyboard.press("Enter");
        await zoomOut.focus();
        await page.keyboard.press("Enter");
        await expect.poll(async () => (await chartWindow(page)).zoomed).toBe(false);
        await expect(zoomOut).toBeDisabled();
        await expect(zoomIn).toBeEnabled();
        await expect(zoomIn, "keyboard zoom-out keeps focus when it reaches full view").toBeFocused();
        await expect(reset).toBeHidden();
        await expect(overview).toBeVisible();

        // The other limit is communicated too: once the shortest useful window
        // is reached, further zoom-in is unavailable while zoom-out remains so.
        await zoomIn.focus();
        for (let i = 0; i < 12 && (await zoomIn.isEnabled()); i++) await page.keyboard.press("Enter");
        await expect(zoomIn).toBeDisabled();
        await expect(zoomOut).toBeEnabled();
        await expect(zoomOut, "keyboard zoom-in keeps focus when it reaches the minimum span").toBeFocused();

        const viewportAtMinimum = await boxOf(page, "#player-chart-overview-viewport");
        const startAtMinimum = await boxOf(page, "#player-chart-overview-start");
        const endAtMinimum = await boxOf(page, "#player-chart-overview-end");
        expect(startAtMinimum.width).toBeGreaterThan(0);
        expect(endAtMinimum.width).toBeGreaterThan(0);
        expect(
            startAtMinimum.x + startAtMinimum.width,
            "fine-pointer edge hit targets do not overlap at minimum zoom",
        ).toBeLessThanOrEqual(endAtMinimum.x + 1);
        expect(startAtMinimum.width).toBeLessThanOrEqual(viewportAtMinimum.width / 2 + 1);
        expect(endAtMinimum.width).toBeLessThanOrEqual(viewportAtMinimum.width / 2 + 1);
    });

    test("zoom-out grows a programmatic below-floor view without jumping", async ({ page }) => {
        const play = page.locator("#player-play");
        if ((await play.getAttribute("data-paused")) === "false") await play.click();
        await expect(play).toHaveAttribute("data-paused", "true");

        // Export/event previews may intentionally create a window narrower than
        // the ordinary one-second navigation floor. Seed that valid state
        // directly: this regression is about how the shared navigator adopts an
        // already-created programmatic view, not about the preview entry point.
        const seeded = await page.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const st = (window as any).__everydashcam.state;
            const trip = st.active ? st.trips[st.active.trip] : null;
            if (!st.chart || !trip) throw new Error("chart window unavailable");
            const duration = trip.timeline.contentDurationSec as number;
            const normalFloorPct = Math.max(0.001, Math.min(0.5, 1 / duration));
            const normalFloorSec = normalFloorPct * duration;
            const span = normalFloorSec / 4;
            const min = duration * 0.4;
            st.chart.options.scales.x.min = min;
            st.chart.options.scales.x.max = min + span;
            st.chart.update("none");
            st.chartZoomed = true;
            st.isPreviewZoom = true;
            return { min, span, normalFloorSec };
        });
        const before = await chartWindow(page);
        expect(before.max - before.min, "seeded view really is below the ordinary floor").toBeCloseTo(seeded.span, 4);
        expect(before.max - before.min).toBeLessThan(seeded.normalFloorSec);

        // A real programmatic preview runs the same timeline sync immediately.
        // Our direct seed bypassed it, so let ResizeObserver reconcile the
        // navigator before asserting the initial ARIA contract and controls.
        await page.setViewportSize({ width: DESKTOP.width - 1, height: DESKTOP.height });
        const start = page.locator("#player-chart-overview-start");
        const end = page.locator("#player-chart-overview-end");
        await expect.poll(async () => Number(await start.getAttribute("aria-valuenow"))).toBeCloseTo(seeded.min, 4);
        expect(Number(await end.getAttribute("aria-valuenow"))).toBeCloseTo(seeded.min + seeded.span, 4);
        expect(Number(await start.getAttribute("aria-valuemax"))).toBeCloseTo(seeded.min, 4);
        expect(Number(await end.getAttribute("aria-valuemin"))).toBeCloseTo(seeded.min + seeded.span, 4);
        const zoomIn = page.locator("#player-chart-zoom-in");
        const zoomOut = page.locator("#player-chart-zoom-out");
        await expect(zoomIn).toBeDisabled();
        await expect(zoomOut).toBeEnabled();

        // One explicit outward step should grow from the actual view. The old
        // clamp jumped straight to normalFloorSec on this first interaction.
        await zoomOut.click();
        await expect
            .poll(async () => {
                const view = await chartWindow(page);
                return view.max - view.min;
            })
            .toBeGreaterThan(seeded.span);
        const after = await chartWindow(page);
        const grownSpan = after.max - after.min;
        expect(grownSpan, "outward zoom stays below the ordinary floor instead of jumping").toBeLessThan(
            seeded.normalFloorSec,
        );
        expect(after.zoomed).toBe(true);
        expect(await page.evaluate(() => (window as any).__everydashcam.state.isPreviewZoom)).toBe(false);

        // The handles announce the same effective floor the next independent
        // edge gesture will enforce: at a below-floor view neither edge can
        // make the viewport narrower, while both can still expand it.
        expect(Number(await start.getAttribute("aria-valuenow"))).toBeCloseTo(after.min, 4);
        expect(Number(await end.getAttribute("aria-valuenow"))).toBeCloseTo(after.max, 4);
        expect(Number(await start.getAttribute("aria-valuemax"))).toBeCloseTo(after.min, 4);
        expect(Number(await end.getAttribute("aria-valuemin"))).toBeCloseTo(after.max, 4);
        await expect(zoomIn).toBeDisabled();
        await expect(zoomOut).toBeEnabled();
    });

    test("timeline zoom row preserves the chart stack at 390px", async ({ page }) => {
        await page.setViewportSize(MOBILE);
        try {
            await expect(page.locator("#player-chart-zoom-row")).toBeVisible();
            const playerChart = await boxOf(page, "#player-chart");
            const canvas = await boxOf(page, "#player-chart-canvas");
            const strip = await boxOf(page, "#player-chart-inferred-strip-wrap");
            const zoomRow = await boxOf(page, "#player-chart-zoom-row");
            const overview = await boxOf(page, "#player-chart-overview");
            const rowOverflow = await page.locator("#player-chart-zoom-row").evaluate((el) => ({
                clientWidth: el.clientWidth,
                scrollWidth: el.scrollWidth,
            }));

            expect(zoomRow.y, "zoom row starts below the chart canvas").toBeGreaterThanOrEqual(
                canvas.y + canvas.height - 1,
            );
            expect(zoomRow.y, "zoom row starts below the event strip").toBeGreaterThanOrEqual(
                strip.y + strip.height - 1,
            );
            expect(zoomRow.x, "zoom row stays inside the chart on the left").toBeGreaterThanOrEqual(playerChart.x - 1);
            expect(zoomRow.x + zoomRow.width, "zoom row stays inside the chart on the right").toBeLessThanOrEqual(
                playerChart.x + playerChart.width + 1,
            );
            expect(zoomRow.y + zoomRow.height, "zoom row stays inside the chart at the bottom").toBeLessThanOrEqual(
                playerChart.y + playerChart.height + 1,
            );
            expect(
                Math.abs(overview.x + overview.width / 2 - (playerChart.x + playerChart.width / 2)),
                "390px navigator stays centered on the whole chart",
            ).toBeLessThanOrEqual(1);
            expect(overview.x, "navigator stays inside the chart on the left").toBeGreaterThanOrEqual(
                playerChart.x - 1,
            );
            expect(overview.x + overview.width, "navigator stays inside the chart on the right").toBeLessThanOrEqual(
                playerChart.x + playerChart.width + 1,
            );
            expect(rowOverflow.scrollWidth, "zoom row has no horizontal overflow at 390px").toBeLessThanOrEqual(
                rowOverflow.clientWidth + 1,
            );
            expect(overview.width, "navigator keeps a usable width beside the controls").toBeGreaterThan(40);
            expect(canvas.height, "mobile chart keeps a readable plot area").toBeGreaterThan(24);
        } finally {
            await page.setViewportSize(DESKTOP);
        }
    });

    test("timeline zoom row stays stable across the former 520px breakpoint", async ({ page }) => {
        await page.locator("#player-chart-zoom-in").click();
        await expect(page.locator("#player-chart-overview-reset")).toBeVisible();

        const geometryAt = async (width: number) => {
            await page.setViewportSize({ width, height: MOBILE.height });
            await expect.poll(async () => (await boxOf(page, "#player-chart-zoom-row")).width).toBeCloseTo(width, 0);
            const overview = await boxOf(page, "#player-chart-overview");
            const controls = await boxOf(page, ".chart-zoom-controls");
            const playerChart = await boxOf(page, "#player-chart");
            const rowOverflow = await page.locator("#player-chart-zoom-row").evaluate((el) => ({
                clientWidth: el.clientWidth,
                scrollWidth: el.scrollWidth,
            }));
            const resetLabelDisplay = await page
                .locator("#player-chart-overview-reset span")
                .evaluate((el) => getComputedStyle(el).display);
            const rangeDisplay = await page
                .locator("#player-chart-zoom-range")
                .evaluate((el) => getComputedStyle(el).display);
            return { overview, controls, playerChart, rowOverflow, resetLabelDisplay, rangeDisplay };
        };

        try {
            const at520 = await geometryAt(520);
            const at521 = await geometryAt(521);
            expect(
                Math.abs(at521.overview.width - at520.overview.width),
                "navigator has no breakpoint width jump",
            ).toBeLessThanOrEqual(2);
            expect(
                Math.abs(at521.controls.width - at520.controls.width),
                "controls grow continuously",
            ).toBeLessThanOrEqual(2);
            for (const [sample, width] of [
                [at520, 520],
                [at521, 521],
            ] as const) {
                expect(
                    Math.abs(
                        sample.overview.x +
                            sample.overview.width / 2 -
                            (sample.playerChart.x + sample.playerChart.width / 2),
                    ),
                    `${width}px navigator stays centred`,
                ).toBeLessThanOrEqual(1);
                expect(sample.rowOverflow.scrollWidth, `${width}px row does not overflow`).toBeLessThanOrEqual(
                    sample.rowOverflow.clientWidth + 1,
                );
                expect(sample.resetLabelDisplay, `${width}px reset stays icon-only`).toBe("none");
                expect(sample.rangeDisplay, `${width}px status does not reveal a clipped range`).toBe("none");
            }

            // The text returns only once its continuously-grown slot can show
            // the full English label; revealing it does not resize the row.
            const at647 = await geometryAt(647);
            const at648 = await geometryAt(648);
            expect(
                Math.abs(at648.overview.width - at647.overview.width),
                "label reveal keeps navigator width",
            ).toBeLessThanOrEqual(2);
            expect(at647.resetLabelDisplay).toBe("none");
            expect(at648.resetLabelDisplay).not.toBe("none");
            const labelOverflow = await page.locator("#player-chart-overview-reset span").evaluate((el) => ({
                clientWidth: el.clientWidth,
                scrollWidth: el.scrollWidth,
            }));
            expect(labelOverflow.scrollWidth, "expanded Full view label is not truncated").toBeLessThanOrEqual(
                labelOverflow.clientWidth + 1,
            );
        } finally {
            await page.setViewportSize(DESKTOP);
        }
    });

    test("playhead turns neutral at an excluded zoom edge and restores inside", async ({ page }) => {
        await pausePlayback(page);
        await seekToTripStart(page);

        const playerChart = page.locator("#player-chart");
        const playhead = page.locator("#player-chart-playhead");
        const thumb = page.locator("#player-mini-progress-thumb");
        const cursorColors = () =>
            page.evaluate(() => {
                const line = document.querySelector<HTMLElement>("#player-chart-playhead");
                const progressThumb = document.querySelector<HTMLElement>("#player-mini-progress-thumb");
                if (!line || !progressThumb) throw new Error("timeline cursor unavailable");
                return {
                    line: getComputedStyle(line).backgroundColor,
                    thumb: getComputedStyle(progressThumb).backgroundColor,
                };
            });

        await expect(playerChart).not.toHaveClass(/is-playhead-outside-view/);
        await expect(playhead).toBeVisible();
        await expect(thumb).toBeVisible();
        const accent = await cursorColors();
        expect(accent.line, "line and thumb share the accent in range").toBe(accent.thumb);

        // Keep the paused playhead at trip start and inspect only the right-hand
        // part of the trip. Drag-select changes the view without seeking.
        const canvas = await boxOf(page, "#player-chart-canvas");
        const selectY = canvas.y + canvas.height * 0.4;
        await page.mouse.move(canvas.x + canvas.width * 0.6, selectY);
        await page.mouse.down();
        await page.mouse.move(canvas.x + canvas.width * 0.75, selectY, { steps: 3 });
        await page.mouse.move(canvas.x + canvas.width * 0.9, selectY, { steps: 3 });
        await page.mouse.up();

        await expect(playerChart).toHaveClass(/is-playhead-outside-view/);
        const outside = await cursorColors();
        expect(outside.line, "outside line and thumb share the neutral color").toBe(outside.thumb);
        expect(outside.line, "outside color differs from the active accent").not.toBe(accent.line);

        const lineAtEdge = await boxOf(page, "#player-chart-playhead");
        const thumbAtEdge = await boxOf(page, "#player-mini-progress-thumb");
        const progress = await boxOf(page, "#player-mini-progress");
        const lineCenter = lineAtEdge.x + lineAtEdge.width / 2;
        const thumbCenter = thumbAtEdge.x + thumbAtEdge.width / 2;
        expect(Math.abs(lineCenter - thumbCenter), "line and thumb clamp to the same edge").toBeLessThanOrEqual(1);
        expect(lineCenter, "excluded trip start clamps at the left edge").toBeLessThan(
            progress.x + progress.width * 0.2,
        );

        // The scrubber maps to the visible inspection window, so its midpoint
        // is an unambiguous seek back inside without resetting the zoom.
        await page.mouse.click(progress.x + progress.width * 0.5, progress.y + progress.height / 2);
        await expect(playerChart).not.toHaveClass(/is-playhead-outside-view/);
        await expect.poll(cursorColors).toEqual(accent);
        const lineInside = await boxOf(page, "#player-chart-playhead");
        const thumbInside = await boxOf(page, "#player-mini-progress-thumb");
        expect(
            Math.abs(lineInside.x + lineInside.width / 2 - (thumbInside.x + thumbInside.width / 2)),
            "line and thumb stay aligned after the seek",
        ).toBeLessThanOrEqual(1);
    });

    test("timeline overview edge drag narrows and restores the visible window", async ({ page }) => {
        const overview = await boxOf(page, "#player-chart-overview");
        const startHandle = page.locator("#player-chart-overview-start");
        await expect(startHandle).toBeVisible();

        const initial = await chartWindow(page);
        const start = await boxOf(page, "#player-chart-overview-start");
        const y = start.y + start.height / 2;
        await page.mouse.move(start.x + start.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(overview.x + overview.width * 0.25, y, { steps: 5 });
        await page.mouse.up();

        await expect
            .poll(async () => (await chartWindow(page)).min, { message: "start edge drag must narrow the window" })
            .toBeGreaterThan(initial.duration * 0.15);
        const narrowed = await chartWindow(page);
        expect(narrowed.zoomed).toBe(true);
        expect(narrowed.max).toBeCloseTo(initial.duration, 2);

        const movedStart = await boxOf(page, "#player-chart-overview-start");
        const movedY = movedStart.y + movedStart.height / 2;
        await page.mouse.move(movedStart.x + movedStart.width / 2, movedY);
        await page.mouse.down();
        await page.mouse.move(overview.x, movedY, { steps: 5 });
        await page.mouse.up();

        await expect.poll(async () => (await chartWindow(page)).zoomed).toBe(false);
        const restored = await chartWindow(page);
        expect(restored.min).toBeCloseTo(0, 4);
        expect(restored.max).toBeCloseTo(initial.duration, 4);

        // A captured right edge keeps resizing throughout the gesture. Status
        // and reset updates must not feed back into navigator width mid-drag.
        const end = await boxOf(page, "#player-chart-overview-end");
        const endY = end.y + end.height / 2;
        const maxByStep = [restored.max];
        await page.mouse.move(end.x + end.width / 2, endY);
        await page.mouse.down();
        for (const ratio of [0.9, 0.8, 0.7]) {
            await page.mouse.move(overview.x + overview.width * ratio, endY, { steps: 3 });
            maxByStep.push((await chartWindow(page)).max);
            const overviewAtStep = await boxOf(page, "#player-chart-overview");
            expect(
                Math.abs(overviewAtStep.width - overview.width),
                `overview width stays fixed at ${ratio}`,
            ).toBeLessThanOrEqual(1);
        }
        await page.mouse.move(overview.x + overview.width, endY, { steps: 3 });
        await page.mouse.up();

        for (let i = 1; i < maxByStep.length; i++) {
            expect(maxByStep[i]!, `right-edge step ${i} narrows the window`).toBeLessThan(maxByStep[i - 1]!);
        }
        await expect.poll(async () => (await chartWindow(page)).zoomed).toBe(false);
    });

    test("timeline overview edges expose slider values and resize by keyboard", async ({ page }) => {
        const start = page.locator("#player-chart-overview-start");
        const end = page.locator("#player-chart-overview-end");
        const initial = await chartWindow(page);

        await expect(start).toHaveAttribute("role", "slider");
        await expect(end).toHaveAttribute("role", "slider");
        await expect(start).toHaveAccessibleName(/start/i);
        await expect(end).toHaveAccessibleName(/end/i);
        const startMin = Number(await start.getAttribute("aria-valuemin"));
        const startMax = Number(await start.getAttribute("aria-valuemax"));
        const endMin = Number(await end.getAttribute("aria-valuemin"));
        const endMax = Number(await end.getAttribute("aria-valuemax"));
        expect(startMin).toBe(0);
        expect(startMax).toBeGreaterThan(0);
        expect(startMax).toBeLessThan(initial.duration);
        expect(endMin).toBeGreaterThan(0);
        expect(endMax).toBeCloseTo(initial.duration, 4);
        expect(startMax + endMin, "both handles expose the same minimum span").toBeCloseTo(initial.duration, 4);
        expect(Number(await start.getAttribute("aria-valuenow"))).toBeCloseTo(0, 4);
        expect(Number(await end.getAttribute("aria-valuenow"))).toBeCloseTo(initial.duration, 4);

        await start.press("ArrowRight");
        await expect
            .poll(async () => (await chartWindow(page)).min, { message: "ArrowRight moves the start later" })
            .toBeGreaterThan(0);
        const narrowedStart = await chartWindow(page);
        expect(Number(await start.getAttribute("aria-valuenow"))).toBeCloseTo(narrowedStart.min, 2);
        expect(Number(await end.getAttribute("aria-valuemin"))).toBeCloseTo(narrowedStart.min + endMin, 2);
        await start.press("ArrowLeft");
        await expect.poll(async () => (await chartWindow(page)).zoomed).toBe(false);

        await end.press("ArrowLeft");
        await expect
            .poll(async () => (await chartWindow(page)).max, { message: "ArrowLeft moves the end earlier" })
            .toBeLessThan(initial.duration);
        const narrowedEnd = await chartWindow(page);
        expect(Number(await end.getAttribute("aria-valuenow"))).toBeCloseTo(narrowedEnd.max, 2);
        expect(Number(await start.getAttribute("aria-valuemax"))).toBeCloseTo(narrowedEnd.max - endMin, 2);
        await end.press("ArrowRight");
        await expect.poll(async () => (await chartWindow(page)).zoomed).toBe(false);
    });

    test("sidebar collapse button hides the trip list and the edge tab restores it", async ({ page }) => {
        const sidebar = page.locator(".sidebar").first();
        await expect(sidebar).toBeVisible();
        await page.locator("#sidebar-collapse").click();
        await expect(sidebar, "list leaves the layout").toBeHidden();
        const tab = page.locator("#sidebar-expand");
        await expect(tab, "edge tab is the way back").toBeVisible();
        // The viewer must take over the freed column, not slide into the
        // 0-width sidebar track (which rendered the whole area black when
        // the hidden boxes left the grid flow).
        const viewport = page.viewportSize();
        const video = await page.locator("#video-grid").boundingBox();
        expect(video?.width ?? 0, "player keeps a real width").toBeGreaterThan((viewport?.width ?? 0) * 0.5);
        // Session-only by design: a fresh page must show the list again (it is
        // the only way to pick a trip). Asserted as "nothing about collapsing
        // was written", not as one guessed key name - a persistence attempt
        // under any other name has to fail this too.
        const persisted = await page.evaluate(() => Object.keys(localStorage).filter((k) => /collaps/i.test(k)));
        expect(persisted, "no localStorage key about collapsing may be written").toEqual([]);
        await tab.click();
        await expect(sidebar).toBeVisible();
        await expect(tab).toBeHidden();
    });

    test("map divider drag resizes the expanded map pane", async ({ page }) => {
        await page.locator("#mini-map").click();
        await expect(page.locator("#player-wrap")).toHaveClass(/map-expanded/);
        const before = await page.locator("#map").boundingBox();
        expect(before, "map pane must be laid out").not.toBeNull();

        const divider = await boxOf(page, "#video-map-resize");
        const y = divider.y + divider.height / 2;
        await page.mouse.move(divider.x + divider.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(divider.x - 120, y, { steps: 5 });
        await page.mouse.up();

        const after = await page.locator("#map").boundingBox();
        expect((after?.width ?? 0) - (before?.width ?? 0), "map grows by roughly the drag distance").toBeGreaterThan(
            80,
        );
        // The bar loses the map column's width in this layout; buttons must
        // shed into the overflow menu instead of squishing (flex-shrink: 0).
        const play = await boxOf(page, "#player-play");
        expect(play.width, "transport keeps its size in the narrowed bar").toBeGreaterThanOrEqual(38);
        await page.locator("#map-collapse").click();
        await expect(page.locator("#player-wrap")).not.toHaveClass(/map-expanded/);
    });

    test("fullscreen: mini-map click expands the map into a visible split", async ({ page }) => {
        await page.locator("#player-fullscreen").click();
        await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);

        // Desktop expand entry is the mini-map circle. In fullscreen it must
        // reveal the big map pane (video | map split), not leave both maps
        // invisible until fullscreen exit.
        await page.locator("#mini-map").click();
        await expect(page.locator("#player-wrap")).toHaveClass(/map-expanded/);
        const mapBox = await page.locator("#map").boundingBox();
        expect(mapBox, "big map pane must be laid out").not.toBeNull();
        expect(mapBox?.width ?? 0, "map pane occupies a real column").toBeGreaterThan(200);
        // The video keeps the remaining width instead of the 100vw overlay size.
        const videoBox = await page.locator("#video-grid").boundingBox();
        const viewport = page.viewportSize();
        expect((videoBox?.width ?? 0) + (mapBox?.width ?? 0), "split shares the screen").toBeLessThanOrEqual(
            (viewport?.width ?? 0) + 8,
        );

        // The chart/bar overlays are confined to the video column, so the
        // map's lower band keeps taking pointer input while the controls are
        // visible (mousemove keeps them visible whenever the cursor lives on
        // the map, so a full-width overlay would permanently shadow it).
        const probeX = (mapBox?.x ?? 0) + (mapBox?.width ?? 0) / 2;
        const probeY = (mapBox?.y ?? 0) + (mapBox?.height ?? 0) - 20;
        await page.mouse.move(probeX, probeY);
        await expect(page.locator("#player-wrap")).toHaveClass(/controls-visible/);
        const hitsMap = await page.evaluate(
            ([x, y]) => !!document.elementFromPoint(x ?? 0, y ?? 0)?.closest(".map-wrap"),
            [probeX, probeY],
        );
        expect(hitsMap, "map bottom stays clickable under visible controls").toBe(true);

        // The map's collapse X returns to the video-only fullscreen layout.
        await page.locator("#map-collapse").click();
        await expect(page.locator("#player-wrap")).not.toHaveClass(/map-expanded/);
        await expect.poll(() => page.evaluate(() => !!document.fullscreenElement), "still fullscreen").toBe(true);

        await page.evaluate(() => document.exitFullscreen());
        await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    });

    test("fullscreen overlays keep the selected light palette", async ({ page }) => {
        await page.locator('.theme-toggle-btn[data-theme="light"]').click();
        await expect(page.locator("html")).toHaveClass(/dc-light/);

        await page.locator("#player-fullscreen").click();
        await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);

        await page.locator("#player-view-menu").click();
        await page.locator('.view-menu-row[data-panel="chart"]').click();
        await page.locator('.view-menu-row[data-panel="readout"]').click();
        await page.locator("#player-view-menu").click();
        await expect(page.locator("#player-chart")).toBeVisible();
        await expect(page.locator("#player-readout")).toBeVisible();

        const palettes = await page.locator("#player-wrap").evaluate(() => {
            const rgba = (color: string): number[] => {
                const canvas = document.createElement("canvas");
                canvas.width = 1;
                canvas.height = 1;
                const context = canvas.getContext("2d");
                if (!context) throw new Error("canvas context unavailable");
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                return Array.from(context.getImageData(0, 0, 1, 1).data);
            };

            return ["player-chart", "player-readout", "player-bar"].map((id) => {
                const element = document.getElementById(id);
                if (!element) throw new Error(`missing #${id}`);
                const style = getComputedStyle(element);
                return { id, background: rgba(style.backgroundColor), foreground: rgba(style.color) };
            });
        });

        for (const { id, background, foreground } of palettes) {
            expect(Math.min(...background.slice(0, 3)), `${id} uses a light fullscreen surface`).toBeGreaterThan(230);
            expect(Math.max(...foreground.slice(0, 3)), `${id} keeps dark light-theme text`).toBeLessThan(128);
        }

        await page.evaluate(() => document.exitFullscreen());
        await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    });

    test("chart drag-select zooms to the selected span", async ({ page }) => {
        const chart = await boxOf(page, "#player-chart-canvas");
        const y = chart.y + chart.height * 0.4;
        // Drag from ~30% to ~70% of the plot. Multiple intermediate moves so the
        // selection threshold trips and the selection rectangle path runs.
        await page.mouse.move(chart.x + chart.width * 0.3, y);
        await page.mouse.down();
        await page.mouse.move(chart.x + chart.width * 0.45, y, { steps: 4 });
        await expect(page.locator(".chart-drag-select"), "selection rect appears mid-drag").toBeVisible();
        await page.mouse.move(chart.x + chart.width * 0.7, y, { steps: 4 });
        await page.mouse.up();

        const zoomState = await page.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const st = (window as any).__everydashcam.state;
            return {
                zoomed: st.chartZoomed,
                preview: st.isPreviewZoom,
                windowMin: st.chart.scales.x.min as number,
                windowMax: st.chart.scales.x.max as number,
            };
        });
        expect(zoomState.zoomed, "drag-select must zoom the timeline").toBe(true);
        expect(zoomState.preview, "drag-select is inspection, not a preview").toBe(false);
        // The window matches the dragged span, not the full trip.
        expect(zoomState.windowMin).toBeGreaterThan(0);
        expect(zoomState.windowMax).toBeLessThan(4);
        expect(zoomState.windowMax).toBeGreaterThan(zoomState.windowMin);
        // The selection rectangle is gone after release.
        await expect(page.locator(".chart-drag-select")).toHaveCount(0);

        // Recovery is visible and labelled; it must not depend on knowing the
        // double-click gesture.
        const reset = page.locator("#player-chart-overview-reset");
        await expect(reset).toBeVisible();
        await expect(reset).toHaveAccessibleName("Full view");
        await expect(reset).toHaveText("Full view");
        await expect(reset).toBeEnabled();
        await shot(page, "player-05b-timeline-zoom-reset");
        await reset.click();
        await expect
            .poll(() =>
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                page.evaluate(() => (window as any).__everydashcam.state.chartZoomed),
            )
            .toBe(false);
        await expect(reset).toBeHidden();
    });

    test("small pointer wobble on the chart does not zoom the timeline", async ({ page }) => {
        const chart = await boxOf(page, "#player-chart-canvas");
        const x = chart.x + chart.width * 0.45;
        const y = chart.y + chart.height * 0.4;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 8, y);
        await page.mouse.up();

        await expect
            .poll(() =>
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                page.evaluate(() => (window as any).__everydashcam.state.chartZoomed),
            )
            .toBe(false);
        await expect(page.locator("#player-chart-overview-reset")).toBeHidden();
    });

    test("inspection zoom does not clamp seeks to the window", async ({ page }) => {
        // A wheel/keyboard zoom is inspection, not a bounded Preview-clip window:
        // seeks must roam the whole trip (isPreviewZoom stays false). Regression
        // for the old "any zoom traps playback in its window" behavior.
        await pausePlayback(page);

        const chart = await boxOf(page, "#player-chart");
        await page.mouse.move(chart.x + chart.width * 0.2, chart.y + chart.height * 0.4);
        for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -200);

        const zoomState = await page.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const st = (window as any).__everydashcam.state;
            return { zoomed: st.chartZoomed, preview: st.isPreviewZoom, windowMax: st.chart.scales.x.max as number };
        });
        expect(zoomState.zoomed, "the wheel must have zoomed the timeline").toBe(true);
        expect(zoomState.preview, "a wheel zoom is inspection, not a preview").toBe(false);
        // The window ends before the trip end, so a 90%-of-trip seek overshoots it.
        expect(zoomState.windowMax).toBeLessThan(3);

        // Digit "9" jumps to 90% of the TRIP (~3.6s) - a trip-time seek past the
        // window edge (the mini-progress scrubber is window-mapped and can't reach
        // past it, so it cannot exercise the clamp). Inspection lets it land there;
        // a preview window would clamp it back. Paused, so this is the seek alone,
        // not playback drifting past the edge.
        await page.keyboard.press("9");
        const current = page.locator("#player-current");
        await expect
            .poll(() =>
                current.evaluate((el) =>
                    Number((el.textContent ?? "0:0").split(":").reduce((a, p) => a * 60 + Number(p), 0)),
                ),
            )
            .toBeGreaterThan(zoomState.windowMax);
    });

    test("inspection zoom playback crosses the window edge instead of stopping", async ({ page }) => {
        // The core fix: playing inside an inspection zoom must NOT stop/loop at the
        // window's right edge (that behavior is reserved for a Preview-clip window).
        const parseClock = (s: string): number => s.split(":").reduce((a, p) => a * 60 + Number(p), 0);
        const chart = await boxOf(page, "#player-chart");
        await page.mouse.move(chart.x + chart.width * 0.2, chart.y + chart.height * 0.4);
        for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -200);
        const windowMax = await page.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const st = (window as any).__everydashcam.state;
            return st.chartZoomed && !st.isPreviewZoom ? (st.chart.scales.x.max as number) : Number.NaN;
        });
        expect(windowMax, "must be a live inspection zoom below the trip end").toBeGreaterThan(0);
        expect(windowMax).toBeLessThan(3);

        // Seek just inside the window, then play. A grace window pauses auto-follow
        // right after the wheel gesture, but inspection playback is unbounded
        // regardless, so the playhead runs straight past the (frozen) window edge.
        const bar = await boxOf(page, "#player-mini-progress");
        const seekFrac = Math.max(0.02, (windowMax - 0.4) / 4);
        await page.mouse.click(bar.x + bar.width * seekFrac, bar.y + bar.height / 2);
        const play = page.locator("#player-play");
        if ((await play.getAttribute("data-paused")) === "true") await play.click();
        await expect(play).toHaveAttribute("data-paused", "false");

        const current = page.locator("#player-current");
        await expect
            .poll(async () => parseClock((await current.textContent())?.trim() ?? "0:00"), { timeout: 6000 })
            .toBeGreaterThan(windowMax);
    });

    test("playhead re-anchors when the chart resizes while paused", async ({ page }) => {
        // Export mode resizes the chart while playback is paused. The playhead
        // must retain its timeline fraction without another timeupdate.
        await pausePlayback(page);

        const playhead = page.locator("#player-chart-playhead");
        // Read the resolved CSS position so the assertion measures rendered
        // geometry regardless of whether positioning uses pixels or percentages.
        const playheadFraction = async (): Promise<number> => {
            const left = await playhead.evaluate((el) => Number.parseFloat(getComputedStyle(el).left));
            const width = await page.locator("#player-chart").evaluate((el) => (el as HTMLElement).clientWidth);
            expect(width, "chart must have a width").toBeGreaterThan(0);
            return left / width;
        };

        // Seek well past the start so a frozen playhead is clearly off. Gate on
        // the observable result instead of sleeping for a guessed decoder time:
        // cross-file MSE seeks vary most on software-decoding CI runners.
        const bar = await boxOf(page, "#player-mini-progress");
        await page.mouse.click(bar.x + bar.width * 0.7, bar.y + bar.height / 2);
        await expect.poll(playheadFraction, { message: "the seek must land before the resize" }).toBeGreaterThan(0.4);

        const before = await playheadFraction();
        expect(before, "playhead must sit away from the left edge to expose drift").toBeGreaterThan(0.4);

        const chartWidthBefore = await page.locator("#player-chart").evaluate((el) => (el as HTMLElement).clientWidth);
        await page.setViewportSize({ width: 900, height: 900 });
        // Wait for the chart to actually shrink, otherwise the assertion below
        // could pass trivially on a no-op resize (silent green).
        await expect
            .poll(() => page.locator("#player-chart").evaluate((el) => (el as HTMLElement).clientWidth))
            .not.toBe(chartWidthBefore);

        // Re-anchored: same trip-time fraction (bar the gutter wobble). Without
        // the fix the playhead px is frozen at the old width and the fraction
        // drifts far past this tolerance on a shrink this big - and, since the
        // seek has already landed and playback is paused, nothing ever heals it
        // (exactly the export-mode report). The poll only covers the fix's own
        // async settle (the ResizeObserver fires a frame after Chart.js resizes).
        await expect.poll(playheadFraction, { timeout: 4000 }).toBeCloseTo(before, 1);
    });

    test("timeline click seeks even when the chart canvas is hidden", async ({ page }) => {
        // Hide chart + strip -> the canvas is display:none, exactly the no-GPS
        // layout. Clicking the ruler must still seek (shared handler, not the
        // dead plot area).
        await page.locator("#player-view-menu").click();
        await page.locator('.view-menu-row[data-panel="chart"]').click();
        await page.locator('.view-menu-row[data-panel="strip"]').click();
        await page.locator("body").click(); // close popover
        await expect(page.locator("#player-chart-canvas")).toBeHidden();

        const current = page.locator("#player-current");
        const before = (await current.textContent())?.trim();
        const ruler = await boxOf(page, "#player-chart-ruler-top");
        await page.mouse.click(ruler.x + ruler.width * 0.7, ruler.y + ruler.height / 2);
        await expect(current).not.toHaveText(before ?? "");
        await expect(current).not.toHaveText("0:00");
    });

    test("the readout row carries the GPS values and copies the coordinates", async ({ page }) => {
        const row = page.locator("#player-readout");
        await expect(row).toBeVisible();
        // Nothing has been played in this test, so no timeupdate has fired yet.
        // The row must already be telling the truth about the activated trip -
        // a paused player that never starts would otherwise leave it claiming
        // "no GPS data" over a full track.
        await expect(page.locator("#player-readout")).not.toHaveClass(/is-nofix/);
        // Speed left the bar for the row - the bar's copy is the mobile one.
        await expect(page.locator("#player-metrics")).toBeHidden();
        await expect(page.locator("#pm-coords")).toHaveText(/-?\d+\.\d{4}, -?\d+\.\d{4}/);
        await expect(page.locator("#pm-time")).toHaveText(/\d{2}:\d{2}:\d{2}/);
        await expect(page.locator("#readout-fix-label")).toHaveText("GPS signal");
        // The clip name is what you need before going looking for the file.
        await expect(page.locator("#readout-file")).toHaveText(/\.(mp4|mov|ts)$/i);

        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        const shown = (await page.locator("#pm-coords").textContent())?.trim();
        await page.locator("#pm-coords").click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        expect(copied, "the clipboard must carry exactly what the row showed").toBe(shown);
    });

    test("the View menu collapses the readout row and G toggles it back", async ({ page }) => {
        const row = page.locator("#player-readout");
        const frameHeight = async (): Promise<number> => (await boxOf(page, ".video-frame")).height;
        const withRow = await frameHeight();

        await page.locator("#player-view-menu").click();
        await page.locator('.view-menu-row[data-panel="readout"]').click();
        await page.locator("body").click(); // close popover
        await expect(row).toBeHidden();
        // The row's grid track is `auto`, so hiding it hands the height back to
        // the video rather than leaving a gap.
        expect(await frameHeight(), "hiding the row must give the video its pixels back").toBeGreaterThan(withRow);

        await page.keyboard.press("g");
        await expect(row).toBeVisible();
    });

    test("hotkeys modal opens with '?'", async ({ page }) => {
        await page.keyboard.press("?");
        await expect(page.locator("#hotkeys-modal")).toBeVisible();
        await shot(page, "player-06-hotkeys-modal");
    });

    test("global letter hotkeys are inert while a modal is open", async ({ page }) => {
        const inExportMode = () => page.evaluate(() => document.body.classList.contains("export-mode"));
        expect(await inExportMode(), "trip loads outside export-mode").toBe(false);

        await page.keyboard.press("?");
        const modal = page.locator("#hotkeys-modal");
        await expect(modal).toBeVisible();

        // "e" must NOT leak to toggleExportMode while the modal owns the keyboard.
        await page.keyboard.press("e");
        expect(await inExportMode(), "E must not toggle export-mode under a modal").toBe(false);
        await expect(modal).toBeVisible();

        // Close it; the same hotkey now works - the gate is "a modal is open",
        // not a blanket disable.
        await page.keyboard.press("Escape");
        await expect(modal).toBeHidden();
        await page.keyboard.press("e");
        await expect.poll(() => inExportMode()).toBe(true);
    });

    test("expanded map on a narrow desktop window borrows the sidebar column, video and chart stay", async ({
        page,
    }) => {
        // Foldable / portrait-tablet zone: desktop layout (>= 768) but too
        // narrow to fit sidebar + video + map side by side. The sidebar
        // column yields (sidebar.css) instead of the pwrap takeover hiding
        // the video (viewer.css).
        await page.setViewportSize({ width: 900, height: 760 });
        await page.locator("#mini-map").click();
        await expect(page.locator("#player-wrap")).toHaveClass(/map-expanded/);

        // The map opens BESIDE the video, not instead of it.
        await expect(page.locator(".map-wrap")).toBeVisible();
        await expect(page.locator(".video-frame")).toBeVisible();
        await expect(page.locator("#player-chart-canvas")).toBeVisible();
        await expect(page.locator("#sidebar")).toBeHidden();

        // Collapsing the map hands the column back to the trip list.
        await page.locator("#map-collapse").click();
        await expect(page.locator("#player-wrap")).not.toHaveClass(/map-expanded/);
        await expect(page.locator("#sidebar")).toBeVisible();
        await expect(page.locator("#mini-map")).toBeVisible();
    });

    test("settings: switching units updates the speed unit label", async ({ page }) => {
        await page.locator("#settings-btn").click();
        await expect(page.locator("#settings-modal")).toBeVisible();
        const sel = page.locator("#settings-units-select");
        const before = await sel.inputValue();
        const target = before === "metric" ? "imperial" : "metric";
        await sel.selectOption(target);
        await page.locator("#settings-modal-close").click();
        const unit = page.locator("#pm-unit");
        if (target === "metric") await expect(unit).toHaveText(/kph|km/i);
        else await expect(unit).toHaveText(/mph|mi/i);
        await shot(page, "player-07-units");
    });

    test("settings: map marker changes the same global preference", async ({ page }) => {
        await page.locator("#settings-btn").click();
        const control = page.locator('[data-marker-control="settings"]');
        await expect(control).toBeVisible();
        await control.locator('button[data-marker-shape="van"]').click();
        await control.locator('button[data-marker-color="#e5484d"]').click();
        await control.locator('button[data-marker-size="small"]').click();
        await control.scrollIntoViewIfNeeded();
        await shot(page, "player-11-map-marker-settings");
        await page.locator("#settings-modal-close").click();

        await expect(page.locator("#mini-map .car-marker__canvas")).toHaveAttribute(
            "data-marker-render-key",
            "van:#e5484d:overhead",
        );
        const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("everydashcam:mapMarker") ?? "null"));
        expect(stored).toEqual({ shape: "van", color: "#e5484d", size: "small" });
    });
});

test.describe("player timeline with a coarse pointer", () => {
    test.use({ hasTouch: true, isMobile: true });

    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(MOBILE);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);
    });

    test("navigator keeps coarse edge targets separate at minimum zoom", async ({ page }) => {
        const overview = await boxOf(page, "#player-chart-overview");
        expect(overview.height, "coarse-pointer navigator height").toBeCloseTo(36, 0);
        expect(overview.width, "real phone keeps useful navigator width").toBeGreaterThan(140);
        await expect(page.locator("#player-chart-overview-reset span")).toBeHidden();
        await expect(page.locator("#player-chart-zoom-out")).toHaveCSS("width", "36px");
        await expect(page.locator("#player-chart-zoom-in")).toHaveCSS("width", "36px");

        const zoomIn = page.locator("#player-chart-zoom-in");
        for (let i = 0; i < 12 && (await zoomIn.isEnabled()); i++) await zoomIn.click();
        await expect(zoomIn).toBeDisabled();

        const viewport = await boxOf(page, "#player-chart-overview-viewport");
        const start = await boxOf(page, "#player-chart-overview-start");
        const end = await boxOf(page, "#player-chart-overview-end");
        expect(viewport.width, "fixture reaches a viewport narrower than two full touch targets").toBeLessThan(72);
        await expect(page.locator("#player-chart-overview-viewport")).toHaveClass(/is-compact/);
        expect(start.width, "start keeps a two-half hit region").toBeCloseTo(72, 0);
        expect(end.width, "end keeps a two-half hit region").toBeCloseTo(72, 0);
        expect(Math.abs(start.x - end.x)).toBeLessThanOrEqual(1);

        const hitY = start.y + start.height / 2;
        const leftHitX = start.x + start.width * 0.25;
        const rightHitX = start.x + start.width * 0.75;
        const owners = await page.evaluate(
            ({ leftHitX, rightHitX, hitY }) =>
                [leftHitX, rightHitX].map(
                    (x) => document.elementFromPoint(x, hitY)?.closest<HTMLElement>("[role=slider]")?.id ?? null,
                ),
            { leftHitX, rightHitX, hitY },
        );
        expect(owners, "the clipped halves expose different edge controls").toEqual([
            "player-chart-overview-start",
            "player-chart-overview-end",
        ]);

        const before = await chartWindow(page);
        await page.mouse.move(rightHitX, hitY);
        await page.mouse.down();
        await page.mouse.move(rightHitX + 30, hitY, { steps: 3 });
        await page.mouse.up();
        await expect
            .poll(async () => (await chartWindow(page)).max, { message: "coarse end target remains draggable" })
            .toBeGreaterThan(before.max);
    });
});

test.describe("single-clip playback endings", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_NOGPS);
    });

    async function parkNearEnd(page: Page): Promise<void> {
        await pausePlayback(page);

        const master = page.locator(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)");
        const target = await master.evaluate((video: HTMLVideoElement) => {
            video.playbackRate = 8;
            const next = Math.max(0, video.duration - Math.min(1, video.duration / 2));
            video.currentTime = next;
            return next;
        });
        await expect
            .poll(() =>
                master.evaluate(
                    (video: HTMLVideoElement, targetSec) =>
                        !video.seeking && Math.abs(video.currentTime - targetSec) < 0.05,
                    target,
                ),
            )
            .toBe(true);
    }

    test("looping restarts a single native clip after it ends", async ({ page }) => {
        await parkNearEnd(page);
        const loop = page.locator("#player-loop");
        await loop.click();
        await expect(loop).toHaveAttribute("aria-pressed", "true");

        const master = page.locator(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)");
        await master.evaluate((video: HTMLVideoElement) => {
            delete document.body.dataset.loopEnded;
            delete document.body.dataset.loopRestartTime;
            video.addEventListener("ended", () => {
                document.body.dataset.loopEnded = "true";
            });
            video.addEventListener("play", () => {
                if (document.body.dataset.loopEnded === "true") {
                    document.body.dataset.loopRestartTime = String(video.currentTime);
                }
            });
        });
        await page.locator("#player-play").click();
        await expect(page.locator("body")).toHaveAttribute("data-loop-ended", "true");
        await expect(page.locator("body")).toHaveAttribute("data-loop-restart-time", /.+/);
        const restart = Number(await page.locator("body").getAttribute("data-loop-restart-time"));
        const duration = await master.evaluate((video: HTMLVideoElement) => video.duration);
        expect(restart, "loop resumes near the start").toBeLessThan(duration / 2);
    });

    test("Play restarts a finished single native clip", async ({ page }) => {
        await parkNearEnd(page);
        const play = page.locator("#player-play");
        const master = page.locator(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)");

        await master.evaluate((video: HTMLVideoElement) => {
            delete document.body.dataset.nativeEnded;
            video.addEventListener("ended", () => {
                document.body.dataset.nativeEnded = "true";
            });
        });
        await play.click();
        await expect(page.locator("body")).toHaveAttribute("data-native-ended", "true");
        await master.evaluate((video: HTMLVideoElement) => {
            delete document.body.dataset.restartPlayTime;
            video.addEventListener(
                "play",
                () => {
                    document.body.dataset.restartPlayTime = String(video.currentTime);
                },
                { once: true },
            );
        });
        await play.click();
        await expect(page.locator("body")).toHaveAttribute("data-restart-play-time", /.+/);
        const restart = Number(await page.locator("body").getAttribute("data-restart-play-time"));
        const duration = await master.evaluate((video: HTMLVideoElement) => video.duration);
        expect(restart, "Play resumes near the start").toBeLessThan(duration / 2);
    });
});

test.describe("player scrub seeks", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        // Chromium has no fastSeek. A stand-in landing on whole seconds models
        // the key-frame seek Safari and Firefox perform during a drag.
        await page.addInitScript(() => {
            const proto = HTMLMediaElement.prototype as HTMLMediaElement & { fastSeek(time: number): void };
            proto.fastSeek = function (this: HTMLMediaElement, time: number) {
                this.dataset.fastSeeks = String(Number(this.dataset.fastSeeks ?? "0") + 1);
                this.currentTime = Math.floor(time);
            };
        });
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);
    });

    test("drag moves seek to key frames and the release lands exactly", async ({ page }) => {
        await pausePlayback(page);
        const master = page.locator(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)");
        const bar = await boxOf(page, "#player-mini-progress");
        const y = bar.y + bar.height / 2;
        await page.mouse.move(bar.x + bar.width * 0.1, y);
        await page.mouse.down();
        await page.mouse.move(bar.x + bar.width * 0.27, y, { steps: 6 });
        expect(
            Number(await master.getAttribute("data-fast-seeks")),
            "drag moves use key-frame seeks where the browser offers them",
        ).toBeGreaterThan(0);
        await page.mouse.up();
        await expect
            .poll(() => master.evaluate((video: HTMLVideoElement) => !video.seeking && video.currentTime % 1 !== 0), {
                message: "the release seeks exactly instead of staying on the key frame",
            })
            .toBe(true);
    });
});

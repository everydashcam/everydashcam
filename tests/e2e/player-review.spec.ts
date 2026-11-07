import {
    DESKTOP,
    MOBILE,
    SAMPLE_70MAI,
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

test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await presetLocalStorage(page);
});

test("transport follows the video center with expanded map and fullscreen", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("everydashcam:hotkeys:seekStepSec", "600"));
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    const assertCentered = async (): Promise<void> => {
        await expect
            .poll(async () => {
                const anchor = await boxOf(
                    page,
                    (await page.locator(".video-frame").isVisible()) ? ".video-frame" : "#player-bar",
                );
                const play = await boxOf(page, "#player-play");
                return Math.abs(play.x + play.width / 2 - (anchor.x + anchor.width / 2));
            })
            .toBeLessThanOrEqual(1);
        await expect
            .poll(() => page.locator("#player-bar").evaluate((bar) => bar.scrollWidth - bar.clientWidth))
            .toBeLessThanOrEqual(1);
    };
    for (const id of ["player-seek-back", "player-seek-fwd"]) {
        const button = page.locator(`#${id}`);
        await expect(button.locator(".player-seek-amount")).toHaveText("600");
        const label = await boxOf(page, `#${id} .player-seek-amount`);
        const icon = await boxOf(page, `#${id} svg`);
        const bounds = await boxOf(page, `#${id}`);
        expect(label.width).toBeGreaterThan(15);
        expect(label.x).toBeGreaterThanOrEqual(bounds.x);
        expect(label.x + label.width).toBeLessThanOrEqual(bounds.x + bounds.width);
        expect(Math.min(label.x + label.width, icon.x + icon.width) - Math.max(label.x, icon.x)).toBeLessThan(0);
    }
    await assertCentered();
    const info = await boxOf(page, ".player-info");
    const transport = await boxOf(page, ".player-transport");
    const actions = await boxOf(page, "#player-bar-secondary");
    expect(info.x + info.width).toBeLessThan(transport.x);
    expect(transport.x + transport.width).toBeLessThan(actions.x);
    await expect(page.locator(".player-info #player-mute")).toBeVisible();
    await expect(page.locator(".player-info #player-loop")).toBeVisible();
    await expect(page.locator("#gps-sync-pill-mobile")).toBeHidden();
    const mute = await boxOf(page, "#player-mute");
    const current = await boxOf(page, "#player-current");
    const speed = await boxOf(page, "#player-speed");
    const loop = await boxOf(page, "#player-loop");
    expect(mute.x + mute.width).toBeLessThan(current.x);
    expect(current.x + current.width).toBeLessThan(speed.x);
    expect(speed.x + speed.width).toBeLessThan(loop.x);
    await expect(page.locator("#player-bar-secondary > .player-spacer:first-child")).toHaveCount(1);
    await expect(page.locator("#player-speed")).toBeVisible();
    await expect(page.locator("#player-view-menu")).toBeVisible();
    await expect(page.locator("#player-export")).toBeVisible();
    await shot(page, "player-transport-centered-desktop");

    await page.locator("#mini-map").click();
    await expect(page.locator("#player-wrap")).toHaveClass(/map-expanded/);
    await expect(page.locator("body")).not.toHaveClass(/map-morphing/);
    await assertCentered();
    await shot(page, "player-transport-centered-map");
    await page.keyboard.press("f");
    await expect(page.locator("#player-wrap")).toHaveClass(/player-expanded/);
    await assertCentered();
    await shot(page, "player-transport-centered-fullscreen-map");
    await page.keyboard.press("f");
    await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded/);
    await page.locator("#map-collapse").click();

    await page.setViewportSize({ width: 1000, height: 900 });
    await assertCentered();
    const narrowTransport = await boxOf(page, ".player-transport");
    const narrowActions = await boxOf(page, "#player-bar-secondary");
    expect(narrowTransport.y + narrowTransport.height / 2).toBeCloseTo(narrowActions.y + narrowActions.height / 2, 0);
    const narrowInfo = await boxOf(page, ".player-info");
    expect(narrowInfo.x + narrowInfo.width).toBeLessThan(narrowTransport.x);
    expect(narrowTransport.x + narrowTransport.width).toBeLessThan(narrowActions.x);
    await shot(page, "player-transport-centered-narrow");
});

// Controls fold in this order; one entry holds controls of equal priority.
const BAR_DROP_ORDER = [
    ["#player-help", "#player-marker-list"],
    ["#player-capture-wrap", "#player-add-marker"],
    ["#player-total"],
    ["#player-loop"],
    [".player-mute-wrap"],
    ["#player-fullscreen"],
    ["#player-map"],
    ["#gps-sync-pill-mobile"],
    ["#player-export"],
];

test("the player bar folds controls only when the whole bar is full, in one priority order", async ({ page }) => {
    test.setTimeout(120_000);
    // Wide seek labels make the transport wide enough for the sweep to reach
    // widths where controls have to fold.
    await page.addInitScript(() => localStorage.setItem("everydashcam:hotkeys:seekStepSec", "600"));
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    // With the map beside the video the bar spans both, and the transport
    // under the video leaves the left group the narrower side.
    await page.locator("#mini-map").click();
    await expect(page.locator("#player-wrap")).toHaveClass(/map-expanded/);
    await expect(page.locator("body")).not.toHaveClass(/map-morphing/);
    let sawFolding = false;
    let sawShift = false;
    // Desktop widths, where the transport shares the row and slides, then
    // phone widths, where it has a row of its own and controls fold.
    for (let width = 1440; width >= 320; width -= 20) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const bar = await page.evaluate((order) => {
            const visibleChildren = (group: Element) =>
                [...group.children].filter((child) => {
                    const box = child.getBoundingClientRect();
                    return !child.classList.contains("player-spacer") && (box.width > 0 || box.height > 0);
                });
            const info = document.querySelector(".player-info")!;
            const secondary = document.querySelector("#player-bar-secondary")!;
            const transport = document.querySelector(".player-transport")!.getBoundingClientRect();
            const play = document.querySelector("#player-play")!.getBoundingClientRect();
            const video = document.querySelector(".video-frame")!.getBoundingClientRect();
            const gap = Number.parseFloat(getComputedStyle(document.querySelector(".player-bar-layout")!).columnGap);
            const infoEnd = Math.max(...visibleChildren(info).map((child) => child.getBoundingClientRect().right));
            const secondaryStart = Math.min(
                ...visibleChildren(secondary).map((child) => child.getBoundingClientRect().left),
            );
            const spacer = secondary.querySelector(".player-spacer")!.getBoundingClientRect().width;
            const stacked =
                document.querySelector<HTMLElement>(".player-bar-layout")!.dataset.transportStacked === "true";
            return {
                folded: order.map((rank) =>
                    rank.map((selector) => {
                        const el = document.querySelector<HTMLElement>(selector);
                        if (!el || el.hidden) return "unavailable";
                        if (el.dataset.overflowHidden === "true") return "folded";
                        // Hidden by the layout itself (phone-only or desktop-only).
                        return getComputedStyle(el).display === "none" ? "unavailable" : "shown";
                    }),
                ),
                isStacked: stacked,
                menuEntries: document.querySelectorAll("#player-overflow-menu > li").length,
                // Room the bar has beyond what its groups need; a stacked
                // transport has a row of its own.
                freeRoom: spacer + (stacked ? 0 : transport.left - gap - infoEnd),
                gap,
                infoGap: transport.left - infoEnd,
                secondaryGap: secondaryStart - transport.right,
                offCenter: play.left + play.width / 2 - (video.left + video.width / 2),
            };
        }, BAR_DROP_ORDER);
        const label = `${width} px`;
        const lastFolded = bar.folded.map((rank) => rank.includes("folded")).lastIndexOf(true);
        for (let rank = 0; rank < lastFolded; rank++) {
            expect(
                bar.folded[rank],
                `${label}: ${BAR_DROP_ORDER[lastFolded]} folded before ${BAR_DROP_ORDER[rank]}`,
            ).not.toContain("shown");
        }
        if (lastFolded >= 0) {
            sawFolding = true;
            expect(bar.freeRoom, `${label}: a control folded while the bar had room`).toBeLessThan(60);
        }
        expect(bar.menuEntries, `${label}: a menu for one entry`).not.toBe(1);
        if (bar.isStacked) continue;
        expect(bar.infoGap, `${label}: the info group runs into the transport`).toBeGreaterThanOrEqual(bar.gap - 0.5);
        expect(bar.secondaryGap, `${label}: the transport runs into the actions`).toBeGreaterThanOrEqual(bar.gap - 0.5);
        if (Math.abs(bar.offCenter) > 1) {
            sawShift = true;
            // Off the video's center only as far as a side group pushes it.
            const pushedBy = bar.offCenter > 0 ? bar.infoGap : bar.secondaryGap;
            expect(pushedBy, `${label}: the transport left the video's center without being pushed`).toBeLessThan(
                bar.gap + 1,
            );
        }
    }
    expect(sawShift, "the sweep reaches widths where the transport slides").toBe(true);
    expect(sawFolding, "the sweep reaches widths where controls fold").toBe(true);
});

test("transport buttons match arrow seeks, repeat while held, and stop after leaving", async ({ page }) => {
    await page.clock.install();
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    const back = page.locator("#player-seek-back");
    const forward = page.locator("#player-seek-fwd");
    await expect(forward).toHaveAttribute("title", /5.*→.*hold/i);
    await expect(page.locator("#player-step-back")).toHaveAttribute("title", /hold/i);
    await expect(page.locator("#player-play")).toHaveAttribute("title", /Space/);
    expect(
        await page.locator(".player-transport button").evaluateAll((buttons) => buttons.map((button) => button.id)),
    ).toEqual(["player-seek-back", "player-step-back", "player-play", "player-step-fwd", "player-seek-fwd"]);

    // The short fixture needs a smaller configured step to measure repeated seeks.
    await page.locator("#settings-btn").click();
    await page.locator("#settings-seek-step-input").fill("0.5");
    await page.locator("#settings-seek-step-input").press("Tab");
    await page.locator("#settings-modal-close").click();
    await expect(forward).toHaveAttribute("title", /0.5.*→/);
    await expect(forward.locator(".player-seek-amount")).toHaveText("0.5");
    await page.locator("#player-mini-progress").focus();
    await page.keyboard.press("Home");
    await expect.poll(() => masterVideoTime(page)).toBeLessThan(0.1);
    await pausePlayback(page);

    await forward.click();
    await expect.poll(() => masterVideoTime(page)).toBeCloseTo(0.5, 1);
    await back.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => masterVideoTime(page)).toBeCloseTo(1, 1);
    await page.keyboard.press("Enter");
    await expect.poll(() => masterVideoTime(page)).toBeCloseTo(0.5, 1);

    await forward.hover();
    await page.mouse.down();
    await expect.poll(() => masterVideoTime(page)).toBeCloseTo(1, 1);
    await page.clock.fastForward(1_100);
    await expect.poll(() => masterVideoTime(page)).toBeCloseTo(1.5, 1);
    await page.mouse.up();
    await page.clock.fastForward(1_100);
    expect(await masterVideoTime(page)).toBeCloseTo(1.5, 1);

    await back.hover();
    await page.mouse.down();
    await expect.poll(() => masterVideoTime(page)).toBeCloseTo(1, 1);
    await page.mouse.move(0, 0);
    await page.clock.fastForward(1_100);
    await page.mouse.up();
    expect(await masterVideoTime(page)).toBeCloseTo(1, 1);
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "true");
});

test("Space toggles playback after toolbar clicks without reactivating the focused action", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("everydashcam:hotkeys:seekStepSec", "0.5"));
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    const play = page.locator("#player-play");

    for (const id of ["player-seek-fwd", "player-step-fwd", "player-mute", "player-loop"]) {
        await page.locator("#player-mini-progress").focus();
        await page.keyboard.press("Home");
        await expect.poll(() => masterVideoTime(page)).toBeLessThan(0.1);
        const button = page.locator(`#${id}`);
        await button.evaluate((element) => {
            element.dataset.clickCount = "0";
            element.addEventListener("click", () => {
                element.dataset.clickCount = String(Number(element.dataset.clickCount) + 1);
            });
        });
        await button.click();
        await expect(button).toBeFocused();
        await expect(button).toHaveAttribute("data-click-count", "1");

        await page.keyboard.down("Space");
        await expect(play).toHaveAttribute("data-paused", "false");
        await page.keyboard.down("Space");
        await expect(play).toHaveAttribute("data-paused", "false");
        await page.keyboard.up("Space");
        await expect(play).toHaveAttribute("data-paused", "false");
        await page.keyboard.press("Space");
        await expect(play).toHaveAttribute("data-paused", "true");
        await expect(button).toHaveAttribute("data-click-count", "1");
        await expect(button).toBeFocused();

        await page.keyboard.press("Enter");
        await expect(button).toHaveAttribute("data-click-count", "2");
        await expect(play).toHaveAttribute("data-paused", "true");
    }

    const exportButton = page.locator("#player-export");
    const exportPanel = page.locator("#export-panel");
    await exportButton.click();
    await expect(exportPanel).toBeVisible();
    await page.locator("#export-panel-close").click();
    await expect(exportPanel).toBeHidden();
    await expect(exportButton).toBeFocused();
    await page.keyboard.press("Space");
    await expect(play).toHaveAttribute("data-paused", "false");
    await expect(exportPanel).toBeHidden();
    await page.keyboard.press("Space");
    await expect(play).toHaveAttribute("data-paused", "true");
    await page.keyboard.press("Enter");
    await expect(exportPanel).toBeVisible();
});

test("playback speed supports keyboard selection and returns focus", async ({ page }) => {
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    const speed = page.locator("#player-speed");
    await speed.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('#player-speed-menu [data-rate="1"]')).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator('#player-speed-menu [data-rate="1.25"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(speed).toHaveText("1.25x");
    await expect(speed).toBeFocused();
    await expect(page.locator('#player-speed-menu [data-rate="1.25"]')).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowUp");
    await expect(page.locator('#player-speed-menu [data-rate="8"]')).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#player-speed-menu")).toBeHidden();
    await expect(speed).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.locator('#player-speed-menu [data-rate="1.25"]')).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    await expect(speed).toHaveText("1.5x");
    await expect(page.locator("#player-speed-menu")).toBeHidden();
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "true");
});

test("map menu arrow navigation leaves playback position unchanged", async ({ page }) => {
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await page.locator("#player-view-menu").focus();
    await page.keyboard.press("Space");
    await page.locator('[data-map-mode="mini"]').focus();
    const before = await masterVideoTime(page);
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator('[data-map-mode="off"]')).toBeFocused();
    expect(await masterVideoTime(page)).toBeCloseTo(before, 2);
    await page.keyboard.press("Space");
    await expect(page.locator('[data-map-mode="off"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator("#player-view-menu")).toBeFocused();
});

test("portrait view menu stays inside the viewer at narrow phone widths", async ({ page }) => {
    await page.setViewportSize({ ...MOBILE, width: 320 });
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await page.locator("#player-view-menu").click();
    const menu = page.locator("#player-view-menu-popover");
    await expect(menu).toBeVisible();
    await expect.poll(async () => (await boxOf(page, "#player-view-menu-popover")).x).toBeGreaterThanOrEqual(0);
    const bounds = await boxOf(page, "#player-view-menu-popover");
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    const row = await boxOf(page, '.view-menu-row[data-panel="chart"]');
    expect(row.x).toBeGreaterThanOrEqual(0);
    await page.locator('.view-menu-row[data-panel="chart"]').click();
    await expect(page.locator("#player-chart-canvas")).toBeHidden();
});

test("narrow desktop export keeps speed and GPS synchronization inside the readout", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await gotoApp(page, "ru");
    await loadTrip(page, SAMPLE_70MAI);
    await openExport(page);
    const readout = page.locator("#player-readout");
    await expect(readout).toBeVisible();
    await expect(page.locator("#pm-speed-toggle")).toBeVisible();
    await expect(page.locator("#pm-coords")).toBeHidden();
    await expect(page.locator("#pm-time")).toBeHidden();
    expect(await readout.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    const row = await boxOf(page, "#player-readout");
    const sync = await boxOf(page, "#gps-sync-pill");
    expect(sync.x).toBeGreaterThanOrEqual(row.x);
    expect(sync.x + sync.width).toBeLessThanOrEqual(row.x + row.width);
    expect(sync.width).toBeGreaterThan(36);
    await page.locator("#gps-sync-pill").click();
    await expect(page.locator("#gps-sync-modal")).toBeVisible();
});

test.describe("touch player toolbar", () => {
    test.use({ hasTouch: true, isMobile: true, locale: "ru-RU" });

    test("tablet controls keep touch targets in the desktop layout", async ({ page }) => {
        await page.setViewportSize({ width: 1024, height: 768 });
        await gotoApp(page);
        await loadTrip(page, SAMPLE_70MAI);
        await pausePlayback(page);

        for (const selector of [".player-transport button", "#player-speed", "#player-view-menu", "#player-export"]) {
            for (const control of await page.locator(selector).all()) {
                await expect(control).toBeVisible();
                const bounds = await control.boundingBox();
                expect(bounds).not.toBeNull();
                expect(bounds!.width).toBeGreaterThanOrEqual(40);
                expect(bounds!.height).toBeGreaterThanOrEqual(40);
            }
        }
        for (const control of await page.locator(".player-transport button").all()) {
            const bounds = await control.boundingBox();
            expect(bounds!.width, "transport has the full touch target").toBeGreaterThanOrEqual(44);
            expect(bounds!.height, "transport controls share a height").toBe(44);
        }
        await expect
            .poll(() => page.locator("#player-bar").evaluate((bar) => bar.scrollWidth - bar.clientWidth))
            .toBeLessThanOrEqual(1);

        await page.locator("#player-speed").tap();
        for (const row of await page.locator("#player-speed-menu li").all()) {
            expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
        await page.locator('#player-speed-menu [data-rate="1.25"]').tap();
        await expect(page.locator("#player-speed")).toHaveText("1.25x");
        await expect(page.locator("#player-speed-menu")).toBeHidden();

        await page.locator("#player-view-menu").tap();
        for (const row of await page.locator(".view-menu-row:visible, .view-menu-map__modes button:visible").all()) {
            expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
        await page.locator('[data-map-mode="off"]').tap();
        await expect(page.locator('[data-map-mode="off"]')).toHaveAttribute("aria-checked", "true");
        await shot(page, "player-touch-tablet-view-menu");
    });

    test("a narrow phone keeps fullscreen and export reachable", async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 568 });
        await page.addInitScript(() => localStorage.setItem("everydashcam:hotkeys:seekStepSec", "600"));
        await gotoApp(page, "ru");
        await loadTrip(page, SAMPLE_70MAI);
        await expect
            .poll(() => page.locator("#player-bar").evaluate((element) => element.scrollWidth - element.clientWidth))
            .toBeLessThanOrEqual(1);
        let previousRight = 0;
        for (const id of [
            "player-seek-back",
            "player-step-back",
            "player-play",
            "player-step-fwd",
            "player-seek-fwd",
        ]) {
            const control = page.locator(`#${id}`);
            await expect(control).toBeVisible();
            const bounds = await boxOf(page, `#${id}`);
            expect(bounds.width).toBeGreaterThanOrEqual(40);
            expect(bounds.x).toBeGreaterThanOrEqual(previousRight);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
            previousRight = bounds.x + bounds.width;
        }
        await expect(page.locator("#player-bar-secondary #player-mute")).toHaveCount(1);
        await expect(page.locator("#player-bar-secondary #player-loop")).toHaveCount(1);
        const play = await boxOf(page, "#player-play");
        expect(play.x + play.width / 2).toBeCloseTo(160, 0);
        await shot(page, "player-transport-centered-phone");
        const overflow = await boxOf(page, "#player-overflow");
        expect(overflow.x).toBeGreaterThanOrEqual(0);
        expect(overflow.x + overflow.width).toBeLessThanOrEqual(320);
        await expect(page.locator("#player-fullscreen")).toBeHidden();
        await expect(page.locator(".player-fullscreen-actions")).toBeHidden();
        await page.locator("#player-overflow").tap();
        await expect(page.locator("#player-overflow-menu")).toBeVisible();
        await expect
            .poll(async () => {
                const menuBounds = await boxOf(page, "#player-overflow-menu");
                const barBounds = await boxOf(page, "#player-bar");
                return menuBounds.y + menuBounds.height - barBounds.y;
            })
            .toBeLessThan(0);
        expect((await boxOf(page, "#player-overflow-menu")).y).toBeGreaterThanOrEqual(0);
        await shot(page, "player-overflow-above-phone-controls");
        await expect(
            page.locator("#player-overflow-menu").getByRole("button", { name: "На весь экран", exact: true }),
        ).toBeVisible();
        await expect(page.locator("#player-overflow-menu .overflow-menu-btn", { hasText: /карту/i })).toBeVisible();
        await page.locator("#player-overflow").tap();
        await expect(page.locator("#player-export")).toBeVisible();
        await page.locator("#player-export").tap();
        await expect(page.locator("#export-panel")).toBeVisible();
        await page.locator("#export-panel-close").tap();
        await page.setViewportSize({ width: 767, height: 1024 });
        await expect(page.locator("#player-map")).toBeVisible();
        await expect(page.locator("#player-map")).toHaveAttribute("data-overflow-hidden", "false");
        await page.setViewportSize(DESKTOP);
        await expect(page.locator(".player-info #player-mute")).toBeVisible();
        await expect(page.locator(".player-info #player-loop")).toBeVisible();
        await expect(page.locator("#gps-sync-pill-mobile")).toBeHidden();
    });

    test("page zoom preserves the map and export controls when the toolbar has room", async ({ page, context }) => {
        await page.setViewportSize({ width: 767, height: 1024 });
        await gotoApp(page, "ru");
        await loadTrip(page, SAMPLE_70MAI);
        await expect(page.locator("#player-map")).toBeVisible();
        await expect(page.locator("#player-export")).toBeVisible();

        const session = await context.newCDPSession(page);
        await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
        // A real layout resize forces overflow to measure while page zoom is
        // active; the visual viewport is now narrower than the flex toolbar.
        await page.setViewportSize({ width: 766, height: 1024 });

        await expect.poll(() => page.evaluate(() => window.visualViewport?.scale)).toBeCloseTo(2);
        await expect(page.locator("#player-map")).toHaveAttribute("data-overflow-hidden", "false");
        await expect(page.locator("#player-export")).toHaveAttribute("data-overflow-hidden", "false");
        await expect(page.locator("#player-map")).toBeVisible();
        await expect(page.locator("#player-export")).toBeVisible();
        await session.detach();
    });
});

test("expanded map narrows a hand-widened sidebar instead of hiding the video", async ({ page }) => {
    const viewportWidth = 1200;
    await page.setViewportSize({ width: viewportWidth, height: 900 });
    await page.addInitScript(() => localStorage.setItem("everydashcam:sidebar-width", "600"));
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    expect((await boxOf(page, "#sidebar")).width).toBeCloseTo(600, 0);
    await page.locator("#mini-map").click();
    await expect(page.locator("#player-wrap")).toHaveClass(/map-expanded/);
    await expect(page.locator("body")).not.toHaveClass(/map-morphing/);
    // The list gives up only what keeps the player at desktop width, so the
    // pwrap takeover never swallows the video (sidebar.css).
    const capped = viewportWidth - 772;
    await expect.poll(async () => (await boxOf(page, "#sidebar")).width).toBeCloseTo(capped, 0);
    expect((await boxOf(page, ".viewer")).width).toBeGreaterThanOrEqual(767.5);
    await expect(page.locator(".video-frame")).toBeVisible();
    await expect(page.locator(".map-wrap")).toBeVisible();

    // The handle reports and stops at the visible edge, and growing there does
    // not overwrite the saved width - the map's cap is temporary.
    const handle = page.locator("#sidebar-resize");
    await expect(handle).toHaveAttribute("aria-valuemax", String(capped));
    await handle.press("ArrowRight");
    await handle.press("End");
    expect(await page.evaluate(() => localStorage.getItem("everydashcam:sidebar-width"))).toBe("600");
    expect((await boxOf(page, "#sidebar")).width).toBeCloseTo(capped, 0);

    // The docked GPS sync panel takes exactly the narrowed column, not the
    // saved width over the video.
    await page.locator("#map-settings-toggle").click();
    await page.locator("#map-gps-sync-btn").click();
    const panel = page.locator("#gps-sync-modal");
    await expect(panel).toHaveClass(/is-modeless/);
    expect((await boxOf(page, "#gps-sync-modal")).width).toBeCloseTo(capped, 0);
    await page.locator("#gps-sync-close").click();
    await expect(panel).toBeHidden();

    await page.locator("#map-collapse").click();
    await expect.poll(async () => (await boxOf(page, "#sidebar")).width, "dragged width returns").toBeCloseTo(600, 0);
});

test("fullscreen controls remain available while hovered or keyboard focused", async ({ page }) => {
    await page.clock.install();
    await gotoApp(page);
    await loadTrip(page, SAMPLE_70MAI);
    await page.keyboard.press("r");
    await expect(page.locator("#player-loop")).toHaveAttribute("aria-label", "Loop on");
    const play = page.locator("#player-play");
    // Trip autoplay settles after the chart appears; a toggle can race it.
    await expect(play).toHaveAttribute("data-paused", "false");
    await page.locator("#player-fullscreen").click();
    const player = page.locator("#player-wrap");
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await page.locator("#player-speed").hover();
    // The idle deadline itself is under test: controls must survive beyond it.
    await page.clock.fastForward(3300);
    await expect(player).toHaveClass(/controls-visible/);
    await page.mouse.move(10, 10);
    await page.clock.fastForward(3300);
    await expect(player).not.toHaveClass(/controls-visible/);
    await page.keyboard.press("Tab");
    await expect(player).toHaveClass(/controls-visible/);
    await page.clock.fastForward(3300);
    await expect(player).toHaveClass(/controls-visible/);
    await expect(play).toHaveAttribute("data-paused", "false");
    await page.locator("#player-fullscreen-exit").click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
});

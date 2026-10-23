import type { Page } from "@playwright/test";

import {
    DESKTOP,
    MOBILE,
    SAMPLE_70MAI,
    boxOf,
    expect,
    gotoApp,
    loadTrip,
    mockDirectoryPicker,
    openExport,
    persistentTest as test,
    presetLocalStorage,
} from "./_fixtures.js";

async function waitForMetadata(page: Page): Promise<void> {
    await expect
        .poll(() =>
            page.evaluate(() => {
                const state = window.__everydashcam.state;
                return (
                    state.ingestController === null &&
                    state.recordingAnalysisProgress === null &&
                    state.inflightEmbeddedGps.size === 0 &&
                    state.pendingHeavyEmbeddedGps.size === 0 &&
                    state.trips.every((trip) =>
                        trip.frames.every((frame) =>
                            Object.values(frame.channels).every((file) => file?.metadataReady === true),
                        ),
                    )
                );
            }),
        )
        .toBe(true);
}

test("sidebar keyboard resizing follows the visible edge and reports its size", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await loadTrip(page);

    const handle = page.locator("#sidebar-resize");
    const before = await boxOf(page, "#sidebar");
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    const after = await boxOf(page, "#sidebar");
    expect(after.width - before.width).toBeCloseTo(16, 0);
    await expect(handle).toHaveAttribute("aria-valuenow", String(Math.round(after.width)));

    await page.keyboard.press("End");
    await page.setViewportSize({ width: 800, height: 900 });
    const capped = await boxOf(page, "#sidebar");
    await page.keyboard.press("ArrowLeft");
    const reduced = await boxOf(page, "#sidebar");
    expect(capped.width - reduced.width, "a capped sidebar responds to the first key press").toBeCloseTo(16, 0);
    await expect(handle).toHaveAttribute("aria-valuenow", String(Math.round(reduced.width)));
});

test("export removes the desktop trip list from keyboard navigation and restores it on close", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await loadTrip(page);
    const sidebar = page.locator("#sidebar");
    await expect(sidebar).not.toHaveAttribute("inert", "");
    await openExport(page);
    await expect(sidebar).toHaveAttribute("inert", "");
    await page.locator("#export-panel-close").click();
    await expect(sidebar).not.toHaveAttribute("inert", "");
});

test.describe("trip navigation with touch", () => {
    test.use({ hasTouch: true });

    test("localized sorting and the folder menu fit a narrow sidebar", async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize({ width: 1024, height: 768 });
        await mockDirectoryPicker(page, [{ label: "MOCKCARD", dir: SAMPLE_70MAI }]);
        await gotoApp(page, "ru");
        await page.locator("#landing-cta").click();
        await expect(page.locator("li.trip").first()).toBeVisible({ timeout: 30_000 });
        await page.locator("#sidebar-resize").focus();
        await page.keyboard.press("Home");
        await page.locator("#trip-sort-key").selectOption("duration");

        const sidebar = await boxOf(page, "#sidebar");
        for (const selector of [".sidebar-header h2", "#trip-sort-key", "#trip-sort-dir", "#sidebar-collapse"]) {
            const control = await boxOf(page, selector);
            expect(control.x, selector).toBeGreaterThanOrEqual(sidebar.x);
            expect(control.x + control.width, selector).toBeLessThanOrEqual(sidebar.x + sidebar.width);
        }
        const row = page.locator("#folder-sources .folder-source");
        await row.locator(".folder-source__remember").click();
        await expect(row.locator(".folder-source__state")).toBeVisible();
        expect(
            await row.locator(".folder-source__label").evaluate((label) => label.scrollWidth <= label.clientWidth),
            "the folder name remains readable next to its saved state",
        ).toBe(true);
        await row.locator(".folder-source__menu").click();
        const menu = await boxOf(page, ".folder-source__popup");
        expect(menu.x, "the folder menu is not clipped by the scroll container").toBeGreaterThanOrEqual(sidebar.x);
        expect(menu.x + menu.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
        await expect(row.locator(".folder-source__popup button")).toBeInViewport();
    });

    test("Escape dismisses the folder menu before the trip drawer", async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(MOBILE);
        await mockDirectoryPicker(page, [{ label: "MOCKCARD", dir: SAMPLE_70MAI }]);
        await gotoApp(page);
        await page.locator("#landing-cta").click();
        const trip = page.locator("li.trip").first();
        await expect(trip).toBeVisible({ timeout: 30_000 });
        await trip.locator(".trip-title").click();
        await expect(page.locator("body")).not.toHaveClass(/browsing/);
        await expect(page.locator("#sidebar")).toHaveCount(1);
        await page.locator("#topbar-burger").click();
        const sidebar = page.locator("#sidebar");
        await expect(sidebar).toHaveAttribute("data-drawer-open", "true");
        const row = page.locator("#folder-sources .folder-source");
        await row.locator(".folder-source__remember").click();
        await expect(row.locator(".folder-source__state")).toBeVisible();
        const toggle = row.locator(".folder-source__menu");
        await toggle.click();
        await expect(row.locator(".folder-source__popup")).toBeVisible();
        await toggle.press("Escape");
        await expect(row.locator(".folder-source__popup")).toBeHidden();
        await expect(sidebar).toHaveAttribute("data-drawer-open", "true");
        await expect(toggle).toBeFocused();
        await page.locator("#topbar-burger").click();
        await expect(sidebar).not.toHaveAttribute("data-drawer-open", "true");
        await expect(page.locator("#drawer-scrim")).toBeHidden();
    });
});

for (const { name, viewport, narrowSidebar } of [
    { name: "320px phone", viewport: { width: 320, height: 700 }, narrowSidebar: false },
    { name: "390px phone", viewport: MOBILE, narrowSidebar: false },
    { name: "tablet", viewport: { width: 1024, height: 768 }, narrowSidebar: true },
]) {
    test.describe(`trip card actions on ${name}`, () => {
        test.use({ viewport, hasTouch: true, reducedMotion: "reduce", viewerMap: "route-only" });

        test.beforeEach(async ({ page }) => {
            await presetLocalStorage(page);
            await gotoApp(page);
            await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
            await expect(page.locator("li.trip").first()).toBeVisible({ timeout: 30_000 });
            await waitForMetadata(page);
            await expect(page.locator("#ingest-overlay")).toBeHidden();
            await expect(page.locator("#trip-analysis-status")).toBeHidden();
            if (narrowSidebar) {
                await page.locator("#sidebar-resize").focus();
                await page.keyboard.press("Home");
            }
        });

        test("expanding keeps the chevron and event touch targets stationary", async ({ page }) => {
            // Public samples have no impacts. Use the same event UI seam as the
            // trip-events suite while keeping the public recordings unchanged.
            await page.evaluate(() => {
                const trip = window.__everydashcam.state.trips[0]!;
                trip.events = [1, 2, 3].map((relSec) => ({
                    kind: "brake",
                    unixSeconds: trip.startUtc + relSec,
                    relSec,
                    severity: 0.42,
                    recordIndex: 0,
                }));
            });
            await page.locator("#trip-sort-key").selectOption("duration");
            const card = page.locator("li.trip").first();
            await card.scrollIntoViewIfNeeded();
            const chevron = card.locator(".trip-chevron");
            const points = await chevron.evaluate((element) => {
                const box = element.getBoundingClientRect();
                return [
                    { x: box.x + box.width / 2, y: box.bottom + 10 },
                    { x: box.x - 9, y: box.y + box.height / 2 },
                ];
            });
            const owners = () =>
                page.evaluate(
                    (points) =>
                        points.map(
                            ({ x, y }) =>
                                document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-action]")?.dataset.action,
                        ),
                    points,
                );
            expect(await owners(), "collapsed corner targets are distinct").toEqual(["chevron", "trip-events"]);
            await chevron.click();
            await expect(card).toHaveClass(/expanded/);
            expect(await owners(), "expansion rotates only the glyph").toEqual(["chevron", "trip-events"]);

            await page.touchscreen.tap(points[0]!.x, points[0]!.y);
            await expect(card).not.toHaveClass(/expanded/);
            expect(await page.evaluate(() => window.__everydashcam.state.active)).toBeNull();
            await expect(page.locator("body")).toHaveClass(/browsing/);
        });

        test("the details touch target leaves a long filename readable and opens no footage", async ({ page }) => {
            const card = page.locator("li.trip").first();
            await card.locator(".trip-chevron").click();
            const row = card.locator(".trip-files > li").first();
            const info = row.locator(".file-details-toggle");
            await info.scrollIntoViewIfNeeded();
            const layout = await row.evaluate((element) => {
                const name = element.querySelector<HTMLElement>(".file-name")!;
                const info = element.querySelector<HTMLElement>(".file-details-toggle")!;
                const nameBox = name.getBoundingClientRect();
                const infoBox = info.getBoundingClientRect();
                const x = infoBox.x + infoBox.width / 2;
                const y = infoBox.y + infoBox.height / 2;
                return {
                    nameRight: nameBox.right,
                    infoLeft: infoBox.left,
                    nameHeight: nameBox.height,
                    nameLineHeight: Number.parseFloat(getComputedStyle(name).lineHeight),
                    overflows: element.scrollWidth > element.clientWidth,
                    point: { x: x - 18, y },
                    owners: [
                        [x - 18, y],
                        [x + 18, y],
                        [x, y - 18],
                        [x, y + 18],
                    ].map(
                        ([x, y]) =>
                            document.elementFromPoint(x!, y!)?.closest<HTMLElement>("[data-action]")?.dataset.action,
                    ),
                };
            });
            expect(layout.nameRight, "filename clears the full info target").toBeLessThanOrEqual(layout.infoLeft);
            expect(layout.overflows, "expanded file row fits the sidebar").toBe(false);
            if (narrowSidebar) {
                expect(layout.nameHeight, "long filename wraps inside the narrow sidebar").toBeGreaterThan(
                    layout.nameLineHeight,
                );
            }
            expect(layout.owners, "finger-sized reach opens details instead of the playable row").toEqual([
                "file-details",
                "file-details",
                "file-details",
                "file-details",
            ]);
            await page.touchscreen.tap(layout.point.x, layout.point.y);
            await expect(info).toHaveAttribute("aria-expanded", "true");
            const details = row.locator(".file-details");
            await expect(details).toBeVisible();
            const openLayout = await row.evaluate((element) => {
                const panel = element.querySelector<HTMLElement>(".file-details")!;
                const toggle = element.querySelector<HTMLElement>(".file-details-toggle")!;
                const rowBox = element.getBoundingClientRect();
                const panelBox = panel.getBoundingClientRect();
                const style = getComputedStyle(element);
                return {
                    panelRight: panelBox.right,
                    contentRight:
                        rowBox.right -
                        Number.parseFloat(style.borderRightWidth) -
                        Number.parseFloat(style.paddingRight),
                    panelTop: panelBox.top,
                    toggleBottom: toggle.getBoundingClientRect().bottom,
                    overflows: panel.scrollWidth > panel.clientWidth,
                };
            });
            expect(openLayout.panelRight, "details use the width below the info button").toBeCloseTo(
                openLayout.contentRight,
                0,
            );
            expect(openLayout.panelTop, "the open panel clears the entire info target").toBeGreaterThanOrEqual(
                openLayout.toggleBottom,
            );
            expect(openLayout.overflows, "technical details fit the open panel").toBe(false);
            expect(await page.evaluate(() => window.__everydashcam.state.active)).toBeNull();
            await info.focus();
            await page.keyboard.press("Enter");
            await expect(info).toHaveAttribute("aria-expanded", "false");
            await expect(info).toBeFocused();
        });
    });
}

test.describe("reduced motion trip feedback", () => {
    test.use({
        viewport: { width: 1024, height: 768 },
        hasTouch: true,
        reducedMotion: "reduce",
        viewerMap: "route-only",
    });

    test("a pending trip has readable feedback without motion", async ({ page }) => {
        let releaseViewer = (): void => {};
        const viewerGate = new Promise<void>((resolve) => {
            releaseViewer = resolve;
        });
        await page.route("**/assets/maplibre-gl-*.js", async (route) => {
            await viewerGate;
            await route.continue();
        });
        try {
            await presetLocalStorage(page);
            await gotoApp(page);
            await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
            const card = page.locator("li.trip").first();
            await expect(card).toBeVisible({ timeout: 30_000 });
            await expect(page.locator("#landing-cta")).toHaveCount(0);
            await waitForMetadata(page);
            await expect(page.locator("#ingest-overlay")).toBeHidden();
            await page.locator("#sidebar-resize").focus();
            await page.keyboard.press("Home");
            await card.locator(".trip-title").click();
            await expect(card).toHaveAttribute("aria-busy", "true");
            const status = card.getByRole("status");
            await expect(status).toHaveText("Preparing this trip");
            await expect(status.locator(".trip-opening-label")).toBeVisible();
            await expect
                .poll(() => status.evaluate((element) => getComputedStyle(element, "::after").animationName))
                .toBe("none");
            expect(await status.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
        } finally {
            releaseViewer();
        }
        await expect(page.locator("#player-wrap")).toBeVisible();
        await expect(page.locator(".trip-opening-spinner")).toHaveCount(0);
    });
});

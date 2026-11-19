import {
    DESKTOP,
    MOBILE,
    boxOf,
    expect,
    gotoApp,
    loadTrip,
    pausePlayback,
    presetLocalStorage,
    shot,
    test,
} from "./_fixtures.js";

test.use({ serviceWorkers: "block" });

test("shows GPS dropouts and trip flags on both maps through seeking and style changes", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await loadTrip(page);
    await pausePlayback(page);
    await expect(page.locator("#mini-map .endpoint-marker-wrap")).toHaveCount(2);
    await page.evaluate(() => {
        const { state, dom, setMapProvider } = window.__everydashcam;
        dom.player.currentTime = 0.25;
        const trip = state.trips[state.active!.trip]!;
        const startUtc = trip.frames[state.active!.frame]!.startUtc;
        const source = trip.records.find((record) => record.active)!;
        trip.records = [
            { ...source, unixSeconds: startUtc - 7, active: false, lat: 0, lon: 0 },
            { ...source, unixSeconds: startUtc - 5.5, lat: 50, lon: 20 },
            { ...source, unixSeconds: startUtc + 6, lat: 50, lon: 20.01 },
            { ...source, unixSeconds: startUtc + 8, active: false, lat: 0, lon: 0 },
        ];
        setMapProvider("osm-raster");
    });
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.startMarker?.getLngLat().lng)).toBe(20);
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.endMarker?.getLngLat().lng)).toBe(20.01);
    for (const map of ["#map", "#mini-map"]) {
        await expect(page.locator(`${map} .endpoint-marker-wrap`)).toHaveCount(2);
        await expect(page.locator(`${map} [data-endpoint="start"]`)).toHaveAttribute("aria-label", "Trip start");
        await expect(page.locator(`${map} [data-endpoint="end"]`)).toHaveAttribute("title", "Trip end");
        await expect(page.locator(`${map} .car-marker-wrap`)).toHaveCSS("visibility", "hidden");
    }
    const miniBadge = page.locator("#mini-map .map-no-gps");
    const mapBadge = page.locator(".map-wrap > .map-no-gps");
    await expect(miniBadge).toBeVisible();
    await expect(miniBadge).toHaveAttribute("title", "No GPS coordinates at this moment");
    await expect(mapBadge).toHaveJSProperty("hidden", false);
    const mini = await boxOf(page, "#mini-map");
    const badge = await boxOf(page, "#mini-map .map-no-gps");
    expect(badge.x).toBeGreaterThan(mini.x);
    expect(badge.y).toBeGreaterThan(mini.y);
    expect(badge.x + badge.width).toBeLessThan(mini.x + mini.width);
    expect(badge.y + badge.height).toBeLessThan(mini.y + mini.height);
    await shot(page, "map-trip-markers-mini-no-gps");

    await page.evaluate(() => {
        window.__everydashcam.dom.player.currentTime = 1.5;
    });
    await expect(miniBadge).toBeHidden();
    await expect(page.locator("#mini-map .car-marker-wrap")).toHaveCSS("visibility", "visible");
    await page.locator("#mini-map").click();
    await expect(page.locator("body")).not.toHaveClass(/map-morphing/);
    await page.locator('.map-follow-seg[data-follow-mode="off"]').click();
    await page.evaluate(() => {
        window.__everydashcam.dom.player.currentTime = 0.25;
    });
    await expect(mapBadge).toBeVisible();
    await expect(page.locator("#map .car-marker-wrap")).toHaveCSS("visibility", "hidden");
    await page.locator('.theme-toggle-btn[data-theme="light"]').click();
    await expect(page.locator("html")).toHaveClass(/dc-light/);
    await expect
        .poll(() =>
            page.evaluate(() => window.__everydashcam.state.mapReady && window.__everydashcam.state.miniMapReady),
        )
        .toBe(true);
    await expect(mapBadge).toBeVisible();
    await expect(page.locator("#map .endpoint-marker-wrap")).toHaveCount(2);
    await expect(page.locator("#mini-map .endpoint-marker-wrap")).toHaveCount(2);
    const largeBadge = await boxOf(page, ".map-wrap > .map-no-gps");
    const collapse = await boxOf(page, "#map-collapse");
    expect(largeBadge.x + largeBadge.width).toBeLessThan(collapse.x);
    await shot(page, "map-trip-markers-large-no-gps");

    await page.keyboard.press("f");
    await expect(page.locator("#player-wrap")).toHaveClass(/player-expanded/);
    await expect(page.locator("#player-wrap")).not.toHaveClass(/fullscreen-entering/);
    await expect(mapBadge).toBeVisible();
    const fullscreenBadge = await boxOf(page, ".map-wrap > .map-no-gps");
    const fullscreenActions = await boxOf(page, ".player-fullscreen-actions");
    expect(fullscreenBadge.y, "GPS status clears the fullscreen exit controls").toBeGreaterThan(
        fullscreenActions.y + fullscreenActions.height,
    );
    await page.locator("#player-fullscreen-exit").click();
    await expect(page.locator("#player-wrap")).not.toHaveClass(/player-expanded/);

    await page.locator("#video-map-resize").focus();
    await page.keyboard.press("End");
    const narrowMap = await boxOf(page, ".map-wrap");
    expect(narrowMap.width, "map reaches its desktop minimum width").toBeCloseTo(220, 0);
    const narrowBadge = await boxOf(page, ".map-wrap > .map-no-gps");
    const followControls = await boxOf(page, ".map-follow-segments");
    expect(narrowBadge.x, "GPS status clears all follow modes in a narrow map").toBeGreaterThan(
        followControls.x + followControls.width,
    );
    await page.setViewportSize(MOBILE);
    const mobileBadge = await boxOf(page, ".map-wrap > .map-no-gps");
    const mobileCollapse = await boxOf(page, "#map-collapse");
    expect(mobileBadge.x + mobileBadge.width).toBeLessThan(mobileCollapse.x);

    await page.evaluate(() => {
        const { state, setMapProvider } = window.__everydashcam;
        state.trips[state.active!.trip]!.records = [];
        setMapProvider("openfreemap");
    });
    await expect(page.locator("#map .endpoint-marker-wrap")).toHaveCount(0);
    await expect(page.locator("#mini-map .endpoint-marker-wrap")).toHaveCount(0);
    await expect(mapBadge).toHaveJSProperty("hidden", true);
    await expect(miniBadge).toHaveJSProperty("hidden", true);
});

test.describe("touch map status", () => {
    test.use({ viewport: MOBILE, hasTouch: true, isMobile: true });

    test("keeps the GPS badge clear of the larger touch controls", async ({ page }) => {
        await presetLocalStorage(page);
        await gotoApp(page);
        await loadTrip(page);
        await pausePlayback(page);
        await page.locator("#mobile-view-map").click();
        await page.evaluate(() => {
            const { state, setMapProvider } = window.__everydashcam;
            const trip = state.trips[state.active!.trip]!;
            trip.records = trip.records.map((record) => ({ ...record, unixSeconds: record.unixSeconds + 3600 }));
            setMapProvider("osm-raster");
        });
        await expect(page.locator(".map-wrap > .map-no-gps")).toBeVisible();
        const badge = await boxOf(page, ".map-wrap > .map-no-gps");
        const collapse = await boxOf(page, "#map-collapse");
        const followControls = await boxOf(page, ".map-follow-segments");
        expect(collapse.width, "touch hit target is active").toBe(40);
        expect(badge.x + badge.width, "GPS status clears collapse").toBeLessThan(collapse.x);
        expect(badge.x, "GPS status clears follow modes").toBeGreaterThan(followControls.x + followControls.width);
    });
});

test("keeps coincident trip flags distinct and labels them in Russian", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page, "ru");
    await loadTrip(page);
    await pausePlayback(page);
    await page.evaluate(() => {
        const { state, setMapProvider } = window.__everydashcam;
        const trip = state.trips[state.active!.trip]!;
        const source = trip.records.find((record) => record.active)!;
        trip.records = [{ ...source, unixSeconds: trip.frames[state.active!.frame]!.startUtc, lat: 50, lon: 20 }];
        setMapProvider("osm-raster");
    });
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.startMarker?.getLngLat().lng)).toBe(20);
    for (const map of ["#map", "#mini-map"]) {
        await expect(page.locator(`${map} [data-endpoint="start"]`)).toHaveAttribute("title", "Начало поездки");
        await expect(page.locator(`${map} [data-endpoint="end"]`)).toHaveAttribute("aria-label", "Конец поездки");
    }
    const start = await boxOf(page, '#mini-map [data-endpoint="start"]');
    const end = await boxOf(page, '#mini-map [data-endpoint="end"]');
    // Each pole stands 1 unit inside the 28-unit flag artwork, scaled to the inset.
    expect(start.x + start.width - end.x, "flags share a pole while facing opposite directions").toBeCloseTo(
        (2 * start.width) / 28,
        1,
    );
    await expect(page.locator("#mini-map .map-no-gps")).toHaveAttribute(
        "aria-label",
        "Для этого момента нет GPS-координат",
    );
});

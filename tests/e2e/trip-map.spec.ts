// The map of all trips: local routes without a basemap, the place filter and
// opening a trip at its pass, the map laid over an open trip, the dots of far
// trips, "Read now", and the phone's map tab with its sheet.

import { type Page } from "@playwright/test";

import { DESKTOP, expect, gotoApp, MOBILE, presetLocalStorage, test } from "./_fixtures.js";
import { EAST_ROAD, NORTH_ROAD, removeTripLibraries, roadPoint, writeTripLibrary } from "./_trip-library.js";

test.afterAll(removeTripLibraries);

async function openLibrary(page: Page, directory: string): Promise<void> {
    await presetLocalStorage(page);
    await gotoApp(page);
    await page.locator("#folder-input").setInputFiles(directory);
    await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.recordingAnalysisProgress)).toBeNull();
}

/** Waits until the map of all trips has drawn its corridor lines. */
async function expectRoutesDrawn(page: Page): Promise<void> {
    await expect
        .poll(() =>
            page.evaluate(() => {
                const map = window.__everydashcam.state.tripMap;
                if (!map?.getLayer("trip-map-lines-core")) return 0;
                return map.queryRenderedFeatures({ layers: ["trip-map-lines-core"] }).length;
            }),
        )
        .toBeGreaterThan(0);
}

/** Page coordinates of a road point on the map of all trips. */
async function mapPoint(page: Page, eastM: number, northM: number): Promise<{ x: number; y: number }> {
    return page.evaluate(
        (lngLat) => {
            const map = window.__everydashcam.state.tripMap!;
            const point = map.project(lngLat);
            const rect = map.getCanvas().getBoundingClientRect();
            return { x: rect.left + point.x, y: rect.top + point.y };
        },
        roadPoint(eastM, northM),
    );
}

/** Centres the map on a road point at street zoom, where a click picks that road. */
async function zoomTo(page: Page, eastM: number, northM: number): Promise<void> {
    await page.evaluate(
        (center) => {
            window.__everydashcam.state.tripMap!.jumpTo({ center, zoom: 15 });
        },
        roadPoint(eastM, northM),
    );
}

test("draws every trip's route while the basemap is blocked", { tag: "@golden-map" }, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openLibrary(page, writeTripLibrary({ roads: [EAST_ROAD, EAST_ROAD, NORTH_ROAD], withoutGps: 1 }));

    await expect(page.locator("#trip-map-state")).toBeVisible();
    await expectRoutesDrawn(page);
    await expect(page.locator("#trip-map-counter-text")).toHaveText("3 of 4 on the map");
    await expect(page.locator(".empty-state")).toBeHidden();
});

test.describe("with routes only", () => {
    test.use({ viewerMap: "route-only", viewport: DESKTOP });

    test("a place filters the list and opens the trip at its pass", async ({ page }) => {
        await openLibrary(page, writeTripLibrary({ roads: [EAST_ROAD, NORTH_ROAD, EAST_ROAD], withoutGps: 1 }));
        await expectRoutesDrawn(page);
        await zoomTo(page, 1500, 0);
        const road = await mapPoint(page, 1500, 0);
        await page.mouse.click(road.x, road.y);

        await expect(page.locator("#trip-place-bar")).toBeVisible();
        await expect(page.locator("#trip-filter-result")).toContainText("Showing 2 of 4");
        await expect(page.locator("#trip-filter-untracked")).toHaveText("No GPS track, not on the map: 1");
        const rows = page.locator("li.trip:not(.unindexed-note)");
        await expect(rows).toHaveCount(2);
        await expect(rows.first()).toContainText(/pass at \d\d:\d\d/);
        // Beside the road the closest points and pass times stay the same; the circle still moves.
        const handle = page.locator(".trip-map-place-handle");
        const handleBefore = (await handle.boundingBox())!;
        await page.mouse.click(road.x, road.y - 10);
        await expect.poll(async () => handleBefore.y - (await handle.boundingBox())!.y).toBeCloseTo(10, -1);
        await expect(rows).toHaveCount(2);

        const tripIndex = Number(await rows.first().getAttribute("data-trip-index"));
        await rows.first().locator(".trip-title").click();
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.active?.trip ?? null)).toBe(tripIndex);
        await expect(page.locator(".viewer")).not.toHaveClass(/\bempty\b/);

        await page.locator("#trip-place-clear").click();
        await expect(page.locator("#trip-place-bar")).toBeHidden();
        await expect(rows).toHaveCount(4);
        await expect(page.locator("#trip-search")).toBeFocused();
    });

    test("lays the map over an open trip and gives the video back", { tag: "@webkit-ui" }, async ({ page }) => {
        await openLibrary(page, writeTripLibrary({ roads: [EAST_ROAD, NORTH_ROAD] }));
        await page.locator("li.trip:not(.unindexed-note)").first().locator(".trip-title").click();
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.mapReady)).toBe(true);
        // The trip's own map keeps the user's view while another map registers.
        await page.evaluate(() => window.__everydashcam.state.map!.jumpTo({ zoom: 12.25 }));

        await page.locator("#trip-map-toggle").click();
        await expect(page.locator(".viewer")).toHaveClass(/has-trip-map-over-trip/);
        await expectRoutesDrawn(page);
        expect(await page.locator(".player-wrap").evaluate((element) => (element as HTMLElement).inert)).toBe(true);
        expect(await page.evaluate(() => document.querySelector("video")!.paused)).toBe(true);
        expect(await page.evaluate(() => window.__everydashcam.state.map!.getZoom())).toBeCloseTo(12.25, 2);
        await expect(page.locator("#trip-map-close")).toHaveAttribute("aria-label", "Back to video");

        await page.locator("#trip-map").click({ position: { x: 20, y: 300 } });
        await page.keyboard.press("Escape");
        await expect(page.locator(".viewer")).not.toHaveClass(/has-trip-map-over-trip/);
        await expect(page.locator("#trip-map-toggle")).toBeFocused();
        expect(await page.locator(".player-wrap").evaluate((element) => (element as HTMLElement).inert)).toBe(false);
        expect(await page.evaluate(() => window.__everydashcam.state.map!.getZoom())).toBeCloseTo(12.25, 2);
    });

    test("a dot of nearby short trips splits when clicked", async ({ page }) => {
        // Trips 16 m apart share a dot's grid cell up to zoom 16 and part at 17,
        // past the last zoom step the corridor lines are computed for.
        await openLibrary(
            page,
            writeTripLibrary({
                roads: [
                    [
                        [0, 0],
                        [12, 0],
                    ],
                    [
                        [16, 0],
                        [28, 0],
                    ],
                ],
            }),
        );
        const dots = page.locator(".trip-map-dot");
        await expect(dots).toHaveCount(1);
        await expect(dots).toHaveText("2");

        await dots.click();

        await expect(dots).toHaveCount(2);
        expect(await page.evaluate(() => window.__everydashcam.state.tripMap!.getZoom())).toBeLessThanOrEqual(17);
    });

    test("reads the tracks inside videos on request", async ({ page }) => {
        await openLibrary(page, writeTripLibrary({ roads: [EAST_ROAD], withoutGps: 1, hasDeferredGps: true }));
        await expectRoutesDrawn(page);
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.pendingHeavyEmbeddedGps.size)).toBe(1);
        const counter = page.locator("#trip-map-counter");
        await expect(counter).toBeEnabled();

        await counter.click();
        await expect(counter).toHaveAttribute("aria-expanded", "true");
        await expect(page.locator("#trip-map-read-no-gps")).toHaveText(
            "1 trip without GPS: no coordinates were found in the recordings.",
        );
        await expect(page.locator("#trip-map-read-unread")).toHaveText(
            "1 trip isn't read yet: the GPS track is inside the video and is read when the trip opens.",
        );
        await page.locator("#trip-map-read-now").click();

        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.pendingHeavyEmbeddedGps.size)).toBe(0);
        await expect(page.locator("#trip-map-read-unread")).toBeHidden();
        await expect(page.locator("#trip-map-read-now")).toBeHidden();
        await expect(counter).not.toHaveClass(/is-reading/);
        await expect(counter).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(counter).toHaveAttribute("aria-expanded", "false");
    });
});

test.describe("on a phone", () => {
    test.use({ viewerMap: "route-only", viewport: MOBILE, hasTouch: true, isMobile: true });

    test("the map tab keeps the credits above its sheet and lists a place's trips there", {
        tag: "@webkit-ui",
    }, async ({ page }) => {
        await openLibrary(page, writeTripLibrary({ roads: [EAST_ROAD, NORTH_ROAD, EAST_ROAD] }));
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.tripMap)).toBeNull();

        await page.locator("#trip-view-map").tap();
        await expect(page.locator("#trip-view-map")).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("#trip-map-panel #trip-map-state")).toBeVisible();
        await expectRoutesDrawn(page);
        const sheet = page.locator("#trip-map-sheet");
        const credits = page.locator("#trip-map-panel .maplibregl-ctrl-bottom-right");
        await expect
            .poll(async () => (await credits.boundingBox())!.y + (await credits.boundingBox())!.height)
            .toBeLessThanOrEqual((await sheet.boundingBox())!.y + 1);

        await zoomTo(page, 1500, 0);
        const road = await mapPoint(page, 1500, 0);
        await page.touchscreen.tap(road.x, road.y);
        await expect(sheet).toHaveClass(/has-place/);
        await expect(page.locator("#trip-map-sheet-list #trip-list li.trip:not(.unindexed-note)")).toHaveCount(2);
        // The place stays in the part of the map the raised sheet leaves visible.
        await expect
            .poll(async () => (await sheet.boundingBox())!.y - (await mapPoint(page, 1500, 0)).y)
            .toBeGreaterThan(20);

        await page.locator("#trip-place-clear").tap();
        await expect(page.locator("#trip-view-map")).toBeFocused();
        await page.locator("#trip-view-list").tap();
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.tripMap)).toBeNull();
    });
});

// Pointer hover over the trip line on the main map: the popup with the nearest
// fix's readout and the chart's hover cursor follow the pointer, and both go
// away once it leaves the line. Hover is answered once per frame from a single
// map-level mousemove, so this pins the enter/move/leave transitions that the
// layer-delegated listeners used to provide.

import type { Page } from "@playwright/test";

import { DESKTOP, expect, gotoApp, loadTrip, pausePlayback, presetLocalStorage, test } from "./_fixtures.js";

test.use({ serviceWorkers: "block" });

interface ClientPoint {
    x: number;
    y: number;
}

/**
 * Client coordinates of a GPS fix whose rendered trip line is under the
 * pointer, clear of the car marker, the canvas edges, anything drawn over the
 * canvas (an open hover popup, endpoint flags: moving onto them leaves the
 * canvas) and the fix at `other`. Without `other` the topmost such fix is
 * returned: the popup opens above the point, which keeps the fixes below it
 * free for a second move.
 */
async function trackPoint(page: Page, other?: ClientPoint): Promise<ClientPoint> {
    const point = await page.evaluate((other) => {
        const { state } = window.__everydashcam;
        const map = state.map!;
        const trip = state.trips[state.active!.trip]!;
        const canvas = map.getCanvas().getBoundingClientRect();
        const car = state.marker ? map.project(state.marker.getLngLat()) : null;
        const popup = document.querySelector("#map .maplibregl-popup")?.getBoundingClientRect();
        const candidates: { x: number; y: number }[] = [];
        for (const record of trip.records) {
            if (!record.active) continue;
            const local = map.project([record.lon, record.lat]);
            const x = local.x + canvas.left;
            const y = local.y + canvas.top;
            const inside = local.x > 40 && local.y > 40 && local.x < canvas.width - 40 && local.y < canvas.height - 40;
            if (!inside || (car && Math.hypot(local.x - car.x, local.y - car.y) < 60)) continue;
            if (other && Math.hypot(x - other.x, y - other.y) < 12) continue;
            const underPopup =
                popup && x > popup.left - 8 && x < popup.right + 8 && y > popup.top - 8 && y < popup.bottom + 8;
            if (underPopup || document.elementFromPoint(x, y) !== map.getCanvas()) continue;
            if (map.queryRenderedFeatures(local, { layers: ["trip-line"] }).length === 0) continue;
            candidates.push({ x, y });
        }
        if (other) return candidates[0] ?? null;
        return candidates.reduce<{ x: number; y: number } | null>(
            (top, candidate) => (top === null || candidate.y < top.y ? candidate : top),
            null,
        );
    }, other);
    expect(point, "a hoverable fix on screen").not.toBeNull();
    return point!;
}

/** A client point over the map canvas where neither the line nor an event dot renders. */
async function emptyMapPoint(page: Page): Promise<ClientPoint> {
    const point = await page.evaluate(() => {
        const map = window.__everydashcam.state.map!;
        const canvas = map.getCanvas().getBoundingClientRect();
        const layers = ["trip-line", "trip-events-circle"].filter((layerId) => map.getLayer(layerId));
        for (let y = 60; y < canvas.height - 60; y += 40) {
            for (let x = 60; x < canvas.width - 60; x += 40) {
                const box: [[number, number], [number, number]] = [
                    [x - 20, y - 20],
                    [x + 20, y + 20],
                ];
                if (map.queryRenderedFeatures(box, { layers }).length === 0) {
                    return { x: x + canvas.left, y: y + canvas.top };
                }
            }
        }
        return null;
    });
    expect(point, "an empty spot on the map").not.toBeNull();
    return point!;
}

test("track hover shows the nearest fix and the chart cursor, and clears them on leave", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await loadTrip(page);
    await pausePlayback(page);
    // The main map starts folded behind the mini-map; clicking it expands it.
    await page.locator("#mini-map").click();
    await expect(page.locator("body")).not.toHaveClass(/map-morphing/);
    await expect(page.locator("#map canvas.maplibregl-canvas")).toBeVisible();
    // A still, flat camera framing the whole route keeps the projected points
    // under the pointer and spreads them wider than the car marker.
    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                const { state } = window.__everydashcam;
                state.followMode = "off";
                const map = state.map!;
                const fixes = state.trips[state.active!.trip]!.records.filter((record) => record.active);
                const lons = fixes.map((record) => record.lon);
                const lats = fixes.map((record) => record.lat);
                map.once("idle", () => resolve());
                map.jumpTo({ pitch: 0, bearing: 0 });
                map.fitBounds(
                    [
                        [Math.min(...lons), Math.min(...lats)],
                        [Math.max(...lons), Math.max(...lats)],
                    ],
                    { padding: 120, animate: false },
                );
            }),
    );

    const popup = page.locator("#map .maplibregl-popup");
    const chartCursor = page.locator("#player-chart-hover-cursor");
    const canvasCursor = () => page.evaluate(() => window.__everydashcam.state.map!.getCanvas().style.cursor);
    await expect(popup).toHaveCount(0);
    await expect(chartCursor).toBeHidden();

    const first = await trackPoint(page);
    await page.mouse.move(first.x, first.y);
    await expect(popup).toBeVisible();
    await expect(chartCursor).toBeVisible();
    await expect.poll(canvasCursor).toBe("pointer");
    const firstHover = await page.evaluate(() => {
        const { state } = window.__everydashcam;
        (window as unknown as { hoverPopupElement?: HTMLElement }).hoverPopupElement = state.hoverPopup!.getElement();
        return { relSec: state.chartHoverX, html: state.hoverPopup!.getElement().textContent };
    });
    expect(firstHover.relSec).not.toBeNull();

    // Moving to another fix re-targets the open popup instead of rebuilding it.
    // One move: a straight path between non-adjacent fixes can leave the line,
    // and leaving it rightly closes the popup.
    const second = await trackPoint(page, first);
    await page.mouse.move(second.x, second.y);
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.chartHoverX)).not.toBe(firstHover.relSec);
    expect(
        await page.evaluate(
            () =>
                window.__everydashcam.state.hoverPopup?.getElement() ===
                (window as unknown as { hoverPopupElement?: HTMLElement }).hoverPopupElement,
        ),
        "the open popup is reused across fixes",
    ).toBe(true);
    await expect(popup).not.toHaveText(firstHover.html ?? "");

    const empty = await emptyMapPoint(page);
    await page.mouse.move(empty.x, empty.y);
    await expect(popup).toHaveCount(0);
    await expect(chartCursor).toBeHidden();
    await expect.poll(canvasCursor).toBe("");
    expect(await page.evaluate(() => window.__everydashcam.state.chartHoverX)).toBeNull();
});

// The GPS-dependent export gate. On a trip with no GPS fix the export panel
// disables (greys out) every option that needs a track - embedded telemetry,
// the .gpx sidecar, and the speed/coords/map overlays - the GPS-track-only
// switch hides, and the produced MP4 carries NO gpmd telemetry track even though
// "keep GPS" is the default. Uses a synthetic H.264 no-GPS sample (every other
// public fixture carries a track by design) so the whole gate runs on CI Chrome,
// not only on a macOS box that decodes HEVC.
//
// Two layers, both regression gates a panel-only test could not give:
//   - the panel DISPLAY (5 checkboxes disabled+unchecked, mode switch hidden)
//   - the PRODUCED FILE: a stale gpmf default must not inject an empty gpmd track
//     (export-flow's `withGpmf && hasGps`). That gate is invisible to a display
//     assertion - only inspecting the output bytes catches a regression in it.

import {
    DESKTOP,
    SAMPLE_70MAI,
    SAMPLE_NOGPS,
    boxOf,
    expect,
    gotoApp,
    installExportCapture,
    loadTrip,
    openExport,
    presetLocalStorage,
    readExportResult,
    shot,
    test,
} from "./_fixtures.js";

const GPS_OPTION_IDS = [
    "#export-panel-gpmf",
    "#export-panel-gpx",
    "#export-panel-ov-speed",
    "#export-panel-ov-coords",
    "#export-panel-ov-map",
    "#export-panel-ov-clock",
    "#export-panel-ov-compass",
    "#export-panel-ov-gforce",
    "#export-panel-ov-distance",
    "#export-panel-ov-graph",
];

test.describe("no-GPS export gate", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        // A trip without GPS may temporarily disable the map controls, but it
        // must not overwrite the layout chosen on a previous GPS-bearing trip.
        await page.addInitScript(() => {
            localStorage.setItem("dc.viewer.panels", JSON.stringify({ map: true, mapMode: "large" }));
        });
        await installExportCapture(page); // before gotoApp - captured at bundle load
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_NOGPS);
        await openExport(page);
    });

    test("panel: GPS-dependent options are disabled and the GPS-track switch hidden", async ({ page }) => {
        // GPS-track-only mode makes no sense without a track - the switch hides
        // (its parent fieldset gets the hidden attribute via syncModeAvailability).
        await expect(page.locator('button[data-mode="gpx"]')).toBeHidden();
        for (const id of GPS_OPTION_IDS) {
            await expect(page.locator(id), `${id} must be disabled with no GPS`).toBeDisabled();
            await expect(page.locator(id), `${id} must be cleared with no GPS`).not.toBeChecked();
        }
        const rows = page.locator(".export-panel__ov-row");
        expect(await rows.count()).toBeGreaterThan(0);
        for (const row of await rows.all()) {
            await expect(row.locator("input")).toBeDisabled();
            await expect(row.locator("button")).toBeDisabled();
        }
        // The map-overlay zoom + shape controls live in the per-widget inspector,
        // which only renders for a selected, enabled widget - on a no-GPS trip
        // nothing is enabled, so the inspector stays hidden.
        await expect(page.locator("#export-panel-overlay-inspector")).toBeHidden();
        await shot(page, "no-gps-01-export-options");
    });

    test("opening a no-GPS trip preserves the saved map mode", async ({ page }) => {
        const storedMode = await page.evaluate(() => {
            const stored = JSON.parse(localStorage.getItem("dc.viewer.panels") ?? "{}") as { mapMode?: string };
            return stored.mapMode;
        });
        expect(storedMode).toBe("large");
        await expect(page.locator('[data-map-mode="large"]')).toBeDisabled();
    });

    test("saved overlays pause on a no-GPS trip and return on the next GPS trip", async ({ page }) => {
        await page.locator("#export-panel-close").click();
        await page.reload();
        await loadTrip(page, SAMPLE_70MAI);
        await openExport(page);
        await page.locator("#export-panel-ov-map").check();
        await expect(page.locator("#player-map-overlay")).toBeVisible();

        await page.locator("#export-panel-close").click();
        await page.reload();
        await loadTrip(page, SAMPLE_NOGPS);
        await openExport(page);
        await expect(page.locator("#export-panel-ov-map")).toBeDisabled();
        await expect(page.locator("#export-panel-ov-map")).not.toBeChecked();
        await expect(page.locator("#player-map-overlay")).toBeHidden();
        await expect(page.locator("#export-panel-overlays-reset")).toBeVisible();
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const stored = JSON.parse(localStorage.getItem("everydashcam:export:overlays") ?? "null") as {
                        overlayMap?: { enabled?: boolean };
                    } | null;
                    return stored?.overlayMap?.enabled;
                }),
            )
            .toBe(true);

        await page.locator("#export-panel-close").click();
        await page.reload();
        await loadTrip(page, SAMPLE_70MAI);
        await openExport(page);
        await expect(page.locator("#export-panel-ov-map")).toBeChecked();
        await expect(page.locator("#player-map-overlay")).toBeVisible();
    });

    test("timeline navigator stays on top above the playhead", async ({ page }) => {
        const chart = await boxOf(page, "#player-chart");
        const navigatorRow = await boxOf(page, "#player-chart-zoom-row");
        const playhead = await boxOf(page, "#player-chart-playhead");

        expect(navigatorRow.y - chart.y, "navigator row stays at the timeline top").toBeLessThanOrEqual(2);
        expect(playhead.y, "the current-time line starts below the navigator row").toBeGreaterThanOrEqual(
            navigatorRow.y + navigatorRow.height - 1,
        );
    });

    test("light theme keeps the no-GPS status readable", async ({ page }) => {
        await page.locator('.theme-toggle-btn[data-theme="light"]').click();
        await expect(page.locator("html")).toHaveClass(/dc-light/);

        const label = page.locator("#readout-fix-label");
        await expect(label).toBeVisible();
        await expect(label).toHaveText("No GPS data");
        const contrast = await label.evaluate((element) => {
            const parseRgb = (color: string): number[] => {
                const channels = color
                    .match(/[\d.]+/g)
                    ?.slice(0, 3)
                    .map(Number);
                if (channels?.length !== 3) throw new Error(`unsupported color: ${color}`);
                return channels;
            };
            const luminance = (color: string): number => {
                const [r, g, b] = parseRgb(color).map((channel) => {
                    const value = channel / 255;
                    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                });
                return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
            };

            const foreground = luminance(getComputedStyle(element).color);
            const background = luminance(getComputedStyle(element.closest("#player-readout")!).backgroundColor);
            return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
        });
        expect(contrast, "small muted status text meets WCAG AA contrast").toBeGreaterThanOrEqual(4.5);
    });

    test("pipeline: a stale 'keep GPS' default does NOT inject a gpmd track", async ({ page }) => {
        // withGpmf defaults true, but
        // the trip has no fix, so export-flow's `withGpmf && hasGps` gate must keep
        // the produced MP4 free of a gpmd track. Single channel + source preset =>
        // stream-copy; the assertion is the absence of gpmd, the inverse of the
        // export-run GPS-sample tests.
        await page.locator("#export-panel-save-btn").click();
        await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 60_000 });

        const r = await readExportResult(page);
        expect(r, "export must have written bytes through the stubbed handle").not.toBeNull();
        expect(r!.len, "produced MP4 must be non-trivial").toBeGreaterThan(1024);
        expect(r!.ftyp, "MP4 must have an ftyp box").toBe(true);
        expect(r!.moov, "MP4 must have a moov box").toBe(true);
        expect(r!.mdat, "MP4 must have media data").toBe(true);
        expect(r!.gpmd, "no GPS -> no gpmd track, despite the kept-by-default toggle").toBe(false);
    });
});

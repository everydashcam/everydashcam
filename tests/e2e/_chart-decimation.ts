import { type Page, expect } from "@playwright/test";
import type { LineElement } from "chart.js";
import { loadTrip, pausePlayback, SAMPLE_70MAI, waitForMetadata } from "./_fixtures.js";

/** Exercise the real chart plugin and application rebuild on either edition. */
export async function verifyChartDecimation(page: Page): Promise<void> {
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await waitForMetadata(page);
    const sourceCount = 10_000;
    const estimateIndex = 5_123;
    const seeded = await page.evaluate(
        ({ sourceCount, estimateIndex }) => {
            const { state } = window.__everydashcam;
            const trip = state.trips[state.active!.trip]!;
            const base = trip.records[0]!;
            const duration = trip.timeline.contentDurationSec;
            const start = trip.timeline.segments[0]!.wallStart;
            trip.records = Array.from({ length: sourceCount }, (_, index) => ({
                ...base,
                unixSeconds: start + (index / (sourceCount - 1)) * duration,
                active: true,
                lat: 43,
                lon: 77,
                speedMs: 20,
                speedSource: index === estimateIndex ? "estimated" : "measured",
                trackSegment: 0,
                accelXg: 0.1,
                accelYg: 0,
                accelZg: 0,
            }));
            return { duration, estimateSec: (estimateIndex / (sourceCount - 1)) * duration };
        },
        { sourceCount, estimateIndex },
    );
    // The public units control rebuilds the chart from the seeded telemetry.
    await page.locator("#pm-speed-toggle").click();
    const overview = await chartSnapshot(page);
    expect(overview.parsing).toBe(false);
    expect(overview.enabled).toBe(true);
    expect(overview.speedCount).toBe(200);
    expect(overview.accelCount).toBe(200);
    expect(overview.finite).toBe(true);
    expect(overview.speedStart).toBeCloseTo(0);
    expect(overview.speedEnd).toBeCloseTo(seeded.duration);
    const estimated = overview.segments.filter((segment) => segment.dash.length > 0);
    expect(estimated).toHaveLength(1);
    expect(estimated[0]!.start).toBeLessThanOrEqual(seeded.estimateSec);
    expect(estimated[0]!.end).toBeGreaterThanOrEqual(seeded.estimateSec);

    // A narrow inspection restores original detail; reset returns to the trip's
    // full range and decimates again without remembering a previous range.
    const zoomIn = page.locator("#player-chart-zoom-in");
    for (let i = 0; i < 12 && (await zoomIn.isEnabled()); i++) await zoomIn.click();
    const detail = await chartSnapshot(page);
    expect(detail.max - detail.min).toBeLessThan(seeded.duration);
    expect(detail.speedCount).toBeGreaterThan(overview.speedCount);
    await page.locator("#player-chart-overview-reset").click();
    const reset = await chartSnapshot(page);
    expect(reset.min).toBeCloseTo(0);
    expect(reset.max).toBeCloseTo(seeded.duration);
    expect(reset.speedCount).toBe(200);

    const gaps = await page.evaluate(() => {
        const { state } = window.__everydashcam;
        const trip = state.trips[state.active!.trip]!;
        const missingIndex = Math.floor(trip.records.length / 3);
        const boundaryIndex = Math.floor((trip.records.length * 2) / 3);
        const missing = trip.records[missingIndex]!;
        missing.lat = 0;
        missing.lon = 0;
        for (const record of trip.records.slice(boundaryIndex)) record.trackSegment = 1;
        const start = trip.timeline.segments[0]!.wallStart;
        return {
            missingSec: missing.unixSeconds - start,
            boundarySec:
                (trip.records[boundaryIndex - 1]!.unixSeconds + trip.records[boundaryIndex]!.unixSeconds) / 2 - start,
        };
    });
    await page.locator("#pm-speed-toggle").click();
    const gapped = await chartSnapshot(page);
    expect(gapped.enabled).toBe(false);
    expect(gapped.speedCount).toBe(sourceCount + 1);
    expect(gapped.accelCount).toBe(sourceCount);
    expect(gapped.missing).toHaveLength(2);
    expect(gapped.missing[0]).toBeCloseTo(gaps.missingSec);
    expect(gapped.missing[1]).toBeCloseTo(gaps.boundarySec);
    for (const gap of gapped.missing) {
        expect(gapped.segments.some((segment) => segment.start < gap && segment.end > gap)).toBe(false);
    }
}

async function chartSnapshot(page: Page) {
    return page.evaluate(() => {
        const chart = window.__everydashcam.state.chart!;
        const points = chart.data.datasets[0]!.data as Array<{ x: number; y: number }>;
        const line = chart.getDatasetMeta(0).dataset as LineElement;
        return {
            parsing: chart.options.parsing,
            enabled: chart.options.plugins?.decimation?.enabled,
            speedCount: points.length,
            accelCount: chart.data.datasets[1]!.data.length,
            speedStart: points[0]!.x,
            speedEnd: points.at(-1)!.x,
            min: chart.scales.x!.min,
            max: chart.scales.x!.max,
            finite: points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
            missing: points.filter((point) => !Number.isFinite(point.y)).map((point) => point.x),
            segments: line.segments.map((segment) => ({
                start: points[segment.start]!.x,
                end: points[segment.end]!.x,
                // Chart.js exposes segment bounds in its types but omits the
                // resolved per-segment style used by its canvas renderer.
                dash: (Reflect.get(segment, "style") as { borderDash?: number[] } | undefined)?.borderDash ?? [],
            })),
        };
    });
}

// Trip activation per vendor.
//
// Architecture: one ingest, then iterate trips. Each replay clicks a
// DIFFERENT trip so playFrame's tripChanged branch fires fresh
// setVideoSrcFromFile + refreshMap + rebuildChartFromTrip, and
// requestVideoFrameCallback fires for the new paint. Reset-state-and-
// reclick on the SAME trip does not work: setVideoSrcFromFile is
// idempotent ("same file already attached"), no new frame paint, no
// player-first-frame event.
//
// Vendors with fewer trips than WARMUP+REPLAYS get fewer measured replays.
// Vendors with zero trips are skipped (no UI to click).

import { test } from "@playwright/test";

import { deliverFiles } from "../harness/files.js";
import { parseEnvInt } from "../harness/env.js";
import { readBytesRead, resetBytesRead } from "../harness/bytes-read.js";
import {
    readCdpMetrics,
    readCdpProcesses,
    readLifecycleEvents,
    readMeasures,
    resetPerfState,
    sumByType,
} from "../harness/measure.js";
import { readMeasureUASpecificMemory, startPeakMemoryPoller, stopAndReadPeakMemory } from "../harness/peak-memory.js";
import { aggregate } from "../harness/repeat.js";
import { setupPage } from "../harness/setup.js";
import { discoverVendors, type VendorSample } from "../harness/vendors.js";

// Defaults: 1 warmup + 3 replays + median. Override via env for quick smokes:
//   PERF_WARMUP=1 PERF_REPLAYS=1 make perf-vendor VENDOR=...
// Invalid env falls back to default with a stderr warn instead of silent NaN.
const WARMUP = parseEnvInt("PERF_WARMUP", 1);
const REPLAYS = parseEnvInt("PERF_REPLAYS", 3);

const vendors = discoverVendors();

if (vendors.length === 0) {
    test.skip(true, "no vendor samples in private/samples - skipping trip-activation suite");
}

for (const vendor of vendors) {
    test(`trip activation: ${vendor.name}`, async ({ browser }, testInfo) => {
        // One progressive ingest in setup (not per-replay).
        // ingestBudgetMs bounds the ingest-done wait below; the test timeout
        // adds headroom for the activation replays (each capped at 10 s plus
        // CDP metric reads) on top of it.
        const mbTotal = Math.ceil(vendor.totalBytes / (1024 * 1024));
        const ingestBudgetMs = 60_000 + mbTotal * 250;
        test.setTimeout(Math.max(ingestBudgetMs + (WARMUP + REPLAYS) * 30_000, 180_000));

        const ctx = await browser.newContext({ serviceWorkers: "block" });
        const page = await ctx.newPage();
        const samples: ScenarioResult[] = [];
        try {
            await setupPage(page);

            // One ingest for the whole test. Not measured, but bounded by the
            // vendor-scaled budget - a fixed timeout would spuriously fail on
            // large cards or slow CI storage.
            await deliverFiles(page, vendor.absPath);
            await page.waitForFunction(
                () => {
                    const w = window as unknown as {
                        __everydashcamPerf?: { lifecycleEvents?: Array<{ type: string }> };
                    };
                    return !!w.__everydashcamPerf?.lifecycleEvents?.some((e) => e.type === "everydashcam:ingest-done");
                },
                { timeout: ingestBudgetMs, polling: 100 },
            );

            const tripCount = await page.evaluate(() => {
                const w = window as unknown as { __everydashcam?: { state: { trips: unknown[] } } };
                return w.__everydashcam?.state.trips.length ?? 0;
            });
            if (tripCount === 0) {
                test.skip(true, `vendor ${vendor.name} has 0 trips after ingest, nothing to activate`);
                return;
            }
            // Clip iterations to available trips. A vendor with only 1 trip
            // still gets 1 measured sample (no warmup); a vendor with 2 trips
            // gets 1 warmup + 1 measured; etc.
            const totalIterations = Math.min(WARMUP + REPLAYS, tripCount);
            const warmupCount = totalIterations > 1 ? WARMUP : 0;

            for (let i = 0; i < totalIterations; i++) {
                const tripIdx = i;
                // Sidebar may have sorted trips by date (default desc). The
                // attribute data-trip-index reflects the ORIGINAL state.trips
                // index, not the rendered position. Click by that selector so
                // we activate a deterministic trip irrespective of sort.
                const tripHeader = page.locator(`li.trip[data-trip-index="${tripIdx}"] .trip-header`);

                await resetPerfState(page);
                await resetBytesRead(page);
                await startPeakMemoryPoller(page, 100);

                const cdpBefore = await readCdpMetrics(page);
                const procBefore = await readCdpProcesses(page);

                const wallStart = Date.now();
                await tripHeader.click();
                try {
                    await page.waitForFunction(
                        () => {
                            const w = window as unknown as {
                                __everydashcamPerf?: { lifecycleEvents?: Array<{ type: string }> };
                            };
                            const seen = new Set((w.__everydashcamPerf?.lifecycleEvents ?? []).map((e) => e.type));
                            // player-failed is a terminal alternative to
                            // first-frame (canDecodeVideo rejected the codec).
                            // Treat either as "player done" so the harness does
                            // not hang on unplayable-but-otherwise-valid trips.
                            const playerDone =
                                seen.has("everydashcam:player-first-frame") || seen.has("everydashcam:player-failed");
                            return (
                                playerDone &&
                                seen.has("everydashcam:map-tracks-rendered") &&
                                seen.has("everydashcam:chart-rendered")
                            );
                        },
                        { timeout: 10_000, polling: 100 },
                    );
                } catch {
                    const dump = await page.evaluate(() => {
                        const w = window as unknown as {
                            __everydashcamPerf?: { lifecycleEvents?: Array<{ type: string }> };
                            __everydashcam?: { state: { active: unknown; trips: unknown[] } };
                        };
                        return {
                            events: (w.__everydashcamPerf?.lifecycleEvents ?? []).map((e) => e.type),
                            active: w.__everydashcam?.state.active,
                            tripsLen: w.__everydashcam?.state.trips.length,
                        };
                    });
                    throw new Error(
                        `${vendor.name} trip ${tripIdx} (replay ${i}): missing lifecycle events. ` +
                            `dump=${JSON.stringify(dump)}`,
                    );
                }
                const wallEnd = Date.now();

                const cdpAfter = await readCdpMetrics(page);
                const procAfter = await readCdpProcesses(page);
                const measures = await readMeasures(page);
                const lifecycleEvents = await readLifecycleEvents(page);
                const bytesRead = await readBytesRead(page);
                const peakMem = await stopAndReadPeakMemory(page);
                // Per-replay set to null. Total page memory (measureUASpec)
                // is captured once at end-of-test below.
                const replayMeasureUA: number | null = null;

                const rendererBefore = sumByType(procBefore, "renderer");
                const rendererAfter = sumByType(procAfter, "renderer");
                const gpuBefore = sumByType(procBefore, "gpu");
                const gpuAfter = sumByType(procAfter, "gpu");

                const tFirst = lifecycleEvents[0]?.t ?? 0;
                const lat = (type: string): number | null => {
                    const e = lifecycleEvents.find((x) => x.type === type);
                    return e ? Math.round(e.t - tFirst) : null;
                };

                const result: ScenarioResult = {
                    wallMs: wallEnd - wallStart,
                    latency: {
                        tripActivated: lat("everydashcam:trip-activated"),
                        playerFirstFrame: lat("everydashcam:player-first-frame"),
                        mapTracksRendered: lat("everydashcam:map-tracks-rendered"),
                        chartRendered: lat("everydashcam:chart-rendered"),
                    },
                    bytesRead,
                    peakUsedJSHeap: peakMem.peakUsedJSHeapSize,
                    peakTotalJSHeap: peakMem.peakTotalJSHeapSize,
                    crossOriginIsolated: peakMem.crossOriginIsolated,
                    measureUASpecificMemoryBytes: replayMeasureUA,
                    cdpScriptDurationSecDelta: cdpAfter.scriptDurationSec - cdpBefore.scriptDurationSec,
                    cdpTaskDurationSecDelta: cdpAfter.taskDurationSec - cdpBefore.taskDurationSec,
                    cdpLayoutCountDelta: cdpAfter.layoutCount - cdpBefore.layoutCount,
                    rendererRssDeltaBytes: rendererAfter.rss - rendererBefore.rss,
                    rendererCpuSecDelta: rendererAfter.cpu - rendererBefore.cpu,
                    gpuRssDeltaBytes: gpuAfter.rss - gpuBefore.rss,
                    gpuCpuSecDelta: gpuAfter.cpu - gpuBefore.cpu,
                    measures,
                    lifecycleEvents,
                };
                if (i >= warmupCount) samples.push(result);
            }
            // End-of-test total-page memory snapshot. Captures workers +
            // canvas + decode buffers. Off by default (PERF_MEASURE_UA=1 to
            // enable) - the API synchronizes with GC and can take up to ~20 s
            // even called once. Stamp on the last sample so the report
            // carries a non-null reading.
            if (process.env.PERF_MEASURE_UA === "1") {
                const measureUABytes = await readMeasureUASpecificMemory(page);
                if (measureUABytes !== null && samples.length > 0) {
                    samples[samples.length - 1]!.measureUASpecificMemoryBytes = measureUABytes;
                }
            }
        } finally {
            await ctx.close();
        }

        publishMetrics(testInfo, vendor, samples);
    });
}

interface ScenarioResult {
    wallMs: number;
    latency: {
        tripActivated: number | null;
        playerFirstFrame: number | null;
        mapTracksRendered: number | null;
        chartRendered: number | null;
    };
    bytesRead: number;
    peakUsedJSHeap: number;
    peakTotalJSHeap: number;
    crossOriginIsolated: boolean;
    measureUASpecificMemoryBytes: number | null;
    cdpScriptDurationSecDelta: number;
    cdpTaskDurationSecDelta: number;
    cdpLayoutCountDelta: number;
    rendererRssDeltaBytes: number;
    rendererCpuSecDelta: number;
    gpuRssDeltaBytes: number;
    gpuCpuSecDelta: number;
    measures: Array<{ name: string; startTime: number; duration: number }>;
    lifecycleEvents: Array<{ type: string; t: number; detail: Record<string, unknown> | undefined }>;
}

interface PerfAnnotationPayload {
    entries: Array<{ name: string; value: number; unit: string; extra?: string }>;
    detail?: Record<string, unknown>;
}

function publishMetrics(
    testInfo: { annotations: Array<{ type: string; description?: string }> },
    vendor: VendorSample,
    samples: ScenarioResult[],
): void {
    if (samples.length === 0) return;
    const prefix = `trip-activation/${vendor.name}/`;
    const wall = aggregate(samples.map((s) => s.wallMs));
    const playerFf = aggregate(
        samples.map((s) => s.latency.playerFirstFrame ?? Number.NaN).filter((x) => Number.isFinite(x)),
    );
    const mapFf = aggregate(
        samples.map((s) => s.latency.mapTracksRendered ?? Number.NaN).filter((x) => Number.isFinite(x)),
    );
    const chartFf = aggregate(
        samples.map((s) => s.latency.chartRendered ?? Number.NaN).filter((x) => Number.isFinite(x)),
    );
    const heap = aggregate(samples.map((s) => s.peakUsedJSHeap));
    const bytes = aggregate(samples.map((s) => s.bytesRead));
    const scriptCpu = aggregate(samples.map((s) => s.cdpScriptDurationSecDelta * 1000));
    const rendererRss = aggregate(samples.map((s) => s.rendererRssDeltaBytes));
    const gpuRss = aggregate(samples.map((s) => s.gpuRssDeltaBytes));
    const gpuCpu = aggregate(samples.map((s) => s.gpuCpuSecDelta * 1000));

    const entries: PerfAnnotationPayload["entries"] = [
        { name: `${prefix}wall-ms (median)`, value: wall.median, unit: "ms" },
        { name: `${prefix}wall-ms (max)`, value: wall.max, unit: "ms" },
        { name: `${prefix}player-first-frame-ms (median)`, value: playerFf.median, unit: "ms" },
        { name: `${prefix}map-tracks-rendered-ms (median)`, value: mapFf.median, unit: "ms" },
        { name: `${prefix}chart-rendered-ms (median)`, value: chartFf.median, unit: "ms" },
        { name: `${prefix}peak-heap-bytes (median)`, value: heap.median, unit: "B" },
        // See cold-ingest.spec.ts: this is requested bytes (may double-count
        // if multiple readers slice the same range), not unique disk-read.
        { name: `${prefix}bytes-requested (median)`, value: bytes.median, unit: "B" },
        { name: `${prefix}script-cpu-ms (median)`, value: scriptCpu.median, unit: "ms" },
        { name: `${prefix}renderer-rss-delta-bytes`, value: rendererRss.median, unit: "B" },
        { name: `${prefix}gpu-rss-delta-bytes`, value: gpuRss.median, unit: "B" },
        { name: `${prefix}gpu-cpu-ms (median)`, value: gpuCpu.median, unit: "ms" },
    ];
    testInfo.annotations.push({
        type: "perf",
        description: JSON.stringify({
            entries,
            detail: {
                vendor: vendor.name,
                samples: samples.map((s, i) => ({
                    replay: i,
                    wallMs: s.wallMs,
                    latency: s.latency,
                    bytesRead: s.bytesRead,
                    peakUsedJSHeap: s.peakUsedJSHeap,
                    crossOriginIsolated: s.crossOriginIsolated,
                    measureUASpecificMemoryBytes: s.measureUASpecificMemoryBytes,
                    rendererRssDeltaBytes: s.rendererRssDeltaBytes,
                    gpuRssDeltaBytes: s.gpuRssDeltaBytes,
                })),
            },
        } satisfies PerfAnnotationPayload),
    });
}

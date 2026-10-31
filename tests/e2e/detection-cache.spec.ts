import { installWorkerRpc } from "./_worker-rpc.js";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DetectionQuality } from "../../src/tracking/detection-sampling.js";
import type { TimeInterval } from "../../src/tracking/interval-set.js";
import type { DetectKind, DetectRequestData, DetectResult } from "../../src/workers/tracker-protocol.js";
import { computeTrackerAssets } from "../../vite-plugins/tracker-assets.js";
import { expect, hasWebGpuAdapter, REPO_ROOT, test } from "./_fixtures.js";

for (const scenario of [
    {
        kind: "plate",
        quality: "balanced",
        threshold: 0.7,
        filename: "plate-motion-long.mp4",
        startSec: 0.37,
        endSec: 2.61,
        end: 3,
        tripStart: 0,
    },
    {
        kind: "plate",
        quality: "fast",
        threshold: 0.7,
        filename: "plate-motion-long.mp4",
        startSec: 1.4,
        endSec: 2.61,
        end: 3,
        tripStart: 0,
    },
    {
        kind: "plate",
        quality: "balanced",
        threshold: 0.7,
        filename: "plate-motion-long.mp4",
        startSec: 1.25,
        endSec: 1.61,
        end: 3,
        tripStart: 0,
    },
    {
        kind: "plate",
        quality: "balanced",
        threshold: 1,
        filename: "plate-motion-long.mp4",
        startSec: 0.37,
        endSec: 2.61,
        end: 3,
        tripStart: 0,
    },
    {
        kind: "face",
        quality: "thorough",
        threshold: 0.7,
        filename: "face-motion-60fps.mp4",
        startSec: 0.12,
        endSec: 0.62,
        end: 0.79,
        tripStart: 0,
    },
    // The retained checkpoint at 1.266666... s rounds backward when
    // converted from content time to source time at these trip offsets.
    ...[30.07, 321.123].map((tripStart) => ({
        kind: "plate" as const,
        quality: "balanced" as const,
        threshold: 0.7,
        filename: "plate-motion-long.mp4",
        startSec: 0.37,
        endSec: 1.61,
        end: 3,
        tripStart,
    })),
] satisfies Array<{
    kind: DetectKind;
    quality: DetectionQuality;
    threshold: number;
    filename: string;
    startSec: number;
    endSec: number;
    end: number;
    tripStart: number;
}>) {
    test(`checkpoint cache matches fresh ${scenario.quality} ${scenario.kind} detection at ${scenario.threshold} from ${scenario.startSec}, trip start ${scenario.tripStart}`, async ({
        page,
    }, info) => {
        test.setTimeout(600_000);
        const workers = readdirSync(resolve(REPO_ROOT, "dist/assets")).filter((name) =>
            /^tracker-worker-.*\.js$/.test(name),
        );
        expect(workers).toHaveLength(1);
        await page.route("**/detection-cache-harness.html", (route) =>
            route.fulfill({
                contentType: "text/html",
                body: "<!doctype html><title>Detection cache regression</title>",
            }),
        );
        await page.goto("/detection-cache-harness.html");
        test.skip(!(await hasWebGpuAdapter(page)), "WebGPU adapter unavailable - detection is WebGPU-only");
        await installWorkerRpc(page);
        const measurements = await page.evaluate(
            async ({ scenario, bytes, workerUrl, assets }) => {
                const worker = new Worker(workerUrl, { type: "module" });
                const file = new File([new Uint8Array(bytes)], scenario.filename, { type: "video/mp4" });
                const rpc = window.__workerRpc.connect(worker);
                const run = (bounds: TimeInterval, cached?: DetectResult, kinds: DetectKind[] = [scenario.kind]) => {
                    const contentBounds = {
                        startSec: scenario.tripStart + bounds.startSec,
                        endSec: scenario.tripStart + bounds.endSec,
                    };
                    const data: DetectRequestData = {
                        segments: [
                            {
                                file,
                                startInFile: bounds.startSec,
                                endInFile: bounds.endSec,
                                tripStart: scenario.tripStart,
                            },
                        ],
                        startContentSec: contentBounds.startSec,
                        endContentSec: contentBounds.endSec,
                        kinds,
                        quality: scenario.quality,
                        thresholds: { [scenario.kind]: scenario.threshold },
                        analyzeIntervalsByKind: Object.fromEntries(kinds.map((kind) => [kind, [contentBounds]])),
                        cachedAnalysisByKind: cached?.analysisByKind,
                        plateModelUrl: new URL(assets.models.plate.url, location.origin).href,
                        faceModelUrl: new URL(assets.models.face.url, location.origin).href,
                        trackerModelUrl: new URL(assets.models.tracker.url, location.origin).href,
                        ortAssets: assets.ort.webgpu,
                    };
                    return rpc.request<DetectResult>("detect", data);
                };
                try {
                    let previous = await run({ startSec: scenario.startSec, endSec: scenario.endSec });
                    const results = [];
                    for (const bounds of [
                        { startSec: 0.01, endSec: scenario.endSec },
                        { startSec: 0.01, endSec: scenario.end },
                        { startSec: 0, endSec: scenario.end },
                        { startSec: scenario.end / 3, endSec: scenario.end },
                        { startSec: 0.01, endSec: scenario.end - 0.037 },
                    ]) {
                        const incremental = await run(bounds, previous);
                        const fresh = await run(bounds);
                        results.push({
                            incremental,
                            fresh,
                            previousTracks: previous.tracksByKind[scenario.kind]!.length,
                            mixed: false,
                        });
                        previous = incremental;
                    }
                    if (
                        scenario.kind === "plate" &&
                        scenario.quality === "balanced" &&
                        scenario.threshold === 0.7 &&
                        scenario.startSec === 0.37
                    ) {
                        const bounds = { startSec: 0, endSec: scenario.end };
                        results.push({
                            incremental: await run(bounds, previous, ["plate", "face"]),
                            fresh: await run(bounds, undefined, ["plate", "face"]),
                            previousTracks: previous.tracksByKind.plate!.length,
                            mixed: true,
                        });
                    }
                    return results;
                } finally {
                    rpc.dispose();
                }
            },
            {
                scenario,
                bytes: Array.from(
                    readFileSync(resolve(REPO_ROOT, "tests/testdata/detector-motion", scenario.filename)),
                ),
                workerUrl: `/assets/${workers[0]!}`,
                assets: computeTrackerAssets("build").app,
            },
        );
        await info.attach("cache-effort", {
            body: JSON.stringify(
                measurements.map(({ incremental, fresh }) => ({
                    incremental: { decodedFrames: incremental.decodedFrames, stats: incremental.statsByKind },
                    fresh: { decodedFrames: fresh.decodedFrames, stats: fresh.statsByKind },
                })),
                null,
                2,
            ),
            contentType: "application/json",
        });
        if (scenario.quality === "fast") expect(measurements[0]!.previousTracks).toBeGreaterThan(0);
        for (const [index, { incremental, fresh, mixed }] of measurements.entries()) {
            expect(
                incremental.tracksByKind,
                "extension produces exactly the fresh masks, without stale endpoint tracks",
            ).toEqual(fresh.tracksByKind);
            expect(incremental.sourceFrames).toEqual(fresh.sourceFrames);
            expect(incremental.analysisByKind, "a reused result can itself be extended again").toEqual(
                fresh.analysisByKind,
            );
            expect(incremental.statsByKind[scenario.kind]!.scans).toBeLessThan(fresh.statsByKind[scenario.kind]!.scans);
            if (scenario.threshold === 1 || scenario.quality === "fast")
                expect(fresh.tracksByKind[scenario.kind]).toEqual([]);
            else expect(fresh.tracksByKind[scenario.kind]!.length).toBeGreaterThan(0);
            const hasReusableInterior = scenario.quality !== "fast" && !(scenario.startSec === 1.25 && index === 0);
            if (hasReusableInterior && !mixed) expect(incremental.decodedFrames).toBeLessThan(fresh.decodedFrames);
            if (mixed) expect(incremental.statsByKind.face!.scans).toBe(fresh.statsByKind.face!.scans);
            if (
                hasReusableInterior &&
                scenario.quality === "balanced" &&
                scenario.threshold < 1 &&
                scenario.startSec !== 1.25
            )
                expect(incremental.statsByKind[scenario.kind]!.trackUpdates).toBeLessThan(
                    fresh.statsByKind[scenario.kind]!.trackUpdates,
                );
        }
    });
}

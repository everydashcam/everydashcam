import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type BlurRegion, regionRectAt } from "../../src/blur-regions.js";
import type { CropRect } from "../../src/transcode/compose.js";
import type { WireRequest, WireResponse } from "../../src/workers/_protocol/wire.js";
import type { DetectRequestData, DetectResult } from "../../src/workers/tracker-protocol.js";
import { computeTrackerAssets } from "../../vite-plugins/tracker-assets.js";
import type motionFixture from "../testdata/plate-recovery/motion.json";
import { expect, hasWebGpuAdapter, REPO_ROOT, test } from "./_fixtures.js";

const motion = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "tests/testdata/plate-recovery/motion.json"), "utf8"),
) as typeof motionFixture;

function coverage(mask: CropRect, target: CropRect): number {
    const width = Math.max(
        0,
        Math.min(mask.xPct + mask.wPct, target.xPct + target.wPct) - Math.max(mask.xPct, target.xPct),
    );
    const height = Math.max(
        0,
        Math.min(mask.yPct + mask.hPct, target.yPct + target.hPct) - Math.max(mask.yPct, target.yPct),
    );
    return (width * height) / (target.wPct * target.hPct);
}

test("a real plate tracker loss triggers same-frame detection through exit", async ({ page }, testInfo) => {
    test.setTimeout(testInfo.project.metadata.requireWebGpu ? 600_000 : 120_000);
    const workers = readdirSync(resolve(REPO_ROOT, "dist/assets")).filter((name) =>
        /^tracker-worker-.*\.js$/.test(name),
    );
    expect(workers, "one fresh production tracker worker").toHaveLength(1);
    const assets = computeTrackerAssets("build").app;
    const bytes = Array.from(readFileSync(resolve(REPO_ROOT, "tests/testdata/plate-recovery", motion.filename)));
    await page.route("**/plate-recovery-harness.html", (route) =>
        route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>Plate recovery regression</title>",
        }),
    );
    await page.goto("/plate-recovery-harness.html");
    test.skip(!(await hasWebGpuAdapter(page)), "WebGPU adapter unavailable - detection is WebGPU-only");
    const result = await page.evaluate(
        async ({ workerUrl, bytes, assets, durationSec }) => {
            const worker = new Worker(workerUrl, { type: "module" });
            try {
                return await new Promise<DetectResult>((resolve, reject) => {
                    worker.onerror = (event) => reject(new Error(event.message));
                    worker.onmessage = (event: MessageEvent<unknown>) => {
                        if (!event.data || typeof event.data !== "object") return;
                        const message = event.data as Partial<WireResponse>;
                        if (message.__k !== "res" || message.id !== 1) return;
                        if (message.ok === true) resolve(message.result as DetectResult);
                        else if (message.ok === false) reject(new Error(message.error?.message ?? "detector failed"));
                        else reject(new Error("invalid detector response"));
                    };
                    const file = new File([new Uint8Array(bytes)], "motion.mp4", { type: "video/mp4" });
                    const data: DetectRequestData = {
                        segments: [{ file, startInFile: 0, endInFile: durationSec, tripStart: 0 }],
                        startContentSec: 0,
                        endContentSec: durationSec,
                        kinds: ["plate"],
                        quality: "balanced",
                        analyzeIntervalsByKind: { plate: [{ startSec: 0, endSec: durationSec }] },
                        plateModelUrl: new URL(assets.models.plate.url, location.origin).href,
                        faceModelUrl: new URL(assets.models.face.url, location.origin).href,
                        trackerModelUrl: new URL(assets.models.tracker.url, location.origin).href,
                        ortAssets: assets.ort.webgpu,
                    };
                    worker.postMessage({ __k: "req", id: 1, type: "detect", data } satisfies WireRequest);
                });
            } finally {
                worker.terminate();
            }
        },
        { workerUrl: `/assets/${workers[0]!}`, bytes, assets, durationSec: motion.durationSec },
    );
    const path = testInfo.outputPath("plate-recovery-result.json");
    writeFileSync(path, JSON.stringify(result, null, 2));
    await testInfo.attach("plate-recovery-result", { path, contentType: "application/json" });
    const stats = result.statsByKind.plate;
    expect(stats).toBeDefined();
    expect(stats!.recoveryScans).toBe(3);
    expect(stats!.scans).toBe(4 + stats!.recoveryScans!);
    expect(stats!.tiles).toBe(stats!.scans * 4);
    expect(stats!.recoveredTracks).toBe(3);
    expect(stats!.trackUpdates).toBeGreaterThan(0);
    const tracks = result.tracksByKind.plate ?? [];
    expect(tracks).toHaveLength(4);
    expect(tracks.every((track) => track.detHits === 1)).toBe(true);
    expect(Math.max(...tracks.map((track) => track.endSec)), "covers the last partially visible plate").toBeCloseTo(
        0.28,
    );
    // The empty checkpoint verifies the departing branch; a rejected update
    // with no detector recovery remains available for manual review.
    expect(result.uncertainFramesByKind?.plate).toHaveLength(1);
    expect(result.uncertainFramesByKind!.plate![0]!.contentSec).toBeCloseTo(0.28);
    expect(result.uncertainFramesByKind!.plate![0]!.durationSec).toBeCloseTo(0.04);
    const regions: BlurRegion[] = tracks.map((track, index) => ({
        id: `plate-${index}`,
        channel: "front",
        style: "fill",
        startSec: track.startSec,
        endSec: track.endSec,
        autoEnd: false,
        lastTrackLost: false,
        interpolation: "hold",
        keyframes: track.keyframes.map((keyframe) => ({ ...keyframe, pinned: false })),
    }));
    for (const frame of motion.frames) {
        const masks = regions.flatMap((region) => {
            const rect = regionRectAt(region, frame.contentSec);
            return rect ? [rect] : [];
        });
        expect(masks, `one cover per visible plate, none after exit at ${frame.contentSec}`).toHaveLength(
            frame.plates.length,
        );
        for (const target of frame.plates) {
            expect(coverage(masks[0]!, target), `visible plate coverage at ${frame.contentSec}`).toBeGreaterThan(0.9);
            expect(
                (masks[0]!.wPct * masks[0]!.hPct) / (target.wPct * target.hPct),
                `bounded cover at ${frame.contentSec}`,
            ).toBeLessThan(2);
        }
    }
});

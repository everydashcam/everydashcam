import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { regionRectAt, type BlurRegion } from "../../src/blur-regions.js";
import { iou } from "../../src/tracking/detect-track.js";
import type { CropRect } from "../../src/transcode/compose.js";
import type { WireRequest, WireResponse } from "../../src/workers/_protocol/wire.js";
import type { TrackRequestData, TrackResult } from "../../src/workers/tracker-protocol.js";
import { computeTrackerAssets } from "../../vite-plugins/tracker-assets.js";
import type motionFixture from "../testdata/tracker-motion/motion.json";
import { expect, REPO_ROOT, test } from "./_fixtures.js";

const motion = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "tests/testdata/tracker-motion/motion.json"), "utf8"),
) as typeof motionFixture;

function coveredFraction(mask: CropRect, target: CropRect): number {
    const w = Math.max(
        0,
        Math.min(mask.xPct + mask.wPct, target.xPct + target.wPct) - Math.max(mask.xPct, target.xPct),
    );
    const h = Math.max(
        0,
        Math.min(mask.yPct + mask.hPct, target.yPct + target.hPct) - Math.max(mask.yPct, target.yPct),
    );
    return (w * h) / (target.wPct * target.hPct);
}

test("real Follow keeps a moving textured target covered across a resolution change", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const workers = readdirSync(resolve(REPO_ROOT, "dist/assets")).filter((name) =>
        /^tracker-worker-.*\.js$/.test(name),
    );
    expect(workers, "one built production tracker worker").toHaveLength(1);
    const assets = computeTrackerAssets("build").app;
    const files = motion.segments.map((segment) => ({
        ...segment,
        bytes: Array.from(readFileSync(resolve(REPO_ROOT, "tests/testdata/tracker-motion", segment.name))),
    }));
    await page.route("**/tracker-motion-harness.html", (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Tracker motion regression</title>" }),
    );
    await page.goto("/tracker-motion-harness.html");
    const first = motion.frames[0]!;
    const lastSegment = motion.segments[motion.segments.length - 1]!;
    const endContentSec = lastSegment.tripStart + lastSegment.durationSec;
    const result = await page.evaluate(
        async ({ workerUrl, files, assets, seedRect, endContentSec }) => {
            const worker = new Worker(workerUrl, { type: "module" });
            try {
                return await new Promise<TrackResult>((resolve, reject) => {
                    worker.onerror = (event) => reject(new Error(event.message));
                    worker.onmessage = (event: MessageEvent<unknown>) => {
                        if (!event.data || typeof event.data !== "object") return;
                        const message = event.data as Partial<WireResponse>;
                        if (message.__k !== "res" || message.id !== 1) return;
                        if (message.ok === true) resolve(message.result as TrackResult);
                        else if (message.ok === false)
                            reject(new Error(message.error?.message ?? "tracker response failed"));
                        else reject(new Error("invalid tracker response"));
                    };
                    const data: TrackRequestData = {
                        segments: files.map((file) => ({
                            file: new File([new Uint8Array(file.bytes)], file.name, { type: "video/mp4" }),
                            startInFile: 0,
                            endInFile: file.durationSec,
                            tripStart: file.tripStart,
                        })),
                        seedContentSec: 0,
                        seedRect,
                        endContentSec,
                        modelUrl: new URL(assets.models.tracker, location.origin).href,
                        ortAssets: assets.ort.wasm,
                    };
                    worker.postMessage({ __k: "req", id: 1, type: "track", data } satisfies WireRequest);
                });
            } finally {
                worker.terminate();
            }
        },
        { workerUrl: `/assets/${workers[0]!}`, files, assets, seedRect: first.rect, endContentSec },
    );
    await testInfo.attach("tracker-motion-result", {
        body: JSON.stringify(result, null, 2),
        contentType: "application/json",
    });
    expect(result.endReason).toBe("completed");
    expect(result.trackedUntilSec).toBeCloseTo(endContentSec);
    expect(result.keyframes.length, "motion is measured throughout both source files").toBeGreaterThan(30);
    expect(result.keyframes.some((keyframe) => keyframe.contentSec > 3.5)).toBe(true);
    const region: BlurRegion = {
        id: "synthetic-moving-object",
        channel: "front",
        style: "fill",
        startSec: 0,
        endSec: endContentSec,
        autoEnd: true,
        lastTrackLost: false,
        keyframes: [
            { ...first, pinned: true },
            ...result.keyframes.map((keyframe) => ({ ...keyframe, pinned: false })),
        ],
    };
    for (const frame of motion.frames) {
        const mask = regionRectAt(region, frame.contentSec);
        expect(mask, `mask exists at ${frame.contentSec.toFixed(3)}s`).not.toBeNull();
        if (!mask) throw new Error("tracked mask missing");
        expect(iou(mask, frame.rect), `target overlap at ${frame.contentSec.toFixed(3)}s`).toBeGreaterThan(0.6);
        expect(coveredFraction(mask, frame.rect), `target coverage at ${frame.contentSec.toFixed(3)}s`).toBeGreaterThan(
            0.85,
        );
        expect(
            (mask.wPct * mask.hPct) / (frame.rect.wPct * frame.rect.hPct),
            `mask area stays bounded at ${frame.contentSec.toFixed(3)}s`,
        ).toBeLessThan(2);
    }
});

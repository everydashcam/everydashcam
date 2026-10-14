import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page, TestInfo } from "@playwright/test";

import { applyTrackResult } from "../../src/blur-follow.js";
import { createBlurRegion, regionRectAt, type BlurRegion } from "../../src/blur-regions.js";
import { iou } from "../../src/tracking/detect-track.js";
import type { CropRect } from "../../src/transcode/compose.js";
import type { WireRequest, WireResponse } from "../../src/workers/_protocol/wire.js";
import type { TrackRequestData, TrackResult } from "../../src/workers/tracker-protocol.js";
import { computeTrackerAssets } from "../../vite-plugins/tracker-assets.js";
import type motionFixture from "../testdata/tracker-motion/motion.json";
import type reliabilityFixture from "../testdata/tracker-reliability/reliability.json";
import { expect, REPO_ROOT, test } from "./_fixtures.js";

const motion = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "tests/testdata/tracker-motion/motion.json"), "utf8"),
) as typeof motionFixture;
const reliability = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "tests/testdata/tracker-reliability/reliability.json"), "utf8"),
) as typeof reliabilityFixture;

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

async function runFollow(
    page: Page,
    testInfo: TestInfo,
    fixtureDirectory: string,
    segments: Array<{ name: string; tripStart: number; durationSec: number }>,
    seedRect: CropRect,
    endContentSec: number,
): Promise<TrackResult> {
    const workers = readdirSync(resolve(REPO_ROOT, "dist/assets")).filter((name) =>
        /^tracker-worker-.*\.js$/.test(name),
    );
    expect(workers, "one built production tracker worker").toHaveLength(1);
    const assets = computeTrackerAssets("build").app;
    const files = segments.map((segment) => ({
        ...segment,
        bytes: Array.from(readFileSync(resolve(REPO_ROOT, "tests/testdata", fixtureDirectory, segment.name))),
    }));
    await page.route("**/tracker-motion-harness.html", (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Tracker motion regression</title>" }),
    );
    await page.goto("/tracker-motion-harness.html");
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
        { workerUrl: `/assets/${workers[0]!}`, files, assets, seedRect, endContentSec },
    );
    await testInfo.attach("tracker-motion-result", {
        body: JSON.stringify(result, null, 2),
        contentType: "application/json",
    });
    return result;
}

test("real Follow keeps a moving textured target covered across a resolution change", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const first = motion.frames[0]!;
    const lastSegment = motion.segments[motion.segments.length - 1]!;
    const endContentSec = lastSegment.tripStart + lastSegment.durationSec;
    const result = await runFollow(page, testInfo, "tracker-motion", motion.segments, first.rect, endContentSec);
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

test("real Follow loses a textured target behind a smooth cover and holds its last trusted mask", async ({
    page,
}, testInfo) => {
    test.setTimeout(120_000);
    const scenario = reliability.scenarios.find((item) => item.id === "smooth-occlusion")!;
    const first = scenario.frames[0]!;
    const result = await runFollow(
        page,
        testInfo,
        "tracker-reliability",
        [{ name: scenario.name, tripStart: 0, durationSec: scenario.durationSec }],
        first.targetRect,
        scenario.durationSec,
    );
    expect(result.endReason).toBe("lost");
    expect(result.trackedUntilSec, "tracking succeeds before the occluder arrives").toBeGreaterThanOrEqual(
        scenario.occlusionStartSec! - 0.15,
    );
    expect(result.trackedUntilSec, "the fully hidden target never produces a trusted observation").toBeLessThan(
        scenario.occlusionFullSec!,
    );
    expect(result.keyframes.length, "loss is preceded by real target tracking").toBeGreaterThan(8);
    const last = result.keyframes[result.keyframes.length - 1]!;
    expect(last.contentSec).toBeCloseTo(result.trackedUntilSec);
    expect(result.keyframes.every((frame) => frame.contentSec < scenario.occlusionFullSec!)).toBe(true);

    const region = createBlurRegion("front", "fill", 0, scenario.durationSec, 0, first.targetRect);
    region.autoEnd = true;
    applyTrackResult(region, 0, scenario.durationSec, scenario.durationSec, result);
    expect(region.lastTrackLost).toBe(true);
    expect(region.endSec, "uncertain loss keeps the requested tail covered").toBe(scenario.durationSec);
    for (const frame of scenario.frames) {
        const mask = regionRectAt(region, frame.contentSec);
        expect(mask, `cover exists at ${frame.contentSec.toFixed(3)}s`).not.toBeNull();
        if (!mask) throw new Error("tracked mask missing");
        if (frame.contentSec <= scenario.occlusionStartSec!) {
            expect(iou(mask, frame.targetRect), `visible target overlap at ${frame.contentSec}`).toBeGreaterThan(0.6);
            expect(
                coveredFraction(mask, frame.targetRect),
                `visible target coverage at ${frame.contentSec}`,
            ).toBeGreaterThan(0.85);
        }
        if (!frame.visible)
            expect(mask, `hidden frame ${frame.contentSec} holds the last trusted cover`).toEqual(last.rect);
    }
    expect(regionRectAt(region, scenario.durationSec)).toEqual(last.rect);
});

test("real Follow keeps a moving textured target covered through brightness and contrast changes", async ({
    page,
}, testInfo) => {
    test.setTimeout(120_000);
    const scenario = reliability.scenarios.find((item) => item.id === "illumination-change")!;
    const first = scenario.frames[0]!;
    const result = await runFollow(
        page,
        testInfo,
        "tracker-reliability",
        [{ name: scenario.name, tripStart: 0, durationSec: scenario.durationSec }],
        first.targetRect,
        scenario.durationSec,
    );
    expect(result.endReason).toBe("completed");
    expect(result.trackedUntilSec).toBe(scenario.durationSec);
    expect(result.keyframes.length).toBeGreaterThan(20);
    expect(result.keyframes[result.keyframes.length - 1]!.contentSec).toBeGreaterThan(2.2);
    const region = createBlurRegion("front", "fill", 0, scenario.durationSec, 0, first.targetRect);
    region.autoEnd = true;
    applyTrackResult(region, 0, scenario.durationSec, scenario.durationSec, result);
    expect(region.lastTrackLost).toBe(false);
    for (const frame of scenario.frames) {
        const mask = regionRectAt(region, frame.contentSec);
        expect(mask, `cover exists at ${frame.contentSec.toFixed(3)}s`).not.toBeNull();
        if (!mask) throw new Error("tracked mask missing");
        expect(iou(mask, frame.targetRect), `target overlap at ${frame.contentSec.toFixed(3)}s`).toBeGreaterThan(0.6);
        expect(
            coveredFraction(mask, frame.targetRect),
            `target coverage at ${frame.contentSec.toFixed(3)}s`,
        ).toBeGreaterThan(0.85);
        expect(
            (mask.wPct * mask.hPct) / (frame.targetRect.wPct * frame.targetRect.hPct),
            `bounded cover at ${frame.contentSec.toFixed(3)}s`,
        ).toBeLessThan(2);
    }
});

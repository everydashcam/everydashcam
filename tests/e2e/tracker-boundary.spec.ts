import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { applyTrackResult } from "../../src/blur-follow.js";
import { createBlurRegion, regionRectAt } from "../../src/blur-regions.js";
import { iou } from "../../src/tracking/detect-track.js";
import type { CropRect } from "../../src/transcode/compose.js";
import type { WireRequest, WireResponse } from "../../src/workers/_protocol/wire.js";
import type { TrackRequestData, TrackResult } from "../../src/workers/tracker-protocol.js";
import { computeTrackerAssets } from "../../vite-plugins/tracker-assets.js";
import type boundaryFixture from "../testdata/tracker-boundary/boundary.json";
import { expect, REPO_ROOT, test } from "./_fixtures.js";

const boundary = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "tests/testdata/tracker-boundary/boundary.json"), "utf8"),
) as typeof boundaryFixture;

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
    await page.route("**/tracker-boundary-harness.html", (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Tracker boundary regression</title>" }),
    );
    await page.goto("/tracker-boundary-harness.html");
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
                        modelUrl: new URL(assets.models.tracker.url, location.origin).href,
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
    await testInfo.attach("tracker-boundary-result", {
        body: JSON.stringify(result, null, 2),
        contentType: "application/json",
    });
    return result;
}

for (const scenario of boundary.scenarios) {
    test(`real Follow preserves identity: ${scenario.id}`, async ({ page }, testInfo) => {
        test.setTimeout(120_000);
        const first = scenario.frames[0]!;
        const result = await runFollow(
            page,
            testInfo,
            "tracker-boundary",
            [{ name: scenario.name, tripStart: 0, durationSec: scenario.durationSec }],
            first.targetRect,
            scenario.durationSec,
        );
        if (scenario.exitSec !== null) {
            expect(["lost", "exited"]).toContain(result.endReason);
            expect(result.trackedUntilSec, "the initial visible movement is followed").toBeGreaterThan(1.4);
            expect(result.trackedUntilSec, "no background observation is accepted after the target exits").toBeLessThan(
                scenario.exitSec,
            );
            expect(result.keyframes.every((frame) => frame.contentSec < scenario.exitSec!)).toBe(true);
            const region = createBlurRegion("front", "fill", 0, scenario.durationSec, 0, first.targetRect);
            region.autoEnd = true;
            applyTrackResult(region, 0, scenario.durationSec, scenario.durationSec, result);
            expect(region.endSec, "automatic cover ends with observed tracking").toBe(result.trackedUntilSec);
            expect(region.lastTrackLost, "early endings remain marked for review").toBe(true);
            expect(regionRectAt(region, scenario.durationSec), "no frozen cover remains after departure").toBeNull();
            for (const keyframe of result.keyframes) {
                const truth = scenario.frames[Math.round(keyframe.contentSec * scenario.fps)]!;
                if (truth.visibleFraction < 0.5 || !truth.visibleRect) continue;
                expect(
                    iou(keyframe.rect, truth.visibleRect),
                    `visible target identity at ${keyframe.contentSec}`,
                ).toBeGreaterThan(0.5);
            }
        } else {
            expect(result.endReason, "being near the edge is not itself a loss").toBe("completed");
            expect(result.trackedUntilSec).toBe(scenario.durationSec);
            const region = createBlurRegion("front", "fill", 0, scenario.durationSec, 0, first.targetRect);
            region.keyframes = result.keyframes.map((keyframe) => ({ ...keyframe, pinned: false }));
            for (const frame of scenario.frames) {
                const mask = regionRectAt(region, frame.contentSec);
                expect(mask, `cover exists at ${frame.contentSec}`).not.toBeNull();
                if (!mask) throw new Error("tracked mask missing");
                expect(iou(mask, frame.targetRect), `edge target overlap at ${frame.contentSec}`).toBeGreaterThan(0.6);
                expect((mask.wPct * mask.hPct) / (frame.targetRect.wPct * frame.targetRect.hPct)).toBeLessThan(1.6);
            }
        }
    });
}

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { type BlurRegion, regionRectAt } from "../../src/blur-regions.js";
import type { CropRect } from "../../src/transcode/compose.js";
import type { WireRequest, WireResponse } from "../../src/workers/_protocol/wire.js";
import type { DetectRequestData, DetectResult } from "../../src/workers/tracker-protocol.js";
import { computeTrackerAssets } from "../../vite-plugins/tracker-assets.js";
import type faceMotionFixture from "../testdata/detector-motion/face-motion.json";
import type motionFixture from "../testdata/detector-motion/motion.json";
import { expect, hasWebGpuAdapter, REPO_ROOT, test } from "./_fixtures.js";

interface MeasuredDetectResult extends DetectResult {
    nativeDecodeCalls?: number;
}

const plateMotion = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "tests/testdata/detector-motion/motion.json"), "utf8"),
) as typeof motionFixture;
const faceMotion = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "tests/testdata/detector-motion/face-motion.json"), "utf8"),
) as typeof faceMotionFixture;
const longPlateMotion = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "tests/testdata/detector-motion/long-motion.json"), "utf8"),
) as typeof motionFixture;
const smallPlateMotion = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "tests/testdata/detector-motion/small-plate-motion.json"), "utf8"),
) as typeof motionFixture;
const crispSmallPlateMotion = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "tests/testdata/detector-motion/small-plate-crisp-motion.json"), "utf8"),
) as typeof motionFixture;
const slowSmallPlateMotion = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "tests/testdata/detector-motion/small-plate-crisp-slow-motion.json"), "utf8"),
) as typeof motionFixture;
const plateCase = {
    label: "every frame of a brief fast-moving plate",
    kind: "plate" as const,
    motion: { ...plateMotion, frames: plateMotion.frames.map((frame) => ({ ...frame, boxes: frame.plates })) },
    maxMaskArea: 2,
    splitSec: null as number | null,
    startSec: 0,
    expectedScans: plateMotion.frames.length,
    quality: "thorough" as const,
    expectedMiss: false,
    singleSeedSec: null as number | null,
    expectedBeforeSeed: 6,
    expectedAfterSeed: 5,
    minimumBackwardUpdates: 0,
    expectsTrackUpdates: true,
    tilesPerScan: 1,
};
const faceCase = {
    label: "every frame of a brief fast-moving face",
    kind: "face" as const,
    motion: { ...faceMotion, frames: faceMotion.frames.map((frame) => ({ ...frame, boxes: frame.faces })) },
    maxMaskArea: 2.5,
    splitSec: null,
    startSec: 0,
    expectedScans: faceMotion.frames.length,
    quality: "thorough" as const,
    expectedMiss: false,
    singleSeedSec: null,
    expectedBeforeSeed: 6,
    expectedAfterSeed: 5,
    minimumBackwardUpdates: 0,
    expectsTrackUpdates: true,
    tilesPerScan: 1,
};
const finalFace = faceCase.motion.frames[17]!;
const heldTailCase = {
    ...faceCase,
    label: "the observed final face throughout a longer audio tail",
    motion: {
        ...faceCase.motion,
        filename: "face-held-tail.mp4",
        durationSec: 0.7,
        frames: [
            ...faceCase.motion.frames.slice(0, 18),
            ...[0.6, 19 / 30, 20 / 30].map((contentSec) => ({ ...finalFace, contentSec })),
        ],
    },
    expectedScans: 18,
};
const longPlateCase = {
    ...plateCase,
    label: "all 12 moving plate frames within 3 seconds of footage",
    motion: {
        ...longPlateMotion,
        frames: longPlateMotion.frames.map((frame) => ({ ...frame, boxes: frame.plates })),
    },
    expectedScans: 90,
};
const cases = [
    plateCase,
    faceCase,
    {
        ...plateCase,
        label: "every moving plate frame across a fractional file boundary",
        splitSec: 0.215,
        expectedScans: plateCase.expectedScans + 1,
    },
    {
        ...plateCase,
        quality: "balanced" as const,
        label: "every moving plate frame across a fractional file boundary",
        splitSec: 0.215,
        expectedScans: 6,
    },
    heldTailCase,
    { ...heldTailCase, quality: "balanced" as const, expectedScans: 4 },
    {
        ...heldTailCase,
        label: "a range wholly inside the held final face frame",
        startSec: 0.62,
        motion: {
            ...heldTailCase.motion,
            durationSec: 0.68,
            // Export resolves held pixels at the original sample timestamp;
            // preview resolves at the playhead. Both need the same cover.
            frames: [finalFace, ...[0.62, 0.65, 0.67].map((contentSec) => ({ ...finalFace, contentSec }))],
        },
        expectedScans: 1,
        expectsTrackUpdates: false,
    },
    longPlateCase,
    { ...longPlateCase, quality: "balanced" as const, expectedScans: 13 },
    { ...faceCase, quality: "balanced" as const, expectedScans: 4 },
    {
        ...faceCase,
        quality: "balanced" as const,
        label: "every face frame with coded rotation restored by display metadata",
        motion: { ...faceCase.motion, filename: "face-motion-rotated.mp4" },
        expectedScans: 4,
    },
    {
        ...longPlateCase,
        quality: "fast" as const,
        label: "all moving plate frames before and after one discovery hit",
        startSec: 0.4,
        expectedScans: 4,
        singleSeedSec: 1.4,
    },
    {
        ...longPlateCase,
        quality: "fast" as const,
        label: "a 48 by 12 pixel plate on both sides of one tiled discovery hit",
        motion: {
            ...crispSmallPlateMotion,
            frames: crispSmallPlateMotion.frames.map((frame) => ({ ...frame, boxes: frame.plates })),
        },
        startSec: 0.4,
        expectedScans: 4,
        singleSeedSec: 1.4,
        // The measured detector seed is 64 by 20 px after coverage padding;
        // keep the absolute allowance small without treating quantization as drift.
        maxMaskArea: 2.5,
        tilesPerScan: 4,
    },
    {
        ...longPlateCase,
        quality: "fast" as const,
        label: "rejects a below-threshold small-plate seed",
        motion: {
            ...smallPlateMotion,
            frames: smallPlateMotion.frames.map((frame) => ({ ...frame, boxes: frame.plates })),
        },
        startSec: 0.4,
        expectedScans: 4,
        expectedMiss: true,
        tilesPerScan: 4,
    },
    {
        ...longPlateCase,
        quality: "fast" as const,
        label: "a small plate while reverse tracking crosses a frame-buffer block boundary",
        motion: {
            ...slowSmallPlateMotion,
            frames: slowSmallPlateMotion.frames.map((frame) => ({ ...frame, boxes: frame.plates })),
        },
        startSec: 0.8,
        expectedScans: 7,
        singleSeedSec: 2.8,
        expectedBeforeSeed: 12,
        expectedAfterSeed: 11,
        // Twelve earlier 1080p frames exceed the eight-frame 64 MiB buffer.
        minimumBackwardUpdates: 8,
        maxMaskArea: 2.5,
        tilesPerScan: 4,
    },
    {
        ...longPlateCase,
        quality: "balanced" as const,
        label: "all 24 small-plate frames across intermediate discovery scans",
        motion: {
            ...slowSmallPlateMotion,
            frames: slowSmallPlateMotion.frames.map((frame) => ({ ...frame, boxes: frame.plates })),
        },
        startSec: 0.3,
        expectedScans: 24,
        // More than eight reverse updates cross both a discovery interval
        // and the bounded 1080p frame buffer; rejected scans must not clip coverage.
        minimumBackwardUpdates: 8,
        maxMaskArea: 2.5,
        tilesPerScan: 4,
    },
    {
        ...longPlateCase,
        quality: "thorough" as const,
        label: "all 24 small-plate frames when additional scans miss or reject the moving target",
        motion: {
            ...slowSmallPlateMotion,
            frames: slowSmallPlateMotion.frames.map((frame) => ({ ...frame, boxes: frame.plates })),
        },
        startSec: 0.3,
        expectedScans: slowSmallPlateMotion.frames.length - Math.round(0.3 * slowSmallPlateMotion.fps),
        maxMaskArea: 2.5,
        tilesPerScan: 4,
    },
    {
        ...longPlateCase,
        quality: "fast" as const,
        label: "reports the missed plate appearing wholly between discovery samples",
        expectedMiss: true,
        expectedScans: 4,
    },
];

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

for (const {
    label,
    kind,
    motion,
    maxMaskArea,
    splitSec,
    startSec,
    expectedScans,
    quality,
    expectedMiss,
    singleSeedSec,
    expectedBeforeSeed,
    expectedAfterSeed,
    minimumBackwardUpdates,
    expectsTrackUpdates,
    tilesPerScan,
} of cases) {
    const usesTracker = !expectedMiss;
    test(
        `${quality} real detector ${expectedMiss ? label : `covers ${label}`} ${usesTracker ? "with bidirectional ViTTrack" : "without loading ViTTrack"}`,
        { tag: "@golden-blur" },
        async ({ page }, testInfo) => {
            test.setTimeout(testInfo.project.metadata.requireWebGpu ? 600_000 : 180_000);
            const workers = readdirSync(resolve(REPO_ROOT, "dist/assets")).filter((name) =>
                /^tracker-worker-.*\.js$/.test(name),
            );
            expect(workers, "one built production tracker worker").toHaveLength(1);
            const measuresReverseDecode = singleSeedSec !== null && minimumBackwardUpdates > 0;
            if (measuresReverseDecode) {
                // Count real decoder submissions, including discarded GOP
                // preroll. Delivered samples alone hide repeated decoding.
                const instrumentation = `
let nativeDecodeCalls = 0;
const originalDecode = VideoDecoder.prototype.decode;
VideoDecoder.prototype.decode = function(...args) {
    nativeDecodeCalls++;
    return originalDecode.apply(this, args);
};
const originalPostMessage = self.postMessage;
self.postMessage = function(message, ...args) {
    if (message?.__k === "res" && message.ok === true) {
        message.result.nativeDecodeCalls = nativeDecodeCalls;
    }
    return originalPostMessage.call(this, message, ...args);
};
`;
                const workerCode = readFileSync(resolve(REPO_ROOT, "dist/assets", workers[0]!), "utf8");
                await page.route(`**/assets/${workers[0]}`, (route) =>
                    route.fulfill({ contentType: "application/javascript", body: instrumentation + workerCode }),
                );
            }
            const assets = computeTrackerAssets("build").app;
            const bytes = Array.from(
                readFileSync(resolve(REPO_ROOT, "tests/testdata/detector-motion", motion.filename)),
            );
            const fetchedModels: string[] = [];
            const plainWasm = assets.ort.wasm.wasm;
            const plainRuntimeUrls = new Set(
                [
                    assets.ort.wasm.moduleUrl,
                    ...("parts" in plainWasm ? plainWasm.parts.map((part) => part.url) : [plainWasm.url]),
                ].map((url) => new URL(url, "http://localhost").pathname),
            );
            const fetchedPlainRuntime: string[] = [];
            page.on("request", (request) => {
                if (request.url().endsWith(".onnx")) fetchedModels.push(request.url());
                if (plainRuntimeUrls.has(new URL(request.url()).pathname)) fetchedPlainRuntime.push(request.url());
            });
            await page.route("**/detector-motion-harness.html", (route) =>
                route.fulfill({
                    contentType: "text/html",
                    body: "<!doctype html><title>Detector motion regression</title>",
                }),
            );
            await page.goto("/detector-motion-harness.html");
            test.skip(!(await hasWebGpuAdapter(page)), "WebGPU adapter unavailable - detection is WebGPU-only");
            const result = await page.evaluate(
                async ({ workerUrl, bytes, assets, filename, durationSec, kind, splitSec, startSec, quality }) => {
                    const worker = new Worker(workerUrl, { type: "module" });
                    try {
                        return await new Promise<MeasuredDetectResult>((resolve, reject) => {
                            worker.onerror = (event) => reject(new Error(event.message));
                            worker.onmessage = (event: MessageEvent<unknown>) => {
                                if (!event.data || typeof event.data !== "object") return;
                                const message = event.data as Partial<WireResponse>;
                                if (message.__k !== "res" || message.id !== 1) return;
                                if (message.ok === true) resolve(message.result as MeasuredDetectResult);
                                else if (message.ok === false)
                                    reject(new Error(message.error?.message ?? "detector response failed"));
                                else reject(new Error("invalid detector response"));
                            };
                            const file = new File([new Uint8Array(bytes)], filename, { type: "video/mp4" });
                            const windows =
                                splitSec === null
                                    ? [[startSec, durationSec]]
                                    : [
                                          [startSec, splitSec],
                                          [splitSec, durationSec],
                                      ];
                            const data: DetectRequestData = {
                                segments: windows.map(([startInFile, endInFile]) => ({
                                    file,
                                    startInFile: startInFile!,
                                    endInFile: endInFile!,
                                    tripStart: 0,
                                })),
                                startContentSec: startSec,
                                endContentSec: durationSec,
                                kinds: [kind],
                                quality,
                                analyzeIntervalsByKind: { [kind]: [{ startSec, endSec: durationSec }] },
                                plateModelUrl: new URL(assets.models.plate, location.origin).href,
                                faceModelUrl: new URL(assets.models.face, location.origin).href,
                                ortAssets: assets.ort.webgpu,
                                trackerModelUrl: new URL(assets.models.tracker, location.origin).href,
                            };
                            worker.postMessage({ __k: "req", id: 1, type: "detect", data } satisfies WireRequest);
                        });
                    } finally {
                        worker.terminate();
                    }
                },
                {
                    workerUrl: `/assets/${workers[0]!}`,
                    bytes,
                    assets,
                    filename: motion.filename,
                    durationSec: motion.durationSec,
                    kind,
                    splitSec,
                    startSec,
                    quality,
                },
            );
            const resultPath = testInfo.outputPath("detector-motion-result.json");
            writeFileSync(resultPath, JSON.stringify(result, null, 2));
            await testInfo.attach("detector-motion-result", {
                path: resultPath,
                contentType: "application/json",
            });
            expect(fetchedModels, "only positive discovery loads the tracker model").toEqual([
                new URL(assets.models[kind], page.url()).href,
                ...(usesTracker ? [new URL(assets.models.tracker, page.url()).href] : []),
            ]);
            expect(fetchedPlainRuntime, "automatic tracking reuses the detector runtime").toEqual([]);
            const stats = result.statsByKind[kind];
            expect(stats, "requested detector reports its work").toBeDefined();
            const recoveryScans = stats!.recoveryScans ?? 0;
            const recoveryTiles = stats!.recoveryTiles ?? 0;
            expect(stats!.scans - recoveryScans, "detector follows the selected discovery policy").toBe(expectedScans);
            expect(stats!.tiles - recoveryTiles, "discovery retains the source-resolution tile grid").toBe(
                expectedScans * tilesPerScan,
            );
            expect(recoveryTiles, "recovery never scans a frame tile twice").toBeLessThanOrEqual(
                recoveryScans * tilesPerScan,
            );
            if (!usesTracker) {
                expect(recoveryScans).toBe(0);
                expect(recoveryTiles).toBe(0);
            }
            if (usesTracker && expectsTrackUpdates) {
                expect(stats!.backwardUpdates, "positive discovery tracks preceding source frames").toBeGreaterThan(
                    minimumBackwardUpdates,
                );
                expect(stats!.trackUpdates, "forward work is additional to backward work").toBeGreaterThan(
                    stats!.backwardUpdates,
                );
                expect(stats!.trackMs, "tracker inference time is measured").toBeGreaterThan(0);
            } else {
                expect(stats!.trackUpdates).toBe(0);
                expect(stats!.backwardUpdates).toBe(0);
                if (!usesTracker) expect(stats!.trackMs).toBe(0);
            }
            const regions: BlurRegion[] = (result.tracksByKind[kind] ?? []).map((track, index) => ({
                id: `${kind}-${index}`,
                channel: "front",
                style: "fill",
                startSec: track.startSec,
                endSec: track.endSec,
                autoEnd: false,
                lastTrackLost: false,
                interpolation: "hold",
                keyframes: track.keyframes.map((keyframe) => ({ ...keyframe, pinned: false })),
            }));
            if (expectedMiss) {
                expect(
                    motion.frames.filter((frame) => frame.boxes.length > 0),
                    "the clip really contains a brief plate",
                ).toHaveLength(12);
                expect(regions, "a clip without an eligible discovery seed produces no tracks").toHaveLength(0);
                return;
            }
            expect(regions.length, "positive fixture produces detected objects").toBeGreaterThan(0);
            if (singleSeedSec !== null) {
                expect(
                    result.decodedFrames,
                    "one discovery seed adds a reverse prefix without decoding the whole clip forward twice",
                ).toBeLessThan(motion.frames.length * 2);
                const visible = motion.frames.filter((frame) => frame.boxes.length > 0);
                expect(visible.filter((frame) => frame.contentSec < singleSeedSec - 1e-6)).toHaveLength(
                    expectedBeforeSeed,
                );
                expect(visible.filter((frame) => frame.contentSec > singleSeedSec + 1e-6)).toHaveLength(
                    expectedAfterSeed,
                );
                expect(
                    (result.tracksByKind[kind] ?? []).reduce((sum, track) => sum + track.detHits, 0),
                    "one real detector observation seeds coverage in both temporal directions",
                ).toBe(1);
            }
            if (measuresReverseDecode) {
                // This GOP-30 fixture needs 180 forward packets. Including the
                // seed in its first reverse block adds 25 + 17, within 64 MiB
                // and eight retained surfaces, without a separate seed seek.
                expect(result.nativeDecodeCalls, "the reverse seed shares its block's GOP preroll").toBeLessThanOrEqual(
                    222,
                );
            }
            for (const [frameIndex, frame] of motion.frames.entries()) {
                const masks = regions.flatMap((region) => {
                    const mask = regionRectAt(region, frame.contentSec);
                    return mask ? [mask] : [];
                });
                if (usesTracker) {
                    const nextFrameSec = motion.frames[frameIndex + 1]?.contentSec ?? motion.durationSec;
                    const straddlesSplit = splitSec !== null && frame.contentSec < splitSec && splitSec < nextFrameSec;
                    if (straddlesSplit && masks.length === 2) {
                        // Independent segments both observe this displayed predecessor.
                        // Only its exactly identical cover may overlap the cut; no
                        // tracker state or identity is carried across the boundary.
                        expect(frame.boxes, "the shared boundary frame has one object").toHaveLength(1);
                        expect(masks[1], "shared boundary frame covers are pixel-identical").toEqual(masks[0]);
                        const active = regions.filter((region) => regionRectAt(region, frame.contentSec) !== null);
                        expect(active.filter((region) => region.endSec === splitSec)).toHaveLength(1);
                        expect(
                            active.filter(
                                (region) => region.startSec === frame.contentSec && region.endSec > splitSec!,
                            ),
                        ).toHaveLength(1);
                    } else {
                        expect(masks, `one mask per visible object at ${frame.contentSec.toFixed(3)}s`).toHaveLength(
                            frame.boxes.length,
                        );
                    }
                }
                for (const box of frame.boxes) {
                    const coverage = Math.max(0, ...masks.map((mask) => coveredFraction(mask, box)));
                    expect(coverage, `${kind} coverage at ${frame.contentSec.toFixed(3)}s`).toBeGreaterThan(0.9);
                    const coveringMasks = masks.filter((mask) => coveredFraction(mask, box) > 0.9);
                    const areaRatio = Math.min(
                        ...coveringMasks.map((mask) => (mask.wPct * mask.hPct) / (box.wPct * box.hPct)),
                    );
                    expect(areaRatio, `mask stays near the ${kind} at ${frame.contentSec.toFixed(3)}s`).toBeLessThan(
                        maxMaskArea,
                    );
                }
                if (frame.boxes.length === 0) {
                    expect(
                        masks,
                        `absent ${kind} leaves no projected mask at ${frame.contentSec.toFixed(3)}s`,
                    ).toHaveLength(0);
                }
            }
        },
    );
}

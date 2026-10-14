import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BlurRegion, regionRectAt } from "../blur-regions.js";
import type { Channel } from "../parsers/types.js";
import { groupTrips, tripAllCandidates, type Trip, type VideoCandidate } from "../trips.js";
import { flushMicrotasks, makePairedEndpoints } from "../workers/_protocol/test-helpers.js";
import { isWireMessage, type WireRequest } from "../workers/_protocol/wire.js";
import {
    DETECT_REQUEST,
    TRACK_NOTIFY_PROGRESS,
    TRACK_NOTIFY_STARTED,
    type DetectRequestData,
    type DetectResult,
} from "../workers/tracker-protocol.js";

const ui = vi.hoisted(() => {
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({}) } });
    return {
        trip: null as Trip | null,
        range: { startTripSec: 0, endTripSec: 3 },
        channels: ["front"] as Channel[],
    };
});

// The real pass/client logic runs against a Worker message boundary. Only the
// app's DOM-facing state and notification imports are severed for Node.
vi.mock("./state.js", () => ({
    activeTrip: () => ui.trip,
    state: {
        exportModeOpen: true,
        composition: {
            get channelOrder() {
                return ui.channels;
            },
        },
    },
}));
vi.mock("./export-state.js", () => ({
    exportPanelState: {
        blurStyle: "blur",
        get range() {
            return ui.range;
        },
    },
    subscribeExportState: () => () => {},
    notifyExportStateChanged: () => {},
}));
vi.mock("./notifications.js", () => ({ notify: () => {} }));

import {
    _resetForTests as resetDetection,
    captureDetectExportRequest,
    detectEnabled,
    detectQuality,
    detectPassState,
    detectRegions,
    detectStyle,
    ensureDetectPass,
    ensureDetectRegionsForExport,
    setDetectEnabled,
    setDetectQuality,
    setDetectStyle,
} from "./blur-detect.js";
import {
    _resetForTests as resetAssets,
    downloadBlurAssets,
    TRACKER_MODEL_URL,
    TRACKER_ORT_ASSETS,
} from "./blur-assets.js";
import { carryBlurRegions } from "./blur-regions-state.js";
import {
    _resetForTests,
    cancelTrackPass,
    cancelTrackPassesExceptTrip,
    toggleTrackPass,
    trackPassOf,
} from "./blur-track.js";
import { trackerWorkerClient } from "./tracker-worker-client.js";

function makeTrip(): Trip {
    const file = new File(["video"], "front.mp4");
    const candidate: VideoCandidate = {
        file,
        relativePath: file.name,
        fingerprint: "generic",
        appliedExtractors: [],
        classifierMatches: { time: null, channel: null, mode: null, sequence: null },
        channel: "front",
        channelConfident: true,
        sequence: null,
        recordingMode: null,
        isTimelapse: false,
        startUtc: 1000,
        durationSec: 4,
        wallDurationSec: null,
        driftLeadSec: null,
        startSource: "mp4",
        cameraTzSec: null,
        createdUtc: null,
        records: [],
        codec: null,
        codecParam: null,
        videoCodecString: null,
        rotation: 0,
        width: null,
        height: null,
        fps: null,
        audio: null,
        canPlay: true,
        needsHevcRemux: false,
        isTransportStream: false,
        isMatroska: false,
        audioNeedsTranscode: false,
        embeddedStartUtcHint: null,
        localClockOffsetHintSec: null,
    };
    return groupTrips([candidate])[0]!;
}

function makeRegion(): BlurRegion {
    return {
        id: "region-1",
        channel: "front",
        style: "blur",
        startSec: 0,
        endSec: 4,
        autoEnd: false,
        lastTrackLost: false,
        keyframes: [{ contentSec: 0, rect: { xPct: 0.2, yPct: 0.2, wPct: 0.1, hPct: 0.1 }, pinned: true }],
    };
}

function makeDetectResult(): DetectResult {
    return {
        tracksByKind: {
            plate: [
                {
                    startSec: 0,
                    endSec: 3,
                    keyframes: [{ contentSec: 0, rect: makeRegion().keyframes[0]!.rect }],
                    detHits: 2,
                    bestScore: 0.9,
                },
            ],
        },
        statsByKind: {},
        sourceFrames: Array.from({ length: 90 }, (_, index) => ({ contentSec: index / 30, durationSec: 1 / 30 })),
        decodedFrames: 90,
        passMs: 100,
    };
}

function regroupTrip(): void {
    const previous = ui.trip!;
    ui.trip = groupTrips(tripAllCandidates(previous))[0]!;
    carryBlurRegions([previous], [ui.trip]);
}

let endpoints: ReturnType<typeof makePairedEndpoints>;
let requests: WireRequest[];

beforeEach(() => {
    _resetForTests();
    resetDetection();
    resetAssets();
    ui.trip = makeTrip();
    ui.range = { startTripSec: 0, endTripSec: 3 };
    ui.channels = ["front"];
    endpoints = makePairedEndpoints();
    requests = [];
    endpoints.workerEndpoint.addEventListener("message", (event) => {
        if (isWireMessage(event.data) && event.data.__k === "req") requests.push(event.data);
    });
    vi.stubGlobal("Worker", function Worker() {
        return endpoints.mainEndpoint;
    });
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({}) } });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    vi.stubGlobal("caches", { match: async () => undefined });
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2, 3])));
});

afterEach(() => {
    resetDetection();
    trackerWorkerClient().dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("blur pass lifecycle", () => {
    it.each([true, false])("applies a lost Follow with automatic timing %s", async (autoEnd) => {
        const region = makeRegion();
        region.autoEnd = autoEnd;
        const pending = toggleTrackPass(ui.trip!, region);
        await flushMicrotasks();
        const rect = { xPct: 0.6, yPct: 0.6, wPct: 0.1, hPct: 0.1 };
        endpoints.workerEndpoint.postMessage({
            __k: "res",
            id: requests[0]!.id,
            ok: true,
            result: { keyframes: [{ contentSec: 1, rect }], trackedUntilSec: 1, endReason: "lost" },
        });

        expect(await pending).toBe("completed");
        expect(region.endSec).toBe(autoEnd ? 1 : 4);
        expect(region.lastTrackLost).toBe(true);
        expect(regionRectAt(region, 3)).toEqual(autoEnd ? null : rect);
        expect(trackPassOf(region.id)).toBeNull();
    });

    it("keeps a running detection pass and fresh results when only tile order changes", async () => {
        const front = tripAllCandidates(ui.trip!)[0]!;
        const rear: VideoCandidate = { ...front, file: new File(["video"], "rear.mp4"), channel: "rear" };
        ui.trip = groupTrips([front, rear])[0]!;
        ui.channels = ["front", "rear"];
        await downloadBlurAssets(["detect-plate"]);
        setDetectEnabled("plate", true);
        const initial = captureDetectExportRequest()!;
        ensureDetectPass();
        await flushMicrotasks();
        const frontRequest = requests[0]!;

        ui.channels = ["rear", "front"];
        const reordered = captureDetectExportRequest()!;
        expect(reordered.params.key).toBe(initial.params.key);
        expect(reordered.params.channels, "new scans still follow the current tile order").toEqual(["rear", "front"]);
        ensureDetectPass();
        await flushMicrotasks();
        expect(requests, "tile reorder does not discard and repeat the active scan").toHaveLength(1);

        endpoints.workerEndpoint.postMessage({ __k: "res", id: frontRequest.id, ok: true, result: makeDetectResult() });
        await flushMicrotasks();
        await flushMicrotasks();
        const rearRequest = requests[1]!;
        expect(rearRequest.data).toMatchObject({ segments: [{ file: rear.file }] });
        endpoints.workerEndpoint.postMessage({ __k: "res", id: rearRequest.id, ok: true, result: makeDetectResult() });
        await flushMicrotasks();
        expect(detectRegions().map((region) => region.channel)).toEqual(["front", "rear"]);

        ui.channels = ["front", "rear"];
        ensureDetectPass();
        await flushMicrotasks();
        expect(requests, "a completed cache stays fresh across tile order changes").toHaveLength(2);
        expect(detectRegions()).toHaveLength(2);
    });

    it("keeps Follow running after the visible trip is rebuilt from unchanged source footage", async () => {
        const region = makeRegion();
        const pending = toggleTrackPass(ui.trip!, region);
        await flushMicrotasks();
        regroupTrip();
        cancelTrackPassesExceptTrip(ui.trip);
        await flushMicrotasks();
        expect(trackPassOf(region.id)).not.toBeNull();
        cancelTrackPass(region.id);
        expect(await pending).toBe("cancelled");
    });

    it("ignores cancelled Follow notifications after the same region restarts", async () => {
        const region = makeRegion();
        const first = toggleTrackPass(ui.trip!, region);
        await flushMicrotasks();
        const firstRequest = requests[0]!;
        cancelTrackPass(region.id);
        expect(await first).toBe("cancelled");

        const second = toggleTrackPass(ui.trip!, region);
        await flushMicrotasks();
        const secondRequest = requests[1]!;
        const firstData = firstRequest.data as { regionId: string; passId: string };
        const secondData = secondRequest.data as { regionId: string; passId: string };
        expect(firstData.passId).not.toBe(secondData.passId);

        vi.useFakeTimers();
        endpoints.workerEndpoint.postMessage({ __k: "ntf", type: TRACK_NOTIFY_STARTED, data: firstData });
        endpoints.workerEndpoint.postMessage({
            __k: "ntf",
            type: TRACK_NOTIFY_PROGRESS,
            data: { ...firstData, fractionDone: 0.9 },
        });
        await flushMicrotasks();
        expect(trackPassOf(region.id), "old progress does not move the new pass").toEqual({ fractionDone: 0 });
        expect(vi.getTimerCount(), "queue wait does not arm the replacement's inactivity cap").toBe(0);

        endpoints.workerEndpoint.postMessage({ __k: "ntf", type: TRACK_NOTIFY_STARTED, data: secondData });
        endpoints.workerEndpoint.postMessage({
            __k: "ntf",
            type: TRACK_NOTIFY_PROGRESS,
            data: { ...secondData, fractionDone: 0.25 },
        });
        await flushMicrotasks();
        expect(trackPassOf(region.id)).toEqual({ fractionDone: 0.25 });
        expect(vi.getTimerCount()).toBe(1);
        cancelTrackPass(region.id);
        expect(await second).toBe("cancelled");
        expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps user cancellation authoritative when it crosses a delivered Follow response", async () => {
        const region = makeRegion();
        const before = structuredClone(region);
        const pending = toggleTrackPass(ui.trip!, region);
        await flushMicrotasks();
        endpoints.workerEndpoint.postMessage({
            __k: "res",
            id: requests[0]!.id,
            ok: true,
            result: {
                keyframes: [{ contentSec: 2, rect: { xPct: 0.6, yPct: 0.6, wPct: 0.1, hPct: 0.1 } }],
                trackedUntilSec: 4,
                endReason: "completed",
            },
        });
        queueMicrotask(() => cancelTrackPass(region.id));
        expect(await pending).toBe("cancelled");
        expect(region).toEqual(before);
    });

    it("does not apply Follow results when the inactivity timeout crosses their delivery", async () => {
        vi.useFakeTimers();
        const region = makeRegion();
        const before = structuredClone(region);
        const pending = toggleTrackPass(ui.trip!, region);
        await flushMicrotasks();
        const request = requests[0]!;
        endpoints.workerEndpoint.postMessage({ __k: "ntf", type: TRACK_NOTIFY_STARTED, data: request.data });
        await flushMicrotasks();
        endpoints.workerEndpoint.postMessage({
            __k: "res",
            id: request.id,
            ok: true,
            result: {
                keyframes: [{ contentSec: 2, rect: { xPct: 0.6, yPct: 0.6, wPct: 0.1, hPct: 0.1 } }],
                trackedUntilSec: 4,
                endReason: "completed",
            },
        });
        queueMicrotask(() => vi.runAllTimers());
        expect(await pending).toBe("failed");
        expect(region).toEqual(before);
    });

    it("restores cached covers after trimming without waiting behind another Follow", async () => {
        await downloadBlurAssets(["detect-plate"]);
        setDetectEnabled("plate", true);
        const initial = ensureDetectRegionsForExport(
            captureDetectExportRequest()!,
            new AbortController().signal,
            () => {},
        );
        await flushMicrotasks();
        const request = requests[0]!;
        const result = makeDetectResult();
        result.tracksByKind.plate![0]!.keyframes.push({
            contentSec: 1,
            rect: { xPct: 0.3, yPct: 0.2, wPct: 0.1, hPct: 0.1 },
        });
        endpoints.workerEndpoint.postMessage({ __k: "res", id: request.id, ok: true, result });
        expect(await initial).toHaveLength(1);

        regroupTrip();
        expect(detectEnabled("plate"), "regroup preserves detection even without manual zones").toBe(true);
        expect(detectRegions()).toHaveLength(1);

        const region = makeRegion();
        const follow = toggleTrackPass(ui.trip!, region);
        await flushMicrotasks();
        ui.range = { startTripSec: 1.01, endTripSec: 2 };
        const trimmed = ensureDetectRegionsForExport(
            captureDetectExportRequest()!,
            new AbortController().signal,
            () => {},
        );
        await flushMicrotasks();
        try {
            expect(requests.filter((entry) => entry.type === DETECT_REQUEST)).toHaveLength(1);
            expect(await trimmed, "a mid-frame trim preserves the first displayed frame's observation").toMatchObject([
                { startSec: 1, endSec: 2 },
            ]);
            expect(detectRegions()).toMatchObject([{ startSec: 1, endSec: 2 }]);
            expect(trackPassOf(region.id), "the unrelated Follow remains active").not.toBeNull();
        } finally {
            cancelTrackPass(region.id);
            expect(await follow).toBe("cancelled");
        }
    });

    it.each([
        {
            label: "a stationary track whose geometry keyframe is much older than the displayed frame",
            startSec: 2.01,
            expectedStartSec: 2,
            sourceFrames: makeDetectResult().sourceFrames,
        },
        {
            label: "a variable-duration source frame",
            startSec: 1.05,
            expectedStartSec: 1.021,
            sourceFrames: [
                { contentSec: 1.002, durationSec: 0.019 },
                { contentSec: 1.021, durationSec: 0.073 },
                { contentSec: 1.094, durationSec: 0.041 },
            ],
        },
        {
            label: "the exact exclusive end of the preceding frame",
            startSec: 1.021,
            expectedStartSec: 1.021,
            sourceFrames: [
                { contentSec: 1.002, durationSec: 0.019 },
                { contentSec: 1.021, durationSec: 0.073 },
            ],
        },
        {
            label: "a source gap with no displayed predecessor covering the trim",
            startSec: 1.5,
            expectedStartSec: 1.5,
            sourceFrames: [
                { contentSec: 0.96, durationSec: 0.04 },
                { contentSec: 2, durationSec: 0.04 },
            ],
        },
        {
            label: "the first frame of a later source segment",
            startSec: 1.02,
            expectedStartSec: 1.007,
            sourceFrames: [
                { contentSec: 0.967, durationSec: 0.04 },
                { contentSec: 1.007, durationSec: 0.041 },
            ],
        },
    ])("limits cached trim support to $label", async ({ startSec, expectedStartSec, sourceFrames }) => {
        await downloadBlurAssets(["detect-plate"]);
        setDetectEnabled("plate", true);
        const initial = ensureDetectRegionsForExport(
            captureDetectExportRequest()!,
            new AbortController().signal,
            () => {},
        );
        await flushMicrotasks();
        const result = makeDetectResult();
        result.sourceFrames = sourceFrames;
        endpoints.workerEndpoint.postMessage({ __k: "res", id: requests[0]!.id, ok: true, result });
        expect(await initial).toHaveLength(1);

        ui.range = { startTripSec: startSec, endTripSec: 2.5 };
        const trimmed = await ensureDetectRegionsForExport(
            captureDetectExportRequest()!,
            new AbortController().signal,
            () => {},
        );
        expect(requests, "a contained trim reuses the completed pass").toHaveLength(1);
        expect(trimmed).toMatchObject([{ startSec: expectedStartSec, endSec: 2.5 }]);
        expect(trimmed[0]!.keyframes[0]!.contentSec, "geometry remains available to the hold resolver").toBe(0);
        expect(regionRectAt(trimmed[0]!, expectedStartSec)).toEqual(makeRegion().keyframes[0]!.rect);
        expect(
            regionRectAt(trimmed[0]!, expectedStartSec - 0.0001),
            "support never extends to an earlier frame",
        ).toBeNull();
    });

    it("retains the observed final-frame mask when a cached trim lies entirely in its held tail", async () => {
        await downloadBlurAssets(["detect-plate"]);
        setDetectEnabled("plate", true);
        ui.range = { startTripSec: 0, endTripSec: 0.7 };
        const initial = ensureDetectRegionsForExport(
            captureDetectExportRequest()!,
            new AbortController().signal,
            () => {},
        );
        await flushMicrotasks();
        const result = makeDetectResult();
        const track = result.tracksByKind.plate![0]!;
        track.startSec = 0.2;
        track.endSec = 0.7;
        const heldTimestamp = 17 / 30;
        result.sourceFrames = [
            { contentSec: 0.2, durationSec: heldTimestamp - 0.2 },
            { contentSec: heldTimestamp, durationSec: 0.7 - heldTimestamp },
        ];
        const rect = makeRegion().keyframes[0]!.rect;
        track.keyframes = [
            { contentSec: 0.2, rect },
            { contentSec: heldTimestamp, rect },
            { contentSec: 0.7, rect },
        ];
        endpoints.workerEndpoint.postMessage({ __k: "res", id: requests[0]!.id, ok: true, result });
        expect(await initial).toHaveLength(1);

        ui.range = { startTripSec: 0.62, endTripSec: 0.68 };
        const trimmed = await ensureDetectRegionsForExport(
            captureDetectExportRequest()!,
            new AbortController().signal,
            () => {},
        );
        expect(requests, "the completed analysis already includes the displayed held tail").toHaveLength(1);
        expect(trimmed).toMatchObject([{ startSec: heldTimestamp, endSec: 0.68 }]);
        expect(
            regionRectAt(trimmed[0]!, heldTimestamp),
            "export resolves held pixels at their source timestamp",
        ).toEqual(rect);
        expect(regionRectAt(trimmed[0]!, 0.65)).toEqual(rect);
    });

    it.each([
        { edge: "start", startTripSec: 1 - 1 / 30, endTripSec: 3 },
        { edge: "end", startTripSec: 1, endTripSec: 3 + 1 / 30 },
    ])(
        "reanalyzes the complete source window after a one-frame $edge extension",
        async ({ startTripSec, endTripSec }) => {
            await downloadBlurAssets(["detect-plate"]);
            setDetectEnabled("plate", true);
            ui.range = { startTripSec: 1, endTripSec: 3 };
            const initial = ensureDetectRegionsForExport(
                captureDetectExportRequest()!,
                new AbortController().signal,
                () => {},
            );
            await flushMicrotasks();
            endpoints.workerEndpoint.postMessage({
                __k: "res",
                id: requests[0]!.id,
                ok: true,
                result: makeDetectResult(),
            });
            expect(await initial).toHaveLength(1);

            ui.range = { startTripSec, endTripSec };
            const expanded = ensureDetectRegionsForExport(
                captureDetectExportRequest()!,
                new AbortController().signal,
                () => {},
            );
            await flushMicrotasks();
            expect(requests, "every newly included frame receives inference").toHaveLength(2);
            const request = requests[1]!;
            expect(request.data).toMatchObject({
                analyzeIntervalsByKind: { plate: [{ startSec: startTripSec, endSec: endTripSec }] },
                trackerModelUrl: TRACKER_MODEL_URL,
                ortAssets: TRACKER_ORT_ASSETS.webgpu,
            });
            expect(request.data).not.toHaveProperty("trackerOrtAssets");
            const replacement = makeDetectResult();
            replacement.tracksByKind.plate![0]!.startSec = startTripSec;
            replacement.tracksByKind.plate![0]!.endSec = endTripSec;
            endpoints.workerEndpoint.postMessage({ __k: "res", id: request.id, ok: true, result: replacement });
            expect(await expanded, "the complete analysis replaces old tracks without duplicate covers").toMatchObject([
                { startSec: startTripSec, endSec: endTripSec, interpolation: "hold" },
            ]);
            expect(detectRegions()).toHaveLength(1);
        },
    );

    it.each([
        { edge: "start", startTripSec: 0.5, endTripSec: 11, changed: [0] },
        { edge: "end", startTripSec: 1, endTripSec: 11.5, changed: [2] },
        { edge: "both", startTripSec: 0.5, endTripSec: 11.5, changed: [0, 2] },
    ])("keeps complete interior files cached when extending $edge", async ({ startTripSec, endTripSec, changed }) => {
        const base = tripAllCandidates(ui.trip!)[0]!;
        const candidates = Array.from({ length: 3 }, (_, index) => ({
            ...base,
            file: new File(["video"], `front-${index}.mp4`),
            startUtc: base.startUtc + index * 4,
        }));
        ui.trip = groupTrips(candidates)[0]!;
        ui.range = { startTripSec: 1, endTripSec: 11 };
        await downloadBlurAssets(["detect-plate"]);
        setDetectEnabled("plate", true);
        const reply = async (request: WireRequest) => {
            const data = request.data as DetectRequestData;
            expect(data.segments, "each cached result has a single source owner").toHaveLength(1);
            const start = data.startContentSec;
            const end = data.endContentSec;
            const result = makeDetectResult();
            result.tracksByKind.plate![0]!.startSec = start;
            result.tracksByKind.plate![0]!.endSec = end;
            result.tracksByKind.plate![0]!.keyframes[0]!.contentSec = start;
            result.sourceFrames = [{ contentSec: start, durationSec: end - start }];
            endpoints.workerEndpoint.postMessage({ __k: "res", id: request.id, ok: true, result });
            await flushMicrotasks();
        };
        const initial = ensureDetectRegionsForExport(
            captureDetectExportRequest()!,
            new AbortController().signal,
            () => {},
        );
        await flushMicrotasks();
        for (let index = 0; index < 3; index++) {
            expect(requests).toHaveLength(index + 1);
            await reply(requests[index]!);
        }
        const original = await initial;
        expect(original).toHaveLength(3);

        ui.range = { startTripSec, endTripSec };
        const extended = ensureDetectRegionsForExport(
            captureDetectExportRequest()!,
            new AbortController().signal,
            () => {},
        );
        await flushMicrotasks();
        for (const [index, fileIndex] of changed.entries()) {
            expect(requests, "only changed boundary windows need a new pass").toHaveLength(4 + index);
            const request = requests[3 + index]!;
            const start = fileIndex === 0 ? startTripSec : 8;
            const end = fileIndex === 2 ? endTripSec : 4;
            expect(request.data).toMatchObject({
                segments: [{ file: candidates[fileIndex]!.file }],
                startContentSec: start,
                endContentSec: end,
                analyzeIntervalsByKind: { plate: [{ startSec: start, endSec: end }] },
            });
            await reply(request);
        }
        const result = await extended;
        expect(requests).toHaveLength(3 + changed.length);
        expect(result).toHaveLength(3);
        expect(result[1], "the unchanged middle file retains its exact cached mask").toMatchObject({
            startSec: original[1]!.startSec,
            endSec: original[1]!.endSec,
            keyframes: original[1]!.keyframes,
        });
    });

    it("copies only held geometry needed by a cached short trim", async () => {
        await downloadBlurAssets(["detect-plate"]);
        setDetectEnabled("plate", true);
        const initial = ensureDetectRegionsForExport(
            captureDetectExportRequest()!,
            new AbortController().signal,
            () => {},
        );
        await flushMicrotasks();
        const result = makeDetectResult();
        result.tracksByKind.plate![0]!.keyframes = result.sourceFrames.map((frame, index) => ({
            contentSec: frame.contentSec,
            rect: { ...makeRegion().keyframes[0]!.rect, xPct: index / 100 },
        }));
        endpoints.workerEndpoint.postMessage({ __k: "res", id: requests[0]!.id, ok: true, result });
        const [original] = await initial;
        ui.range = { startTripSec: 1.01, endTripSec: 1.07 };
        const [trimmed] = await ensureDetectRegionsForExport(
            captureDetectExportRequest()!,
            new AbortController().signal,
            () => {},
        );
        expect(requests).toHaveLength(1);
        expect(trimmed!.keyframes).toHaveLength(3);
        expect(original!.keyframes, "the cached/exported original remains detached").toHaveLength(90);
        for (const sec of [1, 31 / 30, 32 / 30]) {
            expect(regionRectAt(trimmed!, sec)).toEqual(regionRectAt(original!, sec));
        }
    });

    it("preserves a running pass when a slider drag returns to its quality before the debounce", async () => {
        vi.useFakeTimers();
        await downloadBlurAssets(["detect-plate"]);
        setDetectEnabled("plate", true);
        ensureDetectPass();
        await flushMicrotasks();
        expect(requests).toHaveLength(1);

        setDetectQuality("fast");
        setDetectQuality("balanced");
        await vi.advanceTimersByTimeAsync(1500);
        expect(requests, "the matching pass keeps its accumulated work").toHaveLength(1);
        expect(detectPassState()).not.toBeNull();
        endpoints.workerEndpoint.postMessage({ __k: "res", id: requests[0]!.id, ok: true, result: makeDetectResult() });
        await flushMicrotasks();
        expect(detectRegions()).toHaveLength(1);
    });

    it("keeps Save-time quality immutable and reanalyzes cached frames after a quality change", async () => {
        await downloadBlurAssets(["detect-plate"]);
        expect(detectQuality()).toBe("balanced");
        setDetectQuality("fast");
        setDetectEnabled("plate", true);
        const captured = captureDetectExportRequest()!;
        const initial = ensureDetectRegionsForExport(captured, new AbortController().signal, () => {});
        await flushMicrotasks();
        expect(requests[0]!.data).toMatchObject({ quality: "fast" });

        setDetectQuality("thorough");
        expect(captured.params.quality, "an active export keeps its captured choice").toBe("fast");
        endpoints.workerEndpoint.postMessage({
            __k: "res",
            id: requests[0]!.id,
            ok: true,
            result: makeDetectResult(),
        });
        expect(await initial, "changing the live slider does not cancel the saved export").toHaveLength(1);
        expect(detectRegions(), "a fast result is stale for the new thorough choice").toHaveLength(0);

        const updated = ensureDetectRegionsForExport(
            captureDetectExportRequest()!,
            new AbortController().signal,
            () => {},
        );
        await flushMicrotasks();
        expect(requests).toHaveLength(2);
        expect(requests[1]!.data, "a different quality cannot reuse the old interval cache").toMatchObject({
            quality: "thorough",
            analyzeIntervalsByKind: { plate: [{ startSec: 0, endSec: 3 }] },
        });
        endpoints.workerEndpoint.postMessage({
            __k: "res",
            id: requests[1]!.id,
            ok: true,
            result: makeDetectResult(),
        });
        expect(await updated).toHaveLength(1);
        expect(detectRegions()).toHaveLength(1);
        regroupTrip();
        expect(detectQuality(), "trip regrouping preserves the chosen quality").toBe("thorough");
    });

    it("keeps independent analyses when returning to previously completed qualities", async () => {
        await downloadBlurAssets(["detect-plate"]);
        setDetectEnabled("plate", true);
        const qualities = ["fast", "balanced", "thorough"] as const;
        const expectedRects = qualities.map((_, index) => ({
            ...makeRegion().keyframes[0]!.rect,
            xPct: 0.1 + index * 0.2,
        }));
        for (const [index, quality] of qualities.entries()) {
            setDetectQuality(quality);
            const pending = ensureDetectRegionsForExport(
                captureDetectExportRequest()!,
                new AbortController().signal,
                () => {},
            );
            await flushMicrotasks();
            expect(requests).toHaveLength(index + 1);
            const result = makeDetectResult();
            result.tracksByKind.plate![0]!.keyframes[0]!.rect = expectedRects[index]!;
            endpoints.workerEndpoint.postMessage({ __k: "res", id: requests[index]!.id, ok: true, result });
            expect((await pending)[0]!.keyframes[0]!.rect).toEqual(expectedRects[index]);
        }
        for (const quality of ["balanced", "fast", "thorough"] as const) {
            setDetectQuality(quality);
            const regions = await ensureDetectRegionsForExport(
                captureDetectExportRequest()!,
                new AbortController().signal,
                () => {},
            );
            expect(requests, "a quality round trip does not repeat inference").toHaveLength(3);
            expect(regions[0]!.keyframes[0]!.rect, "the exact quality retains its own geometry").toEqual(
                expectedRects[qualities.indexOf(quality)],
            );
        }

        // A larger range replaces only that quality; returning to the old
        // range still restores the other completed analyses without inference.
        ui.range = { startTripSec: 0, endTripSec: 4 };
        const expanded = ensureDetectRegionsForExport(
            captureDetectExportRequest()!,
            new AbortController().signal,
            () => {},
        );
        await flushMicrotasks();
        expect(requests).toHaveLength(4);
        const result = makeDetectResult();
        result.tracksByKind.plate![0]!.endSec = 4;
        result.tracksByKind.plate![0]!.keyframes[0]!.rect = { ...expectedRects[2]!, xPct: 0.7 };
        endpoints.workerEndpoint.postMessage({ __k: "res", id: requests[3]!.id, ok: true, result });
        expect((await expanded)[0]!.keyframes[0]!.rect.xPct).toBeCloseTo(0.7);
        ui.range = { startTripSec: 0, endTripSec: 3 };
        for (const quality of ["fast", "thorough"] as const) {
            setDetectQuality(quality);
            const regions = await ensureDetectRegionsForExport(
                captureDetectExportRequest()!,
                new AbortController().signal,
                () => {},
            );
            expect(requests).toHaveLength(4);
            expect(regions[0]!.keyframes[0]!.rect.xPct).toBeCloseTo(quality === "fast" ? 0.1 : 0.7);
        }
    });

    it("retains cached plates while analyzing newly enabled faces", async () => {
        await downloadBlurAssets(["detect-plate", "detect-face"]);
        setDetectEnabled("plate", true);
        const initial = ensureDetectRegionsForExport(
            captureDetectExportRequest()!,
            new AbortController().signal,
            () => {},
        );
        await flushMicrotasks();
        endpoints.workerEndpoint.postMessage({
            __k: "res",
            id: requests[0]!.id,
            ok: true,
            result: makeDetectResult(),
        });
        expect(await initial).toHaveLength(1);

        setDetectEnabled("face", true);
        const combined = ensureDetectRegionsForExport(
            captureDetectExportRequest()!,
            new AbortController().signal,
            () => {},
        );
        await flushMicrotasks();
        const request = requests[1]!;
        expect(request.data).toMatchObject({
            analyzeIntervalsByKind: { plate: [], face: [{ startSec: 0, endSec: 3 }] },
        });
        const faceResult = makeDetectResult();
        faceResult.tracksByKind = { face: faceResult.tracksByKind.plate };
        endpoints.workerEndpoint.postMessage({ __k: "res", id: request.id, ok: true, result: faceResult });
        expect((await combined).map((region) => region.id)).toEqual([
            expect.stringMatching(/^auto-plate-/),
            expect.stringMatching(/^auto-face-/),
        ]);
    });

    it("retains an in-flight scan when regrouping preserves its source mapping", async () => {
        await downloadBlurAssets(["detect-plate"]);
        setDetectEnabled("plate", true);
        ensureDetectPass();
        await flushMicrotasks();
        const request = requests[0]!;

        regroupTrip();
        expect(detectPassState(), "the rebuilt trip still owns the running scan").not.toBeNull();
        endpoints.workerEndpoint.postMessage({ __k: "res", id: request.id, ok: true, result: makeDetectResult() });
        await flushMicrotasks();
        expect(detectEnabled("plate")).toBe(true);
        expect(detectRegions()).toHaveLength(1);
    });

    it("drops an in-flight scan when a mutable candidate changes the source mapping", async () => {
        await downloadBlurAssets(["detect-plate"]);
        setDetectEnabled("plate", true);
        ensureDetectPass();
        await flushMicrotasks();
        const request = requests[0]!;
        tripAllCandidates(ui.trip!)[0]!.rotation = 180;

        regroupTrip();
        endpoints.workerEndpoint.postMessage({ __k: "res", id: request.id, ok: true, result: makeDetectResult() });
        await flushMicrotasks();
        expect(detectPassState()).toBeNull();
        expect(detectEnabled("plate"), "source corrections preserve the user's privacy choice").toBe(true);
        expect(detectRegions(), "old pixel coordinates never appear on the changed source").toEqual([]);
        ensureDetectPass();
        await flushMicrotasks();
        const replacement = requests[1]!;
        expect(replacement.data).toMatchObject({ analyzeIntervalsByKind: { plate: [{ startSec: 0, endSec: 3 }] } });
        endpoints.workerEndpoint.postMessage({ __k: "res", id: replacement.id, ok: true, result: makeDetectResult() });
        await flushMicrotasks();
        expect(detectRegions()).toHaveLength(1);
    });

    it("keeps old export results out of a source mapping corrected on the same Trip object", async () => {
        await downloadBlurAssets(["detect-plate"]);
        setDetectEnabled("plate", true);
        const pending = ensureDetectRegionsForExport(
            captureDetectExportRequest()!,
            new AbortController().signal,
            () => {},
        );
        await flushMicrotasks();
        const request = requests[0]!;
        tripAllCandidates(ui.trip!)[0]!.rotation = 180;
        carryBlurRegions([ui.trip!], [ui.trip!]);

        endpoints.workerEndpoint.postMessage({ __k: "res", id: request.id, ok: true, result: makeDetectResult() });
        expect(await pending, "the captured export still receives its own results").toHaveLength(1);
        expect(detectEnabled("plate")).toBe(true);
        expect(detectRegions(), "the old export cannot replace the corrected trip's empty cache").toEqual([]);

        ensureDetectPass();
        await flushMicrotasks();
        const replacement = requests[1]!;
        expect(replacement.data).toMatchObject({ analyzeIntervalsByKind: { plate: [{ startSec: 0, endSec: 3 }] } });
        endpoints.workerEndpoint.postMessage({ __k: "res", id: replacement.id, ok: true, result: makeDetectResult() });
        await flushMicrotasks();
        expect(detectRegions()).toHaveLength(1);
    });

    it("preserves detection choices and rescans when channel reassignment changes the first file", async () => {
        const front = tripAllCandidates(ui.trip!)[0]!;
        const rear: VideoCandidate = { ...front, file: new File(["video"], "rear.mp4"), channel: "rear" };
        ui.trip = groupTrips([front, rear])[0]!;
        await downloadBlurAssets(["detect-plate"]);
        setDetectEnabled("plate", true);
        setDetectStyle("fill");
        ensureDetectPass();
        await flushMicrotasks();
        const request = requests[0]!;
        endpoints.workerEndpoint.postMessage({ __k: "res", id: request.id, ok: true, result: makeDetectResult() });
        await flushMicrotasks();
        expect(detectRegions()).toHaveLength(1);

        const previous = ui.trip!;
        expect(tripAllCandidates(previous)[0]!.file).toBe(front.file);
        front.channel = "rear";
        rear.channel = "front";
        regroupTrip();
        expect(tripAllCandidates(ui.trip!)[0]!.file, "the file set survives in a different order").toBe(rear.file);
        expect(detectEnabled("plate")).toBe(true);
        expect(detectStyle()).toBe("fill");
        expect(detectRegions(), "channel reassignment invalidates the cached rectangles").toEqual([]);

        ensureDetectPass();
        await flushMicrotasks();
        const replacement = requests[1]!;
        expect(replacement.data).toMatchObject({
            segments: [{ file: rear.file }],
            analyzeIntervalsByKind: { plate: [{ startSec: 0, endSec: 3 }] },
        });
        endpoints.workerEndpoint.postMessage({ __k: "res", id: replacement.id, ok: true, result: makeDetectResult() });
        await flushMicrotasks();
        expect(detectRegions()).toMatchObject([{ channel: "front", style: "fill" }]);
    });

    it.each([false, true])(
        "keeps every channel's file windows across clock corrections (export: %s)",
        async (forExport) => {
            const front = tripAllCandidates(ui.trip!)[0]!;
            const rear: VideoCandidate = { ...front, file: new File(["video"], "rear.mp4"), channel: "rear" };
            ui.trip = groupTrips([front, rear])[0]!;
            ui.channels = ["front", "rear"];
            await downloadBlurAssets(["detect-plate"]);
            setDetectEnabled("plate", true);
            const exported = forExport
                ? ensureDetectRegionsForExport(captureDetectExportRequest()!, new AbortController().signal, () => {})
                : null;
            if (!forExport) ensureDetectPass();
            await flushMicrotasks();
            const first = requests[0]!;

            front.startUtc += 3600;
            rear.startUtc += 3600;
            regroupTrip();
            endpoints.workerEndpoint.postMessage({ __k: "res", id: first.id, ok: true, result: makeDetectResult() });
            await flushMicrotasks();
            await flushMicrotasks();
            expect(requests, "the rear channel is still analyzed after the first channel finishes").toHaveLength(2);
            const second = requests[1]!;
            expect(second.data).toMatchObject({
                segments: [{ file: rear.file, startInFile: 0, endInFile: 3, tripStart: 0 }],
            });
            endpoints.workerEndpoint.postMessage({ __k: "res", id: second.id, ok: true, result: makeDetectResult() });
            await flushMicrotasks();
            expect(detectRegions().map((region) => region.channel)).toEqual(["front", "rear"]);
            if (exported) expect((await exported).map((region) => region.channel)).toEqual(["front", "rear"]);
        },
    );

    it("fails export when the captured source changes while model assets warm", async () => {
        setDetectEnabled("plate", true);
        const request = captureDetectExportRequest()!;
        let release!: (response: Response) => void;
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockImplementationOnce(
                    () =>
                        new Promise<Response>((resolve) => {
                            release = resolve;
                        }),
                )
                .mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]))),
        );
        const pending = ensureDetectRegionsForExport(request, new AbortController().signal, () => {});
        const rejected = expect(pending).rejects.toThrow("detect source changed after export started");
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
        tripAllCandidates(ui.trip!)[0]!.startUtc += 3600;
        regroupTrip();
        release(new Response(new Uint8Array([1, 2, 3])));
        await rejected;
        expect(requests, "the changed source cannot produce a falsely empty privacy result").toHaveLength(0);
    });

    it("gives sub-centisecond trim edits distinct detection contracts", () => {
        setDetectEnabled("plate", true);
        const original = captureDetectExportRequest()!;
        ui.range = { startTripSec: 0.001, endTripSec: 3.001 };
        const changed = captureDetectExportRequest()!;
        expect(changed.params.key).not.toBe(original.params.key);
        expect(original.params.startSec).toBe(0);
        expect(original.params.endSec).toBe(3);
        expect(changed.params.startSec).toBe(0.001);
    });
});

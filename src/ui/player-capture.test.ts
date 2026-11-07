import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeCameraLayout, VIEWER_MIN_THUMB_HEIGHT_PX, VIEWER_TILE_GAP_PX } from "../camera-layout.js";

type FakeVideo = EventTarget & {
    readyState: number;
    videoWidth: number;
    videoHeight: number;
    currentTime: number;
    paused: boolean;
    seeking: boolean;
    src: string;
    requestVideoFrameCallback: undefined | ((callback: VideoFrameRequestCallback) => number);
    cancelVideoFrameCallback: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => {
    const makeVideo = (width: number, height: number, src: string): FakeVideo =>
        Object.assign(new EventTarget(), {
            readyState: 2,
            videoWidth: width,
            videoHeight: height,
            currentTime: 1,
            paused: true,
            seeking: false,
            src,
            requestVideoFrameCallback: undefined as undefined | ((callback: VideoFrameRequestCallback) => number),
            cancelVideoFrameCallback: vi.fn(),
        });
    return {
        activeEffectiveBlurRegions: vi.fn(),
        previewExportStartSec: vi.fn(),
        resolveRegionBlursAt: vi.fn(),
        drawCameraComposition: vi.fn(),
        drawTelemetryOverlays: vi.fn(),
        drawWatermark: vi.fn(),
        drawMapPlaceholder: vi.fn(),
        drawMapOverlay: vi.fn(),
        planCompositionSpans: vi.fn(),
        buildOverlayPipelineArgs: vi.fn(),
        watermarkAnchorForExport: vi.fn(),
        downloadBlob: vi.fn(),
        notify: vi.fn(),
        viewerCameraLayout: vi.fn(),
        zoomedCameraView: vi.fn(),
        makeVideo,
        players: { front: makeVideo(100, 60, "blob:front"), rear: makeVideo(50, 30, "blob:rear") } as Record<
            string,
            FakeVideo
        >,
        visible: ["front"] as string[],
        state: { exportModeOpen: true, channelBackends: {}, composition: { crops: {} }, active: {} },
        trip: { cameraTzSec: null, timeline: { contentDurationSec: 60 } } as object | null,
    };
});

vi.mock("../blur-regions.js", () => ({ resolveRegionBlursAt: mocks.resolveRegionBlursAt }));
vi.mock("../download.js", () => ({ downloadBlob: mocks.downloadBlob }));
vi.mock("../i18n/index.js", () => ({ t: (key: string) => key }));
vi.mock("../log.js", () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// Canvas drawing and the export's frame plan are exercised by their own
// tests; here they only record what the capture asked for.
vi.mock("../transcode/camera-composition.js", () => ({ planCompositionSpans: mocks.planCompositionSpans }));
vi.mock("../transcode/compose.js", () => ({
    createBlurHelper: () => ({}),
    createRegionBlurHelper: () => ({}),
    drawCameraComposition: mocks.drawCameraComposition,
}));
vi.mock("../transcode/map-overlay.js", () => ({
    drawMapOverlay: mocks.drawMapOverlay,
    drawMapPlaceholder: mocks.drawMapPlaceholder,
}));
vi.mock("../transcode/overlay-pipeline-helpers.js", () => ({
    createOverlayFrameResolver: () => () => ({ hasFix: false }),
    hasAnyOverlay: () => true,
}));
vi.mock("../transcode/overlay-styles.js", () => ({ ensureOverlayFontsReady: () => Promise.resolve() }));
vi.mock("../transcode/telemetry-overlays.js", () => ({ drawTelemetryOverlays: mocks.drawTelemetryOverlays }));
vi.mock("../transcode/watermark.js", () => ({
    drawWatermark: mocks.drawWatermark,
    ensureWatermarkFontReady: () => Promise.resolve(),
}));
vi.mock("../trips.js", () => ({ displayClockDate: (sec: number) => new Date(sec * 1000) }));
vi.mock("./blur-effective.js", () => ({
    activeEffectiveBlurRegions: mocks.activeEffectiveBlurRegions,
    previewExportStartSec: mocks.previewExportStartSec,
}));
vi.mock("./camera-aspect.js", () => ({ cameraExportAspect: () => 16 / 9 }));
vi.mock("./camera-flip-pref.js", () => ({
    cameraFlipForChannel: () => ({ horizontal: false, vertical: false }),
}));
vi.mock("./dom.js", () => ({
    channelPlayers: mocks.players,
    effectiveMasterChannel: () => "front",
    dom: { playerBar: { capture: {} } },
}));
vi.mock("./export-flow.js", () => ({
    buildOverlayPipelineArgs: mocks.buildOverlayPipelineArgs,
    resolveOutputDims: () => ({ width: 1280, height: 720 }),
    watermarkAnchorForExport: mocks.watermarkAnchorForExport,
}));
vi.mock("./export-state.js", () => ({ exportPanelState: { letterboxFill: "black", range: null } }));
vi.mock("./notifications.js", () => ({ notify: mocks.notify }));
vi.mock("./player-overlays.js", () => ({ previewMapCanvas: () => null }));
vi.mock("./player-layout.js", () => ({ viewerCameraLayout: mocks.viewerCameraLayout }));
vi.mock("./player-video-src.js", () => ({ videoAttachedFile: new Map() }));
vi.mock("./player-zoom.js", () => ({
    isCameraOnGrid: () => true,
    zoomedCameraView: mocks.zoomedCameraView,
}));
vi.mock("./state.js", () => ({
    activeCandidate: () => null,
    activeTrip: () => mocks.trip,
    state: mocks.state,
    visibleChannels: () => mocks.visible,
}));

import { type CaptureClock, captureStill } from "./player-capture.js";

const VIEW = { kind: "view" } as const;

function clock(tripSec: number, frameSec: CaptureClock["getFrameContentSec"]): CaptureClock {
    return { getTripStartUtcSec: () => 0, getTripCurrentSec: () => tripSec, getFrameContentSec: frameSec };
}

function stubCaptureCanvas(): { canvas: { width: number; height: number }; toBlobType: () => string | undefined } {
    let lastType: string | undefined;
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({}),
        toBlob: (callback: (blob: Blob) => void, type?: string) => {
            lastType = type;
            callback(new Blob(["image"], { type }));
        },
    };
    vi.stubGlobal("document", {
        createElement: (tag: string) => {
            expect(tag).toBe("canvas");
            return canvas;
        },
    });
    return { canvas, toBlobType: () => lastType };
}

function acknowledgeFrame(video: FakeVideo, before?: () => void): void {
    video.requestVideoFrameCallback = (callback) => {
        queueMicrotask(() => {
            before?.();
            callback(0, {
                mediaTime: 1.25,
                expectedDisplayTime: 0,
                presentationTime: 0,
                presentedFrames: 1,
                width: 100,
                height: 60,
                processingDuration: 0,
            });
        });
        return 1;
    };
}

/** Cameras the last composition drew, keyed by channel. */
function drawnCameras(): Record<string, { sample: unknown; crop: unknown; regionBlurs: unknown }> {
    return mocks.drawCameraComposition.mock.lastCall![2];
}

function resetVideo(video: FakeVideo, src: string): void {
    video.readyState = 2;
    video.paused = true;
    video.currentTime = 1;
    video.seeking = false;
    video.src = src;
    video.requestVideoFrameCallback = undefined;
}

beforeEach(() => {
    vi.clearAllMocks();
    resetVideo(mocks.players.front!, "blob:front");
    resetVideo(mocks.players.rear!, "blob:rear");
    mocks.visible = ["front"];
    mocks.state.exportModeOpen = true;
    mocks.trip = { cameraTzSec: null, timeline: { contentDurationSec: 60 } };
    mocks.previewExportStartSec.mockReturnValue(-Infinity);
    mocks.activeEffectiveBlurRegions.mockReturnValue([]);
    mocks.resolveRegionBlursAt.mockReturnValue([]);
    mocks.buildOverlayPipelineArgs.mockReturnValue(null);
    mocks.watermarkAnchorForExport.mockReturnValue(null);
    mocks.zoomedCameraView.mockReturnValue(null);
    mocks.planCompositionSpans.mockImplementation(({ channels, width, height }) => [
        {
            tiles: channels.map((channel: string) => ({
                channel,
                role: "equal",
                overlay: false,
                x: 0,
                y: 0,
                w: width,
                h: height,
            })),
            presence: Object.fromEntries(channels.map((channel: string) => [channel, "recording"])),
            backdrop: channels[0],
        },
    ]);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("captureStill privacy blur", () => {
    it("burns the full effective manual + detected region set into a JPG", async () => {
        const effective = [{ id: "manual" }, { id: "auto-detected" }];
        const resolved = [{ style: "fill" }];
        mocks.activeEffectiveBlurRegions.mockReturnValue(effective);
        mocks.resolveRegionBlursAt.mockReturnValue(resolved);
        const { toBlobType } = stubCaptureCanvas();

        await captureStill(
            VIEW,
            "download",
            clock(1, () => 3),
        );

        expect(mocks.resolveRegionBlursAt).toHaveBeenCalledWith(effective, "front", 3, -Infinity);
        expect(drawnCameras().front!.regionBlurs).toBe(resolved);
        expect(toBlobType()).toBe("image/jpeg");
        expect(mocks.downloadBlob).toHaveBeenCalledOnce();
        expect(mocks.downloadBlob).toHaveBeenCalledWith(
            expect.any(Blob),
            expect.stringMatching(/^everydashcam_\d{8}_\d{6}_frame\.jpg$/),
        );
    });

    it("forwards fractional export coverage while keeping the captured source frame's timestamp", async () => {
        const effective = [{ id: "manual" }];
        mocks.activeEffectiveBlurRegions.mockReturnValue(effective);
        mocks.resolveRegionBlursAt.mockReturnValue([{ style: "fill" }]);
        mocks.previewExportStartSec.mockReturnValue(1.0005);
        mocks.players.front!.currentTime = 1.0005;
        stubCaptureCanvas();

        await captureStill(
            VIEW,
            "download",
            clock(1.0005, () => 1),
        );

        expect(mocks.previewExportStartSec).toHaveBeenCalledWith("front", 1);
        expect(mocks.resolveRegionBlursAt).toHaveBeenCalledWith(effective, "front", 1, 1.0005);
        expect(mocks.downloadBlob).toHaveBeenCalledOnce();
    });

    it("blurs every camera of the export frame at its own displayed time", async () => {
        mocks.visible = ["front", "rear"];
        stubCaptureCanvas();

        await captureStill(
            VIEW,
            "download",
            clock(1, (channel) => (channel === "front" ? 3 : 2.5)),
        );

        expect(mocks.resolveRegionBlursAt).toHaveBeenCalledWith([], "front", 3, -Infinity);
        expect(mocks.resolveRegionBlursAt).toHaveBeenCalledWith([], "rear", 2.5, -Infinity);
        expect(mocks.planCompositionSpans).toHaveBeenCalledWith(
            expect.objectContaining({ channels: ["front", "rear"], width: 1280, height: 720, startSec: 3 }),
        );
        expect(Object.keys(drawnCameras())).toEqual(["front", "rear"]);
    });

    it("blurs a single camera's still in export mode too", async () => {
        const resolved = [{ style: "fill" }];
        mocks.resolveRegionBlursAt.mockReturnValue(resolved);
        mocks.visible = ["front", "rear"];
        stubCaptureCanvas();

        await captureStill(
            { kind: "camera", channel: "rear" },
            "download",
            clock(1, () => 2),
        );

        expect(Object.keys(drawnCameras())).toEqual(["rear"]);
        expect(drawnCameras().rear!.regionBlurs).toBe(resolved);
        expect(mocks.downloadBlob).toHaveBeenCalledWith(
            expect.any(Blob),
            expect.stringMatching(/^everydashcam_\d{8}_\d{6}_rear\.jpg$/),
        );
    });

    it("leaves a paused camera with a confirmed frame alone instead of nudging its decoder", async () => {
        stubCaptureCanvas();
        const video = mocks.players.front!;
        const frameCallback = vi.fn(() => 1);
        video.requestVideoFrameCallback = frameCallback;
        let writes = 0;
        let time = 1;
        Object.defineProperty(video, "currentTime", {
            configurable: true,
            get: () => time,
            set: (value: number) => {
                writes++;
                time = value;
            },
        });

        await captureStill(
            VIEW,
            "download",
            clock(1, () => 3),
        );

        // A self-seek there may present no new frame and leave the frame
        // unconfirmed for every later reader.
        expect(writes, "no self-seek").toBe(0);
        expect(frameCallback).not.toHaveBeenCalled();
        expect(mocks.downloadBlob).toHaveBeenCalledOnce();
        Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 1 });
    });

    it("refuses a JPG while the requested seek still displays older pixels", async () => {
        mocks.players.front!.seeking = true;
        await captureStill(
            VIEW,
            "download",
            clock(40, () => null),
        );
        expect(mocks.downloadBlob).not.toHaveBeenCalled();
        expect(mocks.resolveRegionBlursAt).not.toHaveBeenCalled();
    });

    it("refuses an export-mode JPG until its displayed frame has a timestamp", async () => {
        stubCaptureCanvas();
        await captureStill(
            VIEW,
            "download",
            clock(40, () => null),
        );
        expect(mocks.downloadBlob).not.toHaveBeenCalled();
        expect(mocks.resolveRegionBlursAt).not.toHaveBeenCalled();
    });

    it("resolves a captured frame's own PTS instead of a later playhead", async () => {
        stubCaptureCanvas();
        acknowledgeFrame(mocks.players.front!);
        const contentTime = vi.fn((_channel: string, time?: number) => (time === undefined ? null : time + 2));
        await captureStill(VIEW, "download", clock(40, contentTime));
        expect(contentTime).toHaveBeenCalledWith("front", 1.25);
        expect(mocks.resolveRegionBlursAt).toHaveBeenCalledWith([], "front", 3.25, -Infinity);
        expect(mocks.downloadBlob).toHaveBeenCalledOnce();
    });

    it("rejects a source reload on the same video during frame acknowledgement", async () => {
        // A playing camera is always nudged to decode its current frame.
        mocks.players.front!.paused = false;
        acknowledgeFrame(mocks.players.front!, () => {
            mocks.players.front!.src = "blob:replacement";
        });
        await captureStill(
            VIEW,
            "download",
            clock(40, () => 3.25),
        );
        expect(mocks.downloadBlob).not.toHaveBeenCalled();
        expect(mocks.resolveRegionBlursAt).not.toHaveBeenCalled();
    });

    it("waits for seeked when the captured frame arrives while the self-seek is still pending", async () => {
        // A playing camera is always nudged to decode its current frame.
        mocks.players.front!.paused = false;
        vi.useFakeTimers();
        stubCaptureCanvas();
        const video = mocks.players.front!;
        acknowledgeFrame(video, () => {
            video.seeking = true;
        });
        const effective = [{ id: "manual" }];
        mocks.activeEffectiveBlurRegions.mockReturnValue(effective);
        mocks.resolveRegionBlursAt.mockReturnValue([{ style: "fill" }]);
        const contentTime = vi.fn((_channel: string, time?: number) => (time === undefined ? 3.25 : time + 2));
        const pending = captureStill(VIEW, "download", clock(40, contentTime));
        await Promise.resolve();
        await Promise.resolve();
        expect(mocks.drawCameraComposition).not.toHaveBeenCalled();
        video.seeking = false;
        video.dispatchEvent(new Event("seeked"));
        await pending;

        expect(contentTime).toHaveBeenCalledWith("front", undefined);
        expect(mocks.resolveRegionBlursAt).toHaveBeenCalledWith(effective, "front", 3.25, -Infinity);
        expect(mocks.downloadBlob).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("uses the latest presented frame when the same video advances before seeked", async () => {
        // A playing camera is always nudged to decode its current frame.
        mocks.players.front!.paused = false;
        stubCaptureCanvas();
        const video = mocks.players.front!;
        acknowledgeFrame(video, () => {
            video.seeking = true;
        });
        let currentFrameSec = 3.25;
        const contentTime = vi.fn((_channel: string, time?: number) =>
            time === undefined ? currentFrameSec : time + 2,
        );
        const pending = captureStill(VIEW, "download", clock(40, contentTime));
        await Promise.resolve();
        await Promise.resolve();
        currentFrameSec = 4.5;
        video.seeking = false;
        video.dispatchEvent(new Event("seeked"));
        await pending;

        expect(mocks.drawCameraComposition).toHaveBeenCalledOnce();
        expect(mocks.resolveRegionBlursAt).toHaveBeenCalledWith([], "front", 4.5, -Infinity);
        expect(mocks.downloadBlob).toHaveBeenCalledOnce();
    });

    it("rejects a source replacement during the seek completion wait", async () => {
        // A playing camera is always nudged to decode its current frame.
        mocks.players.front!.paused = false;
        vi.useFakeTimers();
        stubCaptureCanvas();
        const video = mocks.players.front!;
        acknowledgeFrame(video, () => {
            video.seeking = true;
        });
        const pending = captureStill(
            VIEW,
            "download",
            clock(40, () => 3.25),
        );
        await Promise.resolve();
        await Promise.resolve();
        video.src = "blob:replacement";
        video.seeking = false;
        video.dispatchEvent(new Event("seeked"));
        await pending;

        expect(mocks.drawCameraComposition).not.toHaveBeenCalled();
        expect(mocks.downloadBlob).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("stops waiting when the source unloads before seeked", async () => {
        // A playing camera is always nudged to decode its current frame.
        mocks.players.front!.paused = false;
        vi.useFakeTimers();
        stubCaptureCanvas();
        const video = mocks.players.front!;
        acknowledgeFrame(video, () => {
            video.seeking = true;
        });
        const pending = captureStill(
            VIEW,
            "download",
            clock(40, () => 3.25),
        );
        await Promise.resolve();
        await Promise.resolve();
        video.dispatchEvent(new Event("emptied"));
        await pending;

        expect(mocks.drawCameraComposition).not.toHaveBeenCalled();
        expect(mocks.downloadBlob).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("refuses capture when the acknowledged frame's seek never settles", async () => {
        // A playing camera is always nudged to decode its current frame.
        mocks.players.front!.paused = false;
        vi.useFakeTimers();
        stubCaptureCanvas();
        acknowledgeFrame(mocks.players.front!, () => {
            mocks.players.front!.seeking = true;
        });
        const pending = captureStill(
            VIEW,
            "download",
            clock(40, () => 3.25),
        );
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1500);
        await pending;

        expect(mocks.drawCameraComposition).not.toHaveBeenCalled();
        expect(mocks.downloadBlob).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("captureStill content", () => {
    beforeEach(() => {
        mocks.state.exportModeOpen = false;
    });

    it("lays the cameras out as the viewer shows them, the main one at its own width", async () => {
        mocks.visible = ["front", "rear"];
        const request = {
            width: 800,
            height: 600,
            cameras: [
                { channel: "front" as const, aspect: 100 / 60 },
                { channel: "rear" as const, aspect: 50 / 30 },
            ],
            mode: "main" as const,
            thumbScale: null,
            allowOverlay: false,
            gap: VIEWER_TILE_GAP_PX,
            minThumbHeight: VIEWER_MIN_THUMB_HEIGHT_PX,
        };
        mocks.viewerCameraLayout.mockReturnValue({ request, layout: computeCameraLayout(request) });
        const { canvas } = stubCaptureCanvas();

        await captureStill(
            VIEW,
            "download",
            clock(1, () => 3),
        );

        const tiles = mocks.drawCameraComposition.mock.lastCall![1] as { channel: string; w: number }[];
        expect(tiles.map((tile) => tile.channel)).toEqual(["front", "rear"]);
        expect(tiles[0]!.w).toBeCloseTo(100, 0);
        expect(canvas.width).toBeGreaterThanOrEqual(100);
        expect(drawnCameras().rear!.sample, "the smaller camera is drawn too").not.toBeNull();
        expect(drawnCameras().front!.regionBlurs, "viewing shows no privacy zones").toBeNull();
        expect(mocks.resolveRegionBlursAt).not.toHaveBeenCalled();
    });

    it("saves only the zoomed part of a zoomed camera, in its recorded pixels", async () => {
        mocks.visible = ["front", "rear"];
        mocks.zoomedCameraView.mockReturnValue({ channel: "front", share: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
        const { canvas } = stubCaptureCanvas();

        await captureStill(
            VIEW,
            "download",
            clock(1, () => 3),
        );

        expect(canvas).toMatchObject({ width: 50, height: 30 });
        expect(Object.keys(drawnCameras())).toEqual(["front"]);
        expect(drawnCameras().front!.crop).toEqual({ xPct: 0.25, yPct: 0.25, wPct: 0.5, hPct: 0.5 });
    });

    it("refuses the arranged view when the zoom it was waiting for is gone", async () => {
        mocks.visible = ["front", "rear"];
        mocks.zoomedCameraView
            .mockReturnValueOnce({ channel: "front", share: { x: 0, y: 0, w: 0.5, h: 0.5 } })
            .mockReturnValue(null);
        const request = {
            width: 800,
            height: 600,
            cameras: [
                { channel: "front" as const, aspect: 100 / 60 },
                { channel: "rear" as const, aspect: 50 / 30 },
            ],
            mode: "main" as const,
            thumbScale: null,
            allowOverlay: false,
            gap: VIEWER_TILE_GAP_PX,
            minThumbHeight: VIEWER_MIN_THUMB_HEIGHT_PX,
        };
        mocks.viewerCameraLayout.mockReturnValue({ request, layout: computeCameraLayout(request) });
        stubCaptureCanvas();

        await captureStill(
            VIEW,
            "download",
            clock(1, () => 3),
        );

        expect(mocks.drawCameraComposition, "the rear camera was never waited for").not.toHaveBeenCalled();
        expect(mocks.downloadBlob).not.toHaveBeenCalled();
    });

    it("refuses the arranged view while one of its cameras is not ready", async () => {
        vi.useFakeTimers();
        mocks.visible = ["front", "rear"];
        mocks.players.rear!.readyState = 0;
        stubCaptureCanvas();

        const pending = captureStill(
            VIEW,
            "download",
            clock(1, () => 3),
        );
        await vi.advanceTimersByTimeAsync(1500);
        await pending;

        expect(mocks.drawCameraComposition).not.toHaveBeenCalled();
        expect(mocks.downloadBlob).not.toHaveBeenCalled();
    });

    it("saves one camera's whole picture at its own resolution", async () => {
        mocks.visible = ["front", "rear"];
        mocks.zoomedCameraView.mockReturnValue({ channel: "rear", share: { x: 0, y: 0, w: 0.5, h: 0.5 } });
        const { canvas } = stubCaptureCanvas();

        await captureStill(
            { kind: "camera", channel: "rear" },
            "download",
            clock(1, () => 3),
        );

        expect(canvas).toMatchObject({ width: 50, height: 30 });
        expect(drawnCameras().rear!.crop, "the camera item ignores the zoom").toBeNull();
    });
});

describe("captureStill export overlays", () => {
    it("draws the export's overlays, map placeholder and watermark over the frame", async () => {
        mocks.buildOverlayPipelineArgs.mockReturnValue({ localeScript: "latin", map: { shape: "rect" } });
        mocks.watermarkAnchorForExport.mockReturnValue("br");
        stubCaptureCanvas();

        await captureStill(
            VIEW,
            "download",
            clock(1, () => 3),
        );

        expect(mocks.drawTelemetryOverlays).toHaveBeenCalledOnce();
        expect(mocks.drawMapPlaceholder, "no GPS fix keeps the export's map placeholder").toHaveBeenCalledOnce();
        expect(mocks.drawWatermark).toHaveBeenCalledWith(expect.anything(), 1280, 720, "br");
    });

    it("keeps a single camera's still free of overlays", async () => {
        mocks.buildOverlayPipelineArgs.mockReturnValue({ localeScript: "latin", map: null });
        mocks.watermarkAnchorForExport.mockReturnValue("br");
        stubCaptureCanvas();

        await captureStill(
            { kind: "camera", channel: "front" },
            "download",
            clock(1, () => 3),
        );

        expect(mocks.drawTelemetryOverlays).not.toHaveBeenCalled();
        expect(mocks.drawWatermark).not.toHaveBeenCalled();
    });
});

describe("captureStill clipboard", () => {
    beforeEach(() => {
        mocks.state.exportModeOpen = false;
        mocks.viewerCameraLayout.mockReturnValue(null);
        mocks.zoomedCameraView.mockReturnValue({ channel: "front", share: { x: 0, y: 0, w: 1, h: 1 } });
    });

    /** Clipboard that behaves like the engines: the write settles once every
     *  item's data settles, and a rejected item fails the write. */
    function stubClipboard(): { write: ReturnType<typeof vi.fn>; items: { type: string; data: unknown }[] } {
        const items: { type: string; data: unknown }[] = [];
        vi.stubGlobal(
            "ClipboardItem",
            class {
                constructor(data: Record<string, unknown>) {
                    for (const [type, value] of Object.entries(data)) items.push({ type, data: value });
                }
            },
        );
        const write = vi.fn(async () => {
            await Promise.all(items.map((item) => item.data));
        });
        vi.stubGlobal("navigator", { clipboard: { write } });
        return { write, items };
    }

    it("starts the clipboard write before any wait, with the PNG still being drawn", async () => {
        const { toBlobType } = stubCaptureCanvas();
        const { write, items } = stubClipboard();

        const pending = captureStill(
            VIEW,
            "clipboard",
            clock(1, () => 3),
        );

        expect(write, "written synchronously to keep the user activation").toHaveBeenCalledOnce();
        expect(items).toHaveLength(1);
        expect(items[0]!.type).toBe("image/png");
        expect(items[0]!.data).toBeInstanceOf(Promise);
        await pending;
        await expect(items[0]!.data).resolves.toBeInstanceOf(Blob);
        expect(toBlobType()).toBe("image/png");
        expect(mocks.notify).toHaveBeenCalledWith({ severity: "info", messageKey: "player.captureCopy.done" });
        expect(mocks.downloadBlob).not.toHaveBeenCalled();
    });

    it("reports a copy whose still cannot be drawn", async () => {
        stubCaptureCanvas();
        stubClipboard();
        mocks.players.front!.seeking = true;

        await captureStill(
            VIEW,
            "clipboard",
            clock(1, () => 3),
        );

        expect(mocks.drawCameraComposition).not.toHaveBeenCalled();
        expect(mocks.notify).toHaveBeenCalledWith({ severity: "warn", messageKey: "player.captureCopy.failed" });
    });

    it("reports a browser that cannot copy images", async () => {
        vi.stubGlobal("navigator", {});

        await captureStill(
            VIEW,
            "clipboard",
            clock(1, () => 3),
        );

        expect(mocks.notify).toHaveBeenCalledWith({ severity: "warn", messageKey: "player.captureCopy.failed" });
        expect(mocks.drawCameraComposition).not.toHaveBeenCalled();
    });
});

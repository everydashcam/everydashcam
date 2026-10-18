import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    activeEffectiveBlurRegions: vi.fn(),
    previewExportStartSec: vi.fn(),
    resolveRegionBlursAt: vi.fn(),
    paintRegionBlursForView: vi.fn(),
    downloadBlob: vi.fn(),
    video: Object.assign(new EventTarget(), {
        readyState: 2,
        videoWidth: 100,
        videoHeight: 60,
        currentTime: 1,
        paused: true,
        seeking: false,
        src: "blob:current",
        requestVideoFrameCallback: undefined as undefined | ((callback: VideoFrameRequestCallback) => number),
        cancelVideoFrameCallback: vi.fn(),
    }),
}));

vi.mock("../blur-regions.js", () => ({ resolveRegionBlursAt: mocks.resolveRegionBlursAt }));
vi.mock("../download.js", () => ({ downloadBlob: mocks.downloadBlob }));
vi.mock("../i18n/index.js", () => ({ t: (key: string) => key }));
vi.mock("../log.js", () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../transcode/compose.js", () => ({
    createRegionBlurHelper: () => ({}),
    paintRegionBlursForView: mocks.paintRegionBlursForView,
}));
vi.mock("../trips.js", () => ({ displayClockDate: (sec: number) => new Date(sec * 1000) }));
vi.mock("./blur-effective.js", () => ({
    activeEffectiveBlurRegions: mocks.activeEffectiveBlurRegions,
    previewExportStartSec: mocks.previewExportStartSec,
}));

vi.mock("./dom.js", () => ({
    activePlayer: () => mocks.video,
    effectiveMasterChannel: () => "front",
    dom: { playerBar: { capture: {} }, player: mocks.video },
}));
vi.mock("./state.js", () => ({
    activeCandidate: () => null,
    activeTrip: () => null,
    state: { exportModeOpen: true, channelBackends: {}, chartZoomed: false },
}));

import { captureCurrentFrame } from "./player-capture.js";

function stubCaptureCanvas(): { drawImage: ReturnType<typeof vi.fn> } {
    const ctx = { drawImage: vi.fn() };
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => ctx,
        toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["jpg"])),
    };
    vi.stubGlobal("document", {
        createElement: (tag: string) => {
            expect(tag).toBe("canvas");
            return canvas;
        },
    });
    return ctx;
}

function acknowledgeFrame(before?: () => void): void {
    mocks.video.requestVideoFrameCallback = (callback) => {
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

describe("captureCurrentFrame privacy blur", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.previewExportStartSec.mockReturnValue(-Infinity);
        mocks.video.currentTime = 1;
        mocks.video.seeking = false;
        mocks.video.src = "blob:current";
        mocks.video.requestVideoFrameCallback = undefined;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("burns the full effective manual + detected region set into a JPG", async () => {
        const effective = [{ id: "manual" }, { id: "auto-detected" }];
        const resolved = [{ style: "fill" }];
        mocks.activeEffectiveBlurRegions.mockReturnValue(effective);
        mocks.resolveRegionBlursAt.mockReturnValue(resolved);

        const ctx = stubCaptureCanvas();

        await captureCurrentFrame(
            () => 0,
            () => 1,
            () => 3,
        );

        expect(mocks.resolveRegionBlursAt).toHaveBeenCalledWith(effective, "front", 3, -Infinity);
        expect(mocks.paintRegionBlursForView).toHaveBeenCalledWith(
            ctx,
            resolved,
            100,
            60,
            0,
            0,
            100,
            60,
            0,
            0,
            100,
            60,
            expect.anything(),
            { horizontal: false, vertical: false },
        );
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
        mocks.video.currentTime = 1.0005;
        stubCaptureCanvas();

        await captureCurrentFrame(
            () => 0,
            () => 1.0005,
            () => 1,
        );

        expect(mocks.previewExportStartSec).toHaveBeenCalledWith("front", 1);
        expect(mocks.resolveRegionBlursAt).toHaveBeenCalledWith(effective, "front", 1, 1.0005);
        expect(mocks.paintRegionBlursForView).toHaveBeenCalledOnce();
        expect(mocks.downloadBlob).toHaveBeenCalledOnce();
    });

    it("refuses a JPG while the requested seek still displays older pixels", async () => {
        mocks.video.seeking = true;
        await captureCurrentFrame(
            () => 0,
            () => 40,
            () => null,
        );
        expect(mocks.downloadBlob).not.toHaveBeenCalled();
        expect(mocks.resolveRegionBlursAt).not.toHaveBeenCalled();
    });

    it("refuses an export-mode JPG until its displayed frame has a timestamp", async () => {
        await captureCurrentFrame(
            () => 0,
            () => 40,
            () => null,
        );
        expect(mocks.downloadBlob).not.toHaveBeenCalled();
        expect(mocks.resolveRegionBlursAt).not.toHaveBeenCalled();
    });

    it("resolves a captured frame's own PTS instead of a later playhead", async () => {
        stubCaptureCanvas();
        acknowledgeFrame();
        mocks.activeEffectiveBlurRegions.mockReturnValue([]);
        mocks.resolveRegionBlursAt.mockReturnValue([]);
        const contentTime = vi.fn((_channel: string, time?: number) => (time === undefined ? null : time + 2));
        await captureCurrentFrame(
            () => 0,
            () => 40,
            contentTime,
        );
        expect(contentTime).toHaveBeenCalledWith("front", 1.25);
        expect(mocks.resolveRegionBlursAt).toHaveBeenCalledWith([], "front", 3.25, -Infinity);
        expect(mocks.downloadBlob).toHaveBeenCalledOnce();
    });

    it("rejects a source reload on the same video during frame acknowledgement", async () => {
        acknowledgeFrame(() => {
            mocks.video.src = "blob:replacement";
        });
        await captureCurrentFrame(
            () => 0,
            () => 40,
            () => 3.25,
        );
        expect(mocks.downloadBlob).not.toHaveBeenCalled();
        expect(mocks.resolveRegionBlursAt).not.toHaveBeenCalled();
    });

    it("waits for seeked when the captured frame arrives while the self-seek is still pending", async () => {
        vi.useFakeTimers();
        const ctx = stubCaptureCanvas();
        acknowledgeFrame(() => {
            mocks.video.seeking = true;
        });
        const effective = [{ id: "manual" }];
        mocks.activeEffectiveBlurRegions.mockReturnValue(effective);
        mocks.resolveRegionBlursAt.mockReturnValue([{ style: "fill" }]);
        const contentTime = vi.fn((_channel: string, time?: number) => (time === undefined ? 3.25 : time + 2));
        const pending = captureCurrentFrame(
            () => 0,
            () => 40,
            contentTime,
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(ctx.drawImage).not.toHaveBeenCalled();
        mocks.video.seeking = false;
        mocks.video.dispatchEvent(new Event("seeked"));
        await pending;

        expect(contentTime).toHaveBeenCalledWith("front", undefined);
        expect(mocks.resolveRegionBlursAt).toHaveBeenCalledWith(effective, "front", 3.25, -Infinity);
        expect(mocks.paintRegionBlursForView).toHaveBeenCalledOnce();
        expect(mocks.downloadBlob).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("uses the latest presented frame when the same video advances before seeked", async () => {
        const ctx = stubCaptureCanvas();
        acknowledgeFrame(() => {
            mocks.video.seeking = true;
        });
        mocks.activeEffectiveBlurRegions.mockReturnValue([]);
        mocks.resolveRegionBlursAt.mockReturnValue([]);
        let currentFrameSec = 3.25;
        const contentTime = vi.fn((_channel: string, time?: number) =>
            time === undefined ? currentFrameSec : time + 2,
        );
        const pending = captureCurrentFrame(
            () => 0,
            () => 40,
            contentTime,
        );
        await Promise.resolve();
        await Promise.resolve();
        currentFrameSec = 4.5;
        mocks.video.seeking = false;
        mocks.video.dispatchEvent(new Event("seeked"));
        await pending;

        expect(ctx.drawImage).toHaveBeenCalledOnce();
        expect(mocks.resolveRegionBlursAt).toHaveBeenCalledWith([], "front", 4.5, -Infinity);
        expect(mocks.downloadBlob).toHaveBeenCalledOnce();
    });

    it("rejects a source replacement during the seek completion wait", async () => {
        vi.useFakeTimers();
        const ctx = stubCaptureCanvas();
        acknowledgeFrame(() => {
            mocks.video.seeking = true;
        });
        const pending = captureCurrentFrame(
            () => 0,
            () => 40,
            () => 3.25,
        );
        await Promise.resolve();
        await Promise.resolve();
        mocks.video.src = "blob:replacement";
        mocks.video.seeking = false;
        mocks.video.dispatchEvent(new Event("seeked"));
        await pending;

        expect(ctx.drawImage).not.toHaveBeenCalled();
        expect(mocks.downloadBlob).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("stops waiting when the source unloads before seeked", async () => {
        vi.useFakeTimers();
        const ctx = stubCaptureCanvas();
        acknowledgeFrame(() => {
            mocks.video.seeking = true;
        });
        const pending = captureCurrentFrame(
            () => 0,
            () => 40,
            () => 3.25,
        );
        await Promise.resolve();
        await Promise.resolve();
        mocks.video.dispatchEvent(new Event("emptied"));
        await pending;

        expect(ctx.drawImage).not.toHaveBeenCalled();
        expect(mocks.downloadBlob).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("refuses capture when the acknowledged frame's seek never settles", async () => {
        vi.useFakeTimers();
        const ctx = stubCaptureCanvas();
        acknowledgeFrame(() => {
            mocks.video.seeking = true;
        });
        const pending = captureCurrentFrame(
            () => 0,
            () => 40,
            () => 3.25,
        );
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1500);
        await pending;

        expect(ctx.drawImage).not.toHaveBeenCalled();
        expect(mocks.downloadBlob).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});

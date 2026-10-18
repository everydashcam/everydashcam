import { beforeEach, describe, expect, it, vi } from "vitest";

const ui = vi.hoisted(() => ({
    range: null as { startTripSec: number } | null,
    videos: { front: { currentTime: 1.0005 }, rear: { currentTime: 0.5005 } },
    channelPresentedFrame: vi.fn(),
}));

// These modules reach DOM-backed playback, editor and detector state. Keep
// the coverage decision itself real while supplying their current UI values.
vi.mock("./blur-detect.js", () => ({ detectRegions: () => [] }));
vi.mock("./blur-regions-state.js", () => ({ activeBlurRegions: () => [] }));
vi.mock("./export-state.js", () => ({
    exportPanelState: {
        get range() {
            return ui.range;
        },
    },
}));
vi.mock("./dom.js", () => ({ channelPlayers: ui.videos }));
vi.mock("./player-frame-time.js", () => ({ channelPresentedFrame: ui.channelPresentedFrame }));

import { previewExportStartSec } from "./blur-effective.js";

describe("previewExportStartSec", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ui.range = { startTripSec: 1.0005 };
        ui.videos.front.currentTime = 1.0005;
        ui.videos.rear.currentTime = 0.5005;
        ui.channelPresentedFrame.mockReturnValue({ contentSec: 1.0005 });
    });

    it("uses source-frame coverage without a selected export range", () => {
        ui.range = null;
        expect(previewExportStartSec("front", 1)).toBe(-Infinity);
        expect(ui.channelPresentedFrame).not.toHaveBeenCalled();
    });

    it.each([1.0005, 2])("uses source-frame coverage when the displayed frame is already in-range at %s", (sec) => {
        expect(previewExportStartSec("front", sec)).toBe(-Infinity);
        expect(ui.channelPresentedFrame).not.toHaveBeenCalled();
    });

    it("covers the retained frame once the settled player clock reaches the fractional trim", () => {
        expect(previewExportStartSec("front", 1)).toBe(1.0005);
        expect(ui.channelPresentedFrame).toHaveBeenCalledWith("front", true, 1.0005);
    });

    it("keeps ordinary coverage when seeking before the trim", () => {
        ui.videos.front.currentTime = 1;
        ui.channelPresentedFrame.mockReturnValue({ contentSec: 1 });
        expect(previewExportStartSec("front", 1)).toBe(-Infinity);
        expect(ui.channelPresentedFrame).toHaveBeenCalledWith("front", true, 1);
    });

    it("does not extend coverage without a settled source clock", () => {
        ui.channelPresentedFrame.mockReturnValue(null);
        expect(previewExportStartSec("front", 1)).toBe(-Infinity);
        expect(ui.channelPresentedFrame).toHaveBeenCalledWith("front", true, 1.0005);
    });

    it("maps each channel's local clock before comparing it with the content-axis trim", () => {
        // The rear file starts half a second later on the shared content axis.
        expect(previewExportStartSec("rear", 1)).toBe(1.0005);
        expect(ui.channelPresentedFrame).toHaveBeenCalledWith("rear", true, 0.5005);
    });
});

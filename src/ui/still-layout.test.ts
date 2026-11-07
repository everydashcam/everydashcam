import { describe, expect, it } from "vitest";

import {
    type CameraLayoutRequest,
    computeCameraLayout,
    VIEWER_MIN_THUMB_HEIGHT_PX,
    VIEWER_TILE_GAP_PX,
} from "../camera-layout.js";
import type { Channel } from "../parsers/types.js";
import { STILL_MAX_PIXELS, singleCameraStill, stillBudgetFactor, viewerStill } from "./still-layout.js";

const WIDE = 16 / 9;

function viewerRequest(
    width: number,
    height: number,
    channels: Channel[],
    overrides: Partial<CameraLayoutRequest> = {},
): CameraLayoutRequest {
    return {
        width,
        height,
        cameras: channels.map((channel) => ({ channel, aspect: WIDE })),
        mode: "main",
        thumbScale: null,
        allowOverlay: false,
        gap: VIEWER_TILE_GAP_PX,
        minThumbHeight: VIEWER_MIN_THUMB_HEIGHT_PX,
        ...overrides,
    };
}

describe("stillBudgetFactor", () => {
    it("keeps an image that fits the canvas limits", () => {
        expect(stillBudgetFactor(3840, 2160)).toBe(1);
    });

    it("shrinks an image larger than the area limit to the limit", () => {
        const factor = stillBudgetFactor(7680, 4320);
        expect(factor).toBeLessThan(1);
        expect(7680 * factor * 4320 * factor).toBeCloseTo(STILL_MAX_PIXELS, -2);
    });
});

describe("singleCameraStill", () => {
    it("keeps the camera's own resolution", () => {
        const still = singleCameraStill("rear", 1920, 1080);
        expect(still).toMatchObject({ width: 1920, height: 1080 });
        expect(still.tiles).toEqual([{ channel: "rear", role: "equal", overlay: false, x: 0, y: 0, w: 1920, h: 1080 }]);
    });

    it("keeps only the recorded pixels of a zoomed part", () => {
        const still = singleCameraStill("front", 3840, 2160, { w: 0.25, h: 0.25 });
        expect(still).toMatchObject({ width: 960, height: 540 });
        expect(still.tiles[0]).toMatchObject({ w: 960, h: 540 });
    });
});

describe("viewerStill", () => {
    it("gives the lead camera its own width and keeps the viewer's arrangement", () => {
        const request = viewerRequest(1200, 900, ["front", "rear", "interior"]);
        const view = computeCameraLayout(request);
        const still = viewerStill(request, view, "front", 2560);
        expect(still).not.toBeNull();
        const front = still!.tiles.find((tile) => tile.channel === "front")!;
        expect(front.w).toBeCloseTo(2560, 0);
        expect(front.h, "front keeps its picture shape").toBeCloseTo(2560 / WIDE, 0);
        expect(still!.tiles.map((tile) => tile.role)).toEqual(view.tiles.map((tile) => tile.role));
        for (const tile of still!.tiles) {
            expect(tile.x, `${tile.channel} starts inside the still`).toBeGreaterThanOrEqual(-0.5);
            expect(tile.y, `${tile.channel} starts inside the still`).toBeGreaterThanOrEqual(-0.5);
            expect(tile.x + tile.w, `${tile.channel} ends inside the still`).toBeLessThanOrEqual(still!.width + 0.5);
            expect(tile.y + tile.h, `${tile.channel} ends inside the still`).toBeLessThanOrEqual(still!.height + 0.5);
        }
    });

    it("drops the empty part of the player box", () => {
        // A wide player box around one 16:9 camera leaves bars at the sides.
        const request = viewerRequest(2000, 600, ["front"]);
        const view = computeCameraLayout(request);
        const still = viewerStill(request, view, "front", 1920);
        expect(still).toMatchObject({ width: 1920, height: 1080 });
    });

    it("leaves no gaps between the tiles", () => {
        const request = viewerRequest(1200, 1200, ["front", "rear"], { mode: "equal" });
        const view = computeCameraLayout(request);
        const still = viewerStill(request, view, "front", 1920)!;
        const [first, second] = still.tiles;
        const touches =
            Math.abs(first!.y + first!.h - second!.y) < 0.5 || Math.abs(first!.x + first!.w - second!.x) < 0.5;
        expect(touches).toBe(true);
    });

    it("fits a large composition into the canvas limits", () => {
        const request = viewerRequest(1600, 900, ["front", "rear", "interior", "side"], { mode: "equal" });
        const view = computeCameraLayout(request);
        const still = viewerStill(request, view, "front", 3840)!;
        expect(still.width * still.height).toBeLessThanOrEqual(STILL_MAX_PIXELS);
    });

    it("returns null when the lead camera has no tile", () => {
        const request = viewerRequest(1200, 900, ["front"]);
        expect(viewerStill(request, computeCameraLayout(request), "rear", 1920)).toBeNull();
    });
});

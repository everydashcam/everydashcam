import { describe, expect, it, vi } from "vitest";

import {
    createReusingMapSnapshotter,
    isMapPoseReusable,
    MAP_SNAPSHOT_WIDTH,
    zoomForDiameterKm,
} from "./map-snapshot-camera.js";
import type { MapSnapshotRequest } from "./map-snapshotter-types.js";

const NORTH_UP = { headingUp: false, adaptiveZoom: false };
const CHASE = { headingUp: true, adaptiveZoom: true };

/** Moves a request north by `meters` (1 degree of latitude ~ 111.2 km). */
function north(req: MapSnapshotRequest, meters: number): MapSnapshotRequest {
    return { ...req, lat: req.lat + meters / 111_195 };
}

const base: MapSnapshotRequest = { lat: 55.75, lon: 37.62, bearingDeg: 90, zoomKm: 1, speedMs: 14 };

describe("isMapPoseReusable", () => {
    it("reuses a pose that moved by less than a snapshot pixel at the base zoom", () => {
        // 1 km across MAP_SNAPSHOT_WIDTH px -> 1.5625 m per px; 0.5 px = 0.78 m.
        const metersPerPx = 1000 / MAP_SNAPSHOT_WIDTH;
        expect(isMapPoseReusable(base, north(base, 0.5 * metersPerPx), NORTH_UP)).toBe(true);
        expect(isMapPoseReusable(base, north(base, 1.5 * metersPerPx), NORTH_UP)).toBe(false);
    });

    it("tightens the shift budget for the tilted chase camera", () => {
        const metersPerPx = 1000 / MAP_SNAPSHOT_WIDTH;
        expect(isMapPoseReusable(base, north(base, 0.5 * metersPerPx), { ...CHASE, adaptiveZoom: false })).toBe(false);
        expect(isMapPoseReusable(base, north(base, 0.25 * metersPerPx), { ...CHASE, adaptiveZoom: false })).toBe(true);
    });

    it("scales the shift budget with the zoom slider", () => {
        // At 100 m across the slot one pixel is 10x fewer metres.
        const tight = { ...base, zoomKm: 0.1 };
        expect(isMapPoseReusable(tight, north(tight, 0.5), NORTH_UP)).toBe(false);
        expect(isMapPoseReusable(tight, north(tight, 0.05), NORTH_UP)).toBe(true);
    });

    it("never reuses across a zoom slider change", () => {
        expect(isMapPoseReusable(base, { ...base, zoomKm: 2 }, NORTH_UP)).toBe(false);
    });

    it("lets the north-up marker rotate by a hair but not the whole heading-up map", () => {
        const turned = { ...base, bearingDeg: base.bearingDeg + 0.3 };
        expect(isMapPoseReusable(base, turned, NORTH_UP)).toBe(true);
        expect(isMapPoseReusable(base, turned, { ...CHASE, adaptiveZoom: false })).toBe(false);
        expect(isMapPoseReusable(base, { ...base, bearingDeg: base.bearingDeg + 0.02 }, CHASE)).toBe(true);
    });

    it("compares bearings across the 0/360 seam", () => {
        expect(isMapPoseReusable({ ...base, bearingDeg: 359.9 }, { ...base, bearingDeg: 0.1 }, NORTH_UP)).toBe(true);
        expect(isMapPoseReusable({ ...base, bearingDeg: 359 }, { ...base, bearingDeg: 1 }, NORTH_UP)).toBe(false);
    });

    it("invalidates a chase pose when the adaptive zoom moves, and ignores speed otherwise", () => {
        const faster = { ...base, speedMs: base.speedMs + 1 };
        expect(isMapPoseReusable(base, faster, CHASE)).toBe(false);
        expect(isMapPoseReusable(base, faster, { ...CHASE, adaptiveZoom: false })).toBe(true);
        expect(isMapPoseReusable(base, faster, NORTH_UP)).toBe(true);
        // Both beyond the full-speed end of the ramp: no zoom change.
        expect(isMapPoseReusable({ ...base, speedMs: 40 }, { ...base, speedMs: 50 }, CHASE)).toBe(true);
    });

    it("rejects a non-finite shift instead of reusing a stale frame", () => {
        expect(isMapPoseReusable(base, { ...base, lat: Number.NaN }, NORTH_UP)).toBe(false);
    });
});

describe("zoomForDiameterKm", () => {
    it("drops one level when the diameter doubles", () => {
        const z1 = zoomForDiameterKm(0, 1, MAP_SNAPSHOT_WIDTH);
        const z2 = zoomForDiameterKm(0, 2, MAP_SNAPSHOT_WIDTH);
        expect(z1 - z2).toBeCloseTo(1, 9);
    });
});

function fakeBitmap(): ImageBitmap {
    return { close: vi.fn(), width: 640, height: 480 } as unknown as ImageBitmap;
}

describe("createReusingMapSnapshotter", () => {
    it("hands the in-flight render to frames whose pose did not move and renders the rest", async () => {
        const bitmaps: ImageBitmap[] = [];
        const inner = {
            snapshot: vi.fn(async () => {
                const bitmap = fakeBitmap();
                bitmaps.push(bitmap);
                return bitmap;
            }),
        };
        const reusing = createReusingMapSnapshotter(inner, NORTH_UP);
        const first = reusing.snapshot(base);
        const second = reusing.snapshot(north(base, 0.2));
        expect(second, "same pose shares the pending render, no second request").toBe(first);
        await first;
        const moved = await reusing.snapshot(north(base, 50));
        expect(inner.snapshot).toHaveBeenCalledTimes(2);
        expect(moved).toBe(bitmaps[1]);
        expect(reusing.stats()).toEqual({ rendered: 2, reused: 1 });
    });

    it("keeps the last renders alive for the frames still holding them, then closes them", async () => {
        const bitmaps: ImageBitmap[] = [];
        const inner = {
            snapshot: vi.fn(async () => {
                const bitmap = fakeBitmap();
                bitmaps.push(bitmap);
                return bitmap;
            }),
        };
        const reusing = createReusingMapSnapshotter(inner, NORTH_UP);
        for (let i = 0; i < 5; i++) await reusing.snapshot(north(base, i * 50));
        expect(bitmaps).toHaveLength(5);
        expect(bitmaps.slice(0, 2).map((b) => (b.close as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 1]);
        expect(bitmaps.slice(2).every((b) => (b.close as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true);
        reusing.dispose();
        expect(bitmaps.every((b) => (b.close as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
        await expect(reusing.snapshot(base)).rejects.toMatchObject({ name: "AbortError" });
    });

    it("closes a render that lands after dispose and rejects its waiters", async () => {
        let resolve!: (bitmap: ImageBitmap) => void;
        const inner = { snapshot: () => new Promise<ImageBitmap>((r) => (resolve = r)) };
        const reusing = createReusingMapSnapshotter(inner, NORTH_UP);
        const pending = reusing.snapshot(base);
        reusing.dispose();
        const late = fakeBitmap();
        resolve(late);
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(late.close).toHaveBeenCalledTimes(1);
    });

    it("does not reuse a failed render for the next frame", async () => {
        const inner = {
            snapshot: vi
                .fn<(req: MapSnapshotRequest) => Promise<ImageBitmap>>()
                .mockRejectedValueOnce(new Error("tiles down"))
                .mockResolvedValueOnce(fakeBitmap()),
        };
        const reusing = createReusingMapSnapshotter(inner, NORTH_UP);
        await expect(reusing.snapshot(base)).rejects.toThrow("tiles down");
        await expect(reusing.snapshot(base)).resolves.toBeDefined();
        expect(inner.snapshot).toHaveBeenCalledTimes(2);
    });
});

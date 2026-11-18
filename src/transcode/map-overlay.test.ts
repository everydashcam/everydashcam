// coverFit is the center-crop math behind the map-overlay minimap (and the same
// cover-fit contract every widget slot relies on). It is pure and canvas-free,
// so a headless unit lock guards the geometry that only the local VRT suite
// otherwise exercises.

import { describe, it, expect } from "vitest";

import { _internal, mapOverlayRect, type MapOverlayDrawOpts } from "./map-overlay.js";

const { coverFit } = _internal;

describe("mapOverlayRect", () => {
    const rightBottom: MapOverlayDrawOpts = { xPct: 0.75, yPct: 0.8, scalePct: 100, shape: "rect" };

    it("moves a resized overlay inside the output frame", () => {
        const small = mapOverlayRect(1920, 1080, rightBottom);
        const large = mapOverlayRect(1920, 1080, { ...rightBottom, scalePct: 200 });
        expect(small.x + small.width).toBe(1920);
        expect(large).toEqual({ x: 960, y: 360, width: 960, height: 720 });
    });

    it("clamps again when the slot becomes circular or the output aspect changes", () => {
        const circle = mapOverlayRect(1920, 1080, { ...rightBottom, shape: "circle" });
        expect(circle.y + circle.height).toBe(1080);
        const portrait = mapOverlayRect(1080, 1920, { ...rightBottom, shape: "circle", scalePct: 200 });
        expect(portrait).toEqual({ x: 540, y: 1380, width: 540, height: 540 });
    });

    it("uses the selected shape for both game radars", () => {
        const circle = mapOverlayRect(1920, 1080, { ...rightBottom, shape: "circle" });
        for (const radar of ["san-andreas", "vice-city"] as const) {
            expect(mapOverlayRect(1920, 1080, { ...rightBottom, radar })).toEqual(
                mapOverlayRect(1920, 1080, rightBottom),
            );
            expect(mapOverlayRect(1920, 1080, { ...rightBottom, radar, shape: "circle" })).toEqual(circle);
        }
    });

    it("preserves output-pixel minimum sizes for a small custom output", () => {
        expect(mapOverlayRect(240, 240, { ...rightBottom, scalePct: 50 })).toEqual({
            x: 180,
            y: 192,
            width: 40,
            height: 30,
        });
    });
});

describe("coverFit", () => {
    it("returns the full source rect when aspects already match", () => {
        expect(coverFit(100, 100, 50, 50)).toEqual({ sx: 0, sy: 0, sw: 100, sh: 100 });
    });

    it("crops width symmetrically when the source is too wide for the slot", () => {
        // 200x100 source into a 100x100 (1:1) slot: keep height, crop width to
        // 100, offset half the excess (50) on the left.
        expect(coverFit(200, 100, 100, 100)).toEqual({ sx: 50, sy: 0, sw: 100, sh: 100 });
    });

    it("crops height symmetrically when the source is too tall for the slot", () => {
        // 100x200 into 100x100: keep width, crop height to 100, offset 50 on top.
        expect(coverFit(100, 200, 100, 100)).toEqual({ sx: 0, sy: 50, sw: 100, sh: 100 });
    });

    it("keeps the visible rect's aspect equal to the destination aspect", () => {
        const dstAspect = 16 / 9;
        const r = coverFit(1920, 1080, 320, 180);
        expect(r.sw / r.sh).toBeCloseTo(dstAspect, 5);
    });

    it("degenerate (non-positive) dimensions fall back to the source rect, never NaN", () => {
        expect(coverFit(0, 100, 50, 50)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 100 });
        expect(coverFit(100, 100, 0, 50)).toEqual({ sx: 0, sy: 0, sw: 100, sh: 100 });
    });
});

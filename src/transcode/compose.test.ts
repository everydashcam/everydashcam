// Unit tests for pure composer functions: computeAutoCrop / computeOutputSize /
// fitKeepAspect / fitKeepAspectCover / computeEffectiveAspect and the privacy
// region geometry.
//
// drawMain / drawCameraComposition / drawWatermark / fillBlurredCover are not
// covered here - they require VideoSample / OffscreenCanvas, which are
// unavailable in Node's jsdom-free vitest environment. The export pixel e2e
// tests check them on real files.

import { describe, expect, it } from "vitest";

import {
    computeAutoCrop,
    computeEffectiveAspect,
    computeOutputSize,
    fitHidesBackdrop,
    fitKeepAspect,
    fitKeepAspectCover,
    mapRegionRectToDest,
    snapRegionToMosaicGrid,
    softBlurRegionGrid,
} from "./compose.js";

describe("computeOutputSize", () => {
    it("16:9 / 1080 → 1920×1080", () => {
        expect(computeOutputSize(1080, "16:9")).toEqual({ width: 1920, height: 1080 });
    });

    it("16:9 / 720 → 1280×720", () => {
        expect(computeOutputSize(720, "16:9")).toEqual({ width: 1280, height: 720 });
    });

    it("9:16 / 1080 → 608×1080 (608 = round(607.5) rounded to even)", () => {
        expect(computeOutputSize(1080, "9:16")).toEqual({ width: 608, height: 1080 });
    });

    it("1:1 / 720 → 720×720", () => {
        expect(computeOutputSize(720, "1:1")).toEqual({ width: 720, height: 720 });
    });

    it("4:5 / 1080 → 864×1080", () => {
        expect(computeOutputSize(1080, "4:5")).toEqual({ width: 864, height: 1080 });
    });

    it("odd height is rounded up to even (H.264 requirement)", () => {
        // 721 → 722. width = round(722 * 16/9) = 1284, even.
        const r = computeOutputSize(721, "16:9");
        expect(r.height % 2).toBe(0);
        expect(r.width % 2).toBe(0);
    });
});

describe("computeAutoCrop", () => {
    it("source 16:9 / output 16:9 → no crop (full frame)", () => {
        const r = computeAutoCrop(1920, 1080, "16:9");
        expect(r).toEqual({ xPct: 0, yPct: 0, wPct: 1, hPct: 1 });
    });

    it("source 16:9 / output 9:16 → horizontal center crop", () => {
        const r = computeAutoCrop(1920, 1080, "9:16");
        // Takes the central 9:16 region: cropW = 1080 * 9/16 = 607.5
        // → xPct = (1920 - 607.5) / 2 / 1920 ≈ 0.3418
        expect(r.yPct).toBe(0);
        expect(r.hPct).toBe(1);
        expect(r.xPct).toBeCloseTo(0.3418, 3);
        expect(r.wPct).toBeCloseTo(0.3164, 3);
        // Symmetric: left margin === right margin.
        expect(r.xPct + r.wPct).toBeCloseTo(1 - r.xPct, 5);
    });

    it("source 9:16 (1080×1920) / output 16:9 → vertical center crop", () => {
        const r = computeAutoCrop(1080, 1920, "16:9");
        expect(r.xPct).toBe(0);
        expect(r.wPct).toBe(1);
        // cropH = 1080 / (16/9) = 607.5, yPct = (1920 - 607.5) / 2 / 1920 ≈ 0.3418
        expect(r.yPct).toBeCloseTo(0.3418, 3);
        expect(r.hPct).toBeCloseTo(0.3164, 3);
    });

    it("source 16:9 / output 1:1 → horizontal crop to square", () => {
        const r = computeAutoCrop(1920, 1080, "1:1");
        // cropW = 1080 (short side), xPct = (1920-1080)/2/1920 = 0.21875
        expect(r.yPct).toBe(0);
        expect(r.hPct).toBe(1);
        expect(r.xPct).toBeCloseTo(0.21875, 5);
        expect(r.wPct).toBeCloseTo(0.5625, 5);
    });

    it("source = output (square → square) - no crop, no floating-point error", () => {
        const r = computeAutoCrop(1080, 1080, "1:1");
        expect(r).toEqual({ xPct: 0, yPct: 0, wPct: 1, hPct: 1 });
    });
});

describe("fitKeepAspect (letterbox)", () => {
    it("16:9 source in 16:9 dest - fills completely with no bars", () => {
        const r = fitKeepAspect(1920, 1080, 1920, 1080);
        expect(r).toEqual({ dx: 0, dy: 0, dw: 1920, dh: 1080 });
    });

    it("16:9 source in 9:16 dest - pillarbox sides (narrow dest)", () => {
        // src ratio 1.78 > dst ratio 0.56: fit to dest width, letterbox vertically.
        const r = fitKeepAspect(1920, 1080, 1080, 1920);
        expect(r.dw).toBe(1080);
        expect(r.dh).toBe(Math.round(1080 / (1920 / 1080)));
        expect(r.dx).toBe(0);
        // dy positive (vertically centered).
        expect(r.dy).toBeGreaterThan(0);
        // No horizontal bars, black bars vertically.
        expect(r.dh).toBeLessThan(1920);
    });

    it("9:16 source in 16:9 dest - letterbox sides (narrow src)", () => {
        const r = fitKeepAspect(1080, 1920, 1920, 1080);
        // src ratio 0.56 < dst ratio 1.78: fit to height.
        expect(r.dh).toBe(1080);
        expect(r.dw).toBe(Math.round(1080 * (1080 / 1920)));
        expect(r.dx).toBeGreaterThan(0);
        expect(r.dy).toBe(0);
    });

    it("1:1 source in 16:9 dest - pillarbox", () => {
        const r = fitKeepAspect(1080, 1080, 1920, 1080);
        expect(r.dh).toBe(1080);
        expect(r.dw).toBe(1080);
        expect(r.dx).toBe(420);
        expect(r.dy).toBe(0);
    });

    it("zero dims fallback - returns full dst (guards against division by zero)", () => {
        expect(fitKeepAspect(0, 1080, 1920, 1080)).toEqual({ dx: 0, dy: 0, dw: 1920, dh: 1080 });
        expect(fitKeepAspect(1920, 0, 1920, 1080)).toEqual({ dx: 0, dy: 0, dw: 1920, dh: 1080 });
    });
});

describe("fitKeepAspectCover (for blur backdrop)", () => {
    it("16:9 source in 16:9 dest - exact match", () => {
        const r = fitKeepAspectCover(1920, 1080, 1920, 1080);
        expect(r.dw).toBe(1920);
        expect(r.dh).toBe(1080);
        expect(r.dx).toBe(0);
        expect(r.dy).toBe(0);
    });

    it("16:9 source in 1:1 dest - covers, excess clipped on sides", () => {
        // src ratio 1.78 > dst ratio 1: fit to height, excess on sides.
        const r = fitKeepAspectCover(1920, 1080, 1080, 1080);
        expect(r.dh).toBe(1080);
        // dw should be 1920 (1080 × 1.78), negative dx to center.
        expect(r.dw).toBe(1920);
        expect(r.dx).toBeLessThan(0); // overflows left/right of dest
        expect(r.dy).toBe(0);
    });

    it("9:16 source in 16:9 dest - covers, excess clipped top/bottom", () => {
        const r = fitKeepAspectCover(1080, 1920, 1920, 1080);
        expect(r.dw).toBe(1920);
        // dh = 1920 / (1080/1920) = round(1920 * 1.778) = round(3413.33) = 3413
        expect(r.dh).toBeGreaterThan(1080);
        expect(r.dx).toBe(0);
        expect(r.dy).toBeLessThan(0);
    });
});

describe("computeEffectiveAspect", () => {
    it("crop=null - returns sourceAspect unchanged", () => {
        expect(computeEffectiveAspect(16 / 9, null)).toBeCloseTo(16 / 9, 5);
        expect(computeEffectiveAspect(1, null)).toBeCloseTo(1, 5);
    });

    it("crop full frame (1.0×1.0) - sourceAspect unchanged", () => {
        const r = computeEffectiveAspect(16 / 9, { xPct: 0, yPct: 0, wPct: 1, hPct: 1 });
        expect(r).toBeCloseTo(16 / 9, 5);
    });

    it("16:9 source + proportional crop (0.5×0.5 of source) - aspect unchanged", () => {
        // crop in source pixels: 0.5*1920 × 0.5*1080 = 960×540 → ratio 1.78 (sourceAspect).
        // A proportional crop does not change the aspect ratio.
        const r = computeEffectiveAspect(16 / 9, { xPct: 0.25, yPct: 0.25, wPct: 0.5, hPct: 0.5 });
        expect(r).toBeCloseTo(16 / 9, 5);
    });

    it("16:9 source + equal-pct crop (wPct=hPct) - aspect = sourceAspect", () => {
        // Crop 0.3×0.3 of source 1920×1080 = 576×324 → aspect 1.78 (= sourceAspect).
        // Equal-percentage crop preserves the source aspect.
        const r = computeEffectiveAspect(16 / 9, { xPct: 0.35, yPct: 0.35, wPct: 0.3, hPct: 0.3 });
        expect(r).toBeCloseTo(16 / 9, 5);
    });

    it("16:9 source + horizontal crop (wPct=1, hPct=0.5) - effective = 2 × sourceAspect = 32:9", () => {
        // crop_w/crop_h = (1*1920)/(0.5*1080) = 1920/540 = 3.56 = 2 * 1.78
        const r = computeEffectiveAspect(16 / 9, { xPct: 0, yPct: 0.25, wPct: 1, hPct: 0.5 });
        expect(r).toBeCloseTo((16 / 9) * 2, 5);
    });

    it("hPct=0 - returns sourceAspect (guard against division by zero)", () => {
        const r = computeEffectiveAspect(16 / 9, { xPct: 0, yPct: 0, wPct: 1, hPct: 0 });
        expect(r).toBeCloseTo(16 / 9, 5);
    });
});

describe("mapRegionRectToDest", () => {
    // Identity view: full 1920x1080 source fitted 1:1 into a 1920x1080 dest.
    const full = [1920, 1080, 0, 0, 1920, 1080, 0, 0, 1920, 1080] as const;

    it("maps a region 1:1 on an identity view", () => {
        const r = mapRegionRectToDest({ xPct: 0.25, yPct: 0.5, wPct: 0.1, hPct: 0.1 }, ...full);
        expect(r).toEqual({ x: 480, y: 540, w: 192, h: 108 });
    });

    it("scales into a downsized letterboxed dest", () => {
        // 1920x1080 source fitted into a 1280x720 area offset by (0, 90).
        const r = mapRegionRectToDest(
            { xPct: 0.5, yPct: 0.5, wPct: 0.25, hPct: 0.25 },
            1920,
            1080,
            0,
            0,
            1920,
            1080,
            0,
            90,
            1280,
            720,
        );
        expect(r).toEqual({ x: 640, y: 450, w: 320, h: 180 });
    });

    it("maps through a crop window", () => {
        // Crop = right half of the source, fitted into the full 960x1080 dest.
        // Region centered at 75% of source width = center of the crop.
        const r = mapRegionRectToDest(
            { xPct: 0.7, yPct: 0.4, wPct: 0.1, hPct: 0.2 },
            1920,
            1080,
            960,
            0,
            960,
            1080,
            0,
            0,
            960,
            1080,
        );
        expect(r).toEqual({ x: 384, y: 432, w: 192, h: 216 });
    });

    it("clips a region partially outside the crop window", () => {
        // Crop = right half; region straddles the crop's left edge.
        const r = mapRegionRectToDest(
            { xPct: 0.45, yPct: 0.4, wPct: 0.1, hPct: 0.1 },
            1920,
            1080,
            960,
            0,
            960,
            1080,
            0,
            0,
            960,
            1080,
        );
        // Visible part: source x in [960, 1056] -> dest x in [0, 96].
        expect(r).toEqual({ x: 0, y: 432, w: 96, h: 108 });
    });

    it("returns null for a region fully outside the crop window", () => {
        const r = mapRegionRectToDest(
            { xPct: 0.1, yPct: 0.1, wPct: 0.2, hPct: 0.2 },
            1920,
            1080,
            960,
            0,
            960,
            1080,
            0,
            0,
            960,
            1080,
        );
        expect(r).toBeNull();
    });

    it("rounds outward so the patch never undercovers", () => {
        // Fractional mapping: region 10.7px..20.3px must produce 10..21.
        const r = mapRegionRectToDest(
            { xPct: 0.0107, yPct: 0.0107, wPct: 0.0096, hPct: 0.0096 },
            1000,
            1000,
            0,
            0,
            1000,
            1000,
            0,
            0,
            1000,
            1000,
        );
        expect(r).toEqual({ x: 10, y: 10, w: 11, h: 11 });
    });

    it("returns null on degenerate views", () => {
        expect(
            mapRegionRectToDest({ xPct: 0, yPct: 0, wPct: 1, hPct: 1 }, 1920, 1080, 0, 0, 0, 1080, 0, 0, 100, 100),
        ).toBeNull();
    });
});

describe("snapRegionToMosaicGrid", () => {
    it("keeps the block size when the region is clipped by the view window", () => {
        // Review regression: 1920x1080, crop = right half, region 192x108 at
        // x=780 - only a 12px sliver visible. Block must stay ~18px (the
        // pre-fix grid stretched 11 cols over 12px = near-identity mosaic).
        const snapped = snapRegionToMosaicGrid(
            { xPct: 780 / 1920, yPct: 0.4, wPct: 192 / 1920, hPct: 108 / 1080 },
            1920,
            1080,
            960,
            0,
            960,
            1080,
        );
        expect(snapped).not.toBeNull();
        const visW = snapped!.rect.wPct * 1920;
        expect(visW).toBeCloseTo(12, 5);
        expect(snapped!.cols).toBe(1);
        // Block size of the visible grid stays coarse.
        expect(visW / snapped!.cols).toBeGreaterThanOrEqual(4);
    });

    it("returns null when the region is fully outside the view", () => {
        expect(
            snapRegionToMosaicGrid({ xPct: 0.1, yPct: 0.1, wPct: 0.1, hPct: 0.1 }, 1920, 1080, 960, 0, 960, 1080),
        ).toBeNull();
    });

    it("uncropped view keeps the outward grid snap", () => {
        const snapped = snapRegionToMosaicGrid(
            { xPct: 0.4, yPct: 0.4, wPct: 0.1, hPct: 0.1 },
            1920,
            1080,
            0,
            0,
            1920,
            1080,
        );
        expect(snapped).not.toBeNull();
        // Snap only grows the rect (outward), never shrinks it.
        expect(snapped!.rect.wPct).toBeGreaterThanOrEqual(0.1 - 1e-9);
        expect(snapped!.cols).toBeGreaterThanOrEqual(6);
    });
});

describe("softBlurRegionGrid", () => {
    const region = { xPct: 0.4, yPct: 0.4, wPct: 0.1, hPct: 0.1 };

    it("keeps the same detail budget across preview, full-HD and 4K source sizes", () => {
        const grids = [
            [960, 540],
            [1920, 1080],
            [3840, 2160],
        ].map(([width, height]) => softBlurRegionGrid(region, width!, height!, 0, 0, width!, height!));
        expect(grids[0]).not.toBeNull();
        for (const grid of grids) {
            expect(grid!.cols).toBe(21);
            expect(grid!.rows).toBe(12);
            expect(grid!.rect.xPct).toBeCloseTo(region.xPct);
            expect(grid!.rect.wPct).toBeCloseTo(region.wPct);
        }
    });

    it("samples only the visible source intersection without shrinking its blur blocks", () => {
        const grid = softBlurRegionGrid(
            { xPct: 780 / 1920, yPct: 0.4, wPct: 192 / 1920, hPct: 108 / 1080 },
            1920,
            1080,
            960,
            0,
            960,
            1080,
        );
        expect(grid).not.toBeNull();
        expect(grid!.rect.xPct).toBeCloseTo(0.5);
        expect(grid!.rect.wPct * 1920).toBeCloseTo(12);
        expect(grid!.cols).toBe(1);
        expect(grid!.rows).toBe(12);
    });

    it("skips fully cropped regions and empty source views", () => {
        expect(softBlurRegionGrid(region, 1920, 1080, 1200, 0, 720, 1080)).toBeNull();
        expect(softBlurRegionGrid(region, 1920, 1080, 0, 0, 0, 1080)).toBeNull();
    });
});

describe("mapRegionRectToDest sliver cover", () => {
    it("covers a sub-1px visible sliver with a 1px patch instead of dropping it", () => {
        // Region ends 0.5 src px past the crop edge - must still paint 1px.
        const r = mapRegionRectToDest(
            { xPct: (960 - 100) / 1920, yPct: 0.4, wPct: 100.5 / 1920, hPct: 0.1 },
            1920,
            1080,
            960,
            0,
            960,
            1080,
            0,
            0,
            960,
            1080,
        );
        expect(r).not.toBeNull();
        expect(r!.x).toBe(0);
        expect(r!.w).toBeGreaterThanOrEqual(1);
    });
});

describe("fitHidesBackdrop", () => {
    it("is true when the fit covers the output exactly and the format is opaque", () => {
        expect(fitHidesBackdrop({ dx: 0, dy: 0, dw: 1920, dh: 1080 }, 1920, 1080, "I420")).toBe(true);
        expect(fitHidesBackdrop({ dx: 0, dy: 0, dw: 1920, dh: 1080 }, 1920, 1080, "NV12")).toBe(true);
    });

    it("is false when letterbox bars remain", () => {
        // 4:3 source fitted into a 16:9 output: pillarbox on both sides.
        expect(fitHidesBackdrop({ dx: 240, dy: 0, dw: 1440, dh: 1080 }, 1920, 1080, "I420")).toBe(false);
        // 21:9 source into 16:9: letterbox top and bottom.
        expect(fitHidesBackdrop({ dx: 0, dy: 129, dw: 1920, dh: 822 }, 1920, 1080, "I420")).toBe(false);
    });

    it("keeps the backdrop for a format carrying alpha", () => {
        expect(fitHidesBackdrop({ dx: 0, dy: 0, dw: 1920, dh: 1080 }, 1920, 1080, "RGBA")).toBe(false);
        expect(fitHidesBackdrop({ dx: 0, dy: 0, dw: 1920, dh: 1080 }, 1920, 1080, "I420A")).toBe(false);
    });

    it("keeps the backdrop when the format is unknown", () => {
        expect(fitHidesBackdrop({ dx: 0, dy: 0, dw: 1920, dh: 1080 }, 1920, 1080, null)).toBe(false);
    });
});

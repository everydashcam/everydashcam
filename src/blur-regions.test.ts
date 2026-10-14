import { describe, expect, it } from "vitest";

import {
    cloneBlurRegions,
    anyRegionIntersectsRange,
    createBlurRegion,
    inflateRect,
    regionHasTrackedKeyframes,
    regionRectAt,
    replaceGeneratedKeyframes,
    resolveRegionBlursAt,
    upsertKeyframe,
    type BlurRegion,
} from "./blur-regions.js";
import type { CropRect } from "./transcode/compose.js";

function rect(x: number, y: number, w = 0.1, h = 0.05): CropRect {
    return { xPct: x, yPct: y, wPct: w, hPct: h };
}

function makeRegion(startSec = 0, endSec = 10): BlurRegion {
    return createBlurRegion("front", "pixelate", startSec, endSec, 2, rect(0.4, 0.4));
}

describe("regionRectAt", () => {
    it("returns null outside the active span", () => {
        const r = makeRegion(1, 5);
        expect(regionRectAt(r, 0.5)).toBeNull();
        expect(regionRectAt(r, 5.01)).toBeNull();
    });

    it("clamps to the first/last keyframe rect at span edges", () => {
        const r = makeRegion(0, 10);
        upsertKeyframe(r, 6, rect(0.6, 0.5), true);
        // before first keyframe (t=2) -> first rect
        expect(regionRectAt(r, 0)).toEqual(rect(0.4, 0.4));
        // after last keyframe (t=6) -> last rect
        expect(regionRectAt(r, 9.9)).toEqual(rect(0.6, 0.5));
    });

    it("interpolates linearly between keyframes", () => {
        const r = makeRegion(0, 10);
        upsertKeyframe(r, 6, rect(0.6, 0.5, 0.2, 0.1), true);
        const mid = regionRectAt(r, 4);
        expect(mid).not.toBeNull();
        expect(mid!.xPct).toBeCloseTo(0.5, 10);
        expect(mid!.yPct).toBeCloseTo(0.45, 10);
        expect(mid!.wPct).toBeCloseTo(0.15, 10);
        expect(mid!.hPct).toBeCloseTo(0.075, 10);
    });

    it("returns exact rects at keyframe times", () => {
        const r = makeRegion(0, 10);
        upsertKeyframe(r, 6, rect(0.6, 0.5), true);
        expect(regionRectAt(r, 2)).toEqual(rect(0.4, 0.4));
        expect(regionRectAt(r, 6)).toEqual(rect(0.6, 0.5));
    });

    it("holds detector geometry for the displayed frame and stops at its exclusive end", () => {
        const r = makeRegion(2, 6.1);
        r.interpolation = "hold";
        upsertKeyframe(r, 6, rect(0.6, 0.5, 0.2, 0.1), false);
        expect(regionRectAt(r, 5.999)).toEqual(rect(0.4, 0.4));
        expect(regionRectAt(r, 6)).toEqual(rect(0.6, 0.5, 0.2, 0.1));
        expect(regionRectAt(r, 6.099)).toEqual(rect(0.6, 0.5, 0.2, 0.1));
        expect(regionRectAt(r, 6.1)).toBeNull();
        const [copy] = cloneBlurRegions([r]);
        expect(copy!.interpolation).toBe("hold");
        expect(regionRectAt(copy!, 5)).toEqual(rect(0.4, 0.4));
    });

    it("single keyframe region is static over its whole span", () => {
        const r = makeRegion(0, 10);
        for (const t of [0, 2, 5, 10]) {
            expect(regionRectAt(r, t)).toEqual(rect(0.4, 0.4));
        }
    });

    it("matches held source frames on the microsecond-rounded browser clock", () => {
        const r = createBlurRegion("front", "fill", 7 / 30, 10 / 30, 7 / 30, rect(0.1, 0.2));
        r.interpolation = "hold";
        upsertKeyframe(r, 8 / 30, rect(0.3, 0.2), false);
        upsertKeyframe(r, 9 / 30, rect(0.5, 0.2), false);
        expect(regionRectAt(r, 0.233333)).toEqual(rect(0.1, 0.2));
        expect(regionRectAt(r, 0.266667)).toEqual(rect(0.3, 0.2));
        expect(regionRectAt(r, 0.3)).toEqual(rect(0.5, 0.2));
        expect(regionRectAt(r, 0.333333)).toBeNull();
        expect(regionRectAt(r, 0.2333)).toBeNull();
    });

    it("selects the displayed held frame after MSE timestamp quantization", () => {
        const previous = rect(0.4, 0.3);
        const current = rect(0.2, 0.4);
        const r = createBlurRegion("front", "fill", 10.719, 10.8, 10.719, previous);
        r.interpolation = "hold";
        upsertKeyframe(r, 10.759, current, false);

        // The same source frame after 57600 Hz remuxing and browser rounding.
        expect(regionRectAt(r, 10.758993055555555)).toEqual(current);
        expect(regionRectAt(r, 10.758993)).toEqual(current);
        expect(regionRectAt(r, 10.759)).toEqual(current);
        // A genuinely earlier time still belongs to the preceding frame.
        expect(regionRectAt(r, 10.758979)).toEqual(previous);
    });

    it("keeps quantized held starts inclusive and ends exclusive", () => {
        const r = createBlurRegion("front", "fill", 10.719, 10.759, 10.719, rect(0.2, 0.4));
        r.interpolation = "hold";
        expect(regionRectAt(r, 10.718979)).toBeNull();
        expect(regionRectAt(r, 10.718993)).toEqual(rect(0.2, 0.4));
        expect(regionRectAt(r, 10.758979)).toEqual(rect(0.2, 0.4));
        expect(regionRectAt(r, 10.758993)).toBeNull();
        expect(regionRectAt(r, 10.759)).toBeNull();

        const manual = { ...r, interpolation: "linear" as const };
        expect(regionRectAt(manual, 10.718993)).toBeNull();
        expect(regionRectAt(manual, 10.758993)).toEqual(rect(0.2, 0.4));
        expect(regionRectAt(manual, 10.759)).toEqual(rect(0.2, 0.4));
    });

    it("does not snap manual interpolation to a nearby held-frame timestamp", () => {
        const r = createBlurRegion("front", "fill", 10.719, 10.8, 10.719, rect(0.4, 0.3));
        upsertKeyframe(r, 10.759, rect(0.2, 0.4), true);
        const interpolated = regionRectAt(r, 10.758993)!;
        expect(interpolated.xPct).toBeCloseTo(0.200035, 10);
        expect(interpolated.yPct).toBeCloseTo(0.3999825, 10);
        expect(interpolated).not.toEqual(rect(0.2, 0.4));
    });

    it("returns a copy, not the stored rect", () => {
        const r = makeRegion(0, 10);
        const got = regionRectAt(r, 2);
        got!.xPct = 999;
        expect(regionRectAt(r, 2)!.xPct).toBeCloseTo(0.4, 10);
    });
});

describe("upsertKeyframe", () => {
    it("keeps keyframes sorted regardless of insert order", () => {
        const r = makeRegion(0, 20);
        upsertKeyframe(r, 8, rect(0.8, 0.1), true);
        upsertKeyframe(r, 4, rect(0.4, 0.1), true);
        upsertKeyframe(r, 12, rect(0.2, 0.1), true);
        expect(r.keyframes.map((k) => k.contentSec)).toEqual([2, 4, 8, 12]);
    });

    it("replaces a keyframe within the merge epsilon instead of duplicating", () => {
        const r = makeRegion(0, 10);
        upsertKeyframe(r, 2.001, rect(0.7, 0.7), true);
        expect(r.keyframes).toHaveLength(1);
        expect(r.keyframes[0]!.contentSec).toBe(2);
        expect(r.keyframes[0]!.rect.xPct).toBeCloseTo(0.7, 10);
    });

    it("treats adjacent 60fps frame steps as distinct keyframes", () => {
        const r = makeRegion(0, 10);
        upsertKeyframe(r, 2 + 1 / 60, rect(0.5, 0.5), true);
        expect(r.keyframes).toHaveLength(2);
    });

    it("replace keeps pinned=true even when the new write is unpinned", () => {
        const r = makeRegion(0, 10); // keyframe at 2 is pinned
        upsertKeyframe(r, 2, rect(0.5, 0.5), false);
        expect(r.keyframes[0]!.pinned).toBe(true);
    });

    it("an unpinned upsert within the epsilon keeps the pinned keyframe's rect", () => {
        // Contract: user pins stay authoritative over re-tracks. An auto-tracked
        // (unpinned) keyframe merging onto a hand-placed pin must not clobber its
        // geometry - only the pinned flag survives, the rect stays the user's.
        const r = makeRegion(0, 10); // pinned keyframe at t=2, rect (0.4,0.4)
        upsertKeyframe(r, 2, rect(0.9, 0.9), false);
        expect(r.keyframes[0]!.pinned).toBe(true);
        expect(r.keyframes[0]!.rect.xPct).toBeCloseTo(0.4, 10);
        expect(r.keyframes[0]!.rect.yPct).toBeCloseTo(0.4, 10);
    });

    it("a pinned upsert over a pinned keyframe DOES replace the rect (user re-edit)", () => {
        const r = makeRegion(0, 10); // pinned keyframe at t=2
        upsertKeyframe(r, 2, rect(0.6, 0.6), true);
        expect(r.keyframes[0]!.rect.xPct).toBeCloseTo(0.6, 10);
    });

    it("a pinned upsert over an unpinned keyframe replaces the rect and pins it", () => {
        const r = makeRegion(0, 10);
        upsertKeyframe(r, 5, rect(0.3, 0.3), false); // tracked keyframe
        upsertKeyframe(r, 5, rect(0.7, 0.7), true); // user corrects it
        const kf = r.keyframes.find((k) => Math.abs(k.contentSec - 5) < 1e-9)!;
        expect(kf.pinned).toBe(true);
        expect(kf.rect.xPct).toBeCloseTo(0.7, 10);
    });
});

describe("replaceGeneratedKeyframes", () => {
    it("replaces unpinned keyframes in range, keeps pinned and out-of-range ones", () => {
        const r = makeRegion(0, 20); // pinned @2
        upsertKeyframe(r, 5, rect(0.5, 0.5), false);
        upsertKeyframe(r, 15, rect(0.9, 0.9), false); // outside replace range
        replaceGeneratedKeyframes(r, 3, 10, [
            { contentSec: 4, rect: rect(0.41, 0.41) },
            { contentSec: 6, rect: rect(0.42, 0.42) },
        ]);
        expect(r.keyframes.map((k) => k.contentSec)).toEqual([2, 4, 6, 15]);
        expect(r.keyframes[0]!.pinned).toBe(true);
        expect(r.keyframes[1]!.pinned).toBe(false);
    });
});

describe("resolveRegionBlursAt", () => {
    it("filters by channel and active span", () => {
        const front = makeRegion(0, 10);
        const rear = createBlurRegion("rear", "fill", 0, 10, 2, rect(0.1, 0.1));
        const late = createBlurRegion("front", "blur", 20, 30, 25, rect(0.2, 0.2));
        const resolved = resolveRegionBlursAt([front, rear, late], "front", 5);
        expect(resolved).toHaveLength(1);
        expect(resolved[0]!.style).toBe("pixelate");
    });

    it("paints stronger overlapping covers after weaker styles regardless of creation order", () => {
        const coverRect = rect(0.4, 0.4);
        const fill = createBlurRegion("front", "fill", 0, 10, 2, coverRect);
        const soft = createBlurRegion("front", "blur", 0, 10, 2, coverRect);
        const mosaic = createBlurRegion("front", "pixelate", 0, 10, 2, coverRect);
        const regions = [fill, soft, mosaic];

        expect(resolveRegionBlursAt(regions, "front", 5).map((region) => region.style)).toEqual([
            "blur",
            "pixelate",
            "fill",
        ]);
        expect(regions).toEqual([fill, soft, mosaic]);
    });
});

describe("anyRegionIntersectsRange", () => {
    it("detects overlap only for visible channels", () => {
        const r = makeRegion(5, 10);
        expect(anyRegionIntersectsRange([r], ["front"], 0, 6)).toBe(true);
        expect(anyRegionIntersectsRange([r], ["rear"], 0, 6)).toBe(false);
    });

    it("treats boundary-touching ranges as intersecting (one frame still paints)", () => {
        const r = makeRegion(5, 10);
        expect(anyRegionIntersectsRange([r], ["front"], 10, 20)).toBe(true);
        expect(anyRegionIntersectsRange([r], ["front"], 0, 5)).toBe(true);
        expect(anyRegionIntersectsRange([r], ["front"], 10.01, 20)).toBe(false);
    });
});

describe("createBlurRegion", () => {
    it("defaults autoEnd to false - a fresh zone's end is the user's", () => {
        expect(makeRegion().autoEnd).toBe(false);
    });

    it("defaults lastTrackLost to false", () => {
        expect(makeRegion().lastTrackLost).toBe(false);
    });
});

describe("regionHasTrackedKeyframes", () => {
    it("is false with only pinned keyframes, true once an unpinned one exists", () => {
        const r = makeRegion(0, 10);
        expect(regionHasTrackedKeyframes(r)).toBe(false);
        upsertKeyframe(r, 4, rect(0.5, 0.5), false);
        expect(regionHasTrackedKeyframes(r)).toBe(true);
    });
});

describe("inflateRect", () => {
    it("grows symmetrically by the given fraction of each dimension", () => {
        const out = inflateRect(rect(0.4, 0.4, 0.2, 0.1), 0.1);
        // 10% of 0.2 = 0.02 total -> 0.01 each side; of 0.1 = 0.01 -> 0.005 each.
        expect(out.xPct).toBeCloseTo(0.39, 6);
        expect(out.wPct).toBeCloseTo(0.22, 6);
        expect(out.yPct).toBeCloseTo(0.395, 6);
        expect(out.hPct).toBeCloseTo(0.11, 6);
    });

    it("clamps to the [0,1] frame instead of spilling past the edges", () => {
        const out = inflateRect(rect(0, 0, 1, 1), 0.2);
        expect(out.xPct).toBe(0);
        expect(out.yPct).toBe(0);
        expect(out.wPct).toBeLessThanOrEqual(1);
        expect(out.hPct).toBeLessThanOrEqual(1);
    });

    it("never shrinks a rect (privacy: over-cover is the safe direction)", () => {
        const base = rect(0.3, 0.3, 0.1, 0.1);
        const out = inflateRect(base, 0.08);
        expect(out.wPct).toBeGreaterThanOrEqual(base.wPct);
        expect(out.hPct).toBeGreaterThanOrEqual(base.hPct);
    });
});

describe("cloneBlurRegions", () => {
    it("detaches keyframes and rects from later editor mutations", () => {
        const original = makeRegion(0, 10);
        const [snapshot] = cloneBlurRegions([original]);
        expect(snapshot).toBeDefined();

        original.style = "fill";
        original.keyframes[0]!.contentSec = 8;
        original.keyframes[0]!.rect.xPct = 0.9;

        expect(snapshot?.style).toBe("pixelate");
        expect(snapshot?.keyframes[0]?.contentSec).toBe(2);
        expect(snapshot?.keyframes[0]?.rect.xPct).toBe(0.4);
    });
});

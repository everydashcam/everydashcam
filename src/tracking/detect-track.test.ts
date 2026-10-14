import { describe, expect, it } from "vitest";

import { createBlurRegion, regionRectAt } from "../blur-regions.js";
import type { CropRect } from "../transcode/compose.js";
import { appendTrackKeyframe, iou, type TrackKeyframe } from "./detect-track.js";

function rect(xPct: number, yPct: number, wPct = 0.04, hPct = 0.02): CropRect {
    return { xPct, yPct, wPct, hPct };
}

describe("iou", () => {
    it("is 1 for identical rects and 0 for disjoint ones", () => {
        expect(iou(rect(0.5, 0.5), rect(0.5, 0.5))).toBeCloseTo(1);
        expect(iou(rect(0.1, 0.1), rect(0.8, 0.8))).toBe(0);
    });

    it("is fractional for partial overlap", () => {
        // Two 0.1x0.1 boxes offset by half their width: overlap 0.05x0.1.
        const a: CropRect = { xPct: 0, yPct: 0, wPct: 0.1, hPct: 0.1 };
        const b: CropRect = { xPct: 0.05, yPct: 0, wPct: 0.1, hPct: 0.1 };
        // inter = 0.05*0.1 = 0.005; union = 0.01+0.01-0.005 = 0.015.
        expect(iou(a, b)).toBeCloseTo(0.005 / 0.015);
    });
});

function renderedRect(keyframes: TrackKeyframe[], contentSec: number): CropRect {
    const region = createBlurRegion("front", "fill", 0, 100, 0, keyframes[0]!.rect);
    region.keyframes = keyframes.map((keyframe) => ({ ...keyframe, pinned: false }));
    return regionRectAt(region, contentSec)!;
}

describe("appendTrackKeyframe", () => {
    it("covers a small plate throughout a brief lateral reversal", () => {
        const keyframes: TrackKeyframe[] = [];
        const samples = [
            { contentSec: 0, rect: rect(0.5, 0.5, 0.00896, 0.00448) },
            { contentSec: 1 / 15, rect: rect(0.504, 0.5, 0.00896, 0.00448) },
            { contentSec: 2 / 15, rect: rect(0.5, 0.5, 0.00896, 0.00448) },
            { contentSec: 0.2, rect: rect(0.5, 0.5, 0.00896, 0.00448) },
        ];
        for (const sample of samples) appendTrackKeyframe(keyframes, sample.contentSec, sample.rect);
        for (const sample of samples) {
            const cover = renderedRect(keyframes, sample.contentSec);
            expect(cover.xPct, `plate position at ${sample.contentSec}`).toBeCloseTo(sample.rect.xPct);
            expect(cover.wPct).toBeCloseTo(sample.rect.wPct);
        }
    });

    it("preserves small size changes while the target approaches", () => {
        const keyframes: TrackKeyframe[] = [];
        appendTrackKeyframe(keyframes, 0, rect(0.5, 0.5, 0.008, 0.004));
        appendTrackKeyframe(keyframes, 1 / 15, rect(0.499, 0.499, 0.01, 0.006));
        appendTrackKeyframe(keyframes, 2 / 15, rect(0.5, 0.5, 0.008, 0.004));
        const cover = renderedRect(keyframes, 1 / 15);
        expect(cover.wPct).toBeCloseTo(0.01);
        expect(cover.hPct).toBeCloseTo(0.006);
    });

    it("bounds stationary storage without starting subsequent motion early", () => {
        const keyframes: TrackKeyframe[] = [];
        for (let sec = 0; sec <= 60; sec++) appendTrackKeyframe(keyframes, sec, rect(0.5, 0.5));
        expect(keyframes.length).toBeLessThanOrEqual(3);
        appendTrackKeyframe(keyframes, 61, rect(0.6, 0.5));
        expect(renderedRect(keyframes, 59.5).xPct).toBeCloseTo(0.5);
        expect(renderedRect(keyframes, 60).xPct).toBeCloseTo(0.5);
        expect(renderedRect(keyframes, 60.5).xPct).toBeCloseTo(0.55);
    });

    it("keeps the preceding hold when the current observation is replaced", () => {
        const keyframes: TrackKeyframe[] = [];
        for (let sec = 0; sec <= 60; sec++) appendTrackKeyframe(keyframes, sec, rect(0.5, 0.5));
        appendTrackKeyframe(keyframes, 60, rect(0.6, 0.5));
        expect(renderedRect(keyframes, 59).xPct).toBeCloseTo(0.5);
        expect(renderedRect(keyframes, 59.5).xPct).toBeCloseTo(0.55);
        expect(renderedRect(keyframes, 60).xPct).toBeCloseTo(0.6);
        expect(keyframes.filter((keyframe) => keyframe.contentSec === 60)).toHaveLength(1);
    });
});

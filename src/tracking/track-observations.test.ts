import { describe, expect, it } from "vitest";
import { applyTrackResult } from "../blur-follow.js";
import { createBlurRegion, regionRectAt, type BlurRegion } from "../blur-regions.js";
import type { CropRect } from "../transcode/compose.js";
import type { TrackKeyframe } from "./detect-track.js";
import { finalizeFollowEndReason } from "./follow-end.js";
import { appendTrackObservation, type PendingTrackHold, recordTrackHold } from "./track-observations.js";

const a: CropRect = { xPct: 0.1, yPct: 0.2, wPct: 0.1, hPct: 0.05 };
const b: CropRect = { xPct: 0.3, yPct: 0.4, wPct: 0.2, hPct: 0.1 };

function trackedRegion(keyframes: TrackKeyframe[]): BlurRegion {
    const region = createBlurRegion("front", "fill", 0, 5, 0, a);
    region.keyframes = keyframes.map((keyframe) => ({ ...keyframe, pinned: false }));
    return region;
}

describe("Follow observations across uncertain frames", () => {
    it("keeps ordinary observed motion continuous", () => {
        const keyframes: TrackKeyframe[] = [];
        const pending: PendingTrackHold = { previousSec: null, latestSec: null };
        appendTrackObservation(keyframes, pending, 0, a);
        appendTrackObservation(keyframes, pending, 1, b);

        expect(keyframes.map((keyframe) => keyframe.contentSec)).toEqual([0, 1]);
        expect(regionRectAt(trackedRegion(keyframes), 0.5)?.xPct).toBeCloseTo(0.2);
    });

    it("freezes through an occlusion instead of interpolating the recovered box backward", () => {
        const keyframes: TrackKeyframe[] = [];
        const pending: PendingTrackHold = { previousSec: null, latestSec: null };
        appendTrackObservation(keyframes, pending, 0, a);
        for (const sec of [0.1, 0.5, 1, 1.5, 1.9]) recordTrackHold(pending, sec);
        appendTrackObservation(keyframes, pending, 2, b);

        const region = trackedRegion(keyframes);
        expect(keyframes.map((keyframe) => keyframe.contentSec)).toEqual([0, 1.9, 2]);
        for (const sec of [0.1, 0.5, 1, 1.5, 1.9]) expect(regionRectAt(region, sec)).toEqual(a);
        expect(regionRectAt(region, 1.95)?.xPct).toBeCloseTo(0.2);
        expect(regionRectAt(region, 2)).toEqual(b);
    });

    it("keeps the preceding hold when a replacement observation uses the rejected timestamp", () => {
        const keyframes: TrackKeyframe[] = [];
        const pending: PendingTrackHold = { previousSec: null, latestSec: null };
        appendTrackObservation(keyframes, pending, 0, a);
        for (const sec of [0.1, 1, 1.9, 2, 2]) recordTrackHold(pending, sec);
        appendTrackObservation(keyframes, pending, 2, b);

        expect(keyframes.map((keyframe) => keyframe.contentSec)).toEqual([0, 1.9, 2]);
        expect(regionRectAt(trackedRegion(keyframes), 1.9)).toEqual(a);
        expect(regionRectAt(trackedRegion(keyframes), 2)).toEqual(b);
    });

    it("preserves the gap hold when a recovered observation is corrected at the same timestamp", () => {
        const keyframes: TrackKeyframe[] = [];
        const pending: PendingTrackHold = { previousSec: null, latestSec: null };
        appendTrackObservation(keyframes, pending, 0, a);
        for (const sec of [0.1, 1, 1.9]) recordTrackHold(pending, sec);
        appendTrackObservation(keyframes, pending, 2, a);
        appendTrackObservation(keyframes, pending, 2, b);

        expect(regionRectAt(trackedRegion(keyframes), 1)).toEqual(a);
        expect(regionRectAt(trackedRegion(keyframes), 1.9)).toEqual(a);
        expect(regionRectAt(trackedRegion(keyframes), 2)).toEqual(b);
    });

    it("does not add a false hold when the only rejection recovers on that same frame", () => {
        const keyframes: TrackKeyframe[] = [];
        const pending: PendingTrackHold = { previousSec: null, latestSec: null };
        appendTrackObservation(keyframes, pending, 0, a);
        recordTrackHold(pending, 0.1);
        appendTrackObservation(keyframes, pending, 0.1, b);

        expect(keyframes).toEqual([
            { contentSec: 0, rect: a },
            { contentSec: 0.1, rect: b },
        ]);
    });

    it("holds the recovered position across later losses without moving the final good timestamp", () => {
        const keyframes: TrackKeyframe[] = [];
        const pending: PendingTrackHold = { previousSec: null, latestSec: null };
        appendTrackObservation(keyframes, pending, 0, a);
        for (const sec of [0.1, 0.5, 0.9]) recordTrackHold(pending, sec);
        appendTrackObservation(keyframes, pending, 1, b);
        for (const sec of [1.1, 1.5, 1.9]) recordTrackHold(pending, sec);
        const c = { ...b, xPct: 0.5 };
        appendTrackObservation(keyframes, pending, 2, c);
        for (const sec of [2.1, 3, 4]) recordTrackHold(pending, sec);

        const region = trackedRegion(keyframes);
        expect(regionRectAt(region, 0.5)).toEqual(a);
        expect(regionRectAt(region, 1.5)).toEqual(b);
        expect(regionRectAt(region, 4)).toEqual(c);
        expect(keyframes.at(-1)?.contentSec).toBe(2);
    });

    it("ends an unresolved Follow tail at the final trusted observation", () => {
        const keyframes: TrackKeyframe[] = [];
        const pending: PendingTrackHold = { previousSec: null, latestSec: null };
        appendTrackObservation(keyframes, pending, 0, a);
        appendTrackObservation(keyframes, pending, 1, b);
        for (const sec of [1.1, 1.5, 1.9]) recordTrackHold(pending, sec);
        const endReason = finalizeFollowEndReason("completed", {
            initialized: true,
            lossPending: true,
            exitPending: false,
            requestedEndSec: 2,
            lastAnalyzedSec: 1.9,
            analysisIntervalSec: 1 / 15,
        });
        const region = createBlurRegion("front", "fill", 0, 2, 0, a);
        region.autoEnd = true;
        applyTrackResult(region, 0, 2, 2, { keyframes, endReason, trackedUntilSec: 1 });

        expect(endReason).toBe("lost");
        expect(region.lastTrackLost).toBe(true);
        expect(region.endSec).toBe(1);
        expect(region.keyframes.at(-1)?.contentSec).toBe(1);
        expect(regionRectAt(region, 1)).toEqual(b);
        expect(regionRectAt(region, 1.9)).toBeNull();
    });
});

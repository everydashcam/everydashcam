import { describe, expect, it } from "vitest";
import { TrackEdgeConsistency } from "./track-edge-consistency.js";
import { EXIT_CONFIRM_SEC, type TrackBox } from "./track-guards.js";

const FRAME_W = 640;
const FRAME_H = 360;
const box = (x: number, w = 80): TrackBox => ({ x, y: 132, w, h: 34 });

function observe(history: TrackEdgeConsistency, xs: number[], startSec = 0): void {
    for (const [i, x] of xs.entries()) history.observeAccepted(box(x), FRAME_W, FRAME_H, startSec + i / 15);
}

describe("TrackEdgeConsistency", () => {
    it.each(["left", "right", "top", "bottom"] as const)(
        "flags an inward excursion after clipped %s motion",
        (edge) => {
            const history = new TrackEdgeConsistency();
            const at = (offset: number): TrackBox => {
                if (edge === "left") return box(offset);
                if (edge === "right") return box(FRAME_W - 80 - offset);
                if (edge === "top") return { x: 132, y: offset, w: 34, h: 80 };
                return { x: 132, y: FRAME_H - 80 - offset, w: 34, h: 80 };
            };
            for (const [i, x] of [10, 2, -6].entries()) history.observeAccepted(at(x), FRAME_W, FRAME_H, i / 15);
            expect(history.needsVerification(at(4), FRAME_W, FRAME_H, 3 / 15)).toBe(true);
            expect(history.needsVerification(at(-14), FRAME_W, FRAME_H, 3 / 15)).toBe(false);
            expect(history.needsVerification(at(-6), FRAME_W, FRAME_H, 3 / 15)).toBe(false);
        },
    );

    it("retains recent outward evidence across noisy accepted localizations", () => {
        const history = new TrackEdgeConsistency();
        const observations = [
            [1.733, 8, 95],
            [1.8, 0, 96],
            [1.867, -1, 94],
            [1.933, -2, 97],
            [2, 1, 98],
            [2.067, -3, 87],
        ];
        for (const [time, x, w] of observations) history.observeAccepted(box(x!, w), FRAME_W, FRAME_H, time!);
        expect(history.needsVerification(box(6, 96), FRAME_W, FRAME_H, 2.133)).toBe(true);
        expect(history.needsVerification(box(-12, 87), FRAME_W, FRAME_H, 2.133)).toBe(false);
    });

    it.each([
        ["stationary", [-6, -6, -6]],
        ["entering", [-18, -12, -6]],
        ["alternating", [-6, -12, -6]],
        ["unclipped", [18, 10, 2]],
    ] as const)("does not flag %s edge history", (_name, xs) => {
        const history = new TrackEdgeConsistency();
        observe(history, [...xs]);
        expect(history.needsVerification(box(20), FRAME_W, FRAME_H, 0.2)).toBe(false);
    });

    it("requires three accepted model updates and does not count candidate queries", () => {
        const history = new TrackEdgeConsistency();
        observe(history, [2, -6]);
        expect(history.needsVerification(box(20), FRAME_W, FRAME_H, 0.2)).toBe(false);
        expect(history.needsVerification(box(-14), FRAME_W, FRAME_H, 0.2)).toBe(false);
        expect(history.needsVerification(box(20), FRAME_W, FRAME_H, 0.3)).toBe(false);
        history.observeAccepted(box(-14), FRAME_W, FRAME_H, 0.3);
        expect(history.needsVerification(box(0), FRAME_W, FRAME_H, 0.4)).toBe(true);
    });

    it("does not treat size growth without outward center motion as evidence", () => {
        const history = new TrackEdgeConsistency();
        for (const [i, w] of [60, 80, 100].entries()) {
            history.observeAccepted(box(40 - w / 2, w), FRAME_W, FRAME_H, i / 15);
        }
        expect(history.needsVerification(box(10, 100), FRAME_W, FRAME_H, 0.2)).toBe(false);
    });

    it("uses target-relative inward movement with a two-pixel floor", () => {
        const history = new TrackEdgeConsistency();
        observe(history, [10, 2, -6]);
        expect(history.needsVerification(box(1.99), FRAME_W, FRAME_H, 0.2)).toBe(false);
        expect(history.needsVerification(box(2.01), FRAME_W, FRAME_H, 0.2)).toBe(true);
        history.reset();
        for (const [i, x] of [2, 0, -2].entries()) history.observeAccepted(box(x, 10), FRAME_W, FRAME_H, i / 15);
        expect(history.needsVerification(box(-0.01, 10), FRAME_W, FRAME_H, 0.2)).toBe(false);
        expect(history.needsVerification(box(0.01, 10), FRAME_W, FRAME_H, 0.2)).toBe(true);
    });

    it("keeps the geometry consistent across analysis-resolution changes", () => {
        const history = new TrackEdgeConsistency();
        history.observeAccepted(box(10), FRAME_W, FRAME_H, 0);
        const doubled = (b: TrackBox): TrackBox => ({ x: b.x * 2, y: b.y * 2, w: b.w * 2, h: b.h * 2 });
        history.observeAccepted(doubled(box(2)), FRAME_W * 2, FRAME_H * 2, 1 / 15);
        history.observeAccepted(box(-6), FRAME_W, FRAME_H, 2 / 15);
        expect(history.needsVerification(doubled(box(4)), FRAME_W * 2, FRAME_H * 2, 0.2)).toBe(true);
        expect(history.needsVerification(doubled(box(-14)), FRAME_W * 2, FRAME_H * 2, 0.2)).toBe(false);
    });

    it("expires outward history after half a second instead of preserving a stale alarm", () => {
        const history = new TrackEdgeConsistency();
        observe(history, [10, 2, -6], 3600);
        expect(history.needsVerification(box(4), FRAME_W, FRAME_H, 3600.4)).toBe(true);
        expect(history.needsVerification(box(4), FRAME_W, FRAME_H, 3600.501)).toBe(false);
        history.observeAccepted(box(-6), FRAME_W, FRAME_H, 3600.8);
        expect(history.needsVerification(box(4), FRAME_W, FRAME_H, 3600.9)).toBe(false);
    });

    it("does not turn duplicate timestamps into extra motion evidence", () => {
        const history = new TrackEdgeConsistency();
        history.observeAccepted(box(10), FRAME_W, FRAME_H, 0);
        history.observeAccepted(box(2), FRAME_W, FRAME_H, 0);
        history.observeAccepted(box(-6), FRAME_W, FRAME_H, 0.1);
        expect(history.needsVerification(box(4), FRAME_W, FRAME_H, 0.2)).toBe(false);
        expect(history.needsVerification(box(4), FRAME_W, FRAME_H, 0.1)).toBe(false);
        expect(history.needsVerification(box(4), FRAME_W, FRAME_H, 0.09)).toBe(false);
    });

    it("resets motion evidence on an explicit reset or a backward clock discontinuity", () => {
        const history = new TrackEdgeConsistency();
        observe(history, [10, 2, -6]);
        history.reset();
        expect(history.needsVerification(box(4), FRAME_W, FRAME_H, 0.2)).toBe(false);
        observe(history, [10, 2, -6], 1);
        history.observeAccepted(box(-6), FRAME_W, FRAME_H, 0.1);
        expect(history.needsVerification(box(4), FRAME_W, FRAME_H, 0.2)).toBe(false);
    });

    it("ignores invalid candidate geometry and clears invalid accepted history", () => {
        const history = new TrackEdgeConsistency();
        observe(history, [10, 2, -6]);
        expect(history.needsVerification(box(Number.NaN), FRAME_W, FRAME_H, 0.2)).toBe(false);
        expect(history.needsVerification(box(4), 0, FRAME_H, 0.2)).toBe(false);
        expect(history.needsVerification(box(4), FRAME_W, FRAME_H, Number.NaN)).toBe(false);
        expect(history.needsVerification(box(4), FRAME_W, FRAME_H, 0.2)).toBe(true);
        history.observeAccepted(box(0, 0), FRAME_W, FRAME_H, 0.2);
        expect(history.needsVerification(box(4), FRAME_W, FRAME_H, 0.3)).toBe(false);
    });

    it("allows a verified reversal to recover inside the short edge-loss window", () => {
        const history = new TrackEdgeConsistency();
        observe(history, [10, 2, -6]);
        expect(history.needsVerification(box(4), FRAME_W, FRAME_H, 0.2)).toBe(true);
        expect(history.observeRejected(0.2, true)).toBe(false);
        history.observeAccepted(box(4), FRAME_W, FRAME_H, 0.25);
        expect(history.observeRejected(0.4)).toBe(false);
        expect(history.lost).toBe(false);
        history.observeAccepted(box(12), FRAME_W, FRAME_H, 0.45);
        expect(history.lost).toBe(false);
    });

    it("latches continued rejection after an edge alarm until a trusted reset", () => {
        const history = new TrackEdgeConsistency();
        expect(history.observeRejected(0, true)).toBe(false);
        expect(history.observeRejected(EXIT_CONFIRM_SEC / 2)).toBe(false);
        expect(history.observeRejected(EXIT_CONFIRM_SEC)).toBe(true);
        expect(history.lost).toBe(true);
        history.observeAccepted(box(20), FRAME_W, FRAME_H, 0.4);
        expect(history.lost).toBe(true);
        expect(history.observeRejected(0.5)).toBe(true);
        history.reset();
        expect(history.lost).toBe(false);
        expect(history.observeRejected(0.6)).toBe(false);
        history.observeAccepted(box(20), FRAME_W, FRAME_H, 0.7);
        expect(history.lost).toBe(false);
    });

    it("does not arm a short loss window from ordinary low-score rejections", () => {
        const history = new TrackEdgeConsistency();
        observe(history, [10, 2, -6]);
        for (const timeSec of [0.2, 0.4, 1, 3, 5]) {
            expect(history.observeRejected(timeSec)).toBe(false);
            expect(history.lost).toBe(false);
        }
    });

    it("does not restart the recovery deadline when an edge alarm repeats", () => {
        const history = new TrackEdgeConsistency();
        expect(history.observeRejected(0, true)).toBe(false);
        expect(history.observeRejected(EXIT_CONFIRM_SEC / 2, true)).toBe(false);
        expect(history.observeRejected(EXIT_CONFIRM_SEC, true)).toBe(true);
    });

    it("uses increasing tracking time while source frames run backward", () => {
        const history = new TrackEdgeConsistency();
        const sourceTimes = [11, 11 - 1 / 15, 11 - 2 / 15];
        const trackingTimes = sourceTimes.map((time) => sourceTimes[0]! - time);
        expect(history.observeRejected(trackingTimes[0]!, true)).toBe(false);
        expect(history.observeRejected(trackingTimes[1]!)).toBe(false);
        expect(history.observeRejected(trackingTimes[2]!)).toBe(true);
    });

    it("gives a later independent loss a fresh recovery window", () => {
        const history = new TrackEdgeConsistency();
        history.observeRejected(0, true);
        history.observeAccepted(box(4), FRAME_W, FRAME_H, 0.05);
        history.observeAccepted(box(12), FRAME_W, FRAME_H, 0.1);
        expect(history.observeRejected(1, true)).toBe(false);
        expect(history.observeRejected(1.05)).toBe(false);
        expect(history.observeRejected(1.15)).toBe(true);
    });

    it("keeps pending evidence through invalid samples without letting them arm a loss", () => {
        const history = new TrackEdgeConsistency();
        expect(history.observeRejected(Number.NaN, true)).toBe(false);
        expect(history.observeRejected(1)).toBe(false);
        expect(history.observeRejected(2, true)).toBe(false);
        history.observeAccepted(box(0, 0), FRAME_W, FRAME_H, 2.05);
        expect(history.observeRejected(Number.NaN)).toBe(false);
        expect(history.observeRejected(2.15)).toBe(true);
        history.observeAccepted(box(Number.NaN), FRAME_W, FRAME_H, 2.2);
        expect(history.lost).toBe(true);
    });

    it("clears a pending window on reset before starting a different track", () => {
        const history = new TrackEdgeConsistency();
        history.observeRejected(0, true);
        history.reset();
        expect(history.observeRejected(1)).toBe(false);
        expect(history.lost).toBe(false);
        expect(history.needsVerification(box(4), FRAME_W, FRAME_H, 1.1)).toBe(false);
    });
});

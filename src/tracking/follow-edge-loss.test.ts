import { describe, expect, it } from "vitest";
import { FollowEdgeLoss } from "./follow-edge-loss.js";
import { finalizeFollowEndReason } from "./follow-end.js";
import type { TrackBox } from "./track-guards.js";

const W = 1000;
const H = 600;
const box = (x: number, y = 200): TrackBox => ({ x, y, w: 100, h: 40 });

function observeMotion(guard: FollowEdgeLoss, boxes: TrackBox[]): TrackBox {
    for (const [index, b] of boxes.entries()) expect(guard.observe(b, W, H, index * 0.08, true)).toBe(false);
    return boxes[boxes.length - 1]!;
}

describe("FollowEdgeLoss", () => {
    it("confirms a rejected outward edge trajectory before a later background peak can recover it", () => {
        const guard = new FollowEdgeLoss();
        const last = observeMotion(guard, [box(44), box(23), box(-2)]);
        expect(guard.observe(last, W, H, 0.2, false)).toBe(false);
        expect(guard.observe(last, W, H, 0.28, false)).toBe(false);
        expect(guard.observe(last, W, H, 0.36, false)).toBe(true);
    });

    it("keeps the usual recovery budget for an approaching but fully visible target", () => {
        const guard = new FollowEdgeLoss();
        const last = observeMotion(guard, [box(100), box(70), box(40)]);
        for (const time of [0.2, 0.4, 1, 2]) expect(guard.observe(last, W, H, time, false)).toBe(false);
    });

    it("does not shorten loss for stationary or inward-moving clipped targets", () => {
        for (const path of [
            [box(-2), box(-2), box(-2)],
            [box(-40), box(-30), box(-20)],
        ]) {
            const guard = new FollowEdgeLoss();
            const last = observeMotion(guard, path);
            expect(guard.observe(last, W, H, 0.2, false)).toBe(false);
            expect(guard.observe(last, W, H, 1, false)).toBe(false);
        }
    });

    it("clears a pending edge loss when the target turns inward before confirmation", () => {
        const guard = new FollowEdgeLoss();
        const last = observeMotion(guard, [box(40), box(20), box(-2)]);
        expect(guard.observe(last, W, H, 0.2, false)).toBe(false);
        const returning = box(8);
        expect(guard.observe(returning, W, H, 0.28, true)).toBe(false);
        expect(guard.hasPendingLoss).toBe(false);
        expect(guard.observe(returning, W, H, 0.36, false)).toBe(false);
        expect(guard.observe(returning, W, H, 1, false)).toBe(false);
    });

    it("keeps accepted outward tracking and gives a later loss a fresh budget after sustained recovery", () => {
        const guard = new FollowEdgeLoss();
        const last = observeMotion(guard, [box(40), box(20), box(-2)]);
        expect(guard.observe(last, W, H, 0.2, false)).toBe(false);
        expect(guard.observe(box(-10), W, H, 0.28, true)).toBe(false);
        expect(guard.hasPendingLoss).toBe(true);
        expect(guard.observe(box(-20), W, H, 0.36, true)).toBe(false);
        expect(guard.hasPendingLoss).toBe(true);
        const recovered = box(-30);
        expect(guard.observe(recovered, W, H, 0.44, true)).toBe(false);
        expect(guard.hasPendingLoss).toBe(false);
        expect(guard.observe(recovered, W, H, 0.52, false)).toBe(false);
        expect(guard.observe(recovered, W, H, 0.56, false)).toBe(false);
        expect(guard.observe(recovered, W, H, 0.68, false)).toBe(true);
    });

    it("preserves edge uncertainty through one accepted shrinking fragment until another rejection", () => {
        const guard = new FollowEdgeLoss();
        const frameW = 1920;
        const frameH = 1080;
        const clipped = { x: -2, y: 414, w: 97, h: 31 };
        const fragment = { x: 4, y: 412, w: 64, h: 32 };
        guard.observe({ x: 44, y: 426, w: 108, h: 31 }, frameW, frameH, 48.8, true);
        guard.observe({ x: 20, y: 419, w: 104, h: 29 }, frameW, frameH, 48.879, true);
        guard.observe(clipped, frameW, frameH, 48.959, true);
        expect(guard.observe(clipped, frameW, frameH, 49, false)).toBe(false);
        // Its left edge is inside again, but the center still moves outward.
        expect(guard.observe(fragment, frameW, frameH, 49.079, true)).toBe(false);
        expect(guard.hasPendingLoss).toBe(true);
        expect(
            finalizeFollowEndReason("completed", {
                initialized: true,
                lossPending: guard.hasPendingLoss,
                exitPending: false,
                lastAnalyzedSec: 49.079,
                requestedEndSec: 49.079,
                analysisIntervalSec: 1 / 15,
            }),
        ).toBe("lost");
        expect(guard.observe(fragment, frameW, frameH, 49.159, false)).toBe(true);
    });

    it("clears pending edge uncertainty when accepted tracking becomes stationary", () => {
        const guard = new FollowEdgeLoss();
        const last = observeMotion(guard, [box(40), box(20), box(-2)]);
        expect(guard.observe(last, W, H, 0.2, false)).toBe(false);
        expect(guard.hasPendingLoss).toBe(true);
        expect(guard.observe(last, W, H, 0.28, true)).toBe(false);
        expect(guard.hasPendingLoss).toBe(false);
        expect(guard.observe(last, W, H, 0.36, false)).toBe(false);
        expect(guard.observe(last, W, H, 0.5, false)).toBe(false);
    });

    it("clears pending uncertainty when a localized fragment is safely inside the frame", () => {
        const guard = new FollowEdgeLoss();
        const last = observeMotion(guard, [box(40), box(20), box(-2)]);
        expect(guard.observe(last, W, H, 0.2, false)).toBe(false);
        const recovered = { ...box(35), w: 10 };
        expect(guard.observe(recovered, W, H, 0.28, true)).toBe(false);
        expect(guard.hasPendingLoss).toBe(false);
        expect(guard.observe(recovered, W, H, 0.36, false)).toBe(false);
    });

    it("clears an already pending edge loss across a stale source gap", () => {
        const guard = new FollowEdgeLoss();
        const last = observeMotion(guard, [box(40), box(20), box(-2)]);
        expect(guard.observe(last, W, H, 0.2, false)).toBe(false);
        expect(guard.hasPendingLoss).toBe(true);
        expect(guard.observe(last, W, H, 1, false)).toBe(false);
        expect(guard.hasPendingLoss).toBe(false);
        expect(guard.observe(last, W, H, 1.2, false)).toBe(false);
    });

    it("ignores small edge jitter and centered growth", () => {
        for (const path of [
            [box(1), box(0), box(-1)],
            [
                { ...box(0), w: 100 },
                { ...box(-5), w: 110 },
                { ...box(-10), w: 120 },
            ],
        ]) {
            const guard = new FollowEdgeLoss();
            const last = observeMotion(guard, path);
            expect(guard.observe(last, W, H, 0.2, false)).toBe(false);
            expect(guard.observe(last, W, H, 0.4, false)).toBe(false);
        }
    });

    it("requires recent accepted motion rather than an old recovery trajectory", () => {
        const guard = new FollowEdgeLoss();
        guard.observe(box(40), W, H, 0, true);
        guard.observe(box(20), W, H, 0.08, true);
        guard.observe(box(-2), W, H, 1, true);
        expect(guard.observe(box(-2), W, H, 1.08, false)).toBe(false);
        expect(guard.observe(box(-2), W, H, 1.4, false)).toBe(false);
    });

    it("does not arm from old accepted motion after a source gap", () => {
        const guard = new FollowEdgeLoss();
        const last = observeMotion(guard, [box(40), box(20), box(-2)]);
        expect(guard.observe(last, W, H, 1, false)).toBe(false);
        expect(guard.observe(last, W, H, 1.2, false)).toBe(false);
    });

    it("uses normalized motion across a resolution change", () => {
        const guard = new FollowEdgeLoss();
        guard.observe(box(40), W, H, 0, true);
        guard.observe(box(20), W, H, 0.08, true);
        const resized = { x: -4, y: 400, w: 200, h: 80 };
        guard.observe(resized, W * 2, H * 2, 0.16, true);
        expect(guard.observe(resized, W * 2, H * 2, 0.2, false)).toBe(false);
        expect(guard.observe(resized, W * 2, H * 2, 0.36, false)).toBe(true);
    });

    it("recognizes outward motion on the right, top, and bottom edges", () => {
        const paths = [
            [box(850), box(880), box(910)],
            [box(200, 40), box(200, 20), box(200, -2)],
            [box(200, 520), box(200, 545), box(200, 570)],
        ];
        for (const path of paths) {
            const guard = new FollowEdgeLoss();
            const last = observeMotion(guard, path);
            expect(guard.observe(last, W, H, 0.2, false)).toBe(false);
            expect(guard.observe(last, W, H, 0.36, false)).toBe(true);
        }
    });
});

import { describe, expect, it } from "vitest";

import { SIZE_GUARD_WARMUP_FRAMES, type TrackBox } from "./track-guards.js";
import { TrackGeometry } from "./track-state.js";

const FRAME_W = 854;
const FRAME_H = 480;
const DT = 1 / 15;

function centered(w: number, h: number): TrackBox {
    return { x: (FRAME_W - w) / 2, y: (FRAME_H - h) / 2, w, h };
}

function settle(geometry: TrackGeometry, frameW = FRAME_W, frameH = FRAME_H): void {
    for (let i = 0; i < SIZE_GUARD_WARMUP_FRAMES; i++) {
        geometry.advanceFrame(frameW, frameH, DT);
        expect(geometry.acceptCandidate(geometry.box), `warmup frame ${i}`).toBe(true);
    }
}

describe("TrackGeometry", () => {
    it("recovers gradual scale growth across a low-confidence frame", () => {
        const geometry = new TrackGeometry(centered(100, 50), FRAME_W, FRAME_H);
        settle(geometry);
        // No candidate on the obscured frame; the next prediction spans two
        // steps of approximately 15% growth, each below the rate limit.
        geometry.advanceFrame(FRAME_W, FRAME_H, DT);
        geometry.advanceFrame(FRAME_W, FRAME_H, DT);
        expect(geometry.acceptCandidate(centered(132, 66))).toBe(true);
        expect(geometry.box).toEqual(centered(132, 66));

        // Accepted predictions reset the elapsed time, so the following frame
        // cannot borrow the occlusion's allowance for a fresh size jump.
        geometry.advanceFrame(FRAME_W, FRAME_H, DT);
        expect(geometry.acceptCandidate(centered(175, 88))).toBe(false);
        expect(geometry.box).toEqual(centered(132, 66));
    });

    it("keeps the age of the accepted box after a rejected prediction", () => {
        const geometry = new TrackGeometry(centered(100, 50), FRAME_W, FRAME_H);
        settle(geometry);
        geometry.advanceFrame(FRAME_W, FRAME_H, DT);
        expect(geometry.acceptCandidate(centered(132, 66))).toBe(false);
        expect(geometry.box).toEqual(centered(100, 50));
        geometry.advanceFrame(FRAME_W, FRAME_H, DT);
        expect(geometry.acceptCandidate(centered(132, 66))).toBe(true);
    });

    it("preserves the normalized search box when the analysis canvas changes", () => {
        const geometry = new TrackGeometry({ x: 960, y: 540, w: 38, h: 22 }, 1920, 1080);
        settle(geometry, 1920, 1080);
        geometry.advanceFrame(1280, 720, DT);
        const smaller = geometry.box;
        expect(smaller.x).toBeCloseTo(640);
        expect(smaller.y).toBeCloseTo(360);
        expect(smaller.w / 1280).toBeCloseTo(38 / 1920);
        expect(smaller.h / 720).toBeCloseTo(22 / 1080);
        expect(geometry.acceptCandidate(smaller)).toBe(true);

        geometry.advanceFrame(1920, 1080, DT);
        expect(geometry.box.x).toBeCloseTo(960);
        expect(geometry.box.y).toBeCloseTo(540);
        expect(geometry.box.w).toBeCloseTo(38);
        expect(geometry.box.h).toBeCloseTo(22);
        expect(geometry.acceptCandidate(geometry.box)).toBe(true);
    });

    it("scales both axes independently while the target remains partly outside", () => {
        const geometry = new TrackGeometry({ x: -20, y: 80, w: 100, h: 50 }, 1000, 500);
        geometry.advanceFrame(500, 300, DT);
        expect(geometry.box).toEqual({ x: -10, y: 48, w: 50, h: 30 });
        expect(geometry.acceptCandidate(geometry.box)).toBe(true);
    });

    it("scales the seed cap without renewing it from an already grown box", () => {
        const geometry = new TrackGeometry(centered(50, 30), FRAME_W, FRAME_H);
        geometry.advanceFrame(FRAME_W, FRAME_H, DT);
        expect(geometry.acceptCandidate(centered(140, 80))).toBe(true);

        geometry.advanceFrame(FRAME_W / 2, FRAME_H / 2, 0.5);
        const scaled = geometry.box;
        expect(scaled.w).toBeCloseTo(70);
        expect(scaled.h).toBeCloseTo(40);
        expect(geometry.acceptCandidate(scaled)).toBe(true);
        geometry.advanceFrame(FRAME_W / 2, FRAME_H / 2, 0.5);
        // Only a 14% increase, but beyond the original seed's scaled 75px cap.
        expect(geometry.acceptCandidate({ ...scaled, x: scaled.x - 5, w: 80 })).toBe(false);
    });

    it("stops a gradual balloon through accepted predictions and a resize", () => {
        const geometry = new TrackGeometry(centered(FRAME_W * 0.05, FRAME_H * 0.05), FRAME_W, FRAME_H);
        settle(geometry);
        let scale = 1;
        let stopped = false;
        for (let step = 1; step <= 30; step++) {
            if (step === 10) scale = 0.5;
            geometry.advanceFrame(FRAME_W * scale, FRAME_H * scale, DT);
            const current = geometry.box;
            const next = {
                x: current.x - current.w * 0.025,
                y: current.y - current.h * 0.025,
                w: current.w * 1.05,
                h: current.h * 1.05,
            };
            if (!geometry.acceptCandidate(next)) {
                stopped = true;
                expect(step, "small plausible steps precede the total growth limit").toBeGreaterThan(10);
                expect(geometry.box).toEqual(current);
                break;
            }
            expect(geometry.box.w / (FRAME_W * scale)).toBeLessThanOrEqual(0.15);
        }
        expect(stopped, "the chain stops before a small seed becomes a large cover").toBe(true);
    });

    it("keeps the absolute cap after an extended loss", () => {
        const geometry = new TrackGeometry(centered(20, 12), FRAME_W, FRAME_H);
        settle(geometry);
        geometry.advanceFrame(FRAME_W, FRAME_H, 10);
        expect(geometry.acceptCandidate(centered(220, 130))).toBe(false);
        expect(geometry.box).toEqual(centered(20, 12));
    });
});

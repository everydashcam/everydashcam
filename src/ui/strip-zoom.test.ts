import { describe, expect, it } from "vitest";

import {
    applyPinchZoom,
    applyWheelZoom,
    computeEffectiveMinViewSpan,
    computeFollowPan,
    resizeZoomViewEdge,
    wheelZoomScaleFactor,
    type ZoomViewState,
} from "./strip-zoom.js";

describe("resizeZoomViewEdge", () => {
    const dur = 10; // minSpan = 0.1

    it("moves the start while keeping the end fixed", () => {
        expect(resizeZoomViewEdge({ viewStartPct: 0, viewEndPct: 0.8 }, "start", 0.25, dur)).toEqual({
            viewStartPct: 0.25,
            viewEndPct: 0.8,
        });
    });

    it("moves the end while keeping the start fixed", () => {
        expect(resizeZoomViewEdge({ viewStartPct: 0.2, viewEndPct: 1 }, "end", 0.65, dur)).toEqual({
            viewStartPct: 0.2,
            viewEndPct: 0.65,
        });
    });

    it("clamps edges to the trip bounds", () => {
        expect(resizeZoomViewEdge({ viewStartPct: 0.2, viewEndPct: 0.8 }, "start", -1, dur)).toEqual({
            viewStartPct: 0,
            viewEndPct: 0.8,
        });
        expect(resizeZoomViewEdge({ viewStartPct: 0.2, viewEndPct: 0.8 }, "end", 2, dur)).toEqual({
            viewStartPct: 0.2,
            viewEndPct: 1,
        });
    });

    it("expands either edge back to the full view", () => {
        expect(resizeZoomViewEdge({ viewStartPct: 0.2, viewEndPct: 1 }, "start", 0, dur)).toEqual({
            viewStartPct: 0,
            viewEndPct: 1,
        });
        expect(resizeZoomViewEdge({ viewStartPct: 0, viewEndPct: 0.8 }, "end", 1, dur)).toEqual({
            viewStartPct: 0,
            viewEndPct: 1,
        });
    });

    it("preserves the minimum duration-aware span when an edge crosses the other", () => {
        const start = resizeZoomViewEdge({ viewStartPct: 0.2, viewEndPct: 0.6 }, "start", 0.9, dur);
        expect(start.viewStartPct).toBeCloseTo(0.5, 6);
        expect(start.viewEndPct).toBeCloseTo(0.6, 6);

        const end = resizeZoomViewEdge({ viewStartPct: 0.4, viewEndPct: 0.8 }, "end", 0.1, dur);
        expect(end.viewStartPct).toBeCloseTo(0.4, 6);
        expect(end.viewEndPct).toBeCloseTo(0.5, 6);
    });

    it("preserves a narrower programmatic span without jumping to the normal floor", () => {
        const view = { viewStartPct: 0.4, viewEndPct: 0.45 };
        const gestureMinSpan = computeEffectiveMinViewSpan(dur, view.viewEndPct - view.viewStartPct);
        expect(gestureMinSpan).toBeCloseTo(0.05, 6);

        const expanded = resizeZoomViewEdge(view, "start", 0.38, dur, gestureMinSpan);
        expect(expanded.viewStartPct).toBeCloseTo(0.38, 6);
        expect(expanded.viewEndPct - expanded.viewStartPct).toBeCloseTo(0.07, 6);

        const crossed = resizeZoomViewEdge(expanded, "start", 0.44, dur, gestureMinSpan);
        expect(crossed.viewStartPct).toBeCloseTo(0.4, 6);
        expect(crossed.viewEndPct - crossed.viewStartPct).toBeCloseTo(0.05, 6);
    });
});

describe("applyWheelZoom", () => {
    it("zooms out smoothly from a view below the normal floor", () => {
        const view = { viewStartPct: 0.4, viewEndPct: 0.45 };
        const next = applyWheelZoom(view, 0.5, 240, 10);
        expect(next).not.toBeNull();
        const span = next!.viewEndPct - next!.viewStartPct;
        expect(span).toBeGreaterThan(0.05);
        expect(span).toBeLessThan(0.1);
    });

    it("does not zoom farther in from a view below the normal floor", () => {
        expect(applyWheelZoom({ viewStartPct: 0.4, viewEndPct: 0.45 }, 0.5, -240, 10)).toBeNull();
    });
});

describe("wheelZoomScaleFactor", () => {
    const composeEvents = (deltaYPx: number, count: number, isCtrlWheel = false): number => {
        let scale = 1;
        for (let i = 0; i < count; i++) scale *= wheelZoomScaleFactor(deltaYPx, isCtrlWheel);
        return scale;
    };

    it("zooms one classic wheel notch by one 15% step", () => {
        expect(wheelZoomScaleFactor(-100, false)).toBeCloseTo(1.15, 6);
        expect(wheelZoomScaleFactor(100, false)).toBeCloseTo(1 / 1.15, 6);
    });

    it("zooms high-resolution sub-notch events about as much as one notch in total", () => {
        // A high-resolution wheel splits one notch into several small events.
        expect(composeEvents(-12.5, 8)).toBeCloseTo(Math.exp(0.15), 6);
    });

    it("does not saturate the zoom range from a burst of small events", () => {
        // A fixed 15% step per event would reach 8x after fifteen events of any size.
        const scale = composeEvents(-12.5, 15);
        expect(scale).toBeGreaterThan(1);
        expect(scale).toBeLessThan(1.5);
    });

    it("zooms in and out symmetrically for opposite deltas", () => {
        expect(wheelZoomScaleFactor(-40, false) * wheelZoomScaleFactor(40, false)).toBeCloseTo(1, 12);
        expect(wheelZoomScaleFactor(-500, false) * wheelZoomScaleFactor(500, false)).toBeCloseTo(1, 12);
    });

    it("caps a single large event at one notch", () => {
        expect(wheelZoomScaleFactor(-800, false)).toBeCloseTo(1.15, 6);
        expect(wheelZoomScaleFactor(-100, true), "ctrl + mouse wheel notch").toBeCloseTo(1.15, 6);
    });

    it("follows a Chromium trackpad pinch 1:1", () => {
        // Chromium encodes a pinch update of scale s as deltaY = -100 * ln(s).
        const pinchDelta = (scale: number) => -100 * Math.log(scale);
        expect(wheelZoomScaleFactor(pinchDelta(1.05), true)).toBeCloseTo(1.05, 6);
        expect(wheelZoomScaleFactor(pinchDelta(0.97), true)).toBeCloseTo(0.97, 6);
    });

    it("returns 1 for zero and non-finite deltas", () => {
        expect(wheelZoomScaleFactor(0, false)).toBe(1);
        expect(wheelZoomScaleFactor(Number.NaN, true)).toBe(1);
        expect(wheelZoomScaleFactor(Number.POSITIVE_INFINITY, false)).toBe(1);
    });
});

// applyPinchZoom is pure + deterministic - no DOM, safe to run in parallel.
describe("applyPinchZoom", () => {
    const dur = 600; // 10 min trip - minSpan = max(0.001, 1/600) ~= 0.00167

    it("zooms in around a centered centroid, halving the span", () => {
        const start: ZoomViewState = { viewStartPct: 0.2, viewEndPct: 0.6 }; // span 0.4
        // distRatio 2 = fingers spread to twice the start distance.
        const next = applyPinchZoom(start, 0.5, 0.5, 2, dur);
        expect(next.viewStartPct).toBeCloseTo(0.3, 6);
        expect(next.viewEndPct).toBeCloseTo(0.5, 6);
    });

    it("zooms out (fingers pinched together), doubling the span", () => {
        const start: ZoomViewState = { viewStartPct: 0.3, viewEndPct: 0.5 }; // span 0.2
        const next = applyPinchZoom(start, 0.5, 0.5, 0.5, dur);
        expect(next.viewStartPct).toBeCloseTo(0.2, 6);
        expect(next.viewEndPct).toBeCloseTo(0.6, 6);
    });

    it("keeps the start-centroid content point under the moving centroid (zoom + pan)", () => {
        // Centroid starts at 0.0 (left edge of window 0.2..0.6 -> content 0.2) and
        // ends at 1.0; zooming in by 2x should pin content 0.2 to the right edge.
        const start: ZoomViewState = { viewStartPct: 0.2, viewEndPct: 0.6 };
        const next = applyPinchZoom(start, 0, 1, 2, dur);
        const span = next.viewEndPct - next.viewStartPct;
        expect(span).toBeCloseTo(0.2, 6);
        // content 0.2 under currentCentroidRatio 1 -> it sits at viewEndPct.
        expect(next.viewEndPct).toBeCloseTo(0.2, 6);
        // ...so the window clamps to [0, 0.2] (newStart would be 0, never negative).
        expect(next.viewStartPct).toBeCloseTo(0, 6);
    });

    it("clamps to the right edge without overshooting 1", () => {
        const start: ZoomViewState = { viewStartPct: 0.6, viewEndPct: 1 }; // span 0.4
        const next = applyPinchZoom(start, 1, 1, 2, dur);
        expect(next.viewStartPct).toBeCloseTo(0.8, 6);
        expect(next.viewEndPct).toBeCloseTo(1, 6);
    });

    it("clamps zoom-out to the full [0, 1] overview", () => {
        const start: ZoomViewState = { viewStartPct: 0.2, viewEndPct: 0.6 };
        const next = applyPinchZoom(start, 0.5, 0.5, 0.1, dur);
        expect(next.viewStartPct).toBe(0);
        expect(next.viewEndPct).toBe(1);
    });

    it("never shrinks below the minimum span for the trip duration", () => {
        const shortDur = 10; // minSpan = max(0.001, min(0.5, 0.1)) = 0.1
        const start: ZoomViewState = { viewStartPct: 0, viewEndPct: 0.1 }; // span 0.1 (already min)
        const next = applyPinchZoom(start, 0.5, 0.5, 100, shortDur);
        expect(next.viewEndPct - next.viewStartPct).toBeCloseTo(0.1, 6);
    });

    it("preserves a narrower programmatic span as the pinch floor", () => {
        const start: ZoomViewState = { viewStartPct: 0.4, viewEndPct: 0.45 };
        const inward = applyPinchZoom(start, 0.5, 0.5, 2, 10);
        expect(inward.viewEndPct - inward.viewStartPct).toBeCloseTo(0.05, 6);

        const outward = applyPinchZoom(start, 0.5, 0.5, 0.8, 10);
        expect(outward.viewEndPct - outward.viewStartPct).toBeCloseTo(0.0625, 6);
    });

    it("does not produce NaN when fingers report zero distance ratio", () => {
        const start: ZoomViewState = { viewStartPct: 0.2, viewEndPct: 0.6 };
        const next = applyPinchZoom(start, 0.5, 0.5, 0, dur);
        expect(Number.isFinite(next.viewStartPct)).toBe(true);
        expect(Number.isFinite(next.viewEndPct)).toBe(true);
        // distRatio 0 -> span explodes -> clamps to full overview.
        expect(next.viewStartPct).toBe(0);
        expect(next.viewEndPct).toBe(1);
    });
});

// computeFollowPan is pure + deterministic - no DOM, safe to run in parallel.
describe("computeFollowPan", () => {
    it("does not pan while the playhead sits comfortably inside the window", () => {
        // span 0.2, playhead at rel 0.5 - well below the 0.85 trigger.
        expect(computeFollowPan(0.4, 0.6, 0.5)).toBeNull();
    });

    it("pans forward once the playhead crosses the trailing trigger, re-seating it at the anchor", () => {
        // span 0.2; playhead at 0.58 = rel 0.9 (>= 0.85). New start puts it at
        // rel 0.15 -> newStart = 0.58 - 0.15*0.2 = 0.55.
        const next = computeFollowPan(0.4, 0.6, 0.58);
        expect(next).not.toBeNull();
        expect(next!).toBeCloseTo(0.55, 6);
        // Same span preserved (caller keeps viewEnd = newStart + span).
    });

    it("recenters when the playhead fell left of the window after a backward seek", () => {
        // playhead at 0.30, window [0.4, 0.6] -> rel < 0. newStart = 0.30 - 0.03 = 0.27.
        const next = computeFollowPan(0.4, 0.6, 0.3);
        expect(next).not.toBeNull();
        expect(next!).toBeCloseTo(0.27, 6);
    });

    it("clamps at the trip end and returns null when the window is already pinned there", () => {
        // span 0.2, window already at the right edge [0.8, 1.0], playhead near end.
        // Desired newStart clamps to 1 - span = 0.8 = current start -> null (no churn).
        expect(computeFollowPan(0.8, 1.0, 0.98)).toBeNull();
    });

    it("returns null for a full-overview (non-zoomed) view", () => {
        expect(computeFollowPan(0, 1, 0.9)).toBeNull();
    });
});

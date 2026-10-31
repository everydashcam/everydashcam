import { describe, expect, it } from "vitest";

import {
    ANALYSIS_BASE_WIDTH,
    ANALYSIS_WIDTH_CAP,
    analysisFrameHeight,
    chooseAnalysisWidth,
} from "./analysis-resolution.js";

function rect(wPct: number, hPct: number): { xPct: number; yPct: number; wPct: number; hPct: number } {
    return { xPct: 0.4, yPct: 0.4, wPct, hPct };
}

describe("chooseAnalysisWidth", () => {
    it("keeps the base width for a large seed (whole-vehicle zone)", () => {
        expect(chooseAnalysisWidth(rect(0.3, 0.3), 1920, 1080)).toBe(ANALYSIS_BASE_WIDTH);
    });

    it("goes to the cap for a plate-sized seed on a 1080p source", () => {
        expect(chooseAnalysisWidth(rect(0.03, 0.02), 1920, 1080)).toBe(ANALYSIS_WIDTH_CAP);
    });

    it("picks an intermediate width for a mid-size seed", () => {
        // sqrt(0.08 * 0.06 * 0.5625) per px -> needs ~1231 px for the 64px
        // target; floored to even.
        expect(chooseAnalysisWidth(rect(0.08, 0.06), 1920, 1080)).toBe(1230);
    });

    it("never upscales past the source width", () => {
        expect(chooseAnalysisWidth(rect(0.03, 0.02), 1280, 720)).toBe(1280);
    });

    it("uses the source width when the source is below the base", () => {
        expect(chooseAnalysisWidth(rect(0.03, 0.02), 640, 480)).toBe(640);
    });

    it("caps a 4K source at the width ceiling", () => {
        expect(chooseAnalysisWidth(rect(0.02, 0.015), 3840, 2160)).toBe(ANALYSIS_WIDTH_CAP);
    });

    it("falls back to the base width when display dims are unknown", () => {
        expect(chooseAnalysisWidth(rect(0.03, 0.02), 0, 0)).toBe(ANALYSIS_BASE_WIDTH);
    });

    it("treats a degenerate zero-area seed as maximally demanding, within clamps", () => {
        expect(chooseAnalysisWidth(rect(0, 0), 1920, 1080)).toBe(ANALYSIS_WIDTH_CAP);
    });
});

describe("analysisFrameHeight", () => {
    it("keeps the square-pixel display aspect, rounded to whole pixels", () => {
        expect(analysisFrameHeight(854, 1920, 1080, 0)).toBe(480);
        expect(analysisFrameHeight(1000, 2560, 1440, 0)).toBe(563);
    });

    it("swaps the axes for a quarter-turn rotation", () => {
        expect(analysisFrameHeight(854, 1920, 1080, 90)).toBe(1518);
        expect(analysisFrameHeight(854, 1920, 1080, 180)).toBe(480);
        expect(analysisFrameHeight(854, 1920, 1080, 270)).toBe(1518);
    });
});

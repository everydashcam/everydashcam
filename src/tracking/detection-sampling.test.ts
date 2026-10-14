import { describe, expect, it } from "vitest";

import { createDetectionSampler, type DetectionQuality } from "./detection-sampling.js";

function sampledIndices(quality: DetectionQuality, fps: number, seconds: number): number[] {
    const sample = createDetectionSampler(quality, 0);
    const indices: number[] = [];
    for (let index = 0; index <= fps * seconds; index++) {
        if (sample(index / fps, index === fps * seconds)) indices.push(index);
    }
    return indices;
}

describe("detection discovery cadence", () => {
    it.each([30, 60])("keeps the one-second grid without drift at %i fps", (fps) => {
        expect(sampledIndices("fast", fps, 3)).toEqual([0, fps, 2 * fps, 3 * fps]);
    });

    it("keeps quarter-second discovery at 30 fps despite alternating frame counts", () => {
        expect(sampledIndices("balanced", 30, 2)).toEqual([0, 8, 15, 23, 30, 38, 45, 53, 60]);
    });

    it("keeps quarter-second discovery at 60 fps", () => {
        expect(sampledIndices("balanced", 60, 2)).toEqual([0, 15, 30, 45, 60, 75, 90, 105, 120]);
    });

    it("selects every source frame in thorough mode", () => {
        expect(sampledIndices("thorough", 30, 1)).toEqual(Array.from({ length: 31 }, (_, index) => index));
    });

    it("keeps a fractional trim's displayed predecessor and the final off-grid frame", () => {
        const sample = createDetectionSampler("balanced", 3.02);
        const times = [3, 3 + 1 / 30, 3.25, 3.3, 3.5, 3.51];
        expect(times.filter((time, index) => sample(time, index === times.length - 1))).toEqual([3, 3.3, 3.51]);
    });

    it("resumes at the next grid position after a timestamp jump", () => {
        const sample = createDetectionSampler("fast", 0);
        const times = [0, 0.5, 2.4, 2.9, 3, 3.5, 4];
        expect(times.filter((time) => sample(time))).toEqual([0, 2.4, 3, 4]);
    });

    it("preserves detector endpoint overrides without applying Follow duplicate filtering", () => {
        const sample = createDetectionSampler("balanced", 10.02);
        expect(sample(10)).toBe(true);
        expect(sample(10)).toBe(false);
        expect(sample(10.01)).toBe(false);
        expect(sample(10.27)).toBe(true);
        expect(sample(10.28, true)).toBe(true);
        expect(sample(10.28, true)).toBe(true);
        const thorough = createDetectionSampler("thorough", 10.02);
        expect(thorough(10)).toBe(true);
        expect(thorough(10)).toBe(true);
    });

    it("preserves detector timing validation after sharing its grid", () => {
        expect(() => createDetectionSampler("balanced", Number.NaN)).toThrow("detection sampling anchor is invalid");
        const sample = createDetectionSampler("balanced", 0);
        expect(() => sample(Number.POSITIVE_INFINITY)).toThrow("detection sampling timestamp is invalid");
        expect(sample(0)).toBe(true);
        expect(sample(0.25)).toBe(true);
    });

    it("exposes a brief object's absent fast seed and its balanced discovery", () => {
        const positiveSamples = (quality: DetectionQuality): number[] => {
            const select = createDetectionSampler(quality, 0);
            const out: number[] = [];
            for (let index = 0; index < 60; index++) {
                const sec = index / 30;
                if (select(sec, index === 59) && sec >= 0.2 && sec < 0.6) out.push(index);
            }
            return out;
        };
        expect(positiveSamples("fast")).toEqual([]);
        expect(positiveSamples("balanced")).toEqual([8, 15]);
    });
});

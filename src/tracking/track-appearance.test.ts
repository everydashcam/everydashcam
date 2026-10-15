import { describe, expect, it } from "vitest";

import {
    APPEARANCE_SIZE,
    appearanceMismatch,
    buildAppearanceSample,
    compareAppearance,
    TrackAppearanceReference,
} from "./track-appearance.js";

function pixels(value: (x: number, y: number) => number, width = APPEARANCE_SIZE, height = APPEARANCE_SIZE) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const gray = value(x, y);
            rgba.set([gray, gray, gray, 255], (y * width + x) * 4);
        }
    }
    return rgba;
}

function pattern(x: number, y: number): number {
    if (x >= 3 && x < 7 && y >= 3 && y < 27) return 200;
    if (x >= 12 && x < 27 && y >= 5 && y < 9) return 170;
    if (x >= 12 && x < 16 && y >= 9 && y < 23) return 130;
    return 50;
}

const reference = buildAppearanceSample(pixels(pattern), 32, 32);

describe("appearance comparison", () => {
    it("distinguishes a fixed spatial pattern from an unrelated orientation", () => {
        const identical = compareAppearance(reference, buildAppearanceSample(pixels(pattern), 32, 32));
        const unrelated = compareAppearance(
            reference,
            buildAppearanceSample(
                pixels((x, y) => pattern(y, 31 - x)),
                32,
                32,
            ),
        );
        expect(identical.alignedNcc).toBeCloseTo(1);
        expect(identical.spatialHogCosine).toBeCloseTo(1);
        expect(identical.hasInformation).toBe(true);
        expect(unrelated.alignedNcc).toBeLessThan(0.5);
        expect(unrelated.spatialHogCosine).toBeLessThan(0.5);
        expect(reference.validPixelCount).toBe(1024);
        expect(reference.variance).toBeGreaterThan(0);
        expect(reference.edgeEnergy).toBeGreaterThan(0);
    });

    it.each([
        { scale: 0.5, offset: 0 },
        { scale: 0.5, offset: 80 },
    ])("preserves uniform contrast and brightness changes: %j", ({ scale, offset }) => {
        const candidate = buildAppearanceSample(
            pixels((x, y) => pattern(x, y) * scale + offset),
            32,
            32,
        );
        const result = compareAppearance(reference, candidate);
        expect(result.alignedNcc).toBeCloseTo(1);
        expect(result.spatialHogCosine).toBeCloseTo(1);
        expect(candidate.variance / reference.variance).toBeCloseTo(scale ** 2);
        expect(candidate.edgeEnergy / reference.edgeEnergy).toBeCloseTo(scale ** 2);
    });

    it("aligns a two-pixel crop displacement using only overlapping valid pixels", () => {
        const candidate = buildAppearanceSample(
            pixels((x, y) => (x >= 2 ? pattern(x - 2, y) : 0)),
            32,
            32,
            {
                x: 2 / 32,
                y: 0,
                w: 30 / 32,
                h: 1,
            },
        );
        const result = compareAppearance(reference, candidate);
        expect(result.alignedNcc).toBeCloseTo(1);
        expect(result.alignedValidPixelCount).toBe(30 * 32);
        expect(result.validPixelCount).toBe(30 * 32);
        expect(result.visibleFraction).toBe(30 / 32);
    });

    it("excludes masked padding from both luminance and gradient comparisons", () => {
        const valid = { x: 0.25, y: 0, w: 0.75, h: 1 };
        const black = buildAppearanceSample(
            pixels((x, y) => (x < 8 ? 0 : pattern(x, y))),
            32,
            32,
            valid,
        );
        const bright = buildAppearanceSample(
            pixels((x, y) => (x < 8 ? 255 : pattern(x, y))),
            32,
            32,
            valid,
        );
        for (const sample of [black, bright]) {
            const result = compareAppearance(reference, sample);
            expect(result.alignedNcc).toBeCloseTo(1);
            expect(result.spatialHogCosine).toBeCloseTo(1);
            expect(result.visibleFraction).toBe(0.75);
        }
        expect(black.variance).toBeCloseTo(bright.variance);
        expect(black.edgeEnergy).toBeCloseTo(bright.edgeEnergy);
    });

    it("normalizes a doubled-resolution input without changing its object coordinates", () => {
        const doubled = buildAppearanceSample(
            pixels((x, y) => pattern(Math.floor(x / 2), Math.floor(y / 2)), 64, 64),
            64,
            64,
        );
        const result = compareAppearance(reference, doubled);
        expect(result.alignedNcc).toBeCloseTo(1);
        expect(result.spatialHogCosine).toBeCloseTo(1);
    });

    it("reports insufficient information for flat, empty, or single-pixel crops", () => {
        const flat = buildAppearanceSample(
            pixels(() => 128),
            32,
            32,
        );
        const empty = buildAppearanceSample(pixels(pattern), 32, 32, { x: 0, y: 0, w: 0, h: 0 });
        const single = buildAppearanceSample(pixels(pattern), 32, 32, { x: 0, y: 0, w: 1 / 32, h: 1 / 32 });
        for (const sample of [flat, empty, single]) {
            expect(sample.hasInformation).toBe(false);
            const result = compareAppearance(reference, sample);
            expect(result.hasInformation).toBe(false);
            expect(result.alignedNcc).toBeNull();
            expect(result.spatialHogCosine).toBeNull();
        }
        expect(empty.visibleFraction).toBe(0);
        expect(single.validPixelCount).toBe(1);
    });

    it("takes an independent frozen sample without retaining or mutating input pixels", () => {
        const rgba = pixels(pattern);
        const frozen = buildAppearanceSample(rgba, 32, 32);
        rgba.fill(0);
        const before = frozen.luminance.slice();
        compareAppearance(frozen, reference);
        compareAppearance(frozen, buildAppearanceSample(rgba, 32, 32));
        expect(frozen.luminance).toEqual(before);
        expect(compareAppearance(frozen, reference).alignedNcc).toBeCloseTo(1);
    });

    it("rejects invalid dimensions, rectangles, and nonfinite sampled pixels", () => {
        expect(() => buildAppearanceSample([], 0, 0)).toThrow("invalid appearance pixels");
        expect(() => buildAppearanceSample(pixels(pattern), 31, 32)).toThrow("invalid appearance pixels");
        expect(() => buildAppearanceSample(pixels(pattern), 32, 32, { x: Number.NaN, y: 0, w: 1, h: 1 })).toThrow();
        expect(() => buildAppearanceSample(pixels(pattern), 32, 32, { x: 0, y: 0, w: -1, h: 1 })).toThrow();
        const invalid = Float32Array.from(pixels(pattern));
        invalid[0] = Number.NaN;
        expect(() => buildAppearanceSample(invalid, 32, 32)).toThrow("invalid appearance pixels");
    });
});

describe("appearanceMismatch", () => {
    const unrelatedPixels = pixels((x, y) => pattern((x + 16) % 32, (y + 16) % 32));
    const unrelated = buildAppearanceSample(unrelatedPixels, 32, 32);

    it("reports a clear spatial change while preserving the original pattern and illumination", () => {
        expect(appearanceMismatch(reference, unrelated)).toBe(true);
        expect(appearanceMismatch(reference, reference)).toBe(false);
        const dimmed = buildAppearanceSample(
            pixels((x, y) => pattern(x, y) * 0.5 + 50),
            32,
            32,
        );
        expect(appearanceMismatch(reference, dimmed)).toBe(false);
    });

    it("does not reject when only the spatial-gradient descriptor changes strongly", () => {
        const rotated = buildAppearanceSample(
            pixels((x, y) => pattern(y, 31 - x)),
            32,
            32,
        );
        const comparison = compareAppearance(reference, rotated);
        expect(comparison.alignedNcc).toBeGreaterThan(0.25);
        expect(comparison.spatialHogCosine).toBeLessThan(0.5);
        expect(appearanceMismatch(reference, rotated)).toBe(false);
    });

    it("abstains when either sample lacks usable contrast or edge detail", () => {
        const flat = buildAppearanceSample(
            pixels(() => 128),
            32,
            32,
        );
        const faint = buildAppearanceSample(
            pixels((x, y) => pattern(x, y) * 0.05 + 100),
            32,
            32,
        );
        const gradual = buildAppearanceSample(
            pixels((x) => 100 + x),
            32,
            32,
        );
        for (const sample of [flat, faint, gradual]) {
            expect(appearanceMismatch(reference, sample)).toBe(false);
            expect(appearanceMismatch(sample, unrelated)).toBe(false);
        }
    });

    it("abstains for small visible fragments and insufficient common support", () => {
        const fragment = buildAppearanceSample(unrelatedPixels, 32, 32, { x: 0.75, y: 0, w: 0.25, h: 1 });
        expect(appearanceMismatch(reference, fragment)).toBe(false);
        expect(appearanceMismatch(fragment, reference)).toBe(false);

        const left = buildAppearanceSample(pixels(pattern), 32, 32, { x: 0, y: 0, w: 0.55, h: 1 });
        const right = buildAppearanceSample(unrelatedPixels, 32, 32, { x: 0.45, y: 0, w: 0.55, h: 1 });
        expect(left.visibleFraction).toBeGreaterThan(0.35);
        expect(right.visibleFraction).toBeGreaterThan(0.35);
        expect(compareAppearance(left, right).visibleFraction).toBeLessThan(0.35);
        expect(appearanceMismatch(left, right)).toBe(false);
    });
});

describe("TrackAppearanceReference", () => {
    const occluder = buildAppearanceSample(
        pixels((x, y) => pattern((x + 16) % 32, (y + 16) % 32)),
        32,
        32,
    );
    const ambiguous = buildAppearanceSample(
        pixels((x, y) => pattern(y, 31 - x)),
        32,
        32,
    );
    const recovered = buildAppearanceSample(
        pixels((x, y) => pattern(x, y) * 0.5 + 50),
        32,
        32,
    );

    function guard(): TrackAppearanceReference {
        const result = new TrackAppearanceReference();
        result.setSeed(reference);
        return result;
    }

    it("latches a patterned occlusion until the original target returns with strong appearance", () => {
        const state = guard();
        expect(state.rejects(reference)).toBe(false);
        expect(state.needsVerification).toBe(false);
        expect(state.rejects(occluder)).toBe(true);
        expect(state.needsVerification).toBe(true);
        expect(state.rejects(recovered)).toBe(false);
        expect(state.needsVerification).toBe(false);
    });

    it("keeps an ambiguous neighbor uncertain even though it is not a clear mismatch", () => {
        expect(appearanceMismatch(reference, ambiguous)).toBe(false);
        const state = guard();
        expect(state.rejects(occluder)).toBe(true);
        for (let i = 0; i < 3; i++) {
            expect(state.rejects(ambiguous)).toBe(true);
            expect(state.needsVerification).toBe(true);
        }
        expect(state.rejects(reference)).toBe(false);
        expect(state.needsVerification).toBe(false);
    });

    it("requires positive confirmation on a suspicious transition without a preceding mismatch", () => {
        const state = guard();
        expect(state.rejects(ambiguous)).toBe(false);
        expect(state.rejects(ambiguous, { requireConfirmation: true })).toBe(true);
        expect(state.needsVerification).toBe(true);
        expect(state.rejects(recovered, { requireConfirmation: true })).toBe(false);
        expect(state.needsVerification).toBe(false);
    });

    it("cannot recover on missing pixels, low detail, or insufficient visible support", () => {
        const state = guard();
        const flat = buildAppearanceSample(
            pixels(() => 128),
            32,
            32,
        );
        const fragment = buildAppearanceSample(pixels(pattern), 32, 32, { x: 0, y: 0, w: 0.25, h: 1 });
        expect(state.rejects(null, { requireConfirmation: true })).toBe(true);
        for (const candidate of [null, flat, fragment]) {
            expect(state.rejects(candidate)).toBe(true);
            expect(state.needsVerification).toBe(true);
        }
        expect(state.rejects(reference)).toBe(false);
    });

    it("abstains without a usable reference and resets uncertainty for a new seed", () => {
        const state = new TrackAppearanceReference();
        const flat = buildAppearanceSample(
            pixels(() => 128),
            32,
            32,
        );
        for (const seed of [null, flat]) {
            state.setSeed(seed);
            expect(state.rejects(occluder, { requireConfirmation: true })).toBe(false);
            expect(state.rejects(null, { requireConfirmation: true })).toBe(false);
            expect(state.needsVerification).toBe(false);
        }
        state.setSeed(reference);
        expect(state.rejects(occluder)).toBe(true);
        state.setSeed(occluder);
        expect(state.needsVerification).toBe(false);
        expect(state.rejects(occluder, { requireConfirmation: true })).toBe(false);
        expect(state.rejects(reference)).toBe(true);
        state.setSeed(null);
        expect(state.needsVerification).toBe(false);
        expect(state.rejects(null)).toBe(false);
    });

    it("keeps an independent reference when the caller reuses sample arrays", () => {
        const sample = buildAppearanceSample(pixels(pattern), 32, 32);
        const state = new TrackAppearanceReference();
        state.setSeed(sample);
        sample.luminance.fill(0);
        sample.valid.fill(0);
        sample.gradientMagnitude.fill(0);
        sample.gradientBin.fill(0);
        expect(state.rejects(occluder)).toBe(true);
        expect(state.rejects(reference)).toBe(false);
    });

    it("rejects provisional weak matches without making later ambiguous frames uncertain", () => {
        const state = guard();
        for (const candidate of [ambiguous, occluder, null]) {
            expect(state.rejects(candidate, { provisional: true })).toBe(true);
            expect(state.needsVerification).toBe(false);
            expect(state.rejects(ambiguous)).toBe(false);
        }
    });

    it("preserves an existing mismatch on failed provisional checks and clears it on confirmation", () => {
        const state = guard();
        expect(state.rejects(occluder)).toBe(true);
        for (const candidate of [ambiguous, null]) {
            expect(state.rejects(candidate, { provisional: true })).toBe(true);
            expect(state.needsVerification).toBe(true);
        }
        expect(state.rejects(recovered, { provisional: true })).toBe(false);
        expect(state.needsVerification).toBe(false);
    });

    it("cannot rescue a weak response without usable seed and candidate information", () => {
        const state = new TrackAppearanceReference();
        expect(state.rejects(reference, { provisional: true })).toBe(true);
        state.setSeed(reference);
        const flat = buildAppearanceSample(
            pixels(() => 128),
            32,
            32,
        );
        const fragment = buildAppearanceSample(pixels(pattern), 32, 32, { x: 0, y: 0, w: 0.25, h: 1 });
        for (const candidate of [flat, fragment, null]) {
            expect(state.rejects(candidate, { provisional: true })).toBe(true);
            expect(state.needsVerification).toBe(false);
        }
        state.setSeed(flat);
        expect(state.rejects(reference, { provisional: true })).toBe(true);
    });
});

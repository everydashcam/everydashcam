import { describe, expect, it } from "vitest";

import { measureTexture, TrackTextureReference, type TextureSample } from "./track-texture.js";

function sample(value: (x: number, y: number) => number): TextureSample {
    const rgba = new Uint8ClampedArray(32 * 32 * 4);
    for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
            const gray = value(x, y);
            rgba.set([gray, gray, gray, 255], (y * 32 + x) * 4);
        }
    }
    return { ...measureTexture(rgba, 32, 32), visibleFraction: 1 };
}

const textured = sample((x, y) => ((x + y) % 2 ? 192 : 64));
const smooth = sample((x) => 112 + x);
const flat = sample(() => 128);

function reference(seed = textured): TrackTextureReference {
    const result = new TrackTextureReference();
    result.setSeed(seed);
    return result;
}

describe("TrackTextureReference", () => {
    it("accepts unchanged detail and rejects a smooth low-contrast replacement", () => {
        const guard = reference();
        expect(guard.rejects(textured)).toBe(false);
        expect(guard.rejects(smooth)).toBe(true);
        expect(guard.rejects(flat)).toBe(true);
    });

    it.each([0.5, 0.25])("preserves texture under brightness and contrast scaling by %s", (scale) => {
        const guard = reference();
        const dimmed = sample((x, y) => ((x + y) % 2 ? 192 : 64) * scale);
        const lowerContrast = sample((x, y) => 128 + (((x + y) % 2 ? 192 : 64) - 128) * scale);
        expect(dimmed.variance / textured.variance).toBeCloseTo(scale ** 2);
        expect(dimmed.edgeEnergy / textured.edgeEnergy).toBeCloseTo(scale ** 2);
        expect(guard.rejects(dimmed)).toBe(false);
        expect(guard.rejects(lowerContrast)).toBe(false);
    });

    it("skips seeds with insufficient variance or edge energy", () => {
        expect(reference(flat).rejects(flat)).toBe(false);
        expect(reference(smooth).rejects(flat)).toBe(false);
        expect(reference({ ...textured, variance: 24 }).rejects(flat)).toBe(false);
        expect(reference({ ...textured, edgeEnergy: 3 }).rejects(flat)).toBe(false);
    });

    it("skips clipped candidate and seed crops instead of treating black padding as lost detail", () => {
        expect(reference().rejects({ ...flat, visibleFraction: 0.89 })).toBe(false);
        expect(reference({ ...textured, visibleFraction: 0.89 }).rejects(flat)).toBe(false);
        expect(reference().rejects({ ...flat, visibleFraction: 0.9 })).toBe(true);
    });

    it("avoids capture only when existing seed or candidate-visibility rules disable rejection", () => {
        const box = { x: 20, y: 10, w: 100, h: 40 };
        const guard = reference();
        expect(guard.needsCapture(box, 200, 100)).toBe(true);
        for (const seed of [flat, smooth, { ...textured, visibleFraction: 0.89 }]) {
            const disabled = reference(seed);
            expect(disabled.needsCapture(box, 200, 100)).toBe(false);
            expect(disabled.rejects(flat)).toBe(false);
        }
        expect(guard.needsCapture({ ...box, x: -11 }, 200, 100)).toBe(false);
        expect(guard.rejects({ ...flat, visibleFraction: 0.89 })).toBe(false);
        expect(guard.needsCapture({ ...box, x: -10 }, 200, 100)).toBe(true);
        expect(guard.rejects({ ...flat, visibleFraction: 0.9 })).toBe(true);
        expect(guard.needsCapture({ ...box, w: 0 }, 200, 100)).toBe(false);
        expect(guard.needsCapture({ ...box, x: Number.NaN }, 200, 100)).toBe(false);
        guard.setSeed(null);
        expect(guard.needsCapture(box, 200, 100)).toBe(false);
        guard.setSeed(textured);
        expect(guard.needsCapture(box, 200, 100)).toBe(true);
    });

    it("keeps its reference fixed through both accepted and rejected candidates", () => {
        const guard = reference();
        expect(guard.rejects(textured)).toBe(false);
        for (let i = 0; i < 4; i++) expect(guard.rejects(smooth)).toBe(true);
        expect(guard.rejects(textured)).toBe(false);
    });

    it("refreshes the reference only on an explicit trusted seed update", () => {
        const guard = reference();
        expect(guard.rejects(smooth)).toBe(true);
        guard.setSeed(smooth);
        expect(guard.rejects(smooth)).toBe(false);
        expect(guard.rejects(flat)).toBe(false);
        guard.setSeed(textured);
        expect(guard.rejects(smooth)).toBe(true);
    });

    it("copies the seed and safely ignores absent or nonfinite measurements", () => {
        const seed = { ...textured };
        const guard = reference(seed);
        seed.variance = 0;
        expect(guard.rejects(smooth)).toBe(true);
        expect(guard.rejects(null)).toBe(false);
        expect(guard.rejects({ ...flat, variance: Number.NaN })).toBe(false);
        guard.setSeed(null);
        expect(guard.rejects(flat)).toBe(false);
    });

    it("requires both strict collapse thresholds", () => {
        const guard = reference();
        expect(guard.rejects({ ...flat, variance: textured.variance * 0.25 })).toBe(false);
        expect(
            guard.rejects({ ...flat, variance: textured.variance * 0.2, edgeEnergy: textured.edgeEnergy * 0.1 }),
        ).toBe(false);
    });
});

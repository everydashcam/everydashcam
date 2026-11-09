import { describe, expect, it } from "vitest";

import { farDotRadiusPx, foldFarTrips } from "./far-dots.js";
import { worldUnitsPerPixel } from "./world.js";

function tripAt(id: number, x: number, y: number, sizePx: number, step: number) {
    const size = sizePx * worldUnitsPerPixel(step);
    return { id, bounds: { minX: x, minY: y, maxX: x + size, maxY: y + size } };
}

describe("foldFarTrips", () => {
    it("folds small nearby trips into one dot and leaves readable ones as lines", () => {
        const step = 6;
        const unit = worldUnitsPerPixel(step);
        // World-anchored grid: keep the trips inside one 34 px cell.
        const base = Math.ceil(0.52 / (34 * unit)) * 34 * unit;
        const dots = foldFarTrips(
            [
                tripAt(1, base + 2 * unit, base + 2 * unit, 3, step),
                tripAt(2, base + 8 * unit, base + 5 * unit, 2, step),
                tripAt(3, base + 12 * unit, base + 10 * unit, 4, step),
                tripAt(4, base + 4 * unit, base + 4 * unit, 40, step),
            ],
            step,
        );

        expect(dots).toHaveLength(1);
        expect(dots[0]!.tripIds).toEqual([1, 2, 3]);
        expect(dots[0]!.bounds.minX).toBeCloseTo(base + 2 * unit, 12);
    });

    it("stops folding a trip once it is large enough at a closer step", () => {
        const trip = tripAt(1, 0.5, 0.3, 5, 6);

        expect(foldFarTrips([trip], 6)).toHaveLength(1);
        expect(foldFarTrips([trip], 7)).toHaveLength(0);
    });
});

describe("farDotRadiusPx", () => {
    it("draws one trip small and grows a group with its count up to a cap", () => {
        expect(farDotRadiusPx(1)).toBe(5);
        expect(farDotRadiusPx(2)).toBe(9.6);
        expect(farDotRadiusPx(16)).toBeGreaterThan(farDotRadiusPx(4));
        expect(farDotRadiusPx(100_000)).toBe(20);
    });
});

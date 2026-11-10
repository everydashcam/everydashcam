import { describe, expect, it } from "vitest";

import { BUNDLE_MAX_STEP } from "./bundle.js";
import { farDotRadiusPx, farTrips, groupFarDots } from "./far-dots.js";
import { worldUnitsPerPixel } from "./world.js";

function tripAt(id: number, x: number, y: number, sizePx: number, step: number) {
    const size = sizePx * worldUnitsPerPixel(step);
    return { id, bounds: { minX: x, minY: y, maxX: x + size, maxY: y + size } };
}

/** A world coordinate on a 34 px grid line at `step`, so test trips stay inside one cell. */
function cellCorner(step: number): number {
    const cell = 34 * worldUnitsPerPixel(step);
    return Math.ceil(0.52 / cell) * cell;
}

describe("farTrips", () => {
    it("keeps the trips too small to read as a line and leaves readable ones out", () => {
        const step = 6;
        // Sides of 3, 40 and 6 px: diagonals of 4.2, 57 and 8.5 px against the 9 px fold.
        const trips = [tripAt(1, 0.5, 0.3, 3, step), tripAt(2, 0.6, 0.3, 40, step), tripAt(3, 0.7, 0.3, 6, step)];

        expect(farTrips(trips, step).map(({ id }) => id)).toEqual([1, 3]);
    });

    it("stops folding a trip once it is large enough at a closer step", () => {
        const trip = tripAt(1, 0.5, 0.3, 5, 6);

        expect(farTrips([trip], 6)).toHaveLength(1);
        expect(farTrips([trip], 7)).toHaveLength(0);
    });
});

describe("groupFarDots", () => {
    it("groups nearby far trips into one dot over their joint bounds", () => {
        const step = 6;
        const unit = worldUnitsPerPixel(step);
        const base = cellCorner(step);
        const dots = groupFarDots(
            [
                tripAt(1, base + 2 * unit, base + 2 * unit, 3, step),
                tripAt(2, base + 8 * unit, base + 5 * unit, 2, step),
                tripAt(3, base + 12 * unit, base + 10 * unit, 4, step),
            ],
            step,
        );

        expect(dots).toHaveLength(1);
        expect(dots[0]!.tripIds).toEqual([1, 2, 3]);
        expect(dots[0]!.bounds.minX).toBeCloseTo(base + 2 * unit, 12);
    });

    it("splits stays that share a dot once the map zooms past the last line step", () => {
        const lineStep = BUNDLE_MAX_STEP;
        const unit = worldUnitsPerPixel(lineStep);
        const base = cellCorner(lineStep);
        // Two parked trips 20 px apart at the last line step: one dot there.
        const stays = [
            tripAt(1, base + 4 * unit, base + 4 * unit, 0, lineStep),
            tripAt(2, base + 24 * unit, base + 4 * unit, 0, lineStep),
        ];
        expect(farTrips(stays, lineStep), "both fold at the last line step").toHaveLength(2);

        expect(groupFarDots(stays, lineStep).map((dot) => dot.tripIds)).toEqual([[1, 2]]);
        expect(groupFarDots(stays, lineStep + 2).map((dot) => dot.tripIds)).toEqual([[1], [2]]);
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

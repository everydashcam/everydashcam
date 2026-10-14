import { describe, expect, it } from "vitest";

import type { CropRect } from "../transcode/compose.js";
import { type RawDetection, tileRects } from "./detect-common.js";
import { filterRecoveryDetections, planDetectionRecovery } from "./detection-recovery.js";

const rect: CropRect = { xPct: 0.1, yPct: 0.3, wPct: 0.1, hPct: 0.04 };
const box: RawDetection = { x: 100, y: 300, w: 100, h: 40, score: 0.8 };

describe("planDetectionRecovery", () => {
    it("uses the visible ViT search square with truncation toward zero", () => {
        const plan = planDetectionRecovery(
            [{ xPct: 0.04, yPct: 0.2, wPct: 0.1, hPct: 0.05 }],
            1000,
            500,
            tileRects(1000, 500),
        );
        expect(plan.regions).toEqual([
            { box: { x: 40, y: 100, w: 100, h: 25 }, roi: { sx: 0, sy: 13, sw: 190, sh: 200 } },
        ]);
    });

    it("preserves fractional crop origins and original grid coordinates", () => {
        const tiles = tileRects(1000, 500);
        const plan = planDetectionRecovery(
            [{ xPct: 0.1005, yPct: 0.2005, wPct: 0.081, hPct: 0.042 }],
            1000,
            500,
            tiles,
        );
        expect(plan.regions[0]!.roi).toEqual({ sx: 58.5, sy: 28.25, sw: 165, sh: 165 });
        expect(plan.tiles).toEqual(tiles);
        expect(plan.tiles[0]).toBe(tiles[0]);
    });

    it("unions overlapping recovery searches once in original grid order", () => {
        const tiles = tileRects(3840, 2160);
        const lost = { xPct: 363.6 / 3840, yPct: 1577.1 / 2160, wPct: 196.35 / 3840, hPct: 105.45 / 2160 };
        const original = structuredClone(tiles);
        const plan = planDetectionRecovery([lost, lost], 3840, 2160, [...tiles, { ...tiles[6]! }]);
        expect(plan.tiles).toEqual([tiles[3], tiles[6]]);
        expect(plan.tiles[0]).toBe(tiles[3]);
        expect(plan.tiles[1]).toBe(tiles[6]);
        expect(tiles).toEqual(original);
    });

    it("never selects more than the original grid for a frame-sized search", () => {
        const tiles = tileRects(3840, 2160);
        const plan = planDetectionRecovery([{ xPct: 0, yPct: 0, wPct: 1, hPct: 1 }], 3840, 2160, tiles);
        expect(plan.regions[0]!.roi).toEqual({ sx: 0, sy: 0, sw: 3840, sh: 2160 });
        expect(plan.tiles).toEqual(tiles);
    });

    it("ignores invalid and completely off-frame boxes without reviving exited objects", () => {
        const invalid = [
            { ...rect, xPct: Number.NaN },
            { ...rect, wPct: Number.POSITIVE_INFINITY },
            { ...rect, wPct: 0 },
            { ...rect, hPct: -0.1 },
            { ...rect, xPct: 1 },
            { ...rect, xPct: -0.2 },
            { ...rect, yPct: 1 },
        ];
        expect(planDetectionRecovery(invalid, 1000, 1000, tileRects(1000, 1000))).toEqual({ regions: [], tiles: [] });
        expect(planDetectionRecovery([], 1000, 1000, tileRects(1000, 1000))).toEqual({ regions: [], tiles: [] });
        expect(planDetectionRecovery([rect], 0, 1000, []).regions).toEqual([]);
        expect(planDetectionRecovery([rect], 1000, Number.NaN, []).regions).toEqual([]);
    });

    it("keeps partial boxes and clips searches to the visible frame", () => {
        const plan = planDetectionRecovery([{ ...rect, xPct: -0.02 }], 1000, 1000, tileRects(1000, 1000));
        expect(plan.regions[0]!.box).toEqual({ x: -20, y: 300, w: 100, h: 40 });
        expect(plan.regions[0]!.roi.sx).toBe(0);
        expect(plan.regions[0]!.roi.sw).toBe(157);
    });

    it("ignores invalid grid entries and tiles that only touch the search edge", () => {
        const inside = { sx: 0, sy: 0, sw: 300, sh: 300 };
        const touching = { sx: 277, sy: 194, sw: 100, sh: 100 };
        const plan = planDetectionRecovery([rect], 1000, 1000, [
            inside,
            touching,
            { ...inside, sw: 0 },
            { ...inside, sy: Number.NaN },
        ]);
        expect(plan.tiles).toEqual([inside]);
    });
});

describe("filterRecoveryDetections", () => {
    const plan = planDetectionRecovery([rect], 1000, 1000, tileRects(1000, 1000));

    it("requires the unchanged seed floor and ignores unrelated detections in a selected tile", () => {
        const accepted = { ...box, score: 0.7 };
        const detections = [accepted, { ...box, score: 0.699 }, { ...box, x: 700, score: 0.99 }];
        const result = filterRecoveryDetections(detections, plan, 0.7, 1000, 1000);
        expect(result).toEqual([accepted]);
        expect(result[0]).toBe(accepted);
    });

    it("checks both size dimensions while allowing half to double the trusted size", () => {
        const small = { ...box, w: 50, h: 20 };
        const large = { ...box, w: 200, h: 80 };
        expect(
            filterRecoveryDetections(
                [small, large, { ...box, w: 49 }, { ...box, h: 19 }, { ...box, w: 201 }, { ...box, h: 81 }],
                plan,
                0.7,
                1000,
                1000,
            ),
        ).toEqual([small, large]);
    });

    it("preserves a strong partial plate without replacing raw size by its visible fragment", () => {
        const lost = { xPct: 157.2 / 3840, yPct: 1626 / 2160, wPct: 212.7 / 3840, hPct: 122.4 / 2160 };
        const partial = { x: -1.65, y: 1683, w: 136.575, h: 132.3, score: 0.73095703125 };
        const edgePlan = planDetectionRecovery([lost], 3840, 2160, tileRects(3840, 2160));
        expect(filterRecoveryDetections([partial], edgePlan, 0.7, 3840, 2160)).toEqual([partial]);
    });

    it("requires position and size to match the same lost object", () => {
        const other = { xPct: 0.8, yPct: 0.3, wPct: 0.01, hPct: 0.004 };
        const combined = planDetectionRecovery([rect, other], 1000, 1000, tileRects(1000, 1000));
        expect(filterRecoveryDetections([{ ...box, w: 10, h: 4 }], combined, 0.7, 1000, 1000)).toEqual([]);
    });

    it("fails closed on invalid boxes, scores, dimensions and seed floors", () => {
        expect(
            filterRecoveryDetections(
                [
                    { ...box, score: Number.NaN },
                    { ...box, score: Number.POSITIVE_INFINITY },
                    { ...box, x: Number.NaN },
                    { ...box, h: 0 },
                    { ...box, w: -1 },
                    { ...box, x: -1000 },
                ],
                plan,
                0.7,
                1000,
                1000,
            ),
        ).toEqual([]);
        expect(filterRecoveryDetections([box], plan, Number.NaN, 1000, 1000)).toEqual([]);
        expect(filterRecoveryDetections([box], plan, -1, 1000, 1000)).toEqual([]);
        expect(filterRecoveryDetections([box], plan, 0.7, 1000, Number.POSITIVE_INFINITY)).toEqual([]);
        expect(filterRecoveryDetections([box], { regions: [], tiles: [] }, 0.7, 1000, 1000)).toEqual([]);
    });
});

import { describe, expect, it } from "vitest";
import { inflateRect } from "../blur-regions.js";
import { boxToRect, visibleBoxRect } from "./box-geometry.js";

describe("tracking box geometry", () => {
    it("keeps raw geometry unclipped while clipping its displayed cover", () => {
        const box = { x: -40, y: 20, w: 80, h: 40 };
        const rect = boxToRect(box, 1000, 500);
        expect(rect.xPct).toBeCloseTo(-0.04);
        expect(rect.wPct).toBeCloseTo(0.08);

        const cover = visibleBoxRect(box, 1000, 500, 0.2)!;
        expect(cover.xPct).toBe(0);
        expect(cover.wPct).toBeCloseTo(0.048);
        expect(cover.yPct).toBeCloseTo(0.032);
        expect(cover.hPct).toBeCloseTo(0.096);
        expect(box).toEqual({ x: -40, y: 20, w: 80, h: 40 });
    });

    it("clips both ends after padding a box crossing the top and right edges", () => {
        const cover = visibleBoxRect({ x: 970, y: -20, w: 60, h: 40 }, 1000, 500, 0.2)!;
        expect(cover.xPct).toBeCloseTo(0.964);
        expect(cover.wPct).toBeCloseTo(0.036);
        expect(cover.yPct).toBe(0);
        expect(cover.hPct).toBeCloseTo(0.048);
    });

    it("does not bring fully outside boxes back into the frame with padding", () => {
        for (const box of [
            { x: -80, y: 20, w: 80, h: 40 },
            { x: 1000, y: 20, w: 80, h: 40 },
            { x: 40, y: -40, w: 80, h: 40 },
            { x: 40, y: 500, w: 80, h: 40 },
        ]) {
            expect(visibleBoxRect(box, 1000, 500, 0.35)).toBeNull();
        }
    });

    it("rejects invalid detector geometry before it can create a cover", () => {
        expect(visibleBoxRect({ x: Number.NaN, y: 20, w: 80, h: 40 }, 1000, 500, 0.2)).toBeNull();
        expect(visibleBoxRect({ x: 40, y: 20, w: 0, h: 40 }, 1000, 500, 0.2)).toBeNull();
        expect(visibleBoxRect({ x: 40, y: 20, w: 80, h: -40 }, 1000, 500, 0.2)).toBeNull();
        expect(visibleBoxRect({ x: 40, y: 20, w: 80, h: 40 }, 0, 500, 0.2)).toBeNull();
    });

    it("clips an ordinary edge cover without moving its opposite edge", () => {
        const rect = inflateRect({ xPct: 0, yPct: 0, wPct: 0.1, hPct: 0.2 }, 0.2);
        expect(rect.xPct).toBe(0);
        expect(rect.yPct).toBe(0);
        expect(rect.wPct).toBeCloseTo(0.11);
        expect(rect.hPct).toBeCloseTo(0.22);
    });
});

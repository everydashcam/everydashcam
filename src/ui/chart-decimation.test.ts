import { describe, expect, it } from "vitest";

import { type ChartPoint, decimateGapAware } from "./chart-decimation.js";

function series(length: number, y: (index: number) => number = (index) => Math.sin(index / 50)): ChartPoint[] {
    return Array.from({ length }, (_, index) => ({ x: index, y: y(index) }));
}

/** Source indices of `points` in `source`, by object identity. */
function sourceIndicesOf(source: readonly ChartPoint[], points: readonly ChartPoint[]): number[] {
    const indexOf = new Map(source.map((point, index) => [point, index]));
    return points.map((point) => indexOf.get(point)!);
}

describe("decimateGapAware", () => {
    it("returns the window unchanged when it already fits the budget", () => {
        const data = series(300);
        const out = decimateGapAware(data, 50, 150, 200);
        expect(out).toEqual(data.slice(50, 200));
    });

    it("reduces a gap-free series to exactly the budget, keeping both endpoints", () => {
        const data = series(10_000);
        const out = decimateGapAware(data, 0, data.length, 200);
        expect(out).toHaveLength(200);
        expect(out[0]).toBe(data[0]);
        expect(out.at(-1)).toBe(data.at(-1));
        const indices = sourceIndicesOf(data, out);
        expect(
            indices.every((index) => index !== undefined),
            "returns source objects",
        ).toBe(true);
        expect(
            indices.every((index, i) => i === 0 || index > indices[i - 1]!),
            "keeps x order",
        ).toBe(true);
    });

    it("keeps a lone spike that the triangle areas single out", () => {
        const data = series(10_000, (index) => (index === 4321 ? 100 : 0));
        const out = decimateGapAware(data, 0, data.length, 200);
        expect(out).toContain(data[4321]);
    });

    it("keeps every gap point and never connects finite points across one", () => {
        const gaps = new Set([1200, 1201, 5000, 9100]);
        const data = series(10_000, (index) => (gaps.has(index) ? Number.NaN : Math.cos(index / 30)));
        const out = decimateGapAware(data, 0, data.length, 200);
        const indices = sourceIndicesOf(data, out);
        expect(indices.filter((index) => gaps.has(index))).toEqual([...gaps]);
        for (let i = 1; i < out.length; i++) {
            if (!Number.isFinite(out[i - 1]!.y) || !Number.isFinite(out[i]!.y)) continue;
            for (const gap of gaps) {
                expect(
                    gap > indices[i - 1]! && gap < indices[i]!,
                    `points ${indices[i - 1]}..${indices[i]} bridge gap ${gap}`,
                ).toBe(false);
            }
        }
        expect(out.length).toBeLessThanOrEqual(200 + gaps.size + 2 * 5);
    });

    it("splits the budget across runs in proportion to their length", () => {
        const data = series(10_000, (index) => (index === 9000 ? Number.NaN : Math.sin(index / 40)));
        const out = decimateGapAware(data, 0, data.length, 200);
        const gapAt = out.indexOf(data[9000]!);
        expect(gapAt).toBeGreaterThan(0);
        expect(gapAt).toBeCloseTo(180, -1);
        expect(out.length - gapAt - 1).toBeCloseTo(20, -1);
    });

    it("keeps at least the endpoints of a short run between gaps", () => {
        const data = series(10_000, (index) => (index === 5000 || index === 5004 ? Number.NaN : 1));
        const out = decimateGapAware(data, 0, data.length, 200);
        expect(out).toContain(data[5001]);
        expect(out).toContain(data[5003]);
    });

    it("decimates only the requested window", () => {
        const data = series(20_000);
        const out = decimateGapAware(data, 5000, 8000, 200);
        const indices = sourceIndicesOf(data, out);
        expect(indices[0]).toBe(5000);
        expect(indices.at(-1)).toBe(12_999);
        expect(out).toHaveLength(200);
    });
});

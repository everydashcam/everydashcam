import { describe, expect, it } from "vitest";
import { lowerBoundBy, nearestIndexBy, upperBoundBy } from "./sorted-search.js";

const value = (item: number): number => item;

describe("sorted numeric searches", () => {
    it("distinguishes the first equal value from the last equal value", () => {
        const items = [10, 20, 20, 40];
        expect(lowerBoundBy(items, 20, value)).toBe(1);
        expect(upperBoundBy(items, 20, value) - 1).toBe(2);
        expect(lowerBoundBy(items, 50, value)).toBe(items.length);
        expect(upperBoundBy(items, 0, value) - 1).toBe(-1);
        expect(lowerBoundBy([], 20, value)).toBe(0);
        expect(upperBoundBy([], 20, value)).toBe(0);
    });

    it("preserves caller-specific nearest ties and clamps to the available samples", () => {
        const items = [10, 20, 40];
        expect(nearestIndexBy(items, 30, value, "earlier")).toBe(1);
        expect(nearestIndexBy(items, 30, value, "later")).toBe(2);
        expect(nearestIndexBy(items, 20, value, "later")).toBe(1);
        expect(nearestIndexBy(items, 5, value, "earlier")).toBe(0);
        expect(nearestIndexBy(items, 50, value, "later")).toBe(2);
        expect(nearestIndexBy([], 20, value, "later")).toBe(-1);
    });

    it("keeps duplicate endpoints and caller timestamp conversion semantics", () => {
        const items = [{ ms: 0 }, { ms: 1000 }, { ms: 1000 }];
        const timestamp = (item: { ms: number }): number => 100 + item.ms / 1000;
        expect(nearestIndexBy(items, 101, timestamp, "earlier")).toBe(1);
        expect(nearestIndexBy(items, 102, timestamp, "earlier")).toBe(1);
        expect(nearestIndexBy(items, 102, timestamp, "later")).toBe(2);
    });
});

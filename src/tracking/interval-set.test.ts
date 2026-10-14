import { describe, expect, it } from "vitest";

import { totalIntervalSec, unionIntervals } from "./interval-set.js";

describe("unionIntervals", () => {
    it("merges overlapping and adjacent intervals, keeps gaps", () => {
        const u = unionIntervals([
            { startSec: 5, endSec: 7 },
            { startSec: 0, endSec: 2 },
            { startSec: 1.5, endSec: 3 },
            { startSec: 3, endSec: 4 },
        ]);
        expect(u).toEqual([
            { startSec: 0, endSec: 4 },
            { startSec: 5, endSec: 7 },
        ]);
    });

    it("preserves a one-frame gap and drops degenerate intervals", () => {
        const u = unionIntervals([
            { startSec: 0, endSec: 2 },
            { startSec: 2 + 1 / 30, endSec: 4 },
            { startSec: 9, endSec: 9 },
            { startSec: 10, endSec: 9 },
        ]);
        expect(u).toEqual([
            { startSec: 0, endSec: 2 },
            { startSec: 2 + 1 / 30, endSec: 4 },
        ]);
    });
});

describe("totalIntervalSec", () => {
    it("sums analyzed lengths without including gaps", () => {
        const set = [
            { startSec: 0, endSec: 2 },
            { startSec: 5, endSec: 6 },
        ];
        expect(totalIntervalSec(set)).toBeCloseTo(3);
    });
});

import { describe, expect, it } from "vitest";
import { planReverseCohorts } from "./reverse-decode-plan.js";

const group = (seedIndex: number, branchCount = 1, startIndex = 0) => ({ seedIndex, startIndex, branchCount });
const seeds = (cohorts: ReturnType<typeof planReverseCohorts>) =>
    cohorts.map((cohort) => cohort.map((item) => item.seedIndex));

describe("planReverseCohorts", () => {
    it("returns no cohorts for an empty input", () => {
        expect(planReverseCohorts([])).toEqual([]);
    });

    it("orders whole groups by seed and preserves input objects without mutating the input", () => {
        const last = Object.freeze({ ...group(12, 2, 4), label: "last" });
        const first = Object.freeze({ ...group(3, 2, 1), label: "first" });
        const middle = Object.freeze({ ...group(8, 2, 7), label: "middle" });
        const input = Object.freeze([last, first, middle]);
        const actual = planReverseCohorts(input);
        expect(seeds(actual)).toEqual([[3, 8, 12]]);
        expect(actual[0]![0]).toBe(first);
        expect(actual[0]![1]).toBe(middle);
        expect(actual[0]![2]).toBe(last);
        expect(actual[0]![2]!.label).toBe("last");
        expect(input).toEqual([last, first, middle]);
    });

    it("limits each cohort to eight seed groups even when the branch budget allows more", () => {
        const input = Array.from({ length: 18 }, (_, index) => group(index + 1)).reverse();
        expect(seeds(planReverseCohorts(input))).toEqual([
            [1, 2, 3, 4, 5, 6, 7, 8],
            [9, 10, 11, 12, 13, 14, 15, 16],
            [17, 18],
        ]);
    });

    it("fills the branch budget exactly and starts the next cohort without splitting a group", () => {
        const input = [group(1, 7), group(2, 9), group(3, 8), group(4, 2)];
        expect(seeds(planReverseCohorts(input))).toEqual([[1, 2, 3], [4]]);
    });

    it("starts a new cohort before adding a group that would exceed twenty-four branches", () => {
        const input = [group(1, 13), group(2, 12), group(3, 12), group(4, 1)];
        expect(seeds(planReverseCohorts(input))).toEqual([[1], [2, 3], [4]]);
    });

    it("runs each oversized group alone and preserves every group exactly once", () => {
        const input = [group(1, 2), group(2, 25), group(3, 30), group(4, 3), group(5, 4)];
        const actual = planReverseCohorts(input);
        expect(seeds(actual)).toEqual([[1], [2], [3], [4, 5]]);
        expect(actual.flat()).toEqual(input);
        for (const item of input) expect(actual.flat().filter((candidate) => candidate === item)).toHaveLength(1);
    });

    it("satisfies both limits across mixed group sizes", () => {
        const input = Array.from({ length: 28 }, (_, index) => group(index + 1, (index % 6) + 1));
        const actual = planReverseCohorts(input);
        expect(actual.flat()).toEqual(input);
        for (const cohort of actual) {
            expect(cohort.length).toBeLessThanOrEqual(8);
            expect(cohort.reduce((sum, item) => sum + item.branchCount, 0)).toBeLessThanOrEqual(24);
        }
    });

    it("rejects duplicate seeds before scheduling them twice", () => {
        expect(() => planReverseCohorts([group(3), group(1), group(3, 2, 1)])).toThrow("must be unique");
    });

    it.each([
        group(0),
        group(-1),
        group(1.5),
        group(Number.NaN),
        group(Number.POSITIVE_INFINITY),
        group(Number.MAX_SAFE_INTEGER + 1),
        group(3, 1, -1),
        group(3, 1, 0.5),
        group(3, 1, Number.NaN),
        group(3, 1, 3),
        group(3, 1, 4),
        group(3, 0),
        group(3, -1),
        group(3, 0.5),
        group(3, Number.NaN),
        group(3, Number.POSITIVE_INFINITY),
        group(3, Number.MAX_SAFE_INTEGER + 1),
    ])("rejects invalid indices or branch counts: %j", (invalid) => {
        expect(() => planReverseCohorts([invalid])).toThrow("reverse decode group is invalid");
    });
});

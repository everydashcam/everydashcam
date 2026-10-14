import { describe, expect, it } from "vitest";
import { planReverseCohorts, planReverseFrameIndices } from "./reverse-decode-plan.js";

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

const framesAtRate = (count: number, fps: number) =>
    Array.from({ length: count }, (_, index) => ({ contentSec: index / fps, durationSec: 1 / fps }));

describe("planReverseFrameIndices", () => {
    it("returns no pixels for an empty cohort", () => {
        expect(planReverseFrameIndices([], [])).toEqual([]);
        expect(planReverseFrameIndices(framesAtRate(10, 30), [], [2, 5])).toEqual([]);
    });

    it.each([
        { fps: 30, seedIndex: 6, expected: [0, 2, 4, 6] },
        { fps: 30, seedIndex: 7, expected: [0, 1, 3, 5, 7] },
        { fps: 60, seedIndex: 12, expected: [0, 4, 8, 12] },
        { fps: 60, seedIndex: 13, expected: [0, 1, 5, 9, 13] },
    ])("retains the seed phase and first endpoint at $fps fps from $seedIndex", ({ fps, seedIndex, expected }) => {
        expect(planReverseFrameIndices(framesAtRate(seedIndex + 1, fps), [group(seedIndex)])).toEqual(expected);
    });

    it("uses timestamps rather than a frame-count stride for variable-rate sources", () => {
        const frames = [0, 0.019, 0.053, 0.081, 0.097, 0.141, 0.2].map((contentSec) => ({
            contentSec,
            durationSec: 0.01,
        }));
        expect(planReverseFrameIndices(frames, [group(6)])).toEqual([0, 1, 4, 6]);
    });

    it("unites independent seed phases without resampling either group", () => {
        expect(planReverseFrameIndices(framesAtRate(14, 60), [group(13), group(12)])).toEqual([
            0, 1, 4, 5, 8, 9, 12, 13,
        ]);
    });

    it("adds recovery warmup pixels without shifting the normal reverse cadence", () => {
        const frames = framesAtRate(13, 60);
        expect(planReverseFrameIndices(frames, [{ ...group(12), recoveryWarmupFrames: 0 }])).toEqual([0, 4, 8, 12]);
        expect(planReverseFrameIndices(frames, [{ ...group(12), recoveryWarmupFrames: 2 }])).toEqual([
            0, 4, 8, 10, 11, 12,
        ]);
        expect(planReverseFrameIndices(frames, [{ ...group(12, 1, 10), recoveryWarmupFrames: 5 }])).toEqual([
            10, 11, 12,
        ]);
    });

    it("retains normal and recovery phases in a mixed cohort", () => {
        const groups = [group(12), { ...group(13), recoveryWarmupFrames: 2 }];
        expect(planReverseFrameIndices(framesAtRate(14, 60), groups)).toEqual([0, 1, 4, 5, 8, 9, 11, 12, 13]);
        expect(planReverseCohorts(groups)).toEqual([groups]);
    });

    it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
        "rejects invalid recovery warmup %s",
        (warmup) => {
            const invalid = { ...group(10), recoveryWarmupFrames: warmup };
            expect(() => planReverseCohorts([invalid])).toThrow("reverse decode recovery warmup is invalid");
            expect(() => planReverseFrameIndices(framesAtRate(20, 30), [invalid])).toThrow(
                "reverse decode recovery warmup is invalid",
            );
        },
    );

    it("retains every high-motion frame while keeping other groups sparse", () => {
        const frames = framesAtRate(14, 60);
        expect(planReverseFrameIndices(frames, [{ ...group(12), hasHighMotion: false }])).toEqual([0, 4, 8, 12]);
        expect(planReverseFrameIndices(frames, [group(12), { ...group(13, 1, 9), hasHighMotion: true }])).toEqual([
            0, 4, 8, 9, 10, 11, 12, 13,
        ]);
    });

    it("retains an intermediate long-held VFR sample without shifting inference", () => {
        const frames = framesAtRate(13, 60);
        frames[10]!.durationSec = 2;
        expect(planReverseFrameIndices(frames, [group(12)])).toEqual([0, 4, 8, 10, 12]);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid frame duration %s", (durationSec) => {
        const frames = framesAtRate(13, 60);
        frames[10]!.durationSec = durationSec;
        expect(() => planReverseFrameIndices(frames, [group(12)])).toThrow(
            "reverse decode frame duration must be finite and positive",
        );
    });

    it("retains off-grid detector and branch endpoints without shifting inference", () => {
        const groups = Object.freeze([Object.freeze(group(12, 1, 3))]);
        const required = Object.freeze([6, 5, 6, 2, 18]);
        expect(planReverseFrameIndices(framesAtRate(20, 60), groups, required)).toEqual([3, 4, 5, 6, 8, 12]);
        expect(required).toEqual([6, 5, 6, 2, 18]);
        expect(groups).toEqual([group(12, 1, 3)]);
    });

    it("keeps low-rate source frames and distant reverse history", () => {
        const frames = framesAtRate(1001, 10);
        expect(planReverseFrameIndices(frames, [group(1000)])).toEqual(frames.map((_, index) => index));
    });

    it("lets eight retained samples cover more source time at high frame rates", () => {
        for (const fps of [30, 60]) {
            const selected = planReverseFrameIndices(framesAtRate(fps + 1, fps), [group(fps)]);
            expect(selected).toHaveLength(16);
            const block = selected.slice(-8);
            expect(block.at(-1)! - block[0]!).toBe((7 * fps) / 15);
        }
    });

    it.each([group(0), group(20), group(3, 1, -1), group(3.5), group(3, 1, 3)])(
        "rejects invalid source frame bounds: %j",
        (invalid) => {
            expect(() => planReverseFrameIndices(framesAtRate(20, 30), [invalid])).toThrow(
                "reverse decode group frame bounds are invalid",
            );
        },
    );

    it.each([-1, 20, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid required frame %s", (index) => {
        expect(() => planReverseFrameIndices(framesAtRate(20, 30), [group(10)], [index])).toThrow(
            "reverse decode required frame index is invalid",
        );
    });

    it.each([
        [0, 0],
        [1, 0],
        [0, Number.NaN],
        [0, Number.POSITIVE_INFINITY],
    ])("rejects invalid presentation order: %j", (...timestamps) => {
        const frames = timestamps.map((contentSec) => ({ contentSec, durationSec: 1 / 30 }));
        expect(() => planReverseFrameIndices(frames, [group(1)])).toThrow(
            "reverse decode frame timestamps must be finite and increasing",
        );
    });
});

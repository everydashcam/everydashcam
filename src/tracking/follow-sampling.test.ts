import { describe, expect, it } from "vitest";

import { createFollowSampler } from "./follow-sampling.js";

const INTERVAL = 1 / 15;
const MICROSECOND = 1e-6;

function frameTimes(fps: number, seconds: number, offset = 0): number[] {
    return Array.from(
        { length: Math.ceil(fps * seconds) },
        (_, index) => Math.round((offset + index / fps) * 1e6) / 1e6,
    );
}

function select(times: number[]): number[] {
    const sample = createFollowSampler(INTERVAL, times[0]!);
    return times.filter(sample);
}

describe("Follow analysis cadence", () => {
    for (const offset of [0, 123.456789, 172800.654321]) {
        it.each([15, 25, 30, 60, 24000 / 1001, 30000 / 1001])(
            `keeps a 15 Hz grid at %s fps with microsecond timestamps starting at ${offset}`,
            (fps) => {
                const times = frameTimes(fps, 10, offset);
                const updates = select(times);
                expect(updates, "the seed is consumed once, followed by 149 analysis ticks").toHaveLength(149);
                const observed = [times[0]!, ...updates];
                const gaps = updates.map((time, index) => time - observed[index]!);
                expect(Math.max(...gaps)).toBeLessThanOrEqual(Math.ceil(fps / 15) / fps + 2 * MICROSECOND);
                for (let index = 0; index < updates.length; index++) {
                    const delay = updates[index]! - (times[0]! + (index + 1) * INTERVAL);
                    expect(
                        delay,
                        `tick ${index + 1} cannot precede its grid beyond timestamp rounding`,
                    ).toBeGreaterThanOrEqual(-1.1 * MICROSECOND);
                    expect(delay, `tick ${index + 1} uses the first available source frame`).toBeLessThan(
                        1 / fps + 2 * MICROSECOND,
                    );
                }
            },
        );
    }

    it("keeps phase over ten minutes instead of accumulating frame-rounding delays", () => {
        const times = frameTimes(25, 600, 36000.123456);
        const updates = select(times);
        expect(updates).toHaveLength(8999);
        for (let index = 0; index < updates.length; index++) {
            const delay = updates[index]! - (times[0]! + (index + 1) * INTERVAL);
            expect(delay).toBeGreaterThanOrEqual(-1.1 * MICROSECOND);
            expect(delay).toBeLessThan(1 / 25 + 2 * MICROSECOND);
        }
    });

    it("uses alternating source-frame gaps without changing the time grid", () => {
        const times = frameTimes(25, 1);
        expect(select(times).slice(0, 6)).toEqual([0.08, 0.16, 0.2, 0.28, 0.36, 0.4]);
    });

    it.each([1, 5, 10, 12])("analyzes every available frame when the source runs at %i fps", (fps) => {
        const times = frameTimes(fps, 5, 10.000001);
        expect(select(times)).toEqual(times.slice(1));
    });

    it("selects VFR frames once while leaving actual elapsed time available to the tracker", () => {
        const times = [0, 0.02, 0.071, 0.093, 0.13, 0.135, 0.21, 0.25, 0.28, 0.34, 0.44];
        const updates = select(times);
        expect(updates).toEqual([0.071, 0.135, 0.21, 0.28, 0.34, 0.44]);
        const elapsed = updates.map((time, index) => time - (index === 0 ? times[0]! : updates[index - 1]!));
        const expected = [0.071, 0.064, 0.075, 0.07, 0.06, 0.1];
        elapsed.forEach((dt, index) => {
            expect(dt).toBeCloseTo(expected[index]!);
        });
    });

    it("preserves one pass across segment boundaries, overlapping predecessors and duplicates", () => {
        const times = frameTimes(30, 3, 120.000001);
        const segments = [times.slice(0, 31), times.slice(29, 62), times.slice(60)];
        const sample = createFollowSampler(INTERVAL, times[0]!);
        const selected = segments.flatMap((segment) => segment.filter(sample));
        expect(selected).toEqual(select(times));
        expect(new Set(selected).size).toBe(selected.length);
    });

    it("skips missing ticks without replaying a burst after a large time gap", () => {
        const sample = createFollowSampler(INTERVAL, 0);
        const times = [0, 0, -0.01, 0.066667, 100000.01, 100000.01, 100000.02, 100000.04, 100000.066667];
        expect(times.filter(sample)).toEqual([0.066667, 100000.01, 100000.066667]);
    });

    it("does not move its cursor backward on an unselected overlapping frame", () => {
        const sample = createFollowSampler(INTERVAL, 0);
        expect(sample(0.05)).toBe(false);
        expect(sample(0.04)).toBe(false);
        expect(sample(0.066667)).toBe(true);
        expect(sample(0.066667)).toBe(false);
        expect(sample(0.133333)).toBe(true);
    });

    it("rejects invalid timing without corrupting the next valid analysis tick", () => {
        for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            expect(() => createFollowSampler(INTERVAL, value)).toThrow("anchor is invalid");
        }
        for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => createFollowSampler(value, 0)).toThrow("interval is invalid");
        }
        const sample = createFollowSampler(INTERVAL, 0);
        for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            expect(() => sample(value)).toThrow("follow sampling timestamp is invalid");
        }
        expect(sample(0.066667)).toBe(true);
        expect(sample(0.133333)).toBe(true);
    });
});

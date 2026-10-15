import { describe, expect, it } from "vitest";
import { type DetectionAnalysis, planDetectionReuse } from "./detection-analysis.js";

function analysis(): DetectionAnalysis {
    return {
        bounds: { startSec: 1.1, endSec: 7.9 },
        quality: "fast",
        threshold: 0.7,
        sourceFrames: Array.from({ length: 70 }, (_, index) => ({ contentSec: 1 + index / 10, durationSec: 0.1 })),
        checkpoints: [1.1, 2, 3, 4, 5, 6, 7, 7.8].map((contentSec) => ({
            contentSec,
            sourceTimestamp: contentSec,
            durationSec: 0.1,
            seeds: [],
            tracks: [],
        })),
    };
}

describe("completed detection reuse", () => {
    it.each([
        { startSec: 0, endSec: 7.9 },
        { startSec: 1.1, endSec: 9 },
        { startSec: 0, endSec: 9 },
    ])("revisits only boundary dependencies for $startSec..$endSec", (bounds) => {
        const cached = analysis();
        const snapshot = structuredClone(cached);
        const plan = planDetectionReuse(cached, bounds);
        expect(plan.retained.map((checkpoint) => checkpoint.contentSec)).toEqual([3, 4, 5, 6]);
        expect(plan.intervals).toEqual([
            { startSec: bounds.startSec, endSec: 3.1 },
            { startSec: 6, endSec: bounds.endSec },
        ]);
        expect(cached, "planning never changes completed evidence").toEqual(snapshot);
    });

    it("retains empty scans as boundaries even without any tracks", () => {
        const plan = planDetectionReuse(analysis(), { startSec: 0, endSec: 9 });
        expect(plan.retained).toHaveLength(4);
        expect(plan.retained.every((checkpoint) => checkpoint.seeds.length === 0)).toBe(true);
    });

    it.each([
        { startSec: 4.01, endSec: 10, retained: [6], intervals: [{ startSec: 4.01, endSec: 10 }] },
        { startSec: 0, endSec: 4.99, retained: [3], intervals: [{ startSec: 0, endSec: 4.99 }] },
        { startSec: 8, endSec: 10, retained: [], intervals: [{ startSec: 8, endSec: 10 }] },
    ])(
        "drops dependencies removed by a sliding range $startSec..$endSec",
        ({ startSec, endSec, retained, intervals }) => {
            const plan = planDetectionReuse(analysis(), { startSec, endSec });
            expect(plan.retained.map((checkpoint) => checkpoint.contentSec)).toEqual(retained);
            expect(plan.intervals).toEqual(intervals);
        },
    );

    it("reanalyzes short windows with no complete interior dependencies", () => {
        const cached = analysis();
        cached.checkpoints = cached.checkpoints.slice(0, 4);
        expect(planDetectionReuse(cached, { startSec: 0, endSec: 9 })).toEqual({
            intervals: [{ startSec: 0, endSec: 9 }],
            retained: [],
        });
    });

    it("reanalyzes overlapping boundary frames without shortening a verified checkpoint hold", () => {
        const cached = analysis();
        cached.checkpoints[2]!.durationSec = 0.5;
        cached.sourceFrames.find((frame) => frame.contentSec === 3)!.durationSec = 0.5;
        expect(planDetectionReuse(cached, { startSec: 0, endSec: 9 })).toEqual({
            intervals: [{ startSec: 0, endSec: 9 }],
            retained: [],
        });
    });

    it("requires the complete following checkpoint inside a fractional boundary", () => {
        const cached = analysis();
        cached.checkpoints[4]!.durationSec = 0.8;
        expect(
            planDetectionReuse(cached, { startSec: 0, endSec: 5.5 }).retained.map(
                (checkpoint) => checkpoint.contentSec,
            ),
        ).toEqual([3]);
    });
});

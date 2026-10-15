import { describe, expect, it } from "vitest";
import { groupDetectionFindings, type DetectionFinding } from "./detection-review.js";

function item(startSec: number, endSec: number, seekSec: number): DetectionFinding {
    return { startSec, endSec, seekSec };
}

describe("groupDetectionFindings", () => {
    it("unions touching and overlapping masks while retaining the first displayed frame", () => {
        const items = [item(0.1, 2, 0.12), item(1.1, 3, 1.12), item(3, 4, 3.02)];
        const before = structuredClone(items);
        expect(groupDetectionFindings(items)).toEqual([item(0.1, 4, 0.12)]);
        expect(items).toEqual(before);
        expect(groupDetectionFindings(items.slice().reverse())).toEqual(groupDetectionFindings(items));
    });

    it("splits every uncovered interval, including a sub-frame gap", () => {
        const items = [item(0, 1, 0.02), item(1 + 1e-7, 3, 1.02)];
        expect(groupDetectionFindings(items)).toEqual(items);
    });

    it("keeps one section while any mask remains active through other objects appearing and disappearing", () => {
        const items = [item(0, 3, 0.02), item(1, 2, 1.02), item(2, 5, 2.02), item(3, 4, 3.02)];
        expect(groupDetectionFindings(items)).toEqual([item(0, 5, 0.02)]);
    });

    it("uses the shortest first-frame target when cameras start together at different cadences", () => {
        const items = [item(1, 3, 1.05), item(1, 2, 1.01), item(1, 4, 1.02)];
        expect(groupDetectionFindings(items)).toEqual([item(1, 4, 1.01)]);
        expect(groupDetectionFindings(items.slice().reverse())).toEqual(groupDetectionFindings(items));
    });

    it("does not choose a shorter later frame over the first frame of a section", () => {
        expect(groupDetectionFindings([item(0, 3, 0.1), item(0.02, 1.5, 0.03)])).toEqual([item(0, 3, 0.1)]);
    });

    it("returns no section for an empty result or zero-duration masks", () => {
        expect(groupDetectionFindings([])).toEqual([]);
        expect(groupDetectionFindings([item(1, 1, 1)])).toEqual([]);
    });
});

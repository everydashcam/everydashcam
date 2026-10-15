import { describe, expect, it } from "vitest";

import { canSeedDetection, DETECTION_POLICIES, detectionPolicy } from "./detector-policy.js";

describe("detector acceptance policy", () => {
    it.each([0.1, 0.45, 0.7, 1])("uses the chosen threshold %s for accepting a seed", (threshold) => {
        const policy = detectionPolicy(threshold);
        expect(canSeedDetection(threshold - 0.001, policy)).toBe(false);
        expect(canSeedDetection(threshold, policy)).toBe(true);
    });

    it.each([0.09, 1.01, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid threshold %s", (threshold) => {
        expect(() => detectionPolicy(threshold)).toThrow("detection threshold is out of range");
    });

    it("does not turn repeated weak plate background hits into a seed", () => {
        const backgroundScores = Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? 0.3 : 0.69));
        expect(backgroundScores.filter((score) => canSeedDetection(score, DETECTION_POLICIES.plate))).toEqual([]);
        expect(canSeedDetection(0.7, DETECTION_POLICIES.plate)).toBe(true);
    });

    it("requires the single-hit confirmation floor for every face seed", () => {
        for (const score of [0.25, 0.3, 0.45, 0.69, 0.699]) {
            expect(canSeedDetection(score, DETECTION_POLICIES.face)).toBe(false);
        }
        expect(canSeedDetection(0.7, DETECTION_POLICIES.face)).toBe(true);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects nonfinite score %s", (score) => {
        expect(canSeedDetection(score, DETECTION_POLICIES.plate)).toBe(false);
        expect(canSeedDetection(score, DETECTION_POLICIES.face)).toBe(false);
    });
});

import { describe, expect, it } from "vitest";

import { canSeedDetection, DETECTION_POLICIES } from "./detector-policy.js";

describe("detector acceptance policy", () => {
    it("does not turn repeated weak plate background hits into a seed", () => {
        const backgroundScores = Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? 0.3 : 0.69));
        expect(backgroundScores.filter((score) => canSeedDetection(score, DETECTION_POLICIES.plate))).toEqual([]);
        expect(canSeedDetection(0.7, DETECTION_POLICIES.plate)).toBe(true);
        expect(DETECTION_POLICIES.plate.strongScore).toBe(DETECTION_POLICIES.plate.seedScoreMin);
    });

    it("preserves face candidates below the single-hit strong threshold", () => {
        expect(canSeedDetection(0.249, DETECTION_POLICIES.face)).toBe(false);
        expect(canSeedDetection(0.25, DETECTION_POLICIES.face)).toBe(true);
        expect(DETECTION_POLICIES.face.strongScore).toBe(0.45);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects nonfinite score %s", (score) => {
        expect(canSeedDetection(score, DETECTION_POLICIES.plate)).toBe(false);
        expect(canSeedDetection(score, DETECTION_POLICIES.face)).toBe(false);
    });
});

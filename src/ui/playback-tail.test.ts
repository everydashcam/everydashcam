import { describe, expect, it } from "vitest";

import { CLIP_TAIL_TOLERANCE_SEC, isClipTailFailure } from "./playback-tail.js";

describe("isClipTailFailure", () => {
    it("treats a failure inside the tail tolerance as the clip end", () => {
        expect(isClipTailFailure(276.97, 276.98)).toBe(true);
        expect(isClipTailFailure(276.98 - CLIP_TAIL_TOLERANCE_SEC, 276.98)).toBe(true);
    });

    it("keeps a mid-clip failure retryable", () => {
        expect(isClipTailFailure(100, 276.98)).toBe(false);
        expect(isClipTailFailure(276.98 - CLIP_TAIL_TOLERANCE_SEC - 0.01, 276.98)).toBe(false);
    });

    it("needs a usable duration", () => {
        expect(isClipTailFailure(5, null)).toBe(false);
        expect(isClipTailFailure(5, undefined)).toBe(false);
        expect(isClipTailFailure(5, 0)).toBe(false);
        expect(isClipTailFailure(5, Number.NaN)).toBe(false);
        expect(isClipTailFailure(Number.NaN, 10)).toBe(false);
    });
});

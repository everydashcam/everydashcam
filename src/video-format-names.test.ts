import { describe, expect, it } from "vitest";

import { demuxPreparationBudgetMs, isRawHevcName } from "./video-format-names.js";

describe("demuxPreparationBudgetMs", () => {
    it("budgets a raw HEVC stream's full read at a slow source's rate", () => {
        const minute = new File([new Uint8Array(37 * 1024 * 1024)], "fcamera.hevc");
        expect(isRawHevcName(minute.name)).toBe(true);
        expect(demuxPreparationBudgetMs(minute)).toBe(18_500);
    });

    it("adds nothing for containers whose demux starts from their own index", () => {
        expect(demuxPreparationBudgetMs(new File([new Uint8Array(1024)], "clip.MP4"))).toBe(0);
        expect(demuxPreparationBudgetMs(new File([new Uint8Array(1024)], "qcamera.ts"))).toBe(0);
    });
});

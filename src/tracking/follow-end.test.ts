import { describe, expect, it } from "vitest";

import { finalizeFollowEndReason, followEdgeEndReason } from "./follow-end.js";

describe("followEdgeEndReason", () => {
    it("marks a reliable partly visible box as uncertain loss", () => {
        expect(followEdgeEndReason(0.2, true)).toBe("lost");
    });

    it("does not mistake a frozen off-frame box for a confirmed departure", () => {
        expect(followEdgeEndReason(0, false)).toBe("lost");
    });

    it("confirms departure only after a reliable fully off-frame observation", () => {
        expect(followEdgeEndReason(0, true)).toBe("exited");
    });
});

const base = {
    initialized: true,
    lossPending: false,
    exitPending: false,
    requestedEndSec: 10,
    lastAnalyzedSec: 9.8,
    analysisIntervalSec: 0.5,
};

describe("finalizeFollowEndReason", () => {
    it("does not overwrite a confirmed exit", () => {
        expect(finalizeFollowEndReason("exited", { ...base, lossPending: true })).toBe("exited");
    });

    it("marks low confidence that reaches EOF before ride-out as lost", () => {
        expect(finalizeFollowEndReason("completed", { ...base, lossPending: true })).toBe("lost");
    });

    it("marks a materially short decode as lost", () => {
        expect(finalizeFollowEndReason("completed", { ...base, lastAnalyzedSec: 7 })).toBe("lost");
    });

    it("marks a pass that decoded no usable frame as lost", () => {
        expect(finalizeFollowEndReason("completed", { ...base, initialized: false })).toBe("lost");
    });

    it("accepts the normal sub-frame gap at the requested end", () => {
        expect(finalizeFollowEndReason("completed", base)).toBe("completed");
    });
});

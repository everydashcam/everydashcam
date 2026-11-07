import { describe, expect, it } from "vitest";

import type { Channel } from "../parsers/types.js";
import { moveChannelInOrder, swapChannelsInOrder } from "./state.js";

describe("moveChannelInOrder", () => {
    const order: Channel[] = ["front", "rear", "interior"];

    it("moves a channel to the end (drop onto last slot)", () => {
        // front dropped onto interior's slot (index 2): the rest slide up,
        // front lands last.
        expect(moveChannelInOrder(order, "front", 2)).toEqual(["rear", "interior", "front"]);
    });

    it("moves a channel to slot 0 (drop onto primary)", () => {
        expect(moveChannelInOrder(order, "interior", 0)).toEqual(["interior", "front", "rear"]);
    });

    it("moves a channel into a middle slot", () => {
        expect(moveChannelInOrder(order, "front", 1)).toEqual(["rear", "front", "interior"]);
    });

    it("is direction-agnostic: dropping onto its own slot is a no-op", () => {
        expect(moveChannelInOrder(order, "rear", 1)).toEqual(["front", "rear", "interior"]);
    });

    it("clamps an out-of-range target index to the end", () => {
        expect(moveChannelInOrder(order, "front", 99)).toEqual(["rear", "interior", "front"]);
    });

    it("clamps a negative target index to slot 0", () => {
        expect(moveChannelInOrder(order, "interior", -5)).toEqual(["interior", "front", "rear"]);
    });

    it("returns a copy unchanged when the channel is absent", () => {
        const result = moveChannelInOrder(order, "side", 0);
        expect(result).toEqual(order);
        expect(result).not.toBe(order); // pure: never returns the input reference
    });

    it("does not mutate the input array", () => {
        const input: Channel[] = ["front", "rear", "interior"];
        moveChannelInOrder(input, "front", 2);
        expect(input).toEqual(["front", "rear", "interior"]);
    });
});

describe("swapChannelsInOrder", () => {
    const order: Channel[] = ["front", "rear", "interior"];

    it("trades two places and leaves the cameras between them alone", () => {
        expect(swapChannelsInOrder(order, "interior", "front")).toEqual(["interior", "rear", "front"]);
        expect(moveChannelInOrder(order, "interior", 0), "insert shifts them instead").toEqual([
            "interior",
            "front",
            "rear",
        ]);
    });

    it("returns an unchanged copy for a missing channel or a self-swap", () => {
        expect(swapChannelsInOrder(order, "side", "front")).toEqual(order);
        expect(swapChannelsInOrder(order, "rear", "rear")).toEqual(order);
        expect(swapChannelsInOrder(order, "rear", "front")).not.toBe(order);
    });
});

import { describe, expect, it } from "vitest";
import { pickNextPreview } from "./trip-preview-order.js";

/** Drains the picker the way the preview pass does: each pick is taken once. */
function drain(order: string[], visible: Set<string>, fallback: string[], done: Set<string> = new Set()): string[] {
    const taken = new Set(done);
    const picks: string[] = [];
    for (;;) {
        const next = pickNextPreview(order, visible, (item) => !taken.has(item), fallback);
        if (next === null) return picks;
        taken.add(next);
        picks.push(next);
    }
}

describe("preview order", () => {
    it("builds the visible cards first, then continues down the list from them and wraps to the top", () => {
        const order = ["a", "b", "c", "d", "e", "f"];
        expect(drain(order, new Set(["d", "c"]), [])).toEqual(["c", "d", "e", "f", "a", "b"]);
    });

    it("follows the list order from the top when nothing is visible", () => {
        expect(drain(["new", "mid", "old"], new Set(), [])).toEqual(["new", "mid", "old"]);
    });

    it("leaves trips the list does not show for last, in fallback order", () => {
        expect(drain(["b", "a"], new Set(["a"]), ["hidden-new", "b", "hidden-old"])).toEqual([
            "a",
            "b",
            "hidden-new",
            "hidden-old",
        ]);
    });

    it("skips trips that already have a preview or failed", () => {
        expect(drain(["a", "b", "c"], new Set(["b"]), [], new Set(["b", "c"]))).toEqual(["a"]);
    });
});

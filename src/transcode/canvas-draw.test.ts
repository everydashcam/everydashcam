// Unit tests for the shared canvas path/math helpers. We can't rasterize in
// node, but we can assert the path verbs each shape emits (so the mini-map clip
// and its border trace the same outline) and the NaN-safe clamp.

import { beforeEach, describe, expect, it } from "vitest";

import { _resetForTests, circlePath, clamp, measureTextWidth } from "./canvas-draw.js";

/** A 2D context stub that records the path verbs it receives. */
function makeCtx(): { ctx: CanvasRenderingContext2D; verbs: string[] } {
    const verbs: string[] = [];
    const ctx = {
        beginPath: () => verbs.push("begin"),
        closePath: () => verbs.push("close"),
        moveTo: () => verbs.push("moveTo"),
        lineTo: () => verbs.push("lineTo"),
        arcTo: () => verbs.push("arcTo"),
        arc: () => verbs.push("arc"),
    } as unknown as CanvasRenderingContext2D;
    return { ctx, verbs };
}

describe("clamp", () => {
    it("bounds and maps non-finite to lo", () => {
        expect(clamp(5, 0, 10)).toBe(5);
        expect(clamp(-3, 0, 10)).toBe(0);
        expect(clamp(99, 0, 10)).toBe(10);
        expect(clamp(Number.NaN, 50, 200)).toBe(50);
        expect(clamp(Number.POSITIVE_INFINITY, 50, 200)).toBe(50);
    });
});

describe("circlePath", () => {
    it("emits a single arc subpath", () => {
        const { ctx, verbs } = makeCtx();
        circlePath(ctx, 50, 50, 20);
        expect(verbs).toEqual(["begin", "arc", "close"]);
    });
});

/** A 2D context stub whose measureText counts calls and varies with the font,
 *  so a stale cache entry (wrong font reused) shows up as a wrong width. */
function makeTextCtx(): { ctx: CanvasRenderingContext2D; calls: () => number } {
    let calls = 0;
    const state = {
        font: "10px A",
        letterSpacing: "0px",
        measureText: (text: string) => {
            calls++;
            return { width: text.length * Number.parseInt(state.font, 10) };
        },
    };
    return { ctx: state as unknown as CanvasRenderingContext2D, calls: () => calls };
}

describe("measureTextWidth", () => {
    beforeEach(() => {
        _resetForTests();
    });

    it("measures once per (font, text) and serves repeats from the cache", () => {
        const { ctx, calls } = makeTextCtx();
        expect(measureTextWidth(ctx, "abc")).toBe(30);
        expect(measureTextWidth(ctx, "abc")).toBe(30);
        expect(measureTextWidth(ctx, "abc")).toBe(30);
        expect(calls()).toBe(1);
    });

    it("re-measures when the font changes", () => {
        const { ctx, calls } = makeTextCtx();
        expect(measureTextWidth(ctx, "abc")).toBe(30);
        ctx.font = "20px A";
        expect(measureTextWidth(ctx, "abc"), "same string at a bigger font").toBe(60);
        expect(calls()).toBe(2);
    });

    it("re-measures when letter spacing changes", () => {
        const { ctx, calls } = makeTextCtx();
        measureTextWidth(ctx, "abc");
        (ctx as unknown as { letterSpacing: string }).letterSpacing = "4px";
        measureTextWidth(ctx, "abc");
        expect(calls()).toBe(2);
    });

    it("keys on the string, not just the font", () => {
        const { ctx, calls } = makeTextCtx();
        expect(measureTextWidth(ctx, "ab")).toBe(20);
        expect(measureTextWidth(ctx, "abcd")).toBe(40);
        expect(calls()).toBe(2);
    });
});

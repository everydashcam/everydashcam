import { describe, expect, it } from "vitest";

import { compositeOver, oklabRamp, parseHexRgb, type Rgb } from "./oklab-ramp.js";

const GREY: Rgb = [229, 228, 226];
const RED: Rgb = [229, 16, 43];

function hexToRgb(hex: string): Rgb {
    const rgb = parseHexRgb(hex);
    if (!rgb) throw new Error(`not a #rrggbb colour: ${hex}`);
    return rgb;
}

describe("parseHexRgb", () => {
    it("parses the #rrggbb form a canvas returns for an opaque colour", () => {
        expect(parseHexRgb("#e5102b")).toEqual([229, 16, 43]);
        expect(parseHexRgb(" #FFFFFF ")).toEqual([255, 255, 255]);
    });

    it("rejects shorthand, alpha and named colours", () => {
        expect(parseHexRgb("#fff")).toBeNull();
        expect(parseHexRgb("rgba(0, 0, 0, 0.5)")).toBeNull();
        expect(parseHexRgb("red")).toBeNull();
        expect(parseHexRgb("")).toBeNull();
    });
});

describe("compositeOver", () => {
    it("blends channel by channel like source-over", () => {
        expect(compositeOver([0, 0, 0], 0.25, [200, 100, 40])).toEqual([150, 75, 30]);
        expect(compositeOver(RED, 0, GREY)).toEqual(GREY);
        expect(compositeOver(RED, 1, GREY)).toEqual(RED);
    });
});

describe("oklabRamp", () => {
    it("runs from the first colour to the second in steps + 1 entries", () => {
        const ramp = oklabRamp(GREY, RED, 8);
        expect(ramp).toHaveLength(9);
        expect(ramp[0]).toBe("#e5e4e2");
        expect(ramp[8]).toBe("#e5102b");
    });

    it("keeps a neutral ramp neutral", () => {
        for (const hex of oklabRamp([255, 255, 255], [0, 0, 0], 10)) {
            const [red, green, blue] = hexToRgb(hex);
            expect(Math.abs(red - green), hex).toBeLessThanOrEqual(1);
            expect(Math.abs(green - blue), hex).toBeLessThanOrEqual(1);
        }
    });

    it("keeps the pale steps of a red ramp coral where an sRGB blend turns pink", () => {
        // Pink is a pale red whose blue overtakes its green. Near full strength
        // this red has more blue than green of its own, so only the pale half
        // of the ramp tells the two blends apart.
        const ramp = oklabRamp(GREY, RED, 10);
        for (const step of [2, 4, 6]) {
            const [, srgbGreen, srgbBlue] = compositeOver(RED, step / 10, GREY);
            expect(srgbBlue, `sRGB blend at ${step / 10}`).toBeGreaterThan(srgbGreen);
            const [, green, blue] = hexToRgb(ramp[step]!);
            expect(green, `OKLab step at ${step / 10}`).toBeGreaterThanOrEqual(blue);
        }
    });
});

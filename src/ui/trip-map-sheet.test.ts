import { describe, expect, it, vi } from "vitest";

// The module wires itself to the page's elements; the logic under test is pure.
vi.mock("./dom.js", () => ({ dom: {} }));

const { releaseVelocity, releasedTripMapSheetSnap, tappedTripMapSheetSnap, tripMapSheetHeights } = await import(
    "./trip-map-sheet.js"
);

const PORTRAIT = tripMapSheetHeights(420, 70);

describe("tripMapSheetHeights", () => {
    it("collapses to the chrome, opens to half the map and leaves a strip above when raised", () => {
        expect(PORTRAIT).toEqual({ collapsed: 70, half: 218, expanded: 300 });
    });

    it("never lowers a higher position below a lower one on a short panel", () => {
        const heights = tripMapSheetHeights(240, 70);
        expect(heights.half).toBe(125);
        expect(heights.expanded, "raised").toBe(heights.half);
    });

    it("keeps the collapsed sheet within the panel", () => {
        const heights = tripMapSheetHeights(50, 70);
        expect(heights.collapsed).toBe(50);
        expect(heights.half).toBe(50);
        expect(heights.expanded).toBe(50);
    });
});

describe("releasedTripMapSheetSnap", () => {
    it("settles a slow release at the nearest height", () => {
        expect(releasedTripMapSheetSnap(PORTRAIT, 100, 0)).toBe("collapsed");
        expect(releasedTripMapSheetSnap(PORTRAIT, 200, 0.1)).toBe("half");
        expect(releasedTripMapSheetSnap(PORTRAIT, 280, -0.1)).toBe("expanded");
    });

    it("prefers the lower height on a tie", () => {
        expect(releasedTripMapSheetSnap(PORTRAIT, 144, 0)).toBe("collapsed");
    });

    it("carries an upward flick to the next height above the release", () => {
        expect(releasedTripMapSheetSnap(PORTRAIT, 80, 1)).toBe("half");
        expect(releasedTripMapSheetSnap(PORTRAIT, 230, 1)).toBe("expanded");
    });

    it("carries a downward flick to the next height below the release", () => {
        expect(releasedTripMapSheetSnap(PORTRAIT, 290, -1)).toBe("half");
        expect(releasedTripMapSheetSnap(PORTRAIT, 210, -1)).toBe("collapsed");
    });

    it("stays at the end when a flick has no height beyond it", () => {
        expect(releasedTripMapSheetSnap(PORTRAIT, 300, 1)).toBe("expanded");
        expect(releasedTripMapSheetSnap(PORTRAIT, 70, -1)).toBe("collapsed");
    });
});

describe("tappedTripMapSheetSnap", () => {
    it("steps up and wraps from the top to collapsed", () => {
        expect(tappedTripMapSheetSnap("collapsed")).toBe("half");
        expect(tappedTripMapSheetSnap("half")).toBe("expanded");
        expect(tappedTripMapSheetSnap("expanded")).toBe("collapsed");
    });
});

describe("releaseVelocity", () => {
    it("measures the rise over the recent moves", () => {
        const samples = [
            { timeMs: 0, clientY: 500 },
            { timeMs: 150, clientY: 480 },
            { timeMs: 200, clientY: 430 },
            { timeMs: 250, clientY: 380 },
        ];
        expect(releaseVelocity(samples)).toBeCloseTo(1);
    });

    it("is negative while the pointer goes down", () => {
        expect(
            releaseVelocity([
                { timeMs: 0, clientY: 300 },
                { timeMs: 50, clientY: 340 },
            ]),
        ).toBeCloseTo(-0.8);
    });

    it("is zero after the pointer rested before the release", () => {
        expect(
            releaseVelocity([
                { timeMs: 0, clientY: 500 },
                { timeMs: 300, clientY: 300 },
            ]),
        ).toBe(0);
        expect(releaseVelocity([{ timeMs: 0, clientY: 500 }])).toBe(0);
        expect(releaseVelocity([])).toBe(0);
    });
});

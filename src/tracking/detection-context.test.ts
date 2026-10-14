import { describe, expect, it } from "vitest";
import { resolvePlateContextDetections, shouldVerifyPlateContext } from "./detection-context.js";
import { type RawDetection, suppressTileOverlaps } from "./detect-common.js";

const box = (x: number, y: number, w: number, h: number, score = 0.9): RawDetection => ({ x, y, w, h, score });

describe("plate context validation", () => {
    it("requires both visible dimensions to remain resolved in the whole-frame input", () => {
        expect(shouldVerifyPlateContext(box(0, 0, 384, 384), 3840, 2160)).toBe(true);
        expect(shouldVerifyPlateContext(box(0, 0, 384, 383), 3840, 2160)).toBe(false);
        expect(shouldVerifyPlateContext(box(0, 0, 383, 384), 3840, 2160)).toBe(false);
        expect(shouldVerifyPlateContext(box(0, 0, 800, 100), 3840, 2160)).toBe(false);
        expect(shouldVerifyPlateContext(box(3700, 1000, 1000, 700), 3840, 2160)).toBe(false);
    });

    it("uses the whole-frame letterbox scale in either orientation", () => {
        expect(shouldVerifyPlateContext(box(0, 0, 192, 192), 1920, 1080)).toBe(true);
        expect(shouldVerifyPlateContext(box(0, 0, 192, 192), 1080, 1920)).toBe(true);
        expect(shouldVerifyPlateContext(box(0, 0, 192, 191), 1080, 1920)).toBe(false);
    });

    it("uses corroborated whole-frame geometry without changing either input", () => {
        const plate = Object.freeze(box(400, 300, 500, 200));
        const context = Object.freeze(box(410, 310, 480, 190, 0.25));
        const result = resolvePlateContextDetections([plate], [context], 1920, 1080);
        expect(result).toEqual([{ ...context, score: plate.score }]);
        expect(plate).toEqual(box(400, 300, 500, 200));
        expect(context).toEqual(box(410, 310, 480, 190, 0.25));
    });

    it("corroborates a clipped plate using visible geometry without limiting off-frame estimates", () => {
        const plate = box(800, 250, 300, 200);
        const context = box(790, 255, 1000, 195, 0.3);
        expect(resolvePlateContextDetections([plate], [context], 1000, 800)).toEqual([
            { ...context, score: plate.score },
        ]);
    });

    it("rejects a vehicle-sized proposal when context finds only a small plate inside it", () => {
        const vehicle = box(2500, 1200, 1100, 700);
        const plate = box(2800, 1500, 180, 70);
        expect(resolvePlateContextDetections([vehicle], [plate], 3840, 2160)).toEqual([]);
        expect(resolvePlateContextDetections([vehicle], [], 3840, 2160)).toEqual([]);
    });

    it("keeps small tiled objects unchanged and never promotes context-only proposals", () => {
        const tiny = box(100, 100, 80, 30);
        const large = box(900, 500, 700, 500);
        expect(resolvePlateContextDetections([tiny], [large], 3840, 2160)).toEqual([tiny]);
        expect(resolvePlateContextDetections([tiny], [], 3840, 2160)[0]).toBe(tiny);
        expect(resolvePlateContextDetections([], [large], 3840, 2160)).toEqual([]);
    });

    it("restores a full close plate from a weak large tile fragment and strong context", () => {
        const clippedStrong = box(867, 391, 720, 261, 0.774);
        const clippedWeak = box(351, 400, 793, 252, 0.592);
        const full = box(346.5, 391.875, 1236, 317, 0.843);
        expect(resolvePlateContextDetections([clippedStrong, clippedWeak], [full], 1920, 1080)).toEqual([full]);
    });

    it("emits one full context box for multiple fragments and preserves their strongest score", () => {
        const first = box(100, 100, 300, 240, 0.8);
        const second = box(200, 100, 300, 240, 0.7);
        const full = box(100, 100, 400, 240, 0.25);
        expect(resolvePlateContextDetections([first, second], [full], 1920, 1080)).toEqual([
            { ...full, score: first.score },
        ]);
    });

    it("removes a near-threshold small duplicate only when context fully covers it", () => {
        const large = box(100, 100, 400, 200);
        const coveredSmall = box(105, 110, 400, 180);
        const protrudingSmall = box(90, 110, 400, 180);
        const full = box(100, 100, 500, 200);
        expect(resolvePlateContextDetections([large, coveredSmall], [full], 1920, 1080)).toEqual([full]);
        expect(resolvePlateContextDetections([large, protrudingSmall], [full], 1920, 1080)).toEqual([
            protrudingSmall,
            full,
        ]);
    });

    it("preserves a strong small fragment's score when a weak full context replaces it", () => {
        const large = box(100, 100, 400, 200, 0.3);
        const small = box(300, 110, 300, 180, 0.9);
        const context = Object.freeze(box(100, 100, 500, 200, 0.25));
        const tiled = suppressTileOverlaps([large, small], 0.5);
        expect(tiled, "both fragments survive the detector's existing tile suppression").toHaveLength(2);
        expect(resolvePlateContextDetections(tiled, [context], 1920, 1080)).toEqual([
            { ...context, score: small.score },
        ]);
        expect(context.score).toBeCloseTo(0.25);
    });

    it("requires spatial agreement instead of merely similar dimensions", () => {
        const plate = box(100, 100, 300, 200);
        expect(resolvePlateContextDetections([plate], [box(800, 600, 300, 200)], 1000, 800)).toEqual([]);
        expect(resolvePlateContextDetections([plate], [box(200, 100, 300, 200)], 1000, 800)).toEqual([
            box(200, 100, 300, 200),
        ]);
        expect(resolvePlateContextDetections([plate], [box(201, 100, 300, 200)], 1000, 800)).toEqual([]);
    });

    it.each([
        box(100, 100, 0, 200),
        box(100, 100, 300, -1),
        box(Number.NaN, 100, 300, 200),
        box(100, 100, Number.POSITIVE_INFINITY, 200),
        box(100, 100, 300, 200, Number.NaN),
        box(100, 100, 300, 200, -1),
        box(100, 100, 300, 200, 2),
        box(1000, 100, 300, 200),
    ])("ignores invalid or invisible proposals: %j", (invalid) => {
        expect(shouldVerifyPlateContext(invalid, 1000, 800)).toBe(false);
        expect(resolvePlateContextDetections([invalid], [], 1000, 800)).toEqual([]);
        expect(resolvePlateContextDetections([box(100, 100, 300, 200)], [invalid], 1000, 800)).toEqual([]);
    });

    it.each([
        [0, 800],
        [1000, -1],
        [Number.NaN, 800],
        [1000, Number.POSITIVE_INFINITY],
    ])("rejects invalid frame dimensions %s by %s", (width, height) => {
        expect(() => shouldVerifyPlateContext(box(100, 100, 300, 200), width, height)).toThrow(
            "detection context frame dimensions are invalid",
        );
        expect(() => resolvePlateContextDetections([], [], width, height)).toThrow(
            "detection context frame dimensions are invalid",
        );
    });
});

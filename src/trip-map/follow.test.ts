import { describe, expect, it } from "vitest";

import { shouldReframe } from "./follow.js";

const VIEW = { viewportWidth: 800, viewportHeight: 600 };

describe("shouldReframe", () => {
    it("frames the first tracks once following starts", () => {
        expect(
            shouldReframe({
                ...VIEW,
                isFollowing: true,
                hasFramed: false,
                tracksOnScreen: { minX: 300, minY: 200, maxX: 320, maxY: 220 },
            }),
        ).toBe(true);
    });

    it("keeps the camera while the tracks stay inside the frame", () => {
        expect(
            shouldReframe({
                ...VIEW,
                isFollowing: true,
                hasFramed: true,
                tracksOnScreen: { minX: 30, minY: 30, maxX: 770, maxY: 570 },
            }),
        ).toBe(false);
    });

    it("moves when a new trip leaves the inner margin", () => {
        expect(
            shouldReframe({
                ...VIEW,
                isFollowing: true,
                hasFramed: true,
                tracksOnScreen: { minX: 10, minY: 30, maxX: 770, maxY: 570 },
            }),
        ).toBe(true);
    });

    it("never moves after the user took over or without tracks", () => {
        expect(
            shouldReframe({
                ...VIEW,
                isFollowing: false,
                hasFramed: true,
                tracksOnScreen: { minX: -500, minY: 0, maxX: 10, maxY: 10 },
            }),
        ).toBe(false);
        expect(shouldReframe({ ...VIEW, isFollowing: true, hasFramed: false, tracksOnScreen: null })).toBe(false);
    });
});

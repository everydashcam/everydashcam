import { describe, expect, it } from "vitest";

import { insetFlagHeightPx, insetMarkerSizePx, insetTrackWidthPx } from "./map-inset-scale.js";

// The export snapshot is 480 CSS px tall; its proportions are the reference.
const SNAPSHOT_HEIGHT = 480;

describe("inset map proportions", () => {
    it("keeps the exported video's car, route and radar arrow sizes", () => {
        expect(insetMarkerSizePx(SNAPSHOT_HEIGHT, "medium", false)).toBeCloseTo(50.4);
        expect(insetMarkerSizePx(SNAPSHOT_HEIGHT, "medium", true)).toBeCloseTo(55.2);
        expect(insetTrackWidthPx(SNAPSHOT_HEIGHT)).toBeCloseTo(5);
    });

    it("scales with the inset so the player and the video keep one look", () => {
        for (const height of [120, 150, 180]) {
            const ratio = height / SNAPSHOT_HEIGHT;
            expect(insetMarkerSizePx(height, "large", false), `${height}px`).toBeCloseTo(
                insetMarkerSizePx(SNAPSHOT_HEIGHT, "large", false) * ratio,
            );
            expect(insetTrackWidthPx(height), `${height}px`).toBeCloseTo(insetTrackWidthPx(SNAPSHOT_HEIGHT) * ratio);
            expect(insetFlagHeightPx(height), `${height}px`).toBeCloseTo(insetFlagHeightPx(SNAPSHOT_HEIGHT) * ratio);
        }
    });

    it("sizes flags against a medium car as the full-size map does", () => {
        expect(insetFlagHeightPx(SNAPSHOT_HEIGHT) / insetMarkerSizePx(SNAPSHOT_HEIGHT, "medium", false)).toBeCloseTo(
            32 / 44,
        );
    });
});

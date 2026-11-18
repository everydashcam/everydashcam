import { describe, expect, it } from "vitest";

import { DEFAULT_MAP_MARKER_APPEARANCE, MAP_MARKER_SHAPES } from "./map-marker-pref.js";
import {
    isMapMarkerBodyPixel,
    mapMarkerPitchScale,
    mapMarkerRenderKey,
    mapMarkerViewForPitch,
    recolorMapMarkerBodyPixel,
} from "./map-marker-renderer.js";

describe("map marker view", () => {
    it("uses overhead art on flat maps and perspective art on tilted maps", () => {
        expect(mapMarkerViewForPitch(0)).toBe("overhead");
        expect(mapMarkerViewForPitch(19.9)).toBe("overhead");
        expect(mapMarkerViewForPitch(20)).toBe("perspective");
        expect(mapMarkerViewForPitch(58)).toBe("perspective");
        expect(mapMarkerViewForPitch(70)).toBe("perspective");
    });

    it("handles out-of-range and invalid pitch without losing the flat-map fallback", () => {
        expect(mapMarkerViewForPitch(-20)).toBe("overhead");
        expect(mapMarkerViewForPitch(100)).toBe("perspective");
        for (const pitch of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            expect(mapMarkerViewForPitch(pitch)).toBe("overhead");
        }
    });

    it("caches each game arrow separately and shares vehicle art across themes", () => {
        const arrow = DEFAULT_MAP_MARKER_APPEARANCE;
        const truck = { ...arrow, shape: "truck" } as const;
        expect(mapMarkerRenderKey(arrow, "overhead", "san-andreas")).not.toBe(
            mapMarkerRenderKey(arrow, "overhead", "vice-city"),
        );
        expect(mapMarkerRenderKey(truck, "overhead", "vice-city")).toBe(mapMarkerRenderKey(truck, "overhead"));
    });

    it("separates vehicle views in render caches while sharing the arrow", () => {
        for (const shape of MAP_MARKER_SHAPES) {
            const appearance = { ...DEFAULT_MAP_MARKER_APPEARANCE, shape };
            const perspectiveKey = `${shape}:${appearance.color}`;
            expect(mapMarkerRenderKey(appearance)).toBe(perspectiveKey);
            expect(mapMarkerRenderKey(appearance, "perspective")).toBe(perspectiveKey);
            expect(mapMarkerRenderKey(appearance, "overhead")).toBe(
                shape === "arrow" ? perspectiveKey : `${perspectiveKey}:overhead`,
            );
        }
    });
});

describe("map marker recoloring", () => {
    it("selects blue paint but leaves glass, lights and tires alone", () => {
        expect(isMapMarkerBodyPixel(20, 90, 220), "blue body paint").toBe(true);
        expect(isMapMarkerBodyPixel(32, 51, 62), "blue-gray glass").toBe(false);
        expect(isMapMarkerBodyPixel(245, 235, 205), "headlight").toBe(false);
        expect(isMapMarkerBodyPixel(230, 28, 12), "tail light").toBe(false);
        expect(isMapMarkerBodyPixel(18, 18, 18), "tire").toBe(false);
    });

    it("keeps red paint red instead of wrapping its hue into black", () => {
        const [red, green, blue] = recolorMapMarkerBodyPixel(20, 90, 220, "#e5484d");
        expect(red).toBeGreaterThan(120);
        expect(red).toBeGreaterThan(green * 1.8);
        expect(red).toBeGreaterThan(blue * 1.5);
    });

    it("honors light and dark custom colors without flattening the paint", () => {
        const white = recolorMapMarkerBodyPixel(20, 90, 220, "#ffffff");
        const black = recolorMapMarkerBodyPixel(20, 90, 220, "#000000");
        expect(Math.min(...white)).toBeGreaterThan(180);
        expect(Math.max(...black)).toBeLessThan(70);
        expect(white[0]).toBe(white[1]);
        expect(black[1]).toBe(black[2]);
    });

    it("foreshortens pitched markers without collapsing them", () => {
        expect(mapMarkerPitchScale(0)).toBe(1);
        expect(mapMarkerPitchScale(58)).toBeCloseTo(0.93, 1);
        expect(mapMarkerPitchScale(70)).toBeGreaterThan(0.9);
        expect(mapMarkerPitchScale(100)).toBe(mapMarkerPitchScale(70));
    });
});

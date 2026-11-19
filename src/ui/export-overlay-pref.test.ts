import { afterEach, describe, expect, it, vi } from "vitest";

import type { OverlayPreferences } from "./export-state.js";
import {
    normalizeOverlayPreferences,
    OVERLAY_PREFERENCES_STORAGE_KEY,
    persistOverlayPreferences,
    readStoredOverlayPreferences,
} from "./export-overlay-pref.js";

function defaults(): OverlayPreferences {
    return {
        overlayStyle: "min",
        overlayAccent: "#FF9000",
        overlayScrim: false,
        overlaySpeed: { enabled: false, xPct: 0.035, yPct: 0.78, scalePct: 100 },
        overlayCoords: { enabled: false, xPct: 0.035, yPct: 0.9, scalePct: 100 },
        overlayMap: {
            enabled: false,
            provider: "openfreemap",
            xPct: 0.045,
            yPct: 0.05,
            scalePct: 100,
            zoomKm: 1,
            shape: "circle",
            theme: "neon",
            preset: "classic",
            labelScalePct: 100,
            labelDensity: "standard",
            radarMarkers: {},
            marker: { shape: "arrow", color: "#ff9000", size: "medium" },
            mode: "chase",
            pitchDeg: 58,
            buildings3d: true,
            adaptiveZoom: true,
        },
        overlayClock: { enabled: false, xPct: 0.8, yPct: 0.045, scalePct: 100 },
        overlayCompass: { enabled: false, xPct: 0.81, yPct: 0.28, scalePct: 100 },
        overlayGforce: { enabled: false, xPct: 0.81, yPct: 0.56, scalePct: 100 },
        overlayDistance: { enabled: false, xPct: 0.035, yPct: 0.68, scalePct: 100 },
        overlayGraph: { enabled: false, xPct: 0.32, yPct: 0.86, scalePct: 100 },
    };
}

function installStorage(): Map<string, string> {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    });
    return values;
}

afterEach(() => vi.unstubAllGlobals());

describe("export overlay preferences", () => {
    it("restores valid fields and falls back field by field", () => {
        const fallback = defaults();
        const restored = normalizeOverlayPreferences(
            {
                overlayStyle: "card",
                overlayAccent: "orange",
                overlayScrim: true,
                overlaySpeed: { enabled: true, xPct: 0.4, yPct: -1, scalePct: 140 },
                overlayMap: {
                    enabled: true,
                    provider: "osm-vector",
                    xPct: 0.2,
                    yPct: 0.3,
                    scalePct: 175,
                    zoomKm: 3.5,
                    shape: "triangle",
                    theme: "dark",
                    preset: "minimal",
                    labelScalePct: 150,
                    labelDensity: "more",
                    radarMarkers: {},
                    marker: { shape: "truck", color: "#E5484D", size: "large" },
                    mode: "north",
                    pitchDeg: 30,
                    buildings3d: false,
                    adaptiveZoom: false,
                },
            },
            fallback,
        );

        expect(restored.overlayStyle).toBe("card");
        expect(restored.overlayAccent).toBe(fallback.overlayAccent);
        expect(restored.overlayScrim).toBe(true);
        expect(restored.overlaySpeed).toEqual({ enabled: true, xPct: 0.4, yPct: 0.78, scalePct: 140 });
        expect(restored.overlayCoords).toEqual(fallback.overlayCoords);
        expect(restored.overlayMap).toEqual({
            enabled: true,
            provider: "osm-vector",
            xPct: 0.2,
            yPct: 0.3,
            scalePct: 175,
            zoomKm: 3.5,
            shape: "circle",
            theme: "dark",
            preset: "minimal",
            labelScalePct: 150,
            labelDensity: "more",
            radarMarkers: {},
            marker: { shape: "truck", color: "#e5484d", size: "large" },
            mode: "north",
            pitchDeg: 30,
            buildings3d: false,
            adaptiveZoom: false,
        });
    });

    it("keeps the earlier map look for layouts saved before style and building choices", () => {
        const restored = normalizeOverlayPreferences(
            { overlayMap: { enabled: true, theme: "dark", mode: "chase", preset: "busy", buildings3d: "yes" } },
            defaults(),
        );
        expect(restored.overlayMap.theme).toBe("dark");
        expect(restored.overlayMap.preset).toBe("classic");
        expect(restored.overlayMap.buildings3d).toBe(true);
    });

    it("round-trips a customized layout and removes storage for defaults", () => {
        const values = installStorage();
        const fallback = defaults();
        const customized = defaults();
        customized.overlaySpeed.enabled = true;
        customized.overlaySpeed.xPct = 0.42;
        customized.overlayMap.theme = "dark";
        customized.overlayMap.provider = "osm-vector";

        persistOverlayPreferences(customized, fallback);
        expect(values.has(OVERLAY_PREFERENCES_STORAGE_KEY)).toBe(true);
        expect(readStoredOverlayPreferences(fallback)).toEqual(customized);

        persistOverlayPreferences(fallback, fallback);
        expect(values.has(OVERLAY_PREFERENCES_STORAGE_KEY)).toBe(false);
    });

    it("rejects unavailable overlay providers without discarding the layout", () => {
        for (const provider of ["route-only", "yandex", "osm-raster", "unknown", undefined]) {
            const restored = normalizeOverlayPreferences(
                { overlayMap: { provider, enabled: true, theme: "dark", zoomKm: 2 } },
                defaults(),
            );
            expect(restored.overlayMap.provider).toBe("openfreemap");
            expect(restored.overlayMap.enabled).toBe(true);
            expect(restored.overlayMap.theme).toBe("dark");
            expect(restored.overlayMap.zoomKm).toBe(2);
        }
    });

    it("returns an independent default layout when storage is unavailable", () => {
        vi.stubGlobal("localStorage", {
            getItem: () => {
                throw new Error("blocked");
            },
        });
        const fallback = defaults();
        const restored = readStoredOverlayPreferences(fallback);
        restored.overlayMap.marker.shape = "van";
        restored.overlaySpeed.enabled = true;

        expect(fallback.overlayMap.marker.shape).toBe("arrow");
        expect(fallback.overlaySpeed.enabled).toBe(false);
    });

    it("reads and changes overlays when the storage getter is blocked", () => {
        vi.stubGlobal("localStorage", undefined);
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            get: () => {
                throw new DOMException("storage blocked", "SecurityError");
            },
        });
        const fallback = defaults();
        const restored = readStoredOverlayPreferences(fallback);
        expect(restored).toEqual(fallback);
        restored.overlayMap.enabled = true;

        expect(() => persistOverlayPreferences(restored, fallback)).not.toThrow();
        expect(() => persistOverlayPreferences(fallback, fallback)).not.toThrow();
        expect(restored.overlayMap.enabled).toBe(true);
    });
});

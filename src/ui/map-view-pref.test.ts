import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    _resetForTests,
    getMapViewPreferences,
    setMapViewPreferences,
    subscribeMapViewPreferences,
} from "./map-view-pref.js";

describe("map view preferences", () => {
    beforeEach(_resetForTests);
    afterEach(() => {
        _resetForTests();
        vi.unstubAllGlobals();
    });

    it("defaults to classic with the interface theme and 3D buildings", () => {
        vi.stubGlobal("localStorage", { getItem: () => null });
        expect(getMapViewPreferences()).toEqual({
            miniMapShape: "rect",
            style: "classic",
            theme: "auto",
            buildings3d: true,
        });
    });

    it("preserves valid fields when a saved choice is unknown", () => {
        vi.stubGlobal("localStorage", {
            getItem: () => JSON.stringify({ style: "obsolete", theme: "dark", buildings3d: false }),
        });
        expect(getMapViewPreferences()).toEqual({
            miniMapShape: "rect",
            style: "classic",
            theme: "dark",
            buildings3d: false,
        });
    });

    it("keeps both panels in sync when persistence fails", () => {
        vi.stubGlobal("localStorage", {
            getItem: () => {
                throw new DOMException("blocked", "SecurityError");
            },
            setItem: () => {
                throw new DOMException("full", "QuotaExceededError");
            },
        });
        const observed: unknown[] = [];
        const unsubscribe = subscribeMapViewPreferences((preferences) => {
            observed.push(preferences);
            preferences.style = "classic";
        });
        const preferences = { miniMapShape: "rect", style: "minimal", theme: "light", buildings3d: false } as const;
        setMapViewPreferences(preferences);
        expect(getMapViewPreferences()).toEqual(preferences);
        setMapViewPreferences(preferences);
        expect(observed).toHaveLength(1);
        unsubscribe();
        setMapViewPreferences({ ...preferences, style: "road" });
        expect(observed).toHaveLength(1);
    });

    it("keeps a manual shape until another radar theme is selected", () => {
        vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ theme: "la-92" }), setItem: () => {} });
        expect(getMapViewPreferences().miniMapShape).toBe("circle");
        setMapViewPreferences({ ...getMapViewPreferences(), miniMapShape: "rect" });
        setMapViewPreferences({ ...getMapViewPreferences(), style: "minimal" });
        expect(getMapViewPreferences().miniMapShape).toBe("rect");
        setMapViewPreferences({ ...getMapViewPreferences(), theme: "miami-86" });
        expect(getMapViewPreferences().miniMapShape).toBe("circle");
    });

    it("restores the selection after a new page session", () => {
        const storage = new Map<string, string>();
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
        });
        setMapViewPreferences({ ...getMapViewPreferences(), theme: "miami-86" });
        const preferences = { miniMapShape: "rect", style: "road", theme: "miami-86", buildings3d: false } as const;
        setMapViewPreferences(preferences);
        _resetForTests();
        expect(getMapViewPreferences()).toEqual(preferences);
    });
});

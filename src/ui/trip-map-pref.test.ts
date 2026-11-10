import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    _resetForTests,
    getTripMapPreferences,
    setTripMapPreferences,
    subscribeTripMapPreferences,
} from "./trip-map-pref.js";

const STORAGE_KEY = "everydashcam:tripMap";

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
    const values = new Map(Object.entries(initial));
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    });
    return values;
}

describe("trip map preferences", () => {
    beforeEach(() => _resetForTests());
    afterEach(() => vi.unstubAllGlobals());

    it("shows the map and the markers by default", () => {
        stubStorage();
        expect(getTripMapPreferences()).toEqual({ isShownWithoutTrip: true, shouldShowMarkers: true });
    });

    it("falls back field by field for a malformed stored value", () => {
        stubStorage({ [STORAGE_KEY]: JSON.stringify({ isShownWithoutTrip: false, shouldShowMarkers: "no" }) });
        expect(getTripMapPreferences()).toEqual({ isShownWithoutTrip: false, shouldShowMarkers: true });
    });

    it("stores a change and tells subscribers once", () => {
        const storage = stubStorage();
        const seen: boolean[] = [];
        subscribeTripMapPreferences((preferences) => seen.push(preferences.shouldShowMarkers));

        setTripMapPreferences({ isShownWithoutTrip: true, shouldShowMarkers: false });
        setTripMapPreferences({ isShownWithoutTrip: true, shouldShowMarkers: false });

        expect(seen).toEqual([false]);
        expect(JSON.parse(storage.get(STORAGE_KEY)!)).toEqual({ isShownWithoutTrip: true, shouldShowMarkers: false });
        expect(getTripMapPreferences().shouldShowMarkers).toBe(false);
    });
});

// What the map of all trips filters the list by: the place with every trip's
// passes, and the routes in the map's frame. The list's chips need both facts
// for every trip, while the map's own counts stay within the listed scope.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { driveThrough, latForNorth, lonForEast, START_SEC, type LocalFix } from "../trip-map/__fixtures__/tracks.js";
import { buildTripMapTrack } from "../trip-map/track-geometry.js";
import type { PackedTripTrack } from "../trip-map/track-input.js";
import { worldX, worldY, type WorldBounds } from "../trip-map/world.js";
import type { GpsRecord } from "../parsers/types.js";
import type { Trip } from "../trips.js";

// The worker is a browser API; the same simplification runs here in-process.
vi.mock("./trip-map-worker-client.js", () => ({
    requestTripMapTrack: async (_id: number, packed: PackedTripTrack) => buildTripMapTrack(packed),
    releaseTripMapTracks: () => {},
    setTripMapWorkerCrashHandler: () => {},
}));

import { state } from "./state.js";
import { syncTripMapLibrary } from "./trip-map-library.js";
import {
    _resetForTests,
    countTripsThrough,
    setTripMapFrame,
    setTripMapPlace,
    setTripMapScope,
    subscribeTripMapSearch,
    tripMapAreaCount,
    tripMapFactsFor,
    tripMapPassesFor,
} from "./trip-map-search.js";

function buildTrip(name: string, fixes: readonly LocalFix[]): Trip {
    const records = fixes.map(
        (fix) =>
            ({
                unixSeconds: fix.unixSeconds,
                active: true,
                lat: latForNorth(fix.northM),
                lon: lonForEast(fix.eastM),
                bearingDeg: 0,
                speedMs: 12,
            }) as GpsRecord,
    );
    const candidate = { file: new File([name], name, { lastModified: 1 }), relativePath: name };
    return { records, frames: [{ channels: { front: candidate } }] } as unknown as Trip;
}

function circleAt(eastM: number, northM: number, radiusMeters = 20) {
    return { x: worldX(lonForEast(eastM)), y: worldY(latForNorth(northM)), radiusMeters };
}

function areaAround(eastM: number, northM: number, halfSizeM: number): WorldBounds {
    const min = { x: worldX(lonForEast(eastM - halfSizeM)), y: worldY(latForNorth(northM + halfSizeM)) };
    const max = { x: worldX(lonForEast(eastM + halfSizeM)), y: worldY(latForNorth(northM - halfSizeM)) };
    return { minX: min.x, minY: min.y, maxX: max.x, maxY: max.y };
}

/** Three trips: two along the same road east, one far north, plus one without GPS. */
async function loadLibrary(): Promise<void> {
    state.trips = [
        buildTrip(
            "east-1.mp4",
            driveThrough([
                [0, 0],
                [1000, 0],
            ]),
        ),
        buildTrip(
            "north.mp4",
            driveThrough([
                [0, 5000],
                [1000, 5000],
            ]),
        ),
        buildTrip(
            "east-2.mp4",
            driveThrough(
                [
                    [1000, 0],
                    [0, 0],
                ],
                { startSec: START_SEC + 3600 },
            ),
        ),
        buildTrip("no-gps.mp4", []),
    ];
    syncTripMapLibrary(state.trips);
    // Track requests resolve on the microtask queue.
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("trip map search", () => {
    beforeEach(async () => {
        _resetForTests();
        state.tripFilters.place = false;
        state.tripFilters.mapArea = false;
        await loadLibrary();
    });

    it("finds the trips through a place with their pass times", async () => {
        let notifications = 0;
        subscribeTripMapSearch(() => notifications++);

        setTripMapPlace(circleAt(500, 0));
        await settle();

        expect(state.tripFilters.place).toBe(true);
        expect([0, 1, 2, 3].map((index) => tripMapFactsFor(index).passesPlace)).toEqual([true, false, true, false]);
        expect(tripMapPassesFor(0)[0]!.unixSeconds).toBeCloseTo(START_SEC + 41.5, 0);
        expect(tripMapPassesFor(2)[0]!.unixSeconds).toBeCloseTo(START_SEC + 3600 + 41.5, 0);
        expect(tripMapFactsFor(3).hasTrack, "a trip without GPS has no track").toBe(false);
        expect(notifications).toBe(1);

        setTripMapPlace(null);
        await settle();
        expect(state.tripFilters.place).toBe(false);
        expect(tripMapPassesFor(0)).toEqual([]);
    });

    it("keeps place facts for trips outside the list's scope while counting only the scope", () => {
        setTripMapScope([0, 1, 3]);
        const place = circleAt(500, 0);
        setTripMapPlace(place);

        expect(tripMapFactsFor(2).passesPlace, "the chips count unlisted trips too").toBe(true);
        expect(countTripsThrough(place), "the probe counts listed trips only").toBe(1);
    });

    it("filters by the frame only while it hides a listed route", () => {
        setTripMapFrame(areaAround(500, 0, 2000));

        expect(state.tripFilters.mapArea).toBe(true);
        expect([0, 1, 2].map((index) => tripMapFactsFor(index).inMapArea)).toEqual([true, false, true]);
        expect(tripMapAreaCount()).toBe(2);

        // The only route outside the frame is not listed: the list stays whole.
        setTripMapScope([0, 2, 3]);
        expect(state.tripFilters.mapArea).toBe(false);
        expect(tripMapAreaCount()).toBeNull();

        setTripMapScope([0, 1, 2, 3]);
        setTripMapFrame(areaAround(500, 2500, 4000));
        expect(state.tripFilters.mapArea, "every route in frame").toBe(false);

        setTripMapFrame(null);
        expect(state.tripFilters.mapArea).toBe(false);
    });
});

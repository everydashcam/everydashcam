// The trip map library keys geometries by what they were built from. A trip
// whose GPS changes needs a new geometry from the worker; until it arrives the
// trip keeps its drawn one, or it would leave a place filtered list for a moment.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { driveThrough, latForNorth, lonForEast, type LocalFix } from "../trip-map/__fixtures__/tracks.js";
import { buildTripMapTrack, type TripMapTrack } from "../trip-map/track-geometry.js";
import type { PackedTripTrack } from "../trip-map/track-input.js";
import type { GpsRecord } from "../parsers/types.js";
import type { Trip } from "../trips.js";

interface PendingTrack {
    id: number;
    packed: PackedTripTrack;
    resolve: (track: TripMapTrack) => void;
    reject: (error: Error) => void;
}

const worker = vi.hoisted(() => ({ pending: [] as PendingTrack[], released: [] as number[] }));

// The worker is a browser API; the test answers its track requests by hand.
vi.mock("./trip-map-worker-client.js", () => ({
    requestTripMapTrack: (id: number, packed: PackedTripTrack) =>
        new Promise<TripMapTrack>((resolve, reject) => worker.pending.push({ id, packed, resolve, reject })),
    releaseTripMapTracks: (ids: number[]) => worker.released.push(...ids),
    setTripMapWorkerCrashHandler: () => {},
}));

import { _resetForTests, syncTripMapLibrary, tripMapEntries } from "./trip-map-library.js";

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

/** Answers the oldest track request the way the worker would. */
async function answerNext(): Promise<void> {
    const request = worker.pending.shift()!;
    request.resolve(buildTripMapTrack(request.packed));
    for (let i = 0; i < 3; i++) await Promise.resolve();
}

async function failNext(): Promise<void> {
    worker.pending.shift()!.reject(new Error("bad track"));
    for (let i = 0; i < 3; i++) await Promise.resolve();
}

const ROAD: [number, number][] = [
    [0, 0],
    [1000, 0],
];
const LONGER_ROAD: [number, number][] = [
    [0, 0],
    [2000, 0],
];

describe("trip map library", () => {
    beforeEach(() => {
        _resetForTests();
        worker.pending.length = 0;
        worker.released.length = 0;
    });

    it("keeps a trip on its drawn geometry until the geometry of its new GPS arrives", async () => {
        syncTripMapLibrary([buildTrip("A.MP4", driveThrough(ROAD))]);
        await answerNext();
        const drawn = tripMapEntries()[0]!;
        expect(drawn.track, "the first geometry is drawn").not.toBeNull();

        // More of the same recording's GPS was read.
        syncTripMapLibrary([buildTrip("A.MP4", driveThrough(LONGER_ROAD))]);
        expect(tripMapEntries()[0], "the trip stands on its drawn geometry").toBe(drawn);
        expect(worker.released, "the drawn geometry is kept").toEqual([]);

        await answerNext();
        const replaced = tripMapEntries()[0]!;
        expect(replaced.id).not.toBe(drawn.id);
        expect(replaced.track).not.toBeNull();
        expect(worker.released, "the old geometry goes once the new one is in").toEqual([drawn.id]);
    });

    it("takes the trip off the map when its new geometry fails", async () => {
        syncTripMapLibrary([buildTrip("A.MP4", driveThrough(ROAD))]);
        await answerNext();
        const drawn = tripMapEntries()[0]!;

        syncTripMapLibrary([buildTrip("A.MP4", driveThrough(LONGER_ROAD))]);
        await failNext();

        expect(tripMapEntries()[0]!.track, "a failed geometry has no route").toBeNull();
        expect(worker.released).toEqual([drawn.id]);
    });

    it("waits without a route for a trip whose recordings were never drawn", () => {
        syncTripMapLibrary([buildTrip("A.MP4", driveThrough(ROAD))]);

        expect(tripMapEntries()[0]!.track).toBeNull();
    });
});

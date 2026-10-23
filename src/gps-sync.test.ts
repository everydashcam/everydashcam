import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    _resetForTests,
    applyStoredGpsSyncToTrip,
    applyStoredGpsSyncToTrips,
    gpsSyncPeerTrips,
    gpsTrackOverhangSec,
    normalizeGpsOffsetSec,
    rawGpsStartUnix,
    resolvedGpsSyncForTrip,
    setTripGpsOffsetSec,
    setTripGpsTrimToVideo,
} from "./gps-sync.js";
import type { GpsRecord } from "./parsers/types.js";
import { groupTrips, type Trip, type VideoCandidate } from "./trips.js";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
});

function record(unixSeconds: number, index: number): GpsRecord {
    return {
        unixSeconds,
        active: true,
        lat: 43.2 + index * 0.0001,
        lon: 76.9 + index * 0.0001,
        bearingDeg: 45,
        speedMs: 10,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename: "action.mp4",
    };
}

function candidate(records: GpsRecord[], lastModified = 1234): VideoCandidate {
    return {
        file: new File([new Uint8Array(32)], "action.mp4", { lastModified }),
        relativePath: "DCIM/action.mp4",
        fingerprint: "action-camera",
        appliedExtractors: ["gpx"],
        classifierMatches: { time: null, channel: null, mode: null, sequence: null },
        channel: null,
        channelConfident: false,
        sequence: null,
        recordingMode: "normal",
        isTimelapse: false,
        startUtc: 1000,
        durationSec: 20,
        wallDurationSec: null,
        driftLeadSec: null,
        startSource: "mp4",
        cameraTzSec: null,
        createdUtc: null,
        records,
        codec: "avc",
        codecParam: "avc1",
        videoCodecString: null,
        rotation: 0,
        width: 1920,
        height: 1080,
        fps: 30,
        audio: null,
        canPlay: true,
        needsHevcRemux: false,
        isTransportStream: false,
        isMatroska: false,
        audioNeedsTranscode: false,
        embeddedStartUtcHint: null,
        localClockOffsetHintSec: null,
    };
}

function trip(lastModified = 1234): Trip {
    const records = [995, 1000, 1010, 1025].map(record);
    return groupTrips([candidate(records, lastModified)])[0]!;
}

beforeEach(() => {
    storage.clear();
    _resetForTests();
});

afterEach(() => vi.restoreAllMocks());

describe("GPS synchronization", () => {
    it("always shifts from immutable candidate records and restores points hidden by a previous trim", () => {
        const value = trip();
        const rawTimes = value.frames[0]!.channels.front!.records.map((item) => item.unixSeconds);

        setTripGpsTrimToVideo(value, true);
        setTripGpsOffsetSec(value, 5);
        applyStoredGpsSyncToTrip(value);
        expect(value.records.map((item) => item.unixSeconds)).toEqual([1000, 1005, 1015]);

        setTripGpsOffsetSec(value, -5);
        applyStoredGpsSyncToTrip(value);
        expect(value.records.map((item) => item.unixSeconds)).toEqual([1005, 1020]);
        expect(value.frames[0]!.channels.front!.records.map((item) => item.unixSeconds)).toEqual(rawTimes);
    });

    it("lets the user keep or hide GPS outside the footage window", () => {
        const value = trip();
        expect(gpsTrackOverhangSec(value, 0)).toBe(10);
        expect(resolvedGpsSyncForTrip(value).trimToVideo).toBe(false);

        applyStoredGpsSyncToTrip(value);
        expect(value.records.map((item) => item.unixSeconds)).toEqual([995, 1000, 1010, 1025]);

        setTripGpsTrimToVideo(value, true);
        applyStoredGpsSyncToTrip(value);
        expect(value.records.map((item) => item.unixSeconds)).toEqual([1000, 1010]);
    });

    it.each([
        [0, 20],
        [50, 0],
    ])("ignores missing-signal edges around valid (%s, %s) fixes when aligning the track", (lat, lon) => {
        const source = [
            { ...record(900, 0), lat: 0, lon: 0, accelYg: 0.8 },
            { ...record(995, 1), lat, lon },
            { ...record(1025, 2), lat, lon },
            { ...record(1100, 3), lat: 0, lon: 0 },
        ];
        const value = groupTrips([candidate(source)])[0]!;
        expect(rawGpsStartUnix(value)).toBe(995);
        expect(gpsTrackOverhangSec(value, 0)).toBe(10);
        expect(gpsTrackOverhangSec(value, 5)).toBe(10);
        expect(source[0]).toMatchObject({ unixSeconds: 900, accelYg: 0.8 });
        expect(value.records).toHaveLength(source.length);
    });

    it("has no GPS alignment start or overhang when every position is missing", () => {
        const source = [900, 1100].map((time, index) => ({ ...record(time, index), lat: 0, lon: 0 }));
        const value = groupTrips([candidate(source)])[0]!;
        expect(rawGpsStartUnix(value)).toBeNull();
        expect(gpsTrackOverhangSec(value, 0)).toBe(0);
    });

    it("keeps an external track on its absolute clock until the user applies an offset", () => {
        const rawStart = 100_000;
        const external = [rawStart, rawStart + 10, rawStart + 25].map((time, index) => ({
            ...record(time, index),
            externalTrack: true,
            externalTrackKey: "route-a",
        }));
        const value = groupTrips([candidate(external)])[0]!;

        applyStoredGpsSyncToTrip(value);
        expect(value.gpsOffsetSec).toBe(0);
        expect(value.records.map((item) => item.unixSeconds)).toEqual([100_000, 100_010, 100_025]);

        setTripGpsOffsetSec(value, 1000 - rawStart);
        applyStoredGpsSyncToTrip(value);
        expect(value.records.map((item) => item.unixSeconds)).toEqual([1000, 1010, 1025]);
        expect(external[0]!.unixSeconds).toBe(rawStart);
    });

    it("keeps one external track synchronized across consecutive action-camera clips", () => {
        const rawStart = 1000;
        const external = [0, 10, 25, 35, 45].map((delta, index) => ({
            ...record(rawStart + delta, index),
            externalTrack: true,
        }));
        const first = candidate(external);
        const second = candidate([], 5678);
        second.file = new File([new Uint8Array(32)], "action-2.mp4", { lastModified: 5678 });
        second.relativePath = "DCIM/action-2.mp4";
        second.startUtc = 1020;

        const value = groupTrips([first, second])[0]!;
        expect(value.frames).toHaveLength(2);
        setTripGpsTrimToVideo(value, true);
        applyStoredGpsSyncToTrip(value);

        // The GPX is associated with the first file but belongs to the whole
        // derived trip; trimming uses both footage spans and drops only the
        // point beyond the second clip.
        expect(value.records.map((item) => item.unixSeconds)).toEqual([1000, 1010, 1025, 1035]);
    });

    it("does not reuse an external-track override for another GPX on the same video", () => {
        const first = [record(1000, 0)].map((item) => ({
            ...item,
            externalTrack: true,
            externalTrackKey: "route-a",
        }));
        const firstTrip = groupTrips([candidate(first)])[0]!;
        setTripGpsOffsetSec(firstTrip, 7);
        expect(resolvedGpsSyncForTrip(firstTrip).offsetSec).toBe(7);

        const second = [record(1000, 0)].map((item) => ({
            ...item,
            externalTrack: true,
            externalTrackKey: "route-b",
        }));
        const secondTrip = groupTrips([candidate(second)])[0]!;
        expect(resolvedGpsSyncForTrip(secondTrip).hasOffsetOverride).toBe(false);
        expect(resolvedGpsSyncForTrip(secondTrip).offsetSec).toBe(0);
    });

    it("persists a trip offset across reloads and treats zero as a reset", () => {
        const firstLoad = trip();
        setTripGpsOffsetSec(firstLoad, 12);
        applyStoredGpsSyncToTrip(firstLoad);
        expect(firstLoad.gpsOffsetSec).toBe(12);
        expect(resolvedGpsSyncForTrip(firstLoad).hasOffsetOverride).toBe(true);

        // Fresh Trip and File objects with the same stable identity simulate a
        // later folder re-open; the per-trip override must survive it.
        const reopened = trip();
        applyStoredGpsSyncToTrip(reopened);
        expect(reopened.gpsOffsetSec).toBe(12);

        setTripGpsOffsetSec(reopened, 0);
        applyStoredGpsSyncToTrip(reopened);
        expect(reopened.gpsOffsetSec).toBe(0);
        expect(resolvedGpsSyncForTrip(reopened).hasOffsetOverride).toBe(false);
    });

    it("keeps calibration and trimming in the session when an existing storage entry cannot be overwritten", () => {
        const value = trip();
        setTripGpsOffsetSec(value, 1);
        vi.spyOn(localStorage, "setItem").mockImplementation(() => {
            throw new DOMException("quota exceeded", "QuotaExceededError");
        });

        setTripGpsOffsetSec(value, 5);
        setTripGpsTrimToVideo(value, true);
        applyStoredGpsSyncToTrip(value);
        expect(resolvedGpsSyncForTrip(value)).toEqual({ offsetSec: 5, trimToVideo: true, hasOffsetOverride: true });
        expect(
            value.records.map((item) => item.unixSeconds),
            "unsaved trim applies to the unsaved offset",
        ).toEqual([1000, 1005, 1015]);

        setTripGpsOffsetSec(value, null);
        setTripGpsTrimToVideo(value, false);
        applyStoredGpsSyncToTrip(value);
        expect(resolvedGpsSyncForTrip(value), "reset cannot resurrect the stale stored offset").toEqual({
            offsetSec: 0,
            trimToVideo: false,
            hasOffsetOverride: false,
        });
        expect(value.records.map((item) => item.unixSeconds)).toEqual([995, 1000, 1010, 1025]);
    });

    it("persists all pending trip calibrations when storage writes recover", () => {
        const first = trip(2001);
        const second = trip(2002);
        setTripGpsOffsetSec(first, 1);
        const setItemSpy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
            throw new DOMException("quota exceeded", "QuotaExceededError");
        });
        setTripGpsOffsetSec(first, 5);
        setTripGpsOffsetSec(second, 9);
        setItemSpy.mockRestore();

        setTripGpsTrimToVideo(first, true);
        _resetForTests();
        const reopenedFirst = trip(2001);
        const reopenedSecond = trip(2002);
        applyStoredGpsSyncToTrips([reopenedFirst, reopenedSecond]);
        expect(reopenedFirst.gpsOffsetSec, "the first pending calibration survives reload").toBe(5);
        expect(reopenedFirst.gpsTrimToVideo).toBe(true);
        expect(reopenedSecond.gpsOffsetSec, "the second pending calibration survives reload").toBe(9);
    });

    it("loads the stored-entry snapshot once for a bulk apply", () => {
        const first = trip(2001);
        const second = trip(2002);
        setTripGpsOffsetSec(first, 4);
        setTripGpsOffsetSec(second, 9);

        const getItemSpy = vi.spyOn(localStorage, "getItem");
        applyStoredGpsSyncToTrips([first, second]);

        const syncReads = getItemSpy.mock.calls.filter(([key]) => key === "everydashcam:trips:gpsSync");
        expect(syncReads).toHaveLength(1);
        expect(first.gpsOffsetSec).toBe(4);
        expect(second.gpsOffsetSec).toBe(9);
        getItemSpy.mockRestore();
    });

    it("offers only native-GPS trips from the same camera as batch peers", () => {
        const source = trip(1001);
        const sameCamera = trip(1002);
        const otherCamera = trip(1003);
        otherCamera.frames[0]!.channels.front!.fingerprint = "other-camera";
        const external = trip(1004);
        external.frames[0]!.channels.front!.records = external.frames[0]!.channels.front!.records.map((item) => ({
            ...item,
            externalTrack: true,
        }));

        expect(gpsSyncPeerTrips(source, [source, sameCamera, otherCamera, external])).toEqual([sameCamera]);
        expect(gpsSyncPeerTrips(external, [source, sameCamera, external])).toEqual([]);
    });

    it("accepts offsets large enough for a camera clock reset to 1970", () => {
        const fiftySixYearsSec = 56 * 365.25 * 24 * 60 * 60;
        expect(normalizeGpsOffsetSec(fiftySixYearsSec)).toBeCloseTo(fiftySixYearsSec, 3);
    });
});

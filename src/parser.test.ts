// Unit tests for generic GpsRecord utilities:
// - haversineKm: total distance and point-to-point distances.
// - findNearestIndex: binary search for nearest record.
// - interpolatePosition: interpolation between points + tolerance.
// - dedupRecords: deduplication by composite key.
// - fillForwardBearings: bearing fill with look-ahead and inheritance.
// - totalDistanceKm: total distance via haversine.
//
// These functions are hot-path in the player (called on every timeupdate / hover),
// their behavior determines map marker UX.

import { describe, expect, it } from "vitest";

import {
    accelMagnitude,
    cloneRecordsAcrossChannels,
    dedupRecords,
    dropTeleportOutliers,
    fillForwardBearings,
    findNearestIndex,
    firstSyncedRecord,
    forwardFillBearingsIfAllZero,
    freezeStationaryBearings,
    cumulativeDistanceKm,
    haversineKm,
    interpolatePosition,
    lastSyncedRecord,
    mergeIntoGpsLog,
    rebindOrphanLogRecords,
    rebuildLog,
    recordsHaveGps,
    thinDenseRecords,
    totalDistanceKm,
    unionStringArrays,
} from "./parser.js";
import { detectEvents } from "./events.js";
import type { GpsRecord, ParsedLog, SkippedLine, VendorFile } from "./parsers/types.js";
import { vendorFileKey } from "./vendor-file-key.js";

function rec(unixSeconds: number, lat: number, lon: number, overrides: Partial<GpsRecord> = {}): GpsRecord {
    return {
        unixSeconds,
        active: true,
        lat,
        lon,
        bearingDeg: 0,
        speedMs: 0,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename: "x.mp4",
        ...overrides,
    };
}

describe("haversineKm", () => {
    it("returns 0 for identical points", () => {
        expect(haversineKm(55.75, 37.6, 55.75, 37.6)).toBe(0);
    });

    it("approximates 1 degree of latitude near equator ≈ 111 km", () => {
        const d = haversineKm(0, 0, 1, 0);
        expect(d).toBeGreaterThan(110);
        expect(d).toBeLessThan(112);
    });

    it("1 degree of longitude at 60° latitude ≈ 55.6 km (cos(60°) * 111)", () => {
        const d = haversineKm(60, 0, 60, 1);
        expect(d).toBeGreaterThan(55);
        expect(d).toBeLessThan(56);
    });

    it("known distance Moscow → St. Petersburg ≈ 634 km", () => {
        const d = haversineKm(55.7558, 37.6173, 59.9343, 30.3351);
        // Great-circle distance ~634 km; haversine with R=6371 gives ~632, tolerance 5 km.
        expect(d).toBeGreaterThan(627);
        expect(d).toBeLessThan(637);
    });

    it("symmetric (a → b same as b → a)", () => {
        const ab = haversineKm(40, -100, 50, -90);
        const ba = haversineKm(50, -90, 40, -100);
        expect(ab).toBeCloseTo(ba, 9);
    });

    it("antipodal points ≈ π * R", () => {
        const d = haversineKm(0, 0, 0, 180);
        const expected = Math.PI * 6371;
        expect(d).toBeCloseTo(expected, 1);
    });
});

describe("totalDistanceKm", () => {
    it("returns 0 for empty/null/single", () => {
        expect(totalDistanceKm(null)).toBe(0);
        expect(totalDistanceKm(undefined)).toBe(0);
        expect(totalDistanceKm([])).toBe(0);
        expect(totalDistanceKm([rec(0, 55, 37)])).toBe(0);
    });

    it("sums haversine across all consecutive active records", () => {
        const records = [rec(0, 0, 0), rec(1, 1, 0), rec(2, 2, 0)];
        const expected = 2 * haversineKm(0, 0, 1, 0);
        expect(totalDistanceKm(records)).toBeCloseTo(expected, 6);
    });

    it("skips records with active=false (no fix gaps don't inflate distance)", () => {
        const records = [
            rec(0, 0, 0),
            rec(1, 10, 10, { active: false }), // lost fix - skipped
            rec(2, 1, 0),
        ];
        // Skip the middle point - distance is computed 0→2 directly (1 deg),
        // as if the lost point never existed: prev tracks last active record.
        const expected = haversineKm(0, 0, 1, 0);
        expect(totalDistanceKm(records)).toBeCloseTo(expected, 6);
    });
});

describe("cumulativeDistanceKm", () => {
    it("returns an empty array for empty/null/undefined", () => {
        expect(cumulativeDistanceKm(null)).toHaveLength(0);
        expect(cumulativeDistanceKm(undefined)).toHaveLength(0);
        expect(cumulativeDistanceKm([])).toHaveLength(0);
    });

    it("starts at zero and grows with each leg", () => {
        const records = [rec(0, 0, 0), rec(1, 1, 0), rec(2, 2, 0)];
        const leg = haversineKm(0, 0, 1, 0);
        const prefix = cumulativeDistanceKm(records);
        expect(prefix[0]).toBe(0);
        expect(prefix[1]).toBeCloseTo(leg, 6);
        expect(prefix[2]).toBeCloseTo(2 * leg, 6);
    });

    it("carries the running total across a lost fix without advancing it", () => {
        const records = [rec(0, 0, 0), rec(1, 10, 10, { active: false }), rec(2, 1, 0)];
        const prefix = cumulativeDistanceKm(records);
        // The lost-fix record keeps the total it inherited - stepping onto it
        // must not credit the coordinate jump that its stale lat/lon implies.
        expect(prefix[1]).toBe(0);
        expect(prefix[2]).toBeCloseTo(haversineKm(0, 0, 1, 0), 6);
    });

    it("ends on the same total as totalDistanceKm", () => {
        const records = [
            rec(0, 55.75, 37.6),
            rec(1, 55.76, 37.61),
            rec(2, 10, 10, { active: false }),
            rec(3, 55.77, 37.62),
            rec(4, 55.78, 37.63),
        ];
        const prefix = cumulativeDistanceKm(records);
        expect(prefix[prefix.length - 1], "prefix tail must agree with the whole-track sum").toBeCloseTo(
            totalDistanceKm(records),
            9,
        );
    });
});

describe("recordsHaveGps", () => {
    it("is false for empty/null/undefined", () => {
        expect(recordsHaveGps(null)).toBe(false);
        expect(recordsHaveGps(undefined)).toBe(false);
        expect(recordsHaveGps([])).toBe(false);
    });

    it("is true when at least one record has a valid fix", () => {
        expect(recordsHaveGps([rec(0, 55, 37)])).toBe(true);
        expect(recordsHaveGps([rec(0, 0, 0, { active: false }), rec(1, 55, 37)])).toBe(true);
    });

    it("is false when every record is a lost fix (active=false)", () => {
        // The driver of the GPS-dependent export gate: a trip whose records all
        // lack a fix carries no usable GPS, so telemetry/overlays/.gpx are off.
        expect(recordsHaveGps([rec(0, 0, 0, { active: false }), rec(1, 10, 10, { active: false })])).toBe(false);
    });

    it("ignores active records whose coordinates cannot describe a valid fix", () => {
        const invalid = [rec(0, Number.NaN, 37), rec(1, 55, Number.POSITIVE_INFINITY), rec(2, 91, 37), rec(3, 55, 181)];
        expect(recordsHaveGps(invalid)).toBe(false);
        expect(recordsHaveGps([...invalid, rec(4, 55, 37)])).toBe(true);
    });
});

describe("findNearestIndex", () => {
    const records = [rec(100, 0, 0), rec(200, 0, 0), rec(300, 0, 0), rec(400, 0, 0)];

    it("returns -1 for empty array", () => {
        expect(findNearestIndex([], 100)).toBe(-1);
    });

    it("returns 0 for single-element array regardless of target", () => {
        expect(findNearestIndex([rec(500, 0, 0)], 100)).toBe(0);
        expect(findNearestIndex([rec(500, 0, 0)], 1000)).toBe(0);
    });

    it("finds exact match", () => {
        expect(findNearestIndex(records, 200)).toBe(1);
        expect(findNearestIndex(records, 400)).toBe(3);
    });

    it("finds nearest when between two points (prefers earlier on tie)", () => {
        // 150 is equidistant from 100 and 200 - return 0 (prefer left).
        expect(findNearestIndex(records, 150)).toBe(0);
        // 250 is equidistant from 200 and 300 - return 1.
        expect(findNearestIndex(records, 250)).toBe(1);
    });

    it("finds nearest when between two points (asymmetric)", () => {
        expect(findNearestIndex(records, 240)).toBe(1); // closer to 200
        expect(findNearestIndex(records, 260)).toBe(2); // closer to 300
    });

    it("clamps to first when before first", () => {
        expect(findNearestIndex(records, 0)).toBe(0);
        expect(findNearestIndex(records, -1000)).toBe(0);
    });

    it("clamps to last when after last", () => {
        expect(findNearestIndex(records, 500)).toBe(3);
        expect(findNearestIndex(records, 1e9)).toBe(3);
    });

    it("works on huge arrays in O(log N) (no timeout on 100k points)", () => {
        const big = Array.from({ length: 100_000 }, (_, i) => rec(i, 0, 0));
        // Linear search would be noticeable at 100k; binary search is O(log 100k) ≈ 17.
        expect(findNearestIndex(big, 50_000)).toBe(50_000);
        expect(findNearestIndex(big, 99_999)).toBe(99_999);
    });
});

describe("interpolatePosition", () => {
    it("returns null for empty array", () => {
        expect(interpolatePosition([], 100)).toBeNull();
    });

    it("keeps a single fix visible only within the endpoint tolerance", () => {
        const records = [rec(100, 55, 37, { bearingDeg: 90, speedMs: 5 })];
        for (const target of [95, 100, 105]) {
            expect(interpolatePosition(records, target)).toEqual({ lat: 55, lon: 37, bearingDeg: 90, speedMs: 5 });
        }
        expect(interpolatePosition(records, 94.999)).toBeNull();
        expect(interpolatePosition(records, 105.001)).toBeNull();
    });

    it("hides the position through a lost-fix interval and returns the exact recovered fix", () => {
        const records = [
            rec(100, 43, 77),
            rec(101, 0, 0, { active: false }),
            rec(102, 0, 0, { active: false }),
            rec(103, 43.0001, 77.0001),
            rec(104, 43.0002, 77.0002),
        ];
        expect(interpolatePosition(records, 100)).toMatchObject({ lat: 43, lon: 77 });
        for (const target of [100.5, 101, 101.5, 102, 102.5]) {
            expect(interpolatePosition(records, target), `lost fix at ${target}`).toBeNull();
        }
        expect(interpolatePosition(records, 103)).toMatchObject({ lat: 43.0001, lon: 77.0001 });
        expect(interpolatePosition(records, 103.5)!.lat).toBeCloseTo(43.00015, 8);
    });

    it("uses a valid concurrent fix when another channel has no fix at that timestamp", () => {
        const records = [
            rec(100, 0, 0, { active: false }),
            rec(100, 43, 77),
            rec(101, 43.0001, 77.0001),
            rec(101, 0, 0, { active: false }),
        ];
        expect(interpolatePosition(records, 100)).toMatchObject({ lat: 43, lon: 77 });
        expect(interpolatePosition(records, 100.5)!.lat).toBeCloseTo(43.00005, 8);
        expect(interpolatePosition(records, 101)).toMatchObject({ lat: 43.0001, lon: 77.0001 });
        expect(interpolatePosition(records, 102)).toMatchObject({ lat: 43.0001, lon: 77.0001 });
    });

    it.each<Partial<GpsRecord>>([
        { active: false },
        { lat: Number.NaN },
        { lon: Number.POSITIVE_INFINITY },
        { lat: 90.1 },
        { lat: -90.1 },
        { lon: 180.1 },
        { lon: -180.1 },
        { bearingDeg: Number.NaN },
        { speedMs: Number.POSITIVE_INFINITY },
        { speedMs: -1 },
    ])("rejects an invalid position record %j without poisoning adjacent exact fixes", (overrides) => {
        const records = [rec(100, 43, 77), rec(101, 43, 77, overrides), rec(102, 43.0001, 77.0001)];
        for (const target of [100.5, 101, 101.5]) {
            expect(interpolatePosition(records, target), `invalid fix at ${target}`).toBeNull();
        }
        expect(interpolatePosition(records, 100)).not.toBeNull();
        expect(interpolatePosition(records, 102)).not.toBeNull();
        expect(interpolatePosition([records[1]!], 101)).toBeNull();
    });

    it("rejects a non-finite playhead time", () => {
        const records = [rec(100, 43, 77), rec(101, 43.0001, 77.0001)];
        for (const target of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            expect(interpolatePosition(records, target)).toBeNull();
        }
    });

    it.each([
        [179.9, -179.9, 179.95, -179.95],
        [-179.9, 179.9, -179.95, 179.95],
    ])("crosses the antimeridian along the short arc from %s to %s", (from, to, quarter, threeQuarters) => {
        const records = [rec(100, 43, from), rec(104, 43, to)];
        expect(interpolatePosition(records, 101)!.lon).toBeCloseTo(quarter, 8);
        expect(Math.abs(interpolatePosition(records, 102)!.lon)).toBeCloseTo(180, 8);
        expect(interpolatePosition(records, 103)!.lon).toBeCloseTo(threeQuarters, 8);
    });

    it("interpolates linearly between two points at t=0.5", () => {
        const records = [rec(100, 0, 0, { bearingDeg: 0, speedMs: 0 }), rec(200, 2, 4, { bearingDeg: 0, speedMs: 10 })];
        const result = interpolatePosition(records, 150)!;
        expect(result.lat).toBeCloseTo(1, 9);
        expect(result.lon).toBeCloseTo(2, 9);
        expect(result.speedMs).toBeCloseTo(5, 9);
    });

    it("returns exact prev at t=0", () => {
        const records = [
            rec(100, 1, 1, { bearingDeg: 45, speedMs: 3 }),
            rec(200, 2, 2, { bearingDeg: 90, speedMs: 8 }),
        ];
        const result = interpolatePosition(records, 100)!;
        expect(result.lat).toBeCloseTo(1, 9);
        expect(result.lon).toBeCloseTo(1, 9);
        expect(result.bearingDeg).toBeCloseTo(45, 9);
        expect(result.speedMs).toBeCloseTo(3, 9);
    });

    it("handles bearing wrap (350° → 10° interpolates through 0°, not 180°)", () => {
        const records = [rec(100, 0, 0, { bearingDeg: 350 }), rec(200, 0, 0, { bearingDeg: 10 })];
        // At midpoint expect 0° (or close), not 180°.
        const result = interpolatePosition(records, 150)!;
        // Allow small deviation due to normalization into [0, 360).
        const normalized = result.bearingDeg > 180 ? result.bearingDeg - 360 : result.bearingDeg;
        expect(normalized).toBeCloseTo(0, 5);
    });

    it("handles reverse bearing wrap (10° → 350° goes through 0°)", () => {
        const records = [rec(100, 0, 0, { bearingDeg: 10 }), rec(200, 0, 0, { bearingDeg: 350 })];
        const result = interpolatePosition(records, 150)!;
        // 10 + (-20)*0.5 = 0; normalized = 0.
        const normalized = result.bearingDeg > 180 ? result.bearingDeg - 360 : result.bearingDeg;
        expect(normalized).toBeCloseTo(0, 5);
    });

    it("clamps to first point if target within TOLERANCE before first", () => {
        const records = [rec(100, 55, 37), rec(200, 56, 38)];
        const result = interpolatePosition(records, 96)!;
        // 96 < 100, delta 4s < 5 - return first.
        expect(result.lat).toBeCloseTo(55, 9);
    });

    it("returns null if target too far before first (tolerance 5 sec)", () => {
        const records = [rec(100, 55, 37), rec(200, 56, 38)];
        expect(interpolatePosition(records, 90)).toBeNull();
    });

    it("clamps to last point if target within TOLERANCE after last", () => {
        const records = [rec(100, 55, 37), rec(200, 56, 38)];
        const result = interpolatePosition(records, 204)!;
        expect(result.lat).toBeCloseTo(56, 9);
    });

    it("returns null if target too far after last (tolerance 5 sec)", () => {
        const records = [rec(100, 55, 37), rec(200, 56, 38)];
        expect(interpolatePosition(records, 300)).toBeNull();
    });

    it("handles zero-span (two records with same timestamp)", () => {
        const records = [
            rec(100, 1, 1, { bearingDeg: 0, speedMs: 5 }),
            rec(100, 2, 2, { bearingDeg: 90, speedMs: 10 }),
        ];
        // span=0 → return prev without interpolation.
        const result = interpolatePosition(records, 100)!;
        expect(result.lat).toBeCloseTo(1, 9);
        expect(result.speedMs).toBeCloseTo(5, 9);
    });
});

describe("dedupRecords", () => {
    it("keeps unique records intact", () => {
        const records = [rec(100, 1, 1), rec(200, 2, 2), rec(300, 3, 3)];
        const result = dedupRecords(records);
        expect(result).toHaveLength(3);
        expect(result).toEqual(records);
    });

    it("drops exact duplicate", () => {
        const records = [rec(100, 1, 1), rec(100, 1, 1)];
        expect(dedupRecords(records)).toHaveLength(1);
    });

    it("keeps records with same timestamp but different lat/lon", () => {
        // Multi-channel scenario: front and rear with the same GPS timestamp
        // but (hypothetically) different coordinates. Must not be merged.
        const records = [
            rec(100, 1, 1, { mp4Filename: "front.mp4" }),
            rec(100, 1.001, 1.001, { mp4Filename: "front.mp4" }),
        ];
        expect(dedupRecords(records)).toHaveLength(2);
    });

    it("keeps records with same coords but different mp4Filename", () => {
        const records = [rec(100, 1, 1, { mp4Filename: "a.mp4" }), rec(100, 1, 1, { mp4Filename: "b.mp4" })];
        expect(dedupRecords(records)).toHaveLength(2);
    });

    it("dedups unsynced records by position, ignoring the placeholder/reanchored time", () => {
        // Re-drop: the already-ingested copy was reanchored to a real time, the
        // fresh parse carries the -1 placeholder. Same position + filename ->
        // one record, not two.
        const records = [
            rec(1_780_000_010, 43.1, 76.9, { mp4Filename: "a.mp4", timeUnsynced: true }),
            rec(-1, 43.1, 76.9, { mp4Filename: "a.mp4", timeUnsynced: true }),
        ];
        expect(dedupRecords(records)).toHaveLength(1);
    });

    it("keeps distinct unsynced positions sharing the same placeholder time", () => {
        const records = [
            rec(-1, 43.1, 76.9, { mp4Filename: "a.mp4", timeUnsynced: true }),
            rec(-1, 43.2, 76.9, { mp4Filename: "a.mp4", timeUnsynced: true }),
        ];
        expect(dedupRecords(records)).toHaveLength(2);
    });

    it("preserves stationary relative offsets while deduplicating reanchored copies", () => {
        const reanchored = [0, 2, 4].map((relStartSeconds) =>
            rec(1_780_000_000 + relStartSeconds, 50, 30, { timeUnsynced: true, relStartSeconds }),
        );
        const fresh = reanchored.map((record) => ({ ...record, unixSeconds: -1 }));
        const result = dedupRecords([...reanchored, ...fresh]);
        expect(result).toEqual(reanchored);
        expect(result.map((record) => record.relStartSeconds)).toEqual([0, 2, 4]);
    });

    it("preserves order of first occurrence", () => {
        const records = [
            rec(200, 2, 2),
            rec(100, 1, 1),
            rec(200, 2, 2), // duplicate of second - removed
            rec(300, 3, 3),
        ];
        const result = dedupRecords(records);
        expect(result).toHaveLength(3);
        expect(result[0]!.unixSeconds).toBe(200);
        expect(result[1]!.unixSeconds).toBe(100);
        expect(result[2]!.unixSeconds).toBe(300);
    });

    it("transplants the larger |G| onto a timeUnsynced position collision (parking impact survives)", () => {
        // Parking-mode cold-start clip: car stationary, identical lat/lon on
        // every row, GPS clock not synced. All rows share one position key.
        // Without the transplant they collapse to the first and the impact spike
        // (which rides a later row) is gone before detectEvents runs.
        const records = [
            rec(-1, 43.1, 76.9, { mp4Filename: "a.mp4", timeUnsynced: true }),
            rec(-1, 43.1, 76.9, { mp4Filename: "a.mp4", timeUnsynced: true, accelXg: 1.2 }),
            rec(-1, 43.1, 76.9, { mp4Filename: "a.mp4", timeUnsynced: true }),
        ];
        const out = dedupRecords(records);
        expect(out).toHaveLength(1);
        expect(out[0]!.accelXg).toBe(1.2); // spike moved onto the survivor
        expect(records[0]!.accelXg).toBe(0); // survivor cloned, input untouched
    });

    it("transplants the larger |G| onto a synced position collision too", () => {
        const records = [rec(100, 1, 1, { accelYg: 0.1 }), rec(100, 1, 1, { accelYg: 0.9 })];
        const out = dedupRecords(records);
        expect(out).toHaveLength(1);
        expect(out[0]!.accelYg).toBe(0.9);
    });

    it("keeps the first-seen record intact when it already carries the larger |G|", () => {
        const records = [rec(100, 1, 1, { accelXg: 1.5 }), rec(100, 1, 1, { accelXg: 0.2 })];
        const out = dedupRecords(records);
        expect(out).toHaveLength(1);
        expect(out[0]!.accelXg).toBe(1.5);
        // No transplant needed, so the survivor is the original object (not a clone).
        expect(out[0]!).toBe(records[0]!);
    });
});

describe("thinDenseRecords", () => {
    it("passes records at or below GPS_THIN_HZ through unchanged", () => {
        // Exactly 5 Hz: every record lands in its own 200 ms bucket.
        const records = [rec(100.0, 1, 1), rec(100.2, 1.0001, 1), rec(100.4, 1.0002, 1), rec(101.0, 1.001, 1)];
        expect(thinDenseRecords(records)).toEqual(records);
    });

    it("collapses denser records to the first of each 200 ms bucket", () => {
        // Nextbase fmt1 shape: 10 Hz, fractional unixSeconds, distinct coords.
        const records = [
            rec(100.0, 1, 1),
            rec(100.1, 1.0001, 1),
            rec(100.2, 1.0002, 1),
            rec(100.3, 1.0003, 1),
            rec(101.0, 1.001, 1),
        ];
        const out = thinDenseRecords(records);
        expect(out).toHaveLength(3);
        expect(out[0]!.unixSeconds).toBe(100.0);
        expect(out[1]!.unixSeconds).toBe(100.2);
        expect(out[2]!.unixSeconds).toBe(101.0);
    });

    it("transplants the bucket's max-|G| accel onto the survivor (braking peak survives)", () => {
        const records = [
            rec(100.0, 1, 1, { accelXg: 0.1 }),
            rec(100.05, 1.0001, 1, { accelXg: 1.4 }), // the peak rides a dropped record
            rec(100.1, 1.0002, 1, { accelXg: 0.2 }),
        ];
        const out = thinDenseRecords(records);
        expect(out).toHaveLength(1);
        expect(out[0]!.unixSeconds).toBe(100.0);
        expect(out[0]!.accelXg).toBe(1.4);
        expect(records[0]!.accelXg, "survivor cloned, input untouched").toBe(0.1);
    });

    it("keeps the survivor object identity when it already carries the max |G|", () => {
        const records = [rec(100.0, 1, 1, { accelXg: 1.4 }), rec(100.1, 1.0001, 1, { accelXg: 0.1 })];
        const out = thinDenseRecords(records);
        expect(out).toHaveLength(1);
        expect(out[0]!).toBe(records[0]!);
    });

    it("keeps the survivor object identity on an accel tie (no pointless clone)", () => {
        // Both all-zero accel: >= must treat the tie as "kept is strongest" so
        // the common quiet-driving case never allocates.
        const records = [rec(100.0, 1, 1), rec(100.1, 1.0001, 1)];
        const out = thinDenseRecords(records);
        expect(out).toHaveLength(1);
        expect(out[0]!).toBe(records[0]!);
    });

    it("prefers the first record with a fix over an earlier no-fix one, keeping the max accel", () => {
        const records = [rec(100.0, 0, 0, { active: false, accelYg: 0.8 }), rec(100.1, 1, 1, { active: true })];
        const out = thinDenseRecords(records);
        expect(out).toHaveLength(1);
        expect(out[0]!.lat, "fix acquired mid-bucket wins the coordinates").toBe(1);
        expect(out[0]!.accelYg, "accel of the dropped no-fix record still rides along").toBe(0.8);
        expect(out[0]!, "the transplant must clone, not mutate the fix record").not.toBe(records[1]!);
        expect(records[1]!.accelYg, "input record untouched by the transplant").toBe(0);
    });

    it("keeps the fix record as-is when it also carries the max |G|", () => {
        const records = [
            rec(100.0, 0, 0, { active: false, accelYg: 0.2 }),
            rec(100.1, 1, 1, { active: true, accelYg: 1.0 }),
        ];
        const out = thinDenseRecords(records);
        expect(out).toHaveLength(1);
        expect(out[0]!, "nothing to transplant - no clone").toBe(records[1]!);
        expect(out[0]!.accelYg).toBe(1.0);
    });

    it("buckets unsynced records by relStartSeconds, not the placeholder clock", () => {
        // Vueroid shape: fake camera-local clock, 20 Hz relStartSeconds.
        const records = [
            rec(500.0, 1, 1, { timeUnsynced: true, relStartSeconds: 0.0 }),
            rec(500.05, 1.0001, 1, { timeUnsynced: true, relStartSeconds: 0.05 }),
            rec(500.2, 1.001, 1, { timeUnsynced: true, relStartSeconds: 0.2 }),
        ];
        const out = thinDenseRecords(records);
        expect(out).toHaveLength(2);
        expect(out[0]!.relStartSeconds).toBe(0.0);
        expect(out[1]!.relStartSeconds).toBe(0.2);
    });

    it("keeps a synced record and an unsynced one apart even when their bucket numbers collide", () => {
        // floor(unixSeconds * 5) of the synced record equals
        // floor(relStartSeconds * 5) of the unsynced one - the "r|" axis prefix
        // is what keeps them from collapsing into each other. Reachable: the
        // Vueroid dead-RTC path sets unixSeconds = relStartSeconds.
        const records = [rec(5.0, 1, 1), rec(999, 2, 2, { timeUnsynced: true, relStartSeconds: 5.0 })];
        expect(thinDenseRecords(records)).toHaveLength(2);
    });

    it("passes unsynced records without relStartSeconds through untouched", () => {
        // No per-record clock to bucket by - the placeholder time is meaningless.
        const records = [rec(-1, 1, 1, { timeUnsynced: true }), rec(-1, 1.0001, 1, { timeUnsynced: true })];
        expect(thinDenseRecords(records)).toEqual(records);
    });

    it("never collapses across files", () => {
        const records = [rec(100.0, 1, 1, { mp4Filename: "a.mp4" }), rec(100.1, 2, 2, { mp4Filename: "b.mp4" })];
        expect(thinDenseRecords(records)).toHaveLength(2);
    });

    it("is idempotent across every branch, preserving identities on the second pass", () => {
        const records = [
            rec(100.0, 0, 0, { active: false, accelYg: 0.8 }), // fix-acquired branch
            rec(100.1, 1, 1, { active: true }),
            rec(101.0, 1.001, 1), // accel-transplant branch
            rec(101.1, 1.0011, 1, { accelXg: 1.2 }),
            rec(102.0, 1.002, 1), // untouched passthrough
        ];
        const once = thinDenseRecords(records);
        const twice = thinDenseRecords(once);
        expect(twice).toEqual(once);
        for (let i = 0; i < once.length; i++) {
            expect(twice[i]!, `record ${i} identity survives the second pass`).toBe(once[i]!);
        }
    });
});

describe("accelMagnitude", () => {
    it("is the Euclidean norm of the gravity-removed triple", () => {
        expect(accelMagnitude(0, 0, 0)).toBe(0);
        expect(accelMagnitude(3, 4, 0)).toBe(5);
        expect(accelMagnitude(1, 2, 2)).toBe(3);
    });
});

describe("firstSyncedRecord / lastSyncedRecord", () => {
    it("returns the first/last record with a real GPS clock, skipping unsynced", () => {
        const recs = [
            rec(-1, 1, 1, { timeUnsynced: true }),
            rec(2000, 2, 2),
            rec(3000, 3, 3),
            rec(-1, 4, 4, { timeUnsynced: true }),
        ];
        expect(firstSyncedRecord(recs)?.unixSeconds).toBe(2000);
        expect(lastSyncedRecord(recs)?.unixSeconds).toBe(3000);
    });

    it("returns null when every record is unsynced", () => {
        const recs = [rec(-1, 1, 1, { timeUnsynced: true }), rec(-1, 2, 2, { timeUnsynced: true })];
        expect(firstSyncedRecord(recs)).toBeNull();
        expect(lastSyncedRecord(recs)).toBeNull();
    });

    it("does not calibrate a recording from directory rows selected using its own clock", () => {
        const hint = { sourcePath: "CARD/GPSData.txt", sourceKey: "card", extractorId: "csv-70mai" };
        const records = [
            rec(1000, 1, 2, { timeAssociation: hint, videoKey: "clip" }),
            rec(1001, 1, 2, { timeAssociation: hint, videoKey: "clip" }),
        ];
        expect(firstSyncedRecord(records)).toBeNull();
        expect(lastSyncedRecord(records)).toBeNull();
        expect(firstSyncedRecord([...records, rec(2000, 1, 2)])?.unixSeconds).toBe(2000);
    });

    it("null/empty input returns null", () => {
        expect(firstSyncedRecord([])).toBeNull();
        expect(firstSyncedRecord(null)).toBeNull();
        expect(lastSyncedRecord(undefined)).toBeNull();
    });
});

describe("fillForwardBearings", () => {
    it("fills bearing from look-ahead point", () => {
        // Moving due east: +lon, lat=0.
        const records = [
            rec(100, 0, 0, { bearingDeg: 0, speedMs: 10 }),
            rec(101, 0, 0.0001, { bearingDeg: 0, speedMs: 10 }),
            rec(102, 0, 0.0002, { bearingDeg: 0, speedMs: 10 }),
        ];
        fillForwardBearings(records);
        // Moving east = bearing ≈ 90°.
        expect(records[0]!.bearingDeg).toBeCloseTo(90, 0);
        // Intermediate records also inherit a valid bearing.
        expect(records[1]!.bearingDeg).toBeGreaterThanOrEqual(0);
        expect(records[1]!.bearingDeg).toBeLessThan(360);
    });

    it("uses lastValid bearing on stationary samples (speed < MIN_SPEED)", () => {
        // Car is stationary for first 2 samples, then moves.
        const records = [
            rec(100, 0, 0, { bearingDeg: 999, speedMs: 0.1 }), // stationary
            rec(101, 0, 0, { bearingDeg: 999, speedMs: 0.2 }), // stationary
            rec(102, 0, 0.0001, { bearingDeg: 999, speedMs: 10 }), // moving east
        ];
        fillForwardBearings(records);
        // Stationary records inherit lastValid (initially 0).
        expect(records[0]!.bearingDeg).toBe(0);
        expect(records[1]!.bearingDeg).toBe(0);
        // Third record: no next (it's last), so also inherits lastValid (still 0).
        expect(records[2]!.bearingDeg).toBe(0);
    });

    it("skips look-ahead points within MIN_DIST and finds farther point", () => {
        // First point is close to second (< MIN), but third is far enough.
        const records = [
            rec(100, 0, 0, { bearingDeg: 999, speedMs: 10 }),
            rec(101, 0, 1e-6, { bearingDeg: 999, speedMs: 10 }), // too close
            rec(102, 0, 0.0001, { bearingDeg: 999, speedMs: 10 }), // far enough (east)
        ];
        fillForwardBearings(records);
        // First bearing should be ~90° (east).
        expect(records[0]!.bearingDeg).toBeCloseTo(90, 0);
    });

    it("last record inherits lastValid (no look-ahead available)", () => {
        const records = [
            rec(100, 0, 0, { bearingDeg: 0, speedMs: 10 }),
            rec(101, 0, 0.0001, { bearingDeg: 0, speedMs: 10 }), // moving east
            rec(102, 0, 0.0002, { bearingDeg: 999, speedMs: 10 }), // last, no next
        ];
        fillForwardBearings(records);
        // Last record inherits lastValid from previous (≈90°).
        expect(records[2]!.bearingDeg).toBeCloseTo(90, 0);
    });

    it("mutates input array in place", () => {
        const records = [rec(100, 0, 0, { bearingDeg: 999, speedMs: 10 }), rec(101, 0, 0.001, { speedMs: 10 })];
        const originalRef = records[0];
        fillForwardBearings(records);
        expect(records[0]).toBe(originalRef); // same object reference
        expect(records[0]!.bearingDeg).not.toBe(999); // but field changed
    });
});

describe("forwardFillBearingsIfAllZero", () => {
    it("fills bearings when every record has bearingDeg=0 (parser without course)", () => {
        // Moving due east.
        const records = [
            rec(100, 0, 0, { speedMs: 10 }),
            rec(101, 0, 0.0001, { speedMs: 10 }),
            rec(102, 0, 0.0002, { speedMs: 10 }),
        ];
        forwardFillBearingsIfAllZero(records);
        expect(records[0]!.bearingDeg).toBeCloseTo(90, 0);
    });

    it("leaves bearings untouched when at least one record carries a non-zero bearing", () => {
        // Parser that writes course (NMEA RMC etc.): even one non-zero value
        // is treated as proof the format provides bearing.
        const records = [
            rec(100, 0, 0, { bearingDeg: 45, speedMs: 10 }),
            rec(101, 0, 0.0001, { bearingDeg: 0, speedMs: 10 }), // a real zero
            rec(102, 0, 0.0002, { bearingDeg: 47, speedMs: 10 }),
        ];
        forwardFillBearingsIfAllZero(records);
        expect(records[0]!.bearingDeg).toBe(45);
        expect(records[1]!.bearingDeg).toBe(0);
        expect(records[2]!.bearingDeg).toBe(47);
    });

    it("no-ops on empty input or single record", () => {
        const empty: GpsRecord[] = [];
        forwardFillBearingsIfAllZero(empty);
        expect(empty).toEqual([]);

        const one = [rec(100, 0, 0)];
        forwardFillBearingsIfAllZero(one);
        expect(one[0]!.bearingDeg).toBe(0); // single record has no neighbour to bear toward
    });
});

describe("freezeStationaryBearings", () => {
    it("inherits last moving bearing across a stationary gap", () => {
        // 90 -> stop -> stop -> 270 (sharp U-turn after the gap).
        // Stationary records must NOT spin to random angles, they hold the
        // last "moving" value until the next real heading arrives.
        const records = [
            rec(100, 0, 0, { bearingDeg: 90, speedMs: 10 }),
            rec(101, 0, 0, { bearingDeg: 17, speedMs: 0.1 }), // NMEA noise on a stopped car
            rec(102, 0, 0, { bearingDeg: 243, speedMs: 0.4 }), // more noise
            rec(103, 0, 0, { bearingDeg: 270, speedMs: 10 }),
        ];
        freezeStationaryBearings(records);
        expect(records[0]!.bearingDeg).toBe(90);
        expect(records[1]!.bearingDeg).toBe(90);
        expect(records[2]!.bearingDeg).toBe(90);
        expect(records[3]!.bearingDeg).toBe(270); // lastValid refreshed on movement
    });

    it("keeps the moving bearing untouched (no smoothing of real motion)", () => {
        const records = [
            rec(100, 0, 0, { bearingDeg: 10, speedMs: 5 }),
            rec(101, 0, 0, { bearingDeg: 350, speedMs: 5 }),
            rec(102, 0, 0, { bearingDeg: 5, speedMs: 5 }),
        ];
        freezeStationaryBearings(records);
        expect(records[0]!.bearingDeg).toBe(10);
        expect(records[1]!.bearingDeg).toBe(350);
        expect(records[2]!.bearingDeg).toBe(5);
    });

    it("uses the first record's bearing as initial lastValid when trip starts stationary", () => {
        // No "moving" record before the stationary ones - the freeze cannot
        // invent a heading, so it picks the first record's bearing and holds.
        const records = [
            rec(100, 0, 0, { bearingDeg: 42, speedMs: 0.1 }),
            rec(101, 0, 0, { bearingDeg: 313, speedMs: 0.2 }),
            rec(102, 0, 0, { bearingDeg: 50, speedMs: 10 }),
        ];
        freezeStationaryBearings(records);
        expect(records[0]!.bearingDeg).toBe(42);
        expect(records[1]!.bearingDeg).toBe(42);
        expect(records[2]!.bearingDeg).toBe(50);
    });

    it("threshold is inclusive of stationary (< 1.0 m/s) and exclusive at boundary", () => {
        // Speeds chosen around 1.0 m/s - the documented STATIONARY_SPEED_MS.
        const records = [
            rec(100, 0, 0, { bearingDeg: 100, speedMs: 2 }),
            rec(101, 0, 0, { bearingDeg: 999, speedMs: 0.99 }), // stationary
            rec(102, 0, 0, { bearingDeg: 200, speedMs: 1.0 }), // exactly at boundary - moving
        ];
        freezeStationaryBearings(records);
        expect(records[0]!.bearingDeg).toBe(100);
        expect(records[1]!.bearingDeg).toBe(100); // overwritten
        expect(records[2]!.bearingDeg).toBe(200); // untouched, lastValid moves to 200
    });

    it("no-ops on empty input", () => {
        const empty: GpsRecord[] = [];
        freezeStationaryBearings(empty);
        expect(empty).toEqual([]);
    });
});

describe("dropTeleportOutliers", () => {
    // Latitude degree ~= 111.195 km under our haversine (R=6371). Handy deltas:
    //   0.05 deg lat  ~= 5.56 km   (a clear teleport)
    //   0.0001 deg    ~= 11 m      (normal 1 Hz urban step)
    const LAT = 50.0;
    const LON = 30.0;

    /** Straight 1 Hz track heading north at ~11 m/s. */
    function track1Hz(count: number, t0 = 1000): GpsRecord[] {
        return Array.from({ length: count }, (_, i) => rec(t0 + i, LAT + i * 0.0001, LON, { speedMs: 11 }));
    }

    it("drops a single 5 km teleport spike that returns to the track (1 Hz)", () => {
        const records = track1Hz(10);
        records[5] = rec(1005, LAT + 0.05, LON, { speedMs: 11 }); // ~5.56 km jump, implied ~5.5 km/s
        const kept = dropTeleportOutliers(records);
        expect(kept).toHaveLength(9);
        expect(kept.some((r) => r.lat > LAT + 0.01)).toBe(false);
    });

    it("keeps every sample of an 18 Hz GoPro-style track with ±10 m jitter (distance floor)", () => {
        // 30 m/s forward + +-10 m lateral jitter: implied speed spikes to
        // ~180 m/s but displacement never reaches the 200 m floor.
        const records: GpsRecord[] = [];
        for (let i = 0; i < 200; i++) {
            const jitter = ((i % 3) - 1) * 0.00009; // ~+-10 m on lon
            records.push(rec(1000 + i / 18, LAT + (i * 30) / 18 / 111195, LON + jitter, { speedMs: 30 }));
        }
        expect(dropTeleportOutliers(records)).toHaveLength(200);
    });

    it("keeps constant 250 m/s motion via the new-anchor branch", () => {
        // Every step trips both gates (250 m jump, 250 m/s), but the next
        // record always confirms the motion - nothing is dropped.
        const records = Array.from({ length: 10 }, (_, i) => rec(1000 + i, LAT + i * 0.002248, LON, { speedMs: 250 }));
        expect(dropTeleportOutliers(records)).toHaveLength(10);
    });

    it("keeps a recording resumed 100 km away after a 2 h gap (large dt, low implied speed)", () => {
        const before = track1Hz(5);
        const after = Array.from({ length: 5 }, (_, i) =>
            rec(1004 + 7200 + i, LAT + 0.9 + i * 0.0001, LON, { speedMs: 11 }),
        );
        expect(dropTeleportOutliers([...before, ...after])).toHaveLength(10);
    });

    it("drops a trailing spike at the end of the records (no follower to confirm)", () => {
        const records = track1Hz(6);
        records.push(rec(1006, LAT + 0.05, LON, { speedMs: 11 }));
        const kept = dropTeleportOutliers(records);
        expect(kept).toHaveLength(6);
        expect(kept[kept.length - 1]!.lat).toBeCloseTo(LAT + 5 * 0.0001, 9);
    });

    it("keeps a 2-point spike cluster (documented limitation - continuity anchors on the first spike)", () => {
        // The confirm step sees the second spike agreeing with the first and
        // accepts the cluster as a genuine new anchor. viofosync's median-of-5
        // would catch this; rejected as a heavier policy. Assert the current
        // behavior so a future change here is deliberate, not accidental.
        const records = [
            ...track1Hz(4),
            rec(1004, LAT + 0.05, LON, { speedMs: 11 }),
            rec(1005, LAT + 0.0501, LON, { speedMs: 11 }),
            rec(1006, LAT + 0.0006, LON, { speedMs: 11 }),
            rec(1007, LAT + 0.0007, LON, { speedMs: 11 }),
        ];
        expect(dropTeleportOutliers(records)).toHaveLength(8);
    });

    it("passes active:false records through and skips them in the confirm lookahead", () => {
        // anchor -> spike -> inactive row (far away) -> confirming record.
        // The lookahead must skip the inactive row, find the confirmer, and
        // drop the spike; the inactive row itself is kept untouched.
        const records = [
            rec(1000, LAT, LON, { speedMs: 11 }),
            rec(1001, LAT + 0.05, LON, { speedMs: 11 }), // spike
            rec(1001.5, 0, 0, { active: false }), // escort-style void fix
            rec(1002, LAT + 0.0002, LON, { speedMs: 11 }),
        ];
        const kept = dropTeleportOutliers(records);
        expect(kept).toHaveLength(3);
        expect(kept.some((r) => !r.active)).toBe(true);
        expect(kept.some((r) => r.lat > LAT + 0.01)).toBe(false);
    });

    it("passes timeUnsynced records through untouched (fully-unsynced formats are exempt)", () => {
        // 70mai freegps / gps-box style: every record is a cold-start
        // placeholder. Even with teleport-looking geometry nothing is dropped.
        const records = [
            rec(1, LAT, LON, { timeUnsynced: true }),
            rec(2, LAT + 0.05, LON, { timeUnsynced: true }),
            rec(3, LAT, LON, { timeUnsynced: true }),
        ];
        expect(dropTeleportOutliers(records)).toHaveLength(3);
    });

    it("keeps dt<=0 records but never promotes them to anchor (same-second cross-channel merge)", () => {
        // B is a same-second teleported duplicate: kept, but if it became the
        // anchor, the legitimate last record C would be dropped as a trailing
        // spike. C must survive.
        const records = [
            rec(1000, LAT, LON, { speedMs: 11 }),
            rec(1000, LAT + 0.05, LON, { speedMs: 11, mp4Filename: "rear.mp4" }),
            rec(1001, LAT + 0.0001, LON, { speedMs: 11 }),
        ];
        const kept = dropTeleportOutliers(records);
        expect(kept).toHaveLength(3);
        expect(kept[2]!.lat).toBeCloseTo(LAT + 0.0001, 9);
    });

    it("returns a new array and never mutates the input", () => {
        const records = track1Hz(4);
        records.push(rec(1004, LAT + 0.05, LON, { speedMs: 11 }));
        const snapshot = [...records];
        const kept = dropTeleportOutliers(records);
        expect(kept).not.toBe(records);
        expect(records).toEqual(snapshot);
    });

    describe("accel transplant on drop (crash impact coinciding with a GPS glitch)", () => {
        it("a dropped spike's larger |G| moves onto the nearest kept neighbor; the brake event survives", () => {
            // A hard impact can jolt the receiver into the very >200 m spike
            // this filter drops, on the same second as the G spike - the
            // impact marker is the most valuable event of a crash clip.
            const records = track1Hz(10);
            records[5] = rec(1005, LAT + 0.05, LON, { speedMs: 11, accelXg: 0.9, accelYg: 0.2 });
            const kept = dropTeleportOutliers(records);
            expect(kept).toHaveLength(9);
            expect(kept.some((r) => r.lat > LAT + 0.01)).toBe(false); // spike position is gone
            // Anchor (t=1004) and confirmer (t=1006) are equidistant; ties go
            // to the anchor. Its clone carries the dropped accel triple.
            const neighbor = kept.find((r) => r.unixSeconds === 1004)!;
            expect(neighbor.accelXg).toBe(0.9);
            expect(neighbor.accelYg).toBe(0.2);
            expect(neighbor.lat).toBeCloseTo(LAT + 4 * 0.0001, 9); // position untouched
            // The input record was cloned, not mutated.
            expect(records[4]!.accelXg).toBe(0);
            // End-to-end: the auto-detected impact marker survives filtering.
            const events = detectEvents(kept, 1000);
            expect(events.some((e) => e.kind === "brake" && e.severity >= 0.9)).toBe(true);
        });

        it("transplants onto the upcoming confirmer when it is the nearer neighbor", () => {
            const records = [
                rec(1000, LAT, LON, { speedMs: 11 }),
                rec(1000.9, LAT + 0.05, LON, { speedMs: 11, accelZg: 0.8 }), // spike, 0.1 s before the confirmer
                rec(1001, LAT + 0.0001, LON, { speedMs: 11 }),
                rec(1002, LAT + 0.0002, LON, { speedMs: 11 }),
            ];
            const kept = dropTeleportOutliers(records);
            expect(kept).toHaveLength(3);
            const confirmer = kept.find((r) => r.unixSeconds === 1001)!;
            expect(confirmer.accelZg).toBe(0.8);
            expect(records[2]!.accelZg).toBe(0); // input untouched
            expect(kept.find((r) => r.unixSeconds === 1000)!.accelZg).toBe(0); // anchor untouched
        });

        it("a trailing spike's |G| lands on the last kept record", () => {
            const records = track1Hz(6);
            records.push(rec(1006, LAT + 0.05, LON, { speedMs: 11, accelYg: 1.2 }));
            const kept = dropTeleportOutliers(records);
            expect(kept).toHaveLength(6);
            expect(kept[kept.length - 1]!.accelYg).toBe(1.2);
        });

        it("does NOT transplant when the neighbor's own |G| is larger (max wins)", () => {
            const records = track1Hz(10);
            records[4] = rec(1004, LAT + 4 * 0.0001, LON, { speedMs: 11, accelXg: 1.5 });
            records[5] = rec(1005, LAT + 0.05, LON, { speedMs: 11, accelXg: 0.6 });
            const kept = dropTeleportOutliers(records);
            expect(kept).toHaveLength(9);
            const neighbor = kept.find((r) => r.unixSeconds === 1004)!;
            expect(neighbor).toBe(records[4]); // untouched, not even cloned
            expect(neighbor.accelXg).toBe(1.5);
        });

        it("a zero-G dropped spike transplants nothing", () => {
            const records = track1Hz(10);
            records[5] = rec(1005, LAT + 0.05, LON, { speedMs: 11 });
            const kept = dropTeleportOutliers(records);
            expect(kept).toHaveLength(9);
            expect(kept.every((r) => r.accelXg === 0 && r.accelYg === 0 && r.accelZg === 0)).toBe(true);
        });
    });

    it("handles empty and single-record input", () => {
        expect(dropTeleportOutliers([])).toEqual([]);
        expect(dropTeleportOutliers([rec(1000, LAT, LON)])).toHaveLength(1);
    });
});

describe("directory log record ownership", () => {
    it("does not carry a moving heading into a later stationary session", () => {
        const hint = { sourcePath: "CARD/GPSData.txt", extractorId: "csv-70mai" };
        const records = [
            rec(1000, 1, 2, { bearingDeg: 90, speedMs: 10, trackSegment: 0, timeAssociation: hint }),
            rec(2000, 1, 2, { bearingDeg: 180, trackSegment: 1, timeAssociation: hint }),
            rec(2001, 1, 2, { bearingDeg: 190, trackSegment: 1, timeAssociation: hint }),
        ];
        const log = rebuildLog(["csv-70mai"], records, []);
        expect(log.records.map((record) => record.bearingDeg)).toEqual([90, 180, 180]);
    });

    it("keeps pending card sources distinct through deduplication, thinning and bearing stabilization", () => {
        const source = (sourceKey: string, bearingDeg: number) =>
            [1000, 1001].map((time) =>
                rec(time, 1, 2, {
                    mp4Filename: "GPSData.txt",
                    bearingDeg,
                    timeAssociation: { sourcePath: "CARD/GPSData.txt", sourceKey, extractorId: "csv-70mai" },
                }),
            );
        const first = source("a", 90);
        const second = source("b", 180);
        const log = mergeIntoGpsLog(null, {
            records: [...first, ...second],
            appliedExtractors: ["csv-70mai"],
            skipped: [],
        });
        expect(log.records).toHaveLength(4);
        expect(log.pendingByFilename.size).toBe(1);
        expect(log.byVideoKey.size).toBe(0);
        expect(first.map((record) => record.bearingDeg)).toEqual([90, 90]);
        expect(second.map((record) => record.bearingDeg)).toEqual([180, 180]);

        const bound = { ...first[0]!, mp4Filename: "clip.mp4", videoKey: "clip" };
        const merged = mergeIntoGpsLog(log, {
            records: [bound, ...first, ...second],
            appliedExtractors: [],
            skipped: [],
        });
        expect(merged.records).toHaveLength(5);
        expect(merged.pendingByFilename.has("clip.mp4")).toBe(false);
        expect(merged.byVideoKey.get("clip")).toEqual([bound]);
    });
});

describe("mergeIntoGpsLog: incremental merge equals full rebuild", () => {
    type Batch = { records: GpsRecord[]; appliedExtractors: string[]; skipped: SkippedLine[] };

    // The old O(total) path, inlined as the reference: dedup + thin the WHOLE
    // concatenated log and regroup every bucket on each merge.
    function naiveMerge(existing: ParsedLog | null, batch: Batch): ParsedLog {
        if (!existing)
            return rebuildLog(batch.appliedExtractors, thinDenseRecords(dedupRecords(batch.records)), batch.skipped);
        return rebuildLog(
            unionStringArrays(existing.appliedExtractors, batch.appliedExtractors),
            thinDenseRecords(dedupRecords(existing.records.concat(batch.records))),
            existing.skipped.concat(batch.skipped),
        );
    }

    // Canonical form for equality: byFilename buckets are the contractual
    // structure (sorted ascending). records[] order is NOT contractual, so it is
    // compared as a multiset via a per-run sort.
    function canonicalBuckets(log: ParsedLog): Array<readonly [string, GpsRecord[]]> {
        return [...log.byFilename.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    }
    function sortRecords(records: GpsRecord[]): GpsRecord[] {
        const key = (r: GpsRecord): string =>
            `${r.mp4Filename}|${r.unixSeconds}|${r.lat}|${r.lon}|${r.accelXg}|${r.accelYg}|${r.accelZg}`;
        return [...records].sort((a, b) => (key(a) < key(b) ? -1 : 1));
    }
    function line(reason: string): SkippedLine {
        return { line: 0, raw: reason, reason };
    }

    // Fresh objects per call: incremental and naive runs must mutate disjoint
    // record sets (freeze/transplant mutate/clone), or they cross-contaminate.
    // Batches overlap on purpose: dup keys with weaker AND stronger accel (exercises
    // the transplant), new files appearing later, and a re-touched bucket.
    function makeBatches(): Batch[] {
        return [
            {
                records: [
                    rec(100, 1, 1, { mp4Filename: "a.mp4", speedMs: 11, bearingDeg: 10, accelXg: 0.1 }),
                    rec(101, 1.001, 1, { mp4Filename: "a.mp4", speedMs: 11, bearingDeg: 12 }),
                    rec(102, 1.002, 1, { mp4Filename: "a.mp4", speedMs: 11, bearingDeg: 14 }),
                    rec(200, 2, 2, { mp4Filename: "b.mp4", speedMs: 0.2, bearingDeg: 90 }),
                    // same-bucket sibling of b@200: thinned onto it, spike transplanted.
                    rec(200.1, 2.0005, 2, { mp4Filename: "b.mp4", speedMs: 0.4, bearingDeg: 91, accelZg: 1.1 }),
                    rec(201, 2.001, 2, { mp4Filename: "b.mp4", speedMs: 11, bearingDeg: 92 }),
                ],
                appliedExtractors: ["freegps"],
                skipped: [line("bad-1")],
            },
            {
                records: [
                    // dup of a@102 with a STRONGER spike -> transplant onto survivor.
                    rec(102, 1.002, 1, { mp4Filename: "a.mp4", speedMs: 11, bearingDeg: 14, accelYg: 0.9 }),
                    rec(103, 1.003, 1, { mp4Filename: "a.mp4", speedMs: 11, bearingDeg: 16 }),
                    rec(300, 3, 3, { mp4Filename: "c.mp4", speedMs: 11, bearingDeg: 0 }),
                ],
                appliedExtractors: ["freegps", "gpmf"],
                skipped: [line("bad-2")],
            },
            {
                records: [
                    // dup of a@100 with a WEAKER spike -> survivor keeps its own accel.
                    rec(100, 1, 1, { mp4Filename: "a.mp4", speedMs: 11, bearingDeg: 10, accelXg: 0.05 }),
                    // record inside a@102's thin bucket, arriving a batch
                    // later: thins onto the cross-batch survivor.
                    rec(102.1, 1.0025, 1, { mp4Filename: "a.mp4", speedMs: 11, bearingDeg: 15, accelZg: 0.3 }),
                    rec(202, 2.002, 2, { mp4Filename: "b.mp4", speedMs: 11, bearingDeg: 94 }),
                ],
                appliedExtractors: ["nmea"],
                skipped: [],
            },
        ];
    }

    it("produces the same byFilename/records/skipped/extractors across several overlapping batches", () => {
        const incrBatches = makeBatches();
        const naiveBatches = makeBatches();
        let incr: ParsedLog | null = null;
        let naive: ParsedLog | null = null;
        for (let i = 0; i < incrBatches.length; i++) {
            incr = mergeIntoGpsLog(incr, incrBatches[i]!);
            naive = naiveMerge(naive, naiveBatches[i]!);
            expect(canonicalBuckets(incr)).toEqual(canonicalBuckets(naive));
            expect(sortRecords(incr.records)).toEqual(sortRecords(naive.records));
            expect(incr.appliedExtractors).toEqual(naive.appliedExtractors);
            expect(incr.skipped).toEqual(naive.skipped);
            // records[] and byFilename share record identity (mergeAccelSamples
            // mutates these same objects in place downstream).
            const flat = [...incr.byFilename.values()].flat();
            expect(incr.records).toHaveLength(flat.length);
            expect(new Set(incr.records)).toEqual(new Set(flat));
        }
    });

    it("carries the transplant through the incremental path (spike from a later batch survives)", () => {
        const [b1, b2] = makeBatches();
        const log1 = mergeIntoGpsLog(null, b1!);
        const log2 = mergeIntoGpsLog(log1, b2!);
        const a102 = log2.byFilename.get("a.mp4")!.find((r) => r.unixSeconds === 102)!;
        expect(a102.accelYg).toBe(0.9); // stronger accel from batch 2 kept
    });

    it("reuses record indexes for an empty batch while preserving labels and skipped diagnostics", () => {
        const existing = mergeIntoGpsLog(null, makeBatches()[0]!);
        const skipped = line("clock-hint-only");
        const merged = mergeIntoGpsLog(existing, {
            records: [],
            appliedExtractors: ["freegps", "clock-hint"],
            skipped: [skipped],
        });

        expect(merged).not.toBe(existing);
        expect(merged.records).toBe(existing.records);
        expect(merged.byFilename).toBe(existing.byFilename);
        expect(merged.byVideoKey).toBe(existing.byVideoKey);
        expect(merged.appliedExtractors).toEqual(["freegps", "clock-hint"]);
        expect(merged.skipped).toEqual([...existing.skipped, skipped]);
    });

    it("returns the existing log itself for a completely empty batch", () => {
        const existing = mergeIntoGpsLog(null, makeBatches()[0]!);
        expect(mergeIntoGpsLog(existing, { records: [], appliedExtractors: [], skipped: [] })).toBe(existing);
    });
});

describe("rebindOrphanLogRecords (70mai ghost names in GPSData)", () => {
    function logWith(...recs: GpsRecord[]): ParsedLog {
        return rebuildLog(["csv-70mai"], recs, []);
    }

    it("re-keys a mode-prefix rename: NO row -> EV file on disk (A810 locked clip)", () => {
        const log = logWith(
            rec(100, 43, 7, { mp4Filename: "NO20260713-133158-000008F.MP4" }),
            rec(101, 43, 7, { mp4Filename: "NO20260713-133158-000008F.MP4" }),
        );
        const rebound = rebindOrphanLogRecords(log, ["EV20260713-133158-000008F.MP4"]);
        expect(rebound).toBe(2);
        for (const r of log.records) expect(r.mp4Filename).toBe("EV20260713-133158-000008F.MP4");
    });

    it("re-keys a row with garbage after .MP4 (X800: VL...F.MP4G4)", () => {
        const log = logWith(rec(100, 43, 78, { mp4Filename: "VL20260428-192844-000413F.MP4G4" }));
        const rebound = rebindOrphanLogRecords(log, ["VL20260428-192844-000413F.MP4"]);
        expect(rebound).toBe(1);
        expect(log.records[0]!.mp4Filename).toBe("VL20260428-192844-000413F.MP4");
    });

    it("leaves exactly-bound records and channel mismatches alone", () => {
        const bound = rec(100, 43, 7, { mp4Filename: "NO20260713-133158-000008F.MP4" });
        // Front-named row with only the rear twin loaded: cores differ by the
        // channel letter - must NOT bind (rear records are the rear's own).
        const orphanRear = rec(200, 43, 7, { mp4Filename: "NO20260713-133258-000009F.MP4" });
        const log = logWith(bound, orphanRear);
        const rebound = rebindOrphanLogRecords(log, ["NO20260713-133158-000008F.MP4", "NO20260713-133258-000009R.MP4"]);
        expect(rebound).toBe(0);
        expect(bound.mp4Filename).toBe("NO20260713-133158-000008F.MP4");
        expect(orphanRear.mp4Filename).toBe("NO20260713-133258-000009F.MP4");
    });

    it("skips an ambiguous core (two loaded videos share it) and non-70mai names", () => {
        const log = logWith(
            rec(100, 43, 7, { mp4Filename: "NO20260713-133158-000008F.MP4" }),
            rec(200, 43, 7, { mp4Filename: "track.gpx" }),
        );
        const rebound = rebindOrphanLogRecords(log, ["EV20260713-133158-000008F.MP4", "LA20260713-133158-000008F.MP4"]);
        expect(rebound).toBe(0);
    });

    // Real-card regressions. Clip names below are verbatim from user SD cards
    // (A810 and X800); filenames carry only datetime+sequence+channel, no
    // location, so they are safe to commit. These lock the exact scenarios the
    // synthetic cases above abstract.

    it("A810 card: NO log rows rebind onto locked EV clips renamed on disk (real names)", () => {
        // On this card 20 event clips lost their GPS this way (1240 records);
        // six representative locked clips here. A clip records as Normal (the
        // GPSData log writes NO<core> rows), a g-sensor event then locks it and
        // renames the FILE NO->EV on disk, so the exact-name join misses.
        const evOnDisk = [
            "EV20260713-133741-000014F.MP4",
            "EV20260713-133851-000015F.MP4",
            "EV20260713-133923-000016F.MP4",
            "EV20260713-134147-000018F.MP4",
            "EV20260713-134446-000021F.MP4",
            "EV20260713-134848-000025F.MP4",
        ];
        // Two rows per clip, keyed by the NO ghost name the firmware wrote live.
        const log = logWith(
            ...evOnDisk.flatMap((ev, i) => {
                const ghostName = ev.replace(/^EV/, "NO");
                return [
                    rec(1000 + i * 2, 43, 7, { mp4Filename: ghostName }),
                    rec(1001 + i * 2, 43, 7, { mp4Filename: ghostName }),
                ];
            }),
        );
        // The one event clip on the card with no matching NO-log row (a pure
        // event, never a normal phase) is loaded but has nothing to bind.
        const loaded = [...evOnDisk, "EV20260713-133158-000008F.MP4"];

        const rebound = rebindOrphanLogRecords(log, loaded);
        expect(rebound).toBe(evOnDisk.length * 2);
        // Every record moved to its EV disk name; no NO ghost name survives.
        expect(new Set(log.records.map((r) => r.mp4Filename))).toEqual(new Set(evOnDisk));
    });

    it("X800 card: log rows with stray bytes after .MP4 rebind onto the clean disk name (real names)", () => {
        // X800 firmware appends garbage after ".MP4" in the log row - and not
        // always the same bytes ("G4" and "P4" both occur on one card). The core
        // regex stops at ".MP4", so any tail is ignored and the row binds to the
        // clean-named locked clip on disk.
        const log = logWith(
            rec(100, 43, 78, { mp4Filename: "VL20260428-192844-000413F.MP4G4" }),
            rec(101, 43, 78, { mp4Filename: "VL20260428-192908-000415F.MP4P4" }),
        );
        const rebound = rebindOrphanLogRecords(log, ["VL20260428-192844-000413F.MP4", "VL20260428-192908-000415F.MP4"]);
        expect(rebound).toBe(2);
        expect(log.records.map((r) => r.mp4Filename).sort()).toEqual([
            "VL20260428-192844-000413F.MP4",
            "VL20260428-192908-000415F.MP4",
        ]);
    });
});

describe("cloneRecordsAcrossChannels (BlackVue shared .gps sidecar)", () => {
    const NF = "20260718_070333_NF.mp4";
    const NR = "20260718_070333_NR.mp4";
    const NI = "20260718_070333_NI.mp4";
    const EF = "20260718_070333_EF.mp4";
    const ER = "20260718_070333_ER.mp4";

    function logWith(...recs: GpsRecord[]): ParsedLog {
        return rebuildLog([], recs, []);
    }

    function loaded(...names: string[]): VendorFile[] {
        return loadedFrom("card", ...names);
    }

    function loadedFrom(sourceKey: string, ...names: string[]): VendorFile[] {
        return names.map((name) => ({
            file: new File([name], name, { lastModified: 1 }),
            relativePath: `BLACKVUE/Record/${name}`,
            sourceKey,
        }));
    }

    it.each(["canonical", "alias-keyed", "alias-unowned"])(
        "shares %s GPS through a normal copy of the event survivor",
        (sourceKind) => {
            const [normal, rear] = loaded(NF, NR);
            const survivor = { ...loaded(EF)[0]!, recordingCopies: [normal!] };
            const source = rec(100, 52, 0, {
                mp4Filename: sourceKind === "canonical" ? EF : NF,
                ...(sourceKind === "alias-unowned"
                    ? {}
                    : { videoKey: vendorFileKey(sourceKind === "canonical" ? survivor : normal!) }),
            });
            const log = logWith(source);

            expect(cloneRecordsAcrossChannels(log, [survivor, rear!])).toBe(1);
            const rebuilt = rebuildLog([], log.records, []);
            expect(rebuilt.byVideoKey.get(vendorFileKey(rear!))?.[0]?.mp4Filename).toBe(NR);
            expect(cloneRecordsAcrossChannels(rebuilt, [survivor, rear!])).toBe(0);
        },
    );

    it("clones to the event survivor instead of its normal alias", () => {
        const [normal, rear] = loaded(NF, NR);
        const survivor = { ...loaded(EF)[0]!, recordingCopies: [normal!] };
        const log = logWith(rec(100, 52, 0, { mp4Filename: NR, videoKey: vendorFileKey(rear!) }));

        expect(cloneRecordsAcrossChannels(log, [survivor, rear!])).toBe(1);
        const rebuilt = rebuildLog([], log.records, []);
        expect(rebuilt.byFilename.get(NF)).toBeUndefined();
        expect(rebuilt.byVideoKey.get(vendorFileKey(survivor))?.[0]?.mp4Filename).toBe(EF);
    });

    it("clones once when both physical modes connect the same survivors", () => {
        const [normalFront, normalRear] = loaded(NF, NR);
        const front = { ...loaded(EF)[0]!, recordingCopies: [normalFront!] };
        const rear = { ...loaded(ER)[0]!, recordingCopies: [normalRear!] };
        const log = logWith(rec(100, 52, 0, { mp4Filename: EF, videoKey: vendorFileKey(front) }));

        expect(cloneRecordsAcrossChannels(log, [front, rear])).toBe(1);
        expect(log.records).toHaveLength(2);
        const rebuilt = rebuildLog([], log.records, []);
        expect(rebuilt.byVideoKey.get(vendorFileKey(rear))?.[0]?.mp4Filename).toBe(ER);
        expect(cloneRecordsAcrossChannels(rebuilt, [front, rear])).toBe(0);
    });

    it("revisits an earlier mode group after its confirmed copy receives shared GPS", () => {
        const [normalFront, interior] = loaded(NF, NI);
        const front = { ...loaded(EF)[0]!, recordingCopies: [normalFront!] };
        const rear = loaded(ER)[0]!;
        const log = logWith(rec(100, 52, 0, { mp4Filename: NI, videoKey: vendorFileKey(interior!) }));

        expect(cloneRecordsAcrossChannels(log, [front, rear, interior!])).toBe(2);
        const rebuilt = rebuildLog([], log.records, []);
        expect(rebuilt.byVideoKey.get(vendorFileKey(front))?.[0]?.mp4Filename).toBe(EF);
        expect(rebuilt.byVideoKey.get(vendorFileKey(rear))?.[0]?.mp4Filename).toBe(ER);
    });

    it.each([true, false])("preserves source isolation for aliases with keyed GPS %s", (isKeyed) => {
        const [aNormal, aRear] = loadedFrom("card-a", NF, NR);
        const [bNormal, bRear] = loadedFrom("card-b", NF, NR);
        const aFront = { ...loadedFrom("card-a", EF)[0]!, recordingCopies: [aNormal!] };
        const bFront = { ...loadedFrom("card-b", EF)[0]!, recordingCopies: [bNormal!] };
        const source = rec(100, 52, 0, {
            mp4Filename: NF,
            ...(isKeyed ? { videoKey: vendorFileKey(aNormal!) } : {}),
        });
        const log = logWith(source);

        expect(cloneRecordsAcrossChannels(log, [aFront, aRear!, bFront, bRear!])).toBe(isKeyed ? 1 : 0);
        const rebuilt = rebuildLog([], log.records, []);
        expect(rebuilt.byVideoKey.get(vendorFileKey(aRear!))?.length ?? 0).toBe(isKeyed ? 1 : 0);
        expect(rebuilt.byVideoKey.get(vendorFileKey(bFront))).toBeUndefined();
        expect(rebuilt.byVideoKey.get(vendorFileKey(bRear!))).toBeUndefined();
    });

    it("leaves a physical alias claimed by independent survivors out of the clone groups", () => {
        const [normal, rear] = loadedFrom("copy-card", NF, NR);
        const first = { ...loadedFrom("card-a", EF)[0]!, recordingCopies: [normal!] };
        const second = { ...loadedFrom("card-b", EF)[0]!, recordingCopies: [normal!] };
        const log = logWith(rec(100, 52, 0, { mp4Filename: EF, videoKey: vendorFileKey(first) }));

        expect(cloneRecordsAcrossChannels(log, [first, second, rear!])).toBe(0);
        expect(log.records).toHaveLength(1);
    });

    it("clones the front-bound records onto the rear clip (identical but for mp4Filename)", () => {
        const log = logWith(
            rec(100, 52, 0, { mp4Filename: NF, speedMs: 24, bearingDeg: 145 }),
            rec(101, 52, 0, { mp4Filename: NF, speedMs: 25, bearingDeg: 146 }),
        );
        const cloned = cloneRecordsAcrossChannels(log, loaded(NF, NR));
        expect(cloned).toBe(2);

        const rebuilt = rebuildLog([], log.records, []);
        const rearBucket = rebuilt.byFilename.get(NR);
        expect(rearBucket).toHaveLength(2);
        // Every field carries over verbatim except the bound filename.
        expect(rearBucket!.map((r) => [r.unixSeconds, r.lat, r.lon, r.speedMs, r.bearingDeg])).toEqual(
            rebuilt.byFilename.get(NF)!.map((r) => [r.unixSeconds, r.lat, r.lon, r.speedMs, r.bearingDeg]),
        );
    });

    it("clones onto every sibling channel (front -> rear + interior)", () => {
        const log = logWith(rec(100, 52, 0, { mp4Filename: NF }));
        const cloned = cloneRecordsAcrossChannels(log, loaded(NF, NR, NI));
        expect(cloned).toBe(2);
        const rebuilt = rebuildLog([], log.records, []);
        expect(rebuilt.byFilename.get(NR)).toHaveLength(1);
        expect(rebuilt.byFilename.get(NI)).toHaveLength(1);
    });

    it("is idempotent: a second pass adds nothing (a sibling that already has GPS is left alone)", () => {
        const log = logWith(rec(100, 52, 0, { mp4Filename: NF }));
        expect(cloneRecordsAcrossChannels(log, loaded(NF, NR))).toBe(1);
        const afterFirst = rebuildLog([], log.records, []);
        expect(cloneRecordsAcrossChannels(afterFirst, loaded(NF, NR))).toBe(0);
    });

    it("never overwrites a channel that carries its own GPS (both embedded)", () => {
        const log = logWith(rec(100, 52, 0, { mp4Filename: NF }), rec(100, 52, 0, { mp4Filename: NR, speedMs: 99 }));
        expect(cloneRecordsAcrossChannels(log, loaded(NF, NR))).toBe(0);
    });

    it("does nothing when only one channel of the recording is loaded", () => {
        const log = logWith(rec(100, 52, 0, { mp4Filename: NF }));
        expect(cloneRecordsAcrossChannels(log, loaded(NF))).toBe(0);
    });

    it("ignores non-BlackVue names (no channel-group key)", () => {
        const log = logWith(rec(100, 52, 0, { mp4Filename: "MOV_0581.mp4" }));
        expect(cloneRecordsAcrossChannels(log, loaded("MOV_0581.mp4", "MOV_0582.mp4"))).toBe(0);
    });

    it("does not clone a shared sidecar across equal trees from two sources", () => {
        const [aFront, aRear] = loadedFrom("card-a", NF, NR);
        const [bFront, bRear] = loadedFrom("card-b", NF, NR);
        const log = logWith(rec(100, 52, 0, { mp4Filename: NF, videoKey: vendorFileKey(aFront!) }));

        expect(cloneRecordsAcrossChannels(log, [aFront!, aRear!, bFront!, bRear!])).toBe(1);
        const rebuilt = rebuildLog([], log.records, []);
        expect(rebuilt.byVideoKey.get(vendorFileKey(aRear!))).toHaveLength(1);
        expect(rebuilt.byVideoKey.get(vendorFileKey(bFront!))).toBeUndefined();
        expect(rebuilt.byVideoKey.get(vendorFileKey(bRear!))).toBeUndefined();
    });
});

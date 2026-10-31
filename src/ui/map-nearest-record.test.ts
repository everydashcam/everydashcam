import { describe, expect, it } from "vitest";
import { mercatorY, wrapDegrees } from "../coordinates.js";
import { isValidGpsFix } from "../parser.js";
import type { GpsRecord } from "../parsers/types.js";
import { isProjectionOf, nearestProjectedRecordIndex, projectTrack } from "./map-nearest-record.js";

function record(lat: number, lon: number, overrides: Partial<GpsRecord> = {}): GpsRecord {
    return {
        unixSeconds: 0,
        active: true,
        lat,
        lon,
        bearingDeg: 0,
        speedMs: 0,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename: "trip.mp4",
        ...overrides,
    };
}

/** The per-query scan the projection replaces, kept as the reference. */
function scanNearest(records: readonly GpsRecord[], lat: number, lng: number): number {
    let bestIdx = -1;
    let bestDist = Infinity;
    const targetY = mercatorY(lat);
    for (let i = 0; i < records.length; i++) {
        const r = records[i]!;
        if (!isValidGpsFix(r)) continue;
        const dLat = mercatorY(r.lat) - targetY;
        const dLon = wrapDegrees(r.lon - lng);
        const d = dLat * dLat + dLon * dLon;
        if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
        }
    }
    return bestIdx;
}

describe("nearestProjectedRecordIndex", () => {
    it("matches a full scan and skips invalid fixes", () => {
        // A winding route with lost, null-island and non-finite fixes mixed in.
        const records = Array.from({ length: 240 }, (_, i) => {
            const lat = 59.9 + 0.001 * i + 0.002 * Math.sin(i / 7);
            const lon = 30.3 + 0.0015 * i * Math.cos(i / 31);
            if (i % 17 === 0) return record(lat, lon, { active: false });
            if (i % 29 === 0) return record(0, 0);
            if (i % 41 === 0) return record(Number.NaN, lon);
            return record(lat, lon);
        });
        const track = projectTrack(records);
        for (let row = 0; row <= 12; row++) {
            for (let column = 0; column <= 12; column++) {
                const lat = 59.88 + row * 0.03;
                const lng = 30.28 + column * 0.03;
                const expected = scanNearest(records, lat, lng);
                expect(nearestProjectedRecordIndex(track, lat, lng), `query ${lat},${lng}`).toBe(expected);
                expect(isValidGpsFix(records[expected]!), `fix at ${expected} is valid`).toBe(true);
            }
        }
    });

    it("compares longitude across the antimeridian", () => {
        const records = [record(10, 0), record(10, 179.9)];
        expect(nearestProjectedRecordIndex(projectTrack(records), 10, -179.9)).toBe(1);
    });

    it("keeps the earliest record when a route revisits a spot", () => {
        const records = [record(50, 20), record(50.01, 20.01), record(50, 20)];
        expect(nearestProjectedRecordIndex(projectTrack(records), 50, 20)).toBe(0);
    });

    it("returns -1 for a track without a valid fix", () => {
        const records = [record(50, 20, { active: false }), record(0, 0)];
        expect(nearestProjectedRecordIndex(projectTrack(records), 50, 20)).toBe(-1);
        expect(nearestProjectedRecordIndex(projectTrack([]), 50, 20)).toBe(-1);
    });
});

describe("isProjectionOf", () => {
    it("rejects a projection after the array is replaced or grows in place", () => {
        const records = [record(50, 20)];
        const track = projectTrack(records);
        expect(isProjectionOf(track, records)).toBe(true);
        expect(isProjectionOf(track, [...records]), "another array").toBe(false);
        records.push(record(50.1, 20.1));
        expect(isProjectionOf(track, records), "appended in place").toBe(false);
        expect(isProjectionOf(null, records), "nothing projected yet").toBe(false);
    });
});

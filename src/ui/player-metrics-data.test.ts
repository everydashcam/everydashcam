import { beforeEach, describe, expect, it } from "vitest";

import { interpolatePosition, type GpsRecord, totalDistanceKm } from "../parser.js";
import { _resetForTests, resolvePlayerMetrics } from "./player-metrics-data.js";

function record(unixSeconds: number, overrides: Partial<GpsRecord> = {}): GpsRecord {
    return {
        unixSeconds,
        active: true,
        lat: 43,
        lon: 77 + (unixSeconds - 100) * 0.0001,
        speedMs: 10,
        bearingDeg: 90,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename: "sample.mp4",
        ...overrides,
    };
}

beforeEach(_resetForTests);

describe("resolvePlayerMetrics", () => {
    it.each([false, true])(
        "hides readouts through a zero-pair interval with active=%s and restores the recovered fix",
        (active) => {
            const records = [record(100), record(101, { active, lat: 0, lon: 0, accelYg: 0.8 }), record(102)];
            for (const target of [100, 100.2, 100.8, 101, 101.2, 101.8, 102]) {
                const metrics = resolvePlayerMetrics(records, target);
                expect(metrics.fix === "ok", `map/readout agreement at ${target}`).toBe(
                    interpolatePosition(records, target) !== null,
                );
            }
            expect(resolvePlayerMetrics(records, 100.2)).toMatchObject({ fix: "lost", distanceKm: null });
            expect(
                resolvePlayerMetrics(records, 101).record?.accelYg,
                "GPS loss preserves independent acceleration",
            ).toBe(0.8);
            expect(resolvePlayerMetrics(records, 102).record).toBe(records[2]);
        },
    );

    it("selects the valid concurrent channel for an exact timestamp", () => {
        const records = [record(99), record(100, { active: false, lat: 0, lon: 0 }), record(100), record(101)];
        const metrics = resolvePlayerMetrics(records, 100);
        expect(metrics.fix).toBe("ok");
        expect(metrics.record).toBe(records[2]);
        expect(metrics.distanceKm).toBeCloseTo(totalDistanceKm(records.slice(0, 3)), 9);
    });

    it("uses the nearest original sample for steady readouts between fixes", () => {
        const records = [record(100), record(102, { speedMs: 20 })];
        expect(resolvePlayerMetrics(records, 100.2).record).toBe(records[0]);
        expect(resolvePlayerMetrics(records, 101.8).record).toBe(records[1]);
    });

    it("matches the map's endpoint tolerance for a single fix", () => {
        const records = [record(100)];
        for (const target of [94, 95, 100, 105, 106]) {
            expect(resolvePlayerMetrics(records, target).fix === "ok").toBe(
                interpolatePosition(records, target) !== null,
            );
        }
        expect(resolvePlayerMetrics(records, 106)).toEqual({ record: null, fix: "none", distanceKm: null });
    });

    it("rejects invalid coordinates and keeps recovered distances finite", () => {
        const records = [record(100), record(101, { lat: Number.NaN }), record(102, { lon: 181 }), record(103)];
        expect(resolvePlayerMetrics(records, 101).fix).toBe("lost");
        expect(resolvePlayerMetrics(records, 102).fix).toBe("lost");
        const recovered = resolvePlayerMetrics(records, 103);
        expect(recovered.fix).toBe("ok");
        expect(recovered.distanceKm).toBeCloseTo(totalDistanceKm([records[0]!, records[3]!]), 9);
    });

    it("recomputes distance when GPS calibration replaces a trip's records with a trimmed track", () => {
        const trip = { records: [record(100), record(101), record(102), record(103)] };
        const original = resolvePlayerMetrics(trip.records, 102).distanceKm;
        trip.records = trip.records.slice(2);
        expect(resolvePlayerMetrics(trip.records, 102).distanceKm, "trimmed route starts at zero").toBe(0);
        expect(resolvePlayerMetrics(trip.records, 103).distanceKm).toBeCloseTo(totalDistanceKm(trip.records), 9);
        expect(original).toBeGreaterThan(0);
    });

    it("has no fix for empty data or a non-finite playhead", () => {
        expect(resolvePlayerMetrics([], 100)).toEqual({ record: null, fix: "none", distanceKm: null });
        expect(resolvePlayerMetrics([record(100)], Number.NaN)).toEqual({
            record: null,
            fix: "none",
            distanceKm: null,
        });
    });
});

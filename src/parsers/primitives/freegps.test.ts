// Coverage for the gravity-included accel-baseline removal - the one
// subtractAxisMean call site that had no direct test. The variants in
// GRAVITY_INCLUDED_VARIANT_NAMES (Azdome/EEEkit XOR, Vantrue NMEA-embedded)
// store gravity-INCLUDED accel; this path decides, per-file, whether and how
// to strip the static bias.

import { describe, it, expect } from "vitest";

import { _internal } from "./freegps.js";
import { AZDOME_XOR_VARIANT_NAME, VANTRUE_NMEA_VARIANT_NAME } from "../internal/freegps.js";
import type { FreeGpsFileBlockParser } from "../internal/freegps.js";
import type { GpsRecord } from "../types.js";

const { removeGravityIncludedAccelBaseline, finalizeFreeGpsResult } = _internal;

// removeGravityIncludedAccelBaseline only reads claimedVariantName(); the rest
// of the block-parser interface is irrelevant here.
const parserClaiming = (name: string | null): FreeGpsFileBlockParser =>
    ({ claimedVariantName: () => name }) as unknown as FreeGpsFileBlockParser;

const rec = (x: number, y: number, z: number): GpsRecord =>
    ({ accelXg: x, accelYg: y, accelZg: z }) as unknown as GpsRecord;

describe("removeGravityIncludedAccelBaseline", () => {
    it("subtracts the per-axis mean of accel-bearing records when the Azdome variant claimed the file", () => {
        // withAccel = [A, B] (C is all-zero -> excluded from the mean and left alone).
        // mean x = (1+3)/2 = 2, so A.x -> -1, B.x -> 1.
        const a = rec(1, 10, 0);
        const b = rec(3, 20, 0);
        const c = rec(0, 0, 0);
        removeGravityIncludedAccelBaseline([a, b, c], parserClaiming(AZDOME_XOR_VARIANT_NAME));
        expect(a).toMatchObject({ accelXg: -1, accelYg: -5, accelZg: 0 });
        expect(b).toMatchObject({ accelXg: 1, accelYg: 5, accelZg: 0 });
        expect(c, "all-zero records stay untouched").toMatchObject({ accelXg: 0, accelYg: 0, accelZg: 0 });
    });

    it("subtracts the baseline for the Vantrue NMEA-embedded variant too - its Type-15 preamble is gravity-included", () => {
        const a = rec(-1.0, 0.05, 0.0);
        const b = rec(-1.1, 0.07, 0.0);
        removeGravityIncludedAccelBaseline([a, b], parserClaiming(VANTRUE_NMEA_VARIANT_NAME));
        expect(a.accelXg).toBeCloseTo(0.05, 6);
        expect(b.accelXg).toBeCloseTo(-0.05, 6);
    });

    it("is a no-op when a different variant claimed the file (gravity-excluded formats)", () => {
        const a = rec(1, 2, 3);
        removeGravityIncludedAccelBaseline([a], parserClaiming("Some Other Variant"));
        expect(a).toMatchObject({ accelXg: 1, accelYg: 2, accelZg: 3 });
    });

    it("is a no-op when no variant claimed the file (null)", () => {
        const a = rec(1, 2, 3);
        removeGravityIncludedAccelBaseline([a], parserClaiming(null));
        expect(a).toMatchObject({ accelXg: 1, accelYg: 2, accelZg: 3 });
    });

    it("zeros accel with a single sample - one observation cannot separate bias from motion", () => {
        // A ~1 g gravity-included floor must never reach impact detection.
        const a = rec(5, 5, 5);
        const b = rec(0, 0, 0);
        removeGravityIncludedAccelBaseline([a, b], parserClaiming(AZDOME_XOR_VARIANT_NAME));
        expect(a).toMatchObject({ accelXg: 0, accelYg: 0, accelZg: 0 });
    });
});

describe("finalizeFreeGpsResult time-lapse duration guard", () => {
    it("does not drop a leading fix before a long gap on a time-lapse clip based on playback duration", () => {
        const t0 = 1_795_619_660;
        const makeRec = (unixSeconds: number): GpsRecord => ({
            unixSeconds,
            active: true,
            lat: 45,
            lon: 9,
            bearingDeg: 0,
            speedMs: 10,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: "LA20261125-161420-000001F.MP4",
        });
        const result = {
            records: [0, 600, 601, 602, 603].map((off) => makeRec(t0 + off)),
            skipped: [],
        };
        const fakeParser = {
            claimedVariantName: () => "Novatek",
            hasRingBufferRecords: () => false,
            coldStartClockJumpSec: () => null,
        } as unknown as FreeGpsFileBlockParser;
        const timelapseFile = {
            file: new File([], "LA20261125-161420-000001F.MP4"),
            relativePath: "Lapse/LA20261125-161420-000001F.MP4",
        };

        finalizeFreeGpsResult(result, fakeParser, timelapseFile, 60);
        expect(result.records.map((r) => r.unixSeconds - t0)).toEqual([0, 600, 601, 602, 603]);
        expect((result as { timestampOutliersFiltered?: boolean }).timestampOutliersFiltered).toBe(true);
    });

    it("keeps ring-buffer out-of-order protection when mixed variants null out claimedVariantName", () => {
        const t0 = 1_795_619_660;
        const makeRec = (unixSeconds: number): GpsRecord => ({
            unixSeconds,
            active: true,
            lat: 48.18,
            lon: 16.36,
            bearingDeg: 0,
            speedMs: 10,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: "mixed-atc.mp4",
        });
        // ATC ring-buffer block emitted [600, 0, 1, 2], then another variant emitted 3.
        const result: { records: GpsRecord[]; skipped: never[]; recordsOutOfOrder?: boolean } = {
            records: [600, 0, 1, 2, 3].map((off) => makeRec(t0 + off)),
            skipped: [],
        };
        const mixedAtcParser = {
            claimedVariantName: () => null,
            hasRingBufferRecords: () => true,
            coldStartClockJumpSec: () => null,
        } as unknown as FreeGpsFileBlockParser;
        const file = { file: new File([], "mixed-atc.mp4"), relativePath: "mixed-atc.mp4" };

        finalizeFreeGpsResult(result, mixedAtcParser, file, 60);
        expect(result.recordsOutOfOrder).toBe(true);
        expect(result.records.map((r) => r.unixSeconds - t0)).toEqual([600, 0, 1, 2, 3]);
    });
});

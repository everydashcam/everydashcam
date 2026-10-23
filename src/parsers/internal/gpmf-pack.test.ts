// Round-trip tests for the GPMF packer: pack synthetic records via packGpmfSamples,
// then decode via iterTokens/decodeNumeric/parseGpsuTimestamp (the same reader from
// gpmf.ts) and verify values are recovered within scaling truncation. Header bugs
// (BE/LE, padding, sampleSize×repeat) will surface here.
//
// Full pipeline (pack → ISOBMFF inject → mediabunny demux → extractFromGpmdTrack)
// is in gpmd-inject.test.ts.

import { describe, it, expect } from "vitest";
import { packGpmfSamples } from "./gpmf-pack.js";
import { decodeNumeric, decodeString, iterTokens, parseGpsuTimestamp } from "./gpmf.js";
import { buildTripTimeline, type TripFrame } from "../../trips.js";
import type { GpsRecord } from "../types.js";

function makeRecord(overrides: Partial<GpsRecord>): GpsRecord {
    return {
        unixSeconds: 0,
        active: true,
        lat: 0,
        lon: 0,
        bearingDeg: 0,
        speedMs: 0,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename: "",
        ...overrides,
    };
}

// Builds a gapless single-segment timeline and packs a clip starting at the
// given absolute UTC. The segment is anchored 1000 s before the clip so that
// records before the clip start project to content < clipContentStart and are
// excluded - mirroring the old wall-clock filter semantics these tests assert.
// (GPSU(second 0) == contentToWallUtc(clipStartUtc - anchor) == clipStartUtc.)
function packAtUtc(
    records: readonly GpsRecord[],
    clipStartUtc: number,
    durationSec: number,
    opts: { includeAccel: boolean },
): ReturnType<typeof packGpmfSamples> {
    const anchor = clipStartUtc - 1000;
    const frame: TripFrame = { startUtc: anchor, durationSec: 100_000, wallDurationSec: 100_000, channels: {} };
    const timeline = buildTripTimeline([frame]);
    return packGpmfSamples(records, timeline, clipStartUtc - anchor, durationSec, opts);
}

function viewOf(buf: Uint8Array): DataView {
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

describe("packGpmfSamples - structure", () => {
    it("emits one sample per second (clipDurationSec rounded up)", () => {
        const samples = packAtUtc([], 1_700_000_000, 3.4, { includeAccel: false });
        expect(samples).toHaveLength(4);
        // First 3 samples: 1 s each. Last one truncated to the actual end.
        expect(samples[0]!.durationSec).toBe(1);
        expect(samples[1]!.durationSec).toBe(1);
        expect(samples[2]!.durationSec).toBe(1);
        expect(samples[3]!.durationSec).toBeCloseTo(0.4, 5);
    });

    it("each sample is a valid DEVC-rooted KLV blob", () => {
        const samples = packAtUtc([], 1_700_000_000, 1, { includeAccel: false });
        const dv = viewOf(samples[0]!.payload);
        const tokens = [...iterTokens(dv)];
        expect(tokens).toHaveLength(1);
        expect(tokens[0]!.fourCC).toBe("DEVC");
        expect(tokens[0]!.type).toBe(0); // nested
        const deviceName = [...iterTokens(tokens[0]!.payload)].find((token) => token.fourCC === "DVNM");
        expect(deviceName).toBeDefined();
        expect(decodeString(deviceName!)).toBe("everydashcam");
    });

    it.each([2040, 13_136, 13_137, 65_535])("preserves %i GPS and accel records in a dense second", (count) => {
        const baseUtc = 1_700_000_000;
        const records = Array.from({ length: count }, (_, i) =>
            makeRecord({
                unixSeconds: baseUtc + i / count,
                lat: 50 + i / count,
                lon: 30,
                speedMs: i / count,
                accelXg: 0.5,
            }),
        );
        const samples = packAtUtc(records, baseUtc, 1, { includeAccel: true });
        expect(samples).toHaveLength(1);
        expect(samples[0]!.durationSec).toBe(1);
        const gps = decodeFirstGps5(samples[0]!.payload);
        const accel = decodeAccl(samples[0]!.payload);
        expect(gps).toHaveLength(count);
        expect(accel).toHaveLength(count);
        for (const i of [0, Math.floor(count / 2), count - 1]) {
            expect(gps[i]!.lat, `latitude ${i}`).toBeCloseTo(records[i]!.lat, 6);
            expect(gps[i]!.speed2d, `speed ${i}`).toBeCloseTo(records[i]!.speedMs, 3);
            expect(accel[i]!.x, `acceleration ${i}`).toBeCloseTo(0.5 * 9.80665, 2);
        }
    });
});

describe("packGpmfSamples - GPS round-trip", () => {
    const baseUtc = Date.UTC(2026, 4, 8, 12, 30, 45) / 1000; // 2026-05-08 12:30:45 UTC

    it("recovers lat/lon/speed within scaling tolerance", () => {
        const records: GpsRecord[] = [
            makeRecord({ unixSeconds: baseUtc + 0.1, lat: 55.7558, lon: 37.6173, speedMs: 12.345 }),
        ];
        const samples = packAtUtc(records, baseUtc, 1, { includeAccel: false });
        const decoded = decodeFirstGps5(samples[0]!.payload);
        expect(decoded).toHaveLength(1);
        expect(decoded[0]!.lat).toBeCloseTo(55.7558, 6);
        expect(decoded[0]!.lon).toBeCloseTo(37.6173, 6);
        expect(decoded[0]!.speed2d).toBeCloseTo(12.345, 3);
        // We duplicate 2D speed into the 3D field - no other data available.
        expect(decoded[0]!.speed3d).toBeCloseTo(12.345, 3);
    });

    it("GPSU encodes UTC timestamp readable by parseGpsuTimestamp", () => {
        const samples = packAtUtc([], baseUtc, 1, { includeAccel: false });
        const gpsu = findFirstToken(samples[0]!.payload, "GPSU");
        expect(gpsu).not.toBeNull();
        const decoded = parseGpsuTimestamp(decodeString(gpsu!));
        expect(decoded).not.toBeNull();
        expect(decoded!).toBeCloseTo(baseUtc, 2);
    });

    it("emits placeholder GPSF=0 when no records in second", () => {
        const samples = packAtUtc([], baseUtc, 1, { includeAccel: false });
        const gpsf = findFirstToken(samples[0]!.payload, "GPSF");
        expect(gpsf).not.toBeNull();
        expect(decodeNumeric(gpsf!)?.[0]).toBe(0);
    });

    it("emits GPSF=3 when record present with active=true", () => {
        const records: GpsRecord[] = [makeRecord({ unixSeconds: baseUtc + 0.2, lat: 1, lon: 2, active: true })];
        const samples = packAtUtc(records, baseUtc, 1, { includeAccel: false });
        const gpsf = findFirstToken(samples[0]!.payload, "GPSF");
        expect(decodeNumeric(gpsf!)?.[0]).toBe(3);
    });

    it("omits origin placeholders from GPS5 while preserving one-zero-coordinate fixes", () => {
        const records = [
            makeRecord({ unixSeconds: baseUtc + 0.1, lat: 0, lon: 0 }),
            makeRecord({ unixSeconds: baseUtc + 0.2, lat: 0, lon: 37 }),
            makeRecord({ unixSeconds: baseUtc + 0.3, lat: 55, lon: 0 }),
        ];
        const samples = packAtUtc(records, baseUtc, 1, { includeAccel: false });
        expect(decodeFirstGps5(samples[0]!.payload).map(({ lat, lon }) => ({ lat, lon }))).toEqual([
            { lat: 0, lon: 37 },
            { lat: 55, lon: 0 },
        ]);
        expect(decodeNumeric(findFirstToken(samples[0]!.payload, "GPSF")!)?.[0]).toBe(3);
    });

    it("filters records outside [clipStart, clipStart + duration)", () => {
        const records: GpsRecord[] = [
            // before range
            makeRecord({ unixSeconds: baseUtc - 5, lat: 99, lon: 99 }),
            // in range (first second)
            makeRecord({ unixSeconds: baseUtc + 0.5, lat: 55, lon: 37 }),
            // past range (third second with duration=2)
            makeRecord({ unixSeconds: baseUtc + 5, lat: 88, lon: 88 }),
        ];
        const samples = packAtUtc(records, baseUtc, 2, { includeAccel: false });
        // First sample must contain only the lat=55 record.
        const decoded0 = decodeFirstGps5(samples[0]!.payload);
        expect(decoded0).toHaveLength(1);
        expect(decoded0[0]!.lat).toBeCloseTo(55, 6);
        // Second sample (second +1, no records) - placeholder GPSF=0.
        const gpsf1 = findFirstToken(samples[1]!.payload, "GPSF");
        expect(decodeNumeric(gpsf1!)?.[0]).toBe(0);
    });

    it("places multiple records of same second into single GPS5 block", () => {
        const records: GpsRecord[] = [
            makeRecord({ unixSeconds: baseUtc + 0.1, lat: 55.0, lon: 37.0, speedMs: 5 }),
            makeRecord({ unixSeconds: baseUtc + 0.5, lat: 55.1, lon: 37.1, speedMs: 6 }),
            makeRecord({ unixSeconds: baseUtc + 0.9, lat: 55.2, lon: 37.2, speedMs: 7 }),
        ];
        const samples = packAtUtc(records, baseUtc, 1, { includeAccel: false });
        const decoded = decodeFirstGps5(samples[0]!.payload);
        expect(decoded).toHaveLength(3);
        expect(decoded[0]!.lat).toBeCloseTo(55.0, 6);
        expect(decoded[1]!.lat).toBeCloseTo(55.1, 6);
        expect(decoded[2]!.lat).toBeCloseTo(55.2, 6);
    });

    it("excludes records at and after a fractional clip end", () => {
        const records = [
            makeRecord({ unixSeconds: baseUtc + 0.2, lat: 55 }),
            makeRecord({ unixSeconds: baseUtc + 0.375, lat: 56 }),
            makeRecord({ unixSeconds: baseUtc + 0.5, lat: 57 }),
        ];
        const samples = packAtUtc(records, baseUtc, 0.375, { includeAccel: false });
        expect(samples[0]!.durationSec).toBe(0.375);
        expect(decodeFirstGps5(samples[0]!.payload).map((r) => r.lat)).toEqual([55]);
    });

    it("excludes a long GPS track outside footage instead of clamping it to the edges", () => {
        const frame: TripFrame = { startUtc: baseUtc, durationSec: 1.375, wallDurationSec: 1.375, channels: {} };
        const records = [
            makeRecord({ unixSeconds: baseUtc - 1, lat: 54 }),
            makeRecord({ unixSeconds: baseUtc, lat: 55 }),
            makeRecord({ unixSeconds: baseUtc + 1.25, lat: 56 }),
            ...Array.from({ length: 13_136 }, (_, i) => makeRecord({ unixSeconds: baseUtc + 1.375 + i, lat: 57 })),
        ];
        const samples = packGpmfSamples(records, buildTripTimeline([frame]), 0, 1.375, { includeAccel: false });
        expect(samples).toHaveLength(2);
        expect(decodeFirstGps5(samples[0]!.payload).map((r) => r.lat)).toEqual([55]);
        expect(decodeFirstGps5(samples[1]!.payload).map((r) => r.lat)).toEqual([56]);
    });
});

describe("packGpmfSamples - ACCL round-trip", () => {
    const baseUtc = Date.UTC(2026, 4, 8, 12, 30, 45) / 1000;
    const G_TO_MS2 = 9.80665;

    it("preserves acceleration and time while marking origin-only GPS as no fix", () => {
        const records = [makeRecord({ unixSeconds: baseUtc + 0.1, lat: 0, lon: 0, accelXg: 0.5, accelYg: -0.25 })];
        const samples = packAtUtc(records, baseUtc, 1, { includeAccel: true });
        const payload = samples[0]!.payload;
        expect(decodeNumeric(findFirstToken(payload, "GPSF")!)?.[0]).toBe(0);
        expect(decodeFirstGps5(payload)).toHaveLength(1);
        const gpsu = findFirstToken(payload, "GPSU");
        expect(parseGpsuTimestamp(decodeString(gpsu!))).toBeCloseTo(baseUtc, 2);
        const accel = decodeAccl(payload);
        expect(accel).toHaveLength(1);
        expect(accel[0]!.x).toBeCloseTo(0.5 * G_TO_MS2, 2);
        expect(accel[0]!.y).toBeCloseTo(-0.25 * G_TO_MS2, 2);
        expect(records[0]).toMatchObject({ active: true, lat: 0, lon: 0, accelXg: 0.5, accelYg: -0.25 });
    });

    it("includeAccel=false omits ACCL stream entirely", () => {
        const records: GpsRecord[] = [makeRecord({ unixSeconds: baseUtc + 0.1, accelXg: 0.5 })];
        const samples = packAtUtc(records, baseUtc, 1, { includeAccel: false });
        const accl = findFirstToken(samples[0]!.payload, "ACCL");
        expect(accl).toBeNull();
    });

    it("includeAccel=true skips ACCL stream when all records have zero accel", () => {
        // GoPro and GPX-sidecar records have accelXg/Yg/Zg=0 - no point writing an empty ACCL.
        const records: GpsRecord[] = [makeRecord({ unixSeconds: baseUtc + 0.1, lat: 1, lon: 2 })];
        const samples = packAtUtc(records, baseUtc, 1, { includeAccel: true });
        const accl = findFirstToken(samples[0]!.payload, "ACCL");
        expect(accl).toBeNull();
    });

    it("includeAccel=true with non-zero accel writes ACCL on every second (even empty ones)", () => {
        // Regression: previously ACCL was only written on seconds with non-zero accel
        // and skipped on empty/zero seconds. Readers treated this as a broken stream
        // and stopped rendering ACCL entirely (see troubles/dashcamigo_20260429_192226.mp4).
        // Now the decision is made at the trip level: if any record has accel,
        // ACCL is written on every second (placeholder zeros for empty seconds).
        const records: GpsRecord[] = [
            // Only the first second has a record with accel.
            makeRecord({ unixSeconds: baseUtc + 0.5, lat: 55, lon: 37, accelXg: 0.1, accelYg: 0, accelZg: 0 }),
            // Second second has no records - but since the trip "has accel", ACCL must
            // still be written (placeholder zeros).
        ];
        const samples = packAtUtc(records, baseUtc, 3, { includeAccel: true });
        expect(samples).toHaveLength(3);
        for (let i = 0; i < 3; i++) {
            const accl = findFirstToken(samples[i]!.payload, "ACCL");
            expect(accl, `sample[${i}] missing ACCL`).not.toBeNull();
        }
    });

    it("includeAccel=true with non-zero accel encodes ACCL in m/s² with scaling", () => {
        const records: GpsRecord[] = [
            makeRecord({ unixSeconds: baseUtc + 0.1, accelXg: 0.5, accelYg: -0.25, accelZg: 0.1 }),
        ];
        const samples = packAtUtc(records, baseUtc, 1, { includeAccel: true });
        const decoded = decodeAccl(samples[0]!.payload);
        expect(decoded).toHaveLength(1);
        // packGpmfSamples converts g → m/s² × 1000, packs as int32, SCAL=1000.
        expect(decoded[0]!.x).toBeCloseTo(0.5 * G_TO_MS2, 2);
        expect(decoded[0]!.y).toBeCloseTo(-0.25 * G_TO_MS2, 2);
        expect(decoded[0]!.z).toBeCloseTo(0.1 * G_TO_MS2, 2);
    });
});

describe("packGpmfSamples - footage-time collapse across a pause", () => {
    const baseUtc = Date.UTC(2026, 4, 8, 12, 0, 0) / 1000;

    // Two 60 s segments with a 300 s recording pause between them - the same
    // shape the trip grouper produces when a parking pause is below the trip
    // gap threshold. The gpmd track must collapse the pause to stay the same
    // length as the gap-collapsed video track.
    function gappedTimeline(): ReturnType<typeof buildTripTimeline> {
        const frames: TripFrame[] = [
            { startUtc: baseUtc, durationSec: 60, wallDurationSec: 60, channels: {} },
            { startUtc: baseUtc + 360, durationSec: 60, wallDurationSec: 60, channels: {} },
        ];
        return buildTripTimeline(frames);
    }

    function gpsuOf(payload: Uint8Array): number {
        const gpsu = findFirstToken(payload, "GPSU");
        const decoded = parseGpsuTimestamp(decodeString(gpsu!));
        return decoded!;
    }

    it("sample count equals footage seconds (pause not counted)", () => {
        const tl = gappedTimeline();
        // Whole clip on the content axis: 120 s of footage, NOT 420 s wall-clock.
        const samples = packGpmfSamples([], tl, 0, tl.contentDurationSec, { includeAccel: false });
        expect(tl.contentDurationSec).toBe(120);
        expect(samples).toHaveLength(120);
    });

    it("GPSU steps across the pause between the two segments", () => {
        const tl = gappedTimeline();
        const samples = packGpmfSamples([], tl, 0, tl.contentDurationSec, { includeAccel: false });
        // Last second of segment A vs first second of segment B: real UTC jumps
        // by the full 300 s pause, not by 1 s.
        expect(gpsuOf(samples[59]!.payload)).toBeCloseTo(baseUtc + 59, 1);
        expect(gpsuOf(samples[60]!.payload)).toBeCloseTo(baseUtc + 360, 1);
    });

    it("records in the second segment land at their footage-second", () => {
        const tl = gappedTimeline();
        // 10 s into segment B (real UTC baseUtc+370) -> footage second 70.
        const records: GpsRecord[] = [makeRecord({ unixSeconds: baseUtc + 370.4, lat: 55, lon: 37 })];
        const samples = packGpmfSamples(records, tl, 0, tl.contentDurationSec, { includeAccel: false });
        expect(decodeFirstGps5(samples[70]!.payload)).toHaveLength(1);
        expect(decodeFirstGps5(samples[70]!.payload)[0]!.lat).toBeCloseTo(55, 6);
        // The footage second inside the pause (e.g. 60..61, segment B start) has
        // no real record there - placeholder no-fix.
        const gpsf60 = findFirstToken(samples[60]!.payload, "GPSF");
        expect(decodeNumeric(gpsf60!)?.[0]).toBe(0);
    });

    it("excludes pause records from the next footage second and the accel decision", () => {
        const records = [
            makeRecord({ unixSeconds: baseUtc + 60, lat: 54, accelXg: 1 }),
            makeRecord({ unixSeconds: baseUtc + 200, lat: 55, accelXg: 1 }),
            makeRecord({ unixSeconds: baseUtc + 360, lat: 56 }),
        ];
        const samples = packGpmfSamples(records, gappedTimeline(), 60, 1);
        expect(decodeFirstGps5(samples[0]!.payload).map((r) => r.lat)).toEqual([56]);
        expect(findFirstToken(samples[0]!.payload, "ACCL")).toBeNull();
    });
});

// ===== Helpers =====

interface DecodedGps5 {
    lat: number;
    lon: number;
    alt: number;
    speed2d: number;
    speed3d: number;
}

interface DecodedAccl {
    x: number;
    y: number;
    z: number;
}

/**
 * Minimal extractor for a single sample (simplified copy of gpmf-extract.ts logic,
 * without stream-level filters - in tests we want to see exactly what the packer
 * wrote, not what the reader filters out).
 */
function decodeFirstGps5(payload: Uint8Array): DecodedGps5[] {
    const dv = viewOf(payload);
    for (const devc of iterTokens(dv)) {
        if (devc.fourCC !== "DEVC" || devc.type !== 0) continue;
        for (const strm of iterTokens(devc.payload)) {
            if (strm.fourCC !== "STRM" || strm.type !== 0) continue;
            let gps5: ReturnType<typeof firstByFourCC> = null;
            let scal: ReturnType<typeof firstByFourCC> = null;
            for (const tag of iterTokens(strm.payload)) {
                if (tag.fourCC === "GPS5") gps5 = tag;
                if (tag.fourCC === "SCAL") scal = tag;
            }
            if (!gps5 || !scal) continue;
            const scalValues = decodeNumeric(scal);
            if (!scalValues || scalValues.length < 5) continue;
            const samples = decodeNumeric(gps5);
            if (!samples) continue;
            const out: DecodedGps5[] = [];
            const numSamples = samples.length / 5;
            for (let i = 0; i < numSamples; i++) {
                out.push({
                    lat: samples[i * 5]! / scalValues[0]!,
                    lon: samples[i * 5 + 1]! / scalValues[1]!,
                    alt: samples[i * 5 + 2]! / scalValues[2]!,
                    speed2d: samples[i * 5 + 3]! / scalValues[3]!,
                    speed3d: samples[i * 5 + 4]! / scalValues[4]!,
                });
            }
            return out;
        }
    }
    return [];
}

function decodeAccl(payload: Uint8Array): DecodedAccl[] {
    const dv = viewOf(payload);
    for (const devc of iterTokens(dv)) {
        if (devc.fourCC !== "DEVC" || devc.type !== 0) continue;
        for (const strm of iterTokens(devc.payload)) {
            if (strm.fourCC !== "STRM" || strm.type !== 0) continue;
            let accl: ReturnType<typeof firstByFourCC> = null;
            let scal: ReturnType<typeof firstByFourCC> = null;
            for (const tag of iterTokens(strm.payload)) {
                if (tag.fourCC === "ACCL") accl = tag;
                if (tag.fourCC === "SCAL") scal = tag;
            }
            if (!accl || !scal) continue;
            const scalValues = decodeNumeric(scal);
            const samples = decodeNumeric(accl);
            if (!scalValues || !samples) continue;
            const divisor = scalValues[0]!;
            const numSamples = samples.length / 3;
            const out: DecodedAccl[] = [];
            for (let i = 0; i < numSamples; i++) {
                out.push({
                    x: samples[i * 3]! / divisor,
                    y: samples[i * 3 + 1]! / divisor,
                    z: samples[i * 3 + 2]! / divisor,
                });
            }
            return out;
        }
    }
    return [];
}

function findFirstToken(payload: Uint8Array, fourCC: string): ReturnType<typeof firstByFourCC> {
    const dv = viewOf(payload);
    for (const devc of iterTokens(dv)) {
        if (devc.fourCC !== "DEVC" || devc.type !== 0) continue;
        for (const strm of iterTokens(devc.payload)) {
            if (strm.fourCC !== "STRM" || strm.type !== 0) continue;
            for (const tag of iterTokens(strm.payload)) {
                if (tag.fourCC === fourCC) return tag;
            }
        }
    }
    return null;
}

// Type helper for findFirstToken/decode helpers - extracts one token from iterTokens.
function firstByFourCC(): import("./gpmf.js").GpmfToken | null {
    return null;
}

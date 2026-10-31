// Wolfbox / Redtiger `gpmd` meta-track GPS extraction.
//
// Despite the GoPro-looking track name, the samples are NOT GPMF KLV: each
// sample is a fixed binary struct of little-endian int64 value/scale pairs
// (field = value / scale). Two offset layouts exist in the wild; both are
// reverse-engineered, NO REAL SAMPLE has been through this code yet (the
// extractor+sample+tests hard rule was explicitly waived for the Wolfbox
// family - see docs/gps-format-coverage.md "Wolfbox" entry):
//
// Variant B ("block2", ExifTool QuickTimeStream.pl ProcessWolfbox - observed
// on Wolfbox G900 and Redtiger F9 4K; sample >= 0xf8 bytes):
//   0x48/0x50  speed value/scale, knots
//   0x58/0x60  direction value/scale, degrees
//   0x68       u32 LE day, 0x6c month, 0x70 year
//   0xa0       u32 LE hour, 0xa4 minute, 0xa8 second (UTC)
//   0xb0/0xb8  lat value/scale, signed NMEA DDmm.mmmm
//   0xc0/0xc8  lon value/scale, signed NMEA DDDmm.mmmm
//   0xe8/0xf0  altitude value/scale (GpsRecord has no altitude - skipped)
//
// Variant A ("block1", chrisl8/trip-viewer shenshu.rs - reverse-engineered
// from a 2026-firmware 3-channel Wolfbox, "ShenShu MetaData"; 1000-byte
// samples, fix fields in the first 0x78 bytes):
//   0x00       i32 status, 1 = valid fix
//   0x10       u32 LE hour, 0x14 minute, 0x18 second (same slot as the G900
//              "block1" h/m/s; probed, optional - see time handling below)
//   0x28/0x30  lat value/scale, signed NMEA DDmm.mmmm
//   0x38/0x40  lon value/scale, signed NMEA DDDmm.mmmm
//   0x48/0x50  speed value/scale, knots
//   0x58/0x60  direction value/scale, degrees (trip-viewer labels this
//              altitude, but ExifTool's layout puts direction at 0x58 in both
//              of its dumps - we follow ExifTool)
//
// Variant A carries no date, so its records are timeUnsynced and re-anchored
// onto the video window. The in-sample h/m/s (when plausible) provides the
// per-record relStartSeconds; otherwise 1 Hz by sample index. 1 Hz is
// deliberate: the ShenShu track header CLAIMS 5 Hz via timescale/stts, but
// the GPS clock field advances one second per sample (trip-viewer's
// observation), so stts durations must not be trusted here.

import { type GpsRecord, KNOTS_TO_MS, type ParsedRecords, type SkippedLine, type VendorFile } from "../types.js";
import { isDashcamYear, utcMillisecondsFromParts } from "./calendar.js";
import { ddmmToDegrees } from "./ddmm.js";
import { findTrackBySampleFormat, loadTrackSampleBuffers, type Mp4Index, type TrackInfo } from "./mp4-index.js";

// Variant B field offsets.
const B_MIN_SAMPLE_LEN = 0xf8;
const B_OFF_SPEED = 0x48;
const B_OFF_DIR = 0x58;
const B_OFF_DATE = 0x68; // day, month, year - u32 LE each
const B_OFF_TIME = 0xa0; // hour, minute, second - u32 LE each
const B_OFF_LAT = 0xb0;
const B_OFF_LON = 0xc0;

// Variant A field offsets.
const A_MIN_SAMPLE_LEN = 0x78;
const A_OFF_STATUS = 0x00;
const A_OFF_TIME = 0x10; // hour, minute, second - u32 LE each (optional)
const A_OFF_LAT = 0x28;
const A_OFF_LON = 0x38;
const A_OFF_SPEED = 0x48;
const A_OFF_DIR = 0x58;

export type WolfboxVariant = "block2-exiftool" | "block1-shenshu";

/**
 * Returns the candidate meta track for the Wolfbox probe: sample-format
 * 'gpmd' (how ExifTool identifies it), falling back to a handler-type 'meta'
 * track with no recognized sample format (the mp4 layer of trip-viewer
 * identified the ShenShu track by handler only).
 */
export function findWolfboxCandidateTrack(index: Mp4Index): TrackInfo | null {
    const gpmd = findTrackBySampleFormat(index, ["gpmd"]);
    if (gpmd) return gpmd;
    for (const t of index.tracks) {
        if (t.handlerType === "meta" && !t.sampleFormat) return t;
    }
    return null;
}

/** Reads an int64 LE as a JS number (all observed magnitudes < 2^53). */
function i64(dv: DataView, off: number): number {
    return Number(dv.getBigInt64(off, true));
}

/** value/scale pair -> number, with a variant-appropriate zero-scale fallback. */
function rational(dv: DataView, off: number, fallbackScale: number): number {
    const value = i64(dv, off);
    const scale = i64(dv, off + 8);
    return value / (scale > 0 ? scale : fallbackScale);
}

function validHms(h: number, m: number, s: number): boolean {
    return h >= 0 && h < 24 && m >= 0 && m < 60 && s >= 0 && s < 60;
}

/**
 * Classifies the first sample of the candidate track. Returns null when the
 * sample is GPMF KLV (GoPro's territory) or matches neither layout.
 */
export function detectWolfboxVariant(dv: DataView): WolfboxVariant | null {
    if (dv.byteLength >= 4) {
        // GPMF samples open with a KLV fourcc, practically always DEVC.
        const fourcc = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
        if (fourcc === "DEVC") return null;
    }

    if (dv.byteLength >= B_MIN_SAMPLE_LEN) {
        const day = dv.getUint32(B_OFF_DATE, true);
        const month = dv.getUint32(B_OFF_DATE + 4, true);
        const year = dv.getUint32(B_OFF_DATE + 8, true);
        const hour = dv.getUint32(B_OFF_TIME, true);
        const minute = dv.getUint32(B_OFF_TIME + 4, true);
        const second = dv.getUint32(B_OFF_TIME + 8, true);
        if (
            day >= 1 &&
            day <= 31 &&
            month >= 1 &&
            month <= 12 &&
            isDashcamYear(year) &&
            validHms(hour, minute, second)
        ) {
            return "block2-exiftool";
        }
    }

    if (dv.byteLength >= A_MIN_SAMPLE_LEN) {
        const status = dv.getInt32(A_OFF_STATUS, true);
        const latScale = i64(dv, A_OFF_LAT + 8);
        const lonScale = i64(dv, A_OFF_LON + 8);
        // Scales are decimal powers (1e5 observed). Power-of-ten check keeps
        // random meta tracks from sliding through on byte noise. Explicit set
        // instead of log10 - Math.log10(1000) is not exactly 3 everywhere.
        const POW10 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];
        const isPow10 = (n: number) => POW10.includes(n);
        if ((status === 0 || status === 1) && isPow10(latScale) && isPow10(lonScale)) {
            return "block1-shenshu";
        }
    }

    return null;
}

function decodeVariantB(dv: DataView, mp4Filename: string): GpsRecord | null {
    if (dv.byteLength < B_MIN_SAMPLE_LEN) return null;
    const day = dv.getUint32(B_OFF_DATE, true);
    const month = dv.getUint32(B_OFF_DATE + 4, true);
    const year = dv.getUint32(B_OFF_DATE + 8, true);
    const hour = dv.getUint32(B_OFF_TIME, true);
    const minute = dv.getUint32(B_OFF_TIME + 4, true);
    const second = dv.getUint32(B_OFF_TIME + 8, true);
    if (day < 1 || day > 31 || month < 1 || month > 12 || !isDashcamYear(year)) return null;
    if (!validHms(hour, minute, second)) return null;

    const lat = ddmmToDegrees(rational(dv, B_OFF_LAT, 1));
    const lon = ddmmToDegrees(rational(dv, B_OFF_LON, 1));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat === 0 && lon === 0) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

    const speedKnots = rational(dv, B_OFF_SPEED, 1);
    const dir = rational(dv, B_OFF_DIR, 1);
    const timestampMs = utcMillisecondsFromParts(year, month, day, hour, minute, second);
    if (timestampMs === null) return null;

    return {
        unixSeconds: timestampMs / 1000,
        active: true,
        lat,
        lon,
        bearingDeg: dir >= 0 && dir < 360 ? dir : 0,
        speedMs: speedKnots * KNOTS_TO_MS,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename,
    };
}

function decodeVariantA(dv: DataView, mp4Filename: string, relStartSeconds: number): GpsRecord | null {
    if (dv.byteLength < A_MIN_SAMPLE_LEN) return null;
    if (dv.getInt32(A_OFF_STATUS, true) !== 1) return null;

    const lat = ddmmToDegrees(rational(dv, A_OFF_LAT, 1e5));
    const lon = ddmmToDegrees(rational(dv, A_OFF_LON, 1e5));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat === 0 && lon === 0) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

    // 0.01-knot units when the scale slot is zero (trip-viewer hardcodes /100;
    // ExifTool's dumps carry scale=100 in the slot).
    const speedKnots = rational(dv, A_OFF_SPEED, 100);
    const dir = rational(dv, A_OFF_DIR, 100);

    return {
        unixSeconds: 0, // placeholder; reanchored onto the video window
        active: true,
        lat,
        lon,
        bearingDeg: dir >= 0 && dir < 360 ? dir : 0,
        speedMs: speedKnots * KNOTS_TO_MS,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename,
        timeUnsynced: true,
        relStartSeconds,
    };
}

/**
 * Reads the in-sample h/m/s of a variant-A sample as seconds-of-day, or null
 * when the slot does not look like a clock.
 */
function variantATimeOfDay(dv: DataView): number | null {
    if (dv.byteLength < A_OFF_TIME + 12) return null;
    const h = dv.getUint32(A_OFF_TIME, true);
    const m = dv.getUint32(A_OFF_TIME + 4, true);
    const s = dv.getUint32(A_OFF_TIME + 8, true);
    if (!validHms(h, m, s)) return null;
    return h * 3600 + m * 60 + s;
}

/**
 * Extracts GPS from a Wolfbox-family gpmd/meta track. Returns null when the
 * track has no samples or the first sample matches neither known layout
 * (caller treats null as "not this format").
 */
export async function extractFromWolfboxTrack(
    vf: VendorFile,
    index: Mp4Index,
    track: TrackInfo,
): Promise<ParsedRecords | null> {
    const sampleBuffers = await loadTrackSampleBuffers(vf.file, index, track);
    if (!sampleBuffers) return null;
    const first = sampleBuffers[0];
    if (!first) return null;

    const variant = detectWolfboxVariant(new DataView(first));
    if (!variant) return null;

    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];

    // Variant A pacing: prefer the in-sample clock (immune to the lying 5 Hz
    // stts); fall back to 1 Hz by index. The clock anchor is taken from the
    // first sample with a VALID FIX, not the first sample - no-fix cold-start
    // samples can carry an unsynced 0:0:0 clock that would blow up every
    // later offset. The lead-in before the anchor is assumed 1 Hz (baseIndex).
    let baseTod: number | null = null;
    let baseIndex = 0;
    let wrapped = false;

    for (let i = 0; i < sampleBuffers.length; i++) {
        const buf = sampleBuffers[i];
        if (!buf) continue;
        const dv = new DataView(buf);

        let rec: GpsRecord | null;
        if (variant === "block2-exiftool") {
            rec = decodeVariantB(dv, vf.file.name);
        } else {
            rec = decodeVariantA(dv, vf.file.name, i);
            if (rec !== null) {
                const tod = variantATimeOfDay(dv);
                if (tod !== null) {
                    if (baseTod === null) {
                        baseTod = tod;
                        baseIndex = i;
                    }
                    let delta = tod - baseTod;
                    if (delta < 0 || wrapped) {
                        wrapped = true;
                        delta += 86400;
                    }
                    rec.relStartSeconds = baseIndex + delta;
                }
            }
        }

        if (rec === null) {
            // No-fix samples are routine (satellite acquisition) - skip
            // silently like the other embedded parsers do.
            continue;
        }
        records.push(rec);
    }

    if (records.length === 0) return null;
    return { records, skipped };
}

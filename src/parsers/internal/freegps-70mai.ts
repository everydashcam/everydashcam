import { matchesBytesAt } from "./byte-search.js";
// 70mai embedded freeGPS - the layout newer 4K 70mai models (A810, M500, ...)
// write INSIDE the MP4, instead of the older $V02 CSV sidecar (csv-70mai).
//
// It is a `freeGPS ` block like Novatek's, but a different dialect than the
// VIOFO/Vantrue variants in freegps.ts, with two defining differences:
//
//  1. Coordinates are int32 * 1e5 NMEA ddmm.mmmm (degrees*100 + minutes), NOT
//     decimal degrees and NOT Novatek's DDDmm.mmmm float. Verified two ways:
//     the on-video OSD coordinate stamp matches the ddmm digits exactly
//     (a decimal read of the same int32 lands tens of km away - up to 0.4 deg
//     inside a degree cell), and ExifTool's A810 branch (QuickTimeStream.pl,
//     GPSType 19) reads the same offsets as Get32s/1e5 + minutes conversion.
//
//  2. There is NO trustworthy per-record timestamp. The only time field is a
//     single constant file-start unix at offset 0x169, and it carries the known
//     70mai "+8h Beijing time" firmware bias (same bug handled in csv-70mai.ts)
//     AND no per-point granularity. So every record is emitted as
//     `timeUnsynced` (position-only): deriveStartUtc ignores them for TZ/start
//     inference and reanchorUnsyncedTimes spreads them across the video window -
//     the exact path the CSV cold-start rows already use.
//
// Block layout (byte offsets from the 8-byte `freeGPS ` magic):
//   [8..9]    u16 LE block tag; equals [14..15], and [10..11] == 0  (signature)
//   [26]      'A' (0x41) active fix / 'V' (0x56) void
//   [27..30]  int32 LE latitude  ddmm.mmmm * 1e5  (signed: negative = S)
//   [31..34]  int32 LE longitude ddmm.mmmm * 1e5  (signed: negative = W)
//   [35..38]  int32 LE heading degrees, [0..360)
//   [39..42]  int32 LE speed, km/h - the emitted speed source (ExifTool's A810
//             branch reads it the same way). Verified on a real A810 clip:
//             matches the trajectory-implied speed to tenths on every normal
//             ~1 Hz fix, reads 0 at a standstill, and stays live through a
//             position-freeze gap - where a trajectory reconstruction under a
//             fixed dt=1s assumption produced 2-4x spikes instead.
//   [0x169]   int32 LE constant file-start unix (8h-shifted) - unused.
//
// Blocks repeat once per video frame (~28-30x per GPS second); identical
// consecutive fixes are collapsed in finalize70maiRecords (and again globally
// by dedupRecords, which keys timeUnsynced rows on position only).

import { ddmmToDegrees } from "./ddmm.js";
import { KMH_TO_MS, type GpsRecord } from "../types.js";

// Field offsets from the freeGPS magic start.
const OFF_TAG = 8;
const OFF_TAG_ZERO = 10;
const OFF_TAG_MIRROR = 14;
const OFF_ACTIVE = 26;
const OFF_LAT = 27;
const OFF_LON = 31;
const OFF_HEADING = 35;
const OFF_SPEED = 39;

// Smallest window the parser touches (speed ends at byte 42).
const MIN_BLOCK_LEN = OFF_SPEED + 4;

const COORD_SCALE = 1e5; // int32 -> ddmm.mmmm
const ACTIVE = 0x41; // 'A'
const VOID = 0x56; // 'V'

// ~324 km/h - a speed-field reading above this (or negative) is firmware
// garbage, not motion, and reads as 0 (honest "unknown" over a wrong spike).
// Generous on purpose: it must not clip genuine fast highway driving.
const MAX_PLAUSIBLE_SPEED_MS = 90;

// Whether the value is a plausible NMEA ddmm.mmmm coordinate: the minutes part
// is < 60 by construction, so a value failing this is not this dialect (a
// decimal-degrees int32 read as ddmm trips it on most fixes).
function isValidDdmm(ddmm: number, maxDegrees: number): boolean {
    if (!Number.isFinite(ddmm)) return false;
    const abs = Math.abs(ddmm);
    const minutes = abs - Math.floor(abs / 100) * 100;
    if (minutes >= 60) return false;
    return Math.abs(ddmmToDegrees(ddmm)) <= maxDegrees;
}

// `freeGPS ` magic bytes - the view passed by the scanner starts here; verify
// defensively so the parser is safe to call directly (tests, future callers).
const MAGIC = [0x66, 0x72, 0x65, 0x65, 0x47, 0x50, 0x53, 0x20];

/**
 * Whether the block is a 70mai-dialect freeGPS block. The signature is the
 * self-referential tag (u16@8 == u16@14, u16@10 == 0) plus an active/void byte
 * and in-range ddmm.mmmm coordinates (minutes < 60, degrees within 90/180).
 * Strong enough that real VIOFO/Novatek Type-3 blocks (which have 0x00 at
 * offset 26 and unrelated tag bytes) never match - verified against
 * SilverStone F1 / 2E Drive samples.
 */
export function is70maiFreeGpsBlock(view: DataView): boolean {
    if (view.byteLength < MIN_BLOCK_LEN) return false;
    if (!matchesBytesAt(view, 0, MAGIC)) return false;
    if (view.getUint16(OFF_TAG, true) !== view.getUint16(OFF_TAG_MIRROR, true)) return false;
    if (view.getUint16(OFF_TAG_ZERO, true) !== 0) return false;
    const active = view.getUint8(OFF_ACTIVE);
    if (active !== ACTIVE && active !== VOID) return false;
    const latDdmm = view.getInt32(OFF_LAT, true) / COORD_SCALE;
    const lonDdmm = view.getInt32(OFF_LON, true) / COORD_SCALE;
    if (!isValidDdmm(latDdmm, 90) || !isValidDdmm(lonDdmm, 180)) return false;
    if (latDdmm === 0 && lonDdmm === 0) return false;
    return true;
}

/**
 * Parses one 70mai freeGPS block into a position-only GpsRecord. Returns an
 * empty array for a non-70mai block or a void fix; a one-element array
 * otherwise (the block carries a single fix - the array shape comes from the
 * multi-record ParseFreeGpsBlock contract). unixSeconds is a placeholder (the
 * block has no usable per-record clock), filled later by
 * reanchorUnsyncedTimes; the record is flagged `timeUnsynced` so the time
 * layer treats it accordingly. Speed comes from the block's km/h field; an
 * out-of-range value (negative or beyond the vehicle ceiling) reads as 0.
 *
 * Signature matches the ParseFreeGpsBlock contract so it can be injected into
 * the shared streamScanFreeGps scanner.
 */
export function parse70maiFreeGpsBlock(view: DataView, mp4Filename: string): GpsRecord[] {
    if (!is70maiFreeGpsBlock(view)) return [];
    if (view.getUint8(OFF_ACTIVE) !== ACTIVE) return []; // void fix, skip

    const lat = ddmmToDegrees(view.getInt32(OFF_LAT, true) / COORD_SCALE);
    const lon = ddmmToDegrees(view.getInt32(OFF_LON, true) / COORD_SCALE);
    let bearingDeg = view.getInt32(OFF_HEADING, true);
    // Heading is degrees already; clamp obvious garbage to 0 (trajectory bearing
    // is not reconstructed here - a single bad heading is harmless).
    if (!Number.isFinite(bearingDeg) || bearingDeg < 0 || bearingDeg >= 360) bearingDeg = 0;
    let speedMs = view.getInt32(OFF_SPEED, true) * KMH_TO_MS;
    if (!Number.isFinite(speedMs) || speedMs < 0 || speedMs > MAX_PLAUSIBLE_SPEED_MS) speedMs = 0;

    return [
        {
            unixSeconds: 0, // placeholder, reanchored onto the video window
            active: true,
            lat,
            lon,
            bearingDeg,
            speedMs,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename,
            timeUnsynced: true,
        },
    ];
}

/**
 * Collapses the per-frame repeats into one record per GPS fix (blocks repeat
 * once per video frame; consecutive blocks with the same position are the same
 * fix). Speed is NOT reconstructed here: each block carries the receiver's own
 * km/h field, read in parse70maiFreeGpsBlock. A trajectory reconstruction under
 * a fixed dt=1s assumption was tried and produced 2-4x spikes whenever the
 * firmware froze the position for 2+ seconds (the next unique fix is then 2+
 * seconds of travel away) - the recorded field stays correct through exactly
 * that case.
 */
export function finalize70maiRecords(records: GpsRecord[]): GpsRecord[] {
    const uniq: GpsRecord[] = [];
    for (const r of records) {
        const last = uniq[uniq.length - 1];
        if (last && last.lat === r.lat && last.lon === r.lon) continue;
        uniq.push(r);
    }
    return uniq;
}

// Garmin DriveAssist 51 GPS extraction. GPS lives in a `uuid` atom that is a
// direct child of moov - ExifTool registers the GarminGPS uuid handler in its
// Movie tag table (QuickTime.pm:1201 table start, uuid list :1226, GarminGPS
// entry :1244-1252, v13.59), NOT at the top level of the file. The atom
// payload: 16-byte usertype UUID, 17 bytes of unknown header, then
// back-to-back 20-byte big-endian records until the end of the box.
//
// Implemented from foreign source (ExifTool 13.59, QuickTimeStream.pl
// ProcessGarminGPS:3514-3543), with a real Dash Cam 57 regression fixture
// in __fixtures__/supported-gps. DriveAssist 51 model attribution remains
// upstream evidence. The exact 16-byte usertype prevents foreign claims.
// ExifTool notes the DriveAssist 50 uses a completely different (unsupported)
// format - the UUID gate naturally excludes it.

import { type GpsRecord, MPH_TO_MS, type ParsedRecords, type SkippedLine } from "../types.js";
import type { Mp4Index } from "./mp4-index.js";
import { type Box, iterBoxes } from "./mp4-walker.js";

// 16-byte usertype of the Garmin GPS uuid atom - exact match required.
// ExifTool QuickTime.pm:1246 (v13.59).
export const GARMIN_GPS_UUID: readonly number[] = [
    0x9b, 0x63, 0x0f, 0x8d, 0x63, 0x74, 0x40, 0xec, 0x82, 0x04, 0xbc, 0x5f, 0xf5, 0x09, 0x17, 0x28,
];

// Records start 33 bytes into the uuid payload: 16-byte usertype + 17 unknown
// header bytes. ExifTool QuickTimeStream.pl:3519 (v13.59).
const RECORDS_START = 33;
// Fixed 20-byte record stride. QuickTimeStream.pl:3524,3538.
const RECORD_STRIDE = 20;
// Record time is u32 seconds since 1904-01-01 UTC (classic QuickTime epoch);
// Unix epoch is 2082844800 s later. QuickTimeStream.pl:3520 spells it as
// (66*365+17)*24*3600.
const QT_EPOCH_OFFSET_SEC = 2082844800;
// lat/lon are signed 32-bit fractions of a half-turn: raw * 180/2^31 degrees.
// QuickTimeStream.pl:3521 (180 / (32768*65536)).
const FIXED_POINT_SCALE = 180 / 0x80000000;
// Speed field is integer mph (MPH_TO_MS from types.ts). QuickTimeStream.pl:3529.
// Firmware writes i32 min into BOTH lat and lon when there is no GPS fix.
// QuickTimeStream.pl:3532.
const NO_FIX_SENTINEL = -2147483648;

// Plausibility window for the decoded record time - the same 2000..2100 span
// the sibling extractors enforce (utcSecondsFromYmdhms and friends).
// Deliberate hardening over ExifTool, which converts the 1904-epoch u32
// blindly: downstream deriveStartUtc trusts the first synced record's time
// as trip start, so one corrupt row with a small raw time (-> year 1904-1970)
// would poison the whole trip. The upper bound is unreachable for a u32
// field (0xFFFFFFFF maps to ~Feb 2040) and exists only to keep the window
// rule uniform across extractors.
const MIN_PLAUSIBLE_UNIX_SEC = Date.UTC(2000, 0, 1) / 1000;
const MAX_PLAUSIBLE_UNIX_SEC = Date.UTC(2100, 0, 1) / 1000;

/**
 * Finds the Garmin GPS uuid atom among the direct children of moov.
 * A moov may carry several uuid children (different vendors' private atoms),
 * so every one is checked against the 16-byte usertype. Pure sync scan over
 * the already-loaded moov bytes - zero extra IO.
 * Returns null when moov is absent or no child matches.
 */
export function findGarminUuidBox(index: Mp4Index): Box | null {
    const { moov, moovView } = index;
    if (!moov || !moovView) return null;
    for (const child of iterBoxes(moovView, moov.payloadStart, moov.end)) {
        if (child.type !== "uuid") continue;
        // Too short to hold a usertype - some other (corrupt) atom.
        if (child.payloadStart + 16 > child.end) continue;
        let matches = true;
        for (let i = 0; i < 16; i++) {
            if (moovView.getUint8(child.payloadStart + i) !== GARMIN_GPS_UUID[i]) {
                matches = false;
                break;
            }
        }
        if (matches) return child;
    }
    return null;
}

/**
 * Decodes all 20-byte records of a Garmin GPS uuid atom into GpsRecords.
 * `box` must come from findGarminUuidBox over the same `moovView`.
 * Returns empty records when the atom holds no valid fix - with the exact
 * UUID signature that means "camera never had a fix", not a format mismatch.
 *
 * Record layout (big-endian; ExifTool QuickTimeStream.pl:3526-3529):
 *   +0  u32 seconds since 1904-01-01 UTC
 *   +4  u16 speed, mph
 *   +6  6 bytes unknown (ExifTool does not decode them either)
 *   +12 i32 latitude  * 180/2^31 degrees
 *   +16 i32 longitude * 180/2^31 degrees
 */
export function parseGarminUuidBox(moovView: DataView, box: Box, mp4Filename: string): ParsedRecords {
    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];

    let pos = box.payloadStart + RECORDS_START;
    let line = 0;
    while (pos + RECORD_STRIDE <= box.end) {
        line++;
        const rawTime = moovView.getUint32(pos);
        const speedMph = moovView.getUint16(pos + 4);
        const latRaw = moovView.getInt32(pos + 12);
        const lonRaw = moovView.getInt32(pos + 16);
        pos += RECORD_STRIDE;

        // No-fix sentinel. Deliberate adaptation: ExifTool still emits
        // GPSDateTime for these records (QuickTimeStream.pl:3530-3537); we
        // drop the record whole - a GpsRecord without coordinates carries
        // nothing the app can use, and a placeholder position would poison
        // the track polyline. Silent (no skipped entry) like the other
        // cold-start no-fix paths (gps-box-70mai).
        if (latRaw === NO_FIX_SENTINEL && lonRaw === NO_FIX_SENTINEL) continue;

        const lat = latRaw * FIXED_POINT_SCALE;
        const lon = lonRaw * FIXED_POINT_SCALE;
        // 0,0 = zero-filled row (preallocated/padded atom tail), not a real
        // fix - same silent-skip convention as pndm-extract.
        if (lat === 0 && lon === 0) continue;
        // lon cannot leave [-180, 180) by construction; lat beyond +-90 means
        // a half-written row (e.g. only one coord is the no-fix sentinel).
        if (Math.abs(lat) > 90) {
            skipped.push({
                line,
                raw: `<garmin uuid rec ${line}>`,
                reason: "latitude out of range",
            });
            continue;
        }
        const unixSeconds = rawTime - QT_EPOCH_OFFSET_SEC;
        // Time plausibility gate (see MIN/MAX_PLAUSIBLE_UNIX_SEC): a corrupt
        // row with plausible coords but a junk time slot must not reach
        // deriveStartUtc as a "real" GPS wall-clock.
        if (unixSeconds < MIN_PLAUSIBLE_UNIX_SEC || unixSeconds >= MAX_PLAUSIBLE_UNIX_SEC) {
            skipped.push({
                line,
                raw: `<garmin uuid rec ${line}>`,
                reason: "timestamp out of range",
            });
            continue;
        }

        records.push({
            unixSeconds,
            active: true,
            lat,
            lon,
            // No course field in the record - dispatcher forward-fills from
            // the trajectory (same as PNDM).
            bearingDeg: 0,
            speedMs: speedMph * MPH_TO_MS,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename,
        });
    }

    return { records, skipped };
}

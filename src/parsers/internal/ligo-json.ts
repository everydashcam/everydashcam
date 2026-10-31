// LigoGPS JSON variant - plain single-line JSON records inside a TOP-LEVEL
// `udta` atom (often in trailer position after mdat). Two carriers share the
// decode:
//
//  - LigoJSON (Yada RoadCam Pro 4K BT58189): the udta payload opens directly
//    with 'LIGOGPSINFO {' - chained 512-byte 'LIGOGPSINFO {json}' blobs.
//  - GKU (__V35AX_QVDATA__): the udta payload opens with a u32 LE at offset 0
//    that is the absolute offset WITHIN the udta payload where the first
//    'LIGOGPSINFO {' must start (verified before parsing), with the
//    '__V35AX_QVDATA__' literal at payload offset 8.
//
// Both are registered on the file-level udta entry of %QuickTime::Main
// (QuickTime.pm:834-847, v13.59); ProcessGKU's own comment calls the box a
// "trailer". This is a SEPARATE primitive from the encrypted/'####' LigoGPS
// chunk format in ligogps.ts - different carrier, marker, and record shape.
//
// JSON fields per the upstream sample (LigoGPS.pm:344-349, in order):
//   Hour Minute Second Year Month Day      - GPS time, UTC
//   status NS EW Latitude Longitude Speed  - 'A' gate; DECIMAL degrees; knots
//   GsensorX/Y/Z                           - units unknown upstream ("000"
//                                            only) - ZEROED here, the house
//                                            rule bans gravity-unverified raws
//   MHour..MDay, OLatitude/OLongitude      - local clock + duplicate coords,
//                                            ignored (we already have UTC)
//
// No decryption, no unfuzz - the JSON is plaintext.
//
// Implemented from foreign source (ExifTool 13.59 LigoGPS.pm:273-281
// ProcessGKU + 322-398 ProcessLigoJSON, QuickTime.pm:834-847). Two real Type S
// S403 clips validate the GKU wrapper and decode; direct LigoJSON remains
// foreign-source-only. Fixtures: __fixtures__/supported-gps.

import { type GpsRecord, KNOTS_TO_MS, type ParsedRecords, type SkippedLine } from "../types.js";
import { utcSecondsFromYmdhms } from "./calendar.js";

/** Sync literal opening every record (and the LigoJSON udta payload). */
export const LIGO_JSON_MARKER = "LIGOGPSINFO {";

/** GKU literal at udta payload offset 8 (QuickTime.pm:842, v13.59). */
export const GKU_MARKER = "__V35AX_QVDATA__";
const GKU_MARKER_OFFSET = 8;

/** Returns true when `bytes` carries the ASCII `text` at `offset`. */
function hasAsciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
    if (bytes.length < offset + text.length) return false;
    for (let i = 0; i < text.length; i++) {
        if (bytes[offset + i] !== text.charCodeAt(i)) return false;
    }
    return true;
}

/** Sync check: udta payload head opens with 'LIGOGPSINFO {' (LigoJSON). */
export function hasLigoJsonMarker(head: Uint8Array): boolean {
    return hasAsciiAt(head, 0, LIGO_JSON_MARKER);
}

/** Sync check: udta payload head carries the GKU signature at offset 8. */
export function hasGkuMarker(head: Uint8Array): boolean {
    return hasAsciiAt(head, GKU_MARKER_OFFSET, GKU_MARKER);
}

/**
 * GKU indirection (ProcessGKU, LigoGPS.pm:273-281): the u32 LE at payload
 * offset 0 is the offset within the udta payload where 'LIGOGPSINFO {' must
 * start. Returns that offset, or null when the head does not carry the GKU
 * signature. The caller verifies the 13-byte literal at the target before
 * parsing (we cannot do it here - the head read does not reach that far).
 */
export function gkuJsonStart(head: Uint8Array): number | null {
    if (!hasGkuMarker(head)) return null;
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    return dv.getUint32(0, true);
}

// Record scan: 'LIGOGPSINFO ' + a single-line JSON object. Deliberate
// deviation from ExifTool's unbounded lazy /LIGOGPSINFO (\{.*?\})/g
// (LigoGPS.pm:342): the lazy form is quadratic on a corrupt/crafted window
// that repeats the literal with no '}' (~7 min of worker hang at the 4 MB
// scan cap), so the body is a bounded negated class instead. The class is
// exactly what the lazy original could consume - non-'}' non-line-terminator
// ('.' without /s excludes \n \r \u2028 \u2029, and lazy-up-to-'}' stops at
// the FIRST '}') - so well-formed records parse bit-identically. 1024 chars
// is generous: upstream records are chained 512-byte blobs.
const RECORD_RE = /LIGOGPSINFO (\{[^}\r\n\u2028\u2029]{0,1024}\})/g;

/** The JSON values are strings ("Hour": "23"); converts one defensively. */
function numField(value: unknown): number | null {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * Parses chained 'LIGOGPSINFO {json}' records out of a latin1-decoded text
 * window. Malformed JSON and gated records land in skipped (never thrown).
 * Caller is responsible for capping the window size.
 */
export function parseLigoJsonText(text: string, mp4Filename: string): ParsedRecords {
    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];
    let line = 0;
    for (const match of text.matchAll(RECORD_RE)) {
        line++;
        const raw = match[1]!;
        const preview = raw.slice(0, 80);
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            skipped.push({ line, raw: preview, reason: "invalid json" });
            continue;
        }
        if (typeof parsed !== "object" || parsed === null) {
            skipped.push({ line, raw: preview, reason: "json record is not an object" });
            continue;
        }
        const info = parsed as Record<string, unknown>;
        // status gate, mirroring ExifTool's `next unless status eq 'A'`:
        // 'V' (or anything else) = no GPS fix, nothing trustworthy to plot.
        if (info.status !== "A") {
            skipped.push({ line, raw: preview, reason: "no gps fix (status != A)" });
            continue;
        }
        const year = numField(info.Year);
        const month = numField(info.Month);
        const day = numField(info.Day);
        const hour = numField(info.Hour);
        const minute = numField(info.Minute);
        const second = numField(info.Second);
        if (year === null || month === null || day === null || hour === null || minute === null || second === null) {
            skipped.push({ line, raw: preview, reason: "missing datetime fields" });
            continue;
        }
        // GPS time is UTC per the upstream field comment (LigoGPS.pm:345) -
        // honest UTC, no timeUnsynced.
        const unixSeconds = utcSecondsFromYmdhms(year, month, day, hour, minute, second);
        if (unixSeconds === null) {
            skipped.push({ line, raw: preview, reason: "implausible datetime" });
            continue;
        }
        const latAbs = numField(info.Latitude);
        const lonAbs = numField(info.Longitude);
        if (latAbs === null || lonAbs === null) {
            skipped.push({ line, raw: preview, reason: "missing coordinates" });
            continue;
        }
        // DECIMAL degrees (no DDmm conversion upstream), hemisphere by NS/EW.
        const lat = latAbs * (info.NS === "S" ? -1 : 1);
        const lon = lonAbs * (info.EW === "W" ? -1 : 1);
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            skipped.push({ line, raw: preview, reason: "coordinates out of range" });
            continue;
        }
        // Speed is knots (ExifTool multiplies by knotsToKph, LigoGPS.pm:370).
        const speedKnots = numField(info.Speed) ?? 0;
        records.push({
            unixSeconds,
            active: true,
            lat,
            lon,
            // No track field in this format; bearing 0 is forward-filled
            // downstream (forwardFillBearingsIfAllZero).
            bearingDeg: 0,
            speedMs: speedKnots * KNOTS_TO_MS,
            // GsensorX/Y/Z deliberately zeroed: scale and orientation are
            // undocumented upstream (every sample value is "000") and the
            // house rule forbids emitting gravity-unverified raw accel.
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename,
        });
    }
    return { records, skipped };
}

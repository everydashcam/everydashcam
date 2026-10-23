// GPMF (GoPro Metadata Format) packer. Paired utility to gpmf.ts/gpmf-extract.ts:
// those read, this one writes. Same format spec:
// github.com/gopro/gpmf-parser/blob/main/docs/README.md
//
// Used during clip export - serializes a subset of GpsRecords into GPMF KLV
// blocks, which are then injected as a gpmd track in the output MP4 (see
// gpmd-inject.ts).
//
// Layout of one device sample we write:
//
//   DEVC (nested)
//     DVID (uint32 = 1)            "device id"
//     DVNM (string = "everydashcam") "device name"
//     STRM (nested)                "GPS stream"
//       STNM (string)              stream name (read by UI players)
//       SCAL (5×i32)               scale divisors for GPS5
//       GPSU (string YYMMDDhhmmss) UTC timestamp of block start
//       GPSF (uint32)              fix quality (3=3D fix, 0=no fix)
//       GPSP (uint16)              DOP × 100 (100 for our source)
//       UNIT (3×c)                 unit labels for GPS5 columns
//       GPS5 (5×i32 ×N)            lat/lon/alt/speed2d/speed3d, scaled
//     STRM (nested) - optional, only if includeAccel=true and at least one
//                    non-zero accelXg/Yg/Zg in the selection
//       STNM (string)              "Accelerometer"
//       SCAL (3×i32)               divisors (1000)
//       UNIT (3×c)                 m/s²×3
//       ACCL (3×i32 ×N)            X/Y/Z, scaled (g -> m/s² via G_TO_MS2)
//
// Each GPMF sample holds the records within one FOOTAGE (content) second.
// The clip timeline is footage-time, with recording pauses
// removed - identical to the stream-copy video track, which also collapses gaps
// (export.ts videoAccumSec). Both tracks therefore have the same length and the
// telemetry stays in sync. Records are projected onto the content axis via the
// trip timeline before bucketing; each sample's GPSU still carries the real
// absolute UTC of that footage moment (contentToWallUtc), which is what
// gpmf-parser / Telemetry Overlay / GoPro Quik align on.
// If no records exist for a given second, emit a placeholder sample with GPSF=0 and
// lat=lon=0 so readers see no-fix and skip it. Without this there would be a gap
// in the gpmd timeline causing desync with video.
//
// All integer fields are big-endian; ASCII strings are nul-padded, and each
// KLV payload is padded to a multiple of 4 bytes.

import { hasSpeed } from "../../gps-telemetry.js";
import { concat } from "../../bytes.js";
import { isValidGpsFix } from "../../parser.js";
import type { GpsRecord } from "../types.js";
import { type TripTimeline, wallToContentSecIfCovered, contentToWallUtc } from "../../trips.js";

/** g to m/s² conversion factor, matching GoPro's UNIT="m/s2" for the ACCL stream. */
const G_TO_MS2 = 9.80665;

/**
 * SCAL divisors for GPS5, in field order: lat, lon, alt, 2d-speed, 3d-speed.
 * Standard GoPro values: 1e7 for coordinates, 1e3 for the rest.
 * Values are multiplied by these divisors when packing and divided back when
 * reading (gpmf-extract.ts:extractFromGps5).
 */
const GPS5_SCAL: readonly [number, number, number, number, number] = [
    10_000_000, // lat
    10_000_000, // lon
    1_000, // alt (m)
    1_000, // 2d-speed (m/s)
    1_000, // 3d-speed (m/s)
];

const ACCL_SCAL = 1_000;

/** GPS fix quality: active=true -> 3D fix, otherwise no fix. */
const GPSF_3D_FIX = 3;
const GPSF_NO_FIX = 0;

/** Default DOP when unavailable: 100 = 1.00 ("good quality"). */
const GPSP_DEFAULT = 100;

/** One serialized GPMF sample and its duration for the output MP4 sample table. */
export interface GpmfSample {
    /** Fully packed DEVC block, ready to write to mdat. */
    payload: Uint8Array;
    /** Sample duration in seconds for stts calculation. Typically exactly 1. */
    durationSec: number;
}

/**
 * Entry point. Serializes trip records into one GpmfSample per second of the
 * exported clip's FOOTAGE (content) timeline. Pauses in the recording are
 * removed from the axis - the same collapsing the stream-copy video track does -
 * so the produced gpmd track has the same length as the video and the telemetry
 * stays in sync even across a multi-file trip with a recording pause.
 *
 * @param records      Full trip records (wall-clock unixSeconds); filtered and
 *                     projected onto the content axis here.
 * @param timeline     The trip's footage-time projection (wall <-> content).
 * @param clipContentStartSec Clip start on the trip's content axis (footage-sec).
 * @param clipContentDurationSec Clip footage duration in seconds. Ceiled for
 *                     sample count; the last sample may be < 1 second.
 * @param opts         { includeAccel } - include a second STRM with accelerometer.
 */
export function packGpmfSamples(
    records: readonly GpsRecord[],
    timeline: TripTimeline,
    clipContentStartSec: number,
    clipContentDurationSec: number,
    opts: { includeAccel: boolean } = { includeAccel: true },
): GpmfSample[] {
    const totalSeconds = Math.max(1, Math.ceil(clipContentDurationSec));
    const clipContentEndSec = clipContentStartSec + clipContentDurationSec;
    const samples: GpmfSample[] = [];

    // Clamping records outside footage would pile a whole GPS-track tail into
    // one sample at an edge or pause divider.
    const projected: { record: GpsRecord; contentSec: number }[] = [];
    for (const record of records) {
        if (!record.active) continue;
        const contentSec = wallToContentSecIfCovered(timeline, record.unixSeconds);
        if (contentSec === null || contentSec < clipContentStartSec || contentSec >= clipContentEndSec) continue;
        projected.push({ record, contentSec });
    }
    projected.sort((a, b) => a.contentSec - b.contentSec);

    // Decide whether to write ACCL once for the whole clip, not per-second.
    // If any record has non-zero accel, we write the ACCL stream on EVERY
    // second (zeros = "stationary", gravity-removed). If all zeros (GPX
    // sidecar, GoPro without accel), we skip ACCL entirely.
    // Reason: gpmf-parser / Telemetry Overlay / GoPro Quik expect an
    // identical STRM layout in every GPMF sample. A varying ACCL presence is
    // treated as a broken stream and usually not rendered at all.
    // (See troubles/dashcamigo_20260429_192226.mp4 for the original regression.)
    const writeAccel = opts.includeAccel && hasAccel(projected.map((p) => p.record));

    // projected is sorted ascending by contentSec and the per-second windows
    // advance monotonically, so a single forward cursor replaces the per-second
    // full-array rescan (was O(seconds x records)).
    let cursor = 0;
    for (let sec = 0; sec < totalSeconds; sec++) {
        const winStart = clipContentStartSec + sec;
        const winEnd = Math.min(winStart + 1, clipContentEndSec);
        const inSecond: GpsRecord[] = [];
        while (cursor < projected.length && projected[cursor]!.contentSec < winEnd) {
            inSecond.push(projected[cursor]!.record);
            cursor++;
        }
        // GPSU stamp = the real absolute UTC of this footage second (the pause is
        // skipped, so consecutive samples can jump across a gap in wall-clock).
        const secondWallUtc = contentToWallUtc(timeline, winStart);
        // Trim the last sample to the actual clip end so the gpmd track duration
        // matches the video track.
        const remaining = clipContentDurationSec - sec;
        const durationSec = Math.min(1, remaining > 0 ? remaining : 1);
        const payload = packDeviceSample(inSecond, secondWallUtc, writeAccel);
        samples.push({ payload, durationSec });
    }

    return samples;
}

/**
 * Serializes one device sample. inSecond may be empty - in that case we write
 * a STRM with one GPSF=0 entry (no-fix) that readers will discard. When
 * writeAccel is true we always write the ACCL stream (caller guarantees the
 * trip has accel data; empty seconds get zeros = "stationary", gravity-removed).
 */
function packDeviceSample(inSecond: GpsRecord[], secondStartUtc: number, writeAccel: boolean): Uint8Array {
    const streams: Uint8Array[] = [packGpsStream(inSecond, secondStartUtc)];
    if (writeAccel) {
        streams.push(packAcclStream(inSecond));
    }

    const devcChildren = concat([
        packKlv("DVID", "L", 4, 1, u32be(1)),
        packStringKlv("DVNM", "everydashcam"),
        ...streams,
    ]);
    return packNestedKlv("DEVC", devcChildren);
}

// Mixed-case keys are third-party GPMF tags. Keep per-sample provenance and
// source boundaries on re-import; foreign GPS5 readers still receive speed in m/s.
function packSpeedMetadata(samples: GpsRecord[]): Uint8Array[] {
    if (!samples.some((r) => r.speedSource !== undefined || r.trackSegment !== undefined)) return [];
    const sources = Uint8Array.from(samples, (r) => (!hasSpeed(r) ? 2 : r.speedSource === "estimated" ? 1 : 0));
    const segments = new Uint8Array(samples.length * 4);
    const view = new DataView(segments.buffer);
    samples.forEach((r, i) => {
        view.setInt32(i * 4, r.trackSegment ?? -1, false);
    });
    return [packKlv("dcsp", "B", 1, samples.length, sources), packKlv("dcsg", "l", 4, samples.length, segments)];
}

/** STRM with GPS5 and associated tags. */
function packGpsStream(inSecond: GpsRecord[], secondStartUtc: number): Uint8Array {
    // Filter positions here so active records with unusable positions still
    // contribute ACCL; receiver-reported inactive records are excluded earlier.
    const fixes = inSecond.filter(isValidGpsFix);
    // No fixes this second: inject a placeholder lat=lon=0 / GPSF=0 so the
    // gpmd track has a sample for every second (no gaps); readers will discard it.
    const samples = fixes.length > 0 ? fixes : [makePlaceholderRecord(secondStartUtc)];
    const fixQuality = fixes.length > 0 ? GPSF_3D_FIX : GPSF_NO_FIX;

    // GPS5: 5 int32 per record, sampleSize=20, repeat=N.
    const gps5Payload = new Uint8Array(samples.length * 20);
    const dv = new DataView(gps5Payload.buffer);
    for (let i = 0; i < samples.length; i++) {
        const r = samples[i]!;
        const off = i * 20;
        dv.setInt32(off, Math.round(r.lat * GPS5_SCAL[0]), false);
        dv.setInt32(off + 4, Math.round(r.lon * GPS5_SCAL[1]), false);
        dv.setInt32(off + 8, 0, false); // altitude: not in GpsRecord, always 0
        const speed = hasSpeed(r) ? r.speedMs : -1;
        dv.setInt32(off + 12, Math.round(speed * GPS5_SCAL[3]), false);
        dv.setInt32(off + 16, Math.round(speed * GPS5_SCAL[4]), false); // 3D speed: duplicated from 2D
    }

    const scalPayload = new Uint8Array(5 * 4);
    const scalDv = new DataView(scalPayload.buffer);
    for (let i = 0; i < 5; i++) scalDv.setInt32(i * 4, GPS5_SCAL[i]!, false);

    const gpsuPayload = encodeGpsuTimestamp(secondStartUtc);

    const strmChildren = concat([
        packStringKlv("STNM", "GPS (Lat., Long., Alt., 2D speed, 3D speed)"),
        // SCAL: type='l' (int32), sampleSize=4, repeat=5.
        packKlv("SCAL", "l", 4, 5, scalPayload),
        // GPSU: type='c' (ASCII), sampleSize=byteLength, repeat=1.
        // Matches how parseGpsuTimestamp reads it (decodeString joins
        // sampleSize×repeat bytes and strips trailing nulls).
        packKlv("GPSU", "c", gpsuPayload.byteLength, 1, gpsuPayload),
        // GPSF: type='L' uint32.
        packKlv("GPSF", "L", 4, 1, u32be(fixQuality)),
        // GPSP: type='S' uint16.
        packKlv("GPSP", "S", 2, 1, u16be(GPSP_DEFAULT)),
        // UNIT: sampleSize = max unit string length (3 for "m/s" / "deg"),
        // repeat = number of units. Each entry is right-padded with nuls.
        packKlv("UNIT", "c", 3, 5, encodeUnitArray(["deg", "deg", "m", "m/s", "m/s"], 3)),
        ...packSpeedMetadata(samples),
        // GPS5: payload data.
        packKlv("GPS5", "l", 20, samples.length, gps5Payload),
    ]);
    return packNestedKlv("STRM", strmChildren);
}

/** STRM with ACCL. */
function packAcclStream(inSecond: GpsRecord[]): Uint8Array {
    // Empty second: write a single zero-accel placeholder so the ACCL stream
    // has a sample on every second. Readers treat a missing ACCL in any
    // sample as a broken stream and skip the entire STRM.
    const records: ReadonlyArray<{ accelXg: number; accelYg: number; accelZg: number }> =
        inSecond.length > 0 ? inSecond : [{ accelXg: 0, accelYg: 0, accelZg: 0 }];

    const acclPayload = new Uint8Array(records.length * 12);
    const dv = new DataView(acclPayload.buffer);
    for (let i = 0; i < records.length; i++) {
        const r = records[i]!;
        const off = i * 12;
        // ACCL payload order: X, Y, Z (matches STNM description).
        dv.setInt32(off, Math.round(r.accelXg * G_TO_MS2 * ACCL_SCAL), false);
        dv.setInt32(off + 4, Math.round(r.accelYg * G_TO_MS2 * ACCL_SCAL), false);
        dv.setInt32(off + 8, Math.round(r.accelZg * G_TO_MS2 * ACCL_SCAL), false);
    }

    const scalPayload = new Uint8Array(4);
    new DataView(scalPayload.buffer).setInt32(0, ACCL_SCAL, false);

    const strmChildren = concat([
        // No axis labels in STNM: physical axis meaning (up/down vs forward/back)
        // depends on camera mounting and differs by vendor (70mai Y=up, BlackVue Z=up,
        // etc.). We write X,Y,Z as stored in GpsRecord (gravity-removed, in g,
        // normalized by the plugin). Readers show three graphs without axis semantics.
        packStringKlv("STNM", "Accelerometer"),
        // SCAL for ACCL: single scalar applied to all 3 columns.
        packKlv("SCAL", "l", 4, 1, scalPayload),
        // UNIT="m/s2" (ASCII, not m/s² with superscript; GoPro real files also use ASCII).
        packKlv("UNIT", "c", 4, 3, encodeUnitArray(["m/s2", "m/s2", "m/s2"], 4)),
        packKlv("ACCL", "l", 12, records.length, acclPayload),
    ]);
    return packNestedKlv("STRM", strmChildren);
}

function packNestedKlv(fourCC: string, payload: Uint8Array): Uint8Array {
    // Nested blocks count chunks, not bytes. Grow the chunk so repeat fits in
    // uint16, with zero END markers filling a partial chunk (GPMF writer).
    let sampleSize = 1;
    while (Math.ceil(payload.byteLength / sampleSize) > 0xffff) {
        sampleSize *= 2;
        if (sampleSize > 0xff) throw new Error(`nested payload too large for ${fourCC}: ${payload.byteLength}`);
    }
    const repeat = Math.ceil(payload.byteLength / sampleSize);
    const paddedSize = sampleSize * repeat;
    if (paddedSize === payload.byteLength) return packKlv(fourCC, 0, sampleSize, repeat, payload);
    const padded = new Uint8Array(paddedSize);
    padded.set(payload);
    return packKlv(fourCC, 0, sampleSize, repeat, padded);
}

function hasAccel(records: readonly GpsRecord[]): boolean {
    for (const r of records) {
        if (r.accelXg !== 0 || r.accelYg !== 0 || r.accelZg !== 0) return true;
    }
    return false;
}

function makePlaceholderRecord(unixSeconds: number): GpsRecord {
    return {
        unixSeconds,
        active: false,
        lat: 0,
        lon: 0,
        bearingDeg: 0,
        speedMs: 0,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename: "",
    };
}

/**
 * Base KLV builder. `type` is either a single-char string ("l", "L", "c", "S",
 * etc.) whose charCode is used, 0 for a nested block, or a raw type byte.
 *
 * Caller must ensure sampleSize × repeat === payload.byteLength (without padding;
 * padding to a multiple of 4 is added here).
 *
 * Returns a Uint8Array with the 8-byte header + payload + padding.
 */
function packKlv(
    fourCC: string,
    type: string | number,
    sampleSize: number,
    repeat: number,
    payload: Uint8Array,
): Uint8Array {
    if (fourCC.length !== 4) throw new Error(`fourCC must be 4 bytes: ${fourCC}`);
    // sampleSize and repeat are written as uint8/uint16 in the KLV header.
    // Silently truncating would produce a corrupt block; surface the violation.
    if (sampleSize < 0 || sampleSize > 0xff || !Number.isInteger(sampleSize)) {
        throw new Error(`sampleSize out of uint8 range for ${fourCC}: ${sampleSize}`);
    }
    if (repeat < 0 || repeat > 0xffff || !Number.isInteger(repeat)) {
        throw new Error(`repeat out of uint16 range for ${fourCC}: ${repeat}`);
    }
    const expectedPayloadSize = sampleSize * repeat;
    if (payload.byteLength !== expectedPayloadSize) {
        throw new Error(
            `payload size mismatch for ${fourCC}: sampleSize=${sampleSize} × repeat=${repeat} = ${expectedPayloadSize}, got ${payload.byteLength}`,
        );
    }
    const padded = (expectedPayloadSize + 3) & ~3;
    const padding = padded - expectedPayloadSize;
    const out = new Uint8Array(8 + padded);
    out[0] = fourCC.charCodeAt(0);
    out[1] = fourCC.charCodeAt(1);
    out[2] = fourCC.charCodeAt(2);
    out[3] = fourCC.charCodeAt(3);
    out[4] = typeof type === "string" ? type.charCodeAt(0) : type;
    out[5] = sampleSize;
    // repeat: uint16 BE, range 0..65535.
    out[6] = (repeat >> 8) & 0xff;
    out[7] = repeat & 0xff;
    out.set(payload, 8);
    // Padding bytes are zero by default (Uint8Array initialization).
    void padding;
    return out;
}

/**
 * KLV for a string. Type 'c', sampleSize = byte length, repeat = 1.
 * Matches how decodeString in gpmf.ts reads it. No nul-terminator needed
 * (sampleSize marks the explicit boundary).
 */
function packStringKlv(fourCC: string, str: string): Uint8Array {
    const bytes = new TextEncoder().encode(str);
    return packKlv(fourCC, "c", bytes.byteLength, 1, bytes);
}

/** Encodes UNIT strings, each right-padded with nuls to itemSize, for UNIT tag payload. */
function encodeUnitArray(units: string[], itemSize: number): Uint8Array {
    const out = new Uint8Array(units.length * itemSize);
    const enc = new TextEncoder();
    for (let i = 0; i < units.length; i++) {
        const bytes = enc.encode(units[i]!);
        if (bytes.byteLength > itemSize) {
            throw new Error(`unit "${units[i]}" exceeds itemSize=${itemSize}: ${bytes.byteLength} bytes`);
        }
        out.set(bytes, i * itemSize);
    }
    return out;
}

/** Encodes GPSU timestamp as ASCII "yymmddhhmmss.sss" (UTC). Paired with parseGpsuTimestamp in gpmf.ts. */
function encodeGpsuTimestamp(unixSeconds: number): Uint8Array {
    const d = new Date(unixSeconds * 1000);
    const yy = String(d.getUTCFullYear() - 2000).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mi = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = String(d.getUTCSeconds()).padStart(2, "0");
    const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
    return new TextEncoder().encode(`${yy}${mm}${dd}${hh}${mi}${ss}.${ms}`);
}

function u16be(v: number): Uint8Array {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, false);
    return b;
}

function u32be(v: number): Uint8Array {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, false);
    return b;
}

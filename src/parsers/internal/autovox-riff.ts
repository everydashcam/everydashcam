// Auto-Vox RIFF trailer - GPS and accelerometer appended AFTER the last
// ISOBMFF box as RIFF-shaped chunks (`[4cc][u32 LE length][payload]`), not as
// MP4 atoms. The chunk names collide with the Ambarella tail atoms (`gps0`,
// `gsen`) but the record layouts inside differ, so nothing here is shared with
// navitel-gps0.ts.
//
// gps0 records (0x28 bytes, `AITG`):
//   +0x04 f64 latitude, +0x0c f64 longitude - DDDMM.MMMM, always POSITIVE
//   +0x18 u16 speed in KNOTS (the Ambarella gps0 stores km/h - different)
//   +0x1a u8[6] year-1900, month, day, hour, minute, second (the Ambarella
//         one is year-2000 - different; upstream flags both divergences)
//   +0x20 u8 direction / 2
//   +0x21 u8 hemisphere N/S, +0x22 u8 hemisphere E/W
//   +0x24 u32 milliseconds since video start
//
// gsen records (0x0c bytes, `AITS`):
//   +0x04 i8[3] accelerometer, +0x08 u32 milliseconds since video start
//
// Two upstream caveats are carried, not resolved: the hemisphere bytes are
// labelled a guess (1=N/E, 2=S/W), and the accelerometer's 24-counts-per-g
// calibration is labelled a guess too. The hemisphere one is the dangerous
// half - a wrong sign mirrors the track across the equator or the meridian -
// so it is applied exactly as upstream reads it and flagged in the coverage
// doc rather than second-guessed.
//
// Unlike the Ambarella `gsen`, these accelerometer records timestamp
// themselves, so no sampling rate has to be assumed.
//
// Implemented from foreign source (ExifTool 13.55 QuickTimeStream.pl:2903-2995,
// ProcessRIFFTrailer), not validated against a real sample.

import type { AccelSample, GpsRecord, ParsedRecords, SkippedLine } from "../types.js";
import { KNOTS_TO_MS } from "../types.js";
import { isDashcamYear, utcMillisecondsFromParts } from "./calendar.js";
import { ddmmToDegrees, isCoordinateInRange } from "./ddmm.js";

const CHUNK_HEADER_SIZE = 8;
/** Upstream's sanity bound on a chunk length; also caps our read. */
const MAX_CHUNK_SIZE = 0x2000000;

const GPS_RECORD_SIZE = 0x28;
const GPS_RECORD_MAGIC = "AITG";
const ACCEL_RECORD_SIZE = 0x0c;
const ACCEL_RECORD_MAGIC = "AITS";
/** Counts per g. Upstream calls the value a guess; kept as-is. */
const ACCEL_COUNTS_PER_G = 24;

/** Largest trailer we will read. Real ones are a few hundred KB at most. */
export const MAX_TRAILER_BYTES = 8 * 1024 * 1024;

function readFourCc(view: DataView, at: number): string {
    let out = "";
    for (let i = 0; i < 4; i++) out += String.fromCharCode(view.getUint8(at + i));
    return out;
}

/**
 * True when the bytes look like the start of an Auto-Vox RIFF trailer: a
 * well-formed chunk header whose payload begins with one of the two record
 * magics. Both halves matter - `gps0`/`gsen` alone are also Ambarella tail
 * atom names, and the `AITG`/`AITS` magic is what separates the dialects.
 */
export function hasAutoVoxTrailerSignature(bytes: Uint8Array): boolean {
    if (bytes.byteLength < CHUNK_HEADER_SIZE + 4) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = readFourCc(view, 0);
    if (tag !== "gps0" && tag !== "gsen") return false;
    const length = view.getUint32(4, true);
    if (length === 0 || length > MAX_CHUNK_SIZE) return false;
    const magic = readFourCc(view, CHUNK_HEADER_SIZE);
    return magic === GPS_RECORD_MAGIC || magic === ACCEL_RECORD_MAGIC;
}

/**
 * Why a gps0 record did not decode. The two upstream bail conditions
 * ("magic-lost", "coords-out-of-bound") mean the rest of the chunk is
 * unreadable; "fields-invalid" costs exactly one record, because the stride is
 * fixed and every record re-states its own magic.
 */
type GpsRecordFailure = "magic-lost" | "coords-out-of-bound" | "fields-invalid";

const GPS_FAILURE_REASON: Record<GpsRecordFailure, string> = {
    "magic-lost": "gps0 record magic missing - chunk alignment lost",
    "coords-out-of-bound": "gps0 coordinates outside the raw ddmm bound",
    "fields-invalid": "gps0 record field out of range",
};

function parseGpsRecord(view: DataView, at: number, mp4Filename: string): GpsRecord | GpsRecordFailure {
    if (readFourCc(view, at) !== GPS_RECORD_MAGIC) return "magic-lost";

    const latRaw = view.getFloat64(at + 0x04, true);
    const lonRaw = view.getFloat64(at + 0x0c, true);
    // NaN/Infinity fails every comparison below, so it has to be caught here or
    // it rides through into a NaN fix. Upstream has no such check.
    if (!Number.isFinite(latRaw) || !Number.isFinite(lonRaw)) return "fields-invalid";
    // Upstream's own bound on the DDDMM.MMMM form, before conversion.
    if (Math.abs(latRaw) > 9000 || Math.abs(lonRaw) > 18000) return "coords-out-of-bound";

    const ns = view.getUint8(at + 0x21) === 2 ? -1 : 1;
    const ew = view.getUint8(at + 0x22) === 2 ? -1 : 1;
    const lat = ddmmToDegrees(latRaw) * ns;
    const lon = ddmmToDegrees(lonRaw) * ew;
    if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) return "fields-invalid";

    const year = view.getUint8(at + 0x1a) + 1900;
    const month = view.getUint8(at + 0x1b);
    const day = view.getUint8(at + 0x1c);
    const hour = view.getUint8(at + 0x1d);
    const minute = view.getUint8(at + 0x1e);
    const second = view.getUint8(at + 0x1f);
    if (!isDashcamYear(year)) return "fields-invalid";
    const timestampMs = utcMillisecondsFromParts(year, month, day, hour, minute, second);
    if (timestampMs === null) return "fields-invalid";

    const bearingDeg = view.getUint8(at + 0x20) * 2;
    if (bearingDeg >= 360) return "fields-invalid";

    return {
        unixSeconds: timestampMs / 1000,
        active: true,
        lat,
        lon,
        bearingDeg,
        speedMs: view.getUint16(at + 0x18, true) * KNOTS_TO_MS,
        // Accel rides its own chunk and is merged by time, not folded in here.
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename,
    };
}

function parseAccelRecord(view: DataView, at: number): AccelSample | null {
    if (readFourCc(view, at) !== ACCEL_RECORD_MAGIC) return null;
    return {
        msSinceStart: view.getUint32(at + 8, true),
        accelXg: view.getInt8(at + 4) / ACCEL_COUNTS_PER_G,
        accelYg: view.getInt8(at + 5) / ACCEL_COUNTS_PER_G,
        accelZg: view.getInt8(at + 6) / ACCEL_COUNTS_PER_G,
    };
}

/**
 * Walks the RIFF chunks of an Auto-Vox trailer and decodes the `gps0` and
 * `gsen` ones. `trailer` must start at the first chunk header. Returns null
 * when no GPS record decoded - accel alone has nothing to attach to.
 *
 * A malformed chunk header ends the walk rather than aborting it, so whatever
 * decoded before it is kept. Inside a chunk only upstream's two bail conditions
 * (record magic gone, raw coordinates past the ddmm bound) end it; a record
 * whose date or bearing is out of range is dropped alone and the walk goes on -
 * a fix-less record right after power-on carries a zeroed date block, and
 * treating that as fatal would throw away the whole track behind it.
 */
export function parseAutoVoxTrailer(trailer: Uint8Array, mp4Filename: string): ParsedRecords | null {
    const view = new DataView(trailer.buffer, trailer.byteOffset, trailer.byteLength);
    const records: GpsRecord[] = [];
    const accelSamples: AccelSample[] = [];
    const skipped: SkippedLine[] = [];

    let at = 0;
    while (at + CHUNK_HEADER_SIZE <= trailer.byteLength) {
        const tag = readFourCc(view, at);
        // A zero tag is upstream's terminator; anything non-tag-shaped ends the
        // walk too (the trailer is not length-prefixed as a whole).
        if (!/^[\w ]{4}$/.test(tag)) break;
        const length = view.getUint32(at + 4, true);
        if (length > MAX_CHUNK_SIZE) break;
        const payloadAt = at + CHUNK_HEADER_SIZE;
        const payloadEnd = Math.min(payloadAt + length, trailer.byteLength);

        if (tag === "gps0") {
            for (let rec = payloadAt; rec + GPS_RECORD_SIZE <= payloadEnd; rec += GPS_RECORD_SIZE) {
                const outcome = parseGpsRecord(view, rec, mp4Filename);
                if (typeof outcome === "string") {
                    skipped.push({
                        line: (rec - payloadAt) / GPS_RECORD_SIZE + 1,
                        raw: `<autovox gps0 record @${rec}>`,
                        reason: GPS_FAILURE_REASON[outcome],
                    });
                    if (outcome === "fields-invalid") continue;
                    break;
                }
                records.push(outcome);
            }
        } else if (tag === "gsen") {
            for (let rec = payloadAt; rec + ACCEL_RECORD_SIZE <= payloadEnd; rec += ACCEL_RECORD_SIZE) {
                const sample = parseAccelRecord(view, rec);
                if (!sample) break;
                accelSamples.push(sample);
            }
        }
        // gpsa / gsea chunks also appear here and are undecoded upstream.

        at = payloadAt + length;
    }

    if (records.length === 0) return null;
    return accelSamples.length > 0 ? { records, skipped, accelSamples } : { records, skipped };
}

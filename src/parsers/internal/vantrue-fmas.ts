// Vantrue N2S (and 2021-firmware N4) FMAS `gpmd` meta-track GPS extraction.
//
// Despite the GoPro-looking track name, the samples are NOT GPMF KLV: each
// sample is a fixed binary record (>= 160 bytes) opening with an 8-byte
// 'FMAS\0\0\0\0' prefix and carrying an 'OFNIMMASSAMM' magic at +0x48. All
// field offsets below are relative to that magic. Implemented from foreign
// source (ExifTool 13.59 QuickTimeStream.pl ProcessFMAS:3580-3611, dispatch
// condition at :196-201; cross-checked against minusbrain/vantrue2gpx
// businesslogic.py:37-89). Three real N2S clips validate the 276-byte carrier
// and empty-status handling only; all have no GPS fix. Positive fields and
// the speed-unit conflict still rely on the documented foreign-source waiver.
//
// Magic-relative layout (magic sits at sample+0x48 in every known record;
// ExifTool's unpack 'x96vCCCCCCx16AAACCCvCCvvv' at QuickTimeStream.pl:3597
// uses the equivalent sample-relative offsets). LONGITUDE COMES BEFORE
// LATITUDE - the reverse of most formats:
//   +24  u16 LE year; +26..+30 u8 month/day/hour/minute/second (UTC)
//   +36  3x float32 LE accelerometer, Z first per ExifTool's own-sample note
//        (QuickTimeStream.pl:3599). NOT stored: the values are raw
//        gravity-included (~ -1 g on Z in the ExifTool hexdump) while
//        GpsRecord wants gravity-removed dynamic accel, and the axis order
//        itself is a single-sample guess.
//   +48  status char, 'A' = valid fix
//   +49  lonRef char 'E'/'W';  +50 latRef char 'N'/'S'
//   +51  u8 lonDeg, +52 u8 lonMin, +53 zero pad, +54 u16 LE lon centi-arcsec
//   +56  u8 latDeg, +57 u8 latMin,              +58 u16 LE lat centi-arcsec
//        coordinate = deg + (min + centiArcsec/6000) / 60
//        (QuickTimeStream.pl:3600-3601; 6000 hundredths of an arc-second per
//        arc-minute)
//   +60  u16 LE speed in mph per ExifTool (QuickTimeStream.pl:3604,
//        '* $mphToKph'). UNRESOLVED CONFLICT: vantrue2gpx comments the same
//        field "in km/h" - if it is right, every speed we emit is 1.609x too
//        high. We follow ExifTool; only a real recording (speed stamp on the
//        video overlay) can settle this.
//   +62  u16 LE GPSTrack in degrees -> bearingDeg per ExifTool
//        (QuickTimeStream.pl:3605). CONFLICT: vantrue2gpx reads this field as
//        elevation*0.1m, but the n=1 evidence favors ExifTool - its sample
//        value 73 at 41.64N 81.37W (Cleveland, elevation ~200 m) is
//        implausible as 7.3 m and plausible as a 73 deg heading.
//
// The track stores one record per video frame, repeating the same 1 Hz fix
// for a whole second - records are deduped to the first per unixSeconds.

import { type GpsRecord, MPH_TO_MS, type ParsedRecords, type VendorFile } from "../types.js";
import { utcMillisecondsFromParts } from "./calendar.js";
import { loadTrackSampleBuffers, type Mp4Index, type TrackInfo } from "./mp4-index.js";

// Decoder anchor; in every known record it sits at sample offset 0x48.
const MAGIC = "OFNIMMASSAMM";

// ExifTool's validation gate (QuickTimeStream.pl:3585):
//   /^FMAS\0\0\0\0.{72}SAMM.{36}A/s  and  length >= 160
// expressed as exact byte positions: prefix at 0, 'SAMM' at 80 (the tail of
// the magic), status 'A' at 120.
const GATE_MIN_LEN = 160;
const GATE_OFF_SAMM = 80;
const GATE_OFF_STATUS = 120;

// 8-byte first-sample prefix - mirrors ExifTool's gpmd dispatch condition
// '^FMAS\0\0\0\0' (QuickTimeStream.pl:196-201).
const FMAS_PREFIX = [0x46, 0x4d, 0x41, 0x53, 0, 0, 0, 0];

/** True when ASCII `text` sits at `offset` of the view (bounds-checked). */
function asciiAt(dv: DataView, offset: number, text: string): boolean {
    if (offset < 0 || offset + text.length > dv.byteLength) return false;
    for (let i = 0; i < text.length; i++) {
        if (dv.getUint8(offset + i) !== text.charCodeAt(i)) return false;
    }
    return true;
}

/** Offset of the 'OFNIMMASSAMM' magic in the sample, or -1. */
function findMagic(dv: DataView): number {
    for (let i = 0; i + MAGIC.length <= dv.byteLength; i++) {
        if (asciiAt(dv, i, MAGIC)) return i;
    }
    return -1;
}

/**
 * Strict marker: the sample opens with the 8-byte 'FMAS\0\0\0\0' prefix.
 * Deliberately ONLY the prefix (ExifTool's dispatch condition) - a secondary
 * "magic anywhere in the first 160 bytes" marker was considered and dropped:
 * the prefix-less-N4 premise behind it is unsupported by either source.
 */
export function hasFmasFirstSamplePrefix(bytes: Uint8Array): boolean {
    if (bytes.byteLength < FMAS_PREFIX.length) return false;
    for (let i = 0; i < FMAS_PREFIX.length; i++) {
        if (bytes[i] !== FMAS_PREFIX[i]) return false;
    }
    return true;
}

/**
 * Decodes one FMAS sample into a GpsRecord. Returns null when the sample
 * fails ExifTool's validation gate, the magic anchor is missing, the status
 * char is not 'A' (no fix), or any decoded field is out of range. Exported
 * for tests; production callers go through extractFromFmasTrack.
 */
export function decodeFmasSample(dv: DataView, mp4Filename: string): GpsRecord | null {
    // ExifTool parity gate (see GATE_* above).
    if (dv.byteLength < GATE_MIN_LEN) return null;
    if (!asciiAt(dv, 0, "FMAS")) return null;
    for (let i = 4; i < 8; i++) {
        if (dv.getUint8(i) !== 0) return null;
    }
    if (!asciiAt(dv, GATE_OFF_SAMM, "SAMM")) return null;
    if (dv.getUint8(GATE_OFF_STATUS) !== 0x41 /* 'A' */) return null;

    const magic = findMagic(dv);
    if (magic < 0) return null;
    if (magic + 64 > dv.byteLength) return null; // fields end at magic+63

    const year = dv.getUint16(magic + 24, true);
    const month = dv.getUint8(magic + 26);
    const day = dv.getUint8(magic + 27);
    const hour = dv.getUint8(magic + 28);
    const minute = dv.getUint8(magic + 29);
    const second = dv.getUint8(magic + 30);
    if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;

    // Status re-checked magic-relative (same byte as the gate when the magic
    // is at its canonical 0x48); hemisphere refs must be real N/S/E/W chars -
    // anything else means layout drift, better to skip than to emit a fix
    // with a guessed sign.
    if (dv.getUint8(magic + 48) !== 0x41 /* 'A' */) return null;
    const lonRef = dv.getUint8(magic + 49);
    const latRef = dv.getUint8(magic + 50);
    if (lonRef !== 0x45 /* 'E' */ && lonRef !== 0x57 /* 'W' */) return null;
    if (latRef !== 0x4e /* 'N' */ && latRef !== 0x53 /* 'S' */) return null;

    const lonAbs = dv.getUint8(magic + 51) + (dv.getUint8(magic + 52) + dv.getUint16(magic + 54, true) / 6000) / 60;
    const latAbs = dv.getUint8(magic + 56) + (dv.getUint8(magic + 57) + dv.getUint16(magic + 58, true) / 6000) / 60;
    const lon = lonRef === 0x57 ? -lonAbs : lonAbs;
    const lat = latRef === 0x53 ? -latAbs : latAbs;
    if (lat === 0 && lon === 0) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

    const speedMph = dv.getUint16(magic + 60, true);
    const track = dv.getUint16(magic + 62, true);
    const timestampMs = utcMillisecondsFromParts(year, month, day, hour, minute, second);
    if (timestampMs === null) return null;

    return {
        unixSeconds: timestampMs / 1000,
        active: true,
        lat,
        lon,
        bearingDeg: track < 360 ? track : 0,
        // ExifTool expresses this as `* $mphToKph` (1.60934) into km/h
        // (QuickTimeStream.pl:75, :3604); MPH_TO_MS is the equivalent direct
        // factor, shared with the other mph formats (single-constant rule).
        speedMs: speedMph * MPH_TO_MS,
        // Raw gravity-included floats live at magic+36 - deliberately not
        // stored (see the header comment).
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename,
    };
}

/**
 * Extracts GPS from a Vantrue FMAS gpmd track. Returns null when the track
 * has no samples or no sample decodes (caller treats null as "not this
 * format"). Per-frame repeats of one fix are deduped to the first record per
 * unixSeconds; no-fix samples are skipped silently like the other embedded
 * parsers do.
 */
export async function extractFromFmasTrack(
    vf: VendorFile,
    index: Mp4Index,
    track: TrackInfo,
): Promise<ParsedRecords | null> {
    const sampleBuffers = await loadTrackSampleBuffers(vf.file, index, track);
    if (!sampleBuffers) return null;

    const records: GpsRecord[] = [];
    const seenSeconds = new Set<number>();
    for (const buf of sampleBuffers) {
        if (!buf) continue;
        const rec = decodeFmasSample(new DataView(buf), vf.file.name);
        if (rec === null) continue;
        if (seenSeconds.has(rec.unixSeconds)) continue;
        seenSeconds.add(rec.unixSeconds);
        records.push(rec);
    }

    if (records.length === 0) return null;
    return { records, skipped: [] };
}

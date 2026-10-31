// Kenwood (JVCKenwood DRV-series) dashcam GPS - two carriers, one extractor:
//
//  1. udta records (DRV-A301W family): a TOP-LEVEL `udta` atom (a sibling of
//     moov, NOT moov/udta - ExifTool registers KenwoodData on the
//     %QuickTime::Main udta entry, QuickTime.pm:826-833) whose payload opens
//     with the literal 'VIDEO' + 22x'U'. Records are \xfe\xfe-delimited ASCII:
//       YYYYMMDDHHMMSS <sep> YYYYMMDDHHMMSS <sep>
//       [NS]<lat DDmm*1e4> [EW]<lon DDDmm*1e4>
//       [-+]dddd<altitude, discarded> <speed km/h>
//       ([-+]ddd [-+]ddd [-+]ddd)*  accel triples, /1000
//     ExifTool uses the FIRST date as GPSDateTime and explicitly discards the
//     second ("ignore second date (what is this for?)") - we mirror that.
//     Source: ProcessKenwood, QuickTimeStream.pl:2855-2900.
//
//  2. CCCC trailer (forum16229 family): raw records appended right AFTER the
//     last top-level atom. The trailer announces itself where a box header
//     read returns the bogus ASCII 'CCCCCCCC' size+type (QuickTime.pm:
//     10179-10184); the full marker is a run of 'C' bytes followed by
//     'GPSDATA--'. Records are 121-byte fixed-width ASCII:
//       'GPSDATA--' + YYYYMMDDHHMMSS + 7 x 14-char fields:
//       lat, lon, speed, unk, accX, accY, accZ - lat/lon carry a leading
//       [NSEW] hemisphere letter and are DECIMAL degrees (ProcessKenwoodTrailer
//       applies no DDmm conversion, unlike the udta carrier).
//     Source: ProcessKenwoodTrailer, QuickTimeStream.pl:2994-3041.
//     C-run length quirk: the upstream sample dump shows 14 C's before the
//     first 'GPSDATA--', but ProcessKenwoodTrailer's own check implies 22
//     (8 consumed as the bogus header + 14 verified). We accept any run of
//     14..31 C's and anchor records right after it, covering both readings.
//
// Time semantics: both carriers stamp records with the CAMERA-LOCAL clock and
// no TZ marker (ExifTool: "likely local time zone, but not confirmed"; the
// trailer GPSDateTime likewise has no 'Z'). Emitting them as UTC would poison
// per-fingerprint TZ estimation (estimateTzByFingerprint medians
// pseudo-local-time minus first-GPS deltas - a local-as-UTC GPS time
// collapses the delta to ~0 and mis-corrects every neighboring file), so
// every record is timeUnsynced=true: excluded from TZ/start inference and
// re-anchored onto the video window. relStartSeconds (delta from the
// carrier's first valid record) preserves the per-record cadence through GPS
// gaps; the residual error is the GPS-fix delay between recording start and
// the first record (seconds). Same policy as the freegps LAYOUT_KENWOOD_MN
// absolute-year branch.
//
// Speed units: udta speed is km/h (ExifTool comment); trailer speed has NO
// unit confirmation upstream (GPSSpeed default km/h assumed) - both decoded
// as km/h, the trailer one flagged NC here.
//
// Accel: /1000 scale for udta (ExifTool, no NC mark); trailer values are
// already decimal. Upstream dumps show no ~1g axis in either carrier, so the
// values are treated as gravity-removed - unverified against a real device.
//
// Implemented from foreign source (ExifTool 13.59 QuickTimeStream.pl:
// 2855-2900, 2994-3041 + QuickTime.pm:826-833, 10179-10184), not validated
// against a real sample.

import type { GpsRecord, ParsedRecords, SkippedLine } from "../types.js";
import { ddmmToDegrees } from "./ddmm.js";
import { utcSecondsFromYmdhms } from "./calendar.js";
import type { Mp4Index } from "./mp4-index.js";
import { type Box, iterBoxes } from "./mp4-walker.js";

/** Sync literal at the start of the Kenwood udta payload: 'VIDEO' + 22x'U'
 *  (QuickTime.pm:828, v13.59). */
export const KENWOOD_UDTA_MARKER = `VIDEO${"U".repeat(22)}`;

/** Minimum length of the trailer's leading 'C' run (the upstream dump form). */
const KENWOOD_TRAILER_MIN_C_RUN = 14;
/** Maximum accepted 'C' run: 22 (the ProcessKenwoodTrailer reading) plus
 *  slack; a longer run is not a Kenwood trailer. */
const KENWOOD_TRAILER_MAX_C_RUN = 31;
const KENWOOD_TRAILER_RECORD_PREFIX = "GPSDATA--";
/** Bytes a trailer probe needs: max C run + the record prefix. */
export const KENWOOD_TRAILER_PROBE_BYTES = KENWOOD_TRAILER_MAX_C_RUN + KENWOOD_TRAILER_RECORD_PREFIX.length;

/** 'GPSDATA--'(9) + datetime(14) + 7 fields x 14. */
const TRAILER_RECORD_LENGTH = 121;
const TRAILER_FIELD_LENGTH = 14;
const TRAILER_FIELDS_START = 23;

const LATIN1 = new TextDecoder("latin1");

/** Returns true when `bytes` starts with the ASCII `text`. */
function bytesStartWithAscii(bytes: Uint8Array, text: string): boolean {
    if (bytes.length < text.length) return false;
    for (let i = 0; i < text.length; i++) {
        if (bytes[i] !== text.charCodeAt(i)) return false;
    }
    return true;
}

/** Sync check for the udta carrier: payload head opens with the VIDEOUUU
 *  literal. `head` is Mp4Index.topLevelUdtaHead (or any payload prefix). */
export function hasKenwoodUdtaMarker(head: Uint8Array): boolean {
    return bytesStartWithAscii(head, KENWOOD_UDTA_MARKER);
}

/**
 * Finds a moov/udta child whose payload opens with the VIDEOUUU literal.
 * Pure sync scan over the already-loaded moov bytes - zero IO. Lives here
 * (not in the primitive) so classifyEmbeddedGpsKind in registry.ts can reuse
 * it without importing a primitive module (registry -> internal only).
 */
export function findKenwoodMoovUdta(index: Mp4Index): Box | null {
    if (!index.moov || !index.moovView) return null;
    const mv = index.moovView;
    for (const child of iterBoxes(mv, index.moov.payloadStart, index.moov.end)) {
        if (child.type !== "udta") continue;
        const payloadLen = child.end - child.payloadStart;
        if (payloadLen < KENWOOD_UDTA_MARKER.length) continue;
        const head = new Uint8Array(
            mv.buffer,
            mv.byteOffset + child.payloadStart,
            Math.min(payloadLen, KENWOOD_UDTA_MARKER.length),
        );
        if (hasKenwoodUdtaMarker(head)) return child;
    }
    return null;
}

/**
 * Sync check for the CCCC trailer: a run of 14..31 'C' bytes followed
 * immediately by 'GPSDATA--'. `head` is a read of at least
 * KENWOOD_TRAILER_PROBE_BYTES at the last-top-level-box-end offset.
 */
export function hasKenwoodTrailerMarker(head: Uint8Array): boolean {
    let run = 0;
    while (run < head.length && head[run] === 0x43 && run <= KENWOOD_TRAILER_MAX_C_RUN) run++;
    if (run < KENWOOD_TRAILER_MIN_C_RUN || run > KENWOOD_TRAILER_MAX_C_RUN) return false;
    return bytesStartWithAscii(head.subarray(run), KENWOOD_TRAILER_RECORD_PREFIX);
}

// One udta record, mirroring ExifTool's sequential \G matches collapsed into
// a single anchored regex: date1 + separator + date2 (discarded) + separator
// + hemisphere-tagged coordinate digit runs. The /s separators are binary
// bytes ('.' and \x03 in the upstream dump). The tail (altitude/speed/accel)
// is parsed separately because it is optional per ExifTool.
const UDTA_RECORD_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2}).\d{14}.([NS])(\d+)([EW])(\d+)/s;
// Optional altitude (+dddd, "(NC, educated guess)" upstream - discarded:
// GpsRecord carries no altitude) + speed km/h.
const UDTA_SPEED_RE = /^([-+]\d{4})(\d+)/;
// First accel triple. ExifTool collects EVERY trailing triple into one tag;
// GpsRecord holds a single triple per fix, so we keep the first (closest to
// the GPS timestamp) and drop the rest.
const UDTA_ACCEL_RE = /^([-+]\d+)([-+]\d+)([-+]\d+)/;

/**
 * Parses the Kenwood udta payload (bytes AFTER the box header; may start with
 * the VIDEOUUU literal - the records are extracted by delimiter, so leading
 * non-record bytes are naturally skipped). Returns records with
 * timeUnsynced=true and relStartSeconds anchored to the first valid record
 * (see the module banner for the time-semantics rationale).
 */
export function parseKenwoodUdta(payload: Uint8Array, mp4Filename: string): ParsedRecords {
    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];
    const text = LATIN1.decode(payload);

    let firstNaiveSeconds: number | null = null;
    let line = 0;
    // \xfe\xfe delimiter, record body = the following non-\xfe bytes
    // (ProcessKenwood's /\xfe\xfe([^\xfe]+)/g).
    for (const match of text.matchAll(/\xfe\xfe([^\xfe]+)/g)) {
        line++;
        const rec = match[1]!;
        const m = UDTA_RECORD_RE.exec(rec);
        if (!m) {
            skipped.push({ line, raw: rec.slice(0, 64), reason: "no datetime/coordinate pattern" });
            continue;
        }
        const naiveSeconds = utcSecondsFromYmdhms(
            Number(m[1]),
            Number(m[2]),
            Number(m[3]),
            Number(m[4]),
            Number(m[5]),
            Number(m[6]),
        );
        if (naiveSeconds === null) {
            skipped.push({ line, raw: rec.slice(0, 64), reason: "implausible datetime" });
            continue;
        }
        // Coordinates are DDmm.mmmm scaled by 1e4 in a plain digit run.
        const lat = ddmmToDegrees(Number(m[8]) / 1e4) * (m[7] === "S" ? -1 : 1);
        const lon = ddmmToDegrees(Number(m[10]) / 1e4) * (m[9] === "W" ? -1 : 1);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            skipped.push({ line, raw: rec.slice(0, 64), reason: "coordinates out of range" });
            continue;
        }

        let speedKmh = 0;
        let accel: readonly [number, number, number] = [0, 0, 0];
        const tail = rec.slice(m[0].length);
        const spd = UDTA_SPEED_RE.exec(tail);
        if (spd) {
            speedKmh = Number(spd[2]);
            const acc = UDTA_ACCEL_RE.exec(tail.slice(spd[0].length));
            if (acc) {
                accel = [Number(acc[1]) / 1000, Number(acc[2]) / 1000, Number(acc[3]) / 1000];
            }
        }

        if (firstNaiveSeconds === null) firstNaiveSeconds = naiveSeconds;
        records.push({
            unixSeconds: naiveSeconds,
            active: true,
            lat,
            lon,
            // No track/course field in this carrier; bearing 0 is
            // forward-filled downstream (forwardFillBearingsIfAllZero).
            bearingDeg: 0,
            speedMs: speedKmh / 3.6,
            accelXg: accel[0],
            accelYg: accel[1],
            accelZg: accel[2],
            mp4Filename,
            timeUnsynced: true,
            relStartSeconds: naiveSeconds - firstNaiveSeconds,
        });
    }
    return { records, skipped };
}

/** Strips an optional leading hemisphere letter and validates the fixed-width
 *  trailer field shape. Returns the signed numeric value, or null. */
function parseTrailerField(field: string): { value: number; hemi: string | null } | null {
    let hemi: string | null = null;
    let body = field;
    if (/^[NSEW]/.test(body)) {
        hemi = body[0]!;
        body = body.slice(1);
    }
    // ExifTool's per-field validator: /^[-+]?\d+\.\d+$/ (trailing padding in
    // the 14-char slot fails the anchor, which is correct - the slots are
    // zero-padded with digits, not spaces, in the upstream dump).
    if (!/^[-+]?\d+\.\d+$/.test(body)) return null;
    return { value: Number(body), hemi };
}

/**
 * Parses the Kenwood CCCC trailer. `bytes` must start at the trailer head
 * (= Mp4Index.lastTopLevelBoxEnd): a 'C' run, then chained 121-byte
 * 'GPSDATA--' records; iteration stops at the first non-matching slot.
 * Returns empty records when the marker is absent.
 */
export function parseKenwoodTrailer(bytes: Uint8Array, mp4Filename: string): ParsedRecords {
    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];
    if (!hasKenwoodTrailerMarker(bytes)) return { records, skipped };

    let pos = 0;
    while (pos < bytes.length && bytes[pos] === 0x43) pos++;

    let firstNaiveSeconds: number | null = null;
    let line = 0;
    while (pos + TRAILER_RECORD_LENGTH <= bytes.length) {
        const rec = LATIN1.decode(bytes.subarray(pos, pos + TRAILER_RECORD_LENGTH));
        const dt = /^GPSDATA--(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(rec);
        if (!dt) break; // record chain ended - same terminator as ExifTool's read loop
        pos += TRAILER_RECORD_LENGTH;
        line++;

        const naiveSeconds = utcSecondsFromYmdhms(
            Number(dt[1]),
            Number(dt[2]),
            Number(dt[3]),
            Number(dt[4]),
            Number(dt[5]),
            Number(dt[6]),
        );
        if (naiveSeconds === null) {
            skipped.push({ line, raw: rec.slice(0, 64), reason: "implausible datetime" });
            continue;
        }

        // 7 x 14-char fields: lat, lon, speed, unk, accX, accY, accZ.
        const fields: (ReturnType<typeof parseTrailerField> | null)[] = [];
        for (let i = 0; i < 7; i++) {
            const start = TRAILER_FIELDS_START + i * TRAILER_FIELD_LENGTH;
            fields.push(parseTrailerField(rec.slice(start, start + TRAILER_FIELD_LENGTH)));
        }
        const [latF, lonF, spdF, , accXF, accYF, accZF] = fields;
        if (!latF || !lonF) {
            skipped.push({ line, raw: rec.slice(0, 64), reason: "invalid coordinate fields" });
            continue;
        }
        // DECIMAL degrees (no DDmm conversion in ProcessKenwoodTrailer).
        const lat = latF.value * (latF.hemi === "S" ? -1 : 1);
        const lon = lonF.value * (lonF.hemi === "W" ? -1 : 1);
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            skipped.push({ line, raw: rec.slice(0, 64), reason: "coordinates out of range" });
            continue;
        }
        // Speed units NC upstream - km/h assumed (ExifTool GPSSpeed default).
        const speedKmh = spdF ? spdF.value : 0;
        // Accel: all-or-nothing like ExifTool's `if @acc == 3`.
        const accel: readonly [number, number, number] =
            accXF && accYF && accZF ? [accXF.value, accYF.value, accZF.value] : [0, 0, 0];

        if (firstNaiveSeconds === null) firstNaiveSeconds = naiveSeconds;
        records.push({
            unixSeconds: naiveSeconds,
            active: true,
            lat,
            lon,
            bearingDeg: 0, // no track field; forward-filled downstream
            speedMs: speedKmh / 3.6,
            accelXg: accel[0],
            accelYg: accel[1],
            accelZg: accel[2],
            mp4Filename,
            timeUnsynced: true,
            relStartSeconds: naiveSeconds - firstNaiveSeconds,
        });
    }
    return { records, skipped };
}

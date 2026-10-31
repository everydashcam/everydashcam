// LigoGPS - GPS payload written by several SoC families under the
// LIGOGPSINFO\0 marker. Claimed here: the encrypted `ssmd` meta-track
// (CARCAM 4CH 360-WiFi and relatives), the plaintext half of the file trailer
// (Beferich J18 - see parseLigoGpsTrailer below) and the plaintext TXT log
// written next to a .TS. The enciphered MPEG-TS PES dialect that log mirrors
// lives in ligogps-ts-pes.ts. The freeGPS-wrapped and `gpmd` carriers (Rexing,
// Kingslim, iiway, XGODY, Redtiger F9 4K) plus the encrypted trailer twin are
// a recognize-and-bail case, deliberately left unclaimed - see
// FUZZ_SETTLED_SAMPLE_FORMAT.
//
// Source of truth: ExifTool LigoGPS.pm (DecryptLigoGPS + ParseLigoGPS),
// ported 1-to-1 to avoid divergence. ExifTool MIT/Artistic-2.
//
// Format:
//   chunk header (0x84 = 132 bytes max):
//     [0..3]  '####' (encryption marker)
//     [4..7]  u32 LE: length of encrypted body (max 0x84)
//     [8..]   encrypted body (length bytes), steering-bit-guided XOR
//
//   Decrypted body - ASCII string like:
//     "<4-byte preamble> 2025/06/07 18:06:17 N:50.123456 E:30.654321 25.5"
//   - first 4 chars skipped by regex (`^.{4}`),
//   - followed by datetime, NS-ref, lat decimal, EW-ref, lon decimal, speed.
//
// Alternative plaintext format (Redtiger F9 4K) - not encrypted, same
// regex after `^.{4}\d{4}/\d{2}/\d{2}` without decryption. Both branches supported.

import { findTsGpsTrailer, isTsGpsTrailerTerminator, TS_TRAILER_SLOTS_OFFSET } from "../../ts-trailer.js";
import type { GpsRecord, ParsedRecords, SkippedLine, VendorFile } from "../types.js";
import { KNOTS_TO_MS, WrongFormatError } from "../types.js";
import { removeGravityBaselineInUnknownUnits } from "./accel-baseline.js";
import { isDashcamYear, utcMillisecondsFromParts } from "./calendar.js";
import { findByteSequence } from "./byte-search.js";
import { loadSamples, readSampleTable } from "./mp4-walker.js";
import type { Mp4Index } from "./mp4-index.js";

const LIGO_MAGIC = "LIGOGPSINFO";
const LIGO_MAGIC_BYTES = new TextEncoder().encode(LIGO_MAGIC);

/**
 * The MP4 carrier whose fuzz state is settled by a real sample: LigoGPS in an
 * `ssmd` meta-track decodes correctly WITHOUT the upstream unfuzz step. The
 * only other settled carrier is the enciphered MPEG-TS PES, and only under the
 * exact stream type and chunk header of its sample (ligogps-ts-pes.ts): that
 * one IS fuzzed, at LIGO_FUZZ_SCALE_3, proven against the camera's plaintext
 * TXT twin.
 *
 * Any other carrier stays unclaimed on purpose. Upstream decides fuzzing from
 * a header byte (LigoGPS.pm:299, v1.06), and that rule misclassifies our real
 * ssmd sample: the sample lands in the "fuzzed" class while its coordinates
 * are verified correct un-fuzzed. So the header cannot key the decision, the
 * carrier has to - and the `gpmd` variant (Kingslim D4 and relatives) has no
 * sample to settle it.
 *
 * Guessing is not the cheap option here. Unfuzzing swaps the fractional parts
 * of the two coordinates within their 10-degree squares (UnfuzzLigoGPS), so a
 * wrong call in EITHER direction still yields a well-formed fix that passes
 * every range and plausibility check while sitting tens of kilometres off. An
 * unclaimed file reads as "no GPS" and can be fixed later; a plausible wrong
 * track is believed.
 */
const FUZZ_SETTLED_SAMPLE_FORMAT = "ssmd";

/**
 * Decrypts one 0x84-byte LigoGPS chunk. Algorithm is 1-to-1 from ExifTool
 * LigoGPS.pm `DecryptLigoGPS`. Returns null if the chunk is malformed.
 *
 * The first byte of each 5-byte sub-chunk is the control byte. The upper
 * 3 bits (steering bits) select one of 4 decryption branches; the lower
 * bits are mixed with the next 4 (or 3, or 1) bytes via OR and XOR with 0x20.
 */
export function decryptLigoGps(chunk: Uint8Array): Uint8Array | null {
    if (chunk.length < 8) return null;
    // num at offset 4 LE u32 - size of the encrypted body.
    const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let num = dv.getUint32(4, true);
    if (num < 4) return null;
    if (num > 0x84) num = 0x84;
    if (chunk.length < 8 + num) return null;

    // @in - encrypted bytes starting at offset 8.
    const inBuf = chunk.subarray(8, 8 + num);
    const out: number[] = [];
    let i = 0;

    while (i < inBuf.length) {
        const b = inBuf[i++]!;
        const steering = b & 0xe0;

        if (steering >= 0xc0) {
            // Note: ExifTool LigoGPS.pm may split 0xc0 and 0xe0 into separate
            // branches. We merge them - works on fixture samples, but no real
            // recordings with steering=0xe0 exist in fixtures. If a LigoGPS
            // dashcam produces broken decryption, compare against ExifTool:
            // https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/LigoGPS.pm
            if (i + 4 > inBuf.length) return null;
            const a = inBuf[i++]!;
            const c = inBuf[i++]!;
            const d = inBuf[i++]!;
            const e = inBuf[i++]!;
            out.push((a | (b & 0x01)) ^ 0x20);
            out.push((c | (b & 0x02)) ^ 0x20);
            out.push((d | (b & 0x0c)) ^ 0x20);
            // ExifTool: shift(@in) ^ 0x20 | $b & 0x30 - precedence: ^ before |
            out.push((e ^ 0x20) | (b & 0x30));
        } else if (steering >= 0x40) {
            if (i + 3 > inBuf.length) return null;
            const a = inBuf[i++]!;
            const c = inBuf[i++]!;
            const d = inBuf[i++]!;
            if (steering === 0x40) {
                out.push(0x20);
                out.push((a | (b & 0x01)) ^ 0x20);
                out.push((c | (b & 0x06)) ^ 0x20);
                out.push((d | (b & 0x18)) ^ 0x20);
            } else if (steering === 0x60) {
                out.push((a | (b & 0x03)) ^ 0x20);
                out.push(0x20);
                out.push((c | (b & 0x04)) ^ 0x20);
                out.push((d | (b & 0x18)) ^ 0x20);
            } else if (steering === 0x80) {
                out.push((a | (b & 0x03)) ^ 0x20);
                out.push((c | (b & 0x0c)) ^ 0x20);
                out.push(0x20);
                out.push((d | (b & 0x10)) ^ 0x20);
            } else {
                // 0xa0
                out.push((a | (b & 0x01)) ^ 0x20);
                out.push((c | (b & 0x06)) ^ 0x20);
                out.push((d | (b & 0x18)) ^ 0x20);
                out.push(0x20);
            }
        } else if (steering === 0x00) {
            if (i + 1 > inBuf.length) return null;
            const a = inBuf[i++]!;
            out.push(a | (b & 0x13));
        } else {
            // 0x20: shouldn't happen per ExifTool comment.
            return null;
        }
    }

    return Uint8Array.from(out);
}

/**
 * Parses a decrypted ASCII string into a GpsRecord.
 *
 * Regex from ExifTool ParseLigoGPS:
 *   /^.{4}(\S+ \S+)\s+([NS?]):(-?)([.\d]+)\s+([EW?]):(-?)([\.\d]+)\s+([.\d]+)/
 *
 * Capture groups (1-indexed, Perl convention):
 *   1: datetime "YYYY/MM/DD HH:MM:SS"
 *   2: lat hemisphere (N/S/?)
 *   3: optional minus
 *   4: lat decimal degrees
 *   5: lon hemisphere (E/W/?)
 *   6: optional minus
 *   7: lon decimal degrees
 *   8: speed (unit is per-carrier, see LigoSpeedUnit)
 *
 * The `s` flag mirrors ExifTool's /s: the leading 4 bytes are a binary
 * counter, and a counter byte of 0x0a (record 10, 266, ...) must not make
 * `.` fail on a "line terminator".
 */
const REC_RX = /^.{4}(\S+ \S+)\s+([NS?]):(-?)([.\d]+)\s+([EW?]):(-?)([.\d]+)\s+([.\d]+)/s;

/** Optional trailing fields (ExifTool ParseLigoGPS): A: course over ground
 *  in degrees, x/y/z accelerometer components. H: (altitude) has no
 *  GpsRecord field and M: (magnetic variation) no consumer - both dropped. */
const COURSE_RX = /\bA:(-?[.\d]+)/;
const COURSE_AFTER_ACCEL_RX = /x:-?[.\d]+\sy:-?[.\d]+\sz:-?[.\d]+\s+(-?[.\d]+)\s+-\s+-\s*$/;
// "<speed> km/h <course> <altitude> <satellites> x:..." - the field order of
// the enciphered TS PES and its TXT twin, course verified against the track.
const COURSE_AFTER_SPEED_RX = /\skm\/h\s+(-?[.\d]+)\s+-?[.\d]+\s+\d+\s+x:/;
const ACCEL_RX = /x:(-?[.\d]+)\sy:(-?[.\d]+)\sz:(-?[.\d]+)/;

/**
 * Speed unit of the record's 8th field. ExifTool keys this off carrier flags
 * (LigoGPS.pm ParseLigoGPS `$flags`): encrypted ssmd records carry knots,
 * the plaintext trailer records (flags 0x02) are already km/h.
 */
type LigoSpeedUnit = "knots" | "kmh";

/**
 * Where an untagged course sits. Every dialect also honours an `A:` tag;
 * the positional forms are dialect-specific, so a caller opts into one.
 */
type LigoCourseLayout = "tagged" | "after-accel" | "after-speed";

export interface LigoRecordOptions {
    speedUnit?: LigoSpeedUnit;
    courseLayout?: LigoCourseLayout;
    /** Undoes the firmware coordinate fuzzing with this scale (see unfuzzLigoGps); absent = plain coordinates. */
    fuzzScale?: number;
}

/**
 * ExifTool `%gpsScl` entry 3 (LigoGPS.pm ParseLigoGPS). The enciphered TS PES
 * dialect matches it: every record of the real sample lands within 12 m of the
 * camera's own plaintext TXT twin, while scales 1, 1.524855137 and 1.456027985
 * miss by 104-252 km.
 */
export const LIGO_FUZZ_SCALE_3 = 1.15368;

/**
 * Inverse of the firmware fuzzing (ExifTool LigoGPS.pm UnfuzzLigoGPS): the
 * fractional parts of latitude and longitude within their 10-degree cells are
 * swapped and multiplied by `scale`. Takes and returns unsigned degrees; the
 * caller applies hemisphere signs afterwards, as ExifTool does.
 */
export function unfuzzLigoGps(lat: number, lon: number, scale: number): { lat: number; lon: number } {
    const latCell = Math.trunc(lat / 10) * 10;
    const lonCell = Math.trunc(lon / 10) * 10;
    return { lat: latCell + (lon - lonCell) * scale, lon: lonCell + (lat - latCell) * scale };
}

function courseMatchFor(text: string, layout: LigoCourseLayout): RegExpMatchArray | null {
    const tagged = text.match(COURSE_RX);
    if (tagged || layout === "tagged") return tagged;
    return text.match(layout === "after-accel" ? COURSE_AFTER_ACCEL_RX : COURSE_AFTER_SPEED_RX);
}

export function parseLigoGpsRecord(
    text: string,
    mp4Filename: string,
    options: LigoRecordOptions = {},
): GpsRecord | null {
    const { speedUnit = "knots", courseLayout = "tagged", fuzzScale } = options;
    const m = text.match(REC_RX);
    if (!m) return null;

    const datetimeStr = m[1]!;
    const nsRef = m[2]!;
    const latNeg = m[3] === "-";
    const latStr = m[4]!;
    const ewRef = m[5]!;
    const lonNeg = m[6] === "-";
    const lonStr = m[7]!;
    const speedStr = m[8]!;
    const courseMatch = courseMatchFor(text, courseLayout);
    const accelMatch = text.match(ACCEL_RX);

    // datetime: "YYYY/MM/DD HH:MM:SS" (UTC).
    const dtMatch = datetimeStr.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})/);
    if (!dtMatch) return null;
    const year = Number(dtMatch[1]);
    const month = Number(dtMatch[2]);
    const day = Number(dtMatch[3]);
    const hour = Number(dtMatch[4]);
    const minute = Number(dtMatch[5]);
    const second = Number(dtMatch[6]);
    if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
    if (!isDashcamYear(year)) return null;
    const timestampMs = utcMillisecondsFromParts(year, month, day, hour, minute, second);
    if (timestampMs === null) return null;

    let lat = Number(latStr);
    let lon = Number(lonStr);
    const speedRaw = Number(speedStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(speedRaw)) return null;

    if (fuzzScale !== undefined) ({ lat, lon } = unfuzzLigoGps(lat, lon, fuzzScale));
    if (latNeg || nsRef === "S") lat = -lat;
    if (lonNeg || ewRef === "W") lon = -lon;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    if (nsRef === "?" || ewRef === "?") return null; // no fix

    // Course: only a plausible [0..360) value lands in bearingDeg; anything
    // else keeps 0 so the dispatcher forward-fills from trajectory.
    let bearingDeg = 0;
    if (courseMatch) {
        const course = Number(courseMatch[1]);
        if (Number.isFinite(course) && course >= 0 && course < 360) bearingDeg = course;
    }
    let accelXg = 0;
    let accelYg = 0;
    let accelZg = 0;
    if (accelMatch) {
        const [ax, ay, az] = [Number(accelMatch[1]), Number(accelMatch[2]), Number(accelMatch[3])];
        if (Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(az)) {
            [accelXg, accelYg, accelZg] = [ax, ay, az];
        }
    }

    const unixSeconds = timestampMs / 1000;
    return {
        unixSeconds,
        active: true,
        lat,
        lon,
        bearingDeg,
        speedMs: speedUnit === "kmh" ? speedRaw / 3.6 : speedRaw * KNOTS_TO_MS,
        accelXg,
        accelYg,
        accelZg,
        mp4Filename,
    };
}

/**
 * Scans the payload for "LIGOGPSINFO" followed by `####` (encrypted format).
 * Returns the chunk-start offset (position of `####`) or null.
 *
 * ExifTool regex: `^(.{16}|.{48}|.{80})LIGOGPSINFO\0` - three prefix lengths.
 * We do a general substring scan, then verify that after LIGOGPSINFO+0x14 a
 * `####` marker follows. Chunk starts there (0x14 = 11 magic + 4 zero-pad +
 * 4 spare; CARCAM stores scale/version info there, which we don't need).
 */
export function findLigoGpsChunkOffset(payload: Uint8Array): number | null {
    const i = findByteSequence(payload, LIGO_MAGIC_BYTES);
    if (i >= 0) {
        // Found "LIGOGPSINFO". Chunk start = LIGOGPSINFO + 0x14.
        const chunkStart = i + 0x14;
        if (chunkStart + 8 > payload.length) return null;
        // Verify '####' marker for encrypted variant.
        if (
            payload[chunkStart] === 0x23 &&
            payload[chunkStart + 1] === 0x23 &&
            payload[chunkStart + 2] === 0x23 &&
            payload[chunkStart + 3] === 0x23
        ) {
            return chunkStart;
        }
        // Note: plaintext variant (Redtiger F9 4K) - chunk has no `####`, starts
        // directly with ASCII datetime. Not implemented without a sample.
        return null;
    }
    return null;
}

/**
 * Extracts GpsRecords from a LigoGPS-encoded MP4. Shared between the
 * vendor-specific carcamPlugin and the genericPlugin fallback.
 *
 * Walks all `meta` tracks, filters non-GPS tracks by sample size heuristic
 * (64..1024 bytes; JPEG thumbnails >1 KB, G-sensor = 12 bytes), then reads
 * samples, locates the LIGOGPSINFO+`####` chunk in each, decrypts, and
 * regex-parses.
 */
export async function parseLigoGpsFromMp4(file: VendorFile, index: Mp4Index): Promise<ParsedRecords> {
    if (!index.moov) throw new WrongFormatError("no moov box");

    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];
    let foundLigoTrack = false;

    for (const t of index.tracks) {
        if (t.handlerType !== "meta") continue;
        if (!index.moovView) continue;

        const samples = readSampleTable(index.moovView, t.trakBox);
        if (!samples || samples.length === 0) continue;

        const firstSize = samples[0]!.size;
        if (firstSize < 64 || firstSize > 1024) continue;

        // Probe with a single sample (random path - just one slice() call
        // regardless of measured sliceCost). Bulk load uses the adaptive
        // strategy via index.sliceCost.
        const firstBuf = (await loadSamples(file.file, [samples[0]!]))[0]!;
        const probeOffset = findLigoGpsChunkOffset(new Uint8Array(firstBuf));
        if (probeOffset === null) continue;

        foundLigoTrack = true;
        // Bail before the bulk read: an unsettled carrier costs one probe
        // sample, not the whole track.
        if (t.sampleFormat !== FUZZ_SETTLED_SAMPLE_FORMAT) {
            skipped.push({
                line: 1,
                raw: `<ligogps track, sample format ${t.sampleFormat ?? "unknown"}>`,
                reason: "unfuzz state unsettled for this carrier - track not claimed",
            });
            continue;
        }

        const sampleBuffers = await loadSamples(file.file, samples, index.sliceCost);
        for (let i = 0; i < sampleBuffers.length; i++) {
            const view = new Uint8Array(sampleBuffers[i]!);
            const chunkOff = findLigoGpsChunkOffset(view);
            if (chunkOff === null) {
                skipped.push({
                    line: i + 1,
                    raw: `<ligogps sample ${i + 1}: no magic>`,
                    reason: "no LIGOGPSINFO magic",
                });
                continue;
            }
            // 8-byte chunk header + up to 0x84 bytes of encrypted body -
            // decryptLigoGps requires 8 + num total, so capping at 0x84 would
            // reject any body longer than 0x7c even when the bytes are there.
            const chunk = view.subarray(chunkOff, Math.min(view.length, chunkOff + 8 + 0x84));
            const decrypted = decryptLigoGps(chunk);
            if (!decrypted) {
                skipped.push({
                    line: i + 1,
                    raw: `<ligogps sample ${i + 1}: decrypt failed>`,
                    reason: "DecryptLigoGPS returned null",
                });
                continue;
            }
            const text = bytesToAscii(decrypted);
            const record = parseLigoGpsRecord(text, file.file.name);
            if (record) {
                records.push(record);
            } else {
                skipped.push({
                    line: i + 1,
                    raw: `<ligogps sample ${i + 1}: parse failed: ${JSON.stringify(text.slice(0, 80))}>`,
                    reason: "regex did not match decrypted text",
                });
            }
        }
        break;
    }

    if (!foundLigoTrack) {
        throw new WrongFormatError("no LigoGPS track in MP4");
    }
    return { records, skipped };
}

/** One char per byte; bytes >= 0x80 become "." while control bytes stay, so the
 *  4-byte binary record counter keeps the width REC_RX skips. */
export function bytesToAscii(buf: Uint8Array): string {
    let out = "";
    for (let i = 0; i < buf.length; i++) {
        const b = buf[i]!;
        out += b < 0x80 ? String.fromCharCode(b) : ".";
    }
    return out;
}

// ---------------------------------------------------------------------------
// File-trailer carrier (Beferich J18 and relatives).
//
// After the last top-level box the firmware appends a zero-padded trailer
// holding TWO LIGOGPSINFO directories: an encrypted twin ('####' chunks;
// fuzz state unsettled for this carrier, deliberately not claimed - see
// FUZZ_SETTLED_SAMPLE_FORMAT) followed by a plaintext table of the same
// records:
//
//   "SKIP" "LIGOGPSINFO" <5 spaces> <u32 BE record count>
//   then per record a 0x84-byte slot: u32 BE 1-based index + ASCII text,
//   NUL-padded; a '####' + u32 BE block-size pair terminates the table.
//
// The plaintext records match ExifTool's "non-encrypted format written by
// Redtiger F9 4K" branch (LigoGPS.pm ProcessLigoGPS -> ParseLigoGPS flags
// 0x03): not fuzzed, speed already km/h. The zero pad before the first
// directory varies per file (24..3408 bytes observed) - scan for the magic,
// never assume a fixed offset.

/** Probe window from the trailer start for the marker check. The magic sits
 *  past a variable zero pad (<=3.4 KB observed); 64 KB is cheap margin. */
export const LIGO_TRAILER_PROBE_BYTES = 64 * 1024;

/** Full-trailer read cap. A 1 Hz table costs ~16 KB/min including the
 *  encrypted twin - 8 MB covers many hours of records. */
const LIGO_TRAILER_READ_CAP = 8 * 1024 * 1024;

const LIGO_SLOT_SIZE = 0x84;
/** Records start at magic + 0x14: 11 magic bytes + 9 header bytes (pad or
 *  spaces + count, depending on the directory flavor). */
const LIGO_DIR_HEADER = 0x14;
/** Sanity cap on the declared record count (24 h at 1 Hz). */
const LIGO_MAX_RECORDS = 86400;

function findLigoMagicOffsets(payload: Uint8Array): number[] {
    const hits: number[] = [];
    let from = 0;
    while (from < payload.length) {
        const offset = findByteSequence(payload, LIGO_MAGIC_BYTES, from);
        if (offset < 0) break;
        hits.push(offset);
        from = offset + LIGO_MAGIC_BYTES.length;
    }
    return hits;
}

/** Whether the buffer holds a LIGOGPSINFO literal - the trailer marker check
 *  over the probe window read from `lastTopLevelBoxEnd`. */
export function hasLigoTrailerMarker(head: Uint8Array): boolean {
    return findByteSequence(head, LIGO_MAGIC_BYTES) >= 0;
}

function isHashMarker(buf: Uint8Array, offset: number): boolean {
    return (
        offset + 4 <= buf.length &&
        buf[offset] === 0x23 &&
        buf[offset + 1] === 0x23 &&
        buf[offset + 2] === 0x23 &&
        buf[offset + 3] === 0x23
    );
}

function readU32BE(buf: Uint8Array, offset: number): number {
    if (offset + 4 > buf.length) return 0;
    return ((buf[offset]! << 24) | (buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!) >>> 0;
}

/**
 * Extracts GpsRecords from the plaintext LIGOGPSINFO table in the file
 * trailer. Reads the region past the last top-level box (capped), walks every
 * LIGOGPSINFO directory in it, skips the encrypted twin, and regex-parses the
 * plaintext slots. Throws WrongFormatError when the region carries no
 * LIGOGPSINFO directory at all; an encrypted-only trailer returns zero
 * records with a skipped entry (recognized but unclaimed, the ssmd-carrier
 * precedent).
 */
export async function parseLigoGpsTrailer(file: VendorFile, index: Mp4Index): Promise<ParsedRecords> {
    const start = index.lastTopLevelBoxEnd;
    if (start === null || start >= index.fileSize) {
        throw new WrongFormatError("no trailing region after last top-level box");
    }
    const end = Math.min(index.fileSize, start + LIGO_TRAILER_READ_CAP);
    const buf = new Uint8Array(await file.file.slice(start, end).arrayBuffer());

    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];
    let foundDirectory = false;

    for (const magicOff of findLigoMagicOffsets(buf)) {
        const recordsStart = magicOff + LIGO_DIR_HEADER;
        // The '####' check needs 4 bytes; a full slot is required only for
        // the plaintext walk below (a truncated encrypted directory must
        // still be recognized, or the file misreads as "no ligogps trailer").
        if (recordsStart + 4 > buf.length) continue;

        if (isHashMarker(buf, recordsStart)) {
            // Encrypted twin. The plaintext table carries the same records,
            // and the unfuzz question (see FUZZ_SETTLED_SAMPLE_FORMAT) stays
            // open for this carrier - recognize, do not claim.
            foundDirectory = true;
            skipped.push({
                line: 1,
                raw: "<ligogps trailer: encrypted directory>",
                reason: "encrypted trailer directory not claimed - the plaintext twin carries the data",
            });
            continue;
        }

        // Plaintext table: the u32 BE right before the records is the count.
        // Trust it only as an upper bound - the '####' terminator and the
        // buffer end also stop the walk (one real file stores 179 slots with
        // indices jumping to 180: a second with no GPS write).
        foundDirectory = true;
        if (recordsStart + LIGO_SLOT_SIZE > buf.length) continue;
        const declaredCount = readU32BE(buf, magicOff + 0x10);
        const regionSlots = Math.floor((buf.length - recordsStart) / LIGO_SLOT_SIZE);
        const maxSlots =
            declaredCount >= 1 && declaredCount <= LIGO_MAX_RECORDS
                ? Math.min(declaredCount, regionSlots)
                : regionSlots;

        for (let i = 0; i < maxSlots; i++) {
            const slotStart = recordsStart + i * LIGO_SLOT_SIZE;
            if (isHashMarker(buf, slotStart)) break; // table terminator
            const slot = buf.subarray(slotStart, slotStart + LIGO_SLOT_SIZE);
            // Blank (all-zero) slots are a normal firmware gap, not an error.
            if (slot.every((b) => b === 0)) continue;
            const text = bytesToAscii(slot).replace(/\0+$/, "");
            const record = parseLigoGpsRecord(text, file.file.name, { speedUnit: "kmh" });
            if (record) {
                records.push(record);
            } else {
                skipped.push({
                    line: i + 1,
                    raw: `<ligogps trailer slot ${i + 1}: ${JSON.stringify(text.slice(0, 80))}>`,
                    reason: "regex did not match plaintext slot",
                });
            }
        }
    }

    if (!foundDirectory) {
        throw new WrongFormatError("no ligogps trailer directory");
    }
    return { records, skipped };
}

// ---------------------------------------------------------------------------
// MPEG-TS file-trailer carrier.
//
// The firmware writes the encrypted LigoGPS stream in-file (private PES on
// its own PID, 1 Hz, classic LIGOGPSINFO + '####' chunks - unclaimed, the
// unfuzz question of FUZZ_SETTLED_SAMPLE_FORMAT applies) and appends a
// plaintext twin table to the END of the .ts, after the last whole 188-byte
// packet. Only the plaintext table is claimed. Structure and detection live
// in src/ts-trailer.ts (shared with the AV-side clamp that keeps mediabunny
// from choking on the same bytes); the slot layout is the Beferich trailer's:
// 132-byte slots of u32 index + ASCII record, speed already km/h.
//
// The record datetime is the camera's local clock (it tracks the filename
// stamp to the second on the real corpus) - parsed as UTC here, shifted by
// the orchestrator via estimateTzByFingerprint, the juscar-ts convention.

/**
 * Extracts GpsRecords from the plaintext trailer of a MPEG-TS file. Throws
 * WrongFormatError when the file carries no trailer (the marker() result went
 * stale or the caller skipped it); a structurally valid trailer whose slots
 * do not parse returns zero records with skipped entries.
 */
export async function parseLigoGpsTsTrailer(file: VendorFile): Promise<ParsedRecords> {
    const trailer = await findTsGpsTrailer(file.file);
    if (!trailer) throw new WrongFormatError("no ligogps trailer on this ts file");
    const buf = new Uint8Array(
        await file.file.slice(trailer.cleanLength, trailer.cleanLength + trailer.trailerLength).arrayBuffer(),
    );

    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];
    const slotsOffset = trailer.unindexedRecordsOffset ?? TS_TRAILER_SLOTS_OFFSET;
    for (let off = slotsOffset; off + LIGO_SLOT_SIZE <= buf.length; off += LIGO_SLOT_SIZE) {
        if (isTsGpsTrailerTerminator(buf, off)) break; // known marker + length copy terminates the table
        const slot = buf.subarray(off, off + LIGO_SLOT_SIZE);
        // Blank (all-zero) slots are a normal firmware gap, not an error.
        if (slot.every((b) => b === 0)) continue;
        const text = bytesToAscii(slot).replace(/\0+$/, "");
        // The paired lowercase-skip table starts directly with the timestamp.
        const indexedText = trailer.unindexedRecordsOffset === undefined ? text : `\0\0\0\0${text}`;
        const record = parseLigoGpsRecord(indexedText, file.file.name, {
            speedUnit: "kmh",
            courseLayout: "after-accel",
        });
        if (record) {
            records.push(record);
        } else {
            const slotIndex = (off - slotsOffset) / LIGO_SLOT_SIZE + 1;
            skipped.push({
                line: slotIndex,
                raw: `<ligogps ts trailer slot ${slotIndex}: ${JSON.stringify(text.slice(0, 80))}>`,
                reason: "regex did not match plaintext slot",
            });
        }
    }
    return { records, skipped };
}

// ---------------------------------------------------------------------------
// Plaintext TXT log next to a .TS.
//
// One line per second, the deciphered text of the enciphered TS PES without
// its 4-byte counter and WITHOUT the fuzzing: on the real sample every line
// equals the unfuzzed PES record of the same second. Layout and evidence:
// docs/format-ligogps-ts-pes.md. Times are the camera's local clock, parsed as
// UTC like the other LigoGPS carriers.

/** Options shared by the TXT log and the enciphered PES it mirrors. */
export const LIGO_TS_DIALECT_OPTIONS: LigoRecordOptions = { speedUnit: "kmh", courseLayout: "after-speed" };

/**
 * Parses a LigoGPS TXT log into records bound to `mp4Filename`. Lines without
 * a fix ('?' hemisphere) or at 0,0 are dropped. Throws WrongFormatError when
 * no line is a LigoGPS record, so a same-name .txt of another kind stays
 * unclaimed.
 */
export function parseLigoGpsTextLog(text: string, mp4Filename: string): GpsRecord[] {
    const records: GpsRecord[] = [];
    let hasRecordShape = false;
    for (const line of text.split(/\r?\n/)) {
        if (!REC_RX.test(`\0\0\0\0${line}`)) continue;
        hasRecordShape = true;
        const record = parseLigoGpsRecord(`\0\0\0\0${line}`, mp4Filename, LIGO_TS_DIALECT_OPTIONS);
        if (record && (record.lat !== 0 || record.lon !== 0)) records.push(record);
    }
    if (!hasRecordShape) throw new WrongFormatError("no ligogps record lines in text log");
    removeGravityBaselineInUnknownUnits(records);
    return records;
}

export const _internal = { decryptLigoGps, parseLigoGpsRecord, findLigoGpsChunkOffset, findLigoMagicOffsets };

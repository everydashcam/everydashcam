// GPS dialects carried by a private PES in an MPEG-TS dashcam
// recording. The binary layouts below come from ExifTool's M2TS.pm
// ProcessTSPacket branches (v13.55), without real-sample validation:
//
//   - INNOVV (motorcycle cams), M2TS.pm:376-401. The RECORD is byte-identical
//     to the one the MP4 freeGPS path already decodes, so `parseInnovvRecord`
//     is reused rather than rewritten - only the carrier is new.
//   - DOD LS600W, M2TS.pm:511-537. 32-byte big-endian records from body offset
//     32, decimal-degree int32 coordinates.
//
// Viidure plaintext is validated against real INNOVV N2 recordings.
// Reuse one carrier scan because reading the media dominates parsing cost.

import { type GpsRecord, type ParsedRecords, type SkippedLine, type VendorFile, WrongFormatError } from "../types.js";
import { hasViidureBody, parseViidureBody } from "./viidure.js";
import { utcMillisecondsFromParts } from "./calendar.js";
import { hasInnovvRecordSignature, parseInnovvRecord } from "./freegps.js";
import { collectPesBody, createTsPesScanPlanner, pesBodyExtent, TS_SIZE, TS_SYNC } from "./ts-walk.js";

type Dialect = "innovv" | "dod" | "viidure";

// Bound on how much of one PES is reassembled. These dialects pack records into
// a PES of a few hundred bytes; this only stops a corrupt length field from
// asking for megabytes.
const MAX_PES_BODY = 8 * 1024;

// Same early-out as novatek-ts: a gate-passing foreign TS must not be scanned
// to EOF before it is rejected.
const SIGNATURE_LIMIT_BYTES = 64 * 1024 * 1024;

const INNOVV_RECORD_SIZE = 32;

// DOD records start here; bytes [0..32) are an unidentified header.
const DOD_RECORD_START = 32;
const DOD_RECORD_SIZE = 32;
// '$S' - the per-record magic, and the only thing gating this dialect.
const DOD_MAGIC = 0x2453;

/** INNOVV: the body opens with a fix record or the `V00\0` void marker. */
function hasInnovvPesBody(body: Uint8Array): boolean {
    if (body.length < INNOVV_RECORD_SIZE) return false;
    if (isInnovvVoidMarker(body, 0)) return true;
    return hasInnovvRecordSignature(new DataView(body.buffer, body.byteOffset, body.byteLength), 0);
}

/** `V00\0` - a record slot with no fix. Upstream skips its coordinates. */
function isInnovvVoidMarker(body: Uint8Array, at: number): boolean {
    return body[at] === 0x56 && body[at + 1] === 0x30 && body[at + 2] === 0x30 && body[at + 3] === 0;
}

/**
 * Decodes every INNOVV record in a PES body. The i32 triple at +20 is dropped
 * for the same reason as in the MP4 path: upstream reports it verbatim with
 * neither scale nor axis mapping.
 */
function decodeInnovvBody(body: Uint8Array, mp4Filename: string): GpsRecord[] {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const records: GpsRecord[] = [];
    for (let at = 0; at + INNOVV_RECORD_SIZE <= body.length; at += INNOVV_RECORD_SIZE) {
        if (isInnovvVoidMarker(body, at)) continue;
        if (!hasInnovvRecordSignature(view, at)) break; // padding past the last record
        const record = parseInnovvRecord(view, at, mp4Filename);
        if (record) records.push(record);
    }
    return records;
}

/** DOD: `$S` at body offset 32 is the whole gate upstream applies. */
function hasDodPesBody(body: Uint8Array): boolean {
    if (body.length < DOD_RECORD_START + DOD_RECORD_SIZE) return false;
    return u16be(body, DOD_RECORD_START) === DOD_MAGIC;
}

/**
 * Decodes every DOD LS600W record in a PES body.
 *
 * Upstream first hunts for the earliest record because the PES holds a CYCLIC
 * list, then walks it with wraparound. That is skipped here: every record
 * carries a full UTC stamp, and the trip layer sorts globally, so reading them
 * in stored order and letting the sort undo the rotation reaches the same
 * result without transliterating a walk whose own `$S` check reads the wrong
 * index.
 */
function decodeDodBody(body: Uint8Array, mp4Filename: string, skipped: SkippedLine[]): GpsRecord[] {
    const records: GpsRecord[] = [];
    for (let at = DOD_RECORD_START; at + DOD_RECORD_SIZE <= body.length; at += DOD_RECORD_SIZE) {
        if (u16be(body, at) !== DOD_MAGIC) break;

        const year = u16be(body, at + 6);
        const month = body[at + 8]!;
        const day = body[at + 9]!;
        const hour = body[at + 10]!;
        const minute = body[at + 11]!;
        // Stored in tenths; GpsRecord is whole seconds, so the fraction is lost.
        const second = Math.floor(u16be(body, at + 12) / 10);
        if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) {
            skipped.push({ line: records.length + 1, raw: `${year}-${month}-${day}`, reason: "date out of range" });
            continue;
        }
        if (hour > 23 || minute > 59 || second > 59) {
            skipped.push({ line: records.length + 1, raw: `${hour}:${minute}:${second}`, reason: "time out of range" });
            continue;
        }

        // Signed, deliberately: upstream unpacks these as UNSIGNED 32-bit,
        // which turns any southern or western coordinate into ~429 degrees.
        // Reading them signed is the only interpretation that can represent the
        // hemispheres the format has no separate flags for.
        const lat = i32be(body, at + 15) * 1e-7;
        const lon = i32be(body, at + 19) * 1e-7;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            skipped.push({ line: records.length + 1, raw: `${lat}/${lon}`, reason: "coordinate out of range" });
            continue;
        }
        if (lat === 0 && lon === 0) continue;

        // Course is a SIGNED heading in [-180,180) x100: 0x8000..0xffff are
        // negative angles, which +36000 (= +360 deg) normalizes into [0,360).
        // Read unsigned they would land at 327.68..655.35 deg.
        const rawTrack = u16be(body, at + 4);
        const track = (rawTrack >= 0x8000 ? rawTrack - (65536 - 36000) : rawTrack) / 100;

        const timestampMs = utcMillisecondsFromParts(year, month, day, hour, minute, second);
        if (timestampMs === null) {
            skipped.push({ line: records.length + 1, raw: `${year}-${month}-${day}`, reason: "date out of range" });
            continue;
        }

        records.push({
            unixSeconds: timestampMs / 1000,
            active: true,
            lat,
            lon,
            bearingDeg: track,
            // Stored as metres per 100 s (upstream's own note), i.e. /100 for m/s.
            speedMs: u16be(body, at + 2) / 100,
            // Upstream notes 10 bytes after the last record that "look like" a
            // single 3-axis reading - one guess, no scale, not decoded.
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename,
        });
    }
    return records;
}

function u16be(bytes: Uint8Array, off: number): number {
    return (bytes[off]! << 8) | bytes[off + 1]!;
}

function i32be(bytes: Uint8Array, off: number): number {
    return (bytes[off]! << 24) | (bytes[off + 1]! << 16) | (bytes[off + 2]! << 8) | bytes[off + 3]! | 0;
}

/**
 * Content probe over an in-memory buffer: returns the dialect and PID of the
 * first PES that matches, or null. Used by the primitive's marker and to lock
 * the PID before the full scan.
 */
export function findTsPesGpsStream(bytes: Uint8Array): { pid: number; dialect: Dialect } | null {
    if (bytes.length < TS_SIZE || bytes[0] !== TS_SYNC) return null;
    const limit = bytes.length - TS_SIZE;
    for (let off = 0; off <= limit; off += TS_SIZE) {
        if (bytes[off] !== TS_SYNC) return null;
        const b1 = bytes[off + 1]!;
        if ((b1 & 0x40) === 0) continue; // PUSI=0
        const pid = ((b1 & 0x1f) << 8) | bytes[off + 2]!;
        const body = bodyAt(bytes, off, pid);
        if (!body) continue;
        if (hasInnovvPesBody(body)) return { pid, dialect: "innovv" };
        if (hasDodPesBody(body)) return { pid, dialect: "dod" };
        if (hasViidureBody(body)) return { pid, dialect: "viidure" };
    }
    return null;
}

/** Reassembled PES body of the packet at `off`, or null when unavailable. */
function bodyAt(buf: Uint8Array, off: number, pid: number): Uint8Array | null {
    const extent = pesBodyExtent(buf, off);
    if (extent === null) return null;
    const assembled = collectPesBody(buf, off, extent.bodyOff, pid, Math.min(extent.bodyLen, MAX_PES_BODY));
    if (typeof assembled !== "object") return null;
    return assembled.body;
}

/**
 * Extracts GPS from a supported private PES in a TS recording: one pass in file
 * order over the PES-start packets of the GPS PID, reading bounded windows
 * around each predicted PES once the cadence is known (see ts-walk.ts).
 *
 * Throws WrongFormatError when nothing matches. A foreign TS must not be
 * scanned to EOF before rejection.
 */
export async function extractTsPesGps(
    file: VendorFile,
    headerBytes?: Uint8Array | null,
    signal?: AbortSignal,
): Promise<ParsedRecords> {
    const seed = headerBytes ? findTsPesGpsStream(headerBytes) : null;
    let pid: number | null = seed?.pid ?? null;
    let dialect: Dialect | null = seed?.dialect ?? null;

    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];

    // The planner serves the buffers: the marker probe first, linear chunks
    // until the PID is locked, then predicted windows around each next PES
    // (see ts-walk.ts). A packet or PES body cut at a buffer end is re-served
    // at the start of the next buffer, so no tail is carried here.
    const planner = createTsPesScanPlanner(file.file, { pid, prefix: headerBytes, signal });
    let range = await planner.next(0);
    while (range !== null) {
        if (signal?.aborted) throw new DOMException("ts-pes-gps scan aborted", "AbortError");
        const { start, buf } = range;
        let off = 0;
        let desyncRun = 0;
        while (off + TS_SIZE <= buf.length) {
            if (buf[off] !== TS_SYNC) {
                desyncRun++;
                off += desyncRun >= TS_SIZE ? TS_SIZE : 1;
                continue;
            }
            desyncRun = 0;
            const b1 = buf[off + 1]!;
            const packetPid = ((b1 & 0x1f) << 8) | buf[off + 2]!;
            if ((pid !== null && packetPid !== pid) || (b1 & 0x40) === 0) {
                off += TS_SIZE;
                continue;
            }

            const extent = pesBodyExtent(buf, off);
            if (extent === null) {
                off += TS_SIZE;
                continue;
            }
            const assembled = collectPesBody(
                buf,
                off,
                extent.bodyOff,
                packetPid,
                Math.min(extent.bodyLen, MAX_PES_BODY),
            );
            // Ran out of buffer mid-PES: re-try this packet with the next buffer.
            if (assembled === "incomplete") break;
            if (assembled === "unavailable") {
                off += TS_SIZE;
                continue;
            }

            const body = assembled.body;
            const matched =
                dialect ??
                (hasInnovvPesBody(body)
                    ? "innovv"
                    : hasDodPesBody(body)
                      ? "dod"
                      : hasViidureBody(body)
                        ? "viidure"
                        : null);
            if (matched === "innovv" && hasInnovvPesBody(body)) {
                pid = packetPid;
                planner.setPid(packetPid);
                dialect = "innovv";
                records.push(...decodeInnovvBody(body, file.file.name));
            } else if (matched === "dod" && hasDodPesBody(body)) {
                pid = packetPid;
                planner.setPid(packetPid);
                dialect = "dod";
                records.push(...decodeDodBody(body, file.file.name, skipped));
            } else if (matched === "viidure" && hasViidureBody(body)) {
                pid = packetPid;
                planner.setPid(packetPid);
                dialect = "viidure";
                const record = parseViidureBody(body, file.file.name);
                if (record) records.push(record);
                else
                    skipped.push({
                        line: records.length + skipped.length + 1,
                        raw: "",
                        reason: "invalid viidure gps record",
                    });
            }
            off += TS_SIZE;
        }

        // Bound on bytes covered, like the chunk end of a plain linear pass.
        if (pid === null && start + buf.length >= SIGNATURE_LIMIT_BYTES) {
            throw new WrongFormatError(
                `ts-pes-gps: no supported gps pes signature in the leading ${SIGNATURE_LIMIT_BYTES >> 20} mib`,
            );
        }
        range = await planner.next(start + off);
    }

    if (records.length === 0) throw new WrongFormatError("ts-pes-gps: no gps records found in ts stream");

    // INNOVV carries no clock of any kind (parseInnovvRecord already flags
    // every record); DOD and Viidure stamp records with UTC.
    return { records, skipped };
}

import { matchesBytesAt } from "./byte-search.js";
// LigoGPS-TS extractor for Juscar dashcams (and any look-alike with a
// plaintext LigoGPS stream embedded in an MPEG-TS private-data PES).
//
// Stream layout (verified on private/incoming/Juscar):
//   - PMT advertises a stream with stream_type=0x06 (PES private_data),
//     PID 0x300 in the sample. We auto-detect the PID via headerBytes probe
//     so different firmware/PMT layouts still work without registry changes.
//   - Each GPS PES carries stream_id 0xbf (private_stream_2 - no extended
//     PES header), PES_packet_length = 152 bytes. Together with the 6-byte
//     fixed PES header that is 158 bytes - fits inside one 188-byte TS
//     packet, so PES never spans across TS packets.
//   - Records alternate ENC/PLN/ENC/PLN at 1 Hz, both forms encode the same
//     point at the same instant. We parse only the plaintext form: it is
//     richer (km/h, 3-axis accel, course, altitude), needs no decrypt, and
//     fully covers the GPS record contract.
//
// Plaintext PES body (152 bytes, null-padded):
//   "<mode>:YYYY/MM/DD HH:MM:SS N:<lat> [WE]:<lon> <speed> km/h
//    x:<ax> y:<ay> z:<az> A:<bearing> H:<altitude>\0\0..."
//
// where <mode> is "normal" on the only sample we have. Other modes
// ("event"/"parking") are plausible based on the SD-card layout (event/
// folder) but unconfirmed - we treat the prefix as informational only.
//
// Performance:
//   - One pass over the file in file order, driven by the predicted-offset
//     planner in ts-walk.ts (bounded windows around each expected PES, exact
//     by continuity-counter verification). Variant rear=front dedup is
//     handled OUTSIDE this extractor (post-process in the dispatcher) - this
//     function stays per-file and predictable.
//   - Tight inner loop: 188-byte stride, byte-level comparisons, no PES
//     reassembly. Typical 358 MB file: ~80 ms CPU, IO-bound on disk.

import type { GpsRecord, ParsedRecords, SkippedLine, VendorFile } from "../types.js";
import { KMH_TO_MS, WrongFormatError } from "../types.js";
import { isDashcamYear, utcMillisecondsFromParts } from "./calendar.js";
import type { Mp4Index } from "./mp4-index.js";
import {
    pesStartPid,
    createTsPesScanPlanner,
    walkTsPackets,
    pesBodyExtent,
    pesBodyOffset,
    TS_SIZE,
} from "./ts-walk.js";

// PID seen in our only sample. Used as a fallback if the probe could not
// find the real PID (e.g. on a heavily truncated file).
const DEFAULT_GPS_PID = 0x300;

// LIGOGPSINFO in ASCII - the signature for the probe.
const LIGO_MAGIC = [0x4c, 0x49, 0x47, 0x4f, 0x47, 0x50, 0x53, 0x49, 0x4e, 0x46, 0x4f];
// "LIGOGPSINFO".length = 11.

// Plaintext format. We capture mode (for future event/parking), date-time,
// coordinates with a hemisphere sign, speed in km/h, 3-axis accel in g,
// bearing (A:) and altitude (H:). km/h is an explicit unit - do not confuse
// it with knots as in the encrypted LigoGPS.
const PLAINTEXT_RX =
    /^([a-z]+):(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([NS]):(-?\d+\.\d+) ([EW]):(-?\d+\.\d+) (-?\d+\.\d+) km\/h x:(-?\d+\.\d+) y:(-?\d+\.\d+) z:(-?\d+\.\d+) A:(-?\d+\.\d+) H:(-?\d+\.\d+)/;

/**
 * Extracts GPS records from the MPEG-TS Juscar format.
 *
 * Contract: throws WrongFormatError if the first 16 MB of headerBytes carry
 * no Juscar signature (LIGOGPSINFO in PES private_data) or no plaintext PES
 * could be parsed.
 */
export async function extractJuscarTsGps(file: VendorFile, index: Mp4Index): Promise<ParsedRecords> {
    // Cheap early-exit: the marker is already computed by Mp4Index in the
    // headerBytes phase. Without it there is guaranteed nothing to parse - we
    // do not spend IO scanning the whole file.
    if (!index.hasLigoGpsMarker) {
        throw new WrongFormatError("juscar: no LIGOGPSINFO marker in headerBytes");
    }

    // The probe finds the GPS stream PID from headerBytes. headerBytes is
    // guaranteed set when hasLigoGpsMarker === true (probeMarkers() sets them
    // together). Without a hard-coded 0x300 we survive firmware with a
    // different PMT layout.
    const gpsPid = index.headerBytes ? (findGpsPidByProbe(index.headerBytes) ?? DEFAULT_GPS_PID) : DEFAULT_GPS_PID;

    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];
    let recordIdx = 0;

    // The planner serves the buffers: the marker probe first, then predicted
    // windows around each next PES once the 1 Hz cadence is known (see
    // ts-walk.ts). A packet split at a buffer end is re-served at the start of
    // the next buffer, so no tail is carried here.
    const planner = createTsPesScanPlanner(file.file, { pid: gpsPid, prefix: index.headerBytes });
    let range = await planner.next(0);
    while (range !== null) {
        const { start, buf } = range;
        const packets = walkTsPackets(buf, start + buf.length >= file.file.size);
        let packet = packets.next();
        for (; !packet.done; packet = packets.next()) {
            const off = packet.value;
            // This dialect fits in one PES-start packet; continuations carry no records.
            if (pesStartPid(buf, off) !== gpsPid) {
                continue;
            }
            const extent = pesBodyExtent(buf, off);
            if (extent === null) {
                continue;
            }
            const { bodyOff } = extent;
            // One PES fits one packet here (see the header), so the body never
            // reaches past the packet - clamp instead of reassembling.
            const tsPacketEnd = off + TS_SIZE;
            if (bodyOff >= tsPacketEnd) {
                continue;
            }
            const bodyEnd = Math.min(bodyOff + extent.bodyLen, tsPacketEnd);

            // The ENC variant starts with "LIGOGPSINFO" - its data is
            // duplicated in plaintext, so we parse only the plaintext form.
            if (buf[bodyOff] === 0x4c /* 'L' */) {
                continue;
            }
            // Plaintext: <lowercase letters>:<digit>...
            // Cheap pre-filter: the first byte is a lowercase ASCII letter.
            const first = buf[bodyOff]!;
            if (first < 0x61 /* 'a' */ || first > 0x7a /* 'z' */) {
                continue;
            }

            recordIdx++;
            const text = bodyToAscii(buf, bodyOff, bodyEnd);
            const rec = parsePlaintextLine(text, file.file.name);
            if (rec) {
                records.push(rec);
            } else {
                skipped.push({
                    line: recordIdx,
                    raw: text.slice(0, 100),
                    reason: "juscar plaintext regex did not match",
                });
            }
        }

        range = await planner.next(start + packet.value);
    }

    if (records.length === 0) {
        throw new WrongFormatError("juscar: no plaintext LigoGPS records extracted");
    }
    return { records, skipped };
}

/**
 * Probe: scans headerBytes for the first TS packet with PUSI=1 and a PES body
 * starting with "LIGOGPSINFO" (ENC variant) or with a lowercase prefix plus
 * ":" (PLN variant). The PID of such a packet is returned as the GPS stream PID.
 *
 * Why: a hard-coded 0x300 is fragile (a different firmware/model may use any
 * PID). PSI parsing (PAT + PMT with stream_type=0x06) would be more correct
 * but costs more code; this probe identifies our stream unambiguously by
 * content, not by type.
 */
function findGpsPidByProbe(headerBytes: Uint8Array): number | null {
    for (const off of walkTsPackets(headerBytes)) {
        const pid = pesStartPid(headerBytes, off);
        if (pid === null) continue;
        // Offset only: the probe reads a fixed-size signature, so an odd or
        // absent PES_packet_length must not cost it the stream.
        const bodyOff = pesBodyOffset(headerBytes, off);
        if (bodyOff === null) continue;
        const tsEnd = off + TS_SIZE;
        if (bodyOff + 11 > tsEnd) continue;

        if (matchesBytesAt(headerBytes, bodyOff, LIGO_MAGIC)) {
            return pid;
        }
        // Plaintext: first byte is a lowercase ASCII letter, then up to 8
        // [a-z] characters, then ':'. This is a very narrow filter, false
        // positives on video/audio PES should not happen.
        const first = headerBytes[bodyOff]!;
        if (first >= 0x61 && first <= 0x7a) {
            let i = bodyOff + 1;
            const stop = Math.min(bodyOff + 12, tsEnd);
            while (i < stop) {
                const c = headerBytes[i]!;
                if (c === 0x3a /* ':' */) {
                    if (i > bodyOff + 1) return pid;
                    break;
                }
                if (c < 0x61 || c > 0x7a) break;
                i++;
            }
        }
    }
    return null;
}

/** PES body as ASCII up to the first NUL or to the end of the body. */
function bodyToAscii(buf: Uint8Array, start: number, end: number): string {
    let stop = start;
    while (stop < end && buf[stop] !== 0) stop++;
    let out = "";
    for (let i = start; i < stop; i++) {
        const b = buf[i]!;
        // Printable ASCII or space. Everything else maps to "." - a guard
        // against garbage.
        out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
    }
    return out;
}

/**
 * Parses a single Juscar plaintext line into a GpsRecord. unixSeconds is
 * computed from the line's date/time fields as UTC; the upper level shifts it
 * to the camera's local TZ when needed via estimateTzByFingerprint (trips.ts).
 *
 * Returns null if the regex did not match or fields are invalid.
 */
function parsePlaintextLine(text: string, mp4Filename: string): GpsRecord | null {
    const m = text.match(PLAINTEXT_RX);
    if (!m) return null;

    // Group order: [_, mode, Y, Mo, D, H, Mi, S, NS, lat, EW, lon, kmh, x, y, z, A, H]
    const year = Number(m[2]);
    const month = Number(m[3]);
    const day = Number(m[4]);
    const hour = Number(m[5]);
    const minute = Number(m[6]);
    const second = Number(m[7]);
    if (!isDashcamYear(year)) return null;
    const timestampMs = utcMillisecondsFromParts(year, month, day, hour, minute, second);
    if (timestampMs === null) return null;

    const nsRef = m[8]!;
    let lat = Number(m[9]);
    const ewRef = m[10]!;
    let lon = Number(m[11]);
    const kmh = Number(m[12]);
    const ax = Number(m[13]);
    const ay = Number(m[14]);
    const az = Number(m[15]);
    const bearing = Number(m[16]);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(kmh)) return null;
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) return null;
    if (!Number.isFinite(bearing)) return null;

    // The `!== 0` condition guards against negative zero: for coordinates
    // exactly at zero (prime meridian / equator) a sign flip turns +0 into -0,
    // which behaves surprisingly in JSON and snapshot comparisons.
    if (nsRef === "S" && lat !== 0) lat = -lat;
    if (ewRef === "W" && lon !== 0) lon = -lon;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

    // bearing in the source may be [0, 360); normalize in case of 360.0.
    const bearingDeg = ((bearing % 360) + 360) % 360;

    return {
        unixSeconds: timestampMs / 1000,
        active: true,
        lat,
        lon,
        bearingDeg,
        speedMs: kmh * KMH_TO_MS,
        // Accel in g, gravity-removed: x/y/z in Juscar plaintext is already at
        // zero at rest - so the vendor removes the gravity bias on-chip. The
        // GpsRecord contract (see types.ts) expects exactly this.
        accelXg: ax,
        accelYg: ay,
        accelZg: az,
        mp4Filename,
    };
}

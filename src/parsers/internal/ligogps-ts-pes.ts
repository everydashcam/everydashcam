import { matchesBytesAt } from "./byte-search.js";
// Enciphered, fuzzed LigoGPS in an MPEG-TS private PES. Layout and evidence:
// docs/format-ligogps-ts-pes.md.
//
// The PMT declares the GPS PID with stream_type 0x82 (DTS in ATSC terms - the
// AV path masks it, see src/ts-program-map.ts). Each PES carries one 1 Hz
// record: the LIGOGPSINFO chunk header, then a '####' chunk that deciphers
// with the ExifTool algorithm into "<counter> YYYY/MM/DD hh:mm:ss N:<lat>
// E:<lon> <speed> km/h <course> <alt> <sats> x: y: z:" with FUZZED
// coordinates. The camera writes the same records unfuzzed into a same-name
// TXT log (parseLigoGpsTextLog), which is how the fuzz scale was settled.
//
// The claim is deliberately narrow: stream type AND the full chunk header must
// match the sample byte for byte. The header byte ExifTool keys fuzzing on is
// already known to misjudge another carrier (FUZZ_SETTLED_SAMPLE_FORMAT in
// ligogps.ts), and a wrong scale yields a plausible track hundreds of
// kilometres off, so a near miss stays unclaimed.

import { readFirstProgramMap } from "../../ts-program-map.js";
import type { GpsRecord, ParsedRecords, SkippedLine, VendorFile } from "../types.js";
import { WrongFormatError } from "../types.js";
import { removeGravityBaselineInUnknownUnits } from "./accel-baseline.js";
import {
    bytesToAscii,
    decryptLigoGps,
    LIGO_FUZZ_SCALE_3,
    LIGO_TS_DIALECT_OPTIONS,
    parseLigoGpsRecord,
} from "./ligogps.js";
import {
    pesStartPid,
    collectPesBody,
    createTsPesScanPlanner,
    looksLikeMpegTs,
    pesBodyExtent,
    TS_SIZE,
    TS_SYNC,
} from "./ts-walk.js";

const LIGO_PES_STREAM_TYPE = 0x82;

/**
 * "LIGOGPSINFO", the nine header bytes of the real sample, then the '####'
 * cipher marker. Every PES of the sample repeats it unchanged.
 */
const SETTLED_CHUNK_HEADER = Uint8Array.from([
    ...new TextEncoder().encode("LIGOGPSINFO"),
    0x00,
    0x00,
    0x00,
    0x00,
    0x05,
    0x01,
    0x00,
    0x00,
    0x00,
    ...new TextEncoder().encode("####"),
]);
/** The cipher chunk ('####', length, body) starts after the 20-byte header. */
const CHUNK_OFFSET = SETTLED_CHUNK_HEADER.length - 4;

// A PES of the sample holds 152 body bytes; this only stops a corrupt length
// field from asking for megabytes.
const MAX_PES_BODY = 1024;

/**
 * GPS PID of the settled dialect in `headerBytes` (a prefix of the file), or
 * null. Requires a PMT entry of type 0x82 whose first PES in the prefix opens
 * with the exact chunk header of the real sample.
 */
export function findLigoGpsTsPesPid(headerBytes: Uint8Array): number | null {
    if (!looksLikeMpegTs(headerBytes)) return null;
    const candidates = new Set(
        (readFirstProgramMap(headerBytes) ?? [])
            .filter((stream) => stream.streamType === LIGO_PES_STREAM_TYPE)
            .map((stream) => stream.pid),
    );
    if (candidates.size === 0) return null;
    for (let off = 0; off + TS_SIZE <= headerBytes.length; off += TS_SIZE) {
        if (headerBytes[off] !== TS_SYNC) return null;
        const pid = pesStartPid(headerBytes, off);
        if (pid === null) continue;
        if (!candidates.has(pid)) continue;
        const extent = pesBodyExtent(headerBytes, off);
        if (extent === null) continue;
        // The first PES of a candidate decides it; a stream that opens with a
        // different header is a different dialect even if later bytes match.
        const bodyEnd = Math.min(extent.bodyOff + extent.bodyLen, off + TS_SIZE);
        if (matchesBytesAt(headerBytes, extent.bodyOff, SETTLED_CHUNK_HEADER, bodyEnd)) return pid;
        candidates.delete(pid);
        if (candidates.size === 0) return null;
    }
    return null;
}

/**
 * Extracts the records of the settled enciphered PES dialect. Throws
 * WrongFormatError when `headerBytes` does not identify the dialect. A PES
 * whose header or cipher does not decode becomes a skipped entry; no-fix
 * records ('?' hemisphere) and 0,0 fixes are dropped, so a clip recorded
 * before the first fix returns zero records.
 */
export async function extractLigoGpsTsPes(
    file: VendorFile,
    headerBytes: Uint8Array,
    signal?: AbortSignal,
): Promise<ParsedRecords> {
    const pid = findLigoGpsTsPesPid(headerBytes);
    if (pid === null) throw new WrongFormatError("ligogps-ts-pes: no settled ligogps pes stream");

    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];
    let pesIndex = 0;
    const skip = (reason: string, raw: string): void => {
        skipped.push({ line: pesIndex, raw, reason });
    };

    const planner = createTsPesScanPlanner(file.file, { pid, prefix: headerBytes, signal });
    let range = await planner.next(0);
    while (range !== null) {
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
            if (pesStartPid(buf, off) !== pid) {
                off += TS_SIZE;
                continue;
            }
            const extent = pesBodyExtent(buf, off);
            if (extent === null) {
                off += TS_SIZE;
                continue;
            }
            const assembled = collectPesBody(buf, off, extent.bodyOff, pid, Math.min(extent.bodyLen, MAX_PES_BODY));
            // Ran out of buffer mid-PES: re-try this packet with the next buffer.
            if (assembled === "incomplete") break;
            off += TS_SIZE;
            pesIndex++;
            if (assembled === "unavailable") {
                skip("ligogps pes body unavailable", "");
                continue;
            }

            // Reassembly includes the last TS packet's remaining payload;
            // bytes outside PES_packet_length cannot complete a short cipher.
            const body = assembled.body.subarray(0, extent.bodyLen);
            if (!matchesBytesAt(body, 0, SETTLED_CHUNK_HEADER)) {
                skip("ligogps pes header differs from the settled dialect", bytesToAscii(body.subarray(0, 24)));
                continue;
            }
            const decrypted = decryptLigoGps(body.subarray(CHUNK_OFFSET));
            if (decrypted === null) {
                skip("ligogps pes chunk did not decrypt", "");
                continue;
            }
            const text = bytesToAscii(decrypted).replace(/\0+$/, "");
            const record = parseLigoGpsRecord(text, file.file.name, {
                ...LIGO_TS_DIALECT_OPTIONS,
                fuzzScale: LIGO_FUZZ_SCALE_3,
            });
            if (record === null) {
                // A no-fix record is a normal firmware state, not a decode failure.
                if (!/\s\?:/.test(text)) {
                    skip("regex did not match decrypted ligogps pes", JSON.stringify(text.slice(4, 84)));
                }
                continue;
            }
            if (record.lat !== 0 || record.lon !== 0) records.push(record);
        }
        range = await planner.next(start + off);
    }

    removeGravityBaselineInUnknownUnits(records);
    return { records, skipped };
}

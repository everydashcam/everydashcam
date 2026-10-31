// MPEG-TS program map (PMT) access shared by the AV read path and the parsers.
//
// mediabunny reads only the first PMT, maps stream_type 0x82 and 0x8a to DTS
// audio, and fails the whole Input when such a stream's first PES carries no
// DTS sync word. Dashcams reuse 0x82 for private telemetry (enciphered
// LigoGPS, docs/format-ligogps-ts-pes.md), so the recording would not open at
// all. Rewrite only streams whose first PES identifies LigoGPS to private_data
// (0x06). Real DTS must remain available for stream-copy export even when the
// browser cannot decode it.

import { pesBodyExtent, TS_SIZE, walkTsPackets } from "./parsers/internal/ts-walk.js";

const PAT_PID = 0;
const PAT_TABLE_ID = 0x00;
const PMT_TABLE_ID = 0x02;
const PRIVATE_DATA_STREAM_TYPE = 0x06;
/** The stream types mediabunny decodes as DTS outside Blu-ray programs. */
const DTS_STREAM_TYPES: ReadonlySet<number> = new Set([0x82, 0x8a]);
/** Bytes between the section start and the program_info_length field end. */
const PMT_FIXED_HEADER_BYTES = 12;
const CRC_BYTES = 4;
/** PAT and PMT lead every recording seen so far; a later PMT costs a larger read for no known file. */
const HEAD_SCAN_BYTES = 256 * TS_SIZE;
/** Match the parser probe budget when telemetry does not appear beside the PMT. */
const TELEMETRY_SCAN_BYTES = 16 * 1024 * 1024;
const LIGO_MAGIC = new TextEncoder().encode("LIGOGPSINFO");

export interface ProgramMapStream {
    pid: number;
    streamType: number;
}

interface ProgramMapSection {
    /** Offset of the table_id byte. */
    sectionStart: number;
    /** Offset just past CRC_32. */
    sectionEnd: number;
    /** Offset just past the packet that carries the section. */
    packetEnd: number;
    streams: Array<ProgramMapStream & { streamTypeOffset: number }>;
}

/**
 * MPEG-2 CRC-32 (polynomial 0x04C11DB7, no reflection, initial 0xFFFFFFFF,
 * no final XOR) as PSI sections carry it. Running it over a whole section,
 * CRC included, yields 0 for an intact section.
 */
export function mpeg2Crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte << 24;
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
        }
    }
    return crc >>> 0;
}

function firstProgramMapPid(bytes: Uint8Array, sectionStart: number, sectionEnd: number): number | null {
    for (let entry = sectionStart + 8; entry + 4 <= sectionEnd - CRC_BYTES; entry += 4) {
        const programNumber = (bytes[entry]! << 8) | bytes[entry + 1]!;
        // Program 0 names the network PID, not a program map.
        if (programNumber !== 0) return ((bytes[entry + 2]! & 0x1f) << 8) | bytes[entry + 3]!;
    }
    return null;
}

/**
 * Locates the PMT section that mediabunny would use: the first one on the PID
 * named by the first PAT, or the first table_id 0x02 section when no PAT
 * precedes it. Null when the head is not a 188-byte packet stream, carries no
 * PMT, or the PMT spans packets (not seen on any recording).
 */
function locateFirstProgramMap(bytes: Uint8Array): ProgramMapSection | null {
    let programMapPid: number | null = null;
    for (const packet of walkTsPackets(bytes)) {
        const flags = bytes[packet + 1]!;
        if ((flags & 0x40) === 0) continue;
        const pid = ((flags & 0x1f) << 8) | bytes[packet + 2]!;
        const adaptationControl = (bytes[packet + 3]! >> 4) & 0x03;
        if ((adaptationControl & 0x01) === 0) continue;
        const packetEnd = packet + TS_SIZE;
        let payload = packet + 4;
        if (adaptationControl & 0x02) payload += 1 + bytes[payload]!;
        if (payload + 4 > packetEnd) continue;
        // A PES start on a media PID is not a section.
        if (bytes[payload] === 0 && bytes[payload + 1] === 0 && bytes[payload + 2] === 1) continue;
        const sectionStart = payload + 1 + bytes[payload]!;
        if (sectionStart + 3 > packetEnd) continue;
        const tableId = bytes[sectionStart]!;
        const isProgramAssociation = pid === PAT_PID && tableId === PAT_TABLE_ID;
        const isProgramMap = tableId === PMT_TABLE_ID && (programMapPid === null || pid === programMapPid);
        if (!isProgramAssociation && !isProgramMap) continue;
        const sectionEnd = sectionStart + 3 + (((bytes[sectionStart + 1]! & 0x0f) << 8) | bytes[sectionStart + 2]!);
        if (sectionEnd > packetEnd) return null;
        if (isProgramAssociation) {
            programMapPid ??= firstProgramMapPid(bytes, sectionStart, sectionEnd);
            continue;
        }

        if (sectionEnd < sectionStart + PMT_FIXED_HEADER_BYTES + CRC_BYTES) return null;
        const programInfoLength = ((bytes[sectionStart + 10]! & 0x0f) << 8) | bytes[sectionStart + 11]!;
        const streams: ProgramMapSection["streams"] = [];
        const loopEnd = sectionEnd - CRC_BYTES;
        let entry = sectionStart + PMT_FIXED_HEADER_BYTES + programInfoLength;
        if (entry > loopEnd) return null;
        while (entry < loopEnd) {
            if (entry + 5 > loopEnd) return null;
            const nextEntry = entry + 5 + (((bytes[entry + 3]! & 0x0f) << 8) | bytes[entry + 4]!);
            if (nextEntry > loopEnd) return null;
            streams.push({
                pid: ((bytes[entry + 1]! & 0x1f) << 8) | bytes[entry + 2]!,
                streamType: bytes[entry]!,
                streamTypeOffset: entry,
            });
            entry = nextEntry;
        }
        return { sectionStart, sectionEnd, packetEnd, streams };
    }
    return null;
}

/**
 * Elementary streams of the first PMT found in `head` (a prefix of a 188-byte
 * packet stream). Null when there is no single-packet PMT to read.
 */
export function readFirstProgramMap(head: Uint8Array): ProgramMapStream[] | null {
    return locateFirstProgramMap(head)?.streams.map(({ pid, streamType }) => ({ pid, streamType })) ?? null;
}

function ligoGpsPids(head: Uint8Array, streams: ProgramMapStream[]): Set<number> {
    const candidates = new Set(streams.filter((stream) => DTS_STREAM_TYPES.has(stream.streamType)).map((s) => s.pid));
    const found = new Set<number>();
    for (const packet of walkTsPackets(head)) {
        if (candidates.size === 0) break;
        const flags = head[packet + 1]!;
        if ((flags & 0x40) === 0) continue;
        const pid = ((flags & 0x1f) << 8) | head[packet + 2]!;
        if (!candidates.has(pid)) continue;
        const extent = pesBodyExtent(head, packet);
        if (!extent) continue;
        candidates.delete(pid);
        if (
            extent.bodyLen >= LIGO_MAGIC.length &&
            extent.bodyOff + LIGO_MAGIC.length <= packet + TS_SIZE &&
            LIGO_MAGIC.every((byte, index) => head[extent.bodyOff + index] === byte)
        ) {
            found.add(pid);
        }
    }
    return found;
}

/**
 * Returns a patched copy of `head`, up to the end of the PMT packet, in which
 * DTS-typed LigoGPS streams become private data and CRC_32 is recomputed.
 * Null when there is nothing to patch, so the caller keeps the original bytes.
 */
export function maskDtsStreamTypes(head: Uint8Array): Uint8Array<ArrayBuffer> | null {
    const section = locateFirstProgramMap(head);
    if (!section) return null;
    const telemetryPids = ligoGpsPids(head, section.streams);
    const dtsStreams = section.streams.filter((stream) => telemetryPids.has(stream.pid));
    if (dtsStreams.length === 0) return null;
    // An explicit copy: slice() on a Node Buffer would return a view and
    // patch the caller's bytes.
    const patched = new Uint8Array(section.packetEnd);
    patched.set(head.subarray(0, section.packetEnd));
    for (const stream of dtsStreams) patched[stream.streamTypeOffset] = PRIVATE_DATA_STREAM_TYPE;
    const crcOffset = section.sectionEnd - CRC_BYTES;
    const crc = mpeg2Crc32(patched.subarray(section.sectionStart, crcOffset));
    new DataView(patched.buffer).setUint32(crcOffset, crc);
    return patched;
}

/**
 * A view of a transport stream whose first PMT no longer declares LigoGPS as
 * DTS (see the file header). Returns `blob` itself when nothing needs patching;
 * otherwise a Blob of the patched head followed by the untouched remainder.
 */
export async function maskTsDtsStreams(blob: Blob): Promise<Blob> {
    const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, HEAD_SCAN_BYTES)).arrayBuffer());
    let patched = maskDtsStreamTypes(head);
    if (
        patched === null &&
        blob.size > head.length &&
        readFirstProgramMap(head)?.some((stream) => DTS_STREAM_TYPES.has(stream.streamType))
    ) {
        const probe = new Uint8Array(await blob.slice(0, TELEMETRY_SCAN_BYTES).arrayBuffer());
        patched = maskDtsStreamTypes(probe);
    }
    return patched === null ? blob : new Blob([patched, blob.slice(patched.length)]);
}

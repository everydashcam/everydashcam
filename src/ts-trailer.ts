// Detection of the LigoGPS-family GPS trailer appended to MPEG-TS files.
//
// Firmware appends a plaintext table after the last whole 188-byte packet.
// AV readers must exclude it to preserve packet sync; GPS parsing reads it
// separately. Layout and dialect constraints: docs/format-ligogps-trailer-ts.md.

import { isTransportStreamName } from "./video-format-names.js";

export interface TsGpsTrailer {
    /** Byte length of the clean 188-aligned TS stream. */
    cleanLength: number;
    /** Trailer length in bytes, excluding preallocated zero padding. */
    trailerLength: number;
    /** Plaintext slots without the usual four-byte record index, relative to the trailer start. */
    unindexedRecordsOffset?: number;
}

const TS_PACKET = 188;
const TS_SYNC_BYTE = 0x47;
const TS_SYNC_RUN = 4;
const TS_SUFFIX_SCAN_PACKETS = 256;
const MAX_TS_SUFFIX_BYTES = 16 * 1024 * 1024;
const TRAILER_SLOT_BYTES = 132;
const HASH_BYTE = 0x23;
const AMPERSAND_BYTE = 0x26;
/** Known magic/terminator pairs. Anything else stays undetected on purpose:
 *  a wrong clamp on an unknown trailer is worse than the old failure mode. */
const TRAILER_DIALECTS = [
    { magic: "SKIPLIGOGPSINFO", terminatorByte: AMPERSAND_BYTE, header: "slot-capacity" },
    { magic: "SKIPLIGOGPSINFO", terminatorByte: HASH_BYTE, header: "length" },
    { magic: "SKIPLCAIGPSINFO", terminatorByte: HASH_BYTE, header: "length-or-count" },
] as const;
/** Empty table: u32 len + magic 15 + 5 flags + u32 field + marker + u32 len. */
const MIN_TRAILER_BYTES = 36;
/** Sanity cap: 24 h at 1 Hz is ~11.4 MB of 132-byte slots. */
const MAX_TRAILER_BYTES = 16 * 1024 * 1024;
const MAX_TRAILER_SLOTS = Math.floor((MAX_TRAILER_BYTES - MIN_TRAILER_BYTES) / TRAILER_SLOT_BYTES);
const PAIRED_SLOTS_OFFSET = 92;
const MAX_ZERO_PADDING_BYTES = 64 * 1024 * 1024;
const ZERO_SCAN_BYTES = 1024 * 1024;

/** Offset of the first 132-byte slot from the trailer start. */
export const TS_TRAILER_SLOTS_OFFSET = 28;

function asciiAt(buf: Uint8Array, start: number, length: number): string {
    let out = "";
    for (let i = start; i < start + length && i < buf.length; i++) {
        const b = buf[i]!;
        out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
    }
    return out;
}

function tsGpsTrailerTerminatorByte(buf: Uint8Array, offset: number): number | null {
    if (offset + 4 > buf.length) return null;
    const markerByte = buf[offset];
    if (markerByte !== HASH_BYTE && markerByte !== AMPERSAND_BYTE) return null;
    if (buf[offset + 1] !== markerByte || buf[offset + 2] !== markerByte || buf[offset + 3] !== markerByte) {
        return null;
    }
    return markerByte;
}

/** Whether four bytes at `offset` are a supported table terminator. */
export function isTsGpsTrailerTerminator(buf: Uint8Array, offset: number): boolean {
    return tsGpsTrailerTerminatorByte(buf, offset) !== null;
}

/**
 * Detects the GPS trailer on a MPEG-TS blob by its EOF terminator. Two tiny
 * reads: the last 8 bytes (known terminator + u32 BE length), then the trailer
 * head at fileSize - length (leading length copy + magic). Every structural
 * check must pass - length sanity, 188-grid alignment of the clean prefix,
 * length copies agreeing, a known magic - or the file reads as trailer-less.
 * Returns null when there is no trailer; IO errors propagate.
 */
async function findStandardTsGpsTrailer(blob: Blob, size: number): Promise<TsGpsTrailer | null> {
    if (size < TS_PACKET + MIN_TRAILER_BYTES) return null;

    const tail = new Uint8Array(await blob.slice(size - 8, size).arrayBuffer());
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const terminatorByte = tsGpsTrailerTerminatorByte(tail, 0);
    if (terminatorByte === null) return null;
    const trailerLength = tailView.getUint32(4);
    if (trailerLength < MIN_TRAILER_BYTES || trailerLength > MAX_TRAILER_BYTES) return null;
    if (trailerLength >= size) return null;
    if ((trailerLength - MIN_TRAILER_BYTES) % TRAILER_SLOT_BYTES !== 0) return null;

    const cleanLength = size - trailerLength;
    if (cleanLength % TS_PACKET !== 0) return null;

    const head = new Uint8Array(await blob.slice(cleanLength, cleanLength + TS_TRAILER_SLOTS_OFFSET).arrayBuffer());
    if (head.length < TS_TRAILER_SLOTS_OFFSET) return null;
    const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (headView.getUint32(0) !== trailerLength) return null;
    // Parking clips carry only SKIP and zero padding, with no GPS magic.
    if (
        trailerLength === MIN_TRAILER_BYTES &&
        terminatorByte === HASH_BYTE &&
        asciiAt(head, 4, 4) === "SKIP" &&
        head.subarray(8).every((byte) => byte === 0)
    ) {
        return { cleanLength, trailerLength };
    }
    const magic = asciiAt(head, 4, 15);
    const dialect = TRAILER_DIALECTS.find(
        (candidate) => candidate.magic === magic && candidate.terminatorByte === terminatorByte,
    );
    if (!dialect) return null;
    const slotCount = (trailerLength - MIN_TRAILER_BYTES) / TRAILER_SLOT_BYTES;
    const headerValue = headView.getUint32(24, true);
    if (dialect.header === "length" && headerValue !== trailerLength) return null;
    // An empty LCAI table may retain its nominal slot capacity even though
    // no GPS slots were written. Keep this exception limited to empty tables.
    if (
        dialect.header === "length-or-count" &&
        headerValue !== trailerLength &&
        headerValue !== slotCount &&
        !(slotCount === 0 && headerValue > 0 && headerValue <= MAX_TRAILER_SLOTS)
    ) {
        return null;
    }
    // Partial clips retain their nominal slot capacity, so it may exceed the
    // number of slots that were actually appended.
    if (dialect.header === "slot-capacity" && (headerValue < slotCount || headerValue > MAX_TRAILER_SLOTS)) {
        return null;
    }

    return { cleanLength, trailerLength };
}

/** The lowercase-skip dialect pairs an enciphered table with a plaintext twin. */
async function findPairedTsGpsTrailer(blob: Blob, end: number): Promise<TsGpsTrailer | null> {
    if (end < TS_PACKET + 2 * (PAIRED_SLOTS_OFFSET + 8)) return null;
    const tail = new Uint8Array(await blob.slice(end - 8, end).arrayBuffer());
    if (tsGpsTrailerTerminatorByte(tail, 0) !== AMPERSAND_BYTE) return null;
    const blockLength = new DataView(tail.buffer).getUint32(4);
    const slotBytes = blockLength - PAIRED_SLOTS_OFFSET - 8;
    if (
        slotBytes < 0 ||
        slotBytes % TRAILER_SLOT_BYTES !== 0 ||
        blockLength > MAX_TRAILER_BYTES ||
        blockLength + 8 > end
    )
        return null;
    const firstTail = new Uint8Array(await blob.slice(end - blockLength - 8, end - blockLength).arrayBuffer());
    if (tsGpsTrailerTerminatorByte(firstTail, 0) !== AMPERSAND_BYTE) return null;
    const trailerLength = new DataView(firstTail.buffer).getUint32(4);
    const firstLength = trailerLength - blockLength;
    const firstSlotBytes = firstLength - PAIRED_SLOTS_OFFSET - 8;
    if (firstSlotBytes < 0 || firstSlotBytes % TRAILER_SLOT_BYTES !== 0 || trailerLength > MAX_TRAILER_BYTES)
        return null;
    const cleanLength = end - trailerLength;
    if (cleanLength < TS_SYNC_RUN * TS_PACKET || cleanLength % TS_PACKET !== 0) return null;

    const bytes = new Uint8Array(await blob.slice(cleanLength, end).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const slotCount = slotBytes / TRAILER_SLOT_BYTES;
    if (
        view.getUint32(0) !== trailerLength ||
        asciiAt(bytes, 4, 15) !== "skipLIGOGPSINFO" ||
        view.getUint32(24, true) !== firstSlotBytes / TRAILER_SLOT_BYTES ||
        view.getUint32(firstLength) !== blockLength ||
        asciiAt(bytes, firstLength + 4, 4) !== "skip" ||
        !bytes.subarray(firstLength + 8, firstLength + 19).every((byte) => byte >= 0x20 && byte < 0x7f) ||
        !bytes.subarray(firstLength + 19, firstLength + 24).every((byte) => byte === 0) ||
        view.getUint32(firstLength + 24) !== slotCount ||
        !bytes.subarray(28, PAIRED_SLOTS_OFFSET).every((byte) => byte === 0) ||
        !bytes.subarray(firstLength + 28, firstLength + PAIRED_SLOTS_OFFSET).every((byte) => byte === 0)
    ) {
        return null;
    }
    const runBytes = TS_SYNC_RUN * TS_PACKET;
    const head = new Uint8Array(await blob.slice(0, runBytes).arrayBuffer());
    const lastPackets = new Uint8Array(await blob.slice(cleanLength - runBytes, cleanLength).arrayBuffer());
    if (!hasTsSyncRun(head, 0) || !hasTsSyncRun(lastPackets, 0)) return null;
    return { cleanLength, trailerLength, unindexedRecordsOffset: firstLength + PAIRED_SLOTS_OFFSET };
}

// One Blob reaches several readers inside one worker: the GPS worker builds
// its index and later parses the trailer, and the AV clamp falls back from
// trailer detection to the packet-boundary search. Each miss re-reads the whole
// zero preallocation (tens of MB on real recordings), so settled answers are
// kept for the Blob's lifetime - a Blob is immutable, so they cannot go stale.
// Rejections are dropped so a transient device error can retry.
const zeroPaddedEndByBlob = new WeakMap<Blob, Promise<number | null>>();
const trailerByBlob = new WeakMap<Blob, Promise<TsGpsTrailer | null>>();

function memoizeByBlob<T>(cache: WeakMap<Blob, Promise<T>>, blob: Blob, compute: () => Promise<T>): Promise<T> {
    const cached = cache.get(blob);
    if (cached) return cached;
    const pending = compute();
    cache.set(blob, pending);
    pending.catch(() => {
        if (cache.get(blob) === pending) cache.delete(blob);
    });
    return pending;
}

/** Returns the end of nonzero data, without interpreting any container bytes. */
function findZeroPaddedEnd(blob: Blob): Promise<number | null> {
    return memoizeByBlob(zeroPaddedEndByBlob, blob, () => scanZeroPaddedEnd(blob));
}

async function scanZeroPaddedEnd(blob: Blob): Promise<number | null> {
    // Preallocated recordings leave zeros after their data. Verify every skipped
    // byte, and keep the scan bounded so unrelated files cannot force a full read.
    const tail = new Uint8Array(await blob.slice(-1).arrayBuffer());
    if (tail[0] !== 0) return null;
    const floor = Math.max(0, blob.size - MAX_ZERO_PADDING_BYTES);
    for (let end = blob.size; end > floor; ) {
        const start = Math.max(floor, end - ZERO_SCAN_BYTES);
        const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
        let last = bytes.length - 1;
        while (last >= 0 && bytes[last] === 0) last--;
        if (last >= 0) return start + last + 1;
        end = start;
    }
    return null;
}

/** Detects known GPS table structures at EOF or before zero preallocation. */
export function findTsGpsTrailer(blob: Blob): Promise<TsGpsTrailer | null> {
    return memoizeByBlob(trailerByBlob, blob, () => detectTsGpsTrailer(blob));
}

async function detectTsGpsTrailer(blob: Blob): Promise<TsGpsTrailer | null> {
    const direct = (await findStandardTsGpsTrailer(blob, blob.size)) ?? (await findPairedTsGpsTrailer(blob, blob.size));
    if (direct) return direct;
    // A table always follows the last whole packet, and only the table and
    // zero preallocation can follow it. A file that still ends in a valid sync
    // run on the 188-byte grid therefore carries neither: skip the bisection
    // (one read per halving, ~25 on a long recording) and the zero scan. Plain
    // .ts recordings take this path in every worker that opens them.
    if (await endsWithTsPackets(blob)) return null;
    const behindLastPacket = await findTsGpsTrailerBehindLastPacket(blob);
    if (behindLastPacket) return behindLastPacket;
    const dataEnd = await findZeroPaddedEnd(blob);
    if (dataEnd === null) return null;
    // A big-endian length may itself end in up to three zero bytes.
    for (let zeros = 0; zeros < 4; zeros++) {
        const trailerEnd = dataEnd + zeros;
        if (trailerEnd > blob.size) break;
        const trailer =
            (await findStandardTsGpsTrailer(blob, trailerEnd)) ?? (await findPairedTsGpsTrailer(blob, trailerEnd));
        if (trailer) return trailer;
    }
    return null;
}

const TS_SYNC_RUN_BYTES = TS_SYNC_RUN * TS_PACKET;
/** Bytes verified to be zero directly behind a table located by bisection. */
const TRAILER_ZERO_WINDOW_BYTES = 64 * 1024;

/**
 * Finds a GPS table that directly follows the last complete packet, without
 * reading whatever comes after the table. Bisects the 188-byte grid for the
 * last offset where a sync run still holds (the packet grid is anchored at
 * byte zero, so a run is valid up to the clean length and invalid in the table
 * and the padding behind it), then reads the table's own leading length - both
 * dialects open with it - and hands that end to the same end-anchored checks
 * the EOF path uses. Only a table those checks accept at exactly this clean
 * length is returned, and only with a zero window behind it; the exhaustive
 * scan additionally proves the whole padding is zero, which is the one read
 * this path skips. A sync defect inside the stream merely stops the bisection
 * early, verifies nothing there, and leaves the fallback to run.
 */
async function findTsGpsTrailerBehindLastPacket(blob: Blob): Promise<TsGpsTrailer | null> {
    const size = blob.size;
    if (size < TS_SYNC_RUN_BYTES + MIN_TRAILER_BYTES) return null;
    const head = new Uint8Array(await blob.slice(0, TS_SYNC_RUN_BYTES).arrayBuffer());
    if (!hasTsSyncRun(head, 0)) return null;
    let low = 0;
    let high = Math.floor((size - TS_SYNC_RUN_BYTES) / TS_PACKET);
    while (low < high) {
        const mid = low + Math.ceil((high - low) / 2);
        const start = mid * TS_PACKET;
        const run = new Uint8Array(await blob.slice(start, start + TS_SYNC_RUN_BYTES).arrayBuffer());
        if (hasTsSyncRun(run, 0)) low = mid;
        else high = mid - 1;
    }
    const cleanLength = low * TS_PACKET + TS_SYNC_RUN_BYTES;
    if (cleanLength + 4 > size) return null;
    const lengthBytes = new Uint8Array(await blob.slice(cleanLength, cleanLength + 4).arrayBuffer());
    if (lengthBytes.length < 4) return null;
    const trailerLength = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0);
    if (trailerLength < MIN_TRAILER_BYTES || trailerLength > MAX_TRAILER_BYTES) return null;
    const trailerEnd = cleanLength + trailerLength;
    if (trailerEnd > size) return null;
    const trailer =
        (await findStandardTsGpsTrailer(blob, trailerEnd)) ?? (await findPairedTsGpsTrailer(blob, trailerEnd));
    if (!trailer || trailer.cleanLength !== cleanLength) return null;
    // An unknown dialect or a stale recording left in a reused file slot shows
    // up as non-zero bytes directly behind the table; the exhaustive scan calls
    // that "not this structure", and so does this path. Only a bounded window
    // is read - the preallocation beyond it is what the bisection exists to skip.
    const windowEnd = Math.min(size, trailerEnd + TRAILER_ZERO_WINDOW_BYTES);
    const window = new Uint8Array(await blob.slice(trailerEnd, windowEnd).arrayBuffer());
    return window.every((byte) => byte === 0) ? trailer : null;
}

/** Whether the blob ends on the byte-zero packet grid with a valid sync run. */
async function endsWithTsPackets(blob: Blob): Promise<boolean> {
    const size = blob.size;
    if (size < TS_SYNC_RUN_BYTES || size % TS_PACKET !== 0) return false;
    const tail = new Uint8Array(await blob.slice(size - TS_SYNC_RUN_BYTES, size).arrayBuffer());
    return hasTsSyncRun(tail, 0);
}

function hasTsSyncRun(bytes: Uint8Array, start: number): boolean {
    for (let i = 0; i < TS_SYNC_RUN; i++) {
        const packet = start + i * TS_PACKET;
        if (bytes[packet] !== TS_SYNC_BYTE) return false;
        // Transport errors do not break packet alignment.
        const adaptationControl = (bytes[packet + 3]! >> 4) & 3;
        if (adaptationControl === 0) return false;
        const adaptationLength = bytes[packet + 4]!;
        if (adaptationControl === 2 && adaptationLength !== 183) return false;
        if (adaptationControl === 3 && adaptationLength > 182) return false;
    }
    return true;
}

/** Finds the last complete packet when a .ts file has an unknown trailing block. */
async function findTsPacketBoundary(blob: Blob): Promise<number | null> {
    let alignedEnd = blob.size - (blob.size % TS_PACKET);
    const runBytes = TS_SYNC_RUN * TS_PACKET;
    if (alignedEnd < runBytes) return null;

    const tail = new Uint8Array(await blob.slice(alignedEnd - runBytes, alignedEnd).arrayBuffer());
    const hasCompleteTail = hasTsSyncRun(tail, 0);
    if (hasCompleteTail && alignedEnd === blob.size) return null;

    // Require the packet grid to begin at byte zero. A mislabeled MP4, M2TS,
    // or a stream with a different packet stride must retain its full bytes.
    const head = new Uint8Array(await blob.slice(0, runBytes).arrayBuffer());
    if (!hasTsSyncRun(head, 0)) return null;
    if (hasCompleteTail) return alignedEnd;

    const dataEnd = await findZeroPaddedEnd(blob);
    if (dataEnd !== null) {
        // Zero-valued payload bytes still belong to the last complete packet.
        alignedEnd = Math.min(alignedEnd, Math.ceil(dataEnd / TS_PACKET) * TS_PACKET);
        const packetTail = new Uint8Array(await blob.slice(alignedEnd - runBytes, alignedEnd).arrayBuffer());
        if (hasTsSyncRun(packetTail, 0)) return alignedEnd;
    }

    const floor = Math.max(runBytes, alignedEnd - Math.floor(MAX_TS_SUFFIX_BYTES / TS_PACKET) * TS_PACKET);
    const chunkBytes = TS_SUFFIX_SCAN_PACKETS * TS_PACKET;
    for (let chunkEnd = alignedEnd; chunkEnd > floor; ) {
        const chunkStart = Math.max(floor, chunkEnd - chunkBytes);
        const readStart = chunkStart - runBytes;
        const bytes = new Uint8Array(await blob.slice(readStart, chunkEnd).arrayBuffer());
        for (let boundary = chunkEnd; boundary >= chunkStart; boundary -= TS_PACKET) {
            if (hasTsSyncRun(bytes, boundary - readStart - runBytes)) return boundary;
        }
        chunkEnd = chunkStart;
    }
    return null;
}

/**
 * Returns a view of a .ts File ending at its last complete 188-byte packet.
 * A recognized GPS trailer supplies an exact boundary; an unknown suffix is
 * clipped only when a four-packet sync run establishes the same packet grid
 * at the head and near the tail. GPS extraction still requires its own strict
 * trailer marker. The returned Blob loses the File name.
 */
export async function clampTsTrailingBytes(blob: Blob): Promise<Blob> {
    const name = blob instanceof File ? blob.name : "";
    if (!isTransportStreamName(name)) return blob;
    const trailer = await findTsGpsTrailer(blob);
    const cleanLength = trailer?.cleanLength ?? (await findTsPacketBoundary(blob));
    return cleanLength === null ? blob : blob.slice(0, cleanLength);
}

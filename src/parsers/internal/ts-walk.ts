// Shared MPEG-TS packet/PES plumbing. Three GPS formats ride private PES
// streams in TS containers (novatek-ts, juscar-ts, ts-pes-gps) and all of them
// need to step packets and locate the PES body; the two whose records outgrow
// a single packet also reassemble here. Keeping one copy of the PES header math
// is the point - the body-length rule in particular is easy to get wrong in a
// way that silently drops a whole dialect.
//
// Dashcam TS quirk that shapes all of this: the GPS PES is NOT advertised in
// the PMT, so PSI parsing cannot find it. Detection is content-based and the
// PID is auto-detected, which means these helpers get run over video and audio
// packets too and must reject them cheaply.

export const TS_SIZE = 188;
export const TS_SYNC = 0x47;

/** Cheap container gate: two aligned sync bytes reject non-TS carriers while
 * keeping detection independent of the filename and extension. */
export function looksLikeMpegTs(bytes: Uint8Array): boolean {
    return bytes.length >= 2 * TS_SIZE && bytes[0] === TS_SYNC && bytes[TS_SIZE] === TS_SYNC;
}

/** Where the PES body of one packet starts and how many bytes of it the PES promises. */
export type PesBodyExtent = { bodyOff: number; bodyLen: number };

/**
 * Parses the PES header of the packet at `off`. Null when the packet has no
 * payload / no PES start code.
 *
 * `bodyLen` is deliberately NOT PES_packet_length: the field counts everything
 * after itself, header included. Only private_stream_2 (0xbf) has a fixed
 * 6-byte header where the two coincide; every other stream_id spends
 * 3 + pes_header_data_length of the counted bytes on its extended header.
 */
function readPesHeader(bytes: Uint8Array, off: number): PesBodyExtent | null {
    const b3 = bytes[off + 3]!;
    const af = (b3 & 0x30) >> 4;
    if (af === 2) return null; // adaptation field only, no payload
    let payOff = off + 4;
    if (af === 3) payOff += 1 + bytes[payOff]!;
    if (payOff + 6 > off + TS_SIZE) return null;
    if (bytes[payOff] !== 0 || bytes[payOff + 1] !== 0 || bytes[payOff + 2] !== 1) return null;
    const streamId = bytes[payOff + 3]!;
    const pesLen = (bytes[payOff + 4]! << 8) | bytes[payOff + 5]!;
    if (streamId === 0xbf) return { bodyOff: payOff + 6, bodyLen: pesLen };
    if (payOff + 9 > off + TS_SIZE) return null;
    const headerDataLen = bytes[payOff + 8]!;
    return { bodyOff: payOff + 9 + headerDataLen, bodyLen: pesLen - 3 - headerDataLen };
}

/**
 * For a TS packet at `off` with PUSI=1, returns the offset of the PES body
 * (after the PES header) or null when the packet has no payload / no PES start
 * code. For callers that also need to know how long the body is, use
 * `pesBodyExtent` - deriving it from PES_packet_length is where this goes wrong.
 */
export function pesBodyOffset(bytes: Uint8Array, off: number): number | null {
    return readPesHeader(bytes, off)?.bodyOff ?? null;
}

/**
 * Body offset AND body length of the PES starting at `off`, or null when there
 * is no PES start code, no payload, or the length field yields no body
 * (0 = unbounded, which the spec allows only for video).
 *
 * This is what a reassembly byte budget must be built from: handing
 * `collectPesBody` the raw PES_packet_length of an extended-header stream_id
 * overshoots the body by 3 + pes_header_data_length, so the walk runs into the
 * next PES start and the record reads as unavailable.
 */
export function pesBodyExtent(bytes: Uint8Array, off: number): PesBodyExtent | null {
    const header = readPesHeader(bytes, off);
    if (header === null || header.bodyLen <= 0) return null;
    return header;
}

/**
 * Outcome of a reassembly attempt. The two failure modes must stay distinct:
 * "incomplete" means the buffer ran out and the caller should re-try this
 * packet once more data is in hand, while "unavailable" means the answer will
 * not improve and the packet has to be stepped over. Collapsing them into one
 * null makes a chunked scan carry an ever-growing tail on a stream that keeps
 * failing to reassemble.
 */
export type ReassemblyResult = { body: Uint8Array } | "incomplete" | "unavailable";

// How far to look for continuation packets of the same PID. The continuations
// of one PES follow within a handful of packets; this only bounds the damage
// on a corrupt stream.
const REASSEMBLY_PACKET_LIMIT = 64;

/**
 * Concatenates the PES body starting at `bodyOff` with the payloads of the
 * following packets on the same PID, until `needBytes` are available. Stops at
 * the next PES start (PUSI=1) on that PID, since that is a different record.
 */
export function collectPesBody(
    buf: Uint8Array,
    packetOff: number,
    bodyOff: number,
    pid: number,
    needBytes: number,
): ReassemblyResult {
    const parts: Uint8Array[] = [buf.subarray(bodyOff, packetOff + TS_SIZE)];
    let have = parts[0]!.length;

    let off = packetOff + TS_SIZE;
    let seen = 0;
    while (have < needBytes) {
        if (seen++ >= REASSEMBLY_PACKET_LIMIT) return "unavailable";
        if (off + TS_SIZE > buf.length) return "incomplete";
        if (buf[off] !== TS_SYNC) return "unavailable"; // desync, not a short read
        const b1 = buf[off + 1]!;
        if ((((b1 & 0x1f) << 8) | buf[off + 2]!) !== pid) {
            off += TS_SIZE;
            continue;
        }
        if ((b1 & 0x40) !== 0) return "unavailable"; // next PES started - record is short

        const af = (buf[off + 3]! & 0x30) >> 4;
        if (af === 2) {
            off += TS_SIZE;
            continue; // adaptation field only
        }
        let payOff = off + 4;
        if (af === 3) payOff += 1 + buf[payOff]!;
        if (payOff < off + TS_SIZE) {
            const part = buf.subarray(payOff, off + TS_SIZE);
            parts.push(part);
            have += part.length;
        }
        off += TS_SIZE;
    }

    const out = new Uint8Array(have);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return { body: out };
}

// ===== Predicted-offset scan planner for 1 Hz GPS PES streams =====
//
// Dashcam muxers write the GPS PES on a wall-clock cadence - one per second,
// or an enciphered/plaintext pair per second - so the byte distance between
// consecutive PES starts follows the bitrate and drifts slowly. A linear pass
// reads the whole file to visit a few hundred packets. The planner instead
// predicts the next PES start from the distance two hits back (which also
// covers the paired cadence), reads a bounded window around it and verifies
// with the packet continuity counter that no PES start on the PID was skipped:
// every packet with payload advances the counter, so the first hit of a window
// must carry the previous hit's counter plus the packets per PES. On a
// mismatch the bytes between the previous hit and the window are read first,
// so the caller still receives every PES start in file order and decodes the
// same records a linear scan would; only the bytes read differ. Windows start
// on the packet grid anchored at byte zero and carry a reassembly margin so a
// body spanning the window end stays readable. An inconsistent counter step or
// repeated mispredictions switch the planner to plain linear reading.

const PLANNER_CHUNK_BYTES = 4 * 1024 * 1024;
const JUMP_NARROW_RADIUS_BYTES = 192 * 1024;
const JUMP_WIDE_RADIUS_BYTES = 1024 * 1024;
/** Trailing packets so collectPesBody never runs out inside a window. */
const JUMP_MARGIN_BYTES = (REASSEMBLY_PACKET_LIMIT + 1) * TS_SIZE;
/** Mispredictions in a row before the stream is treated as irregular. */
const JUMP_MAX_CONSECUTIVE_MISSES = 2;
/** Hits kept for the distance estimate; ~16 s of GPS smooths bitrate spikes. */
const JUMP_HISTORY = 16;
/** Hits needed before predicting: one period-2 distance and two counter steps. */
const JUMP_MIN_HITS = 3;

/** One buffer handed to the caller; `start` is its absolute file offset. */
export interface TsScanRange {
    start: number;
    buf: Uint8Array;
}

export interface TsPesScanPlanner {
    /**
     * The next buffer to scan, or null at end of file. `consumedAbs` is the
     * absolute offset up to which the caller handled the previous buffer; a
     * value short of that buffer's end (a partial packet or a PES body that
     * ran past the end) makes the next buffer start exactly there.
     */
    next(consumedAbs: number): Promise<TsScanRange | null>;
    /** Names the GPS PID once the caller has locked it from the content. */
    setPid(pid: number): void;
}

interface PesStartHit {
    abs: number;
    cc: number;
}

function alignDownToPacket(offset: number): number {
    return Math.floor(offset / TS_SIZE) * TS_SIZE;
}

/** PES-start packets on `pid` inside `buf`, as absolute offsets with their counters. */
function findPesStarts(buf: Uint8Array, start: number, pid: number): PesStartHit[] {
    const found: PesStartHit[] = [];
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
        if ((b1 & 0x40) !== 0 && (((b1 & 0x1f) << 8) | buf[off + 2]!) === pid) {
            found.push({ abs: start + off, cc: buf[off + 3]! & 0x0f });
        }
        off += TS_SIZE;
    }
    return found;
}

/**
 * Creates a planner over `file`. `pid` may be null until the caller locks it
 * from the content; the planner reads linearly until then. `prefix` is an
 * already-loaded head of the file (the marker probe) served in place of the
 * first reads instead of being read again.
 */
export function createTsPesScanPlanner(
    file: Blob,
    options: { pid: number | null; prefix?: Uint8Array | null; signal?: AbortSignal },
): TsPesScanPlanner {
    const fileSize = file.size;
    const { signal } = options;
    const prefix = options.prefix ?? null;
    let pid = options.pid;
    let hits: PesStartHit[] = [];
    let packetsPerPes: number | null = null;
    let isJumpEnabled = true;
    let consecutiveMisses = 0;
    // The previously returned buffer, scanned for hits lazily on the next call
    // so a PID locked halfway through it still contributes its hits.
    let previous: TsScanRange | null = null;
    let isPreviousCollected = false;
    // A verified-clean window held back while the bytes in front of it are read.
    let pending: TsScanRange | null = null;

    const read = async (start: number, end: number): Promise<Uint8Array> => {
        if (signal?.aborted) throw new DOMException("ts scan aborted", "AbortError");
        // The probe is the same length as a chunk, so the leading chunk comes
        // from memory with the same boundary a file read would have had; a
        // range reaching past the probe is read whole from the file.
        if (prefix !== null && end <= prefix.length) return prefix.subarray(start, end);
        return new Uint8Array(await file.slice(start, end).arrayBuffer());
    };

    // Appends the hits of a buffer whose coverage is contiguous with the
    // previous hits, and learns the counter step from them.
    const collect = (range: TsScanRange): void => {
        if (pid === null) return;
        for (const hit of findPesStarts(range.buf, range.start, pid)) {
            const last = hits[hits.length - 1];
            if (last !== undefined && hit.abs <= last.abs) continue;
            if (last !== undefined) {
                const step = (hit.cc - last.cc + 16) & 0x0f;
                // The counter has four bits, so a step sharing a factor of four
                // with sixteen repeats after at most four skipped PES (a step
                // of eight after two) - a bitrate dip puts that within the wide
                // window, where the check could pass over skipped records. A
                // frozen counter reveals nothing at all. Neither stream is ever
                // jumped over; the steps seen in the wild (1 and 6) repeat only
                // after sixteen or eight skipped PES, far outside any window.
                if (step % 4 === 0) isJumpEnabled = false;
                else if (packetsPerPes === null) packetsPerPes = step;
                else if (step !== packetsPerPes) isJumpEnabled = false;
            }
            hits.push(hit);
        }
        if (hits.length > JUMP_HISTORY) hits = hits.slice(-JUMP_HISTORY);
    };

    const deliver = (range: TsScanRange): TsScanRange => {
        previous = range;
        isPreviousCollected = false;
        return range;
    };

    const predictedDistance = (): number | null => {
        const distances: number[] = [];
        for (let i = 2; i < hits.length; i++) distances.push(hits[i]!.abs - hits[i - 2]!.abs);
        if (distances.length === 0) return null;
        distances.sort((a, b) => a - b);
        return distances[Math.floor(distances.length / 2)]!;
    };

    const registerMiss = (): void => {
        consecutiveMisses++;
        if (consecutiveMisses >= JUMP_MAX_CONSECUTIVE_MISSES) isJumpEnabled = false;
    };

    return {
        setPid(lockedPid: number): void {
            if (pid === lockedPid) return;
            pid = lockedPid;
            hits = [];
            packetsPerPes = null;
        },
        async next(consumedAbs: number): Promise<TsScanRange | null> {
            if (previous !== null && !isPreviousCollected) {
                collect(previous);
                isPreviousCollected = true;
            }
            const previousEnd = previous === null ? 0 : previous.start + previous.buf.length;
            // Bytes the caller did not handle: a packet cut by the buffer end,
            // or a PES body that ran past it. They lead the next contiguous
            // buffer, which therefore starts where the caller stopped while
            // its end stays on the planner's own chunk grid.
            let leftover: Uint8Array | null = null;
            if (previous !== null && consumedAbs < previousEnd) {
                if (consumedAbs <= previous.start && previousEnd >= fileSize) return null;
                leftover = previous.buf.subarray(Math.max(0, consumedAbs - previous.start));
            }
            const readFrom = Math.max(previousEnd, consumedAbs);
            // Bytes starting at readFrom, led by the leftover so the caller
            // sees one contiguous buffer.
            const withLeftover = (fresh: Uint8Array): TsScanRange => {
                if (leftover === null || leftover.length === 0) return deliver({ start: readFrom, buf: fresh });
                const buf = new Uint8Array(leftover.length + fresh.length);
                buf.set(leftover, 0);
                buf.set(fresh, leftover.length);
                return deliver({ start: readFrom - leftover.length, buf });
            };
            const contiguous = async (requestedEnd: number): Promise<TsScanRange | null> => {
                if (readFrom >= fileSize) return null;
                // A stale prediction can fall behind the covered bytes; the
                // read then simply continues from where coverage ends.
                const end = requestedEnd > readFrom ? requestedEnd : Math.min(fileSize, readFrom + PLANNER_CHUNK_BYTES);
                return withLeftover(await read(readFrom, end));
            };

            // A window held back while the stretch in front of it was read goes
            // out as soon as coverage reaches it - never re-read from the file
            // and never handed out twice. A PES whose body straddles its start
            // leads the buffer, so the body stays contiguous: the stretch and
            // the window are one range from the caller's point of view.
            if (pending !== null) {
                if (pending.start > readFrom) {
                    return contiguous(Math.min(pending.start, readFrom + PLANNER_CHUNK_BYTES));
                }
                const window = pending;
                pending = null;
                return withLeftover(window.buf.subarray(readFrom - window.start));
            }
            // An unfinished PES body needs the bytes right behind it.
            if (leftover !== null && leftover.length >= TS_SIZE) {
                return contiguous(Math.min(fileSize, readFrom + PLANNER_CHUNK_BYTES));
            }
            if (readFrom >= fileSize) return null;

            const canJump = isJumpEnabled && pid !== null && packetsPerPes !== null && hits.length >= JUMP_MIN_HITS;
            const distance = canJump ? predictedDistance() : null;
            if (distance === null || distance <= TS_SIZE) {
                return contiguous(Math.min(fileSize, readFrom + PLANNER_CHUNK_BYTES));
            }

            const lastHit = hits[hits.length - 1]!;
            const predicted = hits[hits.length - 2]!.abs + distance;
            if (predicted + JUMP_NARROW_RADIUS_BYTES >= fileSize) return contiguous(fileSize);
            // A packet cut at the previous buffer end could itself be a PES start
            // the hit list cannot see; skipping it shows up as a counter gap, so
            // the stretch is read linearly like any other skipped stretch.
            const cursor = readFrom;
            for (const radius of [JUMP_NARROW_RADIUS_BYTES, JUMP_WIDE_RADIUS_BYTES]) {
                const windowStart = Math.max(cursor, alignDownToPacket(predicted - radius));
                const windowEnd = Math.min(fileSize, alignDownToPacket(predicted + radius) + JUMP_MARGIN_BYTES);
                if (windowStart <= cursor) {
                    // The prediction sits right behind the covered bytes: a plain
                    // contiguous read, nothing to verify.
                    return contiguous(windowEnd);
                }
                const window: TsScanRange = { start: windowStart, buf: await read(windowStart, windowEnd) };
                const first = findPesStarts(window.buf, windowStart, pid!)[0];
                if (first === undefined) continue;
                if (first.cc === ((lastHit.cc + packetsPerPes!) & 0x0f)) {
                    consecutiveMisses = 0;
                    return deliver(window);
                }
                // A PES start was skipped between the last hit and this window:
                // read that stretch first, then hand out the window.
                registerMiss();
                pending = window;
                return contiguous(windowStart);
            }
            // Nothing on the PID near the prediction even in the wide window.
            registerMiss();
            return contiguous(
                Math.min(fileSize, alignDownToPacket(predicted + JUMP_WIDE_RADIUS_BYTES) + JUMP_MARGIN_BYTES),
            );
        },
    };
}

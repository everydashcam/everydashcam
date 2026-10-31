import { describe, expect, it } from "vitest";

import {
    createTsPesScanPlanner,
    looksLikeMpegTs,
    walkTsPackets,
    TS_SIZE,
    TS_SYNC,
    type TsPesScanPlanner,
} from "./ts-walk.js";

const GPS_PID = 0x300;
const VIDEO_PID = 0x100;

interface StreamOptions {
    seconds: number;
    /** Filler packets written after the GPS PES of a given second. */
    fillerPackets: (second: number) => number;
    /** Packets per GPS PES (one PES start plus continuations). */
    packetsPerPes?: number;
    /** Keeps the GPS counter frozen, as a muxer that never maintains it would. */
    isCounterFrozen?: boolean;
}

interface SyntheticStream {
    bytes: Uint8Array<ArrayBuffer>;
    gpsStarts: number[];
}

function writePacket(out: Uint8Array, at: number, pid: number, isPesStart: boolean, counter: number): void {
    out.fill(0xff, at, at + TS_SIZE);
    out[at] = TS_SYNC;
    out[at + 1] = (isPesStart ? 0x40 : 0) | ((pid >> 8) & 0x1f);
    out[at + 2] = pid & 0xff;
    out[at + 3] = 0x10 | (counter & 0x0f);
    if (isPesStart) out.set([0x00, 0x00, 0x01, 0xbf, 0x00, 0x20], at + 4);
}

/** One GPS PES per second followed by filler video packets. */
function buildStream(options: StreamOptions): SyntheticStream {
    const packetsPerPes = options.packetsPerPes ?? 1;
    let packetCount = 0;
    for (let second = 0; second < options.seconds; second++) {
        packetCount += packetsPerPes + options.fillerPackets(second);
    }
    const bytes = new Uint8Array(packetCount * TS_SIZE);
    const gpsStarts: number[] = [];
    let at = 0;
    let gpsCounter = 0;
    let videoCounter = 0;
    for (let second = 0; second < options.seconds; second++) {
        gpsStarts.push(at);
        for (let packet = 0; packet < packetsPerPes; packet++) {
            writePacket(bytes, at, GPS_PID, packet === 0, gpsCounter);
            if (!options.isCounterFrozen) gpsCounter = (gpsCounter + 1) & 0x0f;
            at += TS_SIZE;
        }
        const filler = options.fillerPackets(second);
        for (let packet = 0; packet < filler; packet++) {
            writePacket(bytes, at, VIDEO_PID, packet === 0, videoCounter);
            videoCounter = (videoCounter + 1) & 0x0f;
            at += TS_SIZE;
        }
    }
    return { bytes, gpsStarts };
}

/** Deterministic per-second jitter around a base packet count. */
function jittered(base: number, spread: number): (second: number) => number {
    return (second) => base + ((Math.imul(second + 1, 2654435761) >>> 0) % spread);
}

interface Driven {
    starts: number[];
    ranges: Array<[number, number]>;
}

/**
 * Walks the planner the way an extractor does: visits every PES start on the
 * GPS PID, stops in front of a PES whose body would run past the buffer when
 * `packetsPerPes` is given, and reports where it stopped.
 */
async function drive(file: File, planner: TsPesScanPlanner, packetsPerPes = 1): Promise<Driven> {
    const starts: number[] = [];
    const ranges: Array<[number, number]> = [];
    let consumed = 0;
    for (let range = await planner.next(0); range !== null; range = await planner.next(consumed)) {
        const { start, buf } = range;
        const packets = walkTsPackets(buf, start + buf.length >= file.size);
        let packet = packets.next();
        for (; !packet.done; packet = packets.next()) {
            const off = packet.value;
            const b1 = buf[off + 1]!;
            const pid = ((b1 & 0x1f) << 8) | buf[off + 2]!;
            if ((b1 & 0x40) !== 0 && pid === GPS_PID) {
                if (off + packetsPerPes * TS_SIZE > buf.length) break;
                starts.push(start + off);
            }
        }
        ranges.push([start, start + buf.length]);
        consumed = start + packet.value;
    }
    return { starts, ranges };
}

/** A File whose slice reads are recorded, so a test can count bytes read. */
function recordedFile(bytes: Uint8Array<ArrayBuffer>): {
    file: File;
    reads: Array<[number, number]>;
    bytesRead: () => number;
} {
    const file = new File([bytes], "stream.ts");
    const reads: Array<[number, number]> = [];
    const original = file.slice.bind(file);
    Object.defineProperty(file, "slice", {
        value: (start?: number, end?: number) => {
            reads.push([start ?? 0, end ?? file.size]);
            return original(start, end);
        },
    });
    return { file, reads, bytesRead: () => reads.reduce((sum, [start, end]) => sum + (end - start), 0) };
}

function expectStrictlyIncreasing(values: number[]): void {
    for (let i = 1; i < values.length; i++) {
        expect(values[i]!, `offset #${i}`).toBeGreaterThan(values[i - 1]!);
    }
}

describe("looksLikeMpegTs", () => {
    it("rejects an accidental pair that is enough for recovery inside a known TS", () => {
        const bytes = new Uint8Array(20 * TS_SIZE);
        writePacket(bytes, 8 * TS_SIZE + 19, VIDEO_PID, true, 0);
        writePacket(bytes, 9 * TS_SIZE + 19, VIDEO_PID, true, 1);
        expect([...walkTsPackets(bytes)]).toHaveLength(2);
        expect(looksLikeMpegTs(bytes)).toBe(false);
    });

    it("finds five consecutive packets after a long damaged prefix", () => {
        const start = 100 * TS_SIZE + 17;
        const bytes = new Uint8Array(start + 5 * TS_SIZE);
        for (let i = 0; i < 5; i++) writePacket(bytes, start + i * TS_SIZE, VIDEO_PID, true, i);
        expect(looksLikeMpegTs(bytes)).toBe(true);
    });

    it("requires two complete packets even in a short stream", () => {
        const bytes = new Uint8Array(2 * TS_SIZE);
        writePacket(bytes, 0, VIDEO_PID, true, 0);
        writePacket(bytes, TS_SIZE, VIDEO_PID, true, 1);
        expect(looksLikeMpegTs(bytes)).toBe(true);
        expect(looksLikeMpegTs(bytes.subarray(0, TS_SIZE))).toBe(false);
    });
});

describe("walkTsPackets", () => {
    it("rejects an isolated header-shaped sync at byte zero and in a damaged payload", () => {
        const bytes = new Uint8Array(5 * TS_SIZE + 32);
        bytes.set([TS_SYNC, 0x40, 0, 0x10], 0);
        writePacket(bytes, 32, GPS_PID, true, 0);
        writePacket(bytes, 32 + TS_SIZE, VIDEO_PID, true, 0);
        writePacket(bytes, 32 + 2 * TS_SIZE, VIDEO_PID, true, 1);
        // Lose the video sync and leave a plausible header in its payload.
        bytes[32 + 2 * TS_SIZE] = 0;
        bytes.set([TS_SYNC, 0x40, 0, 0x10], 64 + 2 * TS_SIZE);
        writePacket(bytes, 32 + 3 * TS_SIZE, GPS_PID, true, 1);
        writePacket(bytes, 32 + 4 * TS_SIZE, GPS_PID, true, 2);
        expect([...walkTsPackets(bytes)]).toEqual([32, 32 + TS_SIZE, 32 + 3 * TS_SIZE, 32 + 4 * TS_SIZE]);
    });

    it("retains a complete unconfirmed packet until the following header arrives", () => {
        const bytes = new Uint8Array(3 * TS_SIZE);
        writePacket(bytes, TS_SIZE, GPS_PID, true, 0);
        writePacket(bytes, 2 * TS_SIZE, GPS_PID, true, 1);
        const first = walkTsPackets(bytes.subarray(0, 2 * TS_SIZE), false).next();
        expect(first).toEqual({ done: true, value: TS_SIZE });
        expect([...walkTsPackets(bytes.subarray(first.value))]).toEqual([0, TS_SIZE]);
    });

    it.each([0, 1, 4])("keeps a final recovered packet before %i trailing bytes", (tail) => {
        const bytes = new Uint8Array(2 * TS_SIZE + tail);
        writePacket(bytes, TS_SIZE, GPS_PID, true, 0);
        expect([...walkTsPackets(bytes)]).toEqual([TS_SIZE]);
    });
});

describe("createTsPesScanPlanner", () => {
    it("resumes after a sync-free region spanning buffers without assuming packet alignment", async () => {
        const nextGps = 4 * 1024 * 1024 + 17;
        const bytes = new Uint8Array(nextGps + 2 * TS_SIZE);
        writePacket(bytes, 0, GPS_PID, true, 0);
        writePacket(bytes, TS_SIZE, GPS_PID, true, 1);
        writePacket(bytes, nextGps, GPS_PID, true, 2);
        writePacket(bytes, nextGps + TS_SIZE, GPS_PID, true, 2);
        const { file } = recordedFile(bytes);
        const driven = await drive(file, createTsPesScanPlanner(file, { pid: GPS_PID }));
        expect(driven.starts).toEqual([0, TS_SIZE, nextGps, nextGps + TS_SIZE]);
        expect(driven.ranges).toHaveLength(2);
        expect(driven.ranges[1]![0]).toBe(driven.ranges[0]![1]);
    });

    it.each([1, TS_SIZE - 1])("re-serves a recovered packet with only %i bytes in the prefix", async (partialBytes) => {
        const prefixLength = 4 * 1024 * 1024;
        const nextGps = prefixLength - partialBytes;
        const bytes = new Uint8Array(nextGps + 2 * TS_SIZE);
        writePacket(bytes, 0, GPS_PID, true, 0);
        writePacket(bytes, TS_SIZE, GPS_PID, true, 1);
        // A lost region; the next sync is in the prefix's partial tail.
        writePacket(bytes, nextGps, GPS_PID, true, 1);
        writePacket(bytes, nextGps + TS_SIZE, GPS_PID, true, 2);
        const prefix = bytes.subarray(0, prefixLength);
        const { file } = recordedFile(bytes);
        const driven = await drive(file, createTsPesScanPlanner(file, { pid: GPS_PID, prefix }));
        expect(driven.starts).toEqual([0, TS_SIZE, nextGps, nextGps + TS_SIZE]);
        expect(driven.ranges).toHaveLength(2);
        expect(driven.ranges[1]![0]).toBe(nextGps);
    });

    it("stops at an incomplete recovered packet at end of file", async () => {
        const bytes = new Uint8Array(4 * TS_SIZE);
        writePacket(bytes, 0, GPS_PID, true, 0);
        writePacket(bytes, TS_SIZE, GPS_PID, true, 1);
        writePacket(bytes, 3 * TS_SIZE, GPS_PID, true, 2);
        const { file } = recordedFile(bytes.subarray(0, bytes.length - 1));
        const driven = await drive(file, createTsPesScanPlanner(file, { pid: GPS_PID }));
        expect(driven.starts).toEqual([0, TS_SIZE]);
        expect(driven.ranges).toHaveLength(1);
    });

    it("visits every PES start of a steady stream while reading a fraction of it", async () => {
        const stream = buildStream({ seconds: 40, fillerPackets: jittered(5800, 600) });
        const { file, bytesRead } = recordedFile(stream.bytes);
        const driven = await drive(file, createTsPesScanPlanner(file, { pid: GPS_PID }));
        expect(driven.starts).toEqual(stream.gpsStarts);
        expectStrictlyIncreasing(driven.starts);
        expect(bytesRead(), "bytes read").toBeLessThan(file.size * 0.6);
    });

    it("reads the skipped stretch when the cadence breaks", async () => {
        // Second 20 carries three times the usual payload: the next PES lands
        // beyond even the wide window, and the counter check must send the
        // planner back over the stretch it jumped across.
        const stream = buildStream({
            seconds: 40,
            fillerPackets: (second) => (second === 20 ? 18_000 : jittered(5800, 600)(second)),
        });
        const { file } = recordedFile(stream.bytes);
        const driven = await drive(file, createTsPesScanPlanner(file, { pid: GPS_PID }));
        expect(driven.starts).toEqual(stream.gpsStarts);
        expectStrictlyIncreasing(driven.starts);
    });

    it("keeps a PES pair cadence by predicting over the period of two", async () => {
        // Enciphered/plaintext pairs: a short gap inside the pair, a long one
        // between pairs. Modelled as alternating filler counts.
        const stream = buildStream({
            seconds: 60,
            fillerPackets: (second) => (second % 2 === 0 ? 300 : jittered(5800, 400)(second)),
        });
        const { file, bytesRead } = recordedFile(stream.bytes);
        const driven = await drive(file, createTsPesScanPlanner(file, { pid: GPS_PID }));
        expect(driven.starts).toEqual(stream.gpsStarts);
        expect(bytesRead(), "bytes read").toBeLessThan(file.size * 0.7);
    });

    it("falls back to linear reading when the counter never advances", async () => {
        const stream = buildStream({ seconds: 30, fillerPackets: jittered(5800, 600), isCounterFrozen: true });
        const { file, bytesRead } = recordedFile(stream.bytes);
        const driven = await drive(file, createTsPesScanPlanner(file, { pid: GPS_PID }));
        expect(driven.starts).toEqual(stream.gpsStarts);
        expect(bytesRead(), "bytes read").toBe(file.size);
    });

    it("re-serves an unfinished PES body contiguously and reads a multi-packet PES once", async () => {
        const stream = buildStream({ seconds: 30, fillerPackets: jittered(5800, 600), packetsPerPes: 6 });
        const { file } = recordedFile(stream.bytes);
        const driven = await drive(file, createTsPesScanPlanner(file, { pid: GPS_PID }), 6);
        expect(driven.starts).toEqual(stream.gpsStarts);
        for (let i = 1; i < driven.ranges.length; i++) {
            const [previousStart, previousEnd] = driven.ranges[i - 1]!;
            const [start] = driven.ranges[i]!;
            expect(start, `buffer #${i} starts at or after the previous one`).toBeGreaterThanOrEqual(previousStart);
            expect(start, `buffer #${i} leaves no unread gap before a contiguous read`).toBeLessThanOrEqual(
                Math.max(previousEnd, start),
            );
        }
    });

    it("hands a held window out once, led by the body that straddles its start", async () => {
        // A PES skipped by the prediction whose body runs into the predicted
        // window: the counter check sends the planner back over the stretch,
        // the caller stops at the straddling PES, and the window must follow
        // the stretch as one contiguous buffer instead of being served again.
        // Filler counts place the skipped PES within a few packets of the
        // window start; the sweep covers the window-start rounding.
        for (let fillerBeforeSkipped = 4740; fillerBeforeSkipped <= 4760; fillerBeforeSkipped++) {
            const stream = buildStream({
                seconds: 30,
                packetsPerPes: 6,
                fillerPackets: (second) => (second === 20 ? fillerBeforeSkipped : second === 21 ? 1043 : 5800),
            });
            const { file } = recordedFile(stream.bytes);
            const driven = await drive(file, createTsPesScanPlanner(file, { pid: GPS_PID }), 6);
            expect(driven.starts, `filler ${fillerBeforeSkipped}`).toEqual(stream.gpsStarts);
        }
    });

    it("reads linearly when the counter step would repeat inside the window", async () => {
        // Eight packets per PES: three PES ahead the counter reads the same as
        // one PES ahead (24 = 8 mod 16). Two short seconds put the third PES
        // where the first is predicted; only a linear read keeps them all.
        const stream = buildStream({
            seconds: 30,
            packetsPerPes: 8,
            fillerPackets: (second) => (second === 20 || second === 21 ? 100 : second === 22 ? 5584 : 5800),
        });
        const { file, bytesRead } = recordedFile(stream.bytes);
        const driven = await drive(file, createTsPesScanPlanner(file, { pid: GPS_PID }), 8);
        expect(driven.starts).toEqual(stream.gpsStarts);
        expect(bytesRead(), "bytes read").toBe(file.size);
    });

    it("serves the probe prefix instead of reading the head again", async () => {
        const stream = buildStream({ seconds: 30, fillerPackets: jittered(5800, 600) });
        const { file, reads } = recordedFile(stream.bytes);
        const prefix = stream.bytes.subarray(0, 4 * 1024 * 1024);
        const driven = await drive(file, createTsPesScanPlanner(file, { pid: GPS_PID, prefix }));
        expect(driven.starts).toEqual(stream.gpsStarts);
        expect(
            reads.every(([start]) => start >= prefix.length),
            "no read inside the prefix",
        ).toBe(true);
    });

    it("stays linear until the PID is locked, then predicts", async () => {
        const stream = buildStream({ seconds: 40, fillerPackets: jittered(5800, 600) });
        const { file, bytesRead } = recordedFile(stream.bytes);
        const planner = createTsPesScanPlanner(file, { pid: null });
        const starts: number[] = [];
        let consumed = 0;
        let isLocked = false;
        for (let range = await planner.next(0); range !== null; range = await planner.next(consumed)) {
            const { start, buf } = range;
            let off = 0;
            while (off + TS_SIZE <= buf.length) {
                const b1 = buf[off + 1]!;
                const pid = ((b1 & 0x1f) << 8) | buf[off + 2]!;
                if ((b1 & 0x40) !== 0 && pid === GPS_PID) {
                    starts.push(start + off);
                    if (!isLocked) {
                        isLocked = true;
                        planner.setPid(GPS_PID);
                    }
                }
                off += TS_SIZE;
            }
            consumed = start + off;
        }
        expect(starts).toEqual(stream.gpsStarts);
        expect(bytesRead(), "bytes read").toBeLessThan(file.size * 0.6);
    });
});

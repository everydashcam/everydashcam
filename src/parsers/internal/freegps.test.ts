// Tests for the freeGPS scan machinery and the block-variant registry:
//  - streamScanFreeGps scan limits (regression: SCAN_HARD_LIMIT = 256 MB once
//    silently cut ~34 tail blocks of a real 329 MB Vantrue 4K sample);
//  - predicted-offset jump scan;
//  - variant parsing (Type 3 layouts, Type-8 recognize-and-bail, IQS Type-16,
//    Kenwood MN shift) with fixtures rebuilt from ExifTool hexdumps;
//  - the backward anchor-scan fallback + per-file consistency lock;
//  - the structural `gps ` table candidates (canonical/legacy layouts).

import { describe, it, expect } from "vitest";
import { KMH_TO_MS, KNOTS_TO_MS, type VendorFile } from "../types.js";
import { dedupRecords } from "../../parser.js";
import type { Mp4Index } from "./mp4-index.js";
import { freegpsPrimitive } from "../primitives/freegps.js";
import {
    createFreeGpsBlockParser,
    parseFreeGpsBlock,
    REXING_KODAK_VERSION,
    streamScanFreeGps,
    tryStructuralPath,
    _internal,
} from "./freegps.js";

/**
 * Sparse File mock: has the desired size but physically holds only the regions
 * we placed into it. slice() allocates only the requested range, zero-fills it,
 * then overlays the stored regions. This lets us run a 270 MB scan without
 * allocating 270 MB of memory upfront.
 */
class SparseFile {
    public name = "sparse-mock.mp4";
    public lastModified = 0;
    public type = "video/mp4";
    constructor(
        public size: number,
        private regions: Array<{ offset: number; data: Uint8Array }>,
    ) {}
    slice(start: number, end?: number): Blob {
        const e = Math.min(end ?? this.size, this.size);
        const len = Math.max(0, e - start);
        const buf = new Uint8Array(len);
        for (const r of this.regions) {
            const rEnd = r.offset + r.data.length;
            if (rEnd <= start || r.offset >= e) continue;
            const copyStart = Math.max(start, r.offset);
            const copyEnd = Math.min(e, rEnd);
            buf.set(r.data.subarray(copyStart - r.offset, copyEnd - r.offset), copyStart - start);
        }
        // Minimal Blob-like: streamScanFreeGps only calls .arrayBuffer().
        return {
            arrayBuffer: async () => buf.buffer,
        } as unknown as Blob;
    }
    arrayBuffer(): Promise<ArrayBuffer> {
        // streamScanFreeGps never calls this - stub for File type compatibility.
        return Promise.resolve(new Uint8Array(0).buffer);
    }
}

describe("streamScanFreeGps: hard-limit covers full dashcam segments", () => {
    it("finds blocks beyond 256MB - the size that previously cut Vantrue scan", async () => {
        // 270 MB file - just over the old 256 MB limit. Blocks every ~6 MB so
        // the tail-bail heuristic (8 MB without a hit) does not fire between blocks.
        const FILE_SIZE = 270 * 1024 ** 2;
        const STRIDE = 6 * 1024 ** 2;
        const regions: Array<{ offset: number; data: Uint8Array }> = [];
        // 24-byte payload: 8 bytes magic + 16 zeros. Parser will not recognize
        // the variant -> goes to skipped, which is fine: we test SCANNING, not parsing.
        const blockBytes = new Uint8Array(24);
        blockBytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
        let expected = 0;
        for (let off = 1024 ** 2; off + blockBytes.length <= FILE_SIZE; off += STRIDE) {
            regions.push({ offset: off, data: blockBytes });
            expected++;
        }

        const file = new SparseFile(FILE_SIZE, regions) as unknown as File;
        const result = await streamScanFreeGps(file);

        // All markers go to skipped (variant not matched), records=0.
        // What matters: ALL markers found, including those past 256 MB.
        expect(result.records.length + result.skipped.length).toBe(expected);
        expect(expected).toBeGreaterThan(40); // sanity: must have many blocks
        // Confirm the scan actually reached the tail: last marker is above 256 MB.
        const lastOff = regions[regions.length - 1]!.offset;
        expect(lastOff).toBeGreaterThan(256 * 1024 ** 2);
    }, 30_000);
});

describe("streamScanFreeGps: predicted-offset jump scan (heuristic 1)", () => {
    // Builds a synthetic SparseFile with freeGPS blocks at known offsets and
    // verifies the jump-scan path:
    //  1. With proper seedOffsets, all blocks are recovered with O(N x 256 KB)
    //     IO instead of O(file_size).
    //  2. Jitter within the median window is tolerated.
    //  3. Without seeds, falls back to linear scan and still finds everything.

    function buildSparseFile(
        size: number,
        blockOffsets: number[],
    ): {
        file: File;
        readBytesTotal: { value: number };
    } {
        const blockBytes = new Uint8Array(24);
        blockBytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
        const regions = blockOffsets.map((offset) => ({ offset, data: blockBytes }));
        const readBytesTotal = { value: 0 };
        class TrackingSparseFile {
            public name = "sparse.mp4";
            public lastModified = 0;
            public type = "video/mp4";
            public size = size;
            slice(start: number, end?: number): Blob {
                const e = Math.min(end ?? size, size);
                const len = Math.max(0, e - start);
                readBytesTotal.value += len;
                const buf = new Uint8Array(len);
                for (const r of regions) {
                    const rEnd = r.offset + r.data.length;
                    if (rEnd <= start || r.offset >= e) continue;
                    const copyStart = Math.max(start, r.offset);
                    const copyEnd = Math.min(e, rEnd);
                    buf.set(r.data.subarray(copyStart - r.offset, copyEnd - r.offset), copyStart - start);
                }
                return { arrayBuffer: async () => buf.buffer } as unknown as Blob;
            }
            arrayBuffer(): Promise<ArrayBuffer> {
                return Promise.resolve(new Uint8Array(0).buffer);
            }
        }
        return { file: new TrackingSparseFile() as unknown as File, readBytesTotal };
    }

    it("jump scan recovers all blocks with far less IO than linear", async () => {
        // 200 MB file, block every 1.5 MB - typical Novatek HEVC 4K spacing.
        const FILE_SIZE = 200 * 1024 ** 2;
        const STRIDE = 1.5 * 1024 ** 2;
        const offsets: number[] = [];
        for (let off = 256 * 1024; off + 24 <= FILE_SIZE; off += STRIDE) offsets.push(off);
        const { file, readBytesTotal } = buildSparseFile(FILE_SIZE, offsets);

        // Seed with first 3 offsets - what the 4 MB probe would yield.
        const seeds = offsets.slice(0, 3);
        const result = await streamScanFreeGps(file, undefined, seeds);

        // All blocks recovered.
        expect(result.records.length + result.skipped.length).toBe(offsets.length);
        // IO sanity: < 1/3 of full file size (predicted-offset path reads
        // ~256 KB per block). 200 MB / 1.5 MB = ~134 blocks × 256 KB ≈ 33 MB.
        // Hard cap at 80 MB leaves ample headroom for seed-coalesced read.
        expect(readBytesTotal.value).toBeLessThan(80 * 1024 ** 2);
    }, 30_000);

    it("jump scan tolerates jitter within median window", async () => {
        // Same as above but every 8th block is shifted by +200 KB - simulates
        // a large I-frame skewing one delta. Median-Δ should adapt.
        const FILE_SIZE = 200 * 1024 ** 2;
        const STRIDE = 1.5 * 1024 ** 2;
        const offsets: number[] = [];
        let i = 0;
        for (let off = 256 * 1024; off + 24 <= FILE_SIZE; off += STRIDE) {
            const jitter = i % 8 === 0 ? 200 * 1024 : 0;
            offsets.push(off + jitter);
            i++;
        }
        const { file } = buildSparseFile(FILE_SIZE, offsets);
        const seeds = offsets.slice(0, 3);
        const result = await streamScanFreeGps(file, undefined, seeds);

        // Expect at least 95% recovery - jitter within window radius should
        // all be found, occasional edge cases at window boundaries acceptable.
        const recovered = result.records.length + result.skipped.length;
        expect(recovered).toBeGreaterThan(offsets.length * 0.95);
    }, 30_000);

    it("falls back to linear scan when no seeds provided", async () => {
        // Without seeds, jump scan is skipped; linear path must still find all.
        const FILE_SIZE = 50 * 1024 ** 2;
        const STRIDE = 1.5 * 1024 ** 2;
        const offsets: number[] = [];
        for (let off = 256 * 1024; off + 24 <= FILE_SIZE; off += STRIDE) offsets.push(off);
        const { file } = buildSparseFile(FILE_SIZE, offsets);
        const result = await streamScanFreeGps(file); // no seeds
        expect(result.records.length + result.skipped.length).toBe(offsets.length);
    }, 30_000);

    // A parseBlock that counts how many blocks each scan pass parses. On a
    // clean jump-scan accept this fires ~once per block; a linear fallback
    // re-parses the whole prefix, ~doubling the count - so it detects whether
    // the yield check fell back without needing to peek inside jumpScanFreeGps.
    function countingParseBlock(): { parse: (p: DataView, n: string) => never[]; calls: () => number } {
        let calls = 0;
        return {
            parse: (_payload: DataView, _name: string) => {
                calls++;
                return [];
            },
            calls: () => calls,
        };
    }

    it("accepts the jump result when GPS legitimately ends partway (no linear rerun)", async () => {
        // GPS stops at 40% of the file (tunnel / parking). The old yield check
        // projected expectedHits to EOF, so 40%-worth of hits looked like a
        // failure and forced a full linear re-scan of the covered prefix. The
        // fix projects over the covered span, so the complete jump result stands.
        const FILE_SIZE = 100 * 1024 ** 2;
        const STRIDE = 1.5 * 1024 ** 2;
        const GPS_END = 40 * 1024 ** 2;
        const offsets: number[] = [];
        for (let off = 256 * 1024; off + 24 <= GPS_END; off += STRIDE) offsets.push(off);
        const { file } = buildSparseFile(FILE_SIZE, offsets);
        const seeds = offsets.slice(0, 3);
        const counter = countingParseBlock();
        const result = await streamScanFreeGps(file, undefined, seeds, counter.parse);
        // All real blocks recovered.
        expect(result.records.length + result.skipped.length).toBe(offsets.length);
        // Accepted: each block parsed once. A false fallback would re-parse the
        // whole prefix, pushing the count toward 2x.
        expect(counter.calls()).toBeLessThan(offsets.length * 1.5);
    }, 30_000);

    it("stays linear when the spacing is below the jump window and parses each block once", async () => {
        // Tight triplets (Δ=40 KB) with 180 KB gaps: the median spacing is
        // far below the 256 KB window, so a prediction would read overlapping
        // windows. The scan keeps its 4 MB chunks, finds every block and never
        // re-reads a region - the old yield check used to force a second,
        // linear pass over the same prefix here.
        const FILE_SIZE = 8 * 1024 ** 2;
        const TIGHT = 40 * 1024;
        const GAP = 180 * 1024;
        const offsets: number[] = [];
        let off = 256 * 1024;
        while (off + 24 <= FILE_SIZE) {
            offsets.push(off);
            offsets.push(off + TIGHT);
            offsets.push(off + 2 * TIGHT);
            off = off + 2 * TIGHT + GAP;
        }
        const { file } = buildSparseFile(FILE_SIZE, offsets);
        const seeds = offsets.slice(0, 3);
        const counter = countingParseBlock();
        const result = await streamScanFreeGps(file, undefined, seeds, counter.parse);
        expect(result.records.length + result.skipped.length).toBe(offsets.length);
        expect(counter.calls()).toBe(offsets.length);
    }, 30_000);

    it("bootstraps the jump from the linear pass when no seeds are given", async () => {
        // The first chunk already holds two consecutive blocks, so everything
        // past it is read by prediction: far below the 200 MB a linear pass costs.
        const FILE_SIZE = 200 * 1024 ** 2;
        const STRIDE = 1.5 * 1024 ** 2;
        const offsets: number[] = [];
        for (let off = 256 * 1024; off + 24 <= FILE_SIZE; off += STRIDE) offsets.push(off);
        const { file, readBytesTotal } = buildSparseFile(FILE_SIZE, offsets);
        const counter = countingParseBlock();
        const result = await streamScanFreeGps(file, undefined, undefined, counter.parse);
        expect(result.records.length + result.skipped.length).toBe(offsets.length);
        expect(counter.calls()).toBe(offsets.length);
        expect(readBytesTotal.value).toBeLessThan(80 * 1024 ** 2);
    }, 30_000);

    it("returns to linear after a missed prediction and resumes jumping once blocks reappear", async () => {
        // A 6 MB hole (four missing blocks - GPS dropped in a tunnel) halfway
        // through a 1.5 MB-stride file. The prediction misses at the hole; the
        // linear run crosses it within the tail allowance, re-establishes the
        // spacing from the next two blocks and hands back to the jump. The old
        // scan declared the array finished after two misses and lost the rest.
        const FILE_SIZE = 150 * 1024 ** 2;
        const STRIDE = 1.5 * 1024 ** 2;
        const HOLE_START = 75 * 1024 ** 2;
        const HOLE_END = HOLE_START + 6 * 1024 ** 2;
        const offsets: number[] = [];
        for (let off = 256 * 1024; off + 24 <= FILE_SIZE; off += STRIDE) {
            if (off >= HOLE_START && off < HOLE_END) continue;
            offsets.push(off);
        }
        const { file, readBytesTotal } = buildSparseFile(FILE_SIZE, offsets);
        const seeds = offsets.slice(0, 3);
        const counter = countingParseBlock();
        const result = await streamScanFreeGps(file, undefined, seeds, counter.parse);
        expect(result.records.length + result.skipped.length).toBe(offsets.length);
        expect(counter.calls()).toBe(offsets.length);
        expect(readBytesTotal.value).toBeLessThan(FILE_SIZE / 2);
    }, 30_000);

    it("waits for several missing blocks before ending a tail spaced wider than the fixed floor", async () => {
        // 9 MB stride (4K at 70+ Mbps). One block sits 700 KB late - outside
        // even the wide window - so the prediction misses and the linear run
        // has to cross a full stride to find it; with the spacing known, the
        // bail waits for three missing blocks (27 MB here, past the 16 MB floor).
        const FILE_SIZE = 120 * 1024 ** 2;
        const STRIDE = 9 * 1024 ** 2;
        const offsets: number[] = [];
        let i = 0;
        for (let off = 1024 ** 2; off + 24 <= FILE_SIZE; off += STRIDE) {
            offsets.push(i === 5 ? off + 700 * 1024 : off);
            i++;
        }
        const { file } = buildSparseFile(FILE_SIZE, offsets);
        const counter = countingParseBlock();
        const result = await streamScanFreeGps(file, undefined, offsets.slice(0, 2), counter.parse);
        expect(result.records.length + result.skipped.length).toBe(offsets.length);
        expect(counter.calls()).toBe(offsets.length);
    }, 30_000);

    it("bridges a spacing wider than 8 MB from a single seed", async () => {
        // One seed is all a 16 MB probe yields on a 63 Mbps 4K clip whose
        // first block sits past 8 MB (VIOFO A329): the second block lies
        // beyond the probe window. With no spacing known yet, the tail
        // allowance bridges the gap on its own. A fixed 8 MB floor ended the
        // scan after the seed: the chunk grid starts at the seed, so the bail
        // check fired right before the chunk holding the next block.
        const FILE_SIZE = 120 * 1024 ** 2;
        const STRIDE = 8.2 * 1024 ** 2;
        const offsets: number[] = [];
        for (let off = 8.3 * 1024 ** 2; off + 24 <= FILE_SIZE; off += STRIDE) offsets.push(Math.floor(off));
        const { file } = buildSparseFile(FILE_SIZE, offsets);
        const counter = countingParseBlock();
        const result = await streamScanFreeGps(file, undefined, offsets.slice(0, 1), counter.parse);
        expect(result.records.length + result.skipped.length).toBe(offsets.length);
        expect(counter.calls()).toBe(offsets.length);
    }, 30_000);

    it("resumes right after the last seed, so blocks closer than a payload window are kept", async () => {
        // Blocks 20 KB apart (a per-frame dialect at a low bitrate) and the
        // probe's eight seeds: resuming one payload window past the last seed
        // would skip the block that follows it.
        const offsets: number[] = [];
        for (let off = 64 * 1024; off < 2 * 1024 ** 2; off += 20 * 1024) offsets.push(off);
        const { file } = buildSparseFile(4 * 1024 ** 2, offsets);
        const counter = countingParseBlock();
        const result = await streamScanFreeGps(file, undefined, offsets.slice(0, 8), counter.parse);
        expect(result.records.length + result.skipped.length).toBe(offsets.length);
        expect(counter.calls()).toBe(offsets.length);
    });
});

// ===== Block-variant fixtures and builders =====

/** Parses a whitespace-separated hex dump into bytes. */
function bytesFromHexDump(dump: string): Uint8Array {
    return new Uint8Array(
        dump
            .trim()
            .split(/\s+/)
            .map((h) => Number.parseInt(h, 16)),
    );
}

/** ExifTool hexdumps start at the block ATOM ([u32 size]['freeGPS ']...);
 *  parseFreeGpsBlock expects a DataView starting at the literal - strip the
 *  4-byte size prefix. */
function literalViewFromAtomBytes(atom: Uint8Array): DataView {
    return new DataView(atom.buffer, atom.byteOffset + 4, atom.byteLength - 4);
}

/**
 * Builds a Type-3 block with the canonical relative geometry: 6 x u32 LE
 * datetime at anchor-24, 'A'[NS][EW] + pad at the anchor, lat/lon/speed/course
 * float32 LE at anchor+4..+19. anchor 68 = LAYOUT_DEFAULT, 40 = LEGACY,
 * 36 = ALT, 84 = KENWOOD_MN; anything else = a non-standard layout for the
 * anchor-scan fallback.
 */
function buildCanonicalType3Block(opts: {
    anchor: number;
    len?: number;
    h?: number;
    mi?: number;
    s?: number;
    y?: number;
    mo?: number;
    d?: number;
    active?: "A" | "V";
    ns?: "N" | "S";
    ew?: "E" | "W";
    latRaw?: number;
    lonRaw?: number;
    speedKnots?: number;
    course?: number;
}): DataView {
    const {
        anchor,
        len = Math.max(anchor + 20, 128),
        h = 10,
        mi = 20,
        s = 30,
        y = 21,
        mo = 6,
        d = 15,
        active = "A",
        ns = "N",
        ew = "E",
        latRaw = 5006.0, // DDmm.mmmm -> 50.1 deg
        lonRaw = 3003.0, // -> 30.05 deg
        speedKnots = 10,
        course = 90,
    } = opts;
    const bytes = new Uint8Array(len);
    bytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
    const dv = new DataView(bytes.buffer);
    const dt = anchor - 24;
    [h, mi, s, y, mo, d].forEach((value, i) => {
        dv.setUint32(dt + i * 4, value, true);
    });
    bytes[anchor] = active.charCodeAt(0);
    bytes[anchor + 1] = ns.charCodeAt(0);
    bytes[anchor + 2] = ew.charCodeAt(0);
    dv.setFloat32(anchor + 4, latRaw, true);
    dv.setFloat32(anchor + 8, lonRaw, true);
    dv.setFloat32(anchor + 12, speedKnots, true);
    dv.setFloat32(anchor + 16, course, true);
    return dv;
}

function setAscii(dv: DataView, offset: number, text: string): void {
    for (let i = 0; i < text.length; i++) dv.setUint8(offset + i, text.charCodeAt(i));
}

function buildYouqingBlock(
    overrides: {
        active?: "A" | "V";
        ns?: "N" | "S";
        ew?: "E" | "W";
        latRaw?: number;
        lonRaw?: number;
        speedKnots?: number;
        course?: number;
    } = {},
): DataView {
    const bytes = new Uint8Array(160);
    bytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
    const dv = new DataView(bytes.buffer);
    dv.setUint32(8, 0x90, true);
    setAscii(dv, 12, "YOUQINGGPS");
    dv.setFloat32(36, overrides.latRaw ?? 4806, true); // 48.1°
    dv.setFloat32(40, overrides.lonRaw ?? 3003, true); // 30.05°
    [7, 35, 13, 26, 8, 25].forEach((value, i) => {
        dv.setUint32(44 + i * 4, value, true);
    });
    setAscii(dv, 68, `${overrides.active ?? "A"}${overrides.ns ?? "N"}${overrides.ew ?? "E"}`);
    dv.setFloat32(92, overrides.speedKnots ?? 20, true);
    dv.setFloat32(96, overrides.course ?? 108.5, true);
    return dv;
}

describe("parseFreeGpsBlock: variant registry (multi-record contract)", () => {
    it("LAYOUT_DEFAULT block parses to a one-element array", () => {
        const records = parseFreeGpsBlock(buildCanonicalType3Block({ anchor: 68 }), "a.mp4");
        expect(records).toHaveLength(1);
        const r = records[0]!;
        expect(r.lat).toBeCloseTo(50.1, 6);
        expect(r.lon).toBeCloseTo(30.05, 6);
        expect(r.speedMs).toBeCloseTo(10 * KNOTS_TO_MS, 6);
        expect(r.bearingDeg).toBeCloseTo(90, 6);
        expect(r.unixSeconds).toBe(Date.UTC(2021, 5, 15, 10, 20, 30) / 1000);
        expect(r.timeUnsynced).toBeUndefined();
    });

    it("void ('V') and unrecognized blocks yield an empty array", () => {
        expect(parseFreeGpsBlock(buildCanonicalType3Block({ anchor: 68, active: "V" }), "a.mp4")).toEqual([]);
        const zeros = new Uint8Array(128);
        zeros.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
        expect(parseFreeGpsBlock(new DataView(zeros.buffer), "a.mp4")).toEqual([]);
    });

    it("Vantrue NMEA-embedded block returns the sentence's records", () => {
        const bytes = new Uint8Array(256);
        bytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
        const dv = new DataView(bytes.buffer);
        setAscii(dv, 100, "$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A\r\n");
        const records = parseFreeGpsBlock(dv, "v.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(48.1173, 4);
        expect(records[0]!.lon).toBeCloseTo(11.5167, 4);
    });
});

describe("Type-8 recognize-and-bail (Akaso V1 / Redtiger F7N, encrypted upstream)", () => {
    // Verbatim hexdumps from ExifTool QuickTimeStream.pl:1964-1984 (v13.59).
    // The Akaso block is the demonstrating case: decoded as LAYOUT_DEFAULT it
    // used to emit lat 0.0 / lon ~0.00077 deg with a valid 2019-05-29
    // timestamp. The Redtiger block's garbage lon fails the ddmm gate even on
    // the old path - kept as a second shape sample.
    const AKASO_V1_ATOM = bytesFromHexDump(`
        00 00 80 00 66 72 65 65 47 50 53 20 78 00 00 00
        59 6e 64 41 6b 61 73 6f 43 61 72 00 00 00 00 00
        30 30 30 30 30 00 00 00 00 00 00 00 00 00 00 00
        0e 00 00 00 27 00 00 00 2c 00 00 00 e3 07 00 00
        05 00 00 00 1d 00 00 00 41 4e 45 00 00 00 00 00
        f1 4e 3e 3d 90 df ca 40 e3 50 bf 0b 0b 31 a0 40
        4b dc c8 41 9a 79 a7 43 34 58 43 31 4f 37 31 35
        35 31 32 36 36 35 37 35 59 4e 44 53 0d e7 cc f9
        00 00 00 00 05 00 00 00 00 00 00 00 00 00 00 00
    `);
    const REDTIGER_F7N_ATOM = bytesFromHexDump(`
        00 00 40 00 66 72 65 65 47 50 53 20 f0 01 00 00
        0a 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
        01 00 00 00 b0 56 50 01 7b 18 68 45 17 02 3f 46
        13 00 00 00 01 00 00 00 06 00 00 00 15 00 00 00
        0c 00 00 00 1c 00 00 00 41 4e 57 00 00 00 00 00
        80 d4 26 4e 36 11 b5 40 74 b5 15 7b cd 7b f3 40
        0a d7 a3 3d cd 4c 4e 43 38 34 37 41 45 48 31 36
        33 36 30 38 32 34 35 37 59 53 4b 4a 01 00 00 00
        ec ff ff ff 00 00 00 00 0e 00 00 00 01 00 00 00
        0a 00 00 00 e5 07 00 00 0c 00 00 00 1c 00 00 00
    `);

    it("claims both upstream hexdump blocks and emits nothing", () => {
        expect(parseFreeGpsBlock(literalViewFromAtomBytes(AKASO_V1_ATOM), "a.mp4")).toEqual([]);
        expect(parseFreeGpsBlock(literalViewFromAtomBytes(REDTIGER_F7N_ATOM), "a.mp4")).toEqual([]);
    });

    it("does not let the anchor-scan fallback resurrect a Type-8 block", () => {
        // The variant claims the block before the fallback can see it - two
        // consecutive identical blocks must NOT satisfy the consistency lock.
        const parse = createFreeGpsBlockParser();
        expect(parse(literalViewFromAtomBytes(AKASO_V1_ATOM), "a.mp4")).toEqual([]);
        expect(parse(literalViewFromAtomBytes(AKASO_V1_ATOM), "a.mp4")).toEqual([]);
        expect(parse(literalViewFromAtomBytes(AKASO_V1_ATOM), "a.mp4")).toEqual([]);
    });

    it("does not claim a genuine LAYOUT_DEFAULT fix (nonzero latitude bytes)", () => {
        // Bytes 72-75 of a real fix hold a nonzero DDDmm.mmmm float - the
        // \0{5} discriminator fails, the float decode proceeds.
        const records = parseFreeGpsBlock(buildCanonicalType3Block({ anchor: 68 }), "a.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(50.1, 6);
    });
});

describe("YOUQINGGPS plaintext variant", () => {
    it("parses UTC, DDmm coordinates, knot speed and course", () => {
        const records = parseFreeGpsBlock(
            buildYouqingBlock({ ns: "S", ew: "W", speedKnots: 30, course: 142.5 }),
            "redtiger.mp4",
        );

        expect(records).toHaveLength(1);
        const record = records[0]!;
        expect(record.unixSeconds).toBe(Date.UTC(2026, 7, 25, 7, 35, 13) / 1000);
        expect(record.lat).toBeCloseTo(-48.1, 6);
        expect(record.lon).toBeCloseTo(-30.05, 6);
        expect(record.speedMs).toBeCloseTo(30 * KNOTS_TO_MS, 6);
        expect(record.bearingDeg).toBeCloseTo(142.5, 6);
        expect(record.mp4Filename).toBe("redtiger.mp4");
        expect(record.timeUnsynced).toBeUndefined();
    });

    it("claims void and malformed banner-matched blocks without emitting garbage", () => {
        expect(parseFreeGpsBlock(buildYouqingBlock({ active: "V" }), "a.mp4")).toEqual([]);
        expect(parseFreeGpsBlock(buildYouqingBlock({ latRaw: 4861 }), "a.mp4")).toEqual([]);
        expect(parseFreeGpsBlock(buildYouqingBlock({ course: 361 }), "a.mp4")).toEqual([]);

        const truncated = buildYouqingBlock();
        expect(parseFreeGpsBlock(new DataView(truncated.buffer, 0, 64), "a.mp4")).toEqual([]);
    });

    it("wins before the encrypted Type-8 and generic Type-3 aliases", () => {
        const block = buildYouqingBlock();
        const matching = _internal.FREE_GPS_VARIANTS.filter((variant) => variant.matches(block));
        expect(matching.map((variant) => variant.name)).toEqual([
            "YOUQINGGPS",
            "Akaso/Redtiger Type 8 (encrypted, recognize-and-bail)",
            "VIOFO Type 3",
        ]);
        expect(_internal.FREE_GPS_VARIANTS.find((variant) => variant.matches(block))?.name).toBe("YOUQINGGPS");
    });
});

describe("IQS Type-16 int32 sub-variant of LAYOUT_DEFAULT", () => {
    // Synthetic block, field spec from ExifTool QuickTimeStream.pl:2298-2309
    // (v13.59); header string from the upstream sample ("IQS_A7_20150417" at
    // atom 16 = literal 12, dated Mar 29 2017).
    function buildIqsBlock(opts: { ns?: "N" | "S"; ew?: "E" | "W"; lat?: number; lon?: number; speed?: number }) {
        const { ns = "N", ew = "E", lat = 501234567, lon = 307654321, speed = 1234 } = opts;
        const dv = buildCanonicalType3Block({ anchor: 68, ns, ew, h: 16, mi: 5, s: 33, y: 17, mo: 3, d: 29 });
        setAscii(dv, 12, "IQS_A7_20150417");
        dv.setInt32(72, lat, true); // decimal degrees * 1e7
        dv.setInt32(76, lon, true);
        dv.setInt32(80, speed, true); // m/s * 100
        dv.setFloat32(84, 123456, true); // altitude m * 1000 - dropped
        return dv;
    }

    it("decodes int32 fields: decimal degrees, m/s speed, bearing 0", () => {
        const records = parseFreeGpsBlock(buildIqsBlock({}), "iqs.mp4");
        expect(records).toHaveLength(1);
        const r = records[0]!;
        expect(r.lat).toBeCloseTo(50.1234567, 7);
        expect(r.lon).toBeCloseTo(30.7654321, 7);
        expect(r.speedMs).toBeCloseTo(12.34, 6); // NO knots conversion
        expect(r.bearingDeg).toBe(0); // literal 84 is altitude, not course
        expect(r.unixSeconds).toBe(Date.UTC(2017, 2, 29, 16, 5, 33) / 1000);
    });

    it("applies hemisphere sign via Math.abs (no double negation on signed ints)", () => {
        const records = parseFreeGpsBlock(
            buildIqsBlock({ ns: "S", ew: "W", lat: -501234567, lon: -307654321 }),
            "iqs.mp4",
        );
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(-50.1234567, 7);
        expect(records[0]!.lon).toBeCloseTo(-30.7654321, 7);
    });

    it("bails on the ATC Type-11 ring buffer carrying the same IQS header", () => {
        // ATC blocks (ExifTool :2047, sample header "IQS20130306B" :2052)
        // carry 'ATC' at literal 65-67. That overlaps the day field's high
        // bytes, so the datetime gate rejects it even before the explicit ATC
        // check - either way the block must land in skipped, never decoded.
        const dv = buildIqsBlock({});
        setAscii(dv, 65, "ATC");
        expect(parseFreeGpsBlock(dv, "atc.mp4")).toEqual([]);
    });
});

describe("LAYOUT_KENWOOD_MN (+48-shifted Type 3, DRV-A510W)", () => {
    // Verbatim hexdump from ExifTool QuickTimeStream.pl:1755-1763 (v13.59).
    // Decodes to 2026-02-28 12:16:22 (absolute year -> local-clock quirk),
    // 53.1486 N / 2.1753 W, 27.09 kn, course 308.26, accel (-7,-1,1)/256.
    const KENWOOD_ATOM = bytesFromHexDump(`
        00 00 40 00 66 72 65 65 47 50 53 20 f0 03 00 00
        4d 4e 3a 44 52 56 2d 41 35 31 30 57 40 56 31 2e
        37 5f 42 44 5a 49 43 5a 5f 43 00 00 00 00 00 00
        00 00 00 00 00 00 00 00 3a 3a 73 74 61 72 74 40
        0c 00 00 00 10 00 00 00 16 00 00 00 ea 07 00 00
        02 00 00 00 1c 00 00 00 41 4e 57 00 55 e7 a5 45
        d7 84 52 43 52 b8 d8 41 48 21 9a 43 f9 ff ff ff
        ff ff ff ff 01 00 00 00 00 00 00 00 00 00 00 00
    `);
    function kenwoodView(): DataView {
        // Fresh copy per test - some tests mutate fields.
        return literalViewFromAtomBytes(new Uint8Array(KENWOOD_ATOM));
    }

    it("decodes the upstream hexdump: shifted offsets, knots, accel triple", () => {
        const records = parseFreeGpsBlock(kenwoodView(), "k.mp4");
        expect(records).toHaveLength(1);
        const r = records[0]!;
        expect(r.lat).toBeCloseTo(53.1486, 4);
        expect(r.lon).toBeCloseTo(-2.17532, 4); // 'W' -> negative
        expect(r.speedMs).toBeCloseTo(27.09 * KNOTS_TO_MS, 4);
        expect(r.bearingDeg).toBeCloseTo(308.26, 2);
        expect(r.accelXg).toBeCloseTo(-7 / 256, 6);
        expect(r.accelYg).toBeCloseTo(-1 / 256, 6);
        expect(r.accelZg).toBeCloseTo(1 / 256, 6);
    });

    it("absolute year (>= 2000) = local-clock quirk -> timeUnsynced", () => {
        const records = parseFreeGpsBlock(kenwoodView(), "k.mp4");
        expect(records[0]!.timeUnsynced).toBe(true);
        // unixSeconds still carries the field values (re-anchored downstream).
        expect(records[0]!.unixSeconds).toBe(Date.UTC(2026, 1, 28, 12, 16, 22) / 1000);
    });

    it("year-since-2000 = normal UTC path, no timeUnsynced", () => {
        const dv = kenwoodView();
        dv.setUint32(72, 26, true); // year field at datetime+12
        const records = parseFreeGpsBlock(dv, "k.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.timeUnsynced).toBeUndefined();
        expect(records[0]!.unixSeconds).toBe(Date.UTC(2026, 1, 28, 12, 16, 22) / 1000);
    });

    it("ignores the two accel placeholder patterns (all-zero, int16 counter)", () => {
        const zeroed = kenwoodView();
        for (let i = 104; i < 116; i++) zeroed.setUint8(i, 0);
        const r1 = parseFreeGpsBlock(zeroed, "k.mp4")[0]!;
        expect([r1.accelXg, r1.accelYg, r1.accelZg]).toEqual([0, 0, 0]);

        const counter = kenwoodView();
        const pattern = [0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00, 0x05, 0x00, 0x06, 0x00];
        pattern.forEach((b, i) => {
            counter.setUint8(104 + i, b);
        });
        const r2 = parseFreeGpsBlock(counter, "k.mp4")[0]!;
        expect([r2.accelXg, r2.accelYg, r2.accelZg]).toEqual([0, 0, 0]);
    });

    it("a 104-byte block (no accel tail) still decodes, accel 0", () => {
        const atom = new Uint8Array(KENWOOD_ATOM.subarray(0, 108)); // 4 + 104
        const records = parseFreeGpsBlock(literalViewFromAtomBytes(atom), "k.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.accelXg).toBe(0);
    });

    it("does not claim the other layouts and is not claimed by them", () => {
        // An ALT block (anchor 36) has no [AV] byte at literal 84.
        const alt = buildCanonicalType3Block({ anchor: 36 });
        const altRecords = parseFreeGpsBlock(alt, "alt.mp4");
        expect(altRecords).toHaveLength(1);
        expect(altRecords[0]!.lat).toBeCloseTo(50.1, 6); // decoded via ALT offsets
        expect(altRecords[0]!.timeUnsynced).toBeUndefined(); // no Kenwood quirk
        // The Kenwood block decodes via Kenwood offsets - proven by the value
        // assertions above (DEFAULT/LEGACY/ALT would read different bytes).
    });
});

describe("createFreeGpsBlockParser: cold-start clock jump", () => {
    // Real A119 Mini 2 shape: pre-fix blocks carry the RTC datetime at the
    // alt geometry (datetime@12) but their status bytes are 'V00' / ' 00' -
    // no variant signature matches, so they land on the unclaimed path where
    // the datetime collection lives.
    function preFixBlock(h: number, mi: number, s: number): DataView {
        const dv = buildCanonicalType3Block({ anchor: 36, active: "V", h, mi, s, y: 26, mo: 4, d: 6 });
        setAscii(dv, 37, "00"); // real firmware writes '0''0' hemispheres before the fix
        return dv;
    }

    function fixBlock(h: number, mi: number, s: number): DataView {
        return buildCanonicalType3Block({ anchor: 36, h, mi, s, y: 26, mo: 4, d: 6 });
    }

    it("measures a +3h zone jump across the first fix", () => {
        const parser = createFreeGpsBlockParser();
        expect(parser(preFixBlock(11, 21, 20), "a.mp4")).toEqual([]);
        expect(parser(preFixBlock(11, 22, 4), "a.mp4")).toEqual([]);
        expect(parser(fixBlock(14, 22, 5), "a.mp4")).toHaveLength(1);
        expect(parser.coldStartClockJumpSec()).toBe(10_800);
    });

    it("measures a negative zone jump (western hemisphere firmware)", () => {
        const parser = createFreeGpsBlockParser();
        expect(parser(preFixBlock(20, 0, 0), "a.mp4")).toEqual([]);
        expect(parser(fixBlock(15, 0, 1), "a.mp4")).toHaveLength(1);
        expect(parser.coldStartClockJumpSec()).toBe(-18_000);
    });

    it("returns null when the jump is below one zone-grid step", () => {
        const parser = createFreeGpsBlockParser();
        expect(parser(preFixBlock(11, 22, 4), "a.mp4")).toEqual([]);
        expect(parser(fixBlock(11, 22, 5), "a.mp4")).toHaveLength(1);
        expect(parser.coldStartClockJumpSec()).toBeNull();
    });

    it("returns null when the snap residual exceeds the drift tolerance", () => {
        const parser = createFreeGpsBlockParser();
        expect(parser(preFixBlock(11, 22, 4), "a.mp4")).toEqual([]);
        // 3h 2min 1s after the last pre-fix block: 121 s past the grid point.
        expect(parser(fixBlock(14, 24, 5), "a.mp4")).toHaveLength(1);
        expect(parser.coldStartClockJumpSec()).toBeNull();
    });

    it("returns null when the jump is wider than any real UTC offset", () => {
        const parser = createFreeGpsBlockParser();
        // Stale RTC restored two days behind: 2d + 3h is an exact multiple of
        // the grid, so the residual check waves it through - only the
        // magnitude bound separates it from a zone.
        const stale = buildCanonicalType3Block({ anchor: 36, active: "V", h: 11, mi: 22, s: 5, y: 26, mo: 4, d: 4 });
        setAscii(stale, 37, "00");
        expect(parser(stale, "a.mp4")).toEqual([]);
        expect(parser(fixBlock(14, 22, 5), "a.mp4")).toHaveLength(1);
        expect(parser.coldStartClockJumpSec()).toBeNull();
    });

    it("returns null on a warm start (first block already carries a fix)", () => {
        const parser = createFreeGpsBlockParser();
        expect(parser(fixBlock(14, 22, 5), "a.mp4")).toHaveLength(1);
        expect(parser(preFixBlock(14, 22, 6), "a.mp4")).toEqual([]); // mid-file loss, ignored
        expect(parser(fixBlock(14, 22, 7), "a.mp4")).toHaveLength(1);
        expect(parser.coldStartClockJumpSec()).toBeNull();
    });

    it("pairs the fix only with its own layout's pre-fix datetime", () => {
        const parser = createFreeGpsBlockParser();
        // Pre-fix datetime readable ONLY at the default geometry (datetime@44);
        // the fix arrives on the alt geometry - no alt bucket, no measurement.
        const defaultPreFix = buildCanonicalType3Block({
            anchor: 68,
            active: "V",
            h: 11,
            mi: 22,
            s: 4,
            y: 26,
            mo: 4,
            d: 6,
        });
        setAscii(defaultPreFix, 69, "00");
        expect(parser(defaultPreFix, "a.mp4")).toEqual([]);
        expect(parser(fixBlock(14, 22, 5), "a.mp4")).toHaveLength(1);
        expect(parser.coldStartClockJumpSec()).toBeNull();
    });
});

describe("createFreeGpsBlockParser: backward anchor-scan fallback", () => {
    const NON_STANDARD_ANCHOR = 96; // not 68/40/36/84 - no fixed layout matches

    it("locks after 2 consecutive blocks at the same anchor: 2 blocks -> 1 record", () => {
        const parse = createFreeGpsBlockParser();
        const block = () => buildCanonicalType3Block({ anchor: NON_STANDARD_ANCHOR });
        // First validating block at a new anchor is withheld (no retroactive emission).
        expect(parse(block(), "x.mp4")).toEqual([]);
        // Second consecutive block pins the anchor and emits.
        const second = parse(block(), "x.mp4");
        expect(second).toHaveLength(1);
        expect(second[0]!.lat).toBeCloseTo(50.1, 6);
        expect(second[0]!.lon).toBeCloseTo(30.05, 6);
        expect(second[0]!.speedMs).toBeCloseTo(10 * KNOTS_TO_MS, 6);
        // Pinned: subsequent blocks emit immediately.
        expect(parse(block(), "x.mp4")).toHaveLength(1);
    });

    it("ignores a decoy triple that fails validation and locks on the real anchor", () => {
        const parse = createFreeGpsBlockParser();
        const block = () => {
            const dv = buildCanonicalType3Block({ anchor: NON_STANDARD_ANCHOR, len: 256 });
            // Decoy 'ANE' at a higher offset (backward scan sees it first) with
            // invalid surroundings: datetime fields are zeros (mo=0 fails) and
            // coords are zeros (near-(0,0) reject) - validation skips it.
            setAscii(dv, 200, "ANE");
            return dv;
        };
        expect(parse(block(), "x.mp4")).toEqual([]);
        const second = parse(block(), "x.mp4");
        expect(second).toHaveLength(1);
        expect(second[0]!.lat).toBeCloseTo(50.1, 6);
    });

    it("never emits for blocks that validate nowhere", () => {
        const parse = createFreeGpsBlockParser();
        const garbage = () => {
            const bytes = new Uint8Array(256).fill(0xab);
            bytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
            // A triple with garbage around it - datetime range checks fail.
            const dv = new DataView(bytes.buffer);
            setAscii(dv, 120, "ANE");
            return dv;
        };
        for (let i = 0; i < 5; i++) expect(parse(garbage(), "x.mp4")).toEqual([]);
    });

    it("a non-validating block breaks the consecutive chain", () => {
        const parse = createFreeGpsBlockParser();
        const valid = () => buildCanonicalType3Block({ anchor: NON_STANDARD_ANCHOR });
        const invalid = () => {
            const bytes = new Uint8Array(128);
            bytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
            return new DataView(bytes.buffer);
        };
        expect(parse(valid(), "x.mp4")).toEqual([]); // pending
        expect(parse(invalid(), "x.mp4")).toEqual([]); // resets pending
        expect(parse(valid(), "x.mp4")).toEqual([]); // pending again
        expect(parse(valid(), "x.mp4")).toHaveLength(1); // now locked
    });

    it("once pinned, the anchor stays pinned - no rediscovery at other offsets", () => {
        const parse = createFreeGpsBlockParser();
        const at96 = () => buildCanonicalType3Block({ anchor: NON_STANDARD_ANCHOR });
        const at112 = () => buildCanonicalType3Block({ anchor: 112 });
        parse(at96(), "x.mp4");
        expect(parse(at96(), "x.mp4")).toHaveLength(1); // pinned at 96
        // A block valid only at 112 decodes as nothing at the pinned offset.
        expect(parse(at112(), "x.mp4")).toEqual([]);
        // A void fix at the pinned offset is skipped, the pin survives.
        expect(parse(buildCanonicalType3Block({ anchor: NON_STANDARD_ANCHOR, active: "V" }), "x.mp4")).toEqual([]);
        expect(parse(at96(), "x.mp4")).toHaveLength(1);
    });

    it("rejects near-(0,0) decodes (int32-dialect denormal misreads)", () => {
        // int32 deg*1e7 coordinates reinterpreted as float32 are denormals
        // ~1e-40 that pass the ddmm range checks - the null-island guard must
        // keep them out even with a consistent anchor.
        const parse = createFreeGpsBlockParser();
        const block = () => buildCanonicalType3Block({ anchor: NON_STANDARD_ANCHOR, latRaw: 1e-40, lonRaw: 1e-40 });
        expect(parse(block(), "x.mp4")).toEqual([]);
        expect(parse(block(), "x.mp4")).toEqual([]);
        expect(parse(block(), "x.mp4")).toEqual([]);
    });

    it("a renamed-70mai-dialect block never emits through the generic parser", () => {
        // 70mai blocks (ddmm.mmmm*1e5 int32 coords at offset 27) are parsed by their own
        // injected parser; through the GENERIC factory they must yield nothing.
        const build70mai = (): DataView => {
            const bytes = new Uint8Array(64);
            bytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
            const dv = new DataView(bytes.buffer);
            dv.setUint16(8, 0x01ed, true);
            dv.setUint16(14, 0x01ed, true);
            dv.setUint8(26, 0x41); // 'A'
            dv.setInt32(27, 500000000, true); // 50.0 deg
            dv.setInt32(31, 300000000, true); // 30.0 deg
            dv.setInt32(35, 45, true);
            return dv;
        };
        const parse = createFreeGpsBlockParser();
        expect(parse(build70mai(), "NO123.MP4")).toEqual([]);
        expect(parse(build70mai(), "NO123.MP4")).toEqual([]);
        expect(parse(build70mai(), "NO123.MP4")).toEqual([]);
    });

    it("fixed-layout blocks parse identically through the factory (variant path, no lock)", () => {
        const parse = createFreeGpsBlockParser();
        // Single block, immediate emission - the lock applies only to
        // dynamically discovered anchors, not registry variants.
        const viaFactory = parse(buildCanonicalType3Block({ anchor: 68 }), "x.mp4");
        const viaRegistry = parseFreeGpsBlock(buildCanonicalType3Block({ anchor: 68 }), "x.mp4");
        expect(viaFactory).toEqual(viaRegistry);
        expect(viaFactory).toHaveLength(1);
    });

    it("a truncated magic-bearing payload after pinning returns [] instead of throwing", () => {
        // Power-loss tail: the linear scan parses the file's FINAL block
        // truncated at EOF (the defer-to-next-chunk guard is skipped at
        // chunkEnd === fileSize), so the pinned path sees payloads far
        // shorter than anchor + 20. A RangeError here is not a
        // WrongFormatError - the registry would discard the WHOLE file's
        // records over one truncated tail block.
        const parse = createFreeGpsBlockParser();
        // Pin the anchor with two full-size blocks first.
        parse(buildCanonicalType3Block({ anchor: NON_STANDARD_ANCHOR }), "x.mp4");
        expect(parse(buildCanonicalType3Block({ anchor: NON_STANDARD_ANCHOR }), "x.mp4")).toHaveLength(1);
        for (const len of [8, 64, 100]) {
            const bytes = new Uint8Array(len);
            bytes.set(_internal.FREE_GPS_MAGIC_BYTES.subarray(0, len), 0);
            expect(parse(new DataView(bytes.buffer), "x.mp4")).toEqual([]);
        }
        // The pin survives the truncated blocks.
        expect(parse(buildCanonicalType3Block({ anchor: NON_STANDARD_ANCHOR }), "x.mp4")).toHaveLength(1);
    });

    it("absolute-year records from a discovered anchor are quarantined as timeUnsynced", () => {
        // The only known absolute-year writer in this geometry is the Kenwood
        // local-clock mode (ExifTool applies yr >= 2000 local-time handling to
        // the whole Type-3 branch). Without the quarantine a Kenwood-shaped
        // block that missed a fixed-layout byte gate would re-enter here and
        // poison estimateTzByFingerprint with local-as-UTC stamps.
        const parse = createFreeGpsBlockParser();
        const block = () => buildCanonicalType3Block({ anchor: NON_STANDARD_ANCHOR, y: 2026 });
        expect(parse(block(), "x.mp4")).toEqual([]); // pending
        const second = parse(block(), "x.mp4");
        expect(second).toHaveLength(1);
        expect(second[0]!.timeUnsynced).toBe(true);
        // 2-digit years stay honest UTC through the same path.
        const parse2 = createFreeGpsBlockParser();
        parse2(buildCanonicalType3Block({ anchor: NON_STANDARD_ANCHOR, y: 21 }), "x.mp4");
        const synced = parse2(buildCanonicalType3Block({ anchor: NON_STANDARD_ANCHOR, y: 21 }), "x.mp4");
        expect(synced).toHaveLength(1);
        expect(synced[0]!.timeUnsynced).toBeUndefined();
    });

    it("a variant match with an empty parse shadows the fallback (dispatcher contract)", () => {
        // A block with a VOID Type-3 signature at 68 plus a fully valid record
        // at 96: the Type-3 variant claims it (matches() true), parse yields
        // nothing, and the fallback never sees the block.
        const parse = createFreeGpsBlockParser();
        const block = () => {
            const dv = buildCanonicalType3Block({ anchor: NON_STANDARD_ANCHOR });
            dv.setUint8(68, 0x56); // 'V'
            dv.setUint8(69, 0x4e); // 'N'
            dv.setUint8(70, 0x45); // 'E'
            return dv;
        };
        expect(parse(block(), "x.mp4")).toEqual([]);
        expect(parse(block(), "x.mp4")).toEqual([]);
        expect(parse(block(), "x.mp4")).toEqual([]);
    });
});

// ===== ExifTool-derived variant fixtures (foreign source, waiver batch) =====
//
// Provenance: every fixture below is reconstructed from the verbatim hexdumps
// embedded in ExifTool 13.59 QuickTimeStream.pl comments - real camera bytes
// published in ExifTool's GPL source (coordinates included; acceptable solely
// because they are already public there). Ranges the upstream dumps elide
// ("[...]" rows) are filled with the format's pad byte and labelled synthetic
// at each builder. No variant in this batch has been validated against a
// real sample - these fixtures pin our reading of ExifTool, nothing more.

/** Re-encrypts a reconstructed decrypted Type-1 buffer into a literal-start
 *  payload: "freeGPS " + the 6 plain header bytes (atom 12-17) + the XOR-0xAA
 *  window (XOR is involutive, so re-encryption is exact). The 8-byte variant
 *  signature at literal 14 emerges from the decrypted "\0\0XKZD\xfe\xfe"
 *  preamble - it is not written separately. */
function buildAzdomeLiteral(decrypted: Uint8Array, headerTail: number[]): DataView {
    const bytes = new Uint8Array(14 + decrypted.length);
    bytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
    bytes.set(headerTail, 8);
    for (let i = 0; i < decrypted.length; i++) bytes[14 + i] = decrypted[i]! ^ 0xaa;
    return new DataView(bytes.buffer);
}

const AZDOME_DECRYPTED_PREAMBLE = [0x00, 0x00, 0x58, 0x4b, 0x5a, 0x44, 0xfe, 0xfe];

/** Azdome GS63H decrypted block per QuickTimeStream.pl:1661-1671, with the
 *  datetime and the offset-173 accel triple overridable (accel: null omits
 *  the group entirely - a GPS-only block) so the primitive-level baseline
 *  tests can compose multi-block files. Defaults reproduce the upstream dump
 *  byte-for-byte. The dump elides rows between 0x41 and 0xa0 - that gap is
 *  zero-filled (= encrypted 0xAA padding) and is the synthetic part. */
function buildAzdomeGs63hBlock(overrides: { datetime?: string; accel?: string | null } = {}): DataView {
    const { datetime = "20180924224928", accel = "+093-003-005" } = overrides;
    const dec = new Uint8Array(186); // accel triple ends at decrypted 185
    dec.set(AZDOME_DECRYPTED_PREAMBLE, 0);
    const dv = new DataView(dec.buffer);
    setAscii(dv, 8, datetime);
    dec[22] = 0x0c;
    setAscii(dv, 23, "5567GP   "); // user label, bytes 32-36 stay zero
    dec[37] = 0x03;
    setAscii(dv, 38, "N40464350W007040308");
    setAscii(dv, 57, "00000007"); // 8-digit Azdome speed group (7 km/h)
    if (accel !== null) setAscii(dv, 173, accel);
    return buildAzdomeLiteral(dec, [0x05, 0x01, 0x00, 0x00, 0x01, 0x03]);
}

const AZDOME_GS63H_BLOCK: DataView = buildAzdomeGs63hBlock();

/** EEEkit M63 decrypted block per QuickTimeStream.pl:1672-1683 - all 80
 *  decrypted bytes are visible upstream, nothing synthetic in the window. */
const EEEKIT_M63_BLOCK: DataView = (() => {
    const dec = new Uint8Array(80);
    dec.set(AZDOME_DECRYPTED_PREAMBLE, 0);
    const dv = new DataView(dec.buffer);
    setAscii(dv, 8, "20200519162335");
    dec[22] = 0x0c;
    setAscii(dv, 23, "00200519162336");
    dec[37] = 0x03;
    setAscii(dv, 38, "N37452416W122255009");
    setAscii(dv, 57, "+0175011"); // [-+]\d{4} distrusted altitude + 3-digit speed
    setAscii(dv, 65, "+014+002+026+01"); // accel triple at decrypted 65
    return buildAzdomeLiteral(dec, [0xf0, 0x03, 0x00, 0x00, 0x01, 0x03]);
})();

// Verbatim Vantrue S1 hexdump, QuickTimeStream.pl:2024-2032 (124-byte literal).
const HORSONTECH_ATOM = bytesFromHexDump(`
    00 00 80 00 66 72 65 65 47 50 53 20 78 00 00 00
    00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    68 6f 72 73 6f 6e 74 65 63 68 00 00 00 00 00 00
    41 4e 45 00 15 00 00 00 07 00 00 00 02 00 00 00
    03 00 00 00 35 00 00 00 05 00 00 00 4f 74 4c 44
    e2 77 a0 45 89 c1 98 42 71 bd ac 42 02 ab 0d 43
    05 00 00 00 7f 00 00 00 07 01 00 00 00 00 00 00
`);

// Verbatim EACHPAI hexdump, QuickTimeStream.pl:2001-2010 (the "unsolved"
// upstream Type 9 - it deciphers via the same sub-16 transform to a complete
// valid RMC, which is why our matcher does NOT require the ZXSBNXYS header).
const EACHPAI_ATOM = bytesFromHexDump(`
    00 00 80 00 66 72 65 65 47 50 53 20 ac 00 00 00
    00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    00 00 00 00 00 00 00 00 00 00 00 00 34 57 60 62
    5d 53 3c 41 47 45 45 42 42 3e 40 40 40 3c 51 3c
    44 42 44 40 3e 48 46 43 45 3c 5e 3c 40 48 43 41
    42 3e 46 42 47 48 3c 67 3c 40 3e 40 42 3c 43 3e
    43 41 3c 40 42 40 46 42 40 3c 3c 3c 51 3a 47 46
    00 2a 36 35 00 00 00 00 00 00 00 00 00 00 00 00
`);

/** Synthetic Type-7-shaped block: ZXSBNXYS header (QuickTimeStream.pl:1944)
 *  + an RMC sentence enciphered by +16 per byte at literal 56. */
function buildSub16Block(sentence: string, len = 160): DataView {
    const bytes = new Uint8Array(len);
    bytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
    const dv = new DataView(bytes.buffer);
    setAscii(dv, 12, "ZXSBNXYS");
    for (let i = 0; i < sentence.length && i < 80; i++) bytes[56 + i] = sentence.charCodeAt(i) + 16;
    return dv;
}

// Verbatim XGODY ASCII payload, QuickTimeStream.pl:2358-2365.
const XGODY_LINE = "normal:2024/05/22 02:54:29 N:42.382470 W:83.389570 53.6 km/h x:-0.02 y:0.99 z:0.10 A:269.2 H:245.5";

function buildXgodyBlock(line: string, len = 152): DataView {
    const bytes = new Uint8Array(len);
    bytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
    const dv = new DataView(bytes.buffer);
    setAscii(dv, 12, line);
    return dv;
}

const XGODY_BLOCK = buildXgodyBlock(XGODY_LINE);

// Verbatim E-ACE B44 hexdump, QuickTimeStream.pl:1810-1817. The base64
// fields are real-device RC4 ciphertext - the strongest oracle of the batch:
// 'gNiiZ8JTtHca6tw=' decrypts under 'luckychip gps' to '4342.726563'.
const EACE_B44_ATOM = bytesFromHexDump(`
    00 00 40 00 66 72 65 65 47 50 53 20 f0 03 00 00
    08 00 00 00 22 00 00 00 01 00 00 00 18 00 00 00
    08 00 00 00 10 00 00 00 41 4e 45 00 67 4e 69 69
    5a 38 4a 54 74 48 63 61 36 74 77 3d 00 00 00 00
    68 74 75 69 5a 4d 4a 53 73 58 55 58 37 4e 6f 3d
    00 00 00 00 64 3b ac 41 e1 3a 1d 43 2b 01 00 00
    fd ff ff ff 43 00 00 00 32 4a 37 31 50 70 55 48
    37 69 68 66 00 00 00 00 00 00 00 00 00 00 00 00
`);

/** Synthetic E-ACE block with the verbatim header geometry but custom
 *  coordinate fields (ASCII string or raw bytes written into the 20-byte
 *  slots at literal 40/60). */
function buildEaceBlock(opts: {
    latField: string | Uint8Array;
    lonField: string | Uint8Array;
    active?: "A" | "V";
}): DataView {
    const { latField, lonField, active = "A" } = opts;
    const bytes = new Uint8Array(128);
    bytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
    const dv = new DataView(bytes.buffer);
    // Datetime 2024-08-16 08:34:01 - the values of the verbatim dump.
    [8, 34, 1, 24, 8, 16].forEach((v, i) => {
        dv.setUint32(12 + i * 4, v, true);
    });
    bytes[36] = active.charCodeAt(0);
    bytes[37] = 0x4e; // 'N'
    bytes[38] = 0x45; // 'E'
    const writeField = (offset: number, field: string | Uint8Array) => {
        if (typeof field === "string") setAscii(dv, offset, field);
        else bytes.set(field, offset);
    };
    writeField(40, latField);
    writeField(60, lonField);
    dv.setFloat32(80, 21.529, true);
    dv.setFloat32(84, 157.23, true);
    return dv;
}

/** Test-local RC4 (same KSA+PRGA as the implementation, written separately
 *  on purpose - the round-trip then validates the cipher, not just itself). */
function rc4ForTest(data: Uint8Array, key: string): Uint8Array {
    const s = Array.from({ length: 256 }, (_, i) => i);
    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + s[i]! + key.charCodeAt(i % key.length)) & 0xff;
        [s[i], s[j]] = [s[j]!, s[i]!];
    }
    const out = new Uint8Array(data.length);
    let a = 0;
    let b = 0;
    for (let i = 0; i < data.length; i++) {
        a = (a + 1) & 0xff;
        b = (b + s[a]!) & 0xff;
        [s[a], s[b]] = [s[b]!, s[a]!];
        out[i] = data[i]! ^ s[(s[a]! + s[b]!) & 0xff]!;
    }
    return out;
}

/** RC4-encrypt an ASCII coordinate and wrap it base64 + NUL padding - the
 *  on-disk shape of an encrypted E-ACE field. RC4 is symmetric, so the
 *  encryptor IS the decryptor. */
function eaceEncryptField(plaintext: string, key: string): string {
    const cipher = rc4ForTest(new TextEncoder().encode(plaintext), key);
    return btoa(String.fromCharCode(...cipher));
}

// Verbatim Akaso hexdump #1 ('x.xx' firmware placeholder),
// QuickTimeStream.pl:1910-1917. 108-byte literal = exactly minPayloadLength.
const AKASO_XXX_ATOM = bytesFromHexDump(`
    00 00 80 00 66 72 65 65 47 50 53 20 60 00 00 00
    78 2e 78 78 00 00 00 00 00 00 00 00 00 00 00 00
    30 30 30 30 30 00 00 00 00 00 00 00 00 00 00 00
    12 00 00 00 2f 00 00 00 19 00 00 00 41 00 00 00
    13 b3 ca 44 4e 00 00 00 29 92 fb 45 45 00 00 00
    d9 ee b4 41 ec d1 d3 42 e4 07 00 00 01 00 00 00
    0c 00 00 00 01 00 00 00 05 00 00 00 00 00 00 00
`);

// Verbatim Akaso-family hexdump #2 ("Anticlock 2 2020_1125_1455_007.MOV" -
// no 'x.xx', S hemisphere, 2-digit year, negative accel),
// QuickTimeStream.pl:1918-1926.
const AKASO_ANTICLOCK_ATOM = bytesFromHexDump(`
    00 00 80 00 66 72 65 65 47 50 53 20 68 00 00 00
    32 30 31 33 30 33 32 35 41 00 00 00 00 00 00 00
    41 70 72 20 20 36 20 32 30 31 36 2c 20 31 36 3a
    0e 00 00 00 38 00 00 00 22 00 00 00 41 00 00 00
    8a 63 24 45 53 00 00 00 9f e6 42 45 45 00 00 00
    59 c0 04 3f 52 b8 42 41 14 00 00 00 0b 00 00 00
    19 00 00 00 06 00 00 00 05 00 00 00 f6 ff ff ff
    03 00 00 00 04 00 00 00 00 00 00 00 00 00 00 00
`);

/** Synthetic Type-12 block. Header strings are verbatim from the upstream
 *  dump (QuickTimeStream.pl:2163-2166); ALL record bytes are synthetic from
 *  the field map at :2167-2182 - upstream dumps no record bytes for this
 *  type, making it the weakest fixture of the batch (it pins our reading of
 *  the spec, not real camera bytes). */
function buildNovatekDoublesBlock(
    opts: {
        h?: number;
        mi?: number;
        s?: number;
        y?: number;
        mo?: number;
        d?: number;
        ns?: "N" | "S";
        ew?: "E" | "W";
        latDdmm?: number;
        lonDdmm?: number;
        speedKnots?: number;
        heading?: number;
        accelRaw?: [number, number, number];
    } = {},
): DataView {
    const {
        h = 14,
        mi = 30,
        s = 5,
        y = 17, // stored as year-2000 upstream
        mo = 6,
        d = 10,
        ns = "N",
        ew = "W",
        latDdmm = 5134.991211,
        lonDdmm = 217.5322,
        speedKnots = 27.09,
        heading = 308.26,
        accelRaw = [-7, -1, 1],
    } = opts;
    const bytes = new Uint8Array(136);
    bytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
    const dv = new DataView(bytes.buffer);
    setAscii(dv, 12, "20130815.01");
    setAscii(dv, 28, "Jun 10 2017, 14:");
    [h, mi, s].forEach((v, i) => {
        dv.setUint32(44 + i * 4, v, true);
    });
    dv.setUint32(56, 0x41, true); // 'A' int32-boxed
    dv.setFloat64(60, latDdmm, true);
    dv.setUint32(68, ns.charCodeAt(0), true);
    dv.setFloat64(76, lonDdmm, true);
    dv.setUint32(84, ew.charCodeAt(0), true);
    dv.setFloat64(92, speedKnots, true);
    dv.setFloat64(100, heading, true);
    [y, mo, d].forEach((v, i) => {
        dv.setUint32(108 + i * 4, v, true);
    });
    accelRaw.forEach((v, i) => {
        dv.setInt32(120 + i * 4, v, true);
    });
    return dv;
}

const NOVATEK_DOUBLES_BLOCK = buildNovatekDoublesBlock();

// Verbatim Nextbase 512G hexdump, QuickTimeStream.pl:2406-2413: two '$S'
// records at atom 0x30/0x50. The block declares 0x178 used bytes (10 record
// slots) but the dump truncates after record 2 - the two zero rows appended
// here are SYNTHETIC terminator tail, not upstream bytes.
const NEXTBASE_512G_ATOM = bytesFromHexDump(`
    00 00 80 00 66 72 65 65 47 50 53 20 78 01 00 00
    78 2e 78 78 00 00 00 00 00 00 00 00 00 00 00 00
    30 30 30 30 30 00 00 00 00 00 00 00 00 00 00 00
    24 53 02 79 d4 85 07 e2 0a 08 06 2a 01 d1 02 20
    14 98 ff ff 21 67 97 10 00 00 00 00 00 00 00 00
    24 53 02 a2 d4 42 07 e2 0a 08 06 2a 01 d2 02 20
    14 98 e3 ff 21 67 3b 10 00 00 00 00 00 00 00 00
    00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
`);

describe("Azdome/EEEkit XOR variant (Type 1)", () => {
    it("decodes the re-encrypted Azdome GS63H dump: datetime, ddmm/1e4 coords, speed, accel@173", () => {
        // Transform sanity from the visible encrypted rows: decrypted "2018"
        // at offset 8 = literal 22 must re-encrypt to 98 9a 9b 92
        // (QuickTimeStream.pl:1657 row 0x10).
        expect([22, 23, 24, 25].map((i) => AZDOME_GS63H_BLOCK.getUint8(i))).toEqual([0x98, 0x9a, 0x9b, 0x92]);

        const records = parseFreeGpsBlock(AZDOME_GS63H_BLOCK, "az.mp4");
        expect(records).toHaveLength(1);
        const r = records[0]!;
        expect(r.unixSeconds).toBe(Date.UTC(2018, 8, 24, 22, 49, 28) / 1000);
        expect(r.lat).toBeCloseTo(40.7739166, 6); // N4046.4350
        expect(r.lon).toBeCloseTo(-7.06718, 6); // W00704.0308 (9 lon digits / 1e4)
        expect(r.speedMs).toBeCloseTo(7 / 3.6, 6); // 8-digit group "00000007" km/h
        expect(r.accelXg).toBeCloseTo(0.93, 6); // offset-173 triple
        expect(r.accelYg).toBeCloseTo(-0.03, 6);
        expect(r.accelZg).toBeCloseTo(-0.05, 6);
    });

    it("decodes the EEEkit dump: 3-digit speed fallback at 62, accel@65, altitude never emitted", () => {
        const records = parseFreeGpsBlock(EEEKIT_M63_BLOCK, "ek.mp4");
        expect(records).toHaveLength(1);
        const r = records[0]!;
        expect(r.unixSeconds).toBe(Date.UTC(2020, 4, 19, 16, 23, 35) / 1000);
        expect(r.lat).toBeCloseTo(37.7540266, 6);
        expect(r.lon).toBeCloseTo(-122.425015, 6);
        // "+0175011" = distrusted altitude +0175 (dropped) + speed 011 km/h.
        expect(r.speedMs).toBeCloseTo(11 / 3.6, 6);
        expect(r.accelXg).toBeCloseTo(0.14, 6);
        expect(r.accelYg).toBeCloseTo(0.02, 6);
        expect(r.accelZg).toBeCloseTo(0.26, 6);
    });

    it("a mutated signature byte falls through to no variant at all", () => {
        const bytes = new Uint8Array(
            new Uint8Array(AZDOME_GS63H_BLOCK.buffer, AZDOME_GS63H_BLOCK.byteOffset, AZDOME_GS63H_BLOCK.byteLength),
        );
        bytes[16] = 0x00; // third signature byte (0xf2) broken
        expect(parseFreeGpsBlock(new DataView(bytes.buffer), "az.mp4")).toEqual([]);
    });

    it("an accel-only block (no GPS regex match) is skipped, not half-emitted", () => {
        // Azdome writes datetime+accel without coordinates when GPS has no
        // fix (QuickTimeStream.pl:1706) - decrypted text has no [NS] group.
        const dec = new Uint8Array(186);
        dec.set(AZDOME_DECRYPTED_PREAMBLE, 0);
        const dv = new DataView(dec.buffer);
        setAscii(dv, 8, "20180924224928");
        dec[22] = 0x0c;
        setAscii(dv, 173, "+093-003-005");
        const block = buildAzdomeLiteral(dec, [0x05, 0x01, 0x00, 0x00, 0x01, 0x03]);
        expect(parseFreeGpsBlock(block, "az.mp4")).toEqual([]);
    });
});

describe("Vantrue S1 horsontech variant (Type 10)", () => {
    it("decodes the upstream dump: y-m-d-h-m-s order, LON-before-LAT, knots, accel /1000", () => {
        const records = parseFreeGpsBlock(literalViewFromAtomBytes(HORSONTECH_ATOM), "s1.mp4");
        expect(records).toHaveLength(1);
        const r = records[0]!;
        expect(r.unixSeconds).toBe(Date.UTC(2021, 6, 2, 3, 53, 5) / 1000);
        // Value-pinned on purpose: a lon/lat swap also passes the coordinate
        // bounds gate, only these exact values catch it.
        expect(r.lat).toBeCloseTo(51.583089, 5); // float 5134.9853 DDmm at literal 92
        expect(r.lon).toBeCloseTo(8.296955, 5); // float 817.8173 DDmm at literal 88
        expect(r.speedMs).toBeCloseTo(76.378 * KNOTS_TO_MS, 3);
        expect(r.bearingDeg).toBeCloseTo(86.37, 2);
        expect(r.accelXg).toBeCloseTo(0.005, 6); // int32s at 108/112/116, not 116+
        expect(r.accelYg).toBeCloseTo(0.127, 6);
        expect(r.accelZg).toBeCloseTo(0.263, 6);
    });

    it("bails on an implausible month/day (ExifTool's validity gate)", () => {
        const atom = new Uint8Array(HORSONTECH_ATOM);
        new DataView(atom.buffer).setUint32(72, 13, true); // month at literal 68 = atom 72
        expect(parseFreeGpsBlock(literalViewFromAtomBytes(atom), "s1.mp4")).toEqual([]);
    });
});

describe("sub-16 RMC cipher variant (Type 7/9)", () => {
    it("deciphers the verbatim EACHPAI dump to a valid RMC record", () => {
        // Deciphered oracle: $GPRMC,175522.000,A,4240.8635,N,08312.6278,W,
        // 0.02,3.31,020620,,,A*76 (coordinates public in ExifTool source).
        const records = parseFreeGpsBlock(literalViewFromAtomBytes(EACHPAI_ATOM), "ep.mp4");
        expect(records).toHaveLength(1);
        const r = records[0]!;
        expect(r.unixSeconds).toBe(Date.UTC(2020, 5, 2, 17, 55, 22) / 1000);
        expect(r.lat).toBeCloseTo(42.6810583, 6);
        expect(r.lon).toBeCloseTo(-83.2104633, 6);
        expect(r.speedMs).toBeCloseTo(0.02 * KNOTS_TO_MS, 6);
        expect(r.bearingDeg).toBeCloseTo(3.31, 6);
    });

    it("round-trips a synthetic enciphered sentence (Type-7 ZXSBNXYS shape)", () => {
        const sentence = "$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,,,A*68";
        const records = parseFreeGpsBlock(buildSub16Block(sentence), "t7.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(48.1173, 4);
        expect(records[0]!.lon).toBeCloseTo(11.5167, 4);
    });

    it("signature present but non-RMC decipher yields an empty array", () => {
        const bytes = new Uint8Array(160);
        bytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
        for (let i = 56; i < 136; i++) bytes[i] = 0x7a; // deciphers to 'j' repeated
        // Restore the 7-byte signature so the variant claims the block.
        [0x34, 0x57, 0x60, 0x62, 0x5d, 0x53, 0x3c].forEach((b, i) => {
            bytes[56 + i] = b;
        });
        expect(parseFreeGpsBlock(new DataView(bytes.buffer), "t7.mp4")).toEqual([]);
    });

    it("payload below 136 bytes does not match (ExifTool length gate)", () => {
        const sentence = "$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,,,A*68";
        const short = buildSub16Block(sentence, 128);
        for (const variant of _internal.FREE_GPS_VARIANTS) {
            expect(variant.matches(short), variant.name).toBe(false);
        }
    });
});

describe("XGODY ASCII text variant (Type 18)", () => {
    it("decodes the verbatim line: decimal degrees pass through, speed is KNOTS, A: is bearing", () => {
        const records = parseFreeGpsBlock(XGODY_BLOCK, "xg.mp4");
        expect(records).toHaveLength(1);
        const r = records[0]!;
        expect(r.unixSeconds).toBe(Date.UTC(2024, 4, 22, 2, 54, 29) / 1000);
        expect(r.lat).toBeCloseTo(42.38247, 6); // NO ddmm conversion
        expect(r.lon).toBeCloseTo(-83.38957, 6);
        // The "km/h" label lies - the value is stored in knots (ExifTool's
        // hedged n=1 call, :2374).
        expect(r.speedMs).toBeCloseTo(53.6 * KNOTS_TO_MS, 4);
        expect(r.bearingDeg).toBeCloseTo(269.2, 6);
        // x:/y:/z: are gravity-included in the sample (y:0.99 at rest) -
        // dropped per the gravity-removed GpsRecord contract.
        expect([r.accelXg, r.accelYg, r.accelZg]).toEqual([0, 0, 0]);
    });

    it("a non-'normal:' mode prefix still parses (prefix is not the signature)", () => {
        const line = XGODY_LINE.replace("normal:", "parkin:");
        const records = parseFreeGpsBlock(buildXgodyBlock(line), "xg.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(42.38247, 6);
    });

    it("the speed token requires a decimal point (ExifTool parity) - a stray bare integer is skipped", () => {
        // An unknown unlabeled integer field between the longitude and the
        // real fractional speed must not be consumed as speed - ExifTool's
        // token regex is /^\d+\.\d+$/ (QuickTimeStream.pl:2374).
        const line = XGODY_LINE.replace("W:83.389570 53.6", "W:83.389570 1234 53.6");
        const records = parseFreeGpsBlock(buildXgodyBlock(line, 192), "xg.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.speedMs).toBeCloseTo(53.6 * KNOTS_TO_MS, 4);
        // A line with ONLY an integer speed keeps speed 0 (parity with
        // upstream, which would skip it too).
        const intOnly = XGODY_LINE.replace("53.6 km/h", "53 km/h");
        const intRecords = parseFreeGpsBlock(buildXgodyBlock(intOnly), "xg.mp4");
        expect(intRecords).toHaveLength(1);
        expect(intRecords[0]!.speedMs).toBe(0);
    });
});

describe("E-ACE luckychip RC4 variant (Type 4)", () => {
    it("decrypts the verbatim dump's real ciphertext under 'luckychip gps'", () => {
        // 'gNiiZ8JTtHca6tw=' -> '4342.726563', 'htuiZMJSsXUX7No=' ->
        // '2041.674805' - valid DDmm pair, verified against ExifTool's own
        // hexdump (QuickTimeStream.pl:1810-1817).
        const records = parseFreeGpsBlock(literalViewFromAtomBytes(EACE_B44_ATOM), "ea.mp4");
        expect(records).toHaveLength(1);
        const r = records[0]!;
        expect(r.unixSeconds).toBe(Date.UTC(2024, 7, 16, 8, 34, 1) / 1000);
        expect(r.lat).toBeCloseTo(43.7121093, 6);
        expect(r.lon).toBeCloseTo(20.69458, 6);
        expect(r.speedMs).toBeCloseTo(21.529 * KNOTS_TO_MS, 4);
        expect(r.bearingDeg).toBeCloseTo(157.23, 2);
        // Accel raw int32s exist at literal 88 but the per-axis scale is
        // unverified upstream - dropped.
        expect([r.accelXg, r.accelYg, r.accelZg]).toEqual([0, 0, 0]);
    });

    it("sweeps the customer key list (both fields must validate under the SAME key)", () => {
        const block = buildEaceBlock({
            latField: eaceEncryptField("1234.5678", "customer cc gps"),
            lonField: eaceEncryptField("12345.6789", "customer cc gps"),
        });
        const records = parseFreeGpsBlock(block, "ea.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(12.57613, 5);
        expect(records[0]!.lon).toBeCloseTo(123.761315, 5);
    });

    it("decodes the plaintext sub-case without any decryption", () => {
        const block = buildEaceBlock({ latField: "4342.726563", lonField: "2041.674805" });
        const records = parseFreeGpsBlock(block, "ea.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(43.7121093, 6);
        expect(records[0]!.lon).toBeCloseTo(20.69458, 6);
    });

    it("an unknown firmware key degrades to skipped (empty array)", () => {
        // 'customer tt gps' is one letter past ExifTool's sweep (aa..ss).
        const block = buildEaceBlock({
            latField: eaceEncryptField("1234.5678", "customer tt gps"),
            lonField: eaceEncryptField("12345.6789", "customer tt gps"),
        });
        expect(parseFreeGpsBlock(block, "ea.mp4")).toEqual([]);
    });

    it("'V' active flag yields an empty array (claimed, skipped)", () => {
        const block = buildEaceBlock({
            latField: eaceEncryptField("1234.5678", "luckychip gps"),
            lonField: eaceEncryptField("12345.6789", "luckychip gps"),
            active: "V",
        });
        expect(parseFreeGpsBlock(block, "ea.mp4")).toEqual([]);
    });

    it("a real LAYOUT_ALT binary block is NOT claimed - float bytes fail both field shapes", () => {
        const alt = buildCanonicalType3Block({ anchor: 36 });
        const eace = _internal.FREE_GPS_VARIANTS.find((v) => v.name === "E-ACE luckychip RC4 (Type 4)")!;
        expect(eace.matches(alt)).toBe(false);
        // And the registry still routes it to Type 3.
        const records = parseFreeGpsBlock(alt, "alt.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(50.1, 6);
    });

    it("ordering guard: an E-ACE block satisfies the Type-3 ALT signature but is claimed first", () => {
        // This is WHY variantEaceRc4 sits before variantViofoType3 - assert
        // the alias so a future reorder fails loudly.
        const viofo = _internal.FREE_GPS_VARIANTS.find((v) => v.name === "VIOFO Type 3")!;
        expect(viofo.matches(literalViewFromAtomBytes(EACE_B44_ATOM))).toBe(true);
        const records = parseFreeGpsBlock(literalViewFromAtomBytes(EACE_B44_ATOM), "ea.mp4");
        expect(records[0]!.lat).toBeCloseTo(43.7121093, 6); // decoded by RC4, not nulled by Type 3
    });
});

describe("Akaso plain-float variant (Type 6)", () => {
    it("decodes the 'x.xx' dump: km/h speed, track+180, accel dropped, FULL stored year", () => {
        const records = parseFreeGpsBlock(literalViewFromAtomBytes(AKASO_XXX_ATOM), "ak.mp4");
        expect(records).toHaveLength(1);
        const r = records[0]!;
        // Year is stored FULL (0x07e4 = 2020) in this dump - unconditional
        // +2000 would have rejected every record.
        expect(r.unixSeconds).toBe(Date.UTC(2020, 0, 12, 18, 47, 25) / 1000);
        expect(r.lat).toBeCloseTo(16.359934, 5);
        expect(r.lon).toBeCloseTo(80.837833, 5);
        expect(r.speedMs).toBeCloseTo(22.616624 / 3.6, 4); // km/h, NOT knots
        expect(r.bearingDeg).toBeCloseTo(285.91, 2); // 105.91 + 180
        expect([r.accelXg, r.accelYg, r.accelZg]).toEqual([0, 0, 0]); // garbage under 'x.xx'
    });

    it("decodes the 'Anticlock' dump: 2-digit year, S hemisphere, raw track, accel /1000", () => {
        const records = parseFreeGpsBlock(literalViewFromAtomBytes(AKASO_ANTICLOCK_ATOM), "ak.mp4");
        expect(records).toHaveLength(1);
        const r = records[0]!;
        expect(r.unixSeconds).toBe(Date.UTC(2020, 10, 25, 14, 56, 34) / 1000); // matches the source filename 2020_1125_1455
        expect(r.lat).toBeCloseTo(-26.503686, 5); // 'S'
        expect(r.lon).toBeCloseTo(31.306896, 5);
        expect(r.speedMs).toBeCloseTo(0.51856 / 3.6, 5);
        expect(r.bearingDeg).toBeCloseTo(12.17, 2); // no quirk - raw track
        expect(r.accelXg).toBeCloseTo(0.006, 6);
        expect(r.accelYg).toBeCloseTo(0.005, 6);
        expect(r.accelZg).toBeCloseTo(-0.01, 6); // 0xfffffff6 = -10
    });
});

describe("Novatek doubles variant (Type 12)", () => {
    it("decodes the spec-derived block: float64 ddmm coords, knots, year-2000, accel /1000", () => {
        const records = parseFreeGpsBlock(NOVATEK_DOUBLES_BLOCK, "nd.mp4");
        expect(records).toHaveLength(1);
        const r = records[0]!;
        expect(r.unixSeconds).toBe(Date.UTC(2017, 5, 10, 14, 30, 5) / 1000);
        expect(r.lat).toBeCloseTo(51.5831868, 6);
        expect(r.lon).toBeCloseTo(-2.2922033, 6); // 'W'
        expect(r.speedMs).toBeCloseTo(27.09 * KNOTS_TO_MS, 6);
        expect(r.bearingDeg).toBeCloseTo(308.26, 6);
        expect(r.accelXg).toBeCloseTo(-0.007, 6);
        expect(r.accelYg).toBeCloseTo(-0.001, 6);
        expect(r.accelZg).toBeCloseTo(0.001, 6);
    });

    it("requires the full int32 box: a dirty pad byte after [NS] kills the match", () => {
        const block = buildNovatekDoublesBlock();
        block.setUint8(69, 0x01);
        for (const variant of _internal.FREE_GPS_VARIANTS) {
            expect(variant.matches(block), variant.name).toBe(false);
        }
    });
});

describe("Nextbase 512G '$S' multi-record variant (Type 20)", () => {
    it("decodes BOTH upstream records big-endian with fractional seconds", () => {
        const records = parseFreeGpsBlock(literalViewFromAtomBytes(NEXTBASE_512G_ATOM), "nb.mp4");
        expect(records).toHaveLength(2);
        const [r1, r2] = [records[0]!, records[1]!];
        // Record 1: 2018-10-08 06:42:46.5Z - sec field 0x01d1 = 465 = 46.5 s,
        // the 0.1 s fraction must survive into unixSeconds.
        expect(r1.unixSeconds).toBe(Date.UTC(2018, 9, 8, 6, 42, 46) / 1000 + 0.5);
        expect(r1.lat).toBeCloseTo(53.8220799, 7); // unaligned int32 BE at rec+0x0f
        expect(r1.lon).toBeCloseTo(-1.4588009, 7);
        expect(r1.speedMs).toBeCloseTo(6.33, 6); // u16 BE m/s*100
        expect(r1.bearingDeg).toBeCloseTo(248.69, 2); // i16 BE -111.31 -> +360
        expect(r2.unixSeconds).toBe(Date.UTC(2018, 9, 8, 6, 42, 46) / 1000 + 0.6);
        expect(r2.lat).toBeCloseTo(53.8220771, 7);
        expect(r2.lon).toBeCloseTo(-1.4588101, 7);
        expect(r2.speedMs).toBeCloseTo(6.74, 6);
        expect(r2.bearingDeg).toBeCloseTo(248.02, 2);
    });

    it("terminates on date implausibility, not on a record count", () => {
        const atom = new Uint8Array(NEXTBASE_512G_ATOM);
        const dv = new DataView(atom.buffer);
        // Forge a third record slot at atom 0x70 (literal 108): valid magic,
        // implausible year 1999 - the date gate must stop the loop there.
        dv.setUint16(112, 0x2453, false);
        dv.setUint16(118, 1999, false);
        const records = parseFreeGpsBlock(literalViewFromAtomBytes(atom), "nb.mp4");
        expect(records).toHaveLength(2);
    });

    it("honors the block's declared length as an upper bound", () => {
        const atom = new Uint8Array(NEXTBASE_512G_ATOM);
        // Declared used-length (u32 LE at atom 12 = literal 8) cut to cover
        // only the first record slot.
        new DataView(atom.buffer).setUint32(12, 4 + 44 + 32, true);
        const records = parseFreeGpsBlock(literalViewFromAtomBytes(atom), "nb.mp4");
        expect(records).toHaveLength(1);
    });
});

describe("variant cross-matrix: each fixture is claimed only by its owner", () => {
    // Both directions of the negative contract in one table: no NEW variant
    // claims an existing-format fixture, and no existing variant claims a new
    // fixture - except the two documented aliases where ordering is the
    // guard (E-ACE and Type-8 blocks satisfy Type-3 layout signatures).
    const vantrueNmeaBlock = (): DataView => {
        const bytes = new Uint8Array(256);
        bytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
        const dv = new DataView(bytes.buffer);
        setAscii(dv, 100, "$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A\r\n");
        return dv;
    };
    const KENWOOD_MN_ATOM = bytesFromHexDump(`
        00 00 40 00 66 72 65 65 47 50 53 20 f0 03 00 00
        4d 4e 3a 44 52 56 2d 41 35 31 30 57 40 56 31 2e
        37 5f 42 44 5a 49 43 5a 5f 43 00 00 00 00 00 00
        00 00 00 00 00 00 00 00 3a 3a 73 74 61 72 74 40
        0c 00 00 00 10 00 00 00 16 00 00 00 ea 07 00 00
        02 00 00 00 1c 00 00 00 41 4e 57 00 55 e7 a5 45
        d7 84 52 43 52 b8 d8 41 48 21 9a 43 f9 ff ff ff
        ff ff ff ff 01 00 00 00 00 00 00 00 00 00 00 00
    `);
    const AKASO_V1_TYPE8_ATOM = bytesFromHexDump(`
        00 00 80 00 66 72 65 65 47 50 53 20 78 00 00 00
        59 6e 64 41 6b 61 73 6f 43 61 72 00 00 00 00 00
        30 30 30 30 30 00 00 00 00 00 00 00 00 00 00 00
        0e 00 00 00 27 00 00 00 2c 00 00 00 e3 07 00 00
        05 00 00 00 1d 00 00 00 41 4e 45 00 00 00 00 00
        f1 4e 3e 3d 90 df ca 40 e3 50 bf 0b 0b 31 a0 40
        4b dc c8 41 9a 79 a7 43 34 58 43 31 4f 37 31 35
        35 31 32 36 36 35 37 35 59 4e 44 53 0d e7 cc f9
        00 00 00 00 05 00 00 00 00 00 00 00 00 00 00 00
    `);

    const fixtures: Array<{ name: string; view: () => DataView; owner: string; alsoMatches?: string[] }> = [
        { name: "azdome-gs63h", view: () => AZDOME_GS63H_BLOCK, owner: "Azdome/EEEkit XOR (Type 1)" },
        { name: "eeekit-m63", view: () => EEEKIT_M63_BLOCK, owner: "Azdome/EEEkit XOR (Type 1)" },
        {
            name: "horsontech",
            view: () => literalViewFromAtomBytes(HORSONTECH_ATOM),
            owner: "Vantrue S1 horsontech (Type 10)",
        },
        { name: "eachpai", view: () => literalViewFromAtomBytes(EACHPAI_ATOM), owner: "sub-16 RMC cipher (Type 7/9)" },
        { name: "xgody", view: () => XGODY_BLOCK, owner: "XGODY ASCII text (Type 18)" },
        {
            name: "eace-b44",
            view: () => literalViewFromAtomBytes(EACE_B44_ATOM),
            owner: "E-ACE luckychip RC4 (Type 4)",
            // Byte-exact LAYOUT_ALT alias - registry order is the guard.
            alsoMatches: ["VIOFO Type 3"],
        },
        {
            name: "akaso-xxx",
            view: () => literalViewFromAtomBytes(AKASO_XXX_ATOM),
            owner: "Akaso plain-float (Type 6)",
        },
        {
            name: "akaso-anticlock",
            view: () => literalViewFromAtomBytes(AKASO_ANTICLOCK_ATOM),
            owner: "Akaso plain-float (Type 6)",
        },
        { name: "novatek-doubles", view: () => NOVATEK_DOUBLES_BLOCK, owner: "Novatek doubles (Type 12)" },
        {
            name: "nextbase-512g",
            view: () => literalViewFromAtomBytes(NEXTBASE_512G_ATOM),
            owner: "Nextbase 512G $S (Type 20)",
        },
        // Existing-format fixtures: new variants must never claim these.
        { name: "type3-default", view: () => buildCanonicalType3Block({ anchor: 68 }), owner: "VIOFO Type 3" },
        { name: "type3-legacy", view: () => buildCanonicalType3Block({ anchor: 40 }), owner: "VIOFO Type 3" },
        { name: "type3-alt", view: () => buildCanonicalType3Block({ anchor: 36 }), owner: "VIOFO Type 3" },
        { name: "kenwood-mn", view: () => literalViewFromAtomBytes(KENWOOD_MN_ATOM), owner: "VIOFO Type 3" },
        {
            name: "type8-akaso-v1",
            view: () => literalViewFromAtomBytes(AKASO_V1_TYPE8_ATOM),
            owner: "Akaso/Redtiger Type 8 (encrypted, recognize-and-bail)",
            // Type-8 is a byte-exact LAYOUT_DEFAULT alias - ordering guard.
            alsoMatches: ["VIOFO Type 3"],
        },
        {
            name: "youqing",
            view: () => buildYouqingBlock(),
            owner: "YOUQINGGPS",
            // Its datetime/status bytes also satisfy the older Type-8 and
            // generic Type-3 gates; the banner-specific owner must run first.
            alsoMatches: ["Akaso/Redtiger Type 8 (encrypted, recognize-and-bail)", "VIOFO Type 3"],
        },
        { name: "vantrue-nmea", view: vantrueNmeaBlock, owner: "Vantrue NMEA-embedded" },
    ];

    it("matches() matrix: owner (and documented aliases) only", () => {
        for (const fixture of fixtures) {
            const allowed = new Set([fixture.owner, ...(fixture.alsoMatches ?? [])]);
            for (const variant of _internal.FREE_GPS_VARIANTS) {
                expect(variant.matches(fixture.view()), `${variant.name} vs ${fixture.name}`).toBe(
                    allowed.has(variant.name),
                );
            }
        }
    });

    it("registry dispatch resolves every fixture to its owner (order regression)", () => {
        for (const fixture of fixtures) {
            const first = _internal.FREE_GPS_VARIANTS.find((variant) => variant.matches(fixture.view()));
            expect(first?.name, fixture.name).toBe(fixture.owner);
        }
    });
});

// ===== Rexing V1-4K affine deobfuscation (ExifTool GPSType 17b) =====

describe("Rexing affine deobfuscation (Type 17b, KodakVersion-gated)", () => {
    // Pre-obfuscate coarse Phoenix-like coords with the FORWARD transform
    // (the inverse of QuickTimeStream.pl:2325-2326): the parser must round-trip
    // them back. float32 storage costs ~1e-5 deg - assert at 4 decimals.
    const LAT_DEG = 33.6698; // N
    const LON_DEG = 112.0969; // W (sign applied by the hemisphere byte)
    const latRaw = LAT_DEG * 3 + 187.982162849635;
    const lonRaw = LON_DEG * 2 + 2199.19873715495;

    function buildRexingBlock(): DataView {
        return buildCanonicalType3Block({ anchor: 68, ns: "N", ew: "W", latRaw, lonRaw });
    }

    it("flag on: affine transform applied, ddmm conversion skipped, hemisphere sign applied after", () => {
        const parse = createFreeGpsBlockParser({ rexingAffine: true });
        const records = parse(buildRexingBlock(), "rexing.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(LAT_DEG, 4);
        expect(records[0]!.lon).toBeCloseTo(-LON_DEG, 4);
        expect(records[0]!.speedMs).toBeCloseTo(10 * KNOTS_TO_MS, 6);
    });

    it("flag off: rejects the obfuscated values when they are not valid DDmm", () => {
        const parse = createFreeGpsBlockParser();
        const records = parse(buildRexingBlock(), "rexing.mp4");
        expect(records).toEqual([]);
    });

    it("stateless registry default (parseFreeGpsBlock) never applies the transform", () => {
        const records = parseFreeGpsBlock(buildRexingBlock(), "rexing.mp4");
        expect(records).toEqual([]);
    });

    it("flag on does not disturb non-DEFAULT layouts (LAYOUT_LEGACY keeps ddmm)", () => {
        const parse = createFreeGpsBlockParser({ rexingAffine: true });
        const records = parse(buildCanonicalType3Block({ anchor: 40 }), "a.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(50.1, 6); // ddmm 5006.0 - unchanged
    });

    it("primitive threads the flag from Mp4Index.kodakVersion (exact match only)", async () => {
        const atomBytes = blockAtomBytes(buildRexingBlock());
        const offsets = [0x1000, 0x2000];
        const table = canonicalGpsTable(offsets.map((o) => [o, 0x4000]));
        const makeFile = (): File =>
            new SparseFile(
                0x10000,
                offsets.map((offset) => ({ offset, data: atomBytes })),
            ) as unknown as File;
        const makeIndex = (kodakVersion: string | null): Mp4Index =>
            ({
                novatekGpsAtom: { type: "gps ", start: 0, end: table.length, payloadStart: 0 },
                moovView: new DataView(table.buffer, table.byteOffset, table.byteLength),
                kodakVersion,
            }) as unknown as Mp4Index;
        const vf = (): VendorFile => ({ file: makeFile(), relativePath: "rexing.mp4" });

        const gated = await freegpsPrimitive.parse(vf(), makeIndex(REXING_KODAK_VERSION));
        expect(gated.records).toHaveLength(2);
        expect(gated.records[0]!.lat).toBeCloseTo(LAT_DEG, 4);
        expect(gated.records[0]!.lon).toBeCloseTo(-LON_DEG, 4);

        // A DIFFERENT version string (or none) must never set the flag - the
        // gate is exact-match by design (obfuscated raws overlap valid DDmm).
        for (const version of ["3.01.055", null]) {
            const plain = await freegpsPrimitive.parse(vf(), makeIndex(version));
            expect(plain.records).toEqual([]);
            expect(plain.skipped).toHaveLength(2);
        }
    });
});

describe("XBHT XB702 multi-record blocks (Type 14)", () => {
    // Verbatim ExifTool hexdump (QuickTimeStream.pl:2221-2225, v13.55) minus the
    // 4-byte box size, zero-padded so the second record is complete (upstream's
    // dump is cut mid-record).
    const XBHT_DUMP = [
        "66 72 65 65 47 50 53 20 f0 03 00 00",
        "00 17 05 11 0d 25 18 00 41 4e 45 64 83 3f 00 00",
        "44 3d c5 02 48 6d ff 07 df 03 00 00 6b 00 00 00",
        "00 00 00 00 00 17 05 11 0d 25 18 01 41 4e 45 64",
        "8b 3f 00 00 30 3d c5 02 50 6d ff 07 df 03 00 00",
    ].join(" ");

    function xbhtBlock(): DataView {
        const dump = Uint8Array.from(XBHT_DUMP.split(/\s+/).map((h) => Number.parseInt(h, 16)));
        const bytes = new Uint8Array(dump.length + 16);
        bytes.set(dump, 0);
        return new DataView(bytes.buffer);
    }

    it("decodes the packed clock and DDmm*1e4 coordinates", () => {
        const records = parseFreeGpsBlock(xbhtBlock(), "xbht.mp4", 0x400000);
        expect(records).toHaveLength(2);
        const r = records[0]!;
        expect(r.unixSeconds).toBe(Date.UTC(2023, 4, 17, 13, 37, 24) / 1000);
        expect(r.lat).toBeCloseTo(46.80118, 5);
        expect(r.lon).toBeCloseTo(134.30028, 5);
        // u16 speed, km/h per upstream's default tag unit.
        expect(r.speedMs).toBeCloseTo(107 * KMH_TO_MS, 5);
        // No heading field in the format - left at 0 for the forward-fill.
        expect(r.bearingDeg).toBe(0);
        // Real wall clock, so no reanchoring.
        expect(r.timeUnsynced).toBeUndefined();
        expect(records[1]!.lat).toBeCloseTo(46.80115, 5);
    });

    it("does not claim a canonical Type 3 block", () => {
        const records = parseFreeGpsBlock(buildCanonicalType3Block({ anchor: 68 }), "viofo.mp4", 0x400000);
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(50.1, 6); // Type-3 decode, not XBHT
    });
});

describe("ATC self-keying XOR records (Type 11)", () => {
    // Upstream documents the field layout but dumps only the ENCRYPTED bytes,
    // so the fixture is built the other way round: lay out a plaintext record
    // per QuickTimeStream.pl:2109-2131, apply the same XOR forward, and require
    // the parser to round-trip it. The key slots hold plaintext zero, which is
    // exactly why encrypting leaves the key sitting there for the decoder.
    const KEY1 = 0x5a;
    const KEY2 = 0xa5;

    interface AtcFields {
        hour: number;
        minute: number;
        second: number;
        year: number;
        month: number;
        day: number;
        latE7: number;
        lonE7: number;
        speedCms: number;
        headingX100: number;
    }

    function buildAtcRecord(f: AtcFields): Uint8Array {
        const bytes = new Uint8Array(52);
        const dv = new DataView(bytes.buffer);
        dv.setUint8(0x0d, (f.hour - 1) & 0xff); // stored hour-minus-1
        dv.setUint8(0x0e, f.minute);
        dv.setUint8(0x0f, f.second);
        dv.setInt32(0x10, f.latE7, true);
        // 0x14 stays 0 - it becomes key1 once encrypted.
        setAscii(dv, 0x15, "ATC");
        dv.setInt32(0x18, f.lonE7, true);
        // 0x1c stays 0 - it becomes key2.
        setAscii(dv, 0x1d, "001");
        dv.setInt32(0x20, f.speedCms, true);
        dv.setInt16(0x24, f.headingX100, true);
        dv.setInt32(0x28, 123_456, true); // altitude, no GpsRecord field
        dv.setUint16(0x2c, f.year, true);
        dv.setUint8(0x2e, f.month);
        dv.setUint8(0x2f, f.day);

        for (let i = 0x00; i <= 0x14; i++) bytes[i] = bytes[i]! ^ KEY1;
        for (let i = 0x18; i <= 0x1b; i++) bytes[i] = bytes[i]! ^ KEY1;
        bytes[0x1c] = bytes[0x1c]! ^ KEY2;
        for (let i = 0x20; i <= 0x32; i++) bytes[i] = bytes[i]! ^ KEY2;
        return bytes;
    }

    const REC_A: AtcFields = {
        hour: 19,
        minute: 30,
        second: 45,
        year: 2015,
        month: 5,
        day: 15,
        latE7: 481_810_221,
        lonE7: 163_591_268,
        speedCms: 1234, // 12.34 m/s
        headingX100: -4550, // -45.5 deg -> folds to 314.5
    };
    const REC_B: AtcFields = { ...REC_A, second: 46, latE7: 481_810_500, speedCms: 1300, headingX100: 9000 };

    /** freeGPS block holding the given records from literal 44. */
    function buildAtcBlock(records: AtcFields[], opts: { iqsHeader?: boolean } = {}): DataView {
        const bytes = new Uint8Array(44 + records.length * 52 + 16);
        bytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
        const dv = new DataView(bytes.buffer);
        // Sample-1 ATC blocks carry this at literal 12 - the Type-16 anchor.
        if (opts.iqsHeader) setAscii(dv, 12, "IQS20130306B");
        records.forEach((rec, i) => {
            bytes.set(buildAtcRecord(rec), 44 + i * 52);
        });
        return dv;
    }

    it("decrypts both key ranges and round-trips every field", () => {
        const records = parseFreeGpsBlock(buildAtcBlock([REC_A, REC_B]), "atc.mp4");
        expect(records).toHaveLength(2);
        const r = records[0]!;
        expect(r.lat).toBeCloseTo(48.1810221, 7);
        expect(r.lon).toBeCloseTo(16.3591268, 7);
        // Speed is stored in m/s already - no knots conversion on this branch.
        expect(r.speedMs).toBeCloseTo(12.34, 6);
        // Negative headings fold up into 0..360.
        expect(r.bearingDeg).toBeCloseTo(314.5, 6);
        // Stored hour is hour-minus-1; 19:30:45 on 2015-05-15.
        expect(r.unixSeconds).toBe(Date.UTC(2015, 4, 15, 19, 30, 45) / 1000);
        // Real wall clock, so these are NOT reanchored like INNOVV's.
        expect(r.timeUnsynced).toBeUndefined();
        expect(records[1]!.bearingDeg).toBeCloseTo(90, 6);
        expect(records[1]!.unixSeconds).toBe(Date.UTC(2015, 4, 15, 19, 30, 46) / 1000);
    });

    it("skips a record whose plaintext anchors are gone", () => {
        const block = buildAtcBlock([REC_A, REC_B]);
        // Break `001` on the second record only.
        setAscii(block, 44 + 52 + 0x1d, "XXX");
        const records = parseFreeGpsBlock(block, "atc.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.unixSeconds).toBe(Date.UTC(2015, 4, 15, 19, 30, 45) / 1000);
    });

    it("wins over the Type-16 IQS anchor on a block carrying both", () => {
        // The documented ordering hazard: an ATC sample-1 block also has `IQS`
        // at literal 12. Decoded as IQS it would yield one bogus record.
        const records = parseFreeGpsBlock(buildAtcBlock([REC_A], { iqsHeader: true }), "atc.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(48.1810221, 7);
    });

    it("structural path reads the whole atom, not just the first per-block KB", async () => {
        // The ring buffer runs to ~1.6 KB (upstream sample-2 declares a
        // 0x638-byte payload), well past the probe read the structural path
        // issues per block - every record after it must still come back.
        const ring = Array.from({ length: 30 }, (_, i) => ({ ...REC_A, second: i }));
        const block = buildAtcBlock(ring);
        expect(block.byteLength).toBeGreaterThan(1024);
        const table = canonicalGpsTable([[0x1000, 0x4000]]);
        const file = new SparseFile(0x10000, [{ offset: 0x1000, data: blockAtomBytes(block) }]) as unknown as File;

        const parsed = await tryStructuralPath(file, indexStub(table), parseFreeGpsBlock);
        expect(parsed).not.toBeNull();
        expect(parsed!.records).toHaveLength(30);
        expect(parsed!.records[29]!.unixSeconds).toBe(Date.UTC(2015, 4, 15, 19, 30, 29) / 1000);
    });

    it("structural path reads the whole atom when only one valid ring record fits in the probe", async () => {
        const ring = Array.from({ length: 30 }, (_, i) => ({ ...REC_A, second: i }));
        const block = buildAtcBlock(ring);
        // Leave record 0 valid, corrupt every other complete record in the
        // first 1 KiB, then leave the tail valid. A record-count heuristic
        // sees exactly one fix and would incorrectly skip the second read.
        for (let i = 1; i <= 17; i++) setAscii(block, 44 + i * 52 + 0x1d, "XXX");
        const table = canonicalGpsTable([[0x1000, 0x4000]]);
        const file = new SparseFile(0x10000, [{ offset: 0x1000, data: blockAtomBytes(block) }]) as unknown as File;

        const parsed = await tryStructuralPath(file, indexStub(table), parseFreeGpsBlock);
        expect(parsed).not.toBeNull();
        expect(parsed!.records).toHaveLength(13);
        expect(parsed!.records.at(-1)!.unixSeconds).toBe(Date.UTC(2015, 4, 15, 19, 30, 29) / 1000);
    });

    it("reads the whole ring buffer through a literal-pointing (legacy) table too", async () => {
        // The legacy table leaves the box-size dword outside the read, so the
        // atom bound is unknowable - the block still must not be cut at the
        // probe.
        const ring = Array.from({ length: 30 }, (_, i) => ({ ...REC_A, second: i }));
        const block = buildAtcBlock(ring);
        const literalBytes = new Uint8Array(block.buffer, block.byteOffset, block.byteLength);
        const table = legacyGpsTable([[0x1000, 0x4000]]);
        const file = new SparseFile(0x10000, [{ offset: 0x1000, data: literalBytes }]) as unknown as File;

        const parsed = await tryStructuralPath(file, indexStub(table), parseFreeGpsBlock);
        expect(parsed!.records).toHaveLength(30);
    });

    it("ring-buffer repeats across blocks collapse in dedupRecords", () => {
        // Every block restates the whole buffer, so two consecutive blocks
        // share their records; the global dedup is what makes that harmless.
        const first = parseFreeGpsBlock(buildAtcBlock([REC_A, REC_B]), "atc.mp4");
        const second = parseFreeGpsBlock(buildAtcBlock([REC_A, REC_B]), "atc.mp4");
        expect(dedupRecords([...first, ...second])).toHaveLength(2);
    });
});

describe("INNOVV multi-record blocks (Type 13)", () => {
    // Verbatim ExifTool hexdump (QuickTimeStream.pl:2195-2199, v13.55) minus
    // the 4-byte box size: two 32-byte fixes near Vienna, no clock anywhere.
    const INNOVV_DUMP = [
        "66 72 65 65 47 50 53 20 f0 03 00 00",
        "41 4e 45 00 e4 56 96 45 86 b1 ca 44 5c 8f e2 40",
        "33 33 58 43 c3 00 00 00 30 00 00 00 a0 fe ff ff",
        "41 4e 45 00 e3 56 96 45 82 b1 ca 44 5c 8f fa 40",
        "c3 75 56 43 8c ff ff ff 8c 00 00 00 c3 fd ff ff",
    ].join(" ");
    /** Box size 0x4000 big-endian, as the little-endian read the parser gets. */
    const DWORD_16K = 0x400000;

    function innovvBlock(extraBytes = 0): DataView {
        const dump = Uint8Array.from(INNOVV_DUMP.split(/\s+/).map((h) => Number.parseInt(h, 16)));
        const bytes = new Uint8Array(dump.length + extraBytes);
        bytes.set(dump, 0);
        return new DataView(bytes.buffer);
    }

    it("emits every fix in the block, DDmm-converted and timeUnsynced", () => {
        const records = parseFreeGpsBlock(innovvBlock(), "innovv.mp4", DWORD_16K);
        expect(records).toHaveLength(2);
        expect(records[0]!.lat).toBeCloseTo(48.18102, 5);
        expect(records[0]!.lon).toBeCloseTo(16.35913, 5);
        expect(records[0]!.speedMs).toBeCloseTo(7.08 * KNOTS_TO_MS, 5);
        expect(records[0]!.bearingDeg).toBeCloseTo(216.2, 3);
        expect(records[1]!.lat).toBeCloseTo(48.18101, 5);
        expect(records[1]!.bearingDeg).toBeCloseTo(214.46, 3);
        for (const r of records) {
            // No clock of any kind in the format - the time layer reanchors these.
            expect(r.timeUnsynced).toBe(true);
            expect(r.unixSeconds).toBe(0);
            // The i32 triple carries no documented scale, so it is dropped.
            expect(r.accelXg).toBe(0);
            expect(r.accelYg).toBe(0);
            expect(r.accelZg).toBe(0);
        }
    });

    it("stops at the atom bound instead of running into the next block", () => {
        // A second, byte-identical block appended right after the first atom.
        // Scanning the whole 32 KB window would return its records too, and
        // with no timestamps there is nothing to dedup them on.
        const dump = Uint8Array.from(INNOVV_DUMP.split(/\s+/).map((h) => Number.parseInt(h, 16)));
        const atomBytes = 0x100; // pretend the atom is 0x100 long
        const bytes = new Uint8Array(atomBytes * 2);
        bytes.set(dump, 0);
        bytes.set(dump, atomBytes - 4); // next atom's literal, past this atom's end
        const view = new DataView(bytes.buffer);

        const bounded = parseFreeGpsBlock(view, "innovv.mp4", byteSwapForTest(atomBytes));
        expect(bounded).toHaveLength(2);

        // Without the bound the trailing block's fixes leak in.
        const unbounded = parseFreeGpsBlock(view, "innovv.mp4");
        expect(unbounded.length).toBeGreaterThan(2);
    });

    it("does not claim a canonical Type 3 block, and Type 3 does not claim it", () => {
        const type3 = parseFreeGpsBlock(buildCanonicalType3Block({ anchor: 68 }), "viofo.mp4", DWORD_16K);
        expect(type3).toHaveLength(1);
        expect(type3[0]!.timeUnsynced).toBeUndefined(); // Type-3 path, not INNOVV
        // And the INNOVV block never decodes as a single dated Type-3 record.
        const innovv = parseFreeGpsBlock(innovvBlock(), "innovv.mp4", DWORD_16K);
        expect(innovv.every((r) => r.timeUnsynced === true)).toBe(true);
    });
});

/** Mirrors the parser's little-endian read of a big-endian box size. */
function byteSwapForTest(atomSize: number): number {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setUint32(0, atomSize, false);
    return dv.getUint32(0, true);
}

describe("Transcend Drive Body Camera 70 (Type 17c, box-size-dword gated)", () => {
    // Verbatim ExifTool hexdump (QuickTimeStream.pl:2333-2338, v13.55) minus
    // the 4-byte box size, which the parser receives separately: 2025-05-16
    // 09:38:21, A/S/E, then the four floats.
    const TRANSCEND_DUMP = [
        "66 72 65 65 47 50 53 20 4c 00 00 00",
        "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
        "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
        "09 00 00 00 26 00 00 00 15 00 00 00 e9 07 00 00",
        "05 00 00 00 10 00 00 00 41 53 45 00 6c 59 ee 41",
        "9f 1a f7 41 3c 6b 0f 41 9a 99 99 43 00 00 00 00",
    ].join(" ");
    /** Box size 0x4000 stored big-endian, read back little-endian. */
    const DWORD = 0x400000;
    // Durban-ish, matching the dump's hemisphere bytes.
    const LAT_DEG = -29.7937;
    const LON_DEG = 30.888;
    // What the same floats become when ddmm-converted: the silent misparse
    // this gate exists to stop. Both land just off Null Island.
    const MANGLED_LAT = 0.4965;
    const MANGLED_LON = 0.5148;

    function transcendBlock(): DataView {
        const bytes = Uint8Array.from(TRANSCEND_DUMP.split(/\s+/).map((h) => Number.parseInt(h, 16)));
        return new DataView(bytes.buffer);
    }

    it("gated: coordinates stay decimal degrees and speed is read as km/h", () => {
        const records = parseFreeGpsBlock(transcendBlock(), "transcend.mp4", DWORD);
        expect(records).toHaveLength(1);
        const r = records[0]!;
        expect(r.lat).toBeCloseTo(LAT_DEG, 3);
        expect(r.lon).toBeCloseTo(LON_DEG, 3);
        expect(r.speedMs).toBeCloseTo(8.96368 * KMH_TO_MS, 5);
        expect(r.unixSeconds).toBe(Date.UTC(2025, 4, 16, 9, 38, 21) / 1000);
    });

    it("no dword available: falls back to the plain DDmm decode", () => {
        const records = parseFreeGpsBlock(transcendBlock(), "transcend.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(-MANGLED_LAT, 3);
        expect(records[0]!.lon).toBeCloseTo(MANGLED_LON, 3);
        expect(records[0]!.speedMs).toBeCloseTo(8.96368 * KNOTS_TO_MS, 5);
    });

    it("different box size: the gate does not fire", () => {
        const records = parseFreeGpsBlock(transcendBlock(), "transcend.mp4", 0x800000);
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(-MANGLED_LAT, 3);
    });

    it("a genuine DDmm block in a 0x4000 atom is untouched (range check carries it)", () => {
        // 5006.0 DDmm = 50.1 deg - far outside the plain-degree range, so the
        // dword alone cannot claim it. This is the common case: 0x400000 is an
        // ordinary 16 KB freeGPS atom, not a Transcend marker.
        const records = parseFreeGpsBlock(buildCanonicalType3Block({ anchor: 68 }), "viofo.mp4", DWORD);
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(50.1, 6);
        expect(records[0]!.speedMs).toBeCloseTo(10 * KNOTS_TO_MS, 6);
    });

    it("only LAYOUT_DEFAULT is eligible - a legacy-layout block keeps ddmm", () => {
        const records = parseFreeGpsBlock(
            buildCanonicalType3Block({ anchor: 40, latRaw: 29.79, lonRaw: 30.88 }),
            "legacy.mp4",
            DWORD,
        );
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(0.4965, 3);
    });
});

describe("Transcend DrivePro 230 f64 coordinate upgrade", () => {
    const LAT_DDMM = 5006.0;
    const LON_DDMM = 3003.0;

    /** Canonical Type 3 with the optional double pair at literal 108/124. */
    function blockWithDoubles(latDouble: number, lonDouble: number): DataView {
        const dv = buildCanonicalType3Block({ anchor: 68, len: 160, latRaw: LAT_DDMM, lonRaw: LON_DDMM });
        dv.setFloat64(108, latDouble, true);
        dv.setFloat64(124, lonDouble, true);
        return dv;
    }

    it("doubles that agree with the float32 pair win (same DDmm units)", () => {
        // A float32 5006.0 is exact, so shift by less than the 0.001 tolerance
        // to prove the doubles are the ones that reached the record.
        const records = parseFreeGpsBlock(blockWithDoubles(LAT_DDMM + 0.0005, LON_DDMM + 0.0005), "dp230.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo((5006.0005 - 5000) / 60 + 50, 9);
        expect(records[0]!.lon).toBeCloseTo((3003.0005 - 3000) / 60 + 30, 9);
    });

    it("doubles that disagree are ignored - the float32 pair stands", () => {
        const records = parseFreeGpsBlock(blockWithDoubles(LAT_DDMM + 5, LON_DDMM + 5), "dp230.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(50.1, 6);
        expect(records[0]!.lon).toBeCloseTo(30.05, 6);
    });

    it("a block too short to hold the doubles parses as before", () => {
        const records = parseFreeGpsBlock(buildCanonicalType3Block({ anchor: 68, len: 100 }), "short.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(50.1, 6);
    });

    it("the upgrade applies in degree space once the Transcend branch converted", () => {
        // Same block as the 17c dump, plus agreeing doubles in DEGREES - the
        // units the 17c branch leaves behind, not DDmm.
        const bytes = new Uint8Array(160);
        const dv = new DataView(bytes.buffer);
        bytes.set(_internal.FREE_GPS_MAGIC_BYTES, 0);
        [9, 38, 21, 2025, 5, 16].forEach((value, i) => {
            dv.setUint32(44 + i * 4, value, true);
        });
        setAscii(dv, 68, "ASE");
        dv.setFloat32(72, 29.793663, true);
        dv.setFloat32(76, 30.887999, true);
        dv.setFloat32(80, 8.96368, true);
        dv.setFloat32(84, 307.2, true);
        dv.setFloat64(108, 29.7936, true);
        dv.setFloat64(124, 30.888, true);

        const records = parseFreeGpsBlock(dv, "dp230.mp4", 0x400000);
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBeCloseTo(-29.7936, 6);
        expect(records[0]!.lon).toBeCloseTo(30.888, 6);
    });
});

// ===== Structural `gps ` table candidates (internal/freegps.ts) =====

/** Mp4Index stub: only the fields tryStructuralPath touches. */
function indexStub(tablePayload: Uint8Array): Mp4Index {
    return {
        novatekGpsAtom: { type: "gps ", start: 0, end: tablePayload.length, payloadStart: 0 },
        moovView: new DataView(tablePayload.buffer, tablePayload.byteOffset, tablePayload.byteLength),
    } as unknown as Mp4Index;
}

/** Canonical table payload: [version/flags][count u32 BE][offset,size u32 BE...]
 *  - layout per ExifTool QuickTimeStream.pl:2546-2553 (v13.59) and the piofo
 *  real-file hexdump (version word 0x00000101). */
function canonicalGpsTable(entries: Array<[number, number]>, declaredCount = entries.length): Uint8Array {
    const buf = new Uint8Array(8 + entries.length * 8);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0x00000101, false);
    dv.setUint32(4, declaredCount, false);
    entries.forEach(([off, size], i) => {
        dv.setUint32(8 + i * 8, off, false);
        dv.setUint32(12 + i * 8, size, false);
    });
    return buf;
}

/** Legacy-guess table payload: [count u32 LE][offset,size u32 LE...], entries
 *  pointing directly at the literal. */
function legacyGpsTable(entries: Array<[number, number]>): Uint8Array {
    const buf = new Uint8Array(4 + entries.length * 8);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, entries.length, true);
    entries.forEach(([off, size], i) => {
        dv.setUint32(4 + i * 8, off, true);
        dv.setUint32(8 + i * 8, size, true);
    });
    return buf;
}

/** On-disk block atom: [u32 BE size]["freeGPS " + payload] - the shape
 *  canonical table entries point at. */
function blockAtomBytes(blockLiteral: DataView): Uint8Array {
    const lit = new Uint8Array(blockLiteral.buffer, blockLiteral.byteOffset, blockLiteral.byteLength);
    const out = new Uint8Array(4 + lit.length);
    new DataView(out.buffer).setUint32(0, 0x4000, false);
    out.set(lit, 4);
    return out;
}

describe("structural gps-table candidates", () => {
    it("canonical layout: count BE at +4, entries from +8, atom-start pointers", async () => {
        const atom = blockAtomBytes(buildCanonicalType3Block({ anchor: 68 }));
        const offsets = [0x1000, 0x2000];
        const table = canonicalGpsTable(offsets.map((o) => [o, 0x4000]));
        const file = new SparseFile(
            0x10000,
            offsets.map((offset) => ({ offset, data: atom })),
        ) as unknown as File;

        // Calling tryStructuralPath directly proves the records come from the
        // sparse table reads - the streaming scan is not reachable from here.
        const parsed = await tryStructuralPath(file, indexStub(table), parseFreeGpsBlock);
        expect(parsed).not.toBeNull();
        expect(parsed!.records).toHaveLength(2);
        expect(parsed!.records[0]!.lat).toBeCloseTo(50.1, 6);
        expect(parsed!.records[0]!.lon).toBeCloseTo(30.05, 6);
    });

    it("clamps an overshooting declared count to the entries that fit (truncated table)", async () => {
        const atom = blockAtomBytes(buildCanonicalType3Block({ anchor: 68 }));
        const offsets = [0x1000, 0x2000];
        // Declared 100 entries, payload sized for 2 - ExifTool's clamp keeps the prefix.
        const table = canonicalGpsTable(
            offsets.map((o) => [o, 0x4000]),
            100,
        );
        const file = new SparseFile(
            0x10000,
            offsets.map((offset) => ({ offset, data: atom })),
        ) as unknown as File;
        const parsed = await tryStructuralPath(file, indexStub(table), parseFreeGpsBlock);
        expect(parsed).not.toBeNull();
        expect(parsed!.records).toHaveLength(2);
    });

    it("legacy layout (count LE at 0, literal-pointing entries) still parses via the fallback candidate", async () => {
        const block = buildCanonicalType3Block({ anchor: 68 });
        const literalBytes = new Uint8Array(block.buffer, block.byteOffset, block.byteLength);
        const offsets = [0x1000, 0x2000];
        const table = legacyGpsTable(offsets.map((o) => [o, 0x4000]));
        const file = new SparseFile(
            0x10000,
            offsets.map((offset) => ({ offset, data: literalBytes })),
        ) as unknown as File;
        const parsed = await tryStructuralPath(file, indexStub(table), parseFreeGpsBlock);
        expect(parsed).not.toBeNull();
        expect(parsed!.records).toHaveLength(2);
        expect(parsed!.records[0]!.lat).toBeCloseTo(50.1, 6);
    });

    it("a garbage table produces no candidates - falls through to streaming (null)", async () => {
        const table = new Uint8Array(32).fill(0xff);
        const file = new SparseFile(0x10000, []) as unknown as File;
        const parsed = await tryStructuralPath(file, indexStub(table), parseFreeGpsBlock);
        expect(parsed).toBeNull();
    });

    it("a table pointing at non-freeGPS bytes is rejected by the bounded preflight", async () => {
        const junk = new Uint8Array(64).fill(0x42);
        const table = canonicalGpsTable([[0x1000, 0x4000]]);
        const file = new SparseFile(0x10000, [{ offset: 0x1000, data: junk }]) as unknown as File;
        const parsed = await tryStructuralPath(file, indexStub(table), parseFreeGpsBlock);
        expect(parsed).toBeNull();
    });

    it("keeps a valid table when its first descriptor is corrupt", async () => {
        const junk = new Uint8Array(64).fill(0x42);
        const atom = blockAtomBytes(buildCanonicalType3Block({ anchor: 68 }));
        const table = canonicalGpsTable([
            [0x1000, 0x4000],
            [0x2000, 0x4000],
        ]);
        const file = new SparseFile(0x10000, [
            { offset: 0x1000, data: junk },
            { offset: 0x2000, data: atom },
        ]) as unknown as File;

        const parsed = await tryStructuralPath(file, indexStub(table), parseFreeGpsBlock);
        expect(parsed).not.toBeNull();
        expect(parsed!.records).toHaveLength(1);
        expect(parsed!.skipped[0]?.line).toBe(1);
    });
});

// ===== Azdome per-file accel baseline removal (primitive pipeline) =====
//
// The block-level Azdome tests above deliberately pin the RAW gravity-
// included accel output; gravity (DC) removal is a per-file pass in the
// freegps primitive, keyed on the variant that claimed the file's records.
// These tests pin that pass on synthetic multi-block files over both IO
// paths (structural table and streaming scan).

describe("freegps primitive: Azdome per-file accel baseline removal", () => {
    // Two accel-bearing blocks - a steady one and an X-outlier ("braking"
    // event) - plus one GPS-only block without an accel group.
    const azdomeBlocks = (): DataView[] => [
        buildAzdomeGs63hBlock({ datetime: "20180924224928", accel: "+093-003-005" }),
        buildAzdomeGs63hBlock({ datetime: "20180924224929", accel: "+193-003-005" }),
        buildAzdomeGs63hBlock({ datetime: "20180924224930", accel: null }),
    ];

    function structuralFixture(blocks: DataView[]): { vf: VendorFile; index: Mp4Index } {
        const offsets = blocks.map((_, i) => 0x1000 * (i + 1));
        const table = canonicalGpsTable(offsets.map((o) => [o, 0x4000]));
        const file = new SparseFile(
            0x10000,
            blocks.map((block, i) => ({ offset: offsets[i]!, data: blockAtomBytes(block) })),
        ) as unknown as File;
        return { vf: { file, relativePath: "az.mp4" }, index: indexStub(table) };
    }

    function streamingFixture(blocks: DataView[]): { vf: VendorFile; index: Mp4Index } {
        const file = new SparseFile(
            0x10000,
            blocks.map((block, i) => ({
                offset: 0x1000 * (i + 1),
                data: new Uint8Array(block.buffer, block.byteOffset, block.byteLength),
            })),
        ) as unknown as File;
        // No `gps ` atom -> the structural path bails and the streaming
        // (linear) scan carries the parse.
        const index = { novatekGpsAtom: null, moovView: null } as unknown as Mp4Index;
        return { vf: { file, relativePath: "az.mp4" }, index };
    }

    async function expectBaselineRemoved(fixture: { vf: VendorFile; index: Mp4Index }): Promise<void> {
        const parsed = await freegpsPrimitive.parse(fixture.vf, fixture.index);
        expect(parsed.records).toHaveLength(3);
        const steady = parsed.records[0]!;
        const outlier = parsed.records[1]!;
        const noAccel = parsed.records[2]!;
        // Mean over the two accel-bearing records: X 1.43, Y -0.03, Z -0.05.
        expect(steady.accelXg).toBeCloseTo(-0.5, 6);
        expect(outlier.accelXg).toBeCloseTo(0.5, 6); // the event keeps its deviation from the mean
        for (const r of [steady, outlier]) {
            expect(r.accelYg).toBeCloseTo(0, 6);
            expect(r.accelZg).toBeCloseTo(0, 6);
        }
        // Per-axis mean over the accel-bearing records is ~0 after removal.
        expect((steady.accelXg + outlier.accelXg) / 2).toBeCloseTo(0, 10);
        // The record without an accel group is not disturbed.
        expect([noAccel.accelXg, noAccel.accelYg, noAccel.accelZg]).toEqual([0, 0, 0]);
    }

    it("structural path: per-axis mean ~0, event deviation survives, no-accel record untouched", async () => {
        await expectBaselineRemoved(structuralFixture(azdomeBlocks()));
    });

    it("streaming path: same treatment as structural", async () => {
        await expectBaselineRemoved(streamingFixture(azdomeBlocks()));
    });

    it("a single accel-bearing record is zeroed (one sample cannot separate bias from motion)", async () => {
        const { vf, index } = structuralFixture([buildAzdomeGs63hBlock()]);
        const parsed = await freegpsPrimitive.parse(vf, index);
        expect(parsed.records).toHaveLength(1);
        const r = parsed.records[0]!;
        expect([r.accelXg, r.accelYg, r.accelZg]).toEqual([0, 0, 0]);
        // The GPS fields are decoded normally - only the accel is zeroed.
        expect(r.lat).toBeCloseTo(40.7739166, 6);
    });

    it("a non-Azdome file keeps its raw accel byte-for-byte (no blanket subtraction)", async () => {
        // LAYOUT_LEGACY (anchor 40) carries accel int32s /256 at 60/64/68 -
        // the values are exact powers of two, so toBe pins them bit-exact.
        const legacyBlock = (second: number, rawX: number): DataView => {
            const dv = buildCanonicalType3Block({ anchor: 40, s: second });
            dv.setInt32(60, rawX, true);
            dv.setInt32(64, -32, true);
            dv.setInt32(68, 64, true);
            return dv;
        };
        const { vf, index } = structuralFixture([legacyBlock(30, 128), legacyBlock(31, 256)]);
        const parsed = await freegpsPrimitive.parse(vf, index);
        expect(parsed.records).toHaveLength(2);
        expect(parsed.records[0]!.accelXg).toBe(0.5);
        expect(parsed.records[1]!.accelXg).toBe(1);
        expect(parsed.records.map((r) => r.accelYg)).toEqual([-0.125, -0.125]);
        expect(parsed.records.map((r) => r.accelZg)).toEqual([0.25, 0.25]);
    });
});

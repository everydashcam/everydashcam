// Tests for mp4-walker. Currently covers findMoovInFile.
//
// The forward-walk through box headers is critical because our own export
// (mediabunny fastStart:false) writes moov at the end of the file. For
// re-ingest of our own exports to work, the walker must find moov regardless
// of position. This test therefore exercises the moov-at-end layout.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
    findMoovInFile,
    fourCCToVideoCodec,
    hevcCodecStringFromHvcc,
    iterBoxes,
    loadSamples,
    readMvhdCreationTime,
    readMvhdDurationSec,
    readTkhdRotation,
    readHandlerType,
    readChunkByteRanges,
    readFirstSampleEntry,
    readSampleTable,
    readSampleDurationsInTicks,
    readSampleStartsInTicks,
    readSoundSampleParams,
    readVideoFrameRate,
    findBox,
    type Box,
    type SampleEntry,
} from "./mp4-walker.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("findMoovInFile", () => {
    it("finds moov in normal mp4 (moov-at-front)", async () => {
        const buf = readFileSync(resolve(REPO_ROOT, "tests/testdata/dashcam-viewer-corpus/MOV_0581.mp4"));
        const file = new File([buf], "test.mp4");

        const found = await findMoovInFile(file);
        expect(found).not.toBeNull();
        expect(found!.fileStart).toBeGreaterThanOrEqual(0);
        expect(found!.fileEnd).toBeLessThanOrEqual(buf.byteLength);

        // bytes must start with the size+'moov' header.
        expect(found!.bytes.byteLength).toBe(found!.fileEnd - found!.fileStart);
        const dv = new DataView(found!.bytes.buffer, found!.bytes.byteOffset, found!.bytes.byteLength);
        const sz = dv.getUint32(0);
        const t = String.fromCharCode(dv.getUint8(4), dv.getUint8(5), dv.getUint8(6), dv.getUint8(7));
        expect(t).toBe("moov");
        expect(sz).toBe(found!.bytes.byteLength);
    });

    it("finds moov when synthesized as moov-at-end via byte reorder", async () => {
        // Emulate mediabunny fastStart:false: reorder boxes as ftyp → mdat → moov,
        // mimicking the 230 MB file from the bug reproducer
        // (private/incoming/troubles/dashcamigo_*.mp4) on a small public fixture.
        const original = new Uint8Array(
            readFileSync(resolve(REPO_ROOT, "tests/testdata/dashcam-viewer-corpus/MOV_0581.mp4")),
        );
        const dv = new DataView(original.buffer, original.byteOffset, original.byteLength);

        const boxes: { type: string; bytes: Uint8Array }[] = [];
        for (const b of iterBoxes(dv, 0, dv.byteLength)) {
            boxes.push({ type: b.type, bytes: original.slice(b.start, b.end) });
        }
        // Take ftyp + mdats + moov, move moov to the end.
        const ftyp = boxes.find((b) => b.type === "ftyp")!;
        const moov = boxes.find((b) => b.type === "moov")!;
        const others = boxes.filter((b) => b.type !== "ftyp" && b.type !== "moov");

        let total = ftyp.bytes.byteLength + moov.bytes.byteLength;
        for (const b of others) total += b.bytes.byteLength;
        const reordered = new Uint8Array(total);
        let pos = 0;
        reordered.set(ftyp.bytes, pos);
        pos += ftyp.bytes.byteLength;
        for (const b of others) {
            reordered.set(b.bytes, pos);
            pos += b.bytes.byteLength;
        }
        const moovOffset = pos;
        reordered.set(moov.bytes, pos);

        const file = new File([reordered], "synth-end.mp4");
        const found = await findMoovInFile(file);
        expect(found).not.toBeNull();
        expect(found!.fileStart).toBe(moovOffset);
        expect(found!.fileEnd).toBe(moovOffset + moov.bytes.byteLength);
        expect(found!.bytes.byteLength).toBe(moov.bytes.byteLength);
    });

    it("returns null for non-mp4 garbage", async () => {
        // File too small or with a corrupt box header: returns null, not throw.
        // Caller should treat this as "not our format".
        const garbage = new Uint8Array(64);
        // first 4 bytes = huge size → pos+size > fileSize → return null
        new DataView(garbage.buffer).setUint32(0, 999_999_999, false);
        garbage.set(new TextEncoder().encode("XYZW"), 4);
        const file = new File([garbage], "garbage.bin");
        const found = await findMoovInFile(file);
        expect(found).toBeNull();
    });

    it("returns null for empty file", async () => {
        const file = new File([new Uint8Array(0)], "empty.bin");
        const found = await findMoovInFile(file);
        expect(found).toBeNull();
    });
});

describe("readMvhdDurationSec / readMvhdCreationTime", () => {
    // Uses the same public fixture as findMoovInFile tests - provides a real
    // mvhd without hand-crafting bytes. Exact duration/creation_time values
    // are file-dependent; we verify structurally: both parse to finite numbers.
    it("extracts duration and creation_time from real moov", async () => {
        const buf = readFileSync(resolve(REPO_ROOT, "tests/testdata/dashcam-viewer-corpus/MOV_0581.mp4"));
        const file = new File([buf], "test.mp4");
        const found = await findMoovInFile(file);
        expect(found).not.toBeNull();
        const dv = new DataView(found!.bytes.buffer, found!.bytes.byteOffset, found!.bytes.byteLength);

        const dur = readMvhdDurationSec(dv);
        expect(dur).not.toBeNull();
        expect(dur).toBeGreaterThan(0);
        expect(Number.isFinite(dur!)).toBe(true);

        const ct = readMvhdCreationTime(dv);
        // Field may be zero on some sources - returns null. When non-null, must
        // be a Date in a sane range (after the MP4 epoch 1904, before end of century).
        if (ct !== null) {
            const year = ct.getUTCFullYear();
            expect(year).toBeGreaterThan(1970);
            expect(year).toBeLessThan(2100);
        }
    });

    it("returns null for buffer without moov", () => {
        const dv = new DataView(new ArrayBuffer(64));
        // Fill with garbage so findBox for 'moov' finds nothing.
        new Uint8Array(dv.buffer).fill(0xff);
        expect(readMvhdDurationSec(dv)).toBeNull();
        expect(readMvhdCreationTime(dv)).toBeNull();
    });
});

describe("mvhd all-bits-set sentinels (unknown duration/creation)", () => {
    // ISO 14496-12 defines all-bits-set duration as "unknown"; truncated /
    // power-loss dashcam recordings carry exactly that. Decoding it literally
    // used to yield a ~49.7-day durationSec (v0, timescale 1000) and a
    // 2040-02-06 creation date. Fixture is synthetic: a minimal moov>mvhd box,
    // same hand-built style as the tkhd test above.

    /**
     * Builds a minimal moov>mvhd box. 64-bit v1 fields are passed as raw
     * [high, low] 32-bit word pairs so the all-ones sentinel can be expressed
     * without a 64-bit literal (not representable as a double).
     */
    function buildMoovWithMvhd(
        version: 0 | 1,
        creation: number | [high: number, low: number],
        timescale: number,
        duration: number | [high: number, low: number],
    ): DataView {
        // v0 payload: ver/flags(4) + creation(4) + modification(4) + timescale(4) + duration(4)
        // v1 payload: ver/flags(4) + creation(8) + modification(8) + timescale(4) + duration(8)
        const payloadLen = version === 1 ? 32 : 20;
        const mvhdSize = 8 + payloadLen;
        const moovSize = 8 + mvhdSize;
        const bytes = new Uint8Array(moovSize);
        const dv = new DataView(bytes.buffer);
        dv.setUint32(0, moovSize);
        bytes.set(new TextEncoder().encode("moov"), 4);
        dv.setUint32(8, mvhdSize);
        bytes.set(new TextEncoder().encode("mvhd"), 12);
        dv.setUint8(16, version);
        // Writes a creation/modification/duration field at `off`, returns the
        // offset right past it (4 bytes for v0, 8 for v1).
        const writeWide = (off: number, value: number | [number, number]): number => {
            const [high, low] = Array.isArray(value) ? value : [0, value];
            if (version === 1) {
                dv.setUint32(off, high);
                dv.setUint32(off + 4, low);
                return off + 8;
            }
            dv.setUint32(off, low);
            return off + 4;
        };
        let off = writeWide(20, creation); // fields start after ver/flags
        off = writeWide(off, 0); // modification_time - unused by the readers
        dv.setUint32(off, timescale);
        writeWide(off + 4, duration);
        return dv;
    }

    const ALL_ONES = 0xffffffff;

    it("v0 duration 0xFFFFFFFF -> null", () => {
        const dv = buildMoovWithMvhd(0, 100, 1000, ALL_ONES);
        expect(readMvhdDurationSec(dv)).toBeNull();
    });

    it("v1 duration 0xFFFFFFFFFFFFFFFF -> null", () => {
        const dv = buildMoovWithMvhd(1, [0, 100], 1000, [ALL_ONES, ALL_ONES]);
        expect(readMvhdDurationSec(dv)).toBeNull();
    });

    it("v0 creation 0xFFFFFFFF -> null", () => {
        const dv = buildMoovWithMvhd(0, ALL_ONES, 1000, 60_000);
        expect(readMvhdCreationTime(dv)).toBeNull();
    });

    it("v1 creation 0xFFFFFFFFFFFFFFFF -> null", () => {
        const dv = buildMoovWithMvhd(1, [ALL_ONES, ALL_ONES], 1000, [0, 60_000]);
        expect(readMvhdCreationTime(dv)).toBeNull();
    });

    it("non-sentinel values still parse (v0)", () => {
        // creation = MP4-epoch offset + 1.6e9 -> Unix 1.6e9 = 2020-09-13T12:26:40Z.
        const creation = 2_082_844_800 + 1_600_000_000;
        const dv = buildMoovWithMvhd(0, creation, 1000, 60_000);
        expect(readMvhdDurationSec(dv)).toBe(60);
        expect(readMvhdCreationTime(dv)?.getTime()).toBe(1_600_000_000 * 1000);
    });

    it("v0 near-epoch creation (DDPAI Z50: 1904-epoch + 64s = unix 64s, 1970) -> null", () => {
        // The raw field the Z50 writes: a few seconds of boot-uptime, decoding
        // to 1970-01-01T00:01:04Z. Not 0 and not all-ones, so it slips both old
        // guards and would shadow the good filename date in deriveStartUtc.
        const dv = buildMoovWithMvhd(0, 2_082_844_800 + 64, 1000, 60_000);
        expect(readMvhdCreationTime(dv)).toBeNull();
    });

    it("v0 creation one second below the 2000-01-01 floor -> null", () => {
        const justBelow = 2_082_844_800 + Date.UTC(1999, 11, 31, 23, 59, 59) / 1000;
        expect(readMvhdCreationTime(buildMoovWithMvhd(0, justBelow, 1000, 60_000))).toBeNull();
    });

    it("v0 creation exactly at the 2000-01-01 floor still parses (>=, not >)", () => {
        const atFloor = 2_082_844_800 + 946_684_800;
        expect(readMvhdCreationTime(buildMoovWithMvhd(0, atFloor, 1000, 60_000))?.getTime()).toBe(946_684_800 * 1000);
    });

    it("v1 near-epoch creation (boot-uptime in the low word) -> null", () => {
        const dv = buildMoovWithMvhd(1, [0, 2_082_844_800 + 64], 1000, [0, 60_000]);
        expect(readMvhdCreationTime(dv)).toBeNull();
    });

    it("v1 near-sentinel ...FFFFFFFE is NOT nullified (word-wise compare, no double rounding)", () => {
        // 0xFFFFFFFFFFFFFFFE rounds to 2^64 as a double - exactly the value
        // the all-ones sentinel also rounds to. A combined-number comparison
        // would false-match it; the word-wise check must not.
        const dv = buildMoovWithMvhd(1, [0, 100], 1000, [ALL_ONES, 0xfffffffe]);
        const dur = readMvhdDurationSec(dv);
        expect(dur).not.toBeNull();
        expect(dur).toBeGreaterThan(0);
    });
});

describe("fourCCToVideoCodec", () => {
    it("maps known FourCCs", () => {
        expect(fourCCToVideoCodec("avc1")).toBe("avc");
        expect(fourCCToVideoCodec("avc3")).toBe("avc");
        expect(fourCCToVideoCodec("hvc1")).toBe("hevc");
        expect(fourCCToVideoCodec("hev1")).toBe("hevc");
        expect(fourCCToVideoCodec("vp09")).toBe("vp9");
        expect(fourCCToVideoCodec("av01")).toBe("av1");
        expect(fourCCToVideoCodec("vp08")).toBe("vp8");
    });
    it("returns null for unknown FourCCs", () => {
        expect(fourCCToVideoCodec("gpmd")).toBeNull();
        expect(fourCCToVideoCodec("xxxx")).toBeNull();
        expect(fourCCToVideoCodec("")).toBeNull();
    });
});

describe("readTkhdRotation", () => {
    // The public corpus video almost certainly has rotation=0. Verify
    // structurally on a real file - the function does not throw and returns
    // one of the four valid values.
    it("reads rotation from real moov tkhd", async () => {
        const buf = readFileSync(resolve(REPO_ROOT, "tests/testdata/dashcam-viewer-corpus/MOV_0581.mp4"));
        const file = new File([buf], "test.mp4");
        const found = await findMoovInFile(file);
        expect(found).not.toBeNull();
        const dv = new DataView(found!.bytes.buffer, found!.bytes.byteOffset, found!.bytes.byteLength);
        const moov = findBox(dv, 0, dv.byteLength, "moov");
        expect(moov).not.toBeNull();
        let videoTrak = null;
        for (const child of iterBoxes(dv, moov!.payloadStart, moov!.end)) {
            if (child.type !== "trak") continue;
            if (readHandlerType(dv, child) === "vide") {
                videoTrak = child;
                break;
            }
        }
        expect(videoTrak).not.toBeNull();
        const rot = readTkhdRotation(dv, videoTrak!);
        expect([0, 90, 180, 270]).toContain(rot);
    });

    it("returns 0 for trak without tkhd", () => {
        // Synthesize a minimal 'trak' box with no children - falls through to 0.
        const trakBox = { type: "trak", start: 0, end: 8, payloadStart: 8 };
        const dv = new DataView(new ArrayBuffer(8));
        new Uint8Array(dv.buffer).fill(0);
        expect(readTkhdRotation(dv, trakBox)).toBe(0);
    });

    it("detects 90-degree rotation from synthetic matrix", () => {
        // Build a minimal trak/tkhd with matrix corresponding to 90° rotation.
        // tkhd payload (v0): version+flags(4) + creation(4) + modification(4)
        //   + track_id(4) + reserved(4) + duration(4) + reserved(8)
        //   + layer/alt/vol/reserved(8) + matrix(36) = 76 bytes
        // box = header(8) + payload(76) = 84 bytes
        // trak wraps tkhd = 8 + 84 = 92 bytes
        const tkhdPayload = new ArrayBuffer(76);
        const dv = new DataView(tkhdPayload);
        // version+flags = 0 (so v0 path)
        // matrix at offset 4 + 20 + 8 + 8 = 40
        const ONE = 0x00010000;
        // 90°: a=0 b=+1 u=0 c=-1 d=0 v=0 x=0 y=0 w=+1
        dv.setInt32(40, 0); // a
        dv.setInt32(44, ONE); // b
        dv.setInt32(48, 0); // u
        dv.setInt32(52, -ONE); // c
        dv.setInt32(56, 0); // d
        dv.setInt32(60, 0); // v
        // x, y, w left zero

        // Wrap in a trak/tkhd box layout in one Uint8Array.
        const tkhdBoxSize = 8 + 76;
        const trakBoxSize = 8 + tkhdBoxSize;
        const buf = new Uint8Array(trakBoxSize);
        const wv = new DataView(buf.buffer);
        // trak header
        wv.setUint32(0, trakBoxSize);
        buf.set(new TextEncoder().encode("trak"), 4);
        // tkhd header at offset 8
        wv.setUint32(8, tkhdBoxSize);
        buf.set(new TextEncoder().encode("tkhd"), 12);
        // tkhd payload at 16
        buf.set(new Uint8Array(tkhdPayload), 16);

        const trak = { type: "trak", start: 0, end: trakBoxSize, payloadStart: 8 };
        expect(readTkhdRotation(wv, trak)).toBe(90);
    });
});

// ===== synthetic soun trak for the audio-track readers =====

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
    let len = 8;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    new DataView(out.buffer).setUint32(0, len);
    // type may contain non-ASCII bytes (e.g. the 'ms\0\x11' sample entry).
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}
function u32be(...ns: number[]): Uint8Array {
    const out = new Uint8Array(ns.length * 4);
    const dv = new DataView(out.buffer);
    ns.forEach((n, i) => {
        dv.setUint32(i * 4, n >>> 0);
    });
    return out;
}

function trakWithSampleTable(...tableBoxes: Uint8Array[]): { dv: DataView; trak: Box } {
    const trakBytes = box("trak", box("mdia", box("minf", box("stbl", ...tableBoxes))));
    return {
        dv: new DataView(trakBytes.buffer, trakBytes.byteOffset, trakBytes.byteLength),
        trak: { type: "trak", start: 0, end: trakBytes.length, payloadStart: 8 },
    };
}

function trakWithTiming(
    timescale: number,
    ...entries: Array<[sampleCount: number, sampleDelta: number]>
): {
    dv: DataView;
    trak: Box;
} {
    const mdhd = box("mdhd", u32be(0, 0, 0, timescale, 0));
    const stts = box("stts", u32be(0, entries.length, ...entries.flat()));
    const trakBytes = box("trak", box("mdia", mdhd, box("minf", box("stbl", stts))));
    return {
        dv: new DataView(trakBytes.buffer, trakBytes.byteOffset, trakBytes.byteLength),
        trak: { type: "trak", start: 0, end: trakBytes.length, payloadStart: 8 },
    };
}

function le(spec: [number, number][]): Uint8Array {
    const total = spec.reduce((a, [, w]) => a + w, 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    let o = 0;
    for (const [v, w] of spec) {
        if (w === 2) dv.setUint16(o, v, true);
        else dv.setUint32(o, v, true);
        o += w;
    }
    return out;
}

const MS_IMA = String.fromCharCode(0x6d, 0x73, 0x00, 0x11); // 'ms\0\x11' = WAVE 0x0011

// Builds a soun trak: hdlr('soun') + stbl{stsd(ms IMA, v1 sound desc + wave),
// stco[1000,2000], stsc(spc=4), stsz(size=1, count=8)}.
function buildSounTrak(): { dv: DataView; trak: Box } {
    // stsd: ms\0\x11 sample entry, sound description v1 (ch=2, 32 kHz) + wave/WAVEFORMATEX.
    const wfx = box(
        MS_IMA, // WAVEFORMATEX little-endian
        le([
            [0x11, 2], // wFormatTag
            [2, 2], // nChannels
            [32000, 4], // nSamplesPerSec
            [32218, 4], // nAvgBytesPerSec
            [1024, 2], // nBlockAlign
            [4, 2], // wBitsPerSample
            [2, 2], // cbSize
            [1017, 2], // wSamplesPerBlock
        ]),
    );
    const wave = box("wave", box("frma", new Uint8Array([0x6d, 0x73, 0x00, 0x11])), wfx);
    const soundDescV1 = new Uint8Array([
        0x00,
        0x01,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00, // version=1, revision, vendor
        0x00,
        0x02,
        0x00,
        0x04,
        0x00,
        0x00,
        0x00,
        0x00, // channels=2, sampleSize=4, compID, packetSize
        0x7d,
        0x00,
        0x00,
        0x00, // sampleRate 16.16 -> 32000
        0x00,
        0x00,
        0x03,
        0xf9, // samplesPerPacket=1017
        0x00,
        0x00,
        0x00,
        0x22, // bytesPerPacket=34
        0x00,
        0x00,
        0x04,
        0x00, // bytesPerFrame=1024
        0x00,
        0x00,
        0x00,
        0x04, // bytesPerSample=4
    ]);
    const sampleEntry = box(
        MS_IMA,
        new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), // 6 reserved + data_ref_index=1
        soundDescV1,
        wave,
    );
    const stsd = box("stsd", u32be(0, 1), sampleEntry); // version+flags, entry_count=1
    const stco = box("stco", u32be(0, 2, 1000, 2000)); // 2 chunks at 1000, 2000
    const stsc = box("stsc", u32be(0, 1, 1, 4, 1)); // 1 entry: first_chunk=1, spc=4, sdi=1
    const stsz = box("stsz", u32be(0, 1, 8)); // sample_size=1, sample_count=8
    const stbl = box("stbl", stsd, stco, stsc, stsz);
    const minf = box("minf", stbl);
    const hdlr = box("hdlr", u32be(0, 0), new Uint8Array([0x73, 0x6f, 0x75, 0x6e]), u32be(0, 0, 0)); // 'soun'
    const mdia = box("mdia", hdlr, minf);
    const trakBytes = box("trak", mdia);
    const dv = new DataView(trakBytes.buffer, trakBytes.byteOffset, trakBytes.byteLength);
    return { dv, trak: { type: "trak", start: 0, end: trakBytes.length, payloadStart: 8 } };
}

describe("readSoundSampleParams", () => {
    it("reads IMA-ADPCM block params from a QuickTime ms-entry sound description", () => {
        const { dv, trak } = buildSounTrak();
        const p = readSoundSampleParams(dv, trak);
        expect(p).not.toBeNull();
        expect(p!.format).toBe(MS_IMA);
        expect(p!.channels).toBe(2);
        expect(p!.sampleRate).toBe(32000);
        // From the embedded WAVEFORMATEX (the canonical, little-endian source).
        expect(p!.blockAlign).toBe(1024);
        expect(p!.samplesPerBlock).toBe(1017);
    });
});

describe("readChunkByteRanges", () => {
    it("gathers per-chunk byte ranges from stco/stsc/stsz (1-byte samples)", () => {
        const { dv, trak } = buildSounTrak();
        const ranges = readChunkByteRanges(dv, trak);
        // 2 chunks, 4 one-byte samples each -> 4-byte ranges at the chunk offsets.
        expect(ranges).toEqual([
            { offset: 1000, length: 4 },
            { offset: 2000, length: 4 },
        ]);
    });
});

describe("sample table readers", () => {
    it.each(["stco", "co64"])("follows changing chunk runs and bounds the final %s chunk by stsz", (format) => {
        const offsetBase = format === "co64" ? 0x100000000 : 0;
        const offsets = [1000, 2000, 3000, 4000, 5000, 6000];
        const chunkOffsets = box(
            format,
            u32be(0, offsets.length, ...offsets.flatMap((offset) => (format === "co64" ? [1, offset] : [offset]))),
        );
        const stsc = box("stsc", u32be(0, 4, 1, 0, 1, 2, 2, 1, 4, 0, 1, 5, 3, 1));
        const stsz = box("stsz", u32be(0, 0, 6, 7, 0, 9, 11, 13, 17));
        const { dv, trak } = trakWithSampleTable(chunkOffsets, stsc, stsz);

        expect(readSampleTable(dv, trak)).toEqual([
            { offset: offsetBase + 2000, size: 7, index: 1 },
            { offset: offsetBase + 2007, size: 0, index: 2 },
            { offset: offsetBase + 3000, size: 9, index: 3 },
            { offset: offsetBase + 3009, size: 11, index: 4 },
            { offset: offsetBase + 5000, size: 13, index: 5 },
            { offset: offsetBase + 5013, size: 17, index: 6 },
        ]);
        expect(readChunkByteRanges(dv, trak)).toEqual([
            { offset: offsetBase + 1000, length: 0 },
            { offset: offsetBase + 2000, length: 7 },
            { offset: offsetBase + 3000, length: 20 },
            { offset: offsetBase + 4000, length: 0 },
            { offset: offsetBase + 5000, length: 30 },
        ]);
        expect(readFirstSampleEntry(dv, trak)).toEqual({ offset: offsetBase + 2000, size: 7, index: 1 });
    });

    it("rejects a corrupt stco without falling back to a valid co64", () => {
        const stco = box("stco", u32be(0, 2, 1000));
        const co64 = box("co64", u32be(0, 1, 0, 2000));
        const stsc = box("stsc", u32be(0, 1, 1, 1, 1));
        const stsz = box("stsz", u32be(0, 1, 1));
        const { dv, trak } = trakWithSampleTable(stco, co64, stsc, stsz);
        expect(readSampleTable(dv, trak)).toBeNull();
        expect(readChunkByteRanges(dv, trak)).toBeNull();
        expect(readFirstSampleEntry(dv, trak)).toBeNull();
    });
});

describe("readFirstSampleEntry", () => {
    it("reads a fixed-size first sample without materialising the complete table", () => {
        const { dv, trak } = buildSounTrak();
        expect(readFirstSampleEntry(dv, trak)).toEqual({ offset: 1000, size: 1, index: 1 });
    });

    it("skips empty leading chunks and reads a variable size through co64", () => {
        const co64 = box("co64", u32be(0, 2, 0, 1000, 0, 2000));
        const stsc = box("stsc", u32be(0, 2, 1, 0, 1, 2, 2, 1));
        const stsz = box("stsz", u32be(0, 0, 2, 7, 9));
        const { dv, trak } = trakWithSampleTable(co64, stsc, stsz);
        expect(readFirstSampleEntry(dv, trak)).toEqual({ offset: 2000, size: 7, index: 1 });
    });

    it("returns null instead of throwing on a truncated table header", () => {
        const stco = box("stco", u32be(0));
        const stsc = box("stsc", u32be(0, 1, 1, 1, 1));
        const stsz = box("stsz", u32be(0, 1, 1));
        const { dv, trak } = trakWithSampleTable(stco, stsc, stsz);
        expect(() => readFirstSampleEntry(dv, trak)).not.toThrow();
        expect(readFirstSampleEntry(dv, trak)).toBeNull();
    });
});

describe("stts readers", () => {
    it("expands starts/durations but summarizes VFR directly for frame rate", () => {
        const { dv, trak } = trakWithTiming(30_000, [2, 1000], [1, 2000]);
        expect(readSampleStartsInTicks(dv, trak)).toEqual([0, 1000, 2000]);
        expect(readSampleDurationsInTicks(dv, trak)).toEqual([1000, 1000, 2000]);
        expect(readVideoFrameRate(dv, trak)).toBeCloseTo(22.5, 9);
    });

    it("rejects a corrupt oversized sample count before allocating", () => {
        const { dv, trak } = trakWithTiming(30_000, [10_000_001, 1000]);
        expect(readSampleStartsInTicks(dv, trak)).toBeNull();
        expect(readSampleDurationsInTicks(dv, trak)).toBeNull();
        expect(readVideoFrameRate(dv, trak)).toBeNull();
    });

    it("returns null instead of throwing on a truncated stts header", () => {
        const mdhd = box("mdhd", u32be(0, 0, 0, 30_000, 0));
        const stts = box("stts", u32be(0));
        const trakBytes = box("trak", box("mdia", mdhd, box("minf", box("stbl", stts))));
        const dv = new DataView(trakBytes.buffer, trakBytes.byteOffset, trakBytes.byteLength);
        const trak = { type: "trak", start: 0, end: trakBytes.length, payloadStart: 8 };
        expect(readSampleStartsInTicks(dv, trak)).toBeNull();
        expect(readSampleDurationsInTicks(dv, trak)).toBeNull();
        expect(readVideoFrameRate(dv, trak)).toBeNull();
    });

    it("rejects a zero-tick duration summary", () => {
        const { dv, trak } = trakWithTiming(30_000, [2, 0]);
        expect(readSampleDurationsInTicks(dv, trak)).toEqual([0, 0]);
        expect(readVideoFrameRate(dv, trak)).toBeNull();
    });

    it("rejects an FPS summary whose total tick count is not a safe integer", () => {
        const { dv, trak } = trakWithTiming(30_000, [10_000_000, 0xffffffff]);
        expect(readVideoFrameRate(dv, trak)).toBeNull();
    });
});

// Synthetic file that lets the tests both read content AND count IO calls
// so we can verify that the streaming path issues exactly one slice() per
// loadSamples invocation regardless of sample count.
class CountingFile {
    public name = "synthetic.mp4";
    public lastModified = 0;
    public type = "video/mp4";
    public sliceCalls = 0;
    public bytesSliced = 0;
    constructor(
        public size: number,
        private regions: Array<{ offset: number; data: Uint8Array }>,
    ) {}
    slice(start: number, end?: number): Blob {
        this.sliceCalls++;
        const e = Math.min(end ?? this.size, this.size);
        const len = Math.max(0, e - start);
        this.bytesSliced += len;
        const buf = new Uint8Array(len);
        for (const r of this.regions) {
            const rEnd = r.offset + r.data.length;
            if (rEnd <= start || r.offset >= e) continue;
            const copyStart = Math.max(start, r.offset);
            const copyEnd = Math.min(e, rEnd);
            buf.set(r.data.subarray(copyStart - r.offset, copyEnd - r.offset), copyStart - start);
        }
        // Return a real Blob so Blob.stream() works for the streaming path
        // (Node 22 supports Blob.stream natively).
        return new Blob([buf]);
    }
    arrayBuffer(): Promise<ArrayBuffer> {
        return Promise.resolve(new Uint8Array(0).buffer);
    }
}

describe("loadSamples: adaptive strategy", () => {
    it("preserves dense real byte ranges in requested order with independent output buffers", async () => {
        const bytes = readFileSync(resolve(REPO_ROOT, "tests/testdata/gopro-gpmf/hero8-trimmed.mp4"));
        const file = new File([bytes], "samples.mp4");
        const samples = Array.from({ length: 2000 }, (_, index) => ({
            offset: index * 257,
            size: 257,
            index: index + 1,
        })).reverse();
        const buffers = await loadSamples(file, samples, 10);
        for (let index = 0; index < samples.length; index++) {
            const sample = samples[index]!;
            const actual = Buffer.from(buffers[index]!);
            const expected = bytes.subarray(sample.offset, sample.offset + sample.size);
            expect(actual.equals(expected), `sample ${index} matches its source bytes`).toBe(true);
        }
        expect(new Set(buffers).size).toBe(buffers.length);
    });

    function makeSamples(offsets: number[], size: number): SampleEntry[] {
        return offsets.map((offset, i) => ({ offset, size, index: i + 1 }));
    }
    function makeFile(sampleOffsets: number[], sampleSize: number, fileSize: number): CountingFile {
        const regions = sampleOffsets.map((offset, i) => {
            const data = new Uint8Array(sampleSize);
            // Mark each sample with its index so we can verify correctness.
            for (let j = 0; j < sampleSize; j++) data[j] = (i * 7 + j) & 0xff;
            return { offset, data };
        });
        return new CountingFile(fileSize, regions);
    }

    it("random path: dense samples (<50) makes one slice per sample", async () => {
        const offsets = Array.from({ length: 30 }, (_, i) => 1024 + i * 256);
        const samples = makeSamples(offsets, 256);
        const file = makeFile(offsets, 256, 10 * 1024) as unknown as File;
        // sliceCost=0 → random path (default), but adjacency-coalesce kicks
        // in (samples are contiguous): expect ~1 read total.
        const bufs = await loadSamples(file, samples);
        expect(bufs).toHaveLength(30);
        for (let i = 0; i < 30; i++) {
            expect(bufs[i]!.byteLength).toBe(256);
            const u8 = new Uint8Array(bufs[i]!);
            // First byte must match the marker we wrote.
            expect(u8[0]).toBe((i * 7) & 0xff);
        }
        expect((file as unknown as CountingFile).sliceCalls).toBeLessThanOrEqual(2);
    });

    it("stream path: triggered when sliceCost is high", async () => {
        // Carcam-like: 100 sparse samples × 256 bytes spread over 50 MB.
        const STRIDE = 500 * 1024; // 500 KB
        const offsets = Array.from({ length: 100 }, (_, i) => 1024 + i * STRIDE);
        const samples = makeSamples(offsets, 256);
        const fileSize = offsets[offsets.length - 1]! + 256 + 1024;
        const cf = makeFile(offsets, 256, fileSize);
        const file = cf as unknown as File;

        // sliceCost=10ms → stream path (above SLICE_COST_STREAM_ABOVE=5).
        const bufs = await loadSamples(file, samples, 10);
        expect(bufs).toHaveLength(100);
        for (let i = 0; i < 100; i++) {
            expect(bufs[i]!.byteLength).toBe(256);
            const u8 = new Uint8Array(bufs[i]!);
            expect(u8[0]).toBe((i * 7) & 0xff);
        }
        // Stream path: exactly ONE slice() call regardless of sample count.
        expect(cf.sliceCalls).toBe(1);
    });

    it("random path: low sliceCost beats sparse density", async () => {
        // Same sparse layout, but sliceCost=0.3ms (fast NVMe) → random.
        const offsets = Array.from({ length: 100 }, (_, i) => 1024 + i * 500 * 1024);
        const samples = makeSamples(offsets, 256);
        const fileSize = offsets[offsets.length - 1]! + 256 + 1024;
        const cf = makeFile(offsets, 256, fileSize);
        const file = cf as unknown as File;
        const bufs = await loadSamples(file, samples, 0.3);
        expect(bufs).toHaveLength(100);
        // Random: ~100 reads (no adjacency coalescing on sparse layout).
        expect(cf.sliceCalls).toBeGreaterThan(50);
    });

    it("random path: sparse 1 Hz gpmd over a huge span stays random (span >> bytes)", async () => {
        // The meta-track GPS trap: ~1 Hz samples of a few hundred bytes spread
        // across the whole mdat. Density (500 KB/sample) is way over the sparse
        // threshold, but the span (~50 MB) dwarfs the actual sample bytes
        // (~25 KB), so streaming would read ~50 MB of gaps to get 25 KB. The
        // span-to-bytes gate keeps this on the random+coalesce path.
        const offsets = Array.from({ length: 100 }, (_, i) => 1024 + i * 500 * 1024);
        const samples = makeSamples(offsets, 256);
        const fileSize = offsets[offsets.length - 1]! + 256 + 1024;
        const cf = makeFile(offsets, 256, fileSize);
        const file = cf as unknown as File;
        const bufs = await loadSamples(file, samples, 3);
        expect(bufs).toHaveLength(100);
        for (let i = 0; i < 100; i++) {
            expect(bufs[i]!.byteLength).toBe(256);
            expect(new Uint8Array(bufs[i]!)[0]).toBe((i * 7) & 0xff);
        }
        // Random: one read per sample (no adjacency on this sparse layout).
        expect(cf.sliceCalls).toBeGreaterThan(50);
    });

    it("stream path: density tiebreaker still streams when sample bytes fill the span", async () => {
        // Sparse spacing (150 KB stride > 100 KB threshold) but large samples
        // (50 KB) so the span (~9 MB) is within K× the sample bytes (~3 MB) -
        // the case where sequential streaming genuinely wins over many small
        // reads without wasting IO on gaps.
        const SIZE = 50 * 1024;
        const STRIDE = 150 * 1024;
        const offsets = Array.from({ length: 60 }, (_, i) => 1024 + i * STRIDE);
        const samples = makeSamples(offsets, SIZE);
        const fileSize = offsets[offsets.length - 1]! + SIZE + 1024;
        const cf = makeFile(offsets, SIZE, fileSize);
        const file = cf as unknown as File;
        const bufs = await loadSamples(file, samples, 3);
        expect(bufs).toHaveLength(60);
        for (let i = 0; i < 60; i++) {
            expect(bufs[i]!.byteLength).toBe(SIZE);
            expect(new Uint8Array(bufs[i]!)[0]).toBe((i * 7) & 0xff);
        }
        // Stream path - one slice.
        expect(cf.sliceCalls).toBe(1);
    });

    it("random path: density tiebreaker keeps random for dense mid-cost backend", async () => {
        // 100 dense samples (back-to-back, 256 bytes each = ~25 KB total) +
        // sliceCost=3ms → density tiebreaker prefers random (it'll be one
        // coalesced read since samples are contiguous).
        const offsets = Array.from({ length: 100 }, (_, i) => 1024 + i * 256);
        const samples = makeSamples(offsets, 256);
        const cf = makeFile(offsets, 256, 1024 * 50);
        const file = cf as unknown as File;
        const bufs = await loadSamples(file, samples, 3);
        expect(bufs).toHaveLength(100);
        // Adjacency coalesce: one read.
        expect(cf.sliceCalls).toBe(1);
    });

    it("returns empty array on empty input regardless of strategy", async () => {
        const cf = makeFile([], 0, 1024);
        const file = cf as unknown as File;
        const a = await loadSamples(file, []);
        expect(a).toHaveLength(0);
        const b = await loadSamples(file, [], 10);
        expect(b).toHaveLength(0);
        expect(cf.sliceCalls).toBe(0);
    });
});

describe("hevcCodecStringFromHvcc", () => {
    // Builds a minimal 23-byte HEVCDecoderConfigurationRecord. Only the bytes
    // the codec-string parse reads are meaningful; the rest pad to the fixed
    // prefix length. compatRaw is the on-record (MSB-first) value; the parser
    // bit-reverses it for the string, matching mediabunny / RFC 6381.
    function makeHvcc(opts: {
        profileByte: number; // byte 1: profile_space<<6 | tier<<5 | profile_idc
        compatRaw: number; // bytes 2-5, big-endian
        levelIdc: number; // byte 12
        constraint?: number[]; // bytes 6-11 (up to 6)
    }): Uint8Array {
        const rec = new Uint8Array(23);
        rec[0] = 1; // configurationVersion
        rec[1] = opts.profileByte;
        new DataView(rec.buffer).setUint32(2, opts.compatRaw >>> 0);
        const c = opts.constraint ?? [];
        for (let i = 0; i < Math.min(6, c.length); i++) rec[6 + i] = c[i]!;
        rec[12] = opts.levelIdc;
        return rec;
    }

    it("70mai Main: hev1.1.6.L150 (matches the codec metadata fixture in hvcc.test)", () => {
        // compatRaw 0x60000000 bit-reverses to 6; level 150; no constraint flags.
        expect(hevcCodecStringFromHvcc(makeHvcc({ profileByte: 0x01, compatRaw: 0x60000000, levelIdc: 150 }))).toBe(
            "hev1.1.6.L150",
        );
    });

    it("Main10 high level: profile_idc 2 is encoded (the false-positive the canPlay check catches)", () => {
        // compatRaw 0x20000000 -> 4; level 153 (5.1).
        expect(hevcCodecStringFromHvcc(makeHvcc({ profileByte: 0x02, compatRaw: 0x20000000, levelIdc: 153 }))).toBe(
            "hev1.2.4.L153",
        );
    });

    it("high tier sets the H marker", () => {
        // tier flag (bit 5) set; profile_idc 1.
        expect(hevcCodecStringFromHvcc(makeHvcc({ profileByte: 0x21, compatRaw: 0x60000000, levelIdc: 156 }))).toBe(
            "hev1.1.6.H156",
        );
    });

    it("emits non-zero constraint flags as a trailing hex suffix", () => {
        expect(
            hevcCodecStringFromHvcc(
                makeHvcc({ profileByte: 0x01, compatRaw: 0x60000000, levelIdc: 150, constraint: [0xb0] }),
            ),
        ).toBe("hev1.1.6.L150.B0");
    });

    it("returns null for a record shorter than the 23-byte prefix", () => {
        expect(hevcCodecStringFromHvcc(new Uint8Array(10))).toBeNull();
    });
});

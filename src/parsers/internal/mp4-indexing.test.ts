import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { indexMp4FileWithMoov, indexOneFile } from "./mp4-indexing.js";

// Proves the indexer flips audioNeedsTranscode for the IMA-ADPCM (Mio/Navman)
// `ms ` sample entry and leaves it false for ordinary audio - this flag is what
// routes such files through the MSE transcode path (requiresMseBackend).

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
    let len = 8;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    new DataView(out.buffer).setUint32(0, len);
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

const MS_IMA = String.fromCharCode(0x6d, 0x73, 0x00, 0x11);

/** Minimal v0 mvhd: timescale=1000, duration=5000 (5 s). */
function mvhd(): Uint8Array {
    const payload = new Uint8Array(100);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, 0); // version 0 + flags
    dv.setUint32(12, 1000); // timescale
    dv.setUint32(16, 5000); // duration
    return box("mvhd", payload);
}

/** A one-packet soun trak whose stsd sample entry has the given 4cc. */
function sounTrak(format: string, chunkOffset: number): Uint8Array {
    const soundDesc = new Uint8Array(20);
    const soundDv = new DataView(soundDesc.buffer);
    soundDv.setUint16(8, 2); // channels
    soundDv.setUint16(10, 4); // sample size
    soundDv.setUint32(16, 32_000 << 16); // 16.16 sample rate
    const sampleEntry = box(format, new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), soundDesc);
    const stsd = box("stsd", u32be(0, 1), sampleEntry);
    const stts = box("stts", u32be(0, 1, 1, 32_000));
    const stsc = box("stsc", u32be(0, 1, 1, 1, 1));
    const stsz = box("stsz", u32be(0, 32, 1));
    const stco = box("stco", u32be(0, 1, chunkOffset));
    const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
    const minf = box("minf", stbl);
    const hdlr = box("hdlr", u32be(0, 0), new Uint8Array([0x73, 0x6f, 0x75, 0x6e]), u32be(0, 0, 0)); // 'soun'
    const mdhdPayload = new Uint8Array(20);
    const mdhdDv = new DataView(mdhdPayload.buffer);
    mdhdDv.setUint32(12, 32_000); // timescale
    mdhdDv.setUint32(16, 32_000); // duration (1 s)
    const mdia = box("mdia", box("mdhd", mdhdPayload), hdlr, minf);
    const tkhdPayload = new Uint8Array(84);
    const tkhdDv = new DataView(tkhdPayload.buffer);
    tkhdPayload[3] = 1; // enabled track
    tkhdDv.setUint32(12, 1); // track id
    tkhdDv.setUint32(20, 1_000); // duration in movie timescale
    tkhdDv.setUint32(40, 1 << 16); // identity display matrix
    tkhdDv.setUint32(56, 1 << 16);
    tkhdDv.setUint32(72, 1 << 30);
    return box("trak", box("tkhd", tkhdPayload), mdia);
}

function movWithAudio(format: string, name = "a.mov"): File {
    const ftyp = box("ftyp", new Uint8Array([0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0]));
    const mdat = box("mdat", new Uint8Array(32));
    const moov = box("moov", mvhd(), sounTrak(format, ftyp.length + 8));
    return new File([new Uint8Array([...ftyp, ...mdat, ...moov])], name);
}

/** A vide trak with a VisualSampleEntry (width/height), an stts giving a fixed
 *  fps, and an mdhd timescale. `avc1` so fourCCToVideoCodec resolves to "avc". */
function videTrak(width: number, height: number): Uint8Array {
    // VisualSampleEntry payload: 8B SampleEntry (6 reserved + 2 data_ref_index),
    // 16B pre-width fields, then width@24 / height@26 (u16 BE). 78B is the full
    // fixed prefix; only up to +28 is needed by the dimension reader.
    const vpayload = new Uint8Array(78);
    const vdv = new DataView(vpayload.buffer);
    vdv.setUint16(6, 1); // data_reference_index
    vdv.setUint16(24, width);
    vdv.setUint16(26, height);
    const stsd = box("stsd", u32be(0, 1), box("avc1", vpayload));
    // stts: one run of 150 samples, 1000 ticks each. With mdhd timescale 30000,
    // fps = 150 * 30000 / (150 * 1000) = 30.
    const stts = box("stts", u32be(0, 1, 150, 1000));
    const stbl = box("stbl", stsd, stts);
    const minf = box("minf", stbl);
    const hdlr = box("hdlr", u32be(0, 0), new Uint8Array([0x76, 0x69, 0x64, 0x65]), u32be(0, 0, 0)); // 'vide'
    const mdhdPayload = new Uint8Array(20);
    new DataView(mdhdPayload.buffer).setUint32(12, 30000); // v0 timescale
    const mdia = box("mdia", box("mdhd", mdhdPayload), hdlr, minf);
    return box("trak", mdia);
}

function movWithVideo(width: number, height: number): File {
    const moov = box("moov", mvhd(), videTrak(width, height));
    const ftyp = box("ftyp", new Uint8Array([0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0]));
    return new File([new Uint8Array([...ftyp, ...moov])], "v.mp4");
}

describe("indexMp4FileWithMoov: video metadata", () => {
    it("reads coded width/height and average fps from the video track", async () => {
        const { indexed } = await indexMp4FileWithMoov(movWithVideo(1920, 1080), false);
        expect(indexed).not.toBeNull();
        expect(indexed!.width).toBe(1920);
        expect(indexed!.height).toBe(1080);
        expect(indexed!.fps).toBeCloseTo(30, 1);
        expect(indexed!.codec).toBe("avc");
    });

    it("leaves width/height/fps null when there is no video track", async () => {
        const { indexed } = await indexMp4FileWithMoov(movWithAudio("mp4a"), false);
        expect(indexed).not.toBeNull();
        expect(indexed!.width).toBeNull();
        expect(indexed!.height).toBeNull();
        expect(indexed!.fps).toBeNull();
    });
});

describe("indexMp4FileWithMoov: audio descriptor", () => {
    it("exposes the audio sample-entry 4cc for the details panel", async () => {
        const { indexed } = await indexMp4FileWithMoov(movWithAudio("mp4a"), false);
        expect(indexed!.audio).not.toBeNull();
        expect(indexed!.audio!.codec).toBe("mp4a");
    });

    it("is null when there is no audio track", async () => {
        const { indexed } = await indexMp4FileWithMoov(movWithVideo(1280, 720), false);
        expect(indexed!.audio).toBeNull();
    });
});

describe("indexMp4FileWithMoov: audioNeedsTranscode", () => {
    it("flags IMA-ADPCM (ms\\0\\x11) audio for transcode", async () => {
        const { indexed } = await indexMp4FileWithMoov(movWithAudio(MS_IMA), false);
        expect(indexed).not.toBeNull();
        expect(indexed!.audioNeedsTranscode).toBe(true);
    });

    it("does not flag ordinary AAC (mp4a) audio", async () => {
        const { indexed } = await indexMp4FileWithMoov(movWithAudio("mp4a"), false);
        expect(indexed).not.toBeNull();
        expect(indexed!.audioNeedsTranscode).toBe(false);
    });

    it("is false when there is no audio track", async () => {
        const moov = box("moov", mvhd());
        const ftyp = box("ftyp", new Uint8Array([0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0]));
        const file = new File([new Uint8Array([...ftyp, ...moov])], "novid.mov");
        const { indexed } = await indexMp4FileWithMoov(file, false);
        expect(indexed).not.toBeNull();
        expect(indexed!.audioNeedsTranscode).toBe(false);
    });
});

describe("indexOneFile: ISO-BMFF disguised as transport stream", () => {
    it("flags the real IMA-ADPCM sample entry when an MP4/MOV is named .TS", async () => {
        const { indexed } = await indexOneFile(movWithAudio(MS_IMA, "camera.TS"), false);
        expect(indexed).not.toBeNull();
        expect(indexed!.audioNeedsTranscode).toBe(true);
        expect(indexed!.audio!.codec).toBe(MS_IMA);
    });

    it("does not flag an ordinary audio sample entry merely because the file is named .TS", async () => {
        const { indexed } = await indexOneFile(movWithAudio("mp4a", "ordinary.TS"), false);
        expect(indexed).not.toBeNull();
        expect(indexed!.audioNeedsTranscode).toBe(false);
    });
});

/** Parses a "01 02"-format hex string into a Uint8Array. */
function bytes(hex: string): Uint8Array {
    const tokens = hex.trim().split(/\s+/);
    const out = new Uint8Array(tokens.length);
    for (let i = 0; i < tokens.length; i++) out[i] = Number.parseInt(tokens[i]!, 16);
    return out;
}

// 102-byte broken hvcC from a real 70mai x800 file (NO...581F): header zeroed
// (numOfArrays=0, lengthSizeMinusOne=0, profile/level garbage), VPS/SPS/PPS
// intact in the tail. Codec metadata, not PII - see repair/hvcc.test.ts.
const BROKEN_HVCC_PAYLOAD = bytes(
    "01 02 00 00 00 00 00 44 00 00 00 00 00 00 00 00 1a 22 f7 7f a7 00 00 " +
        "20 00 01 00 18 40 01 0c 01 ff ff 01 60 00 00 03 00 00 03 00 00 03 00 00 03 00 96 ac 09 " +
        "21 00 01 00 21 42 01 01 01 60 00 00 03 00 00 03 00 00 03 00 00 03 00 96 a0 01 e0 20 02 1c 7f 89 ad 39 28 92 ec 80 " +
        "22 00 01 00 07 44 01 c0 72 f0 3b 24",
);

/** A vide trak with an hvc1 sample entry carrying the given hvcC payload. */
function hvc1Trak(hvccPayload: Uint8Array): Uint8Array {
    const hvcC = box("hvcC", hvccPayload);
    const hvc1 = box("hvc1", new Uint8Array(78), hvcC); // 78-byte VisualSampleEntry prefix
    const stsd = box("stsd", u32be(0, 1), hvc1);
    const stbl = box("stbl", stsd);
    const minf = box("minf", stbl);
    const hdlr = box("hdlr", u32be(0, 0), new Uint8Array([0x76, 0x69, 0x64, 0x65]), u32be(0, 0, 0)); // 'vide'
    const mdia = box("mdia", hdlr, minf);
    return box("trak", mdia);
}

function movWithHvc1(hvccPayload: Uint8Array): File {
    const moov = box("moov", mvhd(), hvc1Trak(hvccPayload));
    const ftyp = box("ftyp", new Uint8Array([0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0]));
    return new File([new Uint8Array([...ftyp, ...moov])], "hevc-broken.mp4");
}

// End-to-end guard for the "broken hvcC leaves a bogus videoCodecString" defect.
// The hvcC bytes are repaired in the worker (numOfArrays/profile/level rebuilt),
// but videoCodecString is parsed once BEFORE the repair. Without adopting the
// repaired string, the candidate carries hev1.2.0.L0.0.44 (Main10 / level 0) -
// which the config-aware canPlay probe rejects, blocking a file that decodes
// fine, and the details panel shows the wrong codec.
describe("indexMp4FileWithMoov: broken hvcC codec string", () => {
    it("adopts the repaired hvcC codec string, not the broken header's", async () => {
        const { indexed } = await indexMp4FileWithMoov(movWithHvc1(BROKEN_HVCC_PAYLOAD), false);
        expect(indexed).not.toBeNull();
        expect(indexed!.codec).toBe("hevc");
        expect(indexed!.videoCodecString).toBe("hev1.1.6.L150");
        expect(indexed!.videoCodecString).not.toBe("hev1.2.0.L0.0.44");
    });
});

describe("indexOneFile on a raw HEVC stream", () => {
    const name = "0123456789abcdef_00000001--0000000000--19--fcamera.hevc";
    const bytes = readFileSync(new URL(`../__fixtures__/openpilot/${name}`, import.meta.url));

    it("reads the codec from the head and reports openpilot's nominal segment", async () => {
        const { indexed } = await indexOneFile(new File([bytes], name), false);
        expect(indexed).toMatchObject({
            durationSec: 60,
            createdUtc: null,
            codec: "hevc",
            width: 320,
            height: 192,
            fps: 20,
            rotation: 0,
            audio: null,
            needsHevcRemux: false,
            audioNeedsTranscode: false,
        });
        expect(indexed!.videoCodecString).toMatch(/^hev1\.1\./);
    });

    it("reads no further than the head", async () => {
        // Larger than the 256 KiB probe limit, so a whole-file read would show.
        const file = new File([bytes, bytes], name);
        expect(file.size).toBeGreaterThan(256 * 1024);
        const slice = file.slice.bind(file);
        let furthest = 0;
        file.slice = (start, end, contentType) => {
            furthest = Math.max(furthest, end ?? file.size);
            return slice(start, end, contentType);
        };
        const { indexed } = await indexOneFile(file, false);
        expect(indexed).not.toBeNull();
        // The probe stops at the first picture, a few hundred bytes in.
        expect(furthest).toBeLessThanOrEqual(64 * 1024);
    });

    it("skips a stream without parameter sets", async () => {
        const { indexed } = await indexOneFile(new File([new Uint8Array([0, 0, 1, 0x02, 0x01, 0x80])], name), false);
        expect(indexed).toBeNull();
    });
});

// Tests for broken hvcC repair (see src/repair/hvcc.ts).
//
// Fixtures - real 102-byte HEVCDecoderConfigurationRecord payloads from two
// 70mai x800 files from the same trip, differing only in the 23-byte header:
//
//   - GOOD: NO20260429-171553-000580F.MP4. Valid header; plays natively in
//     the browser and VLC. Ground truth for synthesis.
//
//   - BROKEN: NO20260429-171653-000581F.MP4. Header zeroed-out
//     (numOfArrays=0); VPS/SPS/PPS bytes in the payload are identical to the
//     GOOD file - firmware wrote the NAL arrays but skipped the header.
//     Native <video> and WebCodecs show a black screen.
//
// These 102 bytes are codec metadata, not personal data (no coordinates,
// names, or timestamps), so committing them is fine. The original files are
// under NDA in private/ and are not committed.

import {
    BlobSource,
    BufferTarget,
    EncodedPacket,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    Mp4InputFormat,
    Mp4OutputFormat,
    Output,
} from "mediabunny";
import { describe, expect, it } from "vitest";

import { indexMp4FileWithMoov } from "../parsers/internal/mp4-indexing.js";
import { findBox, findHvccInTrak, hevcCodecStringFromHvcc } from "../parsers/internal/mp4-walker.js";
import { _testIsBrokenHeader, _testParseSps, _testRebuildHvcC, detectHvcCRepair, repairBrokenHvcC } from "./hvcc.js";

/** Parses a "01 02 03"-format hex string into a Uint8Array. */
function bytes(hex: string): Uint8Array {
    const tokens = hex.trim().split(/\s+/);
    const out = new Uint8Array(tokens.length);
    for (let i = 0; i < tokens.length; i++) {
        out[i] = Number.parseInt(tokens[i]!, 16);
    }
    return out;
}

// ====== minimal ISOBMFF box builders (for detectHvcCRepair moov tests) ======

function u32(n: number): number[] {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function fourcc(s: string): number[] {
    return [...s].map((c) => c.charCodeAt(0));
}
function box(type: string, ...parts: number[][]): number[] {
    const body = parts.flat();
    return [...u32(8 + body.length), ...fourcc(type), ...body];
}

/**
 * Wraps an hvcC payload in the minimal moov path findHvcCInDataView walks:
 * moov/trak/mdia/minf/stbl/stsd/hvc1/hvcC. The hvc1 sample entry carries the
 * mandatory 78-byte VisualSampleEntry prefix before its hvcC child.
 */
function moovWithHvcc(payload: Uint8Array): Uint8Array {
    const hvcC = box("hvcC", [...payload]);
    const hvc1 = box("hvc1", new Array(78).fill(0), hvcC);
    const stsd = box("stsd", u32(0), u32(1), hvc1); // version+flags, entry_count=1
    const moov = box("moov", box("trak", box("mdia", box("minf", box("stbl", stsd)))));
    return new Uint8Array(moov);
}

// 102-byte hvcC payload from the valid 70mai file (NO20260429-171553-000580F.MP4).
// Extracted via mediabunny.getDecoderConfig().description in scripts/inspect-hvcc.mjs.
const GOOD_HVCC_PAYLOAD = bytes(
    "01 01 60 00 00 00 00 00 00 00 00 00 96 f0 00 fc fd f8 f8 00 00 0f 03 " +
        "20 00 01 00 18 40 01 0c 01 ff ff 01 60 00 00 03 00 00 03 00 00 03 00 00 03 00 96 ac 09 " +
        "21 00 01 00 21 42 01 01 01 60 00 00 03 00 00 03 00 00 03 00 00 03 00 96 a0 01 e0 20 02 1c 7f 89 ad 39 28 92 ec 80 " +
        "22 00 01 00 07 44 01 c0 72 f0 3b 24",
);

// 102-byte hvcC payload from the broken file (NO20260429-171653-000581F.MP4).
// Header [0..23) is garbage (configurationVersion=1 survived; other fields
// are overwritten with random content); the 79-byte NAL arrays in the tail
// are identical to the GOOD file - firmware wrote VPS/SPS/PPS correctly
// but left the header description blank.
const BROKEN_HVCC_PAYLOAD = bytes(
    "01 02 00 00 00 00 00 44 00 00 00 00 00 00 00 00 1a 22 f7 7f a7 00 00 " +
        "20 00 01 00 18 40 01 0c 01 ff ff 01 60 00 00 03 00 00 03 00 00 03 00 00 03 00 96 ac 09 " +
        "21 00 01 00 21 42 01 01 01 60 00 00 03 00 00 03 00 00 03 00 00 03 00 96 a0 01 e0 20 02 1c 7f 89 ad 39 28 92 ec 80 " +
        "22 00 01 00 07 44 01 c0 72 f0 3b 24",
);

// Container tests inspect metadata and packet bytes without decoding footage.
const SYNTHETIC_PACKET = new Uint8Array([0, 0, 0, 3, 0x26, 0x01, 0x80]);

async function hevcFile(fastStart: false | "in-memory"): Promise<File> {
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart }), target });
    const source = new EncodedVideoPacketSource("hevc");
    output.addVideoTrack(source);
    await output.start();
    await source.add(new EncodedPacket(SYNTHETIC_PACKET, "key", 0, 1), {
        decoderConfig: {
            codec: "hev1.1.6.L150",
            codedWidth: 3840,
            codedHeight: 2160,
            description: new Uint8Array(GOOD_HVCC_PAYLOAD),
        },
    });
    await output.finalize();
    if (!target.buffer) throw new Error("synthetic hevc output is empty");
    return new File([target.buffer], "synthetic-hevc.mp4", {
        type: "video/mp4",
        lastModified: 1767225600000,
    });
}

async function expectReadableHevc(file: File): Promise<void> {
    const input = new Input({ source: new BlobSource(file), formats: [new Mp4InputFormat()] });
    try {
        const track = await input.getPrimaryVideoTrack();
        expect(track).not.toBeNull();
        const config = await track!.getDecoderConfig();
        expect(config?.codec).toBe("hev1.1.6.L150");
        expect(hevcCodecStringFromHvcc(GOOD_HVCC_PAYLOAD)).toBe(config!.codec);
        expect(new Uint8Array(config!.description as ArrayBuffer)).toEqual(GOOD_HVCC_PAYLOAD);
        const packet = await new EncodedPacketSink(track!).getFirstPacket();
        expect(packet?.data).toEqual(SYNTHETIC_PACKET);
    } finally {
        input.dispose();
    }
}

describe.each([
    { layout: "moov first", fastStart: "in-memory" as const },
    { layout: "moov last", fastStart: false as const },
])("repairBrokenHvcC with $layout", ({ fastStart }) => {
    it("leaves a healthy file unchanged and agrees with the demuxer's codec metadata", async () => {
        const file = await hevcFile(fastStart);
        expect(await repairBrokenHvcC(file)).toBeNull();
        await expectReadableHevc(file);
    });

    it("repairs only the broken header while preserving the file and indexed codec", async () => {
        const healthy = await hevcFile(fastStart);
        const healthyBytes = new Uint8Array(await healthy.arrayBuffer());
        const dv = new DataView(healthyBytes.buffer);
        const moov = findBox(dv, 0, dv.byteLength, "moov")!;
        const mdat = findBox(dv, 0, dv.byteLength, "mdat")!;
        expect(moov.start < mdat.start).toBe(fastStart === "in-memory");
        const trak = findBox(dv, moov.payloadStart, moov.end, "trak")!;
        const hvcc = findHvccInTrak(dv, trak)!;
        expect(healthyBytes.subarray(hvcc.payloadStart, hvcc.payloadEnd)).toEqual(GOOD_HVCC_PAYLOAD);
        const brokenBytes = healthyBytes.slice();
        brokenBytes.set(BROKEN_HVCC_PAYLOAD, hvcc.payloadStart);
        const broken = new File([brokenBytes], healthy.name, {
            type: healthy.type,
            lastModified: healthy.lastModified,
        });

        const repaired = await repairBrokenHvcC(broken);
        expect(repaired).not.toBeNull();
        expect(repaired!.description).toEqual(GOOD_HVCC_PAYLOAD);
        expect(repaired!.file.size).toBe(broken.size);
        expect(repaired!.file.name).toBe(broken.name);
        expect(repaired!.file.type).toBe(broken.type);
        expect(repaired!.file.lastModified).toBe(broken.lastModified);
        expect(new Uint8Array(await repaired!.file.arrayBuffer())).toEqual(healthyBytes);
        expect(new Uint8Array(await broken.arrayBuffer())).toEqual(brokenBytes);
        await expectReadableHevc(repaired!.file);

        const { indexed, repair } = await indexMp4FileWithMoov(broken, false);
        expect(repair).toBeDefined();
        expect(indexed?.codec).toBe("hevc");
        expect(indexed?.videoCodecString).toBe("hev1.1.6.L150");
    });
});

describe("parseSps", () => {
    it("extracts profile/level/bit_depth/chroma from valid 70mai SPS", () => {
        // In GOOD_HVCC_PAYLOAD: header (23 bytes) + VPS array (1+2+2+24=29) =
        // first 52 bytes. SPS array follows: 1 byte header (0x21) + 2 bytes
        // numNalus (0x0001) + 2 bytes nalUnitLength (0x0021=33) + 33 bytes SPS NAL.
        // SPS NAL bytes start at offset 52+5=57.
        const spsNalu = GOOD_HVCC_PAYLOAD.subarray(57, 57 + 33);
        const sps = _testParseSps(spsNalu);
        expect(sps).not.toBeNull();
        expect(sps!.profile_idc).toBe(1); // Main profile
        expect(sps!.level_idc).toBe(150); // 5.0
        expect(sps!.chromaFormat).toBe(1); // 4:2:0
        expect(sps!.bitDepthLumaMinus8).toBe(0); // 8-bit
        expect(sps!.bitDepthChromaMinus8).toBe(0); // 8-bit
        expect(sps!.profile_compatibility_flags).toBe(0x60000000);
        expect(sps!.numTemporalLayers).toBe(1);
        expect(sps!.tier_flag).toBe(0); // Main tier
    });
});

describe("isBrokenHeader", () => {
    it("detects zeroed header + valid NAL arrays (the 70mai 581 pattern)", () => {
        // Flagged regardless of the hvc1/hev1 sample-entry type: numOfArrays=0
        // with valid VPS/SPS/PPS in the tail is a broken header either way (even
        // though numOfArrays=0 is technically allowed for hev1 inband params).
        expect(_testIsBrokenHeader(BROKEN_HVCC_PAYLOAD)).toBe(true);
    });

    it("does not flag a valid hvcC", () => {
        expect(_testIsBrokenHeader(GOOD_HVCC_PAYLOAD)).toBe(false);
    });

    it("does not flag a 23-byte hvcC with no body (legitimate empty case for hev1+inband params)", () => {
        const empty = GOOD_HVCC_PAYLOAD.slice(0, 23).slice();
        empty[22] = 0; // numOfArrays = 0
        expect(_testIsBrokenHeader(empty)).toBe(false);
    });

    it("does not flag random padding after zeroed header", () => {
        // Zeroed header + 30 bytes of random noise. The NAL array parser must
        // reject it and return null - not our pattern.
        const padded = new Uint8Array(53);
        padded[0] = 1; // configurationVersion
        // bytes [23..53): random-looking but does not parse as a NAL array
        padded[23] = 0x99; // NAL_unit_type=25 (TRAIL slice) - not VPS/SPS/PPS, parser must reject
        expect(_testIsBrokenHeader(padded)).toBe(false);
    });

    it("does not flag a configurationVersion != 1 (file is broken in some other way)", () => {
        const weird = BROKEN_HVCC_PAYLOAD.slice();
        weird[0] = 7; // not 1
        expect(_testIsBrokenHeader(weird)).toBe(false);
    });

    it("rejects a payload where NAL header byte does not match array's NAL_unit_type", () => {
        // Take BROKEN but corrupt the first NAL inside the VPS array: change
        // the first byte of the VPS NAL (offset 23+5=28; 0x40 = NAL_unit_type=32)
        // to 0x26 (NAL_unit_type=19=IDR slice).
        const tampered = BROKEN_HVCC_PAYLOAD.slice();
        // Layout: [0..23) header; [23] VPS array header byte; [24..26) numNalus; [26..28) first naluLength;
        // [28..28+24) first VPS NAL unit. tampered[28] = 0x26 → NAL header type = (0x26>>1)&0x3f = 19.
        tampered[28] = 0x26;
        expect(_testIsBrokenHeader(tampered)).toBe(false);
    });
});

describe("rebuildHvcC", () => {
    it("rebuilds 581's broken hvcC byte-by-byte equal to 580's known-good hvcC", () => {
        const rebuilt = _testRebuildHvcC(BROKEN_HVCC_PAYLOAD);
        expect(rebuilt).not.toBeNull();
        expect(Array.from(rebuilt!)).toEqual(Array.from(GOOD_HVCC_PAYLOAD));
    });

    it("is idempotent on already-valid hvcC (output equals input)", () => {
        // Rebuild on the valid 580 payload should return the same bytes
        // (header is synthesized from the same SPS fields; body is untouched).
        const rebuilt = _testRebuildHvcC(GOOD_HVCC_PAYLOAD);
        expect(rebuilt).not.toBeNull();
        expect(Array.from(rebuilt!)).toEqual(Array.from(GOOD_HVCC_PAYLOAD));
    });

    it("preserves payload size (so MP4 stco/co64/stsz offsets stay valid after substitution)", () => {
        const rebuilt = _testRebuildHvcC(BROKEN_HVCC_PAYLOAD);
        expect(rebuilt!.byteLength).toBe(BROKEN_HVCC_PAYLOAD.byteLength);
    });

    it("returns null on payload too short to contain header", () => {
        const tooShort = new Uint8Array(15);
        tooShort[0] = 1;
        expect(_testRebuildHvcC(tooShort)).toBeNull();
    });

    it("returns null when payload has no SPS array (cannot synthesize header without SPS)", () => {
        // Take BROKEN but remove the SPS array (NAL_unit_type=33). Layout:
        // VPS array (header 3 + 2 length + 24 nalu = 29)
        // + SPS array (3 + 2 + 33 = 38)
        // + PPS array (3 + 2 + 7 = 12) = 79 bytes total.
        // Remove SPS from the middle, leaving VPS+PPS = 29 + 12 = 41 bytes in the tail.
        const noSps = new Uint8Array(23 + 29 + 12);
        noSps.set(BROKEN_HVCC_PAYLOAD.subarray(0, 23 + 29), 0);
        noSps.set(BROKEN_HVCC_PAYLOAD.subarray(23 + 29 + 38), 23 + 29);
        expect(_testRebuildHvcC(noSps)).toBeNull();
    });
});

describe("detectHvcCRepair (moov bytes, no file IO)", () => {
    it("locates a broken hvcC inside moov and rebuilds it to the known-good payload", () => {
        const moov = moovWithHvcc(BROKEN_HVCC_PAYLOAD);
        const repair = detectHvcCRepair(moov);
        expect(repair).not.toBeNull();
        expect(repair!.reason).toBe("header");
        // Rebuilt payload equals the GOOD file's hvcC (same tail, fixed header).
        expect(Array.from(repair!.rebuilt)).toEqual(Array.from(GOOD_HVCC_PAYLOAD));
        // The reported offset points at the hvcC payload within the moov, so
        // writing rebuilt there yields a moov whose hvcC is now valid.
        const patched = new Uint8Array(moov);
        patched.set(repair!.rebuilt, repair!.moovRelPayloadStart);
        const rePatch = detectHvcCRepair(patched);
        expect(rePatch).toBeNull(); // idempotent: the defect is gone
    });

    it("returns null for a moov whose hvcC is already valid", () => {
        const moov = moovWithHvcc(GOOD_HVCC_PAYLOAD);
        expect(detectHvcCRepair(moov)).toBeNull();
    });

    it("returns null for a moov with no hvcC at all", () => {
        const moov = new Uint8Array(box("moov", box("trak", box("mdia", box("minf", box("stbl"))))));
        expect(detectHvcCRepair(moov)).toBeNull();
    });
});

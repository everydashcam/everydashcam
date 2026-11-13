// Tests for the combined container-repair detector run inside the indexer
// worker (src/repair/moov-repair.ts). Covers the phantom-track + hvcC
// combination, the codec gate (hvcC only for HEVC), and the clean-moov fast
// path. The individual detectors are unit-tested in hvcc.test.ts /
// phantom-track.test.ts; this pins the glue: one patched moov copy carrying
// both edit sets, constant size, and the recomputed needsHevcRemux.

import { describe, expect, it } from "vitest";

import { detectHvcCRepair } from "./hvcc.js";
import { detectMoovRepairs } from "./moov-repair.js";
import { findPhantomTracks } from "./phantom-track.js";

// ====== minimal ISOBMFF box builders ======

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
function hdlr(handler: string): number[] {
    return box("hdlr", u32(0), u32(0), fourcc(handler), u32(0), u32(0), u32(0));
}

/** Audio trak whose chunk offsets are all zero (points at no data) - phantom. */
function phantomAudioTrak(): number[] {
    const n = 3;
    const stts = box("stts", u32(0), u32(1), u32(n), u32(3003));
    const stsc = box("stsc", u32(0), u32(1), u32(1), u32(1), u32(1));
    const stsz = box("stsz", u32(0), u32(0), u32(n), ...[0, 0, 0].map(u32));
    const stco = box("stco", u32(0), u32(n), ...[0, 0, 0].map(u32));
    return box("trak", box("mdia", hdlr("soun"), box("minf", box("stbl", stts, stsc, stsz, stco))));
}

/** Healthy audio trak (real offsets + sizes) - never phantom. */
function healthyAudioTrak(): number[] {
    const stts = box("stts", u32(0), u32(1), u32(2), u32(3003));
    const stsc = box("stsc", u32(0), u32(1), u32(1), u32(1), u32(1));
    const stsz = box("stsz", u32(0), u32(0), u32(2), ...[256, 256].map(u32));
    const stco = box("stco", u32(0), u32(2), ...[0x40000, 0x40400].map(u32));
    return box("trak", box("mdia", hdlr("soun"), box("minf", box("stbl", stts, stsc, stsz, stco))));
}

/** Video trak carrying an hvc1 sample entry with the given hvcC payload. */
function hvccVideoTrak(payload: Uint8Array): number[] {
    const hvcC = box("hvcC", [...payload]);
    const hvc1 = box("hvc1", new Array(78).fill(0), hvcC); // 78-byte VisualSampleEntry prefix
    const stsd = box("stsd", u32(0), u32(1), hvc1);
    return box("trak", box("mdia", hdlr("vide"), box("minf", box("stbl", stsd))));
}

/** Plain video trak with no hvcC (AVC-style placeholder). */
function plainVideoTrak(): number[] {
    return box("trak", box("mdia", hdlr("vide"), box("minf", box("stbl"))));
}

function moovOf(...traks: number[][]): Uint8Array {
    return new Uint8Array(box("moov", box("mvhd", new Array(100).fill(0)), ...traks));
}

/** Parses a "01 02"-format hex string into a Uint8Array. */
function bytes(hex: string): Uint8Array {
    const tokens = hex.trim().split(/\s+/);
    const out = new Uint8Array(tokens.length);
    for (let i = 0; i < tokens.length; i++) out[i] = Number.parseInt(tokens[i]!, 16);
    return out;
}

// 102-byte broken hvcC payload from a real 70mai x800 file (header zeroed,
// VPS/SPS/PPS intact in the tail). Codec metadata, not PII - see hvcc.test.ts.
const BROKEN_HVCC_PAYLOAD = bytes(
    "01 02 00 00 00 00 00 44 00 00 00 00 00 00 00 00 1a 22 f7 7f a7 00 00 " +
        "20 00 01 00 18 40 01 0c 01 ff ff 01 60 00 00 03 00 00 03 00 00 03 00 00 03 00 96 ac 09 " +
        "21 00 01 00 21 42 01 01 01 60 00 00 03 00 00 03 00 00 03 00 00 03 00 96 a0 01 e0 20 02 1c 7f 89 ad 39 28 92 ec 80 " +
        "22 00 01 00 07 44 01 c0 72 f0 3b 24",
);

describe("detectMoovRepairs", () => {
    it("returns null for a clean moov (healthy audio, AVC video)", () => {
        const moov = moovOf(plainVideoTrak(), healthyAudioTrak());
        expect(detectMoovRepairs(moov, "avc")).toBeNull();
    });

    it("detects a phantom audio track and produces a defect-free patched moov", () => {
        const moov = moovOf(plainVideoTrak(), phantomAudioTrak());
        const repair = detectMoovRepairs(moov, "avc");
        expect(repair).not.toBeNull();
        expect(repair!.phantomNeutralized).toEqual(["soun"]);
        expect(repair!.hvcc).toBeNull();
        // Constant-size patch keeps every file offset valid.
        expect(repair!.patchedMoov.byteLength).toBe(moov.byteLength);
        // The defect is gone from the patched copy; the original is untouched.
        expect(findPhantomTracks(repair!.patchedMoov)).toHaveLength(0);
        expect(findPhantomTracks(moov)).toHaveLength(1);
    });

    it("fixes a broken hvcC AND a phantom track in one patched moov (HEVC)", () => {
        const moov = moovOf(hvccVideoTrak(BROKEN_HVCC_PAYLOAD), phantomAudioTrak());
        const repair = detectMoovRepairs(moov, "hevc");
        expect(repair).not.toBeNull();
        expect(repair!.phantomNeutralized).toEqual(["soun"]);
        expect(repair!.hvcc).not.toBeNull();
        expect(repair!.hvcc!.reason).toBe("header");
        // A rebuilt (valid) hvcC means native playback, not MSE remux.
        expect(repair!.hvcc!.needsHevcRemux).toBe(false);
        // The codec string is re-derived from the REPAIRED hvcC. Parsing the
        // broken header instead would yield hvc1.2.0.L0.0.44 (profile Main10,
        // level 0), which the config-aware canPlay probe rejects - blocking a
        // file that actually decodes fine after the splice.
        expect(repair!.hvcc!.videoCodecString).toBe("hvc1.1.6.L150");
        expect(repair!.patchedMoov.byteLength).toBe(moov.byteLength);
        // Both defects are gone from the patched moov.
        expect(findPhantomTracks(repair!.patchedMoov)).toHaveLength(0);
        expect(detectHvcCRepair(repair!.patchedMoov)).toBeNull();
    });

    it("does NOT touch a broken hvcC when codec is not HEVC (gate)", () => {
        // Same broken hvcC bytes, but the indexer reported codec=avc - the hvcC
        // detector is gated off, and there is no phantom track, so null.
        const moov = moovOf(hvccVideoTrak(BROKEN_HVCC_PAYLOAD));
        expect(detectMoovRepairs(moov, "avc")).toBeNull();
    });
});

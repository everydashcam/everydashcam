// Tests for the HEVC helpers cleanHvccDescription and needsHevcRemux. The
// per-file MSE pipeline is verified manually in the browser per AGENTS.md; only sync utilities here.

import { describe, it, expect } from "vitest";
import { cleanHvccDescription, needsHevcRemux } from "./hevc-remux.js";

// ===== cleanHvccDescription =====
// Regression: BlackVue ELITE 9 writes HEVCDecoderConfigurationRecord with a
// 4th NAL array nal_unit_type=0 (TRAIL_N) and 128 bytes of null padding.
// VideoToolbox in Chrome throws PIPELINE_ERROR_DECODE - strip the invalid array.
// Tests verify that arrays with allowed types (32/33/34/39/40) are kept and
// others are removed.

describe("cleanHvccDescription", () => {
    /** Builds an hvcC from an array of {nalType, naluPayloads}. Header is
     * filled with minimal bytes - only the NAL array structure matters here. */
    function buildHvcc(arrays: Array<{ nalType: number; payloads: Uint8Array[] }>): Uint8Array {
        const header = new Uint8Array(22);
        let totalLen = 22 + 1;
        for (const a of arrays) {
            totalLen += 3;
            for (const p of a.payloads) totalLen += 2 + p.byteLength;
        }
        const out = new Uint8Array(totalLen);
        out.set(header, 0);
        out[22] = arrays.length;
        let q = 23;
        for (const a of arrays) {
            out[q] = a.nalType & 0x3f;
            out[q + 1] = (a.payloads.length >> 8) & 0xff;
            out[q + 2] = a.payloads.length & 0xff;
            q += 3;
            for (const p of a.payloads) {
                out[q] = (p.byteLength >> 8) & 0xff;
                out[q + 1] = p.byteLength & 0xff;
                out.set(p, q + 2);
                q += 2 + p.byteLength;
            }
        }
        return out;
    }

    it("strips invalid array (BlackVue ELITE 9 nalType=0 padding)", () => {
        const vps = new Uint8Array([0x40, 0x01, 0x0c]);
        const sps = new Uint8Array([0x42, 0x01, 0x04]);
        const pps = new Uint8Array([0x44, 0x01]);
        const padding = new Uint8Array(128);
        const input = buildHvcc([
            { nalType: 32, payloads: [vps] },
            { nalType: 33, payloads: [sps] },
            { nalType: 34, payloads: [pps] },
            { nalType: 0, payloads: [padding] },
        ]);
        const result = cleanHvccDescription(input);
        expect(result).not.toBe(input);
        const out = new Uint8Array(result as ArrayBufferView as Uint8Array);
        expect(out[22]).toBe(3);
    });

    it("returns original when all arrays valid (no allocation)", () => {
        const vps = new Uint8Array([0x40, 0x01]);
        const sps = new Uint8Array([0x42, 0x01]);
        const pps = new Uint8Array([0x44, 0x01]);
        const sei = new Uint8Array([0x4e, 0x01, 0xff]);
        const input = buildHvcc([
            { nalType: 32, payloads: [vps] },
            { nalType: 33, payloads: [sps] },
            { nalType: 34, payloads: [pps] },
            { nalType: 39, payloads: [sei] },
        ]);
        const result = cleanHvccDescription(input);
        expect(result).toBe(input);
    });

    it("undefined → undefined", () => {
        expect(cleanHvccDescription(undefined)).toBeUndefined();
    });

    it("hvcC shorter than 23 bytes - returned as-is", () => {
        const tiny = new Uint8Array(10);
        expect(cleanHvccDescription(tiny)).toBe(tiny);
    });
});

// ===== needsHevcRemux =====
// Flag indicating the file needs MSE remux before playback. Based on hvcC
// content: invalid NAL arrays (VCL types 0-31, reserved 45+) break native
// VideoToolbox. Sample entry (hev1 vs hvc1) is irrelevant - in practice only
// BlackVue ELITE 9 crashes (TRAIL_N padding in hvcC); 22 other hev1 files
// from 6 vendors play natively.

describe("needsHevcRemux", () => {
    function buildHvcc(arrays: Array<{ nalType: number; payloads: Uint8Array[] }>): Uint8Array {
        let len = 23;
        for (const a of arrays) {
            len += 3;
            for (const p of a.payloads) len += 2 + p.byteLength;
        }
        const out = new Uint8Array(len);
        out[22] = arrays.length;
        let q = 23;
        for (const a of arrays) {
            out[q] = a.nalType & 0x3f;
            out[q + 1] = (a.payloads.length >> 8) & 0xff;
            out[q + 2] = a.payloads.length & 0xff;
            q += 3;
            for (const p of a.payloads) {
                out[q] = (p.byteLength >> 8) & 0xff;
                out[q + 1] = p.byteLength & 0xff;
                out.set(p, q + 2);
                q += 2 + p.byteLength;
            }
        }
        return out;
    }
    const vps = new Uint8Array([0x40, 0x01]);
    const sps = new Uint8Array([0x42, 0x01]);
    const pps = new Uint8Array([0x44, 0x01]);
    const cleanHvcc = buildHvcc([
        { nalType: 32, payloads: [vps] },
        { nalType: 33, payloads: [sps] },
        { nalType: 34, payloads: [pps] },
    ]);

    it("avc/h264 - always false", () => {
        expect(needsHevcRemux("avc", null)).toBe(false);
        expect(needsHevcRemux("avc", new Uint8Array(50))).toBe(false);
    });

    it("vp9/av1/vp8 - always false", () => {
        expect(needsHevcRemux("vp9", null)).toBe(false);
        expect(needsHevcRemux("av1", null)).toBe(false);
        expect(needsHevcRemux("vp8", null)).toBe(false);
    });

    it("null codec - always false", () => {
        expect(needsHevcRemux(null, null)).toBe(false);
    });

    it("hevc without description - false", () => {
        expect(needsHevcRemux("hevc", null)).toBe(false);
        expect(needsHevcRemux("hevc", undefined)).toBe(false);
    });

    it("hevc + clean hvcC [VPS, SPS, PPS] - false (70mai/CARCAM/DDPAI/Vantrue)", () => {
        expect(needsHevcRemux("hevc", cleanHvcc)).toBe(false);
    });

    it("hevc + hvcC with AUD/EOS/EOB/FD - false (native ignores them)", () => {
        const dirtyButValid = buildHvcc([
            { nalType: 32, payloads: [vps] },
            { nalType: 33, payloads: [sps] },
            { nalType: 34, payloads: [pps] },
            { nalType: 35, payloads: [new Uint8Array([0x46, 0x01])] }, // AUD (access unit delimiter)
            { nalType: 38, payloads: [new Uint8Array([0x4c, 0x01])] }, // FD (filler data)
        ]);
        expect(needsHevcRemux("hevc", dirtyButValid)).toBe(false);
    });

    it("hevc + hvcC with TRAIL_N (BlackVue ELITE 9 firmware-padding) - true", () => {
        const blackvueStyle = buildHvcc([
            { nalType: 32, payloads: [vps] },
            { nalType: 33, payloads: [sps] },
            { nalType: 34, payloads: [pps] },
            { nalType: 0, payloads: [new Uint8Array(128)] }, // TRAIL_N with null payload
        ]);
        expect(needsHevcRemux("hevc", blackvueStyle)).toBe(true);
    });

    it("hevc + hvcC with reserved NAL type (45+) - true", () => {
        const dirty = buildHvcc([
            { nalType: 32, payloads: [vps] },
            { nalType: 33, payloads: [sps] },
            { nalType: 34, payloads: [pps] },
            { nalType: 50, payloads: [new Uint8Array(8)] },
        ]);
        expect(needsHevcRemux("hevc", dirty)).toBe(true);
    });
});

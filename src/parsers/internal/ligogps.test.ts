import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LIGO_FUZZ_SCALE_3, parseLigoGpsFromMp4, unfuzzLigoGps } from "./ligogps.js";
import { _internal } from "./ligogps.js";
import { WrongFormatError } from "../types.js";
import { buildMp4Index } from "./mp4-index.js";
import { expectPlausibleGpsTrack } from "../__fixtures__/helpers.js";

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/ligogps");

const { decryptLigoGps, parseLigoGpsRecord, findLigoGpsChunkOffset } = _internal;

describe("decryptLigoGps", () => {
    it("returns null for chunk shorter than 8 bytes", () => {
        expect(decryptLigoGps(new Uint8Array(4))).toBeNull();
    });

    it("returns null for num < 4", () => {
        const buf = new Uint8Array(20);
        new DataView(buf.buffer).setUint32(4, 2, true);
        expect(decryptLigoGps(buf)).toBeNull();
    });

    it("decrypts 0xc0 4-byte branch correctly (full preamble)", () => {
        // b=0xc0 + 4×0x20 → output 4 zero bytes (preamble per ExifTool regex).
        const chunk = new Uint8Array([
            0x23,
            0x23,
            0x23,
            0x23, // '####' marker (ignored by decryptor itself, just header)
            5,
            0,
            0,
            0, // num = 5 (control 0xc0 + 4 input)
            0xc0,
            0x20,
            0x20,
            0x20,
            0x20,
        ]);
        const out = decryptLigoGps(chunk);
        expect(out).not.toBeNull();
        expect(Array.from(out!)).toEqual([0x00, 0x00, 0x00, 0x00]);
    });

    it("decrypts 0xc0 branch with ASCII chars (XOR'ed with 0x20)", () => {
        // input chars XOR'ed: each in[i] ^ 0x20 = output char.
        // To get "TEST", input = ['T'^0x20, 'E'^0x20, 'S'^0x20, 'T'^0x20]
        // = [0x74, 0x65, 0x73, 0x74]
        // 'T' = 0x54, 0x54 ^ 0x20 = 0x74. So input 0x74 = 't' gives output 'T'.
        const chunk = new Uint8Array([0x23, 0x23, 0x23, 0x23, 5, 0, 0, 0, 0xc0, 0x74, 0x65, 0x73, 0x74]);
        const out = decryptLigoGps(chunk);
        expect(String.fromCharCode(...out!)).toBe("TEST");
    });

    it("decrypts 0x00 branch (1-byte identity, optional bit OR)", () => {
        // b=0x00, single in byte, out = in | 0 = in.
        const chunk = new Uint8Array([
            0x23,
            0x23,
            0x23,
            0x23,
            4,
            0,
            0,
            0, // num=4: control 0x00 + char + control 0x00 + char
            0x00,
            0x41,
            0x00,
            0x42, // 'A', 'B'
        ]);
        const out = decryptLigoGps(chunk);
        expect(String.fromCharCode(...out!)).toBe("AB");
    });

    it("returns null on invalid steering 0x20", () => {
        // 0x20 - bit pattern fails all branches per ExifTool comment.
        const chunk = new Uint8Array([0x23, 0x23, 0x23, 0x23, 2, 0, 0, 0, 0x20, 0x00]);
        expect(decryptLigoGps(chunk)).toBeNull();
    });
});

describe("parseLigoGpsRecord", () => {
    it("extracts datetime, lat, lon, speed", () => {
        const text = "@@@@2025/06/07 18:06:17 N:50.123456 E:30.654321 25.5";
        const r = parseLigoGpsRecord(text, "test.mp4");
        expect(r).not.toBeNull();
        expect(r!.lat).toBeCloseTo(50.123456, 5);
        expect(r!.lon).toBeCloseTo(30.654321, 5);
        // 25.5 knots * 0.514444 = 13.118 m/s
        expect(r!.speedMs).toBeCloseTo(25.5 * 0.514444, 3);
        expect(r!.unixSeconds).toBe(Date.UTC(2025, 5, 7, 18, 6, 17) / 1000);
        expect(r!.active).toBe(true);
        expect(r!.mp4Filename).toBe("test.mp4");
    });

    it("handles negative coords (S/W hemispheres)", () => {
        const text = "@@@@2024/12/31 23:59:59 S:34.500 W:150.250 0.0";
        const r = parseLigoGpsRecord(text, "x.mp4");
        expect(r).not.toBeNull();
        expect(r!.lat).toBeCloseTo(-34.5, 3);
        expect(r!.lon).toBeCloseTo(-150.25, 3);
    });

    it("returns null on '?' hemisphere (no fix)", () => {
        const text = "@@@@2025/01/01 00:00:00 ?:0.0 ?:0.0 0.0";
        expect(parseLigoGpsRecord(text, "x.mp4")).toBeNull();
    });

    it("returns null on malformed datetime", () => {
        const text = "@@@@bad-date 18:06:17 N:50.0 E:30.0 25.5";
        expect(parseLigoGpsRecord(text, "x.mp4")).toBeNull();
    });

    it("rejects out-of-range coords", () => {
        const text = "@@@@2025/06/07 18:06:17 N:99.0 E:200.0 25.5";
        expect(parseLigoGpsRecord(text, "x.mp4")).toBeNull();
    });

    it("reads the course right after km/h only when the dialect places it there", () => {
        const text =
            "@@@@2026/10/18 13:04:31 N:12.500000 E:34.250000 10.4 km/h 237.70 000.00 12 x:-0.07 y:-4.18 z:2.50";
        expect(parseLigoGpsRecord(text, "x.ts", { speedUnit: "kmh", courseLayout: "after-speed" })!.bearingDeg).toBe(
            237.7,
        );
        expect(parseLigoGpsRecord(text, "x.ts", { speedUnit: "kmh" })!.bearingDeg).toBe(0);
    });

    it("unfuzzes before applying hemisphere signs", () => {
        // Fuzzed from 12.5, 34.25 at scale 2: each fraction moved to the other
        // coordinate's 10-degree cell and halved.
        const text = "@@@@2026/01/02 03:04:05 S:12.125000 W:31.250000 0.0";
        const record = parseLigoGpsRecord(text, "x.ts", { fuzzScale: 2 })!;
        expect(record.lat).toBeCloseTo(-12.5, 9);
        expect(record.lon).toBeCloseTo(-34.25, 9);
    });
});

describe("unfuzzLigoGps", () => {
    it("swaps the fractions within the 10-degree cells and scales them", () => {
        const fuzzed = { lat: 40 + 9 / LIGO_FUZZ_SCALE_3, lon: 60 + 1.5 / LIGO_FUZZ_SCALE_3 };
        const plain = unfuzzLigoGps(fuzzed.lat, fuzzed.lon, LIGO_FUZZ_SCALE_3);
        expect(plain.lat).toBeCloseTo(41.5, 9);
        expect(plain.lon).toBeCloseTo(69, 9);
    });

    it("may move a coordinate into the next cell, as the firmware does", () => {
        const plain = unfuzzLigoGps(48.8, 69.5, LIGO_FUZZ_SCALE_3);
        expect(plain.lat).toBeCloseTo(40 + 9.5 * LIGO_FUZZ_SCALE_3, 9);
        expect(plain.lat).toBeGreaterThan(50);
    });
});

describe("findLigoGpsChunkOffset", () => {
    it("returns null when LIGOGPSINFO not found", () => {
        const buf = new Uint8Array(100);
        expect(findLigoGpsChunkOffset(buf)).toBeNull();
    });

    it("returns chunk offset (LIGOGPSINFO + 0x14) when '####' marker present", () => {
        const magic = new TextEncoder().encode("LIGOGPSINFO");
        const buf = new Uint8Array(50);
        buf.set(magic, 5); // LIGOGPSINFO at offset 5
        // chunk start = 5 + 0x14 = 25; need '####' there.
        buf[25] = 0x23;
        buf[26] = 0x23;
        buf[27] = 0x23;
        buf[28] = 0x23;
        // bytes 29..32 are part of u32 num (zero, but presence of #### is enough for offset)
        expect(findLigoGpsChunkOffset(buf)).toBe(25);
    });

    it("returns null when LIGOGPSINFO present but '####' marker missing", () => {
        const magic = new TextEncoder().encode("LIGOGPSINFO");
        const buf = new Uint8Array(50);
        buf.set(magic, 5);
        // chunk start at 25 has zeros - not '####'.
        expect(findLigoGpsChunkOffset(buf)).toBeNull();
    });
});

describe("parseLigoGpsFromMp4", () => {
    it("parses synthetic CARCAM-style MP4: 3 LigoGPS samples", async () => {
        const buf = readFileSync(resolve(FIXTURES_DIR, "synthetic-ligogps.mp4"));
        const file = new File([buf], "REC20250607-180616-001-A.mp4");
        const index = await buildMp4Index(file);
        const result = await parseLigoGpsFromMp4(
            { file, relativePath: "Normal/A/REC20250607-180616-001-A.mp4" },
            index,
        );
        expectPlausibleGpsTrack(result.records, { minCount: 3 });
        expect(result).toMatchSnapshot();
    });

    it("leaves an unsettled carrier unclaimed instead of emitting maybe-fuzzed coords", async () => {
        // Same bytes, one 4cc changed: the LigoGPS payload now sits in a
        // `gpmd` track (the Kingslim D4 shape) instead of `ssmd`. Upstream
        // would unfuzz or not based on a header byte that provably
        // misclassifies our real ssmd sample, and either choice produces a
        // well-formed fix tens of km off - so the track is not claimed.
        const buf = readFileSync(resolve(FIXTURES_DIR, "synthetic-ligogps.mp4"));
        const ssmdAt = buf.indexOf(Buffer.from("ssmd", "ascii"));
        expect(ssmdAt).toBeGreaterThan(0);
        buf.write("gpmd", ssmdAt, "ascii");

        const file = new File([buf], "REC20250607-180616-001-A.mp4");
        const index = await buildMp4Index(file);
        const result = await parseLigoGpsFromMp4(
            { file, relativePath: "Normal/A/REC20250607-180616-001-A.mp4" },
            index,
        );
        expect(result.records).toHaveLength(0);
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0]!.reason).toContain("unfuzz state unsettled");
        expect(result.skipped[0]!.raw).toContain("gpmd");
    });

    it("throws WrongFormatError on MP4 without LigoGPS track", async () => {
        // Minimal MP4 - ftyp + moov without a meta track.
        const buf = new Uint8Array([
            0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76,
        ]);
        const file = new File([buf], "test.mp4");
        const index = await buildMp4Index(file);
        await expect(parseLigoGpsFromMp4({ file, relativePath: "test.mp4" }, index)).rejects.toBeInstanceOf(
            WrongFormatError,
        );
    });
});

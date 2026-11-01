// Regression tests on real-anonymized LigoGPS-TS-trailer fixtures. The video
// bodies are generated from scratch (testsrc2 + sine AAC); each trailer
// retains its original structure, timestamps, speed and cadence while
// coordinate fractions are zeroed to whole degrees.
//
// Source: scripts/anonymize-ligogps-trailer-ts.mjs.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildMp4Index } from "../../internal/mp4-index.js";
import { ligoGpsTrailerTsPrimitive } from "../../primitives/ligogps-trailer-ts.js";
import { expectPlausibleGpsTrack } from "../helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "real-anonymized.TS");
const AMPERSAND_FIXTURE = resolve(HERE, "real-anonymized-ampersand.TS");
// The real camera's filename shape; the trailer clock is the camera-LOCAL
// 2026-08-13 21:11:xx and tracks the filename stamp to the second.
const NAME = "20260813211138_0000002F.ts";

describe("real-anonymized LigoGPS-TS-trailer fixture", () => {
    it("skips a damaged plaintext slot without losing the rest of the paired table", async () => {
        const bytes = readFileSync(resolve(HERE, "real-anonymized-paired.TS"));
        const slotsStart = bytes.length - 1024 - 17360 + 8772;
        bytes[slotsStart] = 0x78;
        const file = new File([Uint8Array.from(bytes)], "damaged.ts");
        const result = await ligoGpsTrailerTsPrimitive.parse({file, relativePath: file.name});
        expect(result.records).toHaveLength(59);
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0]!.line).toBe(1);
    });

    it("parses the plaintext twin before preallocated zeros and erases the enciphered route", async () => {
        const bytes = readFileSync(resolve(HERE, "real-anonymized-paired.TS"));
        const name = "20261008_095348_f.ts";
        const file = new File([Uint8Array.from(bytes)], name);
        const vf = { file, relativePath: name };
        const index = await buildMp4Index(file);
        expect(await ligoGpsTrailerTsPrimitive.marker(vf, index)).toBe(true);
        const trailer = index.tsGpsTrailer!;
        const encryptedSlots = bytes.subarray(trailer.cleanLength + 92, trailer.cleanLength + 8680 - 8);
        expect(encryptedSlots.every((byte) => byte === 0)).toBe(true);
        const coordinates = [...bytes.subarray(trailer.cleanLength).toString("latin1").matchAll(/[NSEW?]:(-?[\d.]+)/g)];
        expect(coordinates).toHaveLength(120);
        expect(coordinates.every((match) => Number.isInteger(Number(match[1])))).toBe(true);

        const result = await ligoGpsTrailerTsPrimitive.parse(vf, index);
        expect(result.skipped).toHaveLength(0);
        expect(result.records).toHaveLength(60);
        expectPlausibleGpsTrack(result.records, { minCount: 60, monotonicTime: true });
        expect(result.records[0]!.unixSeconds).toBe(Date.UTC(2026, 9, 8, 9, 53, 49) / 1000);
        expect(result.records[59]!.unixSeconds - result.records[0]!.unixSeconds).toBe(59);
        expect(Math.min(...result.records.map((record) => record.speedMs))).toBeCloseTo(6 / 3.6);
        expect(Math.max(...result.records.map((record) => record.speedMs))).toBeCloseTo(31 / 3.6);
        for (const record of result.records) {
            expect(Number.isInteger(record.lat) && Number.isInteger(record.lon)).toBe(true);
            expect(record.mp4Filename).toBe(name);
            expect(record.active).toBe(true);
        }
    });

    it.each([
        ["real-anonymized.TS", 120],
        ["real-anonymized-ampersand.TS", 120],
        ["real-anonymized-count.TS", 120],
        ["real-anonymized-empty.TS", 0],
        ["real-anonymized-empty-capacity.TS", 0],
        ["real-anonymized-zero-header.TS", 28],
    ])("keeps every trailer coordinate in %s at whole degrees", (name, count) => {
        const bytes = readFileSync(resolve(HERE, name));
        const trailerLength = bytes.readUInt32BE(bytes.length - 4);
        const text = bytes.subarray(-trailerLength).toString("latin1");
        const coordinates = [...text.matchAll(/[NSEW?]:(-?[\d.]+)/g)];
        expect(coordinates).toHaveLength(count);
        for (const coordinate of coordinates) {
            expect(Number.isInteger(Number(coordinate[1]))).toBe(true);
        }
    });

    it("marker + parse end-to-end", async () => {
        const file = new File([Uint8Array.from(readFileSync(FIXTURE))], NAME);
        const vf = { file, relativePath: `video/F/${NAME}` };
        const index = await buildMp4Index(file);

        expect(await ligoGpsTrailerTsPrimitive.marker(vf, index)).toBe(true);

        const result = await ligoGpsTrailerTsPrimitive.parse(vf, index);
        expect(result.records).toHaveLength(60);
        expect(result.skipped).toHaveLength(0);
        expectPlausibleGpsTrack(result.records, { minCount: 60, monotonicTime: true });

        const first = result.records[0]!;
        // Camera-local wall clock parsed as if UTC; estimateTzByFingerprint
        // shifts it at the trips layer (the juscar-ts convention).
        expect(first.unixSeconds).toBe(Date.UTC(2026, 7, 13, 21, 11, 39) / 1000);

        for (const r of result.records) {
            // Sentinel coords - whole-degree anchored, never the real track.
            expect(r.lat).toBeCloseTo(45, 6);
            expect(r.lon).toBeCloseTo(9, 6);
            expect(r.active).toBe(true);
            // The source clip is stationary - real speed bytes survive
            // anonymization and must read as a parked car.
            expect(r.speedMs).toBe(0);
            expect(r.mp4Filename).toBe(NAME);
        }

        // Strict 1 Hz cadence from the real trailer.
        const last = result.records[59]!;
        expect(last.unixSeconds - first.unixSeconds).toBe(59);
    });

    it("parses the slot-count header and positional course", async () => {
        const name = "20260904_202849F.ts";
        const file = new File([Uint8Array.from(readFileSync(resolve(HERE, "real-anonymized-count.TS")))], name);
        const vf = { file, relativePath: `video/F/${name}` };
        const index = await buildMp4Index(file);
        expect(await ligoGpsTrailerTsPrimitive.marker(vf, index)).toBe(true);
        const result = await ligoGpsTrailerTsPrimitive.parse(vf, index);
        expect(result.skipped).toHaveLength(0);
        expectPlausibleGpsTrack(result.records, { minCount: 60, monotonicTime: true });
        expect(result.records).toHaveLength(60);
        const first = result.records[0]!;
        expect(first.unixSeconds).toBe(Date.UTC(2026, 8, 4, 20, 29, 0) / 1000);
        expect(first.speedMs).toBeCloseTo(16 / 3.6);
        expect(first.bearingDeg).toBeCloseTo(97.85);
        expect(result.records[59]!.unixSeconds - first.unixSeconds).toBe(59);
        for (const record of result.records) {
            expect(record.lat).toBe(53);
            expect(record.lon).toBe(49);
            expect(record.active).toBe(true);
            expect(record.accelXg).toBe(0);
            expect(record.accelYg).toBe(0);
            expect(record.accelZg).toBe(0);
        }
    });

    it("parses the GKU table whose header field is zero", async () => {
        const name = "20261101_130845_F.TS";
        const file = new File([Uint8Array.from(readFileSync(resolve(HERE, "real-anonymized-zero-header.TS")))], name);
        const vf = { file, relativePath: `Video_front/${name}` };
        const index = await buildMp4Index(file);
        expect(await ligoGpsTrailerTsPrimitive.marker(vf, index)).toBe(true);
        const result = await ligoGpsTrailerTsPrimitive.parse(vf, index);
        expect(result.skipped).toHaveLength(0);
        expect(result.records).toHaveLength(14);
        expectPlausibleGpsTrack(result.records, { minCount: 14, monotonicTime: true });
        const first = result.records[0]!;
        // Unlike the other TS firmwares this clock is UTC: the CET filename
        // stamp 13:08:45 is one hour and one second later.
        expect(first.unixSeconds).toBe(Date.UTC(2026, 10, 1, 12, 8, 44) / 1000);
        expect(result.records[13]!.unixSeconds - first.unixSeconds).toBe(13);
        for (const record of result.records) {
            expect(record.lat).toBe(53);
            expect(record.lon).toBe(10);
            expect(record.bearingDeg).toBeCloseTo(154.6);
            // The stationary source clip reads 0-1 km/h.
            expect(record.speedMs).toBeLessThanOrEqual(1 / 3.6 + 1e-9);
            expect(record.mp4Filename).toBe(name);
        }
    });

    it("indexes an empty parking trailer without inventing GPS", async () => {
        const name = "20260902_174435F_PARK.ts";
        const file = new File([Uint8Array.from(readFileSync(resolve(HERE, "real-anonymized-empty.TS")))], name);
        const vf = { file, relativePath: `park/F/${name}` };
        const index = await buildMp4Index(file);
        expect(await ligoGpsTrailerTsPrimitive.marker(vf, index)).toBe(true);
        expect(await ligoGpsTrailerTsPrimitive.parse(vf, index)).toEqual({ records: [], skipped: [] });
    });

    it("parses an empty LCAI table with retained capacity without inventing GPS", async () => {
        const name = "20260904_205125F.ts";
        const file = new File(
            [Uint8Array.from(readFileSync(resolve(HERE, "real-anonymized-empty-capacity.TS")))],
            name,
        );
        const vf = { file, relativePath: `video/F/${name}` };
        const index = await buildMp4Index(file);
        expect(await ligoGpsTrailerTsPrimitive.marker(vf, index)).toBe(true);
        expect(await ligoGpsTrailerTsPrimitive.parse(vf, index)).toEqual({ records: [], skipped: [] });
    });

    it("parses the classic LIGO magic with an ampersand terminator", async () => {
        const name = "2026081822373512_f.ts";
        const file = new File([Uint8Array.from(readFileSync(AMPERSAND_FIXTURE))], name);
        const vf = { file, relativePath: `VIDEO_F/${name}` };
        const index = await buildMp4Index(file);

        expect(await ligoGpsTrailerTsPrimitive.marker(vf, index)).toBe(true);

        const result = await ligoGpsTrailerTsPrimitive.parse(vf, index);
        expect(result.records).toHaveLength(60);
        expect(result.skipped).toHaveLength(0);
        expectPlausibleGpsTrack(result.records, { minCount: 60, monotonicTime: true });

        const first = result.records[0]!;
        expect(first.unixSeconds).toBe(Date.UTC(2026, 7, 18, 22, 37, 36) / 1000);
        expect(first.speedMs).toBeCloseTo(11 / 3.6, 6);
        for (const record of result.records) {
            expect(record.lat).toBeCloseTo(49, 6);
            expect(record.lon).toBeCloseTo(24, 6);
            expect(record.active).toBe(true);
            expect(record.mp4Filename).toBe(name);
        }

        const last = result.records[59]!;
        expect(last.unixSeconds - first.unixSeconds).toBe(59);
    });
});

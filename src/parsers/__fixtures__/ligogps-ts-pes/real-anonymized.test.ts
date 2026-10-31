// Regression tests on the real-anonymized enciphered LigoGPS PES fixture. The
// PMT packet and six GPS PES are the camera's; coordinates were unfuzzed,
// truncated to whole degrees (41, 69), fuzzed back and re-enciphered, altitude
// zeroed; the video is regenerated. Timestamps, speed, course and accelerometer
// values are the camera's own.
//
// Source: scripts/anonymize-ligogps-ts-pes.mjs (records 5..10 of the sample).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildMp4Index } from "../../internal/mp4-index.js";
import { juscarTsPrimitive } from "../../primitives/juscar-ts.js";
import { ligoGpsTsPesPrimitive } from "../../primitives/ligogps-ts-pes.js";
import { ligoGpsTxtSidecar } from "../../sidecars/ligogps-txt.js";
import { expectPlausibleGpsTrack } from "../helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(resolve(HERE, "real-anonymized.TS"));
const TXT_FIXTURE = readFileSync(resolve(HERE, "../ligogps-txt/real-anonymized.TXT"));
const NAME = "2026_10_18_130426_00.TS";
// Camera-local clock, parsed as UTC (the LigoGPS convention).
const FIRST_UNIX = Date.UTC(2026, 9, 18, 13, 4, 30) / 1000;
const SPEEDS_KMH = [5.8, 10.4, 15.7, 20.3, 24.5, 28.6];
const COURSES = [237.21, 237.7, 237.5, 237.33, 237.2, 236.89];

async function indexed(bytes: Uint8Array, name = NAME) {
    const file = new File([Uint8Array.from(bytes)], name);
    const vf = { file, relativePath: `DCIM/${name}` };
    return { vf, index: await buildMp4Index(file) };
}

/** Every offset of the LIGOGPSINFO literal, i.e. one per GPS PES. */
function ligoChunkOffsets(bytes: Uint8Array): number[] {
    const magic = Buffer.from("LIGOGPSINFO");
    const offsets: number[] = [];
    for (let at = Buffer.from(bytes).indexOf(magic); at >= 0; at = Buffer.from(bytes).indexOf(magic, at + 1)) {
        offsets.push(at);
    }
    return offsets;
}

describe("real-anonymized enciphered LigoGPS PES fixture", () => {
    it("recovers the PMT and GPS after a damaged head with a false payload sync", async () => {
        const bytes = Buffer.from(FIXTURE);
        // SDT is expendable; PAT, PMT and every GPS PES remain intact.
        bytes[0] = 0;
        bytes.set([0x47, 0x41, 0, 0x10], 32);
        const { vf, index } = await indexed(bytes, "renamed.ts");
        expect(index.hasLigoGpsMarker).toBe(true);
        expect(await ligoGpsTsPesPrimitive.marker(vf, index)).toBe(true);
        const result = await ligoGpsTsPesPrimitive.parse(vf, index);
        expect(result.records.map((record) => record.unixSeconds - FIRST_UNIX)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(result.skipped).toEqual([]);
    });

    it("claims the stream and unfuzzes every record onto the anonymized whole-degree fix", async () => {
        const { vf, index } = await indexed(FIXTURE);
        expect(await ligoGpsTsPesPrimitive.marker(vf, index)).toBe(true);
        const result = await ligoGpsTsPesPrimitive.parse(vf, index);
        expect(result.skipped).toEqual([]);
        expectPlausibleGpsTrack(result.records, { minCount: 6, monotonicTime: true });
        expect(result.records).toHaveLength(6);
        for (const [i, record] of result.records.entries()) {
            expect(record.unixSeconds, `time[${i}]`).toBe(FIRST_UNIX + i);
            expect(record.lat, `lat[${i}]`).toBeCloseTo(41, 5);
            expect(record.lon, `lon[${i}]`).toBeCloseTo(69, 5);
            expect(record.speedMs, `speed[${i}]`).toBeCloseTo(SPEEDS_KMH[i]! / 3.6, 6);
            expect(record.bearingDeg, `course[${i}]`).toBeCloseTo(COURSES[i]!, 6);
            expect(record.mp4Filename).toBe(NAME);
        }
    });

    it("matches the TXT twin record for record", async () => {
        const { vf, index } = await indexed(FIXTURE);
        const pes = (await ligoGpsTsPesPrimitive.parse(vf, index)).records;
        const txtFile = new File([Uint8Array.from(TXT_FIXTURE)], "2026_10_18_130426_00.TXT");
        const txt = await ligoGpsTxtSidecar.parse({ file: txtFile, relativePath: txtFile.name }, NAME);
        const txtBySecond = new Map(txt.map((record) => [record.unixSeconds, record]));
        for (const record of pes) {
            const twin = txtBySecond.get(record.unixSeconds);
            expect(twin, `twin of ${record.unixSeconds}`).toBeDefined();
            expect(record.lat).toBeCloseTo(twin!.lat, 5);
            expect(record.lon).toBeCloseTo(twin!.lon, 5);
            expect(record.speedMs).toBe(twin!.speedMs);
            expect(record.bearingDeg).toBe(twin!.bearingDeg);
        }
    });

    it("rescales the gravity-included accelerometer to g and removes its bias", async () => {
        const { vf, index } = await indexed(FIXTURE);
        const records = (await ligoGpsTsPesPrimitive.parse(vf, index)).records;
        // Raw triples sit near |a| = 4.7 units at rest and would read as braking.
        for (const record of records) {
            expect(Math.hypot(record.accelXg, record.accelYg, record.accelZg)).toBeLessThan(0.2);
        }
        const meanZ = records.reduce((sum, record) => sum + record.accelZg, 0) / records.length;
        expect(meanZ).toBeCloseTo(0, 10);
    });

    it("keeps juscar-ts away from the enciphered-only stream", async () => {
        const { vf, index } = await indexed(FIXTURE);
        expect(index.hasLigoGpsMarker, "the literal alone would admit juscar-ts").toBe(true);
        expect(await juscarTsPrimitive.marker(vf, index)).toBe(false);
    });

    it("leaves the stream unclaimed when the PMT does not type it 0x82", async () => {
        const bytes = Buffer.from(FIXTURE);
        // ffmpeg leads with SDT and PAT; the camera PMT is packet 2 and lists
        // 0x100, 0x101, then the GPS PID entry.
        const gpsEntry = 2 * 188 + 5 + 12 + 5 + 5;
        expect(bytes[gpsEntry], "fixture layout").toBe(0x82);
        bytes[gpsEntry] = 0x06;
        const { vf, index } = await indexed(bytes);
        expect(await ligoGpsTsPesPrimitive.marker(vf, index)).toBe(false);
    });

    it("leaves a different chunk header unclaimed - 0x01 is ExifTool's not-fuzzed signature", async () => {
        const bytes = Buffer.from(FIXTURE);
        const offsets = ligoChunkOffsets(bytes);
        expect(offsets).toHaveLength(6);
        for (const at of offsets) {
            expect(bytes[at + 15], "fixture header byte").toBe(0x05);
            bytes[at + 15] = 0x01;
        }
        const { vf, index } = await indexed(bytes);
        expect(await ligoGpsTsPesPrimitive.marker(vf, index)).toBe(false);
        await expect(ligoGpsTsPesPrimitive.parse(vf, index)).rejects.toThrow("no settled ligogps pes stream");
    });

    it("skips one PES with a foreign header and keeps the rest", async () => {
        const bytes = Buffer.from(FIXTURE);
        bytes[ligoChunkOffsets(bytes)[2]! + 15] = 0x01;
        const { vf, index } = await indexed(bytes);
        const result = await ligoGpsTsPesPrimitive.parse(vf, index);
        expect(result.records.map((record) => record.unixSeconds - FIRST_UNIX)).toEqual([0, 1, 3, 4, 5]);
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0]!.reason).toBe("ligogps pes header differs from the settled dialect");
    });

    it.each([
        ["juscar plaintext PES", "../juscar/real-anonymized.TS", "20260429_182640F.ts"],
        ["LigoGPS trailer", "../ligogps-trailer-ts/real-anonymized-paired.TS", "20261008_095348_f.ts"],
    ])("does not claim the %s fixture", async (_label, path, name) => {
        const { vf, index } = await indexed(readFileSync(resolve(HERE, path)), name);
        expect(await ligoGpsTsPesPrimitive.marker(vf, index)).toBe(false);
    });
});

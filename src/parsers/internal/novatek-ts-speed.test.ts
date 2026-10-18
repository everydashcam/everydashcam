import { describe, expect, it } from "vitest";
import { KNOTS_TO_MS } from "../types.js";
import { extractNovatekTsGps } from "./novatek-ts-extract.js";

// All positions are identical: speed units must not depend on displacement.
function stream(rawSpeeds: readonly number[]): Uint8Array {
    const bytes = new Uint8Array(rawSpeeds.length * 188);
    for (const [i, raw] of rawSpeeds.entries()) {
        const off = i * 188;
        bytes.set([0x47, 0x43, 0x00, 0x10 | (i % 16), 0, 0, 1, 0xbf, 0, 44], off);
        const view = new DataView(bytes.buffer, off + 10, 44);
        const date = new Date(Date.UTC(2026, 0, 1, 12, 0, i));
        const clock = [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), 26, 1, 1];
        clock.forEach((v, j) => {
            view.setUint32(j * 4, v, true);
        });
        bytes.set([0x41, 0x4e, 0x45, 0], off + 34);
        view.setFloat32(28, 5000, true);
        view.setFloat32(32, 3000, true);
        view.setFloat32(36, raw, true);
        view.setFloat32(40, 0, true);
    }
    return bytes;
}

async function speeds(raw: readonly number[]) {
    const bytes = stream(raw);
    const file = new File([bytes as BlobPart], "renamed.ts");
    const result = await extractNovatekTsGps({ file, relativePath: file.name });
    expect(result.records).toHaveLength(raw.length);
    return result.records.map((record) => record.speedMs);
}

// Original EG-1 field values, including receiver jitter while stopped.
const DRIVING = [37.37336, 33.83604, 29.7246];
const STOPPED = [0.01852, 0.03704, 0.07408];

describe("Novatek TS speed quantization", () => {
    it.each([
        ["driving without any zero values", DRIVING],
        ["a minute at a stop", Array.from({ length: 60 }, (_, i) => STOPPED[i % 3]!)],
        ["a minute with eight moving seconds", Array.from({ length: 60 }, (_, i) => (i < 8 ? DRIVING[i % 3]! : 0))],
        ["leading and trailing zeros", [0, 0, ...DRIVING, 0]],
        [
            "float32 multiplication roundoff",
            [15.47, 30.68, 5.69].map((v) => Math.fround(Math.fround(v) * Math.fround(1.852))),
        ],
    ])("reads converted km/h for %s", async (_reason, raw) => {
        const result = await speeds(raw);
        for (const [i, value] of result.entries()) expect(value * 3.6).toBeCloseTo(Math.fround(raw[i]!), 6);
    });

    it.each([
        ["hundredths of a knot", [0.2, 0.25, 0.85, 18.89]],
        ["thousandths of a knot", [43.981, 44.245, 44.008, 44.258]],
        ["one repeated converted-grid value", Array.from({ length: 60 }, () => 37.37336)],
        ["only two distinct converted-grid values", [0.01852, 0.03704, 0.01852, 0.03704]],
        // 0.463 is an intersection of 0.01852 and 0.001; multiples cannot
        // distinguish the two encodings, even when they are all different.
        ["grid intersections", [0.463, 0.926, 4.63, 9.26]],
        ["intersections alongside too little exclusive evidence", [0.01852, 0.03704, 0.463, 0.926, 4.63]],
        ["mixed grids", [...DRIVING, 20.01]],
        ["a near match outside float32 roundoff", [...DRIVING, 0.01853]],
        ["tiny positive values near zero", [...DRIVING, 1e-8]],
        ["high magnitudes where the grids overlap at float32 precision", [1e7, 2e7, 3e7]],
    ])("keeps knots for %s", async (_reason, raw) => {
        const result = await speeds(raw);
        for (const [i, value] of result.entries()) expect(value).toBeCloseTo(Math.fround(raw[i]!) * KNOTS_TO_MS, 6);
    });

    it("keeps an all-zero recording at zero", async () => {
        expect(await speeds(Array(60).fill(0))).toEqual(Array(60).fill(0));
    });

    it("does not carry a converted-unit verdict into the next file", async () => {
        await speeds(DRIVING);
        const result = await speeds([10, 11, 12]);
        expect(result[0]).toBeCloseTo(10 * KNOTS_TO_MS, 6);
    });
});

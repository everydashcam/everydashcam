// WonVon W4K front-camera recording published by its reviewer (post #3):
// https://dashcamtalk.com/forum/threads/wonvon-w4k.43180/
// https://drive.google.com/file/d/1SigAoa3ii0oWmV6-nKUuMWocYHz-u0AP/view
// Original: 20200927182649_0000015A.MP4. The fixture retains two real moving
// XOR records, rounded coordinates and sanitized headers; video is synthetic.
// Generator: scripts/anonymize-xor-ascii-mp4.mjs with startRecord=37.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { _internal, AZDOME_XOR_VARIANT_NAME, parseFreeGpsBlock } from "../../internal/freegps.js";
import { buildMp4Index } from "../../internal/mp4-index.js";
import { freegpsPrimitive } from "../../primitives/freegps.js";

const BYTES = readFileSync(new URL("./real-wonvon-anonymized.mp4", import.meta.url));
const NAME = "20200927182649_0000015A.MP4";
const FIRST_TIME = Date.UTC(2020, 8, 27, 18, 27, 26) / 1000;
const SPEEDS_KMH = [10, 11];

function compactBlock(): Uint8Array<ArrayBuffer> {
    const offset = BYTES.indexOf("freeGPS ");
    expect(offset).toBeGreaterThan(0);
    // The freeGPS dialect uses 257 encrypted bytes. The unrelated gpmd
    // carrier's 282-byte minimum must not constrain these records.
    return Uint8Array.from(BYTES.subarray(offset, offset + 14 + 257));
}

describe("WonVon W4K real-anonymized freeGPS", () => {
    it.each([NAME, "renamed.mp4"])("extracts real xor records from %s", async (name) => {
        const file = new File([BYTES], name);
        const vf = { file, relativePath: name };
        const index = await buildMp4Index(file, { probeBytes: file.size });
        expect(await freegpsPrimitive.marker(vf, index)).toBe(true);
        const { records } = await freegpsPrimitive.parse(vf, index);
        expect(records).toHaveLength(2);
        for (const [i, record] of records.entries()) {
            expect(record.unixSeconds).toBe(FIRST_TIME + i);
            expect(record.lat).toBe(35);
            expect(record.lon).toBe(-83);
            expect(record.active).toBe(true);
            expect(record.speedMs).toBeCloseTo(SPEEDS_KMH[i]! / 3.6, 8);
            expect(record.mp4Filename).toBe(name);
            // No valid ASCII accel triple exists in the source recording.
            expect([record.accelXg, record.accelYg, record.accelZg]).toEqual([0, 0, 0]);
        }
    });

    it("claims the compact encrypted record with exactly the existing xor variant", () => {
        const bytes = compactBlock();
        const view = new DataView(bytes.buffer);
        expect(bytes).toHaveLength(271);
        const matches = _internal.FREE_GPS_VARIANTS.filter((variant) => variant.matches(view));
        expect(matches.map((variant) => variant.name)).toEqual([AZDOME_XOR_VARIANT_NAME]);
        const records = parseFreeGpsBlock(view, NAME);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ unixSeconds: FIRST_TIME, lat: 35, lon: -83 });
        expect(records[0]!.speedMs).toBeCloseTo(10 / 3.6, 8);
    });

    it("rejects a damaged xor signature and a truncated coordinate pair", () => {
        const damaged = compactBlock();
        damaged[16] = 0;
        expect(parseFreeGpsBlock(new DataView(damaged.buffer), NAME)).toEqual([]);
        const truncated = compactBlock().slice(0, 14 + 56);
        expect(parseFreeGpsBlock(new DataView(truncated.buffer), NAME)).toEqual([]);
    });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import type { Mp4Index } from "../internal/mp4-index.js";
import { buildMp4Index } from "../internal/mp4-index.js";
import type { VendorFile } from "../types.js";
import { juscarTsPrimitive } from "./juscar-ts.js";

function makeVf(name: string): VendorFile {
    return { file: new File([new Uint8Array(0)], name), relativePath: name };
}

// Minimal Mp4Index stub - hasLigoGpsMarker and empty other fields. No direct
// parse() test: that goes through extractJuscarTsGps which needs a real TS
// bytestream; the real case is covered via the real-anonymized fixture suite.
function makeIndex(hasLigoGpsMarker: boolean): Mp4Index {
    const headerBytes = new Uint8Array(2 * 188);
    headerBytes[0] = 0x47;
    headerBytes[188] = 0x47;
    headerBytes[3] = 0x10;
    headerBytes[191] = 0x10;
    return {
        headerBytes,
        headerView: new DataView(headerBytes.buffer),
        tracks: [],
        moov: null,
        moovView: null,
        topLevelFreeBox: null,
        freeGpsBoxInsideFree: null,
        novatekGpsAtom: null,
        navitelGps0Atom: null,
        navitelIditAtom: null,
        hasFreeGpsMarker: false,
        hasLigoGpsMarker,
    } as unknown as Mp4Index;
}

describe("juscarTsPrimitive.marker", () => {
    it("rejects an MP4 with LigoGPS metadata and accidental TS-like headers in its video payload", async () => {
        const bytes = readFileSync(new URL("../__fixtures__/ligogps-trailer/real-anonymized.mp4", import.meta.url));
        const file = new File([bytes], "renamed.mp4");
        const vf = { file, relativePath: file.name };
        const index = await buildMp4Index(file);
        expect(index.hasLigoGpsMarker).toBe(true);
        expect(await juscarTsPrimitive.marker(vf, index)).toBe(false);
    });

    it("recovers the actual GPS PID after a damaged head with a false payload sync", async () => {
        const original = readFileSync(new URL("../__fixtures__/juscar/real-anonymized.TS", import.meta.url));
        const referenceFile = new File([original], "renamed.ts");
        const reference = await juscarTsPrimitive.parse(
            { file: referenceFile, relativePath: referenceFile.name },
            await buildMp4Index(referenceFile),
        );
        const bytes = Buffer.from(original);
        const firstBody = bytes.indexOf("LIGOGPSINFO");
        expect(firstBody).toBeGreaterThan(0);
        const firstPacket = Math.floor(firstBody / 188) * 188;
        const originalPid = ((bytes[firstPacket + 1]! & 0x1f) << 8) | bytes[firstPacket + 2]!;
        let changedPackets = 0;
        // Renumber GPS independently of the fixture and the legacy fallback.
        for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
            if ((((bytes[offset + 1]! & 0x1f) << 8) | bytes[offset + 2]!) === originalPid) {
                bytes[offset + 1] = (bytes[offset + 1]! & 0xe0) | 0x03;
                bytes[offset + 2] = 0x21;
                changedPackets++;
            }
        }
        expect(changedPackets).toBeGreaterThan(0);
        bytes[0] = 0;
        bytes.set([0x47, 0x41, 0, 0x10], 32);
        const file = new File([bytes], referenceFile.name);
        const vf = { file, relativePath: file.name };
        const index = await buildMp4Index(file);
        expect(index.hasLigoGpsMarker).toBe(true);
        expect(await juscarTsPrimitive.marker(vf, index)).toBe(true);
        expect((await juscarTsPrimitive.parse(vf, index)).records).toEqual(reference.records);
    });

    it("positive on matching name + hasLigoGpsMarker", async () => {
        const vf = makeVf("20260429_182640F.ts");
        expect(await juscarTsPrimitive.marker(vf, makeIndex(true))).toBe(true);
    });

    it("accepts a renamed TS when the content marker is present", async () => {
        const vf = makeVf("random.ts");
        expect(await juscarTsPrimitive.marker(vf, makeIndex(true))).toBe(true);
    });

    it("negative when name matches but hasLigoGpsMarker=false", async () => {
        const vf = makeVf("20260429_182640F.ts");
        expect(await juscarTsPrimitive.marker(vf, makeIndex(false))).toBe(false);
    });

    it("rejects a non-TS carrier that merely contains the shared LigoGPS literal", async () => {
        const index = makeIndex(true);
        index.headerBytes![0] = 0;
        expect(await juscarTsPrimitive.marker(makeVf("renamed.mp4"), index)).toBe(false);
    });

    it("negative without index", async () => {
        const vf = makeVf("20260429_182640F.ts");
        expect(await juscarTsPrimitive.marker(vf, undefined)).toBe(false);
    });
});

describe("juscarTsPrimitive.cloneAcrossGroup", () => {
    it("matching key for front and rear of the same pair", () => {
        const front = juscarTsPrimitive.cloneAcrossGroup!(makeVf("20260429_182640F.ts"));
        const rear = juscarTsPrimitive.cloneAcrossGroup!(makeVf("20260429_182640R.ts"));
        expect(front).toBe("20260429_182640");
        expect(rear).toBe("20260429_182640");
        expect(front).toBe(rear);
    });

    it("different timestamps - different keys", () => {
        const a = juscarTsPrimitive.cloneAcrossGroup!(makeVf("20260429_182640F.ts"));
        const b = juscarTsPrimitive.cloneAcrossGroup!(makeVf("20260429_182645F.ts"));
        expect(a).not.toBe(b);
    });

    it("null for non-juscar name", () => {
        expect(juscarTsPrimitive.cloneAcrossGroup!(makeVf("random.ts"))).toBeNull();
    });
});

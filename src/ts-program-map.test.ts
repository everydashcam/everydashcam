import { readFileSync } from "node:fs";
import { BlobSource, Input, type Source } from "mediabunny";
import { describe, expect, it } from "vitest";

import { createBlobSource, demuxView } from "./blob-source.js";
import { createRetryingBlobSource } from "./retrying-blob-source.js";
import { pesBodyOffset } from "./parsers/internal/ts-walk.js";
import { maskDtsStreamTypes, mpeg2Crc32, readFirstProgramMap } from "./ts-program-map.js";
import { VIDEO_INPUT_FORMATS } from "./video-formats.js";

// A recording whose PMT types its LigoGPS PID 0x82 (the camera's own PMT,
// regenerated video): scripts/anonymize-ligogps-ts-pes.mjs.
const LIGO_PES_TS = readFileSync(new URL("./parsers/__fixtures__/ligogps-ts-pes/real-anonymized.TS", import.meta.url));
const PLAIN_TS = readFileSync(new URL("./parsers/__fixtures__/generic/20260511134011_073648A.TS", import.meta.url));
const NAME = "2026_10_18_130426_00.TS";
// ffmpeg leads with SDT and PAT; the camera PMT is the third packet.
const PMT_PACKET = 2 * 188;
const PMT_SECTION_START = PMT_PACKET + 5;

function sectionOf(bytes: Uint8Array): Uint8Array {
    const sectionLength = ((bytes[PMT_SECTION_START + 1]! & 0x0f) << 8) | bytes[PMT_SECTION_START + 2]!;
    return bytes.subarray(PMT_SECTION_START, PMT_SECTION_START + 3 + sectionLength);
}

describe("readFirstProgramMap", () => {
    it("lists the camera's streams including the private 0x82 and 0x80 PIDs", () => {
        expect(readFirstProgramMap(LIGO_PES_TS.subarray(0, 64 * 188))).toEqual([
            { pid: 0x100, streamType: 0x24 },
            { pid: 0x101, streamType: 0x0f },
            { pid: 0x102, streamType: 0x82 },
            { pid: 0x103, streamType: 0x80 },
        ]);
    });

    it("returns null for bytes that are not a packet stream", () => {
        expect(readFirstProgramMap(new Uint8Array(4 * 188))).toBeNull();
    });

    it("rejects an elementary-stream descriptor that extends past the PMT", () => {
        const malformed = new Uint8Array(LIGO_PES_TS);
        // The first stream follows the fixed 12-byte section header.
        malformed[PMT_SECTION_START + 12 + 4] = 0xff;
        expect(readFirstProgramMap(malformed)).toBeNull();
        expect(maskDtsStreamTypes(malformed)).toBeNull();
    });
});

describe("maskDtsStreamTypes", () => {
    it("matches the camera's CRC and keeps the section intact after the rewrite", () => {
        expect(mpeg2Crc32(sectionOf(LIGO_PES_TS)), "camera-written PMT").toBe(0);
        const patched = maskDtsStreamTypes(LIGO_PES_TS.subarray(0, 64 * 188));
        expect(patched).not.toBeNull();
        expect(patched!.length, "the copy ends with the PMT packet").toBe(PMT_PACKET + 188);
        expect(mpeg2Crc32(sectionOf(patched!)), "recomputed CRC").toBe(0);
        expect(readFirstProgramMap(patched!)).toEqual([
            { pid: 0x100, streamType: 0x24 },
            { pid: 0x101, streamType: 0x0f },
            { pid: 0x102, streamType: 0x06 },
            { pid: 0x103, streamType: 0x80 },
        ]);
    });

    it("leaves a program without DTS-typed streams alone", () => {
        expect(maskDtsStreamTypes(PLAIN_TS.subarray(0, 64 * 188))).toBeNull();
    });

    it.each([0x82, 0x8a])("preserves type 0x%s when its first PES is not LigoGPS", (streamType) => {
        const otherStream = new Uint8Array(LIGO_PES_TS);
        // The GPS entry is third, and all preceding entries have no descriptors.
        otherStream[PMT_SECTION_START + 12 + 2 * 5] = streamType;
        for (let packet = 0; packet + 188 <= otherStream.length; packet += 188) {
            const pid = ((otherStream[packet + 1]! & 0x1f) << 8) | otherStream[packet + 2]!;
            if (pid !== 0x102 || (otherStream[packet + 1]! & 0x40) === 0) continue;
            const body = pesBodyOffset(otherStream, packet)!;
            otherStream[body] = 0x7f;
            break;
        }
        expect(maskDtsStreamTypes(otherStream)).toBeNull();
    });
});

describe("demuxView", () => {
    it("passes a recording without DTS-typed streams through unchanged", async () => {
        const file = new File([PLAIN_TS], "20260511134011_073648A.TS");
        expect(await demuxView(file)).toBe(file);
    });

    it("leaves non-TS names alone even with the same bytes", async () => {
        const file = new File([LIGO_PES_TS], "clip.mp4");
        expect(await demuxView(file)).toBe(file);
    });

    it("identifies telemetry whose first PES appears after the small PMT probe", async () => {
        const padding = new Uint8Array(300 * 188).fill(0xff);
        for (let packet = 0; packet < padding.length; packet += 188) {
            padding.set([0x47, 0x1f, 0xff, 0x10], packet);
        }
        const file = new File([LIGO_PES_TS.subarray(0, 3 * 188), padding, LIGO_PES_TS.subarray(3 * 188)], NAME);
        const view = await demuxView(file);
        expect(view.size).toBe(file.size);
        expect(readFirstProgramMap(new Uint8Array(await view.slice(0, 3 * 188).arrayBuffer()))).toContainEqual({
            pid: 0x102,
            streamType: 0x06,
        });
    });
});

describe("demuxing a TS whose GPS PID is typed as DTS", () => {
    it("fails without the mask - the reason it exists", async () => {
        const input = new Input({
            source: new BlobSource(new File([LIGO_PES_TS], NAME)),
            formats: VIDEO_INPUT_FORMATS,
        });
        try {
            await expect(input.getTracks()).rejects.toThrow("Couldn't parse first media packet");
        } finally {
            input.dispose();
        }
    });

    const factories: Array<[string, (file: File) => Source | Promise<Source>]> = [
        ["blob source", createBlobSource],
        ["retrying source", createRetryingBlobSource],
    ];
    it.each(factories)("opens video and audio through the %s", async (_name, create) => {
        const input = new Input({ source: await create(new File([LIGO_PES_TS], NAME)), formats: VIDEO_INPUT_FORMATS });
        try {
            const tracks = await input.getTracks();
            expect(await Promise.all(tracks.map((track) => track.getCodec()))).toEqual(["hevc", "aac"]);
            expect(await input.computeDuration()).toBeGreaterThan(5);
        } finally {
            input.dispose();
        }
    });
});

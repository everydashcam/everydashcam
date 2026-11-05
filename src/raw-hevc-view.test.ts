import { readFileSync } from "node:fs";

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, type Source } from "mediabunny";
import { describe, expect, it } from "vitest";

import { createBlobSource, demuxView } from "./blob-source.js";
import { _testScanNalUnits, probeRawHevcHead, rawHevcMp4View } from "./raw-hevc-view.js";
import { createRetryingBlobSource } from "./retrying-blob-source.js";
import { VIDEO_INPUT_FORMATS } from "./video-formats.js";

const FIXTURE_DIR = "src/parsers/__fixtures__/openpilot/";
const PREFIX = "0123456789abcdef_00000001--0000000000--19--";
// 60 frames of 320x192 at 20 fps, a key frame every 20 (anonymize-openpilot-segment.mjs).
const fixtureBytes = (stream: string): Uint8Array => readFileSync(`${FIXTURE_DIR}${PREFIX}${stream}.hevc`);

function hevcFile(bytes: Uint8Array, name = "fcamera.hevc"): File {
    // A copy owns a plain ArrayBuffer, which BlobPart requires.
    return new File([new Uint8Array(bytes)], name);
}

async function demux(view: Blob | Source) {
    const source = view instanceof Blob ? new BlobSource(view) : view;
    const input = new Input({ source, formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("no video track");
    const packets: Array<{ timestamp: number; type: string; bytes: number }> = [];
    for await (const packet of new EncodedPacketSink(track).packets()) {
        packets.push({ timestamp: packet.timestamp, type: packet.type, bytes: packet.data.byteLength });
    }
    return {
        codec: await track.getCodec(),
        width: track.displayWidth,
        height: track.displayHeight,
        duration: await input.computeDuration(),
        packets,
    };
}

async function sampleEntryOf(view: Blob): Promise<string[]> {
    const head = new TextDecoder("latin1").decode(await view.slice(0, 4096).arrayBuffer());
    return ["hvc1", "hev1"].filter((entry) => head.includes(entry));
}

describe("raw hevc NAL scan", () => {
    // VPS, SPS, PPS, an IDR slice opening its picture, a TRAIL_R slice that
    // does not; 4-, 3- and 5-byte start codes.
    // biome-ignore format: one NAL unit per line
    const stream = new Uint8Array([
        0, 0, 0, 1, 0x40, 0x01, 0xaa,
        0, 0, 1, 0x42, 0x01, 0xbb, 0xcc,
        0, 0, 0, 0, 1, 0x44, 0x01, 0xdd,
        0, 0, 1, 0x26, 0x01, 0x80, 0xee,
        0, 0, 1, 0x02, 0x01, 0x00, 0xff,
    ]);
    const expected = {
        starts: [4, 10, 19, 25, 32],
        ends: [7, 14, 22, 29, 36],
        types: [32, 33, 34, 19, 1],
        firstSlice: [false, false, false, true, false],
    };

    it("finds every NAL with its start-code zeros excluded, at any chunk size", async () => {
        for (let chunk = 1; chunk <= stream.length + 1; chunk++) {
            expect(await _testScanNalUnits(hevcFile(stream), chunk), `chunk ${chunk}`).toEqual(expected);
        }
    });

    it("scans a real stream identically across chunk boundaries", async () => {
        const file = hevcFile(fixtureBytes("fcamera"));
        const whole = await _testScanNalUnits(file, file.size);
        for (const chunk of [4093, 65_536]) {
            expect(await _testScanNalUnits(file, chunk), `chunk ${chunk}`).toEqual(whole);
        }
        // Every byte is NAL payload or a 3- to 5-byte start code.
        const payload = whole.starts.reduce((sum, start, i) => sum + whole.ends[i]! - start, 0);
        expect(file.size - payload).toBeGreaterThanOrEqual(3 * whole.starts.length);
        expect(file.size - payload).toBeLessThanOrEqual(5 * whole.starts.length);
    });
});

describe("probeRawHevcHead", () => {
    it("describes the codec from the leading parameter sets", async () => {
        const head = await probeRawHevcHead(hevcFile(fixtureBytes("fcamera")));
        expect(head).toMatchObject({ width: 320, height: 192 });
        expect(head!.hvcc[0], "configurationVersion").toBe(1);
        expect(head!.hvcc[22], "numOfArrays").toBe(3);
    });

    it("returns null when no SPS precedes the first picture", async () => {
        const bytes = fixtureBytes("fcamera");
        const index = await _testScanNalUnits(hevcFile(bytes), bytes.length);
        expect(await probeRawHevcHead(hevcFile(bytes.subarray(index.ends[2]!)))).toBeNull();
    });
});

describe("rawHevcMp4View", () => {
    it.each(["fcamera", "ecamera", "dcamera"])("exposes every frame of %s at 20 fps", async (stream) => {
        const raw = fixtureBytes(stream);
        const view = await rawHevcMp4View(hevcFile(raw, `${stream}.hevc`), 20);
        const demuxed = await demux(view);
        expect(demuxed).toMatchObject({ codec: "hevc", width: 320, height: 192 });
        expect(demuxed.duration).toBeCloseTo(3, 6);
        expect(demuxed.packets).toHaveLength(60);
        demuxed.packets.forEach((packet, i) => {
            expect(packet.timestamp, `frame ${i}`).toBeCloseTo(i / 20, 6);
            expect(packet.type, `frame ${i}`).toBe(i % 20 === 0 ? "key" : "delta");
        });
        expect(await sampleEntryOf(view)).toEqual(["hvc1"]);
        // The view references the stream instead of copying a re-encoded one:
        // only the moov and length prefixes are new.
        expect(view.size - raw.length).toBeLessThan(4096);
    });

    it("switches to hev1 when parameter sets repeat inside the stream", async () => {
        const raw = fixtureBytes("fcamera");
        const twice = new Uint8Array(raw.length * 2);
        twice.set(raw, 0);
        twice.set(raw, raw.length);
        const view = await rawHevcMp4View(hevcFile(twice), 20);
        expect(await sampleEntryOf(view)).toEqual(["hev1"]);
        // In-band copies make the hvcC arrays incomplete (array_completeness = 0).
        const head = new Uint8Array(await view.slice(0, 4096).arrayBuffer());
        const hvcc = new TextDecoder("latin1").decode(head).indexOf("hvcC") + 4;
        const arrayCount = head[hvcc + 22]!;
        expect(arrayCount).toBe(3);
        expect(head[hvcc + 23]! & 0x80).toBe(0);
        const demuxed = await demux(view);
        expect(demuxed.packets).toHaveLength(120);
        expect(demuxed.packets.filter((packet) => packet.type === "key")).toHaveLength(6);
        // The repeated parameter sets travel with the first picture after them.
        expect(demuxed.packets[60]!.bytes).toBeGreaterThan(demuxed.packets[0]!.bytes);
    });

    it("returns the cached view for the same file, rate and extent", async () => {
        const file = hevcFile(fixtureBytes("fcamera"));
        const first = rawHevcMp4View(file, 20, { firstPictureOnly: true });
        expect(rawHevcMp4View(file, 20, { firstPictureOnly: true })).toBe(first);
        const full = rawHevcMp4View(file, 20);
        expect(full).not.toBe(first);
        expect(rawHevcMp4View(file, 20)).toBe(full);
        // A full view serves a later first-picture request; another rate is another view.
        expect(rawHevcMp4View(hevcFile(fixtureBytes("fcamera")), 20)).not.toBe(full);
        const fresh = hevcFile(fixtureBytes("fcamera"));
        const freshFull = rawHevcMp4View(fresh, 20);
        expect(rawHevcMp4View(fresh, 20, { firstPictureOnly: true })).toBe(freshFull);
        expect(rawHevcMp4View(fresh, 10)).not.toBe(freshFull);
        expect((await demux(await rawHevcMp4View(fresh, 10))).duration).toBeCloseTo(6, 6);
    });

    it("keeps a picture whose slices a prefix SEI separates in one sample", async () => {
        const raw = fixtureBytes("fcamera");
        const index = await _testScanNalUnits(hevcFile(raw), raw.length);
        const secondSlice = index.types.findIndex((type, nal) => type < 32 && !index.firstSlice[nal]);
        expect(secondSlice, "fixture has multi-slice pictures").toBeGreaterThan(0);
        const at = index.ends[secondSlice - 1]!;
        const sei = new Uint8Array([0, 0, 1, 0x4e, 0x01, 0x80]);
        const withSei = new Uint8Array(raw.length + sei.length);
        withSei.set(raw.subarray(0, at), 0);
        withSei.set(sei, at);
        withSei.set(raw.subarray(at), at + sei.length);
        const original = await demux(await rawHevcMp4View(hevcFile(raw), 20));
        const demuxed = await demux(await rawHevcMp4View(hevcFile(withSei), 20));
        expect(demuxed.packets).toHaveLength(60);
        expect(demuxed.packets[0]).toMatchObject({ type: "key", bytes: original.packets[0]!.bytes + 4 + 3 });
        expect(demuxed.packets[1]).toEqual(original.packets[1]);
    });

    it("leaves trailing zero bytes out of the last sample", async () => {
        const raw = fixtureBytes("fcamera");
        const padded = new Uint8Array(raw.length + 4096);
        padded.set(raw, 0);
        const original = await demux(await rawHevcMp4View(hevcFile(raw), 20));
        const demuxed = await demux(await rawHevcMp4View(hevcFile(padded), 20));
        expect(demuxed.packets).toEqual(original.packets);
    });

    it("builds a first-picture view from the head of the stream", async () => {
        const raw = fixtureBytes("fcamera");
        const twice = new Uint8Array(raw.length * 2);
        twice.set(raw, 0);
        twice.set(raw, raw.length);
        const file = hevcFile(twice);
        let furthest = 0;
        const view = await rawHevcMp4View(file, 20, {
            firstPictureOnly: true,
            readRange: async (start, end) => {
                furthest = Math.max(furthest, end);
                return new Uint8Array(await file.slice(start, end).arrayBuffer());
            },
        });
        expect(furthest).toBeLessThan(file.size);
        const demuxed = await demux(view);
        expect(demuxed.packets).toHaveLength(1);
        expect(demuxed.packets[0]!.type).toBe("key");
        expect(await sampleEntryOf(view)).toEqual(["hvc1"]);
    });

    it("reads through the given reader and stops when its signal aborts", async () => {
        const file = hevcFile(fixtureBytes("fcamera"));
        const controller = new AbortController();
        const reads: Array<[number, number]> = [];
        const view = rawHevcMp4View(file, 20, {
            signal: controller.signal,
            readRange: async (start, end) => {
                reads.push([start, end]);
                controller.abort();
                return new Uint8Array(await file.slice(start, end).arrayBuffer());
            },
        });
        await expect(view).rejects.toMatchObject({ name: "AbortError" });
        expect(reads).toEqual([[0, file.size]]);
        // The aborted build is not cached.
        expect((await demux(await rawHevcMp4View(file, 20))).packets).toHaveLength(60);
    });

    it("rejects a stream without a usable head or without pictures, and retries later", async () => {
        const bytes = fixtureBytes("fcamera");
        const index = await _testScanNalUnits(hevcFile(bytes), bytes.length);
        const headless = hevcFile(bytes.subarray(index.ends[2]!));
        const first = rawHevcMp4View(headless, 20);
        await expect(first).rejects.toThrow("no sequence parameter set");
        const second = rawHevcMp4View(headless, 20);
        expect(second).not.toBe(first);
        await expect(second).rejects.toThrow("no sequence parameter set");

        const parameterSetsOnly = hevcFile(bytes.subarray(0, index.ends[2]!));
        await expect(rawHevcMp4View(parameterSetsOnly, 20)).rejects.toThrow("no pictures");
        await expect(rawHevcMp4View(hevcFile(bytes), 29.97)).rejects.toThrow("frame rate");
    });
});

describe("demux entry points", () => {
    it.each([
        ["blob source", createBlobSource],
        ["retrying source", createRetryingBlobSource],
    ] as const)("opens a raw .hevc file through the %s", async (_name, create) => {
        const file = hevcFile(fixtureBytes("fcamera"), `${PREFIX}fcamera.hevc`);
        const source = await create(file);
        const input = new Input({ source, formats: VIDEO_INPUT_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        expect(await track!.getCodec()).toBe("hevc");
        expect(await input.computeDuration()).toBeCloseTo(3, 6);
    });

    it("presents only named .hevc files as an MP4", async () => {
        const raw = fixtureBytes("fcamera");
        const named = await demuxView(hevcFile(raw, "FCAMERA.HEVC"));
        expect(new TextDecoder().decode(await named.slice(4, 8).arrayBuffer())).toBe("ftyp");
        const nameless = new Blob([new Uint8Array(raw)]);
        expect(await demuxView(nameless)).toBe(nameless);
    });
});

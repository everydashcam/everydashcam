import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { Mp4Index } from "../internal/mp4-index.js";
import { buildMp4Index } from "../internal/mp4-index.js";
import { KNOTS_TO_MS, WrongFormatError, type VendorFile } from "../types.js";
import { novatekTsPrimitive } from "./novatek-ts.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/novatek-ts");
const OTHER_FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../__fixtures__");

// Canonical filename shape of the format family (camera-local time + sequence).
const CANONICAL_NAME = "20210318153933_000188.TS";

function loadVf(path: string, name: string): VendorFile {
    const buf = readFileSync(path);
    return { file: new File([buf], name), relativePath: name };
}

// Minimal Mp4Index stub: the primitive only reads headerBytes. probeMarkers
// populates them for TS files in production (see mp4-index.ts).
function makeIndex(headerBytes: Uint8Array | null): Mp4Index {
    return { headerBytes } as unknown as Mp4Index;
}

function fixtureBytes(name: string): Uint8Array {
    return new Uint8Array(readFileSync(resolve(FIXTURES, name)));
}

describe("novatekTsPrimitive.marker", () => {
    it("positive via content probe even on a renamed file", async () => {
        const bytes = fixtureBytes("synthetic-happy.TS");
        const vf = loadVf(resolve(FIXTURES, "synthetic-happy.TS"), "renamed-copy.bin");
        expect(await novatekTsPrimitive.marker(vf, makeIndex(bytes))).toBe(true);
    });

    it("filename fallback: canonical name + TS sync but no record in headerBytes", async () => {
        // wrong-format carries a text PES, so the content probe misses - the
        // fallback must still let parse() decide.
        const bytes = fixtureBytes("synthetic-wrong-format.TS");
        const vf = loadVf(resolve(FIXTURES, "synthetic-wrong-format.TS"), CANONICAL_NAME);
        expect(await novatekTsPrimitive.marker(vf, makeIndex(bytes))).toBe(true);
    });

    it("negative: canonical name but not an MPEG-TS stream", async () => {
        const junk = new Uint8Array(1024); // zeros - no 0x47 sync
        const vf: VendorFile = { file: new File([junk], CANONICAL_NAME), relativePath: CANONICAL_NAME };
        expect(await novatekTsPrimitive.marker(vf, makeIndex(junk))).toBe(false);
    });

    it("negative: non-matching name and no record signature", async () => {
        const bytes = fixtureBytes("synthetic-wrong-format.TS");
        const vf = loadVf(resolve(FIXTURES, "synthetic-wrong-format.TS"), "random.ts");
        expect(await novatekTsPrimitive.marker(vf, makeIndex(bytes))).toBe(false);
    });

    it("must not claim the Juscar LigoGPS TS fixture", async () => {
        const path = resolve(OTHER_FIXTURES, "juscar/real-anonymized.TS");
        const bytes = new Uint8Array(readFileSync(path));
        const vf = loadVf(path, "20260429_182640F.ts");
        expect(await novatekTsPrimitive.marker(vf, makeIndex(bytes))).toBe(false);
    });

    it("must not claim the generic HEVC+AAC TS fixture", async () => {
        const path = resolve(OTHER_FIXTURES, "generic/20260511134011_073648A.TS");
        const bytes = new Uint8Array(readFileSync(path));
        const vf = loadVf(path, "20260511134011_073648A.TS");
        expect(await novatekTsPrimitive.marker(vf, makeIndex(bytes))).toBe(false);
    });

    it("without an index: canonical name falls back to a head read of the file", async () => {
        const tsVf = loadVf(resolve(FIXTURES, "synthetic-wrong-format.TS"), CANONICAL_NAME);
        expect(await novatekTsPrimitive.marker(tsVf, undefined)).toBe(true);
        const junkVf: VendorFile = {
            file: new File([new Uint8Array(1024)], CANONICAL_NAME),
            relativePath: CANONICAL_NAME,
        };
        expect(await novatekTsPrimitive.marker(junkVf, undefined)).toBe(false);
    });

    it("confirms the bounded filename fallback after a damaged first packet", async () => {
        const bytes = fixtureBytes("synthetic-wrong-format.TS");
        bytes[0] = 0;
        const vf: VendorFile = {
            file: new File([bytes as BlobPart], CANONICAL_NAME),
            relativePath: CANONICAL_NAME,
        };
        expect(await novatekTsPrimitive.marker(vf, undefined)).toBe(true);
    });
});

describe("novatekTsPrimitive.parse", () => {
    it.each([2, 13])(
        "recovers detection and GPS after a false payload sync in video packet %i",
        async (packetIndex) => {
            const bytes = fixtureBytes("synthetic-happy.TS");
            const offset = packetIndex * 188;
            expect(((bytes[offset + 1]! & 0x1f) << 8) | bytes[offset + 2]!).toBe(0x200);
            bytes[offset] = 0;
            bytes.set([0x47, 0x42, 0x00, 0x10], offset + 32);
            const vf: VendorFile = { file: new File([bytes as BlobPart], "renamed.ts"), relativePath: "renamed.ts" };
            const index = await buildMp4Index(vf.file);
            expect(await novatekTsPrimitive.marker(vf, index)).toBe(true);
            const result = await novatekTsPrimitive.parse(vf, index);
            expect(result.records.map((record) => record.relStartSeconds)).toEqual([0, 1, 2, 3, 4, 5]);
            expect(result.skipped).toHaveLength(0);
        },
    );

    it.each([1, 188])("keeps every GPS record after %i damaged bytes in a video packet", async (damagedBytes) => {
        const bytes = fixtureBytes("synthetic-happy.TS");
        // The first video packet after the first GPS PES; no GPS bytes change.
        const offset = 11 * 188;
        expect(((bytes[offset + 1]! & 0x1f) << 8) | bytes[offset + 2]!).toBe(0x200);
        bytes.fill(0, offset, offset + damagedBytes);
        const vf: VendorFile = {
            file: new File([bytes as BlobPart], CANONICAL_NAME),
            relativePath: CANONICAL_NAME,
        };
        const result = await novatekTsPrimitive.parse(vf, makeIndex(bytes));
        expect(result.records.map((record) => record.relStartSeconds)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(result.skipped).toHaveLength(0);
    });

    it("happy path: 6 records, local-clock quarantine, knots conversion", async () => {
        const vf = loadVf(resolve(FIXTURES, "synthetic-happy.TS"), CANONICAL_NAME);
        const result = await novatekTsPrimitive.parse(vf, makeIndex(fixtureBytes("synthetic-happy.TS")));
        expect(result.records).toHaveLength(6);
        expect(result.skipped).toHaveLength(0);

        const first = result.records[0]!;
        // Struct time is the camera-LOCAL wall clock parsed as if UTC...
        expect(first.unixSeconds).toBe(Date.UTC(2021, 2, 18, 15, 39, 34) / 1000);
        // ...therefore quarantined for the time layer.
        expect(first.timeUnsynced).toBe(true);
        expect(first.relStartSeconds).toBe(0);
        expect(first.lat).toBeCloseTo(50.0, 4);
        expect(first.lon).toBeCloseTo(30.0, 4);
        expect(first.speedMs).toBeCloseTo(10 * KNOTS_TO_MS, 5);
        expect(first.bearingDeg).toBeCloseTo(70, 3);
        expect(first.active).toBe(true);
        expect(first.mp4Filename).toBe(CANONICAL_NAME);
        // No accelerometer in this format.
        expect(first.accelXg).toBe(0);

        for (let i = 0; i < 6; i++) {
            const r = result.records[i]!;
            expect(r.timeUnsynced).toBe(true);
            expect(r.relStartSeconds).toBe(i); // 1 Hz cadence
            expect(r.lat).toBeCloseTo(50 + i * 0.0001, 4);
            expect(r.lon).toBeCloseTo(30 + i * 0.0001, 4);
        }
        // Monotonic local time.
        for (let i = 1; i < 6; i++) {
            expect(result.records[i]!.unixSeconds).toBeGreaterThan(result.records[i - 1]!.unixSeconds);
        }
    });

    it("edge: bad records land in skipped, valid ones survive", async () => {
        const vf = loadVf(resolve(FIXTURES, "synthetic-edge.TS"), CANONICAL_NAME);
        const result = await novatekTsPrimitive.parse(vf, makeIndex(fixtureBytes("synthetic-edge.TS")));
        // valid / 'V' no-fix / month=13 / NaN lat / out-of-range lat / valid.
        expect(result.records).toHaveLength(2);
        expect(result.skipped).toHaveLength(4);
        const reasons = result.skipped.map((s) => s.reason);
        expect(reasons).toContain("no gps fix (status V)");
        // month=13 fails the signature gate, not the decode.
        expect(reasons).toContain("novatek-ts signature mismatch on gps pid");
        expect(reasons).toContain("non-finite float field");
        expect(reasons).toContain("coordinate out of range");
        // relStartSeconds stays anchored to the first VALID record.
        expect(result.records[0]!.relStartSeconds).toBe(0);
        expect(result.records[1]!.relStartSeconds).toBe(5);
    });

    it("wrong format (text PES on the GPS PID): WrongFormatError", async () => {
        const vf = loadVf(resolve(FIXTURES, "synthetic-wrong-format.TS"), CANONICAL_NAME);
        await expect(
            novatekTsPrimitive.parse(vf, makeIndex(fixtureBytes("synthetic-wrong-format.TS"))),
        ).rejects.toThrow(WrongFormatError);
    });

    it("Juscar TS content: WrongFormatError, never records", async () => {
        const path = resolve(OTHER_FIXTURES, "juscar/real-anonymized.TS");
        const vf = loadVf(path, CANONICAL_NAME);
        await expect(novatekTsPrimitive.parse(vf, undefined)).rejects.toThrow(WrongFormatError);
    });

    it("generic HEVC+AAC TS content: WrongFormatError, never records", async () => {
        const path = resolve(OTHER_FIXTURES, "generic/20260511134011_073648A.TS");
        const vf = loadVf(path, CANONICAL_NAME);
        await expect(novatekTsPrimitive.parse(vf, undefined)).rejects.toThrow(WrongFormatError);
    });

    it("record straddling the 4 MB chunk boundary still parses", async () => {
        // 22310 null packets end at 4194280; the GPS PUSI packet then spans
        // the 4 MB boundary (4194304) and must survive the tail carry-over.
        const NULL_COUNT = 22310;
        const parts: Uint8Array[] = [];
        const nullPkt = new Uint8Array(188).fill(0xff);
        nullPkt[0] = 0x47;
        nullPkt[1] = 0x1f;
        nullPkt[2] = 0xff;
        nullPkt[3] = 0x10;
        for (let i = 0; i < NULL_COUNT; i++) parts.push(nullPkt);
        // Reuse the committed happy fixture's GPS packets: PAT+PMT (2 pkts) +
        // 3 video pkts precede the first GPS PES (6 pkts) in build order.
        const happy = fixtureBytes("synthetic-happy.TS");
        const firstGpsPes = happy.subarray(5 * 188, 11 * 188);
        parts.push(firstGpsPes);
        const blob = new Blob(parts as BlobPart[]);
        const vf: VendorFile = { file: new File([blob], CANONICAL_NAME), relativePath: CANONICAL_NAME };
        const result = await novatekTsPrimitive.parse(vf, undefined);
        expect(result.records).toHaveLength(1);
        expect(result.records[0]!.lat).toBeCloseTo(50.0, 4);
    });

    it("aborts a stream that never locks a gps pid after the bounded prefix", async () => {
        // 65 MiB of null packets followed by a REAL GPS PES: the pid-lock
        // early-out must throw before the scan ever reaches the record,
        // instead of walking a gate-passing foreign TS to EOF.
        const PKT = 188;
        const nullPkt = new Uint8Array(PKT).fill(0xff);
        nullPkt[0] = 0x47;
        nullPkt[1] = 0x1f;
        nullPkt[2] = 0xff;
        nullPkt[3] = 0x10;
        const PKTS_PER_MIB = Math.ceil((1024 * 1024) / PKT); // 5578
        const mib = new Uint8Array(PKTS_PER_MIB * PKT);
        for (let i = 0; i < PKTS_PER_MIB; i++) mib.set(nullPkt, i * PKT);
        const parts: BlobPart[] = [];
        for (let i = 0; i < 65; i++) parts.push(mib);
        const happy = fixtureBytes("synthetic-happy.TS");
        parts.push(happy.slice(5 * PKT, 11 * PKT)); // first GPS PES of the happy fixture
        const vf: VendorFile = { file: new File(parts, CANONICAL_NAME), relativePath: CANONICAL_NAME };
        await expect(novatekTsPrimitive.parse(vf, makeIndex(null))).rejects.toThrow(WrongFormatError);
    });

    it("honors an already-aborted signal", async () => {
        const vf = loadVf(resolve(FIXTURES, "synthetic-happy.TS"), CANONICAL_NAME);
        const controller = new AbortController();
        controller.abort();
        await expect(novatekTsPrimitive.parse(vf, undefined, controller.signal)).rejects.toMatchObject({
            name: "AbortError",
        });
    });
});

// Smoke tests for primitive.marker() detection logic across all
// sync-marker primitives (those that decide solely from Mp4Index flags).
//
// Each marker is small; the heavy parsing logic is covered by the
// internal/*-extract tests and by the real-anonymized fixture suite. The goal
// here is just to pin the marker decision so a future Mp4Index field rename
// or accidental flag flip is caught immediately, without going through a
// full pipeline test.
//
// Primitives with async, file-probing markers (pndm, nmea-subtitle) are not
// covered here - they need a real bytestream; their detection logic lives in
// internal/pndm-extract.ts / sbtl-nmea-extract.ts and is tested there.

import { describe, expect, it } from "vitest";

import type { Mp4Index } from "../internal/mp4-index.js";
import type { VendorFile } from "../types.js";
import { freeGpsBoxPrimitive } from "./free-gps-box.js";
import { freegps70maiPrimitive } from "./freegps-70mai.js";
import { freegpsPrimitive } from "./freegps.js";
import { gpmfPrimitive } from "./gpmf.js";
import { gpsBox70maiPrimitive } from "./gps-box-70mai.js";
import { kenwoodPrimitive } from "./kenwood.js";
import { ligoJsonPrimitive } from "./ligo-json.js";
import { ligoGpsPrimitive } from "./ligogps.js";
import { navitelTailPrimitive } from "./navitel-tail.js";
import { rvmiPrimitive } from "./rvmi.js";

function vf(name = "any.mp4"): VendorFile {
    return { file: new File([new Uint8Array(0)], name), relativePath: name };
}

// Minimal Mp4Index stub with all fields the sync markers read. Overrides
// merge on top so each test specifies just the relevant flag.
function makeIndex(overrides: Partial<Mp4Index> = {}): Mp4Index {
    return {
        headerBytes: null,
        headerView: null,
        fileSize: 0,
        durationSec: null,
        createdUtc: null,
        tracks: [],
        moov: null,
        moovView: null,
        topLevelFreeBox: null,
        freeBoxView: null,
        freeGpsBoxInsideFree: null,
        novatekGpsAtom: null,
        navitelGps0Atom: null,
        navitelIditAtom: null,
        maiGpsBox: null,
        topLevelUdtaAtoms: [],
        lastTopLevelBoxEnd: null,
        kodakVersion: null,
        hasFreeGpsMarker: false,
        hasLigoGpsMarker: false,
        freeGpsSeedOffsets: [],
        firstSampleCache: new Map(),
        sliceCost: 0,
        ...overrides,
    } as unknown as Mp4Index;
}

describe("rvmiPrimitive.marker", () => {
    it("fires when a track has sampleFormat='RVMI'", async () => {
        const index = makeIndex({ tracks: [{ sampleFormat: "RVMI" } as unknown as Mp4Index["tracks"][0]] });
        expect(await rvmiPrimitive.marker(vf(), index)).toBe(true);
    });

    it("does not fire on empty tracks", async () => {
        expect(await rvmiPrimitive.marker(vf(), makeIndex())).toBe(false);
    });

    it("does not fire without index", async () => {
        expect(await rvmiPrimitive.marker(vf(), undefined)).toBe(false);
    });
});

describe("freeGpsBoxPrimitive.marker", () => {
    it("fires when freeGpsBoxInsideFree is non-null", async () => {
        const index = makeIndex({
            freeGpsBoxInsideFree: {} as unknown as NonNullable<Mp4Index["freeGpsBoxInsideFree"]>,
        });
        expect(await freeGpsBoxPrimitive.marker(vf(), index)).toBe(true);
    });

    it("does not fire when null", async () => {
        expect(await freeGpsBoxPrimitive.marker(vf(), makeIndex())).toBe(false);
    });
});

describe("ligoGpsPrimitive.marker", () => {
    it("fires on hasLigoGpsMarker=true", async () => {
        expect(await ligoGpsPrimitive.marker(vf(), makeIndex({ hasLigoGpsMarker: true }))).toBe(true);
    });

    it("does not fire on hasLigoGpsMarker=false", async () => {
        expect(await ligoGpsPrimitive.marker(vf(), makeIndex({ hasLigoGpsMarker: false }))).toBe(false);
    });
});

describe("navitelTailPrimitive.marker", () => {
    // The IDIT-less branch reads gps0 content (a ~264 B probe of the leading
    // records' date bytes), so these tests use byte-backed File stubs: the
    // gps0 atom bytes sit at offset 0 of the stub file and the index points
    // at them.
    //
    // 32-byte gps0 records; only the date bytes (22 = year-2000, 23 = month)
    // matter for the probe. Layout: internal/navitel-gps0.ts (verified against
    // ExifTool QuickTimeStream.pl Process_gps0).
    function gps0AtomBytes(records: Array<{ year: number; month: number }>): Uint8Array<ArrayBuffer> {
        const bytes = new Uint8Array(8 + records.length * 32);
        const dv = new DataView(bytes.buffer);
        dv.setUint32(0, bytes.byteLength, false);
        bytes.set([0x67, 0x70, 0x73, 0x30], 4); // 'gps0'
        for (let i = 0; i < records.length; i++) {
            bytes[8 + i * 32 + 22] = records[i]!.year;
            bytes[8 + i * 32 + 23] = records[i]!.month;
        }
        return bytes;
    }

    function gps0File(bytes: Uint8Array<ArrayBuffer>): { vendorFile: VendorFile; index: Mp4Index } {
        const file = new File([bytes], "navi.MOV");
        return {
            vendorFile: { file, relativePath: "navi.MOV" },
            index: makeIndex({ navitelGps0Atom: { offset: 0, size: bytes.byteLength }, navitelIditAtom: null }),
        };
    }

    it("fires when BOTH gps0 and IDIT atoms are present (no content read)", async () => {
        const index = makeIndex({
            navitelGps0Atom: {} as unknown as NonNullable<Mp4Index["navitelGps0Atom"]>,
            navitelIditAtom: {} as unknown as NonNullable<Mp4Index["navitelIditAtom"]>,
        });
        expect(await navitelTailPrimitive.marker(vf(), index)).toBe(true);
    });

    it("fires on gps0 without IDIT when records self-describe their date", async () => {
        const { vendorFile, index } = gps0File(gps0AtomBytes([{ year: 23, month: 4 }]));
        expect(await navitelTailPrimitive.marker(vendorFile, index)).toBe(true);
    });

    it("fires on gps0 without IDIT when only a later probe record is dated (cold-start prefix)", async () => {
        // First records zero-filled (no fix yet) - a record-0-only probe would
        // wrongly reject this file.
        const { vendorFile, index } = gps0File(
            gps0AtomBytes([
                { year: 0, month: 0 },
                { year: 0, month: 0 },
                { year: 0, month: 0 },
                { year: 23, month: 4 },
            ]),
        );
        expect(await navitelTailPrimitive.marker(vendorFile, index)).toBe(true);
    });

    it("does not fire on gps0 without IDIT when all probed date bytes are zero-filled", async () => {
        const blank = Array.from({ length: 9 }, () => ({ year: 0, month: 0 }));
        const { vendorFile, index } = gps0File(gps0AtomBytes(blank));
        expect(await navitelTailPrimitive.marker(vendorFile, index)).toBe(false);
    });

    it("does not fire on gps0 without IDIT when date bytes are implausible", async () => {
        // month 13 / year byte 200 - outside the plausible ranges.
        const { vendorFile, index } = gps0File(gps0AtomBytes([{ year: 200, month: 13 }]));
        expect(await navitelTailPrimitive.marker(vendorFile, index)).toBe(false);
    });

    it("does not fire when only IDIT is present (gps0 missing)", async () => {
        const index = makeIndex({
            navitelGps0Atom: null,
            navitelIditAtom: {} as unknown as NonNullable<Mp4Index["navitelIditAtom"]>,
        });
        expect(await navitelTailPrimitive.marker(vf(), index)).toBe(false);
    });

    it("does not fire without index", async () => {
        expect(await navitelTailPrimitive.marker(vf(), undefined)).toBe(false);
    });
});

describe("gps-box-70mai marker", () => {
    it("fires when the top-level GPS box is present", async () => {
        const index = makeIndex({ maiGpsBox: { offset: 100, size: 200 } });
        expect(await gpsBox70maiPrimitive.marker(vf(), index)).toBe(true);
    });

    it("does not fire without a GPS box", async () => {
        expect(await gpsBox70maiPrimitive.marker(vf(), makeIndex())).toBe(false);
        expect(await gpsBox70maiPrimitive.marker(vf(), undefined)).toBe(false);
    });
});

/** One top-level udta stub entry around a head (offsets are irrelevant to
 *  the sync markers - only the head bytes are read). */
function udtaAtoms(...heads: Array<Uint8Array | null>): Mp4Index["topLevelUdtaAtoms"] {
    return heads.map((head, i) => ({ offset: i * 100, size: 100, headerSize: 8, head }));
}

describe("ligoJsonPrimitive.marker", () => {
    const enc = new TextEncoder();

    it("fires when a top-level udta head opens with the LIGOGPSINFO-JSON literal", async () => {
        const head = enc.encode('LIGOGPSINFO {"Hour":1}'.padEnd(32, " "));
        expect(await ligoJsonPrimitive.marker(vf(), makeIndex({ topLevelUdtaAtoms: udtaAtoms(head) }))).toBe(true);
    });

    it("fires on the GKU signature at head offset 8", async () => {
        const head = new Uint8Array(32);
        head.set(enc.encode("__V35AX_QVDATA__"), 8);
        expect(await ligoJsonPrimitive.marker(vf(), makeIndex({ topLevelUdtaAtoms: udtaAtoms(head) }))).toBe(true);
    });

    it("fires when a generic udta PRECEDES the marker-bearing one (mux order is firmware whim)", async () => {
        const plain = enc.encode("meta".padEnd(32, "\0"));
        const head = enc.encode('LIGOGPSINFO {"Hour":1}'.padEnd(32, " "));
        const index = makeIndex({ topLevelUdtaAtoms: udtaAtoms(plain, head) });
        expect(await ligoJsonPrimitive.marker(vf(), index)).toBe(true);
    });

    it("does not fire on ordinary udta heads or a missing one", async () => {
        const plain = enc.encode("meta".padEnd(32, "\0"));
        const plain2 = enc.encode("more meta".padEnd(32, "\0"));
        expect(await ligoJsonPrimitive.marker(vf(), makeIndex({ topLevelUdtaAtoms: udtaAtoms(plain) }))).toBe(false);
        expect(await ligoJsonPrimitive.marker(vf(), makeIndex({ topLevelUdtaAtoms: udtaAtoms(plain, plain2) }))).toBe(
            false,
        );
        expect(await ligoJsonPrimitive.marker(vf(), makeIndex())).toBe(false);
        expect(await ligoJsonPrimitive.marker(vf(), undefined)).toBe(false);
    });

    it("does not fire on the encrypted-chunk LigoGPS literal (that is the ligogps primitive's file)", async () => {
        // 'LIGOGPSINFO\0' without the ' {' JSON opener belongs to the
        // chunk-encrypted family - the two primitives must not cross-claim.
        const head = new Uint8Array(32);
        head.set(enc.encode("LIGOGPSINFO\0\0\0\0\x05"), 0);
        expect(await ligoJsonPrimitive.marker(vf(), makeIndex({ topLevelUdtaAtoms: udtaAtoms(head) }))).toBe(false);
    });
});

describe("kenwoodPrimitive.marker", () => {
    const enc = new TextEncoder();

    it("fires when a top-level udta head opens with the VIDEOUUU literal", async () => {
        const head = enc.encode("VIDEOUUUUUUUUUUUUUUUUUUUUUU".padEnd(32, "U"));
        expect(await kenwoodPrimitive.marker(vf(), makeIndex({ topLevelUdtaAtoms: udtaAtoms(head) }))).toBe(true);
    });

    it("fires when a generic udta PRECEDES the VIDEOUUU one", async () => {
        const plain = enc.encode("meta".padEnd(32, "\0"));
        const head = enc.encode("VIDEOUUUUUUUUUUUUUUUUUUUUUU".padEnd(32, "U"));
        const index = makeIndex({ topLevelUdtaAtoms: udtaAtoms(plain, head) });
        expect(await kenwoodPrimitive.marker(vf(), index)).toBe(true);
    });

    it("does not fire on ordinary udta heads and reads nothing without a trailer gap", async () => {
        const plain = enc.encode("meta".padEnd(32, "\0"));
        const plain2 = enc.encode("more meta".padEnd(32, "\0"));
        // lastTopLevelBoxEnd === fileSize -> no trailing junk -> no probe IO.
        const index = makeIndex({ topLevelUdtaAtoms: udtaAtoms(plain, plain2), lastTopLevelBoxEnd: 0, fileSize: 0 });
        expect(await kenwoodPrimitive.marker(vf(), index)).toBe(false);
        expect(await kenwoodPrimitive.marker(vf(), undefined)).toBe(false);
    });
});

describe("gpmfPrimitive.marker", () => {
    it("fires when a track has sampleFormat='gpmd'", async () => {
        // findGpmdTrack looks at sample-format, not handlerType.
        const index = makeIndex({
            tracks: [{ sampleFormat: "gpmd" } as unknown as Mp4Index["tracks"][0]],
        });
        expect(await gpmfPrimitive.marker(vf(), index)).toBe(true);
    });

    it("does not fire on tracks with other sample formats", async () => {
        const index = makeIndex({
            tracks: [{ sampleFormat: "tx3g" } as unknown as Mp4Index["tracks"][0]],
        });
        expect(await gpmfPrimitive.marker(vf(), index)).toBe(false);
    });

    it("does not fire when handlerType='gpmd' but sampleFormat differs", async () => {
        // Important: classifyEmbeddedGpsKind in registry.ts uses handlerType,
        // but gpmf primitive uses sampleFormat. These two checks live at
        // different layers and serve different purposes (kind gate vs format
        // confirmation). Pin the distinction so a future "let's just use
        // handlerType everywhere" refactor doesn't silently merge them.
        const index = makeIndex({
            tracks: [{ handlerType: "gpmd", sampleFormat: "other" } as unknown as Mp4Index["tracks"][0]],
        });
        expect(await gpmfPrimitive.marker(vf(), index)).toBe(false);
    });
});

describe("freegpsPrimitive.marker", () => {
    // A moov holding only a `gps ` atom whose canonical payload is
    // version(4) + count(4) + count x [offset u32 BE, size u32 BE].
    function gpsTableIndex(entries: Array<[offset: number, size: number]>, declaredCount = entries.length): Mp4Index {
        const payloadLen = 8 + entries.length * 8;
        const moov = new Uint8Array(8 + 8 + payloadLen);
        const view = new DataView(moov.buffer);
        view.setUint32(0, moov.length);
        moov.set(new TextEncoder().encode("moov"), 4);
        view.setUint32(8, 8 + payloadLen);
        moov.set(new TextEncoder().encode("gps "), 12);
        view.setUint32(16, 0x00000101);
        view.setUint32(20, declaredCount);
        entries.forEach(([offset, size], i) => {
            view.setUint32(24 + i * 8, offset);
            view.setUint32(28 + i * 8, size);
        });
        return makeIndex({
            fileSize: 1 << 30,
            moovView: view,
            novatekGpsAtom: { type: "gps ", start: 8, end: moov.length, payloadStart: 16 },
        });
    }

    it("fires on a usable `gps ` table (structural path)", async () => {
        expect(await freegpsPrimitive.marker(vf(), gpsTableIndex([[4096, 0x8000]]))).toBe(true);
    });

    it("does not fire on a placeholder table with a zero count (70mai rear channel)", async () => {
        expect(await freegpsPrimitive.marker(vf(), gpsTableIndex([], 0))).toBe(false);
    });

    it("does not fire on a junk table whose entries are all zero or out of range (VIOFO A329)", async () => {
        const junk = gpsTableIndex([
            [0x801e3200, 0],
            [0, 0],
            [0x76484200, 0],
        ]);
        expect(await freegpsPrimitive.marker(vf(), junk)).toBe(false);
    });

    it("fires on hasFreeGpsMarker (streaming fallback)", async () => {
        expect(await freegpsPrimitive.marker(vf(), makeIndex({ hasFreeGpsMarker: true }))).toBe(true);
    });

    it("fires on either signal - a usable table OR hasFreeGpsMarker", async () => {
        const both = gpsTableIndex([[4096, 0x8000]]);
        both.hasFreeGpsMarker = true;
        expect(await freegpsPrimitive.marker(vf(), both)).toBe(true);
    });

    it("does not fire when neither flag is set", async () => {
        expect(await freegpsPrimitive.marker(vf(), makeIndex())).toBe(false);
    });
});

describe("freegps70maiPrimitive.marker", () => {
    function dialectBlock(): Uint8Array {
        const bytes = new Uint8Array(64);
        bytes.set(new TextEncoder().encode("freeGPS "));
        const view = new DataView(bytes.buffer);
        view.setUint16(8, 0x01ed, true);
        view.setUint16(14, 0x01ed, true);
        view.setUint8(26, 0x41);
        view.setInt32(27, 500_000_000, true);
        view.setInt32(31, 300_000_000, true);
        return bytes;
    }

    it("uses the canonical filename as a fast hint", async () => {
        const index = makeIndex({ hasFreeGpsMarker: true });
        expect(await freegps70maiPrimitive.marker(vf("VL20260428-192844-000413F.MP4"), index)).toBe(true);
    });

    it("accepts a renamed file when a probe block has the 70mai dialect", async () => {
        const headerBytes = dialectBlock();
        const index = makeIndex({ headerBytes, hasFreeGpsMarker: true, freeGpsSeedOffsets: [0] });
        expect(await freegps70maiPrimitive.marker(vf("renamed.mp4"), index)).toBe(true);
    });

    it("does not claim a renamed generic freeGPS file from magic alone", async () => {
        const headerBytes = new Uint8Array(64);
        headerBytes.set(new TextEncoder().encode("freeGPS "));
        const index = makeIndex({ headerBytes, hasFreeGpsMarker: true, freeGpsSeedOffsets: [0] });
        expect(await freegps70maiPrimitive.marker(vf("renamed.mp4"), index)).toBe(false);
    });
});

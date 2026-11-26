// Unit tests for the Garmin DriveAssist 51 uuid-atom extractor. Fixtures are
// synthetic, hand-packed per the ExifTool struct spec (QuickTimeStream.pl
// ProcessGarminGPS:3514-3543, QuickTime.pm:1244-1252, v13.59) - no public
// hexdump exists in the ExifTool source for this format, and no real
// DriveAssist 51 sample is in the corpus yet (foreign-source waiver batch).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { freeGpsBoxPrimitive } from "../primitives/free-gps-box.js";
import { freegps70maiPrimitive } from "../primitives/freegps-70mai.js";
import { freegpsPrimitive } from "../primitives/freegps.js";
import { garminUuidPrimitive } from "../primitives/garmin-uuid.js";
import { gpmfPrimitive } from "../primitives/gpmf.js";
import { gpsBox70maiPrimitive } from "../primitives/gps-box-70mai.js";
import { ligoGpsPrimitive } from "../primitives/ligogps.js";
import { navitelTailPrimitive } from "../primitives/navitel-tail.js";
import { pndmPrimitive } from "../primitives/pndm.js";
import { rvmiPrimitive } from "../primitives/rvmi.js";
import type { VendorFile } from "../types.js";
import { WrongFormatError } from "../types.js";
import { dispatchParseVideoEmbeddedGps } from "../registry.js";
import { GARMIN_GPS_UUID, findGarminUuidBox, parseGarminUuidBox } from "./garmin-uuid.js";
import { buildMp4Index, type Mp4Index } from "./mp4-index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const QT_EPOCH_OFFSET_SEC = 2082844800;
// 45 deg = 2^31/4 raw, exact in the 180/2^31 fixed-point encoding.
const RAW_45_DEG = 0x20000000;
const I32_MIN = -2147483648;
// A different real-world uuid usertype (Canon SX280, ExifTool
// QuickTime.pm:1237) - the closest thing to a "wrong but plausible" UUID.
const CANON_UUID = [0x85, 0xc0, 0xb6, 0x87, 0x82, 0x0f, 0x11, 0xe0, 0x81, 0x11, 0xf4, 0xce, 0x46, 0x2b, 0x6a, 0x48];

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

function box(type: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(8 + payload.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, out.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(payload, 8);
    return out;
}

// Default record time: in the 2000..2100 plausibility window the extractor
// now enforces (a 0 default would land in 1970 and trip the gate).
const DEFAULT_RECORD_UNIX = Date.UTC(2021, 5, 15, 12, 0, 0) / 1000;

/** Packs one 20-byte big-endian record per the ExifTool layout. */
function packRecord(opts: {
    unixSeconds?: number;
    mph?: number;
    latRaw?: number;
    lonRaw?: number;
}): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(20);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, (opts.unixSeconds ?? DEFAULT_RECORD_UNIX) + QT_EPOCH_OFFSET_SEC);
    dv.setUint16(4, opts.mph ?? 0);
    // bytes 6..11 unknown - zero
    dv.setInt32(12, opts.latRaw ?? RAW_45_DEG);
    dv.setInt32(16, opts.lonRaw ?? RAW_45_DEG);
    return out;
}

/** uuid box payload: usertype(16) + 17 unknown header bytes + records. */
function garminUuidBox(records: Uint8Array[], usertype: readonly number[] = GARMIN_GPS_UUID): Uint8Array<ArrayBuffer> {
    return box("uuid", concatBytes(Uint8Array.from(usertype), new Uint8Array(17), ...records));
}

function moovBytes(...children: Uint8Array[]): Uint8Array<ArrayBuffer> {
    return box("moov", concatBytes(...children));
}

/** Minimal Mp4Index stub over synthetic moov bytes (sync-marker tests). */
function indexFromMoov(bytes: Uint8Array | null): Mp4Index {
    return {
        headerBytes: null,
        headerView: null,
        fileSize: bytes?.length ?? 0,
        durationSec: null,
        createdUtc: null,
        moov: bytes ? { type: "moov", start: 0, end: bytes.length, payloadStart: 8 } : null,
        moovView: bytes ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null,
        tracks: [],
        topLevelFreeBox: null,
        freeBoxView: null,
        freeGpsBoxInsideFree: null,
        free3gfBoxInsideFree: null,
        novatekGpsAtom: null,
        hasFreeGpsMarker: false,
        hasLigoGpsMarker: false,
        freeGpsSeedOffsets: [],
        navitelGps0Atom: null,
        navitelGsenAtom: null,
        navitelIditAtom: null,
        maiGpsBox: null,
        topLevelUdatAtom: null,
        topLevelGdatAtom: null,
        topLevelNbmtAtom: null,
        topLevelUdtaAtoms: [],
        lastTopLevelBoxEnd: null,
        trailerHead: null,
        tsGpsTrailer: null,
        kodakVersion: null,
        firstSampleCache: new Map(),
        sliceCost: 0,
    };
}

function vf(name = "GRMN0001.MP4"): VendorFile {
    return { file: new File([new Uint8Array(0)], name), relativePath: name };
}

describe("findGarminUuidBox", () => {
    it("finds the uuid atom among moov children by exact usertype", () => {
        const moov = moovBytes(garminUuidBox([packRecord({})]));
        const found = findGarminUuidBox(indexFromMoov(moov));
        expect(found).not.toBeNull();
        expect(found!.type).toBe("uuid");
    });

    it("skips non-Garmin uuid children and matches a later one (multiple uuid atoms)", () => {
        const moov = moovBytes(
            box("mvhd", new Uint8Array(100)),
            garminUuidBox([packRecord({})], CANON_UUID),
            garminUuidBox([packRecord({})]),
        );
        const found = findGarminUuidBox(indexFromMoov(moov));
        expect(found).not.toBeNull();
        // Must be the second uuid child, not the Canon one at the front.
        const view = indexFromMoov(moov).moovView!;
        for (let i = 0; i < 16; i++) {
            expect(view.getUint8(found!.payloadStart + i)).toBe(GARMIN_GPS_UUID[i]);
        }
    });

    it("returns null when the only uuid child has a foreign usertype", () => {
        const moov = moovBytes(garminUuidBox([packRecord({})], CANON_UUID));
        expect(findGarminUuidBox(indexFromMoov(moov))).toBeNull();
    });

    it("returns null when moov has no uuid children", () => {
        const moov = moovBytes(box("mvhd", new Uint8Array(100)));
        expect(findGarminUuidBox(indexFromMoov(moov))).toBeNull();
    });

    it("returns null without crashing on a uuid box too short for a usertype", () => {
        const moov = moovBytes(box("uuid", new Uint8Array(8)));
        expect(findGarminUuidBox(indexFromMoov(moov))).toBeNull();
    });

    it("returns null when the index has no moov", () => {
        expect(findGarminUuidBox(indexFromMoov(null))).toBeNull();
    });
});

describe("parseGarminUuidBox", () => {
    function parseMoov(moov: Uint8Array, name = "GRMN0001.MP4") {
        const index = indexFromMoov(moov);
        const found = findGarminUuidBox(index);
        expect(found).not.toBeNull();
        return parseGarminUuidBox(index.moovView!, found!, name);
    }

    it("decodes time (1904 epoch), speed (mph) and fixed-point coords", () => {
        // 2021-06-15 12:00:00 UTC; raw u32 = unix + 2082844800 fits 32 bits.
        const unix = Date.UTC(2021, 5, 15, 12, 0, 0) / 1000;
        const moov = moovBytes(
            garminUuidBox([packRecord({ unixSeconds: unix, mph: 50, latRaw: RAW_45_DEG, lonRaw: -2 * RAW_45_DEG })]),
        );
        const { records, skipped } = parseMoov(moov);
        expect(skipped).toHaveLength(0);
        expect(records).toHaveLength(1);
        const r = records[0]!;
        expect(r.unixSeconds).toBe(unix);
        expect(r.lat).toBeCloseTo(45, 10);
        expect(r.lon).toBeCloseTo(-90, 10);
        expect(r.speedMs).toBeCloseTo(50 * 0.44704, 6);
        expect(r.active).toBe(true);
        expect(r.bearingDeg).toBe(0);
        expect(r.mp4Filename).toBe("GRMN0001.MP4");
        // Absolute GPS wall-clock - must NOT be flagged for re-anchoring.
        expect(r.timeUnsynced).toBeUndefined();
    });

    it("skips the no-fix sentinel record (both coords i32 min) silently", () => {
        const unix = Date.UTC(2021, 5, 15, 12, 0, 0) / 1000;
        const moov = moovBytes(
            garminUuidBox([
                packRecord({ unixSeconds: unix }),
                packRecord({ unixSeconds: unix + 1, latRaw: I32_MIN, lonRaw: I32_MIN }),
                packRecord({ unixSeconds: unix + 2 }),
            ]),
        );
        const { records, skipped } = parseMoov(moov);
        expect(records).toHaveLength(2);
        expect(skipped).toHaveLength(0);
        expect(records.map((r) => r.unixSeconds)).toEqual([unix, unix + 2]);
    });

    it("rejects a half-sentinel row (lat = i32 min alone -> -180 deg) as out of range", () => {
        const moov = moovBytes(garminUuidBox([packRecord({ latRaw: I32_MIN, lonRaw: RAW_45_DEG })]));
        const { records, skipped } = parseMoov(moov);
        expect(records).toHaveLength(0);
        expect(skipped).toHaveLength(1);
        expect(skipped[0]!.reason).toBe("latitude out of range");
    });

    it("rejects rows with an implausible timestamp (raw u32 below the 2000-01-01 epoch)", () => {
        // ExifTool converts the 1904-epoch u32 blindly; we gate, because one
        // corrupt row with plausible coords would otherwise reach
        // deriveStartUtc as the trip's "GPS first record" wall-clock.
        const unix = Date.UTC(2021, 5, 15, 12, 0, 0) / 1000;
        const moov = moovBytes(
            garminUuidBox([
                packRecord({ unixSeconds: -QT_EPOCH_OFFSET_SEC }), // raw time slot = 0 -> year 1904
                packRecord({ unixSeconds: Date.UTC(1999, 11, 31, 23, 59, 59) / 1000 }), // just below the window
                packRecord({ unixSeconds: unix }), // in-window control
            ]),
        );
        const { records, skipped } = parseMoov(moov);
        expect(records).toHaveLength(1);
        expect(records[0]!.unixSeconds).toBe(unix);
        expect(skipped).toHaveLength(2);
        expect(skipped.every((s) => s.reason === "timestamp out of range")).toBe(true);
    });

    it("accepts the max-u32 raw time (~2040) - the whole u32 range above 2000 is plausible", () => {
        // 0xFFFFFFFF - 2082844800 = Feb 2040: inside the 2000..2100 window,
        // so the upper bound is unreachable for this field by construction.
        const moov = moovBytes(garminUuidBox([packRecord({ unixSeconds: 0xffffffff - QT_EPOCH_OFFSET_SEC })]));
        const { records, skipped } = parseMoov(moov);
        expect(records).toHaveLength(1);
        expect(skipped).toHaveLength(0);
    });

    it("skips zero-filled rows (0,0 fix) silently", () => {
        const moov = moovBytes(garminUuidBox([packRecord({ latRaw: 0, lonRaw: 0 }), packRecord({})]));
        const { records, skipped } = parseMoov(moov);
        expect(records).toHaveLength(1);
        expect(skipped).toHaveLength(0);
    });

    it("ignores a truncated trailing record (< 20 bytes left)", () => {
        const full = packRecord({});
        const moov = moovBytes(garminUuidBox([full, full.slice(0, 12)]));
        const { records } = parseMoov(moov);
        expect(records).toHaveLength(1);
    });

    it("returns empty records for an atom with header only (no record space)", () => {
        const moov = moovBytes(garminUuidBox([]));
        const { records, skipped } = parseMoov(moov);
        expect(records).toHaveLength(0);
        expect(skipped).toHaveLength(0);
    });
});

describe("garminUuidPrimitive", () => {
    it("marker fires on a moov with the Garmin uuid atom", async () => {
        const index = indexFromMoov(moovBytes(garminUuidBox([packRecord({})])));
        expect(await garminUuidPrimitive.marker(vf(), index)).toBe(true);
    });

    it("marker does not fire without index or without the atom", async () => {
        expect(await garminUuidPrimitive.marker(vf(), undefined)).toBe(false);
        expect(await garminUuidPrimitive.marker(vf(), indexFromMoov(null))).toBe(false);
        expect(await garminUuidPrimitive.marker(vf(), indexFromMoov(moovBytes(box("mvhd", new Uint8Array(100)))))).toBe(
            false,
        );
    });

    it("parse returns records bound to the file name", async () => {
        const unix = Date.UTC(2024, 0, 2, 3, 4, 5) / 1000;
        const index = indexFromMoov(moovBytes(garminUuidBox([packRecord({ unixSeconds: unix, mph: 10 })])));
        const result = await garminUuidPrimitive.parse(vf("trip.MP4"), index);
        expect(result.records).toHaveLength(1);
        expect(result.records[0]!.mp4Filename).toBe("trip.MP4");
    });

    it("parse throws WrongFormatError when the atom is gone (marker/parse divergence)", async () => {
        await expect(garminUuidPrimitive.parse(vf(), indexFromMoov(null))).rejects.toThrow(WrongFormatError);
        await expect(garminUuidPrimitive.parse(vf(), undefined)).rejects.toThrow(WrongFormatError);
    });
});

// Negative cross-claim tests, both directions: the new marker must not claim
// existing formats, and existing sync/probe markers must not claim the new
// synthetic fixture. Mandatory for foreign-source formats (no real sample to
// catch a misfire in the wild).
describe("cross-claim isolation", () => {
    it("garmin-uuid marker stays false when every OTHER format flag is set", async () => {
        const index = indexFromMoov(moovBytes(box("mvhd", new Uint8Array(100))));
        index.novatekGpsAtom = { type: "gps ", start: 0, end: 8, payloadStart: 8 };
        index.hasFreeGpsMarker = true;
        index.hasLigoGpsMarker = true;
        index.navitelGps0Atom = { offset: 0, size: 8 };
        index.navitelIditAtom = { offset: 8, size: 8 };
        index.maiGpsBox = { offset: 16, size: 8 };
        expect(await garminUuidPrimitive.marker(vf(), index)).toBe(false);
    });

    it("garmin-uuid marker is false on real existing MP4 fixtures", async () => {
        // Real moov structures from the corpus: Novatek (freeGPS) and GoPro
        // (gpmd track). Neither carries a moov-level Garmin uuid atom.
        const fixtures = [
            "tests/testdata/novatek-real-anonymized/2e-drive-730.mp4",
            "tests/testdata/gopro-gpmf/hero5-trimmed.mp4",
        ];
        for (const rel of fixtures) {
            const buf = readFileSync(resolve(REPO_ROOT, rel));
            const file = new File([buf], rel.split("/").pop()!);
            const index = await buildMp4Index(file);
            expect(await garminUuidPrimitive.marker({ file, relativePath: file.name }, index), rel).toBe(false);
        }
    });

    it("existing primitives do not claim the new synthetic Garmin fixture", async () => {
        // Whole-file fixture (moov as the only top-level box) run through the
        // real buildMp4Index, exactly as the dispatcher would.
        const fileBytes = moovBytes(garminUuidBox([packRecord({ unixSeconds: 1700000000, mph: 30 })]));
        const file = new File([fileBytes], "GRMN0001.MP4");
        const index = await buildMp4Index(file);
        const candidate: VendorFile = { file, relativePath: "GRMN0001.MP4" };

        expect(await garminUuidPrimitive.marker(candidate, index), "sanity: own marker").toBe(true);

        const others = [
            rvmiPrimitive,
            freeGpsBoxPrimitive,
            ligoGpsPrimitive,
            navitelTailPrimitive,
            gpsBox70maiPrimitive,
            gpmfPrimitive,
            pndmPrimitive,
            freegps70maiPrimitive,
            freegpsPrimitive,
        ];
        for (const primitive of others) {
            expect(await primitive.marker(candidate, index), primitive.id).toBe(false);
        }
    });

    it("preserves Garmin Travelapse span equally when opened from DCIM/104TLPSE or as a standalone file", async () => {
        const mvhdPayload = new Uint8Array(96);
        const mvhdDv = new DataView(mvhdPayload.buffer);
        mvhdDv.setUint32(12, 1000, false); // timescale
        mvhdDv.setUint32(16, 60_000, false); // 60 s playback duration

        const t0 = DEFAULT_RECORD_UNIX;
        const offsets = [0, 600, 601, 602, 603];
        const fileBytes = moovBytes(
            box("mvhd", mvhdPayload),
            garminUuidBox(offsets.map((off) => packRecord({ unixSeconds: t0 + off, mph: 30 }))),
        );

        const openAt = async (relativePath: string, name = "GRMN0003.MP4") =>
            dispatchParseVideoEmbeddedGps([
                {
                    file: { file: new File([fileBytes], name), relativePath },
                    role: "video",
                    sidecarId: null,
                    sidecarMp4: null,
                    logExtractorId: null,
                },
            ]);

        const fromFolder = await openAt("DCIM/104TLPSE/GRMN0003.MP4");
        const standalone = await openAt("GRMN0003.MP4");
        const renamed = await openAt("holiday.mp4", "holiday.mp4");
        const nonTimelapseFolder = await openAt("DCIM/105UNSVD/GRMN0003.MP4");

        expect(fromFolder.records.map((r) => r.unixSeconds - t0)).toEqual(offsets);
        expect(standalone.records.map((r) => r.unixSeconds - t0)).toEqual(offsets);
        expect(renamed.records.map((r) => r.unixSeconds - t0)).toEqual(offsets);
        // Inside an explicit non-timelapse Garmin folder, the 600 s gap on a
        // 60 s clip still triggers the leading edge outlier drop.
        expect(nonTimelapseFolder.records.map((r) => r.unixSeconds - t0)).toEqual([600, 601, 602, 603]);
    });
});

// Unit tests for the classifyOneNonVideo helper - the reuse point shared by
// main-thread classifyFiles and the worker-thread ingest-worker. Covers role
// priority (log-sidecar > sidecar > accel-sidecar > unknown) and the fact
// that sidecarHandlers/accelHandlers are parameters (the worker passes a
// gpx-less list).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
    type ClassifiedFile,
    classifyOneNonVideo,
    dispatchParseVideoEmbeddedGps,
    mergeAccelSamples,
} from "./registry.js";
import { combineAccelSources } from "./registry-light.js";
import { parse3gfBuffer } from "./sidecars/blackvue-3gf.js";
import { gpxSidecar } from "./sidecars/gpx.js";
import { ddpaiGpxSidecar } from "./sidecars/nmea-sidecar.js";
import type { AccelSample, AccelSidecarHandler, GpsRecord, SidecarHandler, VendorFile } from "./types.js";
import { detectEvents } from "../events.js";
import { vendorFileKey } from "../vendor-file-key.js";

function makeVendorFile(name: string, content: string): VendorFile {
    return {
        file: new File([content], name),
        relativePath: name,
    };
}

// Basic fake handlers - matches/parse return predictable values; the test
// checks the dispatcher calls them in the right order.
const fakeSidecar: SidecarHandler = {
    id: "fake-sidecar",
    matches(file, knownVideos) {
        const m = file.file.name.match(/^(.+)\.fakegps$/i);
        if (!m) return null;
        const mp4 = `${m[1]}.mp4`;
        return knownVideos.has(mp4) ? mp4 : null;
    },
    async parse(): Promise<GpsRecord[]> {
        return [];
    },
};

const fakeAccelSidecar: AccelSidecarHandler = {
    id: "fake-accel",
    matches(file, knownVideos) {
        const m = file.file.name.match(/^(.+)\.fakeacc$/i);
        if (!m) return null;
        const mp4 = `${m[1]}.mp4`;
        return knownVideos.has(mp4) ? mp4 : null;
    },
    async parseAccel(): Promise<AccelSample[]> {
        return [];
    },
};

describe("classifyOneNonVideo", () => {
    it("returns role=gps-log when csv-70mai marker matches", async () => {
        // csv-70mai marker: name `GPSData*.txt` + `$V` in the first ~512 bytes.
        const file = makeVendorFile("GPSData.txt", "$V02,1700000000,1,40.0,N,-74.0,W,0,0,VIDEO.MP4,0,0,0\n");
        const cf = await classifyOneNonVideo(file, new Set(), [fakeSidecar], [fakeAccelSidecar]);
        expect(cf.role).toBe("gps-log");
        expect(cf.logExtractorId).toBe("csv-70mai");
        expect(cf.sidecarId).toBeNull();
    });

    it("returns role=gps-log when the dated 70mai marker matches", async () => {
        const file = makeVendorFile(
            ".GPS/GPSData000001.txt",
            "2026-08-01 20:30:59,B,A,074km/h,43.000000,-9.000000,1,20260801-223057-000001F.MP4\n",
        );
        const cf = await classifyOneNonVideo(file, new Set(), [fakeSidecar], [fakeAccelSidecar]);
        expect(cf.role).toBe("gps-log");
        expect(cf.logExtractorId).toBe("csv-70mai-dated");
    });

    it("returns role=gps-log for a recording-scoped NMEA .LOG", async () => {
        const file = makeVendorFile("26082300.LOG", "@Sonygps/ver5.0/wgs-84/20260823075402.000/\n");
        const cf = await classifyOneNonVideo(file, new Set(), [fakeSidecar], [fakeAccelSidecar]);
        expect(cf.role).toBe("gps-log");
        expect(cf.logExtractorId).toBe("sectioned-nmea-log");
        expect(cf.sidecarId).toBeNull();
    });

    it("returns role=gps-log for a 360GPSINFO JSONL stream", async () => {
        const file = makeVendorFile(
            "20260824205434_000001GPS.TXT",
            '{"a":22,"o":114,"s":5.9,"d":331,"t":"2026:08:24-20:55:25"}\n',
        );
        const cf = await classifyOneNonVideo(file, new Set(), [fakeSidecar], [fakeAccelSidecar]);
        expect(cf.role).toBe("gps-log");
        expect(cf.logExtractorId).toBe("360gps-jsonl");
        expect(cf.sidecarId).toBeNull();
    });

    it("keeps a model-specific DDPai .gpx on its authoritative sidecar path", async () => {
        const file = makeVendorFile(
            "20190719161640_0060.gpx",
            "$GPRMC,161640.00,A,5546.0000,N,03737.0000,E,0,0,190719,,*00\n",
        );
        file.relativePath = "DCIM/103gps/20190719161640_0060.gpx";
        const cf = await classifyOneNonVideo(
            file,
            new Set(["20190719161640_0060.mp4"]),
            [ddpaiGpxSidecar, gpxSidecar],
            [],
        );
        expect(cf).toMatchObject({
            role: "sidecar",
            sidecarId: "ddpai-gpx",
            sidecarMp4: "20190719161640_0060.mp4",
        });
    });

    it("returns role=sidecar when a sidecar handler matches a known video", async () => {
        const file = makeVendorFile("trip01.fakegps", "ignored content");
        const known = new Set(["trip01.mp4"]);
        const cf = await classifyOneNonVideo(file, known, [fakeSidecar], [fakeAccelSidecar]);
        expect(cf.role).toBe("sidecar");
        expect(cf.sidecarId).toBe("fake-sidecar");
        expect(cf.sidecarMp4).toBe("trip01.mp4");
    });

    it("returns role=accel-sidecar when an accel handler matches a known video", async () => {
        const file = makeVendorFile("trip02.fakeacc", "ignored");
        const known = new Set(["trip02.mp4"]);
        const cf = await classifyOneNonVideo(file, known, [fakeSidecar], [fakeAccelSidecar]);
        expect(cf.role).toBe("accel-sidecar");
        expect(cf.sidecarId).toBe("fake-accel");
        expect(cf.sidecarMp4).toBe("trip02.mp4");
    });

    it("returns role=unknown when nothing matches", async () => {
        const file = makeVendorFile("random.bin", "junk");
        const cf = await classifyOneNonVideo(file, new Set(), [fakeSidecar], [fakeAccelSidecar]);
        expect(cf.role).toBe("unknown");
        expect(cf.sidecarId).toBeNull();
        expect(cf.logExtractorId).toBeNull();
        expect(cf.sidecarMp4).toBeNull();
    });

    it("does not match a sidecar when the associated MP4 is not in knownVideos", async () => {
        // A .fakegps file exists, but its .mp4 counterpart is not in
        // knownVideos - matches() returns null, role falls back to unknown.
        const file = makeVendorFile("trip03.fakegps", "ignored");
        const cf = await classifyOneNonVideo(file, new Set(), [fakeSidecar], [fakeAccelSidecar]);
        expect(cf.role).toBe("unknown");
    });

    it("prefers log-sidecar over gps-sidecar when both could match", async () => {
        // A file named `GPSData.txt` ($V signature) that also matches the
        // `.fakegps` suffix - never happens in reality, but the priority
        // test needs overlapping matchers.
        const matchAll: SidecarHandler = {
            id: "match-all",
            matches: () => "any.mp4",
            async parse() {
                return [];
            },
        };
        const file = makeVendorFile("GPSData.txt", "$V02,1700000000,1,0,N,0,W,0,0,VIDEO.MP4,0,0,0\n");
        const cf = await classifyOneNonVideo(file, new Set(["any.mp4"]), [matchAll], [fakeAccelSidecar]);
        expect(cf.role).toBe("gps-log");
        expect(cf.logExtractorId).toBe("csv-70mai");
    });

    it("prefers gps-sidecar over accel-sidecar when both could match", async () => {
        const matchAllAccel: AccelSidecarHandler = {
            id: "match-all-accel",
            matches: () => "any.mp4",
            async parseAccel() {
                return [];
            },
        };
        const file = makeVendorFile("trip04.fakegps", "ignored");
        const cf = await classifyOneNonVideo(file, new Set(["trip04.mp4"]), [fakeSidecar], [matchAllAccel]);
        expect(cf.role).toBe("sidecar");
        expect(cf.sidecarId).toBe("fake-sidecar");
    });

    it("respects handler order in sidecarHandlers (first match wins)", async () => {
        const handlerA: SidecarHandler = {
            id: "handler-a",
            matches: () => "first.mp4",
            async parse() {
                return [];
            },
        };
        const handlerB: SidecarHandler = {
            id: "handler-b",
            matches: () => "second.mp4",
            async parse() {
                return [];
            },
        };
        const file = makeVendorFile("random.xyz", "ignored");
        const cf = await classifyOneNonVideo(file, new Set(), [handlerA, handlerB], [fakeAccelSidecar]);
        expect(cf.sidecarId).toBe("handler-a");
        expect(cf.sidecarMp4).toBe("first.mp4");
    });

    it("passes the empty sidecarHandlers list cleanly (worker may pass gpx-less list)", async () => {
        // The worker passes WORKER_SIDECARS = SIDECARS.filter(id !== "gpx").
        // Worst case - an empty list: classifyOneNonVideo must not throw.
        const file = makeVendorFile("trip05.fakegps", "ignored");
        const cf = await classifyOneNonVideo(file, new Set(["trip05.mp4"]), [], []);
        expect(cf.role).toBe("unknown");
    });
});

// ===== Novatek marker-probe escalation in tryParseOne =====
//
// The default 4 MB probe (buildMp4Index DEFAULT_PROBE_BYTES) can miss the
// first freeGPS block of a high-bitrate clip whose moov `gps ` table is
// absent/broken. tryParseOne escalates the probe to MAX_PROBE_BYTES for
// Novatek-family filenames before settling on kind "none". The fixture is a
// sparse synthetic 8 MB file (blocks at 5 / 6.5 MB - past the 4 MB window,
// inside the 16 MB escalation window) so nothing large gets committed.

const MB = 1024 * 1024;

/**
 * Sparse File mock with read-byte accounting: holds only the placed regions,
 * slice() zero-fills the rest. Mirrors the SparseFile helper in
 * internal/freegps.test.ts (file-local test scaffolding there).
 */
class SparseTrackingFile {
    public lastModified = 0;
    public type = "video/mp4";
    public readBytesTotal = 0;
    constructor(
        public name: string,
        public size: number,
        private regions: Array<{ offset: number; data: Uint8Array }>,
    ) {}
    slice(start: number, end?: number): Blob {
        const e = Math.min(end ?? this.size, this.size);
        const len = Math.max(0, e - start);
        this.readBytesTotal += len;
        const buf = new Uint8Array(len);
        for (const r of this.regions) {
            const rEnd = r.offset + r.data.length;
            if (rEnd <= start || r.offset >= e) continue;
            const copyStart = Math.max(start, r.offset);
            const copyEnd = Math.min(e, rEnd);
            buf.set(r.data.subarray(copyStart - r.offset, copyEnd - r.offset), copyStart - start);
        }
        return { arrayBuffer: async () => buf.buffer } as unknown as Blob;
    }
}

// Minimal valid freeGPS block in the LAYOUT_DEFAULT geometry: 8-byte magic,
// 6 x u32 LE datetime at 44, 'A','N','E' status at 68..70, lat/lon/speed/
// course float32 LE at 72..87. Compact twin of buildCanonicalType3Block in
// internal/freegps.test.ts (anchor 68, fixed values).
function buildDefaultFreeGpsBlock(): Uint8Array {
    const bytes = new Uint8Array(128);
    bytes.set(new TextEncoder().encode("freeGPS "), 0);
    const dv = new DataView(bytes.buffer);
    [10, 20, 30, 21, 6, 15].forEach((value, i) => {
        dv.setUint32(44 + i * 4, value, true); // h, mi, s, yy, mo, d
    });
    bytes[68] = 0x41; // 'A'
    bytes[69] = 0x4e; // 'N'
    bytes[70] = 0x45; // 'E'
    dv.setFloat32(72, 5006.0, true); // DDmm.mmmm -> 50.1 deg
    dv.setFloat32(76, 3003.0, true); // -> 30.05 deg
    dv.setFloat32(80, 10, true); // knots
    dv.setFloat32(84, 90, true); // course
    return bytes;
}

// 8 MB file: [ftyp][mdat to EOF], no moov (so no `gps ` table - the
// table-less clone case the escalation exists for), freeGPS blocks at
// 5 MB and 6.5 MB. Two blocks within the escalated window classify "mid"
// (jump-scan-able); a single one would classify "heavy".
function buildSparseNovatekFile(name: string): SparseTrackingFile {
    const fileSize = 8 * MB;
    const header = new Uint8Array(32);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 16);
    header.set(new TextEncoder().encode("ftyp"), 4);
    hv.setUint32(16, fileSize - 16);
    header.set(new TextEncoder().encode("mdat"), 20);
    const block = buildDefaultFreeGpsBlock();
    return new SparseTrackingFile(name, fileSize, [
        { offset: 0, data: header },
        { offset: 5 * MB, data: block },
        { offset: 5 * MB + 1.5 * MB, data: block },
    ]);
}

function classifiedVideo(file: SparseTrackingFile): ClassifiedFile {
    return {
        file: { file: file as unknown as File, relativePath: file.name },
        role: "video",
        sidecarId: null,
        sidecarMp4: null,
        logExtractorId: null,
    };
}

describe("dispatchParseVideoEmbeddedGps: Novatek probe escalation", () => {
    it("Novatek name + first block past 4 MB: escalated probe recovers records", async () => {
        const file = buildSparseNovatekFile("2024_0601_120000_005F.MP4"); // RX_NOVATEK_VIOFO
        const result = await dispatchParseVideoEmbeddedGps([classifiedVideo(file)], undefined, 4, undefined, "all");
        expect(result.appliedExtractors).toContain("freegps");
        expect(result.records).toHaveLength(2);
        const r = result.records[0]!;
        expect(r.lat).toBeCloseTo(50.1, 4);
        expect(r.lon).toBeCloseTo(30.05, 4);
        expect(r.unixSeconds).toBe(Date.UTC(2021, 5, 15, 10, 20, 30) / 1000);
    });

    it("post-escalation kind is 'mid' (two seeds): not deferred under light-only", async () => {
        const file = buildSparseNovatekFile("2024_0601_120000_005F.MP4");
        const result = await dispatchParseVideoEmbeddedGps(
            [classifiedVideo(file)],
            undefined,
            4,
            undefined,
            "light-only",
        );
        // "heavy" would land in heavyFiles with zero records; "mid" parses inline.
        expect(result.heavyFiles).toHaveLength(0);
        expect(result.records).toHaveLength(2);
    });

    it("non-Novatek name with the same bytes stays 'none': no escalation, no records", async () => {
        const file = buildSparseNovatekFile("random_clip.mp4");
        const result = await dispatchParseVideoEmbeddedGps([classifiedVideo(file)], undefined, 4, undefined, "all");
        expect(result.records).toHaveLength(0);
        expect(result.appliedExtractors).toHaveLength(0);
        // Gate respected: only the default 4 MB probe ran (plus 16-byte box
        // headers), never the 16 MB escalation read.
        expect(file.readBytesTotal).toBeLessThan(5 * MB);
    });
});

// ===== Structural GPS skips the marker probe =====
//
// When the moov already carries an EXCLUSIVE structural GPS signal (here: a
// top-level `GPS ` box, the older 70mai Pro / gps-box-70mai format), tryParseOne
// must NOT read the 4 MB freeGPS/LigoGPS marker probe - the GPS lives in the box
// the extractor reads directly. This guards against a regression that
// re-introduces the unconditional probe (pure wasted IO, dominant cost on
// mobile SD). The fixture is a sparse 8 MB file whose `GPS ` box sits in the
// first few hundred bytes; a probe would push readBytesTotal past 4 MB.

// Builds a top-level `GPS ` box (8-byte header + N x 36-byte records) in the
// gps-box-70mai geometry. Mirrors the gpsBox builder in internal/gps-box-70mai.test.ts.
function buildMaiGpsBox(count: number): Uint8Array {
    const packDeg = (d: number): number => {
        const deg = Math.floor(d);
        return deg * 100_000 + Math.round((d - deg) * 60 * 1000);
    };
    const body = new Uint8Array(count * 36);
    const dv = new DataView(body.buffer);
    for (let i = 0; i < count; i++) {
        const o = i * 36;
        dv.setUint32(o, 1, true);
        dv.setUint32(o + 4, 1, true); // hasGps
        dv.setUint32(o + 8, i, true); // seconds
        dv.setUint32(o + 12, 100_000, true); // speed m/h
        dv.setUint8(o + 16, "N".charCodeAt(0));
        dv.setUint32(o + 17, packDeg(50 + i * 0.01), true);
        dv.setUint8(o + 21, "E".charCodeAt(0));
        dv.setUint32(o + 22, packDeg(30 + i * 0.01), true);
    }
    const box = new Uint8Array(8 + body.byteLength);
    new DataView(box.buffer).setUint32(0, box.byteLength, false);
    box.set([0x47, 0x50, 0x53, 0x20], 4); // "GPS "
    box.set(body, 8);
    return box;
}

// 8 MB file: [ftyp][`GPS ` box][mdat to EOF]. The `GPS ` box gives a structural
// signal (maiGpsBox) so the dispatcher classifies "light" without probing.
function buildSparseGpsBoxFile(name: string): SparseTrackingFile {
    const fileSize = 8 * MB;
    const ftyp = new Uint8Array(16);
    const fv = new DataView(ftyp.buffer);
    fv.setUint32(0, 16);
    ftyp.set(new TextEncoder().encode("ftyp"), 4);
    const gpsBox = buildMaiGpsBox(3);
    const mdatOffset = 16 + gpsBox.byteLength;
    const mdatHeader = new Uint8Array(8);
    const mv = new DataView(mdatHeader.buffer);
    mv.setUint32(0, fileSize - mdatOffset);
    mdatHeader.set(new TextEncoder().encode("mdat"), 4);
    return new SparseTrackingFile(name, fileSize, [
        { offset: 0, data: ftyp },
        { offset: 16, data: gpsBox },
        { offset: mdatOffset, data: mdatHeader },
    ]);
}

describe("dispatchParseVideoEmbeddedGps: structural GPS skips the marker probe", () => {
    it("a top-level `GPS ` box is parsed without reading the 4 MB probe window", async () => {
        const file = buildSparseGpsBoxFile("NO20191130-120156-000121.MP4");
        const result = await dispatchParseVideoEmbeddedGps([classifiedVideo(file)], undefined, 4, undefined, "all");
        // Extraction succeeds from the structural box.
        expect(result.appliedExtractors).toContain("gps-box-70mai");
        expect(result.records).toHaveLength(3);
        expect(result.records[0]!.lat).toBeCloseTo(50.0, 4);
        // The probe was skipped: only top-level box headers (~48 B) + the small
        // `GPS ` box payload were read, nowhere near the 4 MB probe window.
        expect(file.readBytesTotal).toBeLessThan(64 * 1024);
    });
});

// ===== No-winner probe retry (P4) =====
//
// embeddedGpsProbeNeeded skips the 4 MB freeGPS/LigoGPS marker probe as soon as
// ANY track looks structural (sbtl/text handler, gpmd sample format, ...),
// assuming that track exclusively owns the file's GPS. But a file can pair such
// a track with probe-dependent GPS: a table-less streaming freeGPS clip whose
// firmware ALSO muxes a speed-overlay subtitle track. Without the retry the
// marker is never read, freegps.marker (keyed on hasFreeGpsMarker) returns
// false, no extractor claims the file, and it yields zero GPS with no error and
// no skip trace. tryParseOne must probe once and re-walk when the walk ends with
// no winner AND the probe was skipped.

// Wraps a payload in an ISOBMFF box (32-bit size + 4CC type).
function isoBox(type: string, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + payload.length);
    new DataView(out.buffer).setUint32(0, out.length, false);
    out.set(new TextEncoder().encode(type), 4);
    out.set(payload, 8);
    return out;
}

// Minimal moov carrying one trak whose mdia/hdlr handler_type is 'sbtl'. That
// single structural signal makes embeddedGpsProbeNeeded return false (probe
// skipped) and classifyEmbeddedGpsKind return "light" - the gate-desync setup.
// The trak has no sample table, so the sbtl-keyed extractors (pndm/nmea/
// nextbase) read no first sample and their markers reject it.
function buildSbtlMoov(): Uint8Array {
    const hdlrPayload = new Uint8Array(32); // version+flags(4) + pre_defined(4) + handler_type(4) + name
    hdlrPayload.set(new TextEncoder().encode("sbtl"), 8); // handler_type at payload offset 8
    return isoBox("moov", isoBox("trak", isoBox("mdia", isoBox("hdlr", hdlrPayload))));
}

// 8 MB sparse file: [ftyp][moov{sbtl trak}][mdat to EOF]. No moov `gps ` atom.
// withMarker places a default-geometry freeGPS block at the head of mdat (well
// inside the 4 MB probe window) - the probe-dependent GPS the sbtl track hides.
function buildSparseSbtlFreeGpsFile(name: string, withMarker: boolean): SparseTrackingFile {
    const fileSize = 8 * MB;
    const ftyp = new Uint8Array(16);
    const fv = new DataView(ftyp.buffer);
    fv.setUint32(0, 16);
    ftyp.set(new TextEncoder().encode("ftyp"), 4);
    const moov = buildSbtlMoov();
    const mdatOffset = 16 + moov.byteLength;
    const mdatHeader = new Uint8Array(8);
    const mv = new DataView(mdatHeader.buffer);
    mv.setUint32(0, fileSize - mdatOffset);
    mdatHeader.set(new TextEncoder().encode("mdat"), 4);
    const regions = [
        { offset: 0, data: ftyp },
        { offset: 16, data: moov },
        { offset: mdatOffset, data: mdatHeader },
    ];
    if (withMarker) {
        regions.push({ offset: mdatOffset + 8, data: buildDefaultFreeGpsBlock() });
    }
    return new SparseTrackingFile(name, fileSize, regions);
}

describe("dispatchParseVideoEmbeddedGps: no-winner probe retry", () => {
    it("recovers streaming freeGPS from a file whose sbtl track skipped the probe", async () => {
        // Non-70mai name so the generic `freegps` primitive (not freegps-70mai)
        // is the one that must win, purely off the retried hasFreeGpsMarker.
        const file = buildSparseSbtlFreeGpsFile("some_clip_0001.mp4", true);
        const result = await dispatchParseVideoEmbeddedGps([classifiedVideo(file)], undefined, 4, undefined, "all");
        // Without the retry the walk finds no winner and yields zero records.
        expect(result.appliedExtractors).toContain("freegps");
        expect(result.records.length).toBeGreaterThan(0);
        expect(result.records[0]!.lat).toBeCloseTo(50.1, 4);
        expect(result.records[0]!.lon).toBeCloseTo(30.05, 4);
    });

    it("retry reads the probe exactly once and stays silent when no marker exists", async () => {
        const file = buildSparseSbtlFreeGpsFile("some_clip_0002.mp4", false);
        const result = await dispatchParseVideoEmbeddedGps([classifiedVideo(file)], undefined, 4, undefined, "all");
        // No freeGPS bytes: the retry probe finds nothing, no winner, no error.
        expect(result.records).toHaveLength(0);
        expect(result.errors).toHaveLength(0);
        // >= 4 MB proves the retry probe fired at all (pre-fix the probe was
        // skipped outright, so this stays a few hundred bytes); < 5 MB proves it
        // read the 4 MB default window exactly once, never a second time.
        expect(file.readBytesTotal).toBeGreaterThanOrEqual(4 * MB);
        expect(file.readBytesTotal).toBeLessThan(5 * MB);
    });

    it("a structural file the walk already claims does not trigger a redundant probe", async () => {
        // The existing `GPS ` box file wins on the first walk (gps-box-70mai),
        // so the retry must NOT run - readBytesTotal stays tiny, guarding
        // against a retry that fires even when a winner was found.
        const file = buildSparseGpsBoxFile("NO20191130-120156-000121.MP4");
        const result = await dispatchParseVideoEmbeddedGps([classifiedVideo(file)], undefined, 4, undefined, "all");
        expect(result.appliedExtractors).toContain("gps-box-70mai");
        expect(file.readBytesTotal).toBeLessThan(64 * 1024);
    });
});

describe("dispatchParseVideoEmbeddedGps: quality-gated parse is a positive claim", () => {
    it("phantom-gated sstar-ssmd file wins with zero records but keeps hint and diagnostics", async () => {
        // The real-anonymized Neoline fixture is the phantom-track sample:
        // every fix is dropped by the quality gate, yet the file must NOT
        // fall through to "no GPS found" - the extractor claims it, the
        // frame-0 clock hint anchors the video, and the skip diagnostics
        // explain where the GPS went.
        const bytes = readFileSync(
            resolve(
                dirname(fileURLToPath(import.meta.url)),
                "../../tests/testdata/sstar-ssmd-real-anonymized/neoline-spectrum-front.mp4",
            ),
        );
        const name = "INF20260520-214526-1-F.mp4";
        const video: ClassifiedFile = {
            file: { file: new File([new Uint8Array(bytes)], name), relativePath: name },
            role: "video",
            sidecarId: null,
            sidecarMp4: null,
            logExtractorId: null,
        };
        const result = await dispatchParseVideoEmbeddedGps([video], undefined, 4, undefined, "all");
        const key = vendorFileKey(video.file);
        expect(result.records).toHaveLength(0);
        expect(result.winningExtractorByFileKey.get(key)).toBe("sstar-ssmd");
        expect(result.videoStartUtcHintByFileKey.get(key)).toBe(Date.UTC(2026, 4, 20, 18, 45, 27) / 1000);
        expect(result.skipped.length).toBeGreaterThan(0);
        for (const s of result.skipped) expect(s.reason).toContain("phantom-track quality gate");
    });
});

// ===== mergeAccelSamples: windowed max-|G| pick (G1) =====
//
// A dense IMU (BlackVue .3gf ~10 Hz) over 1 Hz GPS: an impact lasts ~100-300 ms
// and rarely peaks on a GPS second. The old nearest-sample pick attached the
// low shoulder value at the GPS second and dropped the peak; the windowed pick
// scans +-0.5 s and keeps the strongest sample (gravity offset removed first).

describe("mergeAccelSamples: windowed max-|G| over 1 Hz GPS", () => {
    function gpsRec(unixSeconds: number): GpsRecord {
        return {
            unixSeconds,
            active: true,
            lat: 50,
            lon: 30,
            bearingDeg: 0,
            speedMs: 11,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: "a.mp4",
        };
    }

    it("attaches the mid-second impact peak, not the nearest low sample", () => {
        const startUtc = 1000;
        const records = [gpsRec(1000), gpsRec(1001), gpsRec(1002)];
        // 10 Hz accel, flat except one spike at 400 ms (unix 1000.4) - falls
        // between GPS seconds 1000 and 1001, so nearest-sample would miss it.
        const samples: AccelSample[] = [];
        for (let ms = 0; ms <= 2000; ms += 100) {
            samples.push({ msSinceStart: ms, accelXg: ms === 400 ? 2 : 0, accelYg: 0, accelZg: 0 });
        }
        const mutated = mergeAccelSamples(records, new Map([["a.mp4", samples]]), new Map([["a.mp4", startUtc]]));
        expect(mutated).toBe(3);
        const offsetX = 2 / samples.length; // per-file gravity/bias removal
        // GPS record at 1000 s picks the 1000.4 s spike within its +-0.5 s window.
        expect(records[0]!.accelXg).toBeCloseTo(2 - offsetX, 6);
        // The neighbor at 1001 s is outside the spike window - only a shoulder.
        expect(records[1]!.accelXg).toBeCloseTo(-offsetX, 6);
        expect(Math.abs(records[1]!.accelXg)).toBeLessThan(0.5);
        // The recovered peak clears the default 0.5 g brake threshold.
        expect(detectEvents(records, startUtc).some((e) => e.kind === "brake")).toBe(true);
    });

    it("leaves a record untouched when no sample falls within +-0.5 s", () => {
        const records = [gpsRec(5000)]; // far from any sample
        const samples: AccelSample[] = [{ msSinceStart: 0, accelXg: 0.3, accelYg: 0, accelZg: 0 }];
        const mutated = mergeAccelSamples(records, new Map([["a.mp4", samples]]), new Map([["a.mp4", 1000]]));
        expect(mutated).toBe(0);
        expect(records[0]!.accelXg).toBe(0);
    });

    it("retains the later nearest sample when equal peaks straddle a GPS row", () => {
        const records = [gpsRec(1000)];
        const samples: AccelSample[] = [
            { msSinceStart: 500, accelXg: 1, accelYg: 0, accelZg: 0 },
            { msSinceStart: -500, accelXg: -1, accelYg: 0, accelZg: 0 },
        ];
        mergeAccelSamples(records, new Map([["a.mp4", samples]]), new Map([["a.mp4", 1000]]));
        expect(records[0]!.accelXg).toBe(1);
        expect(samples.map((sample) => sample.msSinceStart)).toEqual([500, -500]);
    });

    it("preserves source order when absolute timestamps round to the same instant", () => {
        const startUtc = 1_700_000_000;
        const records = [gpsRec(startUtc)];
        const samples: AccelSample[] = [
            { msSinceStart: 0.00001, accelXg: 1, accelYg: 0, accelZg: 0 },
            { msSinceStart: 0, accelXg: -1, accelYg: 0, accelZg: 0 },
        ];
        mergeAccelSamples(records, new Map([["a.mp4", samples]]), new Map([["a.mp4", startUtc]]));
        expect(records[0]!.accelXg).toBe(1);
    });

    it("preserves every real IMU window peak across dense and unordered GPS rows", () => {
        const bytes = readFileSync(resolve(BLACKVUE_FIXTURES, "real-anonymized.3gf"));
        const samples = parse3gfBuffer(Uint8Array.from(bytes).buffer).reverse();
        const original = structuredClone(samples);
        const startUtc = 1_700_000_000;
        const firstMs = Math.min(...samples.map((sample) => sample.msSinceStart));
        const lastMs = Math.max(...samples.map((sample) => sample.msSinceStart));
        const records: GpsRecord[] = [];
        for (let ms = firstMs; ms <= lastMs; ms += 200) records.push(gpsRec(startUtc + ms / 1000));
        records.reverse();
        const offsets = samples.reduce(
            (sum, sample) => ({
                x: sum.x + sample.accelXg / samples.length,
                y: sum.y + sample.accelYg / samples.length,
                z: sum.z + sample.accelZg / samples.length,
            }),
            { x: 0, y: 0, z: 0 },
        );
        expect(samples.length).toBeGreaterThan(10);
        expect(mergeAccelSamples(records, new Map([["a.mp4", samples]]), new Map([["a.mp4", startUtc]]))).toBe(
            records.length,
        );
        for (const record of records) {
            const window = samples.filter(
                (sample) => Math.abs(startUtc + sample.msSinceStart / 1000 - record.unixSeconds) <= 0.5,
            );
            const maximum = Math.max(
                ...window.map((sample) =>
                    Math.hypot(sample.accelXg - offsets.x, sample.accelYg - offsets.y, sample.accelZg - offsets.z),
                ),
            );
            expect(Math.hypot(record.accelXg, record.accelYg, record.accelZg), String(record.unixSeconds)).toBeCloseTo(
                maximum,
                12,
            );
        }
        expect(samples).toEqual(original);
    });
});

// ===== Embedded accel reaches the dispatched result =====
//
// Both ends of the embedded-accel path are covered elsewhere - the producer
// (ParsedRecords.accelSamples, __fixtures__/blackvue/real-anonymized.test.ts)
// and the consumer (mergeAccelSamples, above). The segment between them is the
// dispatcher's accelByFileKey map, and without a test here the whole feature
// can be deleted with every suite still green. Carrier: the BlackVue X-series
// container (`gps ` + `3gf ` inside the top-level free box) built around the
// real anonymized sidecar payloads.

const BLACKVUE_FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__/blackvue");

function buildEmbeddedBlackVueFile(name: string, with3gf: boolean): File {
    const children = [isoBox("gps ", new Uint8Array(readFileSync(resolve(BLACKVUE_FIXTURES, "real-anonymized.gps"))))];
    if (with3gf) {
        children.push(isoBox("3gf ", new Uint8Array(readFileSync(resolve(BLACKVUE_FIXTURES, "real-anonymized.3gf")))));
    }
    const freePayload = new Uint8Array(children.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const child of children) {
        freePayload.set(child, at);
        at += child.length;
    }
    const parts = [
        isoBox("ftyp", new TextEncoder().encode("isomisom")),
        isoBox("free", freePayload),
        isoBox("moov", new Uint8Array(0)),
    ];
    return new File(parts as BlobPart[], name);
}

function classifiedRealFile(file: File, sourceKey?: string, relativePath = file.name): ClassifiedFile {
    return {
        file: { file, relativePath, sourceKey },
        role: "video",
        sidecarId: null,
        sidecarMp4: null,
        logExtractorId: null,
    };
}

describe("dispatchParseVideoEmbeddedGps: embedded accel lands in accelByFileKey", () => {
    const NAME = "20260718_070333_XF.mp4";

    it("keys the winning extractor's accel stream by MP4 name, ready for the merge", async () => {
        const file = buildEmbeddedBlackVueFile(NAME, true);
        const classified = classifiedRealFile(file);
        const result = await dispatchParseVideoEmbeddedGps([classified], undefined, 4, undefined, "all");
        expect(result.appliedExtractors).toContain("free-gps-box");
        expect(result.records.length).toBeGreaterThan(0);

        const key = vendorFileKey(classified.file);
        const accel = result.accelByFileKey.get(key);
        expect(accel).toBeDefined();
        // The same 50 samples the extractor returns, unscaled on the way through
        // (gravity-included here - the merge removes the per-file bias).
        expect(accel).toHaveLength(50);
        const meanZ = accel!.reduce((sum, s) => sum + s.accelZg, 0) / accel!.length;
        expect(meanZ).toBeGreaterThan(0.8);

        // The map and GPS rows share the concrete video key, so the two halves
        // meet without falling back to a collision-prone basename.
        const startUtc = result.records[0]!.unixSeconds;
        const mutated = mergeAccelSamples(result.records, result.accelByFileKey, new Map([[key, startUtc]]));
        expect(mutated).toBeGreaterThan(0);
    });

    it("stays empty when the winning extractor carries no accel", async () => {
        const file = buildEmbeddedBlackVueFile("20260718_070334_XF.mp4", false);
        const result = await dispatchParseVideoEmbeddedGps([classifiedRealFile(file)], undefined, 4, undefined, "all");
        expect(result.records.length).toBeGreaterThan(0);
        expect(result.accelByFileKey.size).toBe(0);
    });

    it("keeps equal paths from separate sources independently addressable", async () => {
        const a = classifiedRealFile(buildEmbeddedBlackVueFile(NAME, true), "card-a", `BlackVue/Record/${NAME}`);
        const b = classifiedRealFile(buildEmbeddedBlackVueFile(NAME, true), "card-b", `BlackVue/Record/${NAME}`);

        const result = await dispatchParseVideoEmbeddedGps([a, b], undefined, 2, undefined, "all");
        const aKey = vendorFileKey(a.file);
        const bKey = vendorFileKey(b.file);

        expect(aKey).not.toBe(bKey);
        expect(result.winningExtractorByFileKey.get(aKey)).toBe("free-gps-box");
        expect(result.winningExtractorByFileKey.get(bKey)).toBe("free-gps-box");
        expect(result.records.filter((record) => record.videoKey === aKey)).not.toHaveLength(0);
        expect(result.records.filter((record) => record.videoKey === bKey)).not.toHaveLength(0);
    });
});

// ===== combineAccelSources: sidecar precedence =====
//
// The one merge point of the two accel origins (basename-paired sidecar file,
// video container). Called by the progressive ingest pipeline; the precedence
// rule is a decision, not an accident, so it is pinned here.

describe("combineAccelSources", () => {
    const stream = (accelXg: number): AccelSample[] => [{ msSinceStart: 0, accelXg, accelYg: 0, accelZg: 0 }];

    it("gives the sidecar the file both sources claim, and keeps the embedded-only ones", () => {
        const sidecar = new Map([["a.mp4", stream(1)]]);
        const embedded = new Map([
            ["a.mp4", stream(2)],
            ["b.mp4", stream(3)],
        ]);
        const combined = combineAccelSources(sidecar, embedded);
        expect(combined.get("a.mp4")).toBe(sidecar.get("a.mp4"));
        expect(combined.get("b.mp4")).toBe(embedded.get("b.mp4"));
        // Written into a fresh map: the caller's embedded map keeps its own
        // entry for the contested file.
        expect(embedded.get("a.mp4")![0]!.accelXg).toBe(2);
    });

    it("passes the sidecar map through when no file carried embedded accel", () => {
        const sidecar = new Map([["a.mp4", stream(1)]]);
        expect([...combineAccelSources(sidecar, new Map())]).toEqual([...sidecar]);
    });

    it("passes the embedded map through when the drop has no accel sidecar", () => {
        const embedded = new Map([["a.mp4", stream(1)]]);
        expect([...combineAccelSources(new Map(), embedded)]).toEqual([...embedded]);
    });

    it("yields an empty map when neither source produced anything", () => {
        expect(combineAccelSources(new Map(), new Map()).size).toBe(0);
    });
});

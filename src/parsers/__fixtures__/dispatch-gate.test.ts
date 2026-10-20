// Dispatch-level regression gate for the embedded-GPS primitives.
//
// The per-fixture synthetic.test.ts files call primitive.marker/.parse
// directly - that proves the parser decodes bytes, but it BYPASSES the real
// ingest gate (classifyEmbeddedGpsKind in registry.ts), which short-circuits
// `kind === "none"` BEFORE the primitive loop. A primitive whose Mp4Index
// marker field is not also wired into classifyEmbeddedGpsKind is dead in
// production while its isolated test stays green (this is exactly how the
// gps-box-70mai `maiGpsBox` gap shipped once).
//
// This suite drives each committed fixture through the SAME entry point the
// ingest worker uses (dispatchParseVideoEmbeddedGps) and asserts records come
// out, so any future primitive that forgets the kind-gate wiring fails here.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type ClassifiedFile, dispatchParseVideoEmbeddedGps } from "../registry.js";
import { buildMp4Index, DEFAULT_PROBE_BYTES, probeMarkers } from "../internal/mp4-index.js";
import { juscarTsPrimitive } from "../primitives/juscar-ts.js";
import { ligoGpsTrailerTsPrimitive } from "../primitives/ligogps-trailer-ts.js";
import { vendorFileKey } from "../../vendor-file-key.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function videoFile(relPath: string, name: string): ClassifiedFile {
    const buf = readFileSync(resolve(HERE, relPath));
    const file = new File([buf], name);
    return {
        file: { file, relativePath: name },
        role: "video",
        sidecarId: null,
        sidecarMp4: null,
        logExtractorId: null,
    };
}

// Each entry: the fixture that the per-format synthetic.test covers in
// isolation, plus the extractor that MUST win through the real dispatch gate.
const CASES = [
    {
        label: "70mai Pro GPS box -> gps-box-70mai",
        rel: "70mai-gps-box/synthetic-mai-pro.mp4",
        name: "NO20191130-120156-000121.MP4",
        extractor: "gps-box-70mai",
    },
    {
        label: "70mai 4K embedded freeGPS -> freegps-70mai",
        rel: "70mai-embedded/synthetic-70mai.mp4",
        name: "NO20240702-094820-000029F.MP4",
        extractor: "freegps-70mai",
    },
    {
        label: "iBox iCON gps0 -> navitel-tail",
        rel: "ibox/synthetic-ibox.MOV",
        name: "FILE230422-154515F.MOV",
        extractor: "navitel-tail",
    },
    {
        // The .TS spelling of the same gps0 tail: a plain ISO-BMFF file under
        // a .TS extension (2-channel motorcycle cam) - the kind-gate must key
        // off the box walk, not the extension.
        label: "Navitel gps0 tail in an ISO-BMFF .TS -> navitel-tail",
        rel: "navitel/real-anonymized.TS",
        name: "FILE260817-180301-000004F.TS",
        extractor: "navitel-tail",
    },
    {
        label: "Thinkware F200 PRO subtitle -> nmea-subtitle",
        rel: "thinkware/real-anonymized.mp4",
        name: "REC_2026_06_01_21_16_47_F.MP4",
        extractor: "nmea-subtitle",
    },
    {
        label: "Wolfbox gpmd struct (ExifTool block2) -> wolfbox-gpmd",
        rel: "wolfbox/synthetic-wolfbox-b.mp4",
        name: "2026_03_15_173951_00_F.MP4",
        extractor: "wolfbox-gpmd",
    },
    {
        label: "Wolfbox gpmd struct (ShenShu block1) -> wolfbox-gpmd",
        rel: "wolfbox/synthetic-wolfbox-a.mp4",
        name: "2026_03_15_173951_02_I.MP4",
        extractor: "wolfbox-gpmd",
    },
    {
        // The trailer sits past the last top-level box, invisible to every
        // sync marker - the file must classify "light" through the junk-tail
        // branch (the kenwood fallback) and the 64 KB trailer probe must win.
        label: "Beferich LigoGPS trailer -> ligogps-trailer",
        rel: "ligogps-trailer/real-anonymized.mp4",
        name: "2026-08-03_11_34_53_f.mp4",
        extractor: "ligogps-trailer",
    },
    {
        // MPEG-TS has no moov, so the kind-gate must key off hasLigoGpsMarker
        // (headerBytes), not a moov atom. Also covers the container class the
        // ingest queue regressed on (TS got no embedded GPS at all).
        label: "Juscar MPEG-TS LigoGPS plaintext -> juscar-ts",
        rel: "juscar/real-anonymized.TS",
        name: "20260429_182640F.ts",
        extractor: "juscar-ts",
    },
    {
        // Same literal and container as Juscar, so the gate is the same; the
        // enciphered dialect must win before juscar-ts scans the whole file.
        label: "enciphered fuzzed LigoGPS PES in MPEG-TS -> ligogps-ts-pes",
        rel: "ligogps-ts-pes/real-anonymized.TS",
        name: "2026_10_18_130426_00.TS",
        extractor: "ligogps-ts-pes",
    },
    {
        // Third no-moov variant: the GPS table sits PAST the last whole TS
        // packet, so the kind-gate keys off index.tsGpsTrailer - nothing in
        // headerBytes or the box walk can see it.
        label: "LigoGPS trailer at EOF of a MPEG-TS -> ligogps-trailer-ts",
        rel: "ligogps-trailer-ts/real-anonymized.TS",
        name: "20260813211138_0000002F.ts",
        extractor: "ligogps-trailer-ts",
    },
    {
        // The classic LIGO spelling can pair with `&&&&` instead of `####`;
        // that terminator must reach the same index field and primitive.
        label: "LigoGPS ampersand trailer at EOF of a MPEG-TS -> ligogps-trailer-ts",
        rel: "ligogps-trailer-ts/real-anonymized-ampersand.TS",
        name: "2026081822373512_f.ts",
        extractor: "ligogps-trailer-ts",
    },
    {
        label: "paired LigoGPS tables before preallocation -> ligogps-trailer-ts",
        rel: "ligogps-trailer-ts/real-anonymized-paired.TS",
        name: "20261008_095348_f.ts",
        extractor: "ligogps-trailer-ts",
    },
    {
        // Same no-moov container class: the kind-gate keys off the
        // findNovatekTsGpsPid headerBytes scan.
        label: "Novatek GPS struct in MPEG-TS private PES -> novatek-ts",
        rel: "novatek-ts/real-anonymized.TS",
        name: "20210318153933_000188.TS",
        extractor: "novatek-ts",
    },
    {
        // ssmd meta track classifies "light" via the meta-handler branch; the
        // 40-byte stsz gate must pick sstar-ssmd, not rove-ssmd/ligogps.
        // The name must carry the fixture's baked-in day-of-month (15): the
        // extractor anchors year/month to the filename date and drops rows
        // whose day byte disagrees by more than a rollover.
        label: "SigmaStar 40-byte ssmd GPS track -> sstar-ssmd",
        rel: "sstar-ssmd/synthetic-happy.mp4",
        name: "INF20260315-203950-7-F.mp4",
        extractor: "sstar-ssmd",
    },
    {
        // tvxt handler is none of sbtl/text/meta - it needs its own kind-gate
        // branch, exactly the maiGpsBox gap class this suite exists for.
        label: "Vueroid tvxt/mp4s 72-byte track -> vueroid-txet",
        rel: "vueroid-txet/synthetic-happy.mp4",
        name: "20251111_085423_INF_F_N.mp4",
        extractor: "vueroid-txet",
    },
] as const;

describe("embedded GPS dispatch gate (classifyEmbeddedGpsKind wiring)", () => {
    for (const c of CASES) {
        it(`${c.label}: real dispatch yields records (not dead code)`, async () => {
            const result = await dispatchParseVideoEmbeddedGps([videoFile(c.rel, c.name)]);
            // The gate-gap regression manifests precisely as zero records here
            // while the isolated primitive test still passes.
            expect(result.records.length).toBeGreaterThan(0);
            expect(result.appliedExtractors).toContain(c.extractor);
        });
    }

    it("records the parsed source for cloneAcrossGroup followers", async () => {
        const front = videoFile("juscar/real-anonymized.TS", "20260429_182640F.ts");
        const rear = videoFile("juscar/real-anonymized.TS", "20260429_182640R.ts");
        const frontKey = vendorFileKey(front.file);
        const rearKey = vendorFileKey(rear.file);

        const result = await dispatchParseVideoEmbeddedGps([front, rear], undefined, 1);

        expect(result.sourceFileKeyByFileKey.get(frontKey)).toBe(frontKey);
        expect(result.sourceFileKeyByFileKey.get(rearKey)).toBe(frontKey);
        expect(result.records.some((record) => record.videoKey === rearKey)).toBe(true);
    });
});

// ===== Synthetic in-memory cases (no committed fixture file exists) =====
//
// The udta-pack formats (kenwood, ligo-json) and the Garmin moov/uuid format
// have no committed byte fixtures - their per-primitive tests build files in
// memory. The same builders drive the REAL dispatch here, because all three
// shipped with exactly the maiGpsBox-class gap this suite exists for: marker
// and parse worked in isolation while classifyEmbeddedGpsKind returned
// "none" and the primitives were dead in production.

const ascii = (text: string): Uint8Array => Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);

function mp4Box(type: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(8 + payload.length);
    new DataView(out.buffer).setUint32(0, out.length, false);
    out.set(ascii(type), 4);
    out.set(payload, 8);
    return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
    }
    return out;
}

const FTYP = mp4Box("ftyp", ascii("mp42\0\0\0\0mp42isom"));

function syntheticVideo(bytes: Uint8Array<ArrayBuffer>, name: string): ClassifiedFile {
    return {
        file: { file: new File([bytes], name), relativePath: name },
        role: "video",
        sidecarId: null,
        sidecarMp4: null,
        logExtractorId: null,
    };
}

// Kenwood udta record, verbatim from the public ExifTool hexdump - not a real
// capture (provenance in the internal/kenwood.test.ts header).
const KENWOOD_UDTA_PAYLOAD = `VIDEO${"U".repeat(22)}\xfe\xfe20230107111914.20230107111915\x03N47377053W122099014+0058000+006+009+004`;
// Kenwood CCCC trailer: C-run + one fixed-width GPSDATA-- record.
const KENWOOD_TRAILER =
    "C".repeat(14) +
    "GPSDATA--20240711120412N50.6123860677E8.7027180989533.000000000000.0000000000000.019999999553-0.09000000357-0.14000000059";
// LigoJSON record blob (512-byte chained form).
const LIGO_JSON_BLOB = `LIGOGPSINFO ${JSON.stringify({
    Hour: "23",
    Minute: "10",
    Second: "22",
    Year: "2023",
    Month: "12",
    Day: "28",
    status: "A",
    NS: "N",
    EW: "E",
    Latitude: "37.123456",
    Longitude: "122.654321",
    Speed: "10.5",
})}`.padEnd(512, "\0");

function gkuUdtaPayload(jsonStart: number): Uint8Array {
    const payload = new Uint8Array(jsonStart + 600);
    new DataView(payload.buffer).setUint32(0, jsonStart, true);
    payload.set(ascii("__V35AX_QVDATA__"), 8);
    payload.set(ascii(LIGO_JSON_BLOB), jsonStart);
    return payload;
}

// Denver bracketed record, verbatim from the ExifTool source comment
// (QuickTimeStream.pl:3116-3118) - not a real capture. NUL-padded, as the atom
// is padded to its box size.
const DENVER_UDAT_PAYLOAD = `210318073213[1][N][52200970][E][006362321][+00152][100][00140][C000000]${"+000".repeat(18)}\n`.padEnd(
    256,
    "\0",
);
const NMEA_UDAT_PAYLOAD =
    "$GPRMC,062502.00,A,4137.12345,N,00204.54321,E,10.0,90.0,190419,,,A*4E\n".padEnd(256, "\0");
// The same log opening with a sentence the parser does not decode - upstream
// reads RMC and GGA in any order, and the head-window gate must not turn "the
// firmware wrote GGA first" into a file dropped with zero diagnostics.
const GGA_FIRST_UDAT_PAYLOAD = (
    "$GPGGA,062502.00,4137.12345,N,00204.54321,E,1,08,0.9,545.4,M,46.9,M,,*47\n" +
    "$GPRMC,062502.00,A,4137.12345,N,00204.54321,E,10.0,90.0,190419,,,A*4E\n"
).padEnd(512, "\0");

// Nextbase gdat: the whole atom is Base64 of one JSON object. Key spellings are
// verbatim from Process_gdat; the values are ours (no public dump exists).
const GDAT_TRACK = {
    cameraModel: "622GW",
    gpsData: [
        {
            datetime: "2023-12-28T23:10:22",
            lat: 52.33495,
            lon: 6.6038683,
            speed: 30,
            bearing: 140,
            gpsStatus: "A",
        },
    ],
};
// `indent` gives the pretty-printed form desktop software may export - its
// Base64 opens "ew" instead of "ey", which the head gate has to accept.
const gdatPayload = (indent?: number): Uint8Array =>
    Uint8Array.from(btoa(JSON.stringify(GDAT_TRACK, null, indent)), (ch) => ch.charCodeAt(0));

// Garmin moov/uuid: usertype + 17 unknown header bytes + one 20-byte record.
function garminMoov(): Uint8Array<ArrayBuffer> {
    const GARMIN_GPS_UUID = [
        0x9b, 0x63, 0x0f, 0x8d, 0x63, 0x74, 0x40, 0xec, 0x82, 0x04, 0xbc, 0x5f, 0xf5, 0x09, 0x17, 0x28,
    ];
    const record = new Uint8Array(20);
    const dv = new DataView(record.buffer);
    dv.setUint32(0, Date.UTC(2021, 5, 15, 12, 0, 0) / 1000 + 2082844800);
    dv.setUint16(4, 50); // mph
    dv.setInt32(12, 0x20000000); // 45 deg
    dv.setInt32(16, 0x20000000);
    const uuid = mp4Box("uuid", concatBytes([Uint8Array.from(GARMIN_GPS_UUID), new Uint8Array(17), record]));
    return mp4Box("moov", uuid);
}

const SYNTHETIC_CASES = [
    {
        label: "Kenwood top-level udta VIDEOUUU -> kenwood",
        bytes: () => concatBytes([FTYP, mp4Box("mdat", new Uint8Array(64)), mp4Box("udta", ascii(KENWOOD_UDTA_PAYLOAD))]),
        name: "kenwood-udta.mp4",
        extractor: "kenwood",
    },
    {
        // The trailer carrier is not sync-detectable by content (needs a file
        // read), so the gate keys on the lastTopLevelBoxEnd-vs-fileSize gap.
        label: "Kenwood CCCC trailer -> kenwood",
        bytes: () => concatBytes([FTYP, mp4Box("mdat", new Uint8Array(128)), ascii(KENWOOD_TRAILER)]),
        name: "kenwood-trailer.mp4",
        extractor: "kenwood",
    },
    {
        label: "LigoJSON direct udta -> ligo-json",
        bytes: () => concatBytes([FTYP, mp4Box("mdat", new Uint8Array(64)), mp4Box("udta", ascii(LIGO_JSON_BLOB))]),
        name: "yada.mp4",
        extractor: "ligo-json",
    },
    {
        label: "GKU __V35AX_QVDATA__ udta -> ligo-json",
        bytes: () => concatBytes([FTYP, mp4Box("mdat", new Uint8Array(64)), mp4Box("udta", gkuUdtaPayload(0x80))]),
        name: "gku.mp4",
        extractor: "ligo-json",
    },
    {
        label: "Garmin moov/uuid -> garmin-uuid",
        bytes: () => concatBytes([FTYP, garminMoov(), mp4Box("mdat", new Uint8Array(64))]),
        name: "GRMN0001.MP4",
        extractor: "garmin-uuid",
    },
    {
        label: "Denver bracketed log in top-level udat -> gpslog-atom",
        bytes: () =>
            concatBytes([FTYP, mp4Box("mdat", new Uint8Array(64)), mp4Box("udat", ascii(DENVER_UDAT_PAYLOAD))]),
        name: "denver.mp4",
        extractor: "gpslog-atom",
    },
    {
        // The other dialect of the same atom, and the reason the gate cannot
        // key on Denver content alone.
        label: "NMEA log in top-level udat -> gpslog-atom",
        bytes: () => concatBytes([FTYP, mp4Box("mdat", new Uint8Array(64)), mp4Box("udat", ascii(NMEA_UDAT_PAYLOAD))]),
        name: "datakam.mp4",
        extractor: "gpslog-atom",
    },
    {
        // The gate reads a fixed head window, so it must survive a log whose
        // first line is not the sentence the parser decodes.
        label: "GGA-first NMEA log in top-level udat -> gpslog-atom",
        bytes: () =>
            concatBytes([FTYP, mp4Box("mdat", new Uint8Array(64)), mp4Box("udat", ascii(GGA_FIRST_UDAT_PAYLOAD))]),
        name: "gga-first.mp4",
        extractor: "gpslog-atom",
    },
    {
        // Second atom of the same decoders, and its own primitive - registered
        // behind the Nextbase track formats, so the id differs on purpose.
        label: "NMEA log in top-level nbmt -> gpslog-atom-nbmt",
        bytes: () => concatBytes([FTYP, mp4Box("mdat", new Uint8Array(64)), mp4Box("nbmt", ascii(NMEA_UDAT_PAYLOAD))]),
        name: "nextbase-nbmt.mp4",
        extractor: "gpslog-atom-nbmt",
    },
    {
        label: "Nextbase Base64 JSON in top-level gdat -> nextbase-gdat",
        bytes: () => concatBytes([FTYP, mp4Box("mdat", new Uint8Array(64)), mp4Box("gdat", gdatPayload())]),
        name: "nextbase-gdat.mp4",
        extractor: "nextbase-gdat",
    },
    {
        label: "Pretty-printed Nextbase gdat -> nextbase-gdat",
        bytes: () => concatBytes([FTYP, mp4Box("mdat", new Uint8Array(64)), mp4Box("gdat", gdatPayload(2))]),
        name: "nextbase-gdat-pretty.mp4",
        extractor: "nextbase-gdat",
    },
] as const;

describe("embedded GPS dispatch gate: synthetic udta/uuid/trailer carriers", () => {
    for (const c of SYNTHETIC_CASES) {
        it(`${c.label}: real dispatch yields records (not dead code)`, async () => {
            const result = await dispatchParseVideoEmbeddedGps([syntheticVideo(c.bytes(), c.name)]);
            expect(result.records.length).toBeGreaterThan(0);
            expect(result.appliedExtractors).toContain(c.extractor);
        });
    }
});

// The walk stops at the first primitive that yields records, so registration
// order IS the precedence rule - nothing else enforces it.
describe("embedded GPS dispatch gate: precedence of the text-log atoms", () => {
    it("an nbmt log does not shadow a telemetry track in the same file", async () => {
        // A vendor writing an undocumented text atom next to its real telemetry
        // track is the whole risk: the track decoder is sample-validated and
        // carries accel, the text log has no field for it. Any subtitle track
        // stands in for that here - the fixture is the one committed sbtl file.
        const original = readFileSync(resolve(HERE, "thinkware/real-anonymized.mp4"));
        const name = "REC_2026_06_01_21_16_47_F.MP4";
        const bytes = concatBytes([new Uint8Array(original), mp4Box("nbmt", ascii(NMEA_UDAT_PAYLOAD))]);

        const result = await dispatchParseVideoEmbeddedGps([syntheticVideo(bytes, name)]);
        expect(result.appliedExtractors).toContain("nmea-subtitle");
        expect(result.appliedExtractors).not.toContain("gpslog-atom-nbmt");
        expect(result.records.length).toBeGreaterThan(0);
    });
});

describe("embedded GPS dispatch gate: TS trailer ahead of the PES scanners", () => {
    it("takes the EOF table without scanning a stream that only carries an enciphered LigoGPS PES", async () => {
        // Blackview X5S PRO shape: a private PES whose body opens with the
        // LIGOGPSINFO literal (enciphered, never plaintext) inside the stream,
        // and the readable table at EOF. juscar-ts claims the literal and
        // would read every packet before rejecting the file; the trailer
        // primitive must win first. Larger than the marker probe so a full
        // scan is visible as bytes read beyond the probe window.
        const TS_PACKET = 188;
        const nullPackets = Math.ceil((8 * 1024 * 1024) / TS_PACKET);
        const body = Buffer.alloc(TS_PACKET * (nullPackets + 1), 0xff);
        for (let i = 0; i < nullPackets + 1; i++) {
            body[i * TS_PACKET] = 0x47;
            body[i * TS_PACKET + 1] = 0x1f;
            body[i * TS_PACKET + 2] = 0xff;
            body[i * TS_PACKET + 3] = 0x10;
        }
        // Packet 1: PUSI on PID 0x300, private_stream_2, 152-byte PES.
        const pes = TS_PACKET;
        body[pes + 1] = 0x43;
        body[pes + 2] = 0x00;
        body.set([0x00, 0x00, 0x01, 0xbf, 0x00, 0x98], pes + 4);
        for (let i = pes + 10; i < pes + TS_PACKET; i++) body[i] = (i * 7) & 0xff;
        // The enciphered LigoGPS chunk shape the probe keys on: the literal,
        // then the "####" marker 0x14 bytes in (see findLigoGpsChunkOffset).
        body.write("LIGOGPSINFO", pes + 10, "latin1");
        body.write("####", pes + 10 + 0x14, "latin1");
        const happy = readFileSync(resolve(HERE, "ligogps-trailer-ts/synthetic-happy.TS"));
        const trailer = happy.subarray(2 * TS_PACKET);
        const name = "20260904_202849F.ts";
        const file = new File([Uint8Array.from(Buffer.concat([body, trailer]))], name);
        const vf = { file, relativePath: name };

        const index = await buildMp4Index(file, { probeBytes: 0 });
        await probeMarkers(file, index, DEFAULT_PROBE_BYTES);
        expect(index.hasLigoGpsMarker, "the enciphered PES carries the LigoGPS literal").toBe(true);
        expect(await juscarTsPrimitive.marker(vf, index), "juscar-ts yields to the verified EOF table").toBe(false);
        const expected = await ligoGpsTrailerTsPrimitive.parse(vf, index);
        expect(expected.records.length).toBeGreaterThan(0);

        const original = Blob.prototype.arrayBuffer;
        let bytesRead = 0;
        Blob.prototype.arrayBuffer = function (this: Blob) {
            bytesRead += this.size;
            return original.call(this);
        };
        try {
            const classified: ClassifiedFile[] = [
                { file: vf, role: "video", sidecarId: null, sidecarMp4: null, logExtractorId: null },
            ];
            const result = await dispatchParseVideoEmbeddedGps(classified, undefined, 1, undefined, "light-only");
            expect(result.winningExtractorByFileKey.get(vendorFileKey(vf))).toBe("ligogps-trailer-ts");
            expect(result.records).toHaveLength(expected.records.length);
            expect(bytesRead, "bytes read by the dispatch").toBeLessThan(DEFAULT_PROBE_BYTES + 1024 * 1024);
        } finally {
            Blob.prototype.arrayBuffer = original;
        }
    });

    it("leaves a no-fix clip with an empty EOF table unread past the probe", async () => {
        // The empty table yields no records, so the dispatcher walks on; the
        // juscar-ts marker must still reject the stream instead of proving
        // the absence of plaintext records by reading the whole file.
        const TS_PACKET = 188;
        const nullPackets = Math.ceil((8 * 1024 * 1024) / TS_PACKET);
        const body = Buffer.alloc(TS_PACKET * (nullPackets + 1), 0xff);
        for (let i = 0; i < nullPackets + 1; i++) {
            body[i * TS_PACKET] = 0x47;
            body[i * TS_PACKET + 1] = 0x1f;
            body[i * TS_PACKET + 2] = 0xff;
            body[i * TS_PACKET + 3] = 0x10;
        }
        const pes = TS_PACKET;
        body[pes + 1] = 0x43;
        body[pes + 2] = 0x00;
        body.set([0x00, 0x00, 0x01, 0xbf, 0x00, 0x98], pes + 4);
        for (let i = pes + 10; i < pes + TS_PACKET; i++) body[i] = (i * 7) & 0xff;
        body.write("LIGOGPSINFO", pes + 10, "latin1");
        body.write("####", pes + 10 + 0x14, "latin1");
        const empty = readFileSync(resolve(HERE, "ligogps-trailer-ts/real-anonymized-empty.TS"));
        const trailer = empty.subarray(empty.length - 36);
        const name = "20260904_205125F.ts";
        const file = new File([Uint8Array.from(Buffer.concat([body, trailer]))], name);
        const vf = { file, relativePath: name };

        const original = Blob.prototype.arrayBuffer;
        let bytesRead = 0;
        Blob.prototype.arrayBuffer = function (this: Blob) {
            bytesRead += this.size;
            return original.call(this);
        };
        try {
            const classified: ClassifiedFile[] = [
                { file: vf, role: "video", sidecarId: null, sidecarMp4: null, logExtractorId: null },
            ];
            const result = await dispatchParseVideoEmbeddedGps(classified, undefined, 1, undefined, "light-only");
            expect(result.records).toHaveLength(0);
            expect(result.errors).toEqual([]);
            expect(result.winningExtractorByFileKey.size).toBe(0);
            expect(bytesRead, "bytes read by the dispatch").toBeLessThan(DEFAULT_PROBE_BYTES + 1024 * 1024);
        } finally {
            Blob.prototype.arrayBuffer = original;
        }
    });
});

describe("embedded GPS dispatch gate: probe escalation from a junk `gps ` table", () => {
    // A moov whose `gps ` atom declares `count` blocks but holds no usable
    // entry - VIOFO A329 firmware writes exactly this. The literal sits past
    // the default probe window (a 63 Mbps 4K stream puts the first block near
    // 8 MB), so only the escalated probe can see it.
    class ReadTrackingFile extends File {
        public furthestReadEnd = 0;
        override slice(start?: number, end?: number, contentType?: string): Blob {
            this.furthestReadEnd = Math.max(this.furthestReadEnd, end ?? this.size);
            return super.slice(start, end, contentType);
        }
    }

    function junkTableFile(declaredCount: number, name: string): { classified: ClassifiedFile; file: ReadTrackingFile } {
        const table = new Uint8Array(8 + 2 * 8);
        const view = new DataView(table.buffer);
        view.setUint32(0, 0x00000101);
        view.setUint32(4, declaredCount);
        view.setUint32(8, 0x801e3200);
        const moov = mp4Box("moov", mp4Box("gps ", table));
        const mdat = new Uint8Array(10 * 1024 ** 2);
        mdat.set(ascii("freeGPS "), 6 * 1024 ** 2);
        const file = new ReadTrackingFile([concatBytes([FTYP, moov, mp4Box("mdat", mdat)])], name);
        return {
            classified: { file: { file, relativePath: name }, role: "video", sidecarId: null, sidecarMp4: null, logExtractorId: null },
            file,
        };
    }

    it("a declared count escalates the probe, so a block beyond the default window defers the file as heavy", async () => {
        const { classified, file } = junkTableFile(180, "junk-table.mp4");
        const result = await dispatchParseVideoEmbeddedGps([classified], undefined, 1, undefined, "light-only");
        expect(result.heavyFiles.map((cf) => cf.file.file.name)).toEqual(["junk-table.mp4"]);
        expect(result.errors).toEqual([]);
        expect(file.furthestReadEnd).toBe(file.size);
    });

    it("a placeholder table with a zero count stays at the default window and yields nothing", async () => {
        const { classified, file } = junkTableFile(0, "placeholder-table.mp4");
        const result = await dispatchParseVideoEmbeddedGps([classified], undefined, 1, undefined, "light-only");
        expect(result.heavyFiles).toEqual([]);
        expect(result.records).toEqual([]);
        expect(result.errors).toEqual([]);
        // The moov sits before mdat, so every read stays inside the default probe.
        expect(file.furthestReadEnd).toBeLessThanOrEqual(DEFAULT_PROBE_BYTES);
    });
});

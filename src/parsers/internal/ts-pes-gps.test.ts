// INNOVV and DOD LS600W GPS in an MPEG-TS private PES. Both are foreign-source
// only, so these tests pin the two things that CAN be checked without a sample:
// the layout matches the ExifTool branch byte for byte, and neither dialect
// claims the other's bytes (nor the Novatek TS fixture's).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractTsPesGps, findTsPesGpsStream } from "./ts-pes-gps.js";
import { findNovatekTsGpsPid } from "./novatek-ts-extract.js";
import { buildMp4Index } from "./mp4-index.js";
import { tsPesGpsPrimitive } from "../primitives/ts-pes-gps.js";
import { dispatchParseVideoEmbeddedGps } from "../registry.js";
import { KNOTS_TO_MS, type VendorFile } from "../types.js";

const TS_SIZE = 188;
const PID = 0x300;

function tsPacket(payload: Uint8Array, pusi: boolean, counter: number): Uint8Array {
    const pkt = new Uint8Array(TS_SIZE).fill(0xff);
    pkt[0] = 0x47;
    pkt[1] = (pusi ? 0x40 : 0) | ((PID >> 8) & 0x1f);
    pkt[2] = PID & 0xff;
    pkt[3] = 0x10 | (counter & 0x0f);
    pkt.set(payload.subarray(0, TS_SIZE - 4), 4);
    return pkt;
}

/** Wraps a PES body in a private_stream_2 PES, split over as many packets as needed. */
function pesStream(body: Uint8Array): Uint8Array {
    const pes = new Uint8Array(6 + body.length);
    pes.set([0x00, 0x00, 0x01, 0xbf, (body.length >> 8) & 0xff, body.length & 0xff], 0);
    pes.set(body, 6);

    const packets: Uint8Array[] = [];
    for (let at = 0, i = 0; at < pes.length; at += TS_SIZE - 4, i++) {
        packets.push(tsPacket(pes.subarray(at, at + TS_SIZE - 4), i === 0, i));
    }
    const out = new Uint8Array(packets.length * TS_SIZE);
    packets.forEach((p, i) => {
        out.set(p, i * TS_SIZE);
    });
    return out;
}

/**
 * One TS packet whose payload is short, so the slack is taken by adaptation-
 * field stuffing - how a real mux ends a PES that does not fill a packet.
 */
function stuffedTsPacket(payload: Uint8Array, pusi: boolean, counter: number): Uint8Array {
    const pkt = new Uint8Array(TS_SIZE).fill(0xff);
    pkt[0] = 0x47;
    pkt[1] = (pusi ? 0x40 : 0) | ((PID >> 8) & 0x1f);
    pkt[2] = PID & 0xff;
    pkt[3] = 0x30 | (counter & 0x0f); // adaptation field AND payload
    const afLen = TS_SIZE - 5 - payload.length;
    pkt[4] = afLen;
    if (afLen > 0) pkt[5] = 0; // no PCR/flags, the rest is 0xff stuffing
    pkt.set(payload, TS_SIZE - payload.length);
    return pkt;
}

/**
 * Wraps bodies in back-to-back stream_id 0xbd PES packets with a 5-byte PTS
 * extension, AF-stuffing the last packet of each. This is the shape where
 * PES_packet_length is NOT the body length (it also counts 3 + hdrLen of
 * header), so a reassembly budget built from it runs into the next PES.
 */
function extendedHeaderPesStream(bodies: Uint8Array[]): Uint8Array {
    const hdrLen = 5;
    const packets: Uint8Array[] = [];
    let counter = 0;
    for (const body of bodies) {
        const pesLen = 3 + hdrLen + body.length;
        const pes = new Uint8Array(6 + pesLen);
        pes.set([0x00, 0x00, 0x01, 0xbd, (pesLen >> 8) & 0xff, pesLen & 0xff, 0x80, 0x80, hdrLen], 0);
        pes.set([0x21, 0x00, 0x01, 0x00, 0x01], 9); // PTS, never read here
        pes.set(body, 9 + hdrLen);
        for (let at = 0; at < pes.length; at += TS_SIZE - 4) {
            const part = pes.subarray(at, at + TS_SIZE - 4);
            packets.push(
                part.length === TS_SIZE - 4
                    ? tsPacket(part, at === 0, counter++)
                    : stuffedTsPacket(part, at === 0, counter++),
            );
        }
    }
    const out = new Uint8Array(packets.length * TS_SIZE);
    packets.forEach((p, i) => {
        out.set(p, i * TS_SIZE);
    });
    return out;
}

function vendorFile(bytes: Uint8Array, name = "clip.ts"): VendorFile {
    return { file: new File([bytes as BlobPart], name), relativePath: name };
}

// ===== INNOVV: 32-byte records, layout from M2TS.pm:376-401 (v13.55) =====

function innovvRecord(ns: "N" | "S" = "N", ew: "E" | "W" = "E"): Uint8Array {
    const rec = new Uint8Array(32);
    const dv = new DataView(rec.buffer);
    rec[0] = 0x41; // 'A'
    rec[1] = ns.charCodeAt(0);
    rec[2] = ew.charCodeAt(0);
    rec[3] = 0;
    dv.setFloat32(4, 5220.097, true); // DDmm -> 52.33495
    dv.setFloat32(8, 636.2321, true); // DDDmm -> 6.6038683
    dv.setFloat32(12, 10, true); // knots
    dv.setFloat32(16, 140, true); // track
    // i32 triple at +20 - upstream reports it raw, we drop it.
    dv.setInt32(20, -5, true);
    return rec;
}

function innovvVoid(): Uint8Array {
    const rec = new Uint8Array(32);
    rec.set([0x56, 0x30, 0x30, 0x00], 0); // 'V00\0'
    return rec;
}

describe("INNOVV in MPEG-TS", () => {
    it("detects a renamed recording after a damaged prefix with a false payload sync", async () => {
        const gps = extendedHeaderPesStream([innovvRecord(), innovvRecord("S", "W")]);
        const stream = new Uint8Array(TS_SIZE + gps.length);
        stream.set([0x47, 0x42, 0, 0x10], 32);
        stream.set(gps, TS_SIZE);
        const vf = vendorFile(stream, "renamed.ts");
        const index = await buildMp4Index(vf.file);
        expect(findTsPesGpsStream(stream)).toEqual({ pid: PID, dialect: "innovv" });
        expect(await tsPesGpsPrimitive.marker(vf, index)).toBe(true);
        expect((await tsPesGpsPrimitive.parse(vf, index)).records).toHaveLength(2);
    });

    it("detects the stream and decodes its records", async () => {
        const body = new Uint8Array(64);
        body.set(innovvRecord(), 0);
        body.set(innovvRecord("S", "W"), 32);

        const stream = pesStream(body);
        expect(findTsPesGpsStream(stream)).toEqual({ pid: PID, dialect: "innovv" });

        const parsed = await extractTsPesGps(vendorFile(stream), stream);
        expect(parsed.records).toHaveLength(2);
        expect(parsed.records[0]!.lat).toBeCloseTo(52.33495, 5);
        expect(parsed.records[0]!.lon).toBeCloseTo(6.6038683, 5);
        expect(parsed.records[0]!.speedMs).toBeCloseTo(10 * KNOTS_TO_MS, 5);
        expect(parsed.records[0]!.bearingDeg).toBe(140);
        // No clock of any kind in this format.
        expect(parsed.records[0]!.timeUnsynced).toBe(true);
        // Hemisphere flags are the only sign source.
        expect(parsed.records[1]!.lat).toBeLessThan(0);
        expect(parsed.records[1]!.lon).toBeLessThan(0);
        // The raw i32 triple has no scale or axis order upstream.
        expect([parsed.records[0]!.accelXg, parsed.records[0]!.accelYg, parsed.records[0]!.accelZg]).toEqual([0, 0, 0]);
    });

    it("accepts a body that opens with the void marker and skips those slots", async () => {
        const body = new Uint8Array(64);
        body.set(innovvVoid(), 0);
        body.set(innovvRecord(), 32);

        const stream = pesStream(body);
        expect(findTsPesGpsStream(stream)?.dialect).toBe("innovv");
        const parsed = await extractTsPesGps(vendorFile(stream), stream);
        expect(parsed.records).toHaveLength(1);
    });
});

// ===== DOD LS600W: 32-byte BE records from body offset 32 (M2TS.pm:511-537) =====

function dodRecord(latE7: number, lonE7: number, second = 13): Uint8Array {
    const rec = new Uint8Array(32);
    const dv = new DataView(rec.buffer);
    dv.setUint16(0, 0x2453, false); // '$S'
    dv.setUint16(2, 1000, false); // metres per 100 s -> 10 m/s
    dv.setUint16(4, 14000, false); // track x100 -> 140 deg
    dv.setUint16(6, 2021, false); // year
    rec[8] = 3; // month
    rec[9] = 18; // day
    rec[10] = 7; // hour
    rec[11] = 32; // minute
    dv.setUint16(12, second * 10, false); // tenths of a second
    dv.setInt32(15, latE7, false);
    dv.setInt32(19, lonE7, false);
    return rec;
}

function dodBody(...records: Uint8Array[]): Uint8Array {
    const body = new Uint8Array(32 + records.length * 32);
    records.forEach((r, i) => {
        body.set(r, 32 + i * 32);
    });
    return body;
}

describe("DOD LS600W in MPEG-TS", () => {
    it("decodes decimal-degree records", async () => {
        const stream = pesStream(dodBody(dodRecord(523349500, 66038683)));
        expect(findTsPesGpsStream(stream)).toEqual({ pid: PID, dialect: "dod" });

        const parsed = await extractTsPesGps(vendorFile(stream), stream);
        expect(parsed.records).toHaveLength(1);
        const r = parsed.records[0]!;
        expect(r.lat).toBeCloseTo(52.33495, 6);
        expect(r.lon).toBeCloseTo(6.6038683, 6);
        expect(r.speedMs).toBeCloseTo(10, 6);
        expect(r.bearingDeg).toBeCloseTo(140, 6);
        expect(r.unixSeconds).toBe(Date.UTC(2021, 2, 18, 7, 32, 13) / 1000);
        // Real UTC in the record - not re-anchored like INNOVV.
        expect(r.timeUnsynced).toBeUndefined();
    });

    it("reads southern/western coordinates, which upstream's unsigned read cannot", async () => {
        // -33.865143 / -151.2099: as UNSIGNED 32-bit these become ~429 degrees.
        const stream = pesStream(dodBody(dodRecord(-338651430, -1512099000)));
        const parsed = await extractTsPesGps(vendorFile(stream), stream);
        expect(parsed.records[0]!.lat).toBeCloseTo(-33.865143, 6);
        expect(parsed.records[0]!.lon).toBeCloseTo(-151.2099, 6);
    });

    it("folds a course stored past the signed-u16 boundary back into 0..360", async () => {
        // Angles above ~327 deg do not fit a signed 16-bit field, so the format
        // stores them as (angle - 36000) in two's complement: 350.00 deg is
        // written as 64536, NOT as 35000.
        const rec = dodRecord(523349500, 66038683);
        new DataView(rec.buffer).setUint16(4, 64536, false);
        const stream = pesStream(dodBody(rec));
        const parsed = await extractTsPesGps(vendorFile(stream), stream);
        expect(parsed.records[0]!.bearingDeg).toBeCloseTo(350, 6);
    });

    it("skips a record whose date is out of range", async () => {
        const bad = dodRecord(523349500, 66038683);
        new DataView(bad.buffer).setUint16(6, 1970, false); // year
        const good = dodRecord(523349500, 66038683, 14);
        const stream = pesStream(dodBody(bad, good));
        const parsed = await extractTsPesGps(vendorFile(stream), stream);
        expect(parsed.records).toHaveLength(1);
        expect(parsed.skipped[0]!.reason).toBe("date out of range");
    });

    it("reads a mux that uses an extended PES header, where the length field is not the body length", async () => {
        // stream_id 0xbd + 5 bytes of PTS: PES_packet_length overstates the
        // body by 8. A budget taken from it straight walks into the following
        // PES and the whole dialect reads as absent - detection included.
        const body = () =>
            dodBody(...Array.from({ length: 12 }, (_, i) => dodRecord(523349500 + i * 1000, 66038683, 13 + i)));
        const stream = extendedHeaderPesStream([body(), body()]);
        expect(findTsPesGpsStream(stream)).toEqual({ pid: PID, dialect: "dod" });

        const parsed = await extractTsPesGps(vendorFile(stream), stream);
        expect(parsed.records).toHaveLength(24);
        // The last record of each PES - the tail a short budget would lose.
        expect(parsed.records[11]!.lat).toBeCloseTo(52.33605, 5);
        expect(parsed.records[23]!.lat).toBeCloseTo(52.33605, 5);
    });

    it("reads records that spill past the first TS packet", async () => {
        // 12 records = 416 bytes of body; a packet carries at most 184, so this
        // spans three of them and only reassembly can read the tail.
        const records = Array.from({ length: 12 }, (_, i) => dodRecord(523349500 + i * 1000, 66038683, 13 + i));
        const stream = pesStream(dodBody(...records));
        expect(stream.length).toBe(TS_SIZE * 3);
        const parsed = await extractTsPesGps(vendorFile(stream), stream);
        expect(parsed.records).toHaveLength(12);
    });
});

describe("real dispatch", () => {
    // A primitive whose gate wiring is missing is dead in production while its
    // isolated tests stay green - the regression class __fixtures__/
    // dispatch-gate.test.ts exists for. TS has no moov, so the kind gate must
    // key off the headerBytes scan.
    async function dispatch(bytes: Uint8Array, name: string) {
        return dispatchParseVideoEmbeddedGps([
            {
                file: { file: new File([bytes as BlobPart], name), relativePath: name },
                role: "video",
                sidecarId: null,
                sidecarMp4: null,
                logExtractorId: null,
            },
        ]);
    }

    it("INNOVV reaches the extractor through the real gate", async () => {
        const body = new Uint8Array(32);
        body.set(innovvRecord(), 0);
        const result = await dispatch(pesStream(body), "innovv.ts");
        expect(result.records.length).toBeGreaterThan(0);
        expect(result.appliedExtractors).toContain("ts-pes-gps");
    });

    it("DOD reaches the extractor through the real gate", async () => {
        const result = await dispatch(pesStream(dodBody(dodRecord(523349500, 66038683))), "dod.ts");
        expect(result.records.length).toBeGreaterThan(0);
        expect(result.appliedExtractors).toContain("ts-pes-gps");
    });
});

describe("dialect separation", () => {
    it("neither dialect claims the real Novatek-TS fixture", () => {
        const HERE = dirname(fileURLToPath(import.meta.url));
        const bytes = new Uint8Array(readFileSync(resolve(HERE, "../__fixtures__/novatek-ts/real-anonymized.TS")));
        expect(findTsPesGpsStream(bytes)).toBeNull();
    });

    it("novatek-ts does not claim an INNOVV or DOD stream", () => {
        const innovv = pesStream(
            (() => {
                const b = new Uint8Array(32);
                b.set(innovvRecord(), 0);
                return b;
            })(),
        );
        expect(findNovatekTsGpsPid(innovv)).toBeNull();
        expect(findNovatekTsGpsPid(pesStream(dodBody(dodRecord(523349500, 66038683))))).toBeNull();
    });

    it("a TS with neither signature is rejected", async () => {
        const junk = new Uint8Array(TS_SIZE * 4);
        for (let i = 0; i < 4; i++) {
            junk[i * TS_SIZE] = 0x47;
            junk[i * TS_SIZE + 1] = 0x41;
        }
        expect(findTsPesGpsStream(junk)).toBeNull();
        await expect(extractTsPesGps(vendorFile(junk), junk)).rejects.toThrow();
    });

    it("stops at the signature limit instead of scanning to EOF", async () => {
        // A real GPS PES, but placed past the 64 MiB limit: the early-out
        // has to fire first. Without it these records WOULD be found, which
        // is what makes this an assertion about the early-out and not about
        // the buffer being unparseable.
        const LIMIT = 64 * 1024 * 1024;
        const fillerPackets = Math.ceil(LIMIT / TS_SIZE);
        const gps = pesStream(dodBody(dodRecord(523349500, 66038683)));
        const stream = new Uint8Array(fillerPackets * TS_SIZE + gps.length);
        for (let i = 0; i < fillerPackets; i++) {
            // PUSI=0 payload packets on a foreign PID: walked over, never probed.
            stream[i * TS_SIZE] = 0x47;
            stream[i * TS_SIZE + 1] = 0x01;
            stream[i * TS_SIZE + 3] = 0x10;
        }
        const gpsAt = fillerPackets * TS_SIZE;
        expect(gpsAt).toBeGreaterThan(LIMIT);
        stream.set(gps, gpsAt);

        await expect(extractTsPesGps(vendorFile(stream), null)).rejects.toThrow(/no supported gps pes signature/);
    }, 60_000);
});

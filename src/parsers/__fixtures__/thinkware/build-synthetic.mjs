#!/usr/bin/env node
// Builds a minimal MP4 with a Thinkware-style subtitle (tx3g) track for parser
// fixtures. Mirrors the real F200 PRO layout: each subtitle sample is a tx3g
// cue (uint16-BE length prefix + UTF-8 text) carrying
//   "gsensori,<range>,<sens>,X,Y,Z;[GxRMC,...*cc;]CAR,<obd>"
// with NMEA written WITHOUT a leading '$', ';'-delimited inline. GPS appears
// ~1 Hz, accel every cue, matching the device.
//
// `buildSbtlMp4(cueTexts, options)` is exported so scripts/anonymize-thinkware-mp4.mjs
// can reuse the exact container layout with real (coordinate-scrubbed) cues.
// Running this file directly writes synthetic-fseries.mp4 (synthetic cues).

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fourCC(s) { return Buffer.from(s, "ascii"); }
function box(type, payload) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + payload.length, 0);
    fourCC(type).copy(head, 4);
    return Buffer.concat([head, payload]);
}
function u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }

// tx3g sample framing: uint16-BE text length + UTF-8 text (no trailing style box).
function tx3gSample(text) {
    const body = Buffer.from(text, "latin1");
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(body.length, 0);
    return Buffer.concat([prefix, body]);
}

const CREATION_TIME = 3851323200; // 2026-01-15 12:00:00 in the MP4 epoch

/**
 * Builds a minimal ISOBMFF file (ftyp + moov + mdat) with a single tx3g
 * subtitle track whose samples are `cueTexts`. moov-at-start; one chunk.
 * `creationTime` (MP4-epoch seconds) and `cueDurationMs` let the anonymizer
 * keep the source recording's mvhd stamp and cue spacing; the synthetic
 * fixtures use the defaults.
 * @param {string[]} cueTexts
 * @param {{ creationTime?: number, cueDurationMs?: number }} [options]
 * @returns {Buffer}
 */
export function buildSbtlMp4(cueTexts, { creationTime = CREATION_TIME, cueDurationMs = 1000 } = {}) {
    const samples = cueTexts.map(tx3gSample);
    const sampleSizes = samples.map((s) => s.length);
    const durationMs = samples.length * cueDurationMs;

    const mvhd = (() => {
        const p = Buffer.alloc(108);
        p.writeUInt32BE(creationTime, 4);
        p.writeUInt32BE(creationTime, 8);
        p.writeUInt32BE(1000, 12);
        p.writeUInt32BE(durationMs, 16);
        return box("mvhd", p);
    })();

    const hdlr = (() => {
        const p = Buffer.alloc(33);
        fourCC("sbtl").copy(p, 8);
        return box("hdlr", p);
    })();

    const mdhd = (() => {
        const p = Buffer.alloc(24);
        p.writeUInt32BE(creationTime, 4);
        p.writeUInt32BE(creationTime, 8);
        p.writeUInt32BE(1000, 12);
        p.writeUInt32BE(durationMs, 16);
        return box("mdhd", p);
    })();

    const stsd = (() => {
        const entry = Buffer.alloc(16);
        entry.writeUInt32BE(16, 0);
        fourCC("tx3g").copy(entry, 4);
        return box("stsd", Buffer.concat([Buffer.alloc(4), u32be(1), entry]));
    })();

    const stts = box("stts", Buffer.concat([Buffer.alloc(4), u32be(1), u32be(samples.length), u32be(cueDurationMs)]));
    const stsc = box("stsc", Buffer.concat([Buffer.alloc(4), u32be(1), u32be(1), u32be(samples.length), u32be(1)]));
    const stsz = box("stsz", Buffer.concat([Buffer.alloc(4), u32be(0), u32be(samples.length), ...sampleSizes.map(u32be)]));
    const stcoPlaceholder = box("stco", Buffer.concat([Buffer.alloc(4), u32be(1), u32be(0)]));
    const stbl = box("stbl", Buffer.concat([stsd, stts, stsc, stsz, stcoPlaceholder]));

    const dref = box("dref", Buffer.concat([Buffer.alloc(4), u32be(1), u32be(12), fourCC("url "), Buffer.from([0, 0, 0, 1])]));
    const dinf = box("dinf", dref);
    const minf = box("minf", Buffer.concat([dinf, stbl]));
    const mdia = box("mdia", Buffer.concat([mdhd, hdlr, minf]));

    const tkhd = (() => {
        const p = Buffer.alloc(84);
        p.writeUInt32BE(7, 0);
        p.writeUInt32BE(creationTime, 4);
        p.writeUInt32BE(creationTime, 8);
        p.writeUInt32BE(1, 12);
        p.writeUInt32BE(durationMs, 20);
        return box("tkhd", p);
    })();
    const trak = box("trak", Buffer.concat([tkhd, mdia]));
    const moov = box("moov", Buffer.concat([mvhd, trak]));

    const ftyp = box("ftyp", Buffer.concat([fourCC("isom"), u32be(512), fourCC("isom"), fourCC("avc1"), fourCC("mp41")]));
    const mdat = box("mdat", Buffer.concat(samples));
    const mdatStartOffset = ftyp.length + moov.length + 8;

    // Patch the stco chunk offset (mdat payload start) now that sizes are known.
    const chunkOffsetPos = moov.indexOf(stcoPlaceholder) + 8 + 4 + 4;
    const moovPatched = Buffer.from(moov);
    moovPatched.writeUInt32BE(mdatStartOffset, chunkOffsetPos);

    return Buffer.concat([ftyp, moovPatched, mdat]);
}

// NMEA checksum (XOR of the bytes between the leading '$' and '*'). Thinkware
// omits the '$' and computes over the bare "GxRMC,..." body, so we do the same.
function nmeaChecksum(body) {
    let c = 0;
    for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
    return c.toString(16).toUpperCase().padStart(2, "0");
}

// Builds a "gsensori,...;[GxRMC,...*cc;]CAR,..." cue. Coordinates are passed in
// decimal degrees and encoded to NMEA DDDmm.mmmm. accel is raw signed counts.
function cue({ accel, rmc }) {
    const segs = [`gsensori,4,512,${accel[0]},${accel[1]},${accel[2]}`];
    if (rmc) {
        const { time, lat, lon, knots, course, date, status = "A", talker = "GP" } = rmc;
        const ns = lat >= 0 ? "N" : "S";
        const ew = lon >= 0 ? "E" : "W";
        const ddmm = (deg) => {
            const a = Math.abs(deg);
            return (Math.floor(a) * 100 + (a - Math.floor(a)) * 60).toFixed(5);
        };
        const body =
            status === "A"
                ? `${talker}RMC,${time},A,${ddmm(lat)},${ns},${ddmm(lon)},${ew},${knots.toFixed(3)},${course.toFixed(2)},${date},,,A`
                : `${talker}RMC,${time},V,,,,,,,${date},,,N`;
        // The stray CRLF the device writes between the RMC and ";CAR".
        segs.push(`${body}*${nmeaChecksum(body)}\r\n`);
    }
    segs.push("CAR,0,0,0,0.0,0,0,0,0,0,0,0,0");
    return segs.join(";");
}

// Synthetic cues: two accel-only warm-up cues, then a 1 Hz GPS track moving NE
// from the 50.0 N / 30.0 E sentinel, plus a GNRMC talker and a void fix.
function syntheticCues() {
    const cues = [
        cue({ accel: [5, -3, 8] }),
        cue({ accel: [4, -2, 7] }),
    ];
    const base = { knots: 25, course: 45, date: "150126" };
    for (let i = 0; i < 6; i++) {
        cues.push(
            cue({
                accel: [6 + i, -3 - i, 8 + i],
                rmc: { ...base, time: `1200${String(i).padStart(2, "0")}.00`, lat: 50 + i * 0.0001, lon: 30 + i * 0.0001, course: 45 + i },
            }),
        );
    }
    // multi-GNSS talker (GN) and a void fix (no satellites yet).
    cues.push(cue({ accel: [12, -9, 14], rmc: { ...base, talker: "GN", time: "120006.00", lat: 50.0006, lon: 30.0006, course: 51 } }));
    cues.push(cue({ accel: [3, -1, 6], rmc: { ...base, time: "120007.00", status: "V", lat: 0, lon: 0 } }));
    return cues;
}

// Rear-channel cues: accel every cue, NO RMC ever - the rear camera records the
// G-sensor but not GPS (GPS rides only on the front file). The extractor must
// yield no records here and the primitive must throw WrongFormatError.
function rearCues() {
    return Array.from({ length: 8 }, (_unused, i) => cue({ accel: [5 + i, -3 - i, 8 + i] }));
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
    for (const [name, cues] of [
        ["synthetic-fseries.mp4", syntheticCues()],
        ["synthetic-rear.mp4", rearCues()],
    ]) {
        const file = buildSbtlMp4(cues);
        const outPath = resolve(__dirname, name);
        writeFileSync(outPath, file);
        console.error(`wrote ${file.length} bytes to ${outPath}`);
    }
}

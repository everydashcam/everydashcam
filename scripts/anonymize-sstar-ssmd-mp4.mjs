#!/usr/bin/env node
import { findFirstChild, readBoxBytes, box, fourCC, u32be, readBoxHeader } from "./_mp4-fixture.mjs";
// Anonymize a real SStar-firmware MP4 with a supported 32-byte DDmm,
// 40-byte direct or 56-byte KTRX `ssmd` GPS meta track into a public-safe fixture.
//
// Anonymization (mirrors scripts/anonymize-rvmi-mp4.mjs):
//   1. Walk the MP4, find the meta trak whose stsd entry is 'ssmd' and whose
//      stsz is constant 32, 40 or 56 bytes (sibling tracks are dropped entirely).
//   2. Read all its samples from mdat. On 32-byte DDmm rows (flags 0x097E at
//      +22), decode and round coordinates to WHOLE degrees, then re-encode.
//      On 40-byte fix rows (flags base 0x047E or
//      0x067E at +22 with the 0x0100 fix bit) round the lat/lon doubles to
//      WHOLE degrees (~110 km precision). On 56-byte KTRX rows decode, round,
//      re-encode, and replace the appended 16-hex device/session identifier
//      with zeroes. No-fix rows get the 0xFFFFFFFF sentinel in both slots.
//      A row with invalid coordinates or a foreign
//      flags word is zeroed except the flags word: content this script
//      cannot classify must never reach the fixture verbatim, and the
//      scrubbed row still fails decode the same way.
//      Timestamps, speed, course and the altitude-like word are NOT shifted
//      (not sensitive once coordinates are gone; the parse regression needs
//      them real).
//   3. Assemble a minimal MP4: ftyp + moov with a single meta/ssmd trak
//      (real media timescale, real per-sample stts cadence, header-fixed
//      fixed-size stsz like the real firmware writes) + mdat.
//
// Usage:
//   node scripts/anonymize-sstar-ssmd-mp4.mjs <input.mp4> <output.mp4>

import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";

const SUPPORTED_SAMPLE_SIZES = [32, 40, 56];
// Per-camera flags base + fix bit; mirrors SSTAR_FLAGS_* in
// src/parsers/internal/sstar-ssmd-extract.ts.
const FLAGS_FIX_BIT = 0x0100;
const FLAGS_BASES = [0x047e, 0x067e];
const DDMM_FLAGS_FIX = 0x097e;
const DDMM_FLAGS_NO_FIX = 0x087e;
const KTRX_FLAGS_FIX = 0x087e;
const NO_FIX_COORDINATE = 4294967295;
const KTRX_FACTORS = [
    15, 25, 36, 63, 82, 13, 12, 15, 21, 31, 21, 57, 16, 29, 47, 26, 42, 26, 26, 12, 65, 28, 12, 26, 46, 24, 29, 25, 54,
    23, 87, 12, 46, 48, 35, 37, 68, 12, 24, 46, 76, 55, 26, 28, 67, 24, 43, 46, 68, 87, 23, 56, 78, 34, 16, 48, 27, 81,
    53, 82,
];

function ddmmToDegrees(value) {
    if (!Number.isFinite(value)) return Number.NaN;
    const absolute = Math.abs(value);
    const degrees = Math.floor(absolute / 100);
    const minutes = absolute - degrees * 100;
    if (minutes >= 60) return Number.NaN;
    return Math.sign(value) * (degrees + minutes / 60);
}

function hasValidCoordinates(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function hasNoFixCoordinates(buf) {
    return buf.readDoubleLE(0) === NO_FIX_COORDINATE && buf.readDoubleLE(8) === NO_FIX_COORDINATE;
}

function scrubSample(buf, flags) {
    buf.fill(0);
    buf.writeUInt16LE(flags, 22);
}

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
    console.error("usage: anonymize-sstar-ssmd-mp4.mjs <input.mp4> <output.mp4>");
    process.exit(1);
}

const stat = statSync(inputPath);
const fd = openSync(inputPath, "r");

// Step 1: top-level walk, find moov.
let moov = null;
{
    let pos = 0;
    while (pos + 8 <= stat.size) {
        const h = readBoxHeader(fd, pos, stat.size);
        if (!h) break;
        if (h.type === "moov") {
            moov = { offset: pos, ...h };
            break;
        }
        pos += h.size;
    }
}
if (!moov) {
    console.error("no moov found");
    process.exit(1);
}

// Step 2: find the meta/ssmd trak with a supported constant sample size.
let gpsTrak = null;
let sampleSize = null;
{
    let pos = moov.offset + moov.headerSize;
    const end = moov.offset + moov.size;
    while (pos + 8 <= end) {
        const h = readBoxHeader(fd, pos, stat.size);
        if (!h) break;
        if (h.type === "trak") {
            const trak = { offset: pos, ...h };
            const mdia = findFirstChild(fd, trak, stat.size, "mdia");
            const hdlr = mdia && findFirstChild(fd, mdia, stat.size, "hdlr");
            const minf = mdia && findFirstChild(fd, mdia, stat.size, "minf");
            const stbl = minf && findFirstChild(fd, minf, stat.size, "stbl");
            const stsd = stbl && findFirstChild(fd, stbl, stat.size, "stsd");
            const stsz = stbl && findFirstChild(fd, stbl, stat.size, "stsz");
            if (hdlr && stsd && stsz) {
                const hdlrBuf = readBoxBytes(fd, hdlr);
                const handler = hdlrBuf.toString("ascii", hdlr.headerSize + 8, hdlr.headerSize + 12);
                const stsdBuf = readBoxBytes(fd, stsd);
                const entryType = stsdBuf.toString("ascii", stsd.headerSize + 12, stsd.headerSize + 16);
                const stszBuf = readBoxBytes(fd, stsz);
                const fixedSize = stszBuf.readUInt32BE(stsz.headerSize + 4);
                if (handler === "meta" && entryType === "ssmd" && SUPPORTED_SAMPLE_SIZES.includes(fixedSize)) {
                    gpsTrak = { ...trak, mdia, minf, stbl };
                    sampleSize = fixedSize;
                    break;
                }
            }
        }
        pos += h.size;
    }
}
if (!gpsTrak || sampleSize === null) {
    console.error("no supported fixed-size meta/ssmd track found");
    process.exit(1);
}

// Step 3: sample table of the GPS trak.
function stblChildBuf(type) {
    const h = findFirstChild(fd, gpsTrak.stbl, stat.size, type);
    if (!h) throw new Error(`stbl missing ${type}`);
    return { h, buf: readBoxBytes(fd, h) };
}

const stsz = stblChildBuf("stsz");
const sampleCount = stsz.buf.readUInt32BE(stsz.h.headerSize + 8);

const stco = stblChildBuf("stco");
const chunkOffsets = [];
{
    const n = stco.buf.readUInt32BE(stco.h.headerSize + 4);
    for (let i = 0; i < n; i++) chunkOffsets.push(stco.buf.readUInt32BE(stco.h.headerSize + 8 + i * 4));
}

const stsc = stblChildBuf("stsc");
const stscEntries = [];
{
    const n = stsc.buf.readUInt32BE(stsc.h.headerSize + 4);
    for (let i = 0; i < n; i++) {
        const off = stsc.h.headerSize + 8 + i * 12;
        stscEntries.push({
            firstChunk: stsc.buf.readUInt32BE(off),
            samplesPerChunk: stsc.buf.readUInt32BE(off + 4),
        });
    }
}

const stts = stblChildBuf("stts");
const perSampleDeltas = [];
{
    const n = stts.buf.readUInt32BE(stts.h.headerSize + 4);
    for (let i = 0; i < n; i++) {
        const off = stts.h.headerSize + 8 + i * 8;
        const count = stts.buf.readUInt32BE(off);
        const delta = stts.buf.readUInt32BE(off + 4);
        for (let j = 0; j < count; j++) perSampleDeltas.push(delta);
    }
}

const mdhd = (() => {
    const h = findFirstChild(fd, gpsTrak.mdia, stat.size, "mdhd");
    if (!h) throw new Error("mdia missing mdhd");
    return { h, buf: readBoxBytes(fd, h) };
})();
const mdhdVersion = mdhd.buf.readUInt8(mdhd.h.headerSize);
const mediaTimescale =
    mdhdVersion === 1
        ? mdhd.buf.readUInt32BE(mdhd.h.headerSize + 4 + 16)
        : mdhd.buf.readUInt32BE(mdhd.h.headerSize + 4 + 8);

// Expand per-sample absolute offsets.
const sampleAbsOffsets = [];
{
    let sIdx = 0;
    for (let ci = 0; ci < chunkOffsets.length && sIdx < sampleCount; ci++) {
        let spc = 1;
        for (const e of stscEntries) if (e.firstChunk <= ci + 1) spc = e.samplesPerChunk;
        let off = chunkOffsets[ci];
        for (let i = 0; i < spc && sIdx < sampleCount; i++) {
            sampleAbsOffsets.push(off);
            off += sampleSize;
            sIdx++;
        }
    }
}

// Step 4: read + redact samples.
let fixCount = 0;
let junkCount = 0;
const sampleBuffers = sampleAbsOffsets.map((off) => {
    const buf = Buffer.alloc(sampleSize);
    readSync(fd, buf, 0, sampleSize, off);
    const flags = buf.readUInt16LE(22);
    if (sampleSize === 32) {
        const lat = ddmmToDegrees(buf.readDoubleLE(0));
        const lon = ddmmToDegrees(buf.readDoubleLE(8));
        const isNoFix = hasNoFixCoordinates(buf);
        const hasKnownFlags = flags === DDMM_FLAGS_FIX || (flags === DDMM_FLAGS_NO_FIX && isNoFix);
        if (!hasKnownFlags || (!isNoFix && !hasValidCoordinates(lat, lon))) {
            scrubSample(buf, flags);
            junkCount++;
        } else if (isNoFix) {
            // Keep the local-RTC clock and status without retaining any position.
            buf.writeDoubleLE(NO_FIX_COORDINATE, 0);
            buf.writeDoubleLE(NO_FIX_COORDINATE, 8);
        } else {
            buf.writeDoubleLE(Math.round(lat) * 100, 0);
            buf.writeDoubleLE(Math.round(lon) * 100, 8);
            fixCount++;
        }
    } else if (sampleSize === 56) {
        const hour = buf.readUInt8(25);
        const minute = buf.readUInt8(26);
        const second = buf.readUInt8(27);
        const asciiClock = `${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`;
        const identifierValid = /^[0-9A-F]{16}$/.test(buf.toString("ascii", 32, 48));
        const tagged =
            identifierValid && buf.toString("ascii", 48, 52) === "KTRX" && buf.toString("ascii", 52, 56) === asciiClock;
        // Always remove the appended stable identifier, including from rows
        // whose remaining content cannot be classified.
        buf.write("0000000000000000", 32, "ascii");
        if (flags !== KTRX_FLAGS_FIX || !tagged || hour > 23 || minute > 59 || second > 59) {
            scrubSample(buf, flags);
            junkCount++;
        } else if (hasNoFixCoordinates(buf)) {
            // Tagged no-fix convention is supported defensively by the parser;
            // the real KTRX sample did not contain one.
        } else {
            const latFactor = KTRX_FACTORS[second] / 10;
            const lonFactor = KTRX_FACTORS[minute] / 10;
            const lat = (buf.readDoubleLE(0) - 114.712) / latFactor;
            const lon = (buf.readDoubleLE(8) - 224.222) / lonFactor;
            if (!hasValidCoordinates(lat, lon)) {
                scrubSample(buf, flags);
                junkCount++;
            } else {
                buf.writeDoubleLE(Math.round(lat) * latFactor + 114.712, 0);
                buf.writeDoubleLE(Math.round(lon) * lonFactor + 224.222, 8);
                fixCount++;
            }
        }
    } else if (!FLAGS_BASES.includes(flags & ~FLAGS_FIX_BIT)) {
        // Unclassifiable row: scrub everything but the flags word, so unknown
        // content never reaches the fixture while the row still fails decode.
        scrubSample(buf, flags);
        junkCount++;
    } else if (flags & FLAGS_FIX_BIT) {
        const lat = buf.readDoubleLE(0);
        const lon = buf.readDoubleLE(8);
        if (!hasValidCoordinates(lat, lon)) {
            scrubSample(buf, flags);
            junkCount++;
        } else {
            // Whole-degree rounding is the anonymization: ~110 km precision.
            buf.writeDoubleLE(Math.round(lat), 0);
            buf.writeDoubleLE(Math.round(lon), 8);
            fixCount++;
        }
    } else {
        // Do not trust unused coordinate slots to be empty on a no-fix row.
        buf.writeDoubleLE(NO_FIX_COORDINATE, 0);
        buf.writeDoubleLE(NO_FIX_COORDINATE, 8);
    }
    return buf;
});
closeSync(fd);
console.error(
    `kept ${sampleBuffers.length} samples (${fixCount} fix rows redacted, ${junkCount} foreign rows scrubbed, timescale=${mediaTimescale})`,
);

// Step 5: minimal MP4 with a single meta/ssmd trak.
const hdlrNew = (() => {
    const p = Buffer.alloc(33);
    fourCC("meta").copy(p, 8);
    return box("hdlr", p);
})();

let totalDuration = 0;
for (let i = 0; i < sampleBuffers.length; i++) totalDuration += perSampleDeltas[i] ?? 0;

const mdhdNew = (() => {
    const p = Buffer.alloc(24);
    // creation/modification stay 0 - matches the real firmware.
    p.writeUInt32BE(mediaTimescale, 12);
    p.writeUInt32BE(totalDuration, 16);
    p.writeUInt16BE(0x55c4, 20); // language 'und'
    return box("mdhd", p);
})();

const stsdNew = (() => {
    const entry = Buffer.alloc(16);
    entry.writeUInt32BE(16, 0);
    fourCC("ssmd").copy(entry, 4);
    return box("stsd", Buffer.concat([Buffer.alloc(4), u32be(1), entry]));
})();

// Real stts cadence, run-length grouped.
const sttsNew = (() => {
    const runs = [];
    let curDelta = -1;
    let curCount = 0;
    for (let i = 0; i < sampleBuffers.length; i++) {
        const d = perSampleDeltas[i] ?? 0;
        if (d === curDelta) curCount++;
        else {
            if (curCount > 0) runs.push({ count: curCount, delta: curDelta });
            curDelta = d;
            curCount = 1;
        }
    }
    if (curCount > 0) runs.push({ count: curCount, delta: curDelta });
    return box(
        "stts",
        Buffer.concat([Buffer.alloc(4), u32be(runs.length), ...runs.flatMap((r) => [u32be(r.count), u32be(r.delta)])]),
    );
})();

const stscNew = box(
    "stsc",
    Buffer.concat([Buffer.alloc(4), u32be(1), u32be(1), u32be(sampleBuffers.length), u32be(1)]),
);
// Header-fixed stsz like the real firmware writes.
const stszNew = box("stsz", Buffer.concat([Buffer.alloc(4), u32be(sampleSize), u32be(sampleBuffers.length)]));
const stcoPlaceholder = box("stco", Buffer.concat([Buffer.alloc(4), u32be(1), u32be(0)]));

const dinf = box(
    "dinf",
    box("dref", Buffer.concat([Buffer.alloc(4), u32be(1), u32be(12), fourCC("url "), Buffer.from([0, 0, 0, 1])])),
);
const stblNew = box("stbl", Buffer.concat([stsdNew, sttsNew, stscNew, stszNew, stcoPlaceholder]));
const minfNew = box("minf", Buffer.concat([dinf, stblNew]));
const mdiaNew = box("mdia", Buffer.concat([mdhdNew, hdlrNew, minfNew]));

const tkhdNew = (() => {
    const p = Buffer.alloc(84);
    p.writeUInt32BE(7, 0); // version 0, flags enabled+in-movie+in-preview
    p.writeUInt32BE(1, 12); // track_id
    p.writeUInt32BE(totalDuration, 20);
    return box("tkhd", p);
})();

const trakNew = box("trak", Buffer.concat([tkhdNew, mdiaNew]));
const mvhdNew = (() => {
    const p = Buffer.alloc(108);
    p.writeUInt32BE(1000, 12); // timescale
    // creation/duration stay 0 - the extractor must anchor to the filename.
    return box("mvhd", p);
})();
const moovNew = box("moov", Buffer.concat([mvhdNew, trakNew]));
const ftypNew = box(
    "ftyp",
    Buffer.concat([fourCC("isom"), u32be(512), fourCC("isom"), fourCC("iso2"), fourCC("mp41")]),
);
const mdat = box("mdat", Buffer.concat(sampleBuffers));

// Patch the single chunk offset now that sizes are known.
const mdatPayloadOffset = ftypNew.length + moovNew.length + 8;
const stcoPos = moovNew.indexOf(stcoPlaceholder);
const moovPatched = Buffer.from(moovNew);
moovPatched.writeUInt32BE(mdatPayloadOffset, stcoPos + 8 + 4 + 4);

const out = Buffer.concat([ftypNew, moovPatched, mdat]);
writeFileSync(outputPath, out);
console.error(`wrote ${out.length} bytes to ${outputPath}`);

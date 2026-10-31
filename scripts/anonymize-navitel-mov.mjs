#!/usr/bin/env node
import { box, fourCC, u32be, readBoxHeader } from "./_mp4-fixture.mjs";
// Anonymize a real Navitel R-series .MOV into a public-safe fixture for the
// gps0-tail extractor test.
//
// Real file structure (Navitel R600 sample):
//   ftyp / skip / mdat / moov / IDIT / gpsa / gps0 / gsea / gsen
//
// Anonymization:
//   1. Find IDIT and gps0 top-level boxes by forward-walk.
//   2. Redact gps0 records: translate the track so its first valid fix lands
//      on the 50.0 N / 30.0 E sentinel anchor, PRESERVING the per-record
//      displacement deltas. The parser calibrates the speed unit and course
//      encoding against the trajectory (see internal/navitel-gps0.ts), so a
//      fixture with a fabricated walk would not exercise that path. The
//      absolute position is the PII; the relative shape of a few dozen
//      seconds is already implied by the kept speed/course bytes. No-fix
//      filler rows (implausible coords) pass through untouched.
//   3. Wrap into a minimal MP4: ftyp + tiny moov-stub + IDIT (real bytes)
//      + gps0 (with redacted records). gpsa/gsea/gsen dropped - our extractor
//      doesn't need them.
//
// Real fields kept (not PII): IDIT date string, gps0 record speed/course/
// day/hour/minute/second, padding bytes. Only the lat/lon doubles are
// rewritten.
//
// Usage:
//   node scripts/anonymize-navitel-mov.mjs <input.mov> <output.mov> [numRecords=5]

import { openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";

const GPS0_RECORD_SIZE = 32;

function findTopLevel(fd, fileSize, wantedTypes) {
    const out = new Map();
    let pos = 0;
    while (pos + 8 <= fileSize) {
        const h = readBoxHeader(fd, pos, fileSize);
        if (!h) break;
        if (wantedTypes.has(h.type) && !out.has(h.type)) {
            out.set(h.type, { offset: pos, size: h.size, headerSize: h.headerSize });
        }
        pos += h.size;
    }
    return out;
}

// Convert decimal degrees -> NMEA DDmm.mmmm double.
function degToDDmm(deg) {
    const sign = deg < 0 ? -1 : 1;
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const m = (abs - d) * 60;
    return sign * (d * 100 + m);
}

// Convert NMEA DDmm.mmmm -> decimal degrees (mirror of the parser's ddmm).
function ddmmToDeg(v) {
    const sign = v < 0 ? -1 : 1;
    const abs = Math.abs(v);
    const d = Math.floor(abs / 100);
    return sign * (d + (abs - d * 100) / 60);
}

const [, , inputPath, outputPath, numRecArg] = process.argv;
if (!inputPath || !outputPath) {
    console.error("usage: anonymize-navitel-mov.mjs <input.mov> <output.mov> [numRecords=5]");
    process.exit(1);
}
const numRecords = Number(numRecArg ?? 5);

const stat = statSync(inputPath);
const fd = openSync(inputPath, "r");

const boxes = findTopLevel(fd, stat.size, new Set(["IDIT", "gps0"]));
const iditBox = boxes.get("IDIT");
const gps0Box = boxes.get("gps0");

if (!iditBox || !gps0Box) {
    console.error(`missing tail atoms: IDIT=${!!iditBox} gps0=${!!gps0Box}`);
    process.exit(1);
}

const iditBuf = Buffer.alloc(iditBox.size);
readSync(fd, iditBuf, 0, iditBox.size, iditBox.offset);

const gps0Buf = Buffer.alloc(gps0Box.size);
readSync(fd, gps0Buf, 0, gps0Box.size, gps0Box.offset);

closeSync(fd);

// Redact gps0 records: keep first numRecords with overwritten lat/lon.
const payloadStart = gps0Box.headerSize;
const payloadLen = gps0Box.size - payloadStart;
const recordCount = Math.floor(payloadLen / GPS0_RECORD_SIZE);
const keepCount = Math.min(numRecords, recordCount);

const baseLatDeg = 50.0;
const baseLonDeg = 30.0;
// Anchor = the first valid fix among the kept records; every valid record is
// translated by (anchor -> base), which keeps the real displacement chain.
let anchorLatDeg = null;
let anchorLonDeg = null;
for (let i = 0; i < keepCount; i++) {
    const off = payloadStart + i * GPS0_RECORD_SIZE;
    const latDeg = ddmmToDeg(gps0Buf.readDoubleLE(off));
    const lonDeg = ddmmToDeg(gps0Buf.readDoubleLE(off + 8));
    const validFix =
        Number.isFinite(latDeg) &&
        Number.isFinite(lonDeg) &&
        Math.abs(latDeg) <= 90 &&
        Math.abs(lonDeg) <= 180 &&
        !(latDeg === 0 && lonDeg === 0);
    if (!validFix) continue; // no-fix filler row, nothing to redact
    if (anchorLatDeg === null) {
        anchorLatDeg = latDeg;
        anchorLonDeg = lonDeg;
    }
    gps0Buf.writeDoubleLE(degToDDmm(baseLatDeg + latDeg - anchorLatDeg), off);
    gps0Buf.writeDoubleLE(degToDDmm(baseLonDeg + lonDeg - anchorLonDeg), off + 8);
}

// Trim gps0 to keepCount records.
const trimmedPayloadLen = keepCount * GPS0_RECORD_SIZE;
const newGps0Size = payloadStart + trimmedPayloadLen;
const gps0Header = Buffer.alloc(8);
gps0Header.writeUInt32BE(newGps0Size, 0);
fourCC("gps0").copy(gps0Header, 4);
const gps0Final = Buffer.concat([gps0Header, gps0Buf.subarray(payloadStart, payloadStart + trimmedPayloadLen)]);

// Minimal MP4 wrapper: ftyp + tiny-moov-stub + IDIT + gps0.
const ftyp = box("ftyp", Buffer.concat([fourCC("qt  "), u32be(0), fourCC("qt  ")]));
// Minimal moov with empty mvhd payload - our extractor doesn't touch moov,
// this is only here so Mp4Index doesn't choke.
const mvhd = box("mvhd", Buffer.alloc(108));
const moov = box("moov", mvhd);

const out = Buffer.concat([ftyp, moov, iditBuf, gps0Final]);
writeFileSync(outputPath, out);
console.error(`wrote ${out.length} bytes (${keepCount} gps0 records) to ${outputPath}`);

#!/usr/bin/env node
import { findByteOffsets, box, fourCC, u32be } from "./_mp4-fixture.mjs";
// Anonymize a Vantrue N2X MP4 into a public-safe fixture:
// 1. Scan the file for freeGPS markers (Vantrue's NMEA-embedded variant).
// 2. Take the first N blocks, find the $GNRMC/$GPRMC sentence in each,
//    replace lat/lon with a sentinel (50.0 N / 30.0 E + tiny offset per record).
// 3. Pre-NMEA binary preamble (lat/lon doubles, datetime metadata bytes
//    0..99) - zero-fill (PII in the real file).
// 4. Pack into a minimal MP4 (ftyp + free boxes + moov stub).
//
// Usage:
//   node scripts/anonymize-vantrue-mp4.mjs <input.mp4> <output.mp4> [numBlocks]

import { openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";

const SCAN_LIMIT = 64 << 20;
const MAGIC = Buffer.from("freeGPS ");

// NMEA checksum: XOR of all bytes between $ and *.
function nmeaChecksum(body) {
    let xor = 0;
    for (let i = 0; i < body.length; i++) xor ^= body.charCodeAt(i);
    return xor.toString(16).toUpperCase().padStart(2, "0");
}

// Build sentinel RMC: time = "180617.000", date = "070625", coords = sentinel + idx offset.
function buildSentinelRmc(idx) {
    const sec = 17 + idx;
    const time = `1806${String(sec).padStart(2, "0")}.000`;
    const date = "070625"; // 2025-06-07
    // DDmm.mmmm format: 50.0 N -> 5000.00000, 30.0 E -> 03000.00000.
    // Per-record offset: +0.0001° per second.
    const latDeg = 50 + idx * 0.0001;
    const lonDeg = 30 + idx * 0.0001;
    const latDdmm = (Math.floor(latDeg) * 100 + (latDeg - Math.floor(latDeg)) * 60).toFixed(5).padStart(10, "0");
    const lonDdmm = (Math.floor(lonDeg) * 100 + (lonDeg - Math.floor(lonDeg)) * 60).toFixed(5).padStart(11, "0");
    const speedKn = "10.0";
    const course = "45.0";
    const body = `GNRMC,${time},A,${latDdmm},N,${lonDdmm},E,${speedKn},${course},${date},,,A`;
    return `$${body}*${nmeaChecksum(body)}\r\n`;
}

// Anonymize one freeGPS-block: zero-fill binary preamble (PII), replace NMEA
// sentence with sentinel.
function anonymizeBlock(orig, idx) {
    // Vantrue freeGPS block structure (verified probe):
    //   [0..7]    "freeGPS " magic
    //   [8..11]   block size LE (~232 = 0xe8)
    //   [12..15]  discriminator (0x11)
    //   [16..99]  binary: lat double, lon double, datetime metadata (PII!)
    //   [100..]   ASCII NMEA RMC sentence " $GNRMC,...*XX\r\n"
    //
    // The parser scans for $G[NPL]RMC and parses it as NMEA.
    // For anonymize: keep magic + block size, zero binary [16..99], replace
    // NMEA payload with sentinel. Total block size in the file = up to the
    // next freeGPS marker (or 256 bytes for a compact fixture).
    const out = Buffer.alloc(256);
    // magic
    out.write("freeGPS ", 0, 8, "ascii");
    // block size (informational) - keep original
    if (orig.length >= 12) orig.copy(out, 8, 8, 12);
    // discriminator - keep original (for symmetry with real bytes)
    if (orig.length >= 16) orig.copy(out, 12, 12, 16);
    // bytes 16..99: zero-fill (binary preamble was PII).
    // bytes 100..: sentinel NMEA.
    const sentence = buildSentinelRmc(idx);
    out.write(sentence, 100, "ascii");
    return out;
}

const [, , inputPath, outputPath, numBlocksArg] = process.argv;
if (!inputPath || !outputPath) {
    console.error("usage: anonymize-vantrue-mp4.mjs <input.mp4> <output.mp4> [numBlocks=3]");
    process.exit(1);
}
const numBlocks = Number(numBlocksArg ?? 3);

const fd = openSync(inputPath, "r");
const stat = statSync(inputPath);
const scanEnd = Math.min(stat.size, SCAN_LIMIT);
const scanBuf = Buffer.alloc(scanEnd);
readSync(fd, scanBuf, 0, scanEnd, 0);
const offsets = findByteOffsets(scanBuf, MAGIC, scanEnd);
console.error(`found ${offsets.length} freeGPS markers`);
if (offsets.length === 0) {
    console.error("no markers found");
    process.exit(1);
}

const blockReader = Buffer.alloc(512);
const newBlocks = [];
for (let i = 0; i < offsets.length && newBlocks.length < numBlocks; i++) {
    readSync(fd, blockReader, 0, 512, offsets[i]);
    // Sanity: check the block has an NMEA marker (this is Vantrue's NMEA variant).
    const nmeaIdx = blockReader.indexOf("$G");
    if (nmeaIdx < 0 || nmeaIdx > 200) continue;
    newBlocks.push(anonymizeBlock(blockReader, newBlocks.length));
}
closeSync(fd);

if (newBlocks.length === 0) {
    console.error("no NMEA-style freeGPS blocks found");
    process.exit(1);
}
console.error(`anonymized ${newBlocks.length} blocks`);

// Wrap into minimal MP4: ftyp + free-boxes + moov stub.
const ftyp = box("ftyp", Buffer.concat([fourCC("isom"), u32be(512), fourCC("isom"), fourCC("avc1"), fourCC("mp41")]));
const freeBoxes = newBlocks.map((b) => box("free", b));
const mvhd = box("mvhd", Buffer.alloc(108));
const moov = box("moov", mvhd);

const out = Buffer.concat([ftyp, ...freeBoxes, moov]);
writeFileSync(outputPath, out);
console.error(`wrote ${out.length} bytes to ${outputPath}`);

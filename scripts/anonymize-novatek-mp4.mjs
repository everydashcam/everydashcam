#!/usr/bin/env node
import { findByteOffsets, box, fourCC, u32be } from "./_mp4-fixture.mjs";
// Anonymize a real Novatek freeGPS MP4 into a public-safe fixture:
// 1. Extract first N freeGPS blocks (each 256-byte slice from real file).
// 2. Round lat/lon DDmm-floats to whole degrees (50.0 N / 30.0 E - sentinel
//    coords clearly outside any real city).
// 3. Wrap into a minimal MP4 container (ftyp + free-boxes + moov stub).
//
// Usage:
//   node scripts/anonymize-novatek-mp4.mjs <input.mp4> <output.mp4> [numBlocks]
//
// Real bytes (preamble, padding, structure) preserved - only coord-floats
// replaced. Datetime fields kept as-is (year/month/day/H/M/S - not PII).
//
// Coordinate sentinels chosen for clarity:
//   - DDmm float for 50.0° N = 5000.00000
//   - DDmm float for 30.0° E = 3000.00000
//   - Each subsequent block adds tiny offset so synthetic trip "moves":
//     +0.00010° per record (~10m), ~corresponds to real driving cadence.

import { openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";

const SCAN_LIMIT = 64 << 20;
const BLOCK_SIZE = 256;
const MAGIC = Buffer.from("freeGPS ");

function pickLayoutByActive(block) {
    // Same logic as src/parsers/_internal/freegps.ts: try active@68 (default),
    // active@40 (legacy), active@36 (alt). Return offsets-tuple or null.
    const candidates = [
        {
            name: "default",
            datetime: 44,
            active: 68,
            ns: 69,
            ew: 70,
            lat: 72,
            lon: 76,
            speed: 80,
            course: 84,
            accel: null,
        },
        {
            name: "legacy",
            datetime: 16,
            active: 40,
            ns: 41,
            ew: 42,
            lat: 44,
            lon: 48,
            speed: 52,
            course: 56,
            accel: 60,
        },
        { name: "alt", datetime: 12, active: 36, ns: 37, ew: 38, lat: 40, lon: 44, speed: 48, course: 52, accel: null },
    ];
    for (const l of candidates) {
        const a = block[l.active];
        const ns = block[l.ns];
        const ew = block[l.ew];
        if ((a === 0x41 || a === 0x56) && (ns === 0x4e || ns === 0x53) && (ew === 0x45 || ew === 0x57)) {
            return l;
        }
    }
    return null;
}

function ddmm(deg) {
    const abs = Math.abs(deg);
    return Math.floor(abs) * 100 + (abs - Math.floor(abs)) * 60;
}

const [, , inputPath, outputPath, numBlocksArg] = process.argv;
if (!inputPath || !outputPath) {
    console.error("usage: anonymize-novatek-mp4.mjs <input.mp4> <output.mp4> [numBlocks=3]");
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
    console.error("no markers found - aborting");
    process.exit(1);
}

// Find first numBlocks blocks with active fix.
const activeBlocks = [];
for (let i = 0; i < offsets.length && activeBlocks.length < numBlocks; i++) {
    const block = Buffer.alloc(BLOCK_SIZE);
    readSync(fd, block, 0, BLOCK_SIZE, offsets[i]);
    const layout = pickLayoutByActive(block);
    if (!layout) continue;
    if (block[layout.active] !== 0x41) continue; // 'A' fix only
    activeBlocks.push({ block, layout, originalOffset: offsets[i] });
}
closeSync(fd);

if (activeBlocks.length === 0) {
    console.error(`no active-fix blocks found in first ${offsets.length} markers - cannot anonymize`);
    process.exit(1);
}
console.error(`anonymizing ${activeBlocks.length} active blocks (layout: ${activeBlocks[0].layout.name})`);

// Replace coordinates in each block.
const baseLatDeg = 50.0;
const baseLonDeg = 30.0;
for (let i = 0; i < activeBlocks.length; i++) {
    const { block, layout } = activeBlocks[i];
    const latDeg = baseLatDeg + i * 0.0001;
    const lonDeg = baseLonDeg + i * 0.0001;
    block.writeFloatLE(ddmm(latDeg), layout.lat);
    block.writeFloatLE(ddmm(lonDeg), layout.lon);
    block[layout.ns] = "N".charCodeAt(0);
    block[layout.ew] = "E".charCodeAt(0);
    // Speed and course - leave as-is; they aren't personal anyway.
}

// Wrap into minimal MP4.
const ftyp = box("ftyp", Buffer.concat([fourCC("isom"), u32be(512), fourCC("isom"), fourCC("avc1"), fourCC("mp41")]));
const freeBoxes = activeBlocks.map(({ block }) => box("free", block));
const mvhd = box("mvhd", Buffer.alloc(108));
const moov = box("moov", mvhd);
const out = Buffer.concat([ftyp, ...freeBoxes, moov]);

writeFileSync(outputPath, out);
console.error(`wrote ${out.length} bytes to ${outputPath}`);

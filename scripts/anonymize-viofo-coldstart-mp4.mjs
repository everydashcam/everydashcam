#!/usr/bin/env node
import { findByteOffsets, box, fourCC, u32be } from "./_mp4-fixture.mjs";
// Anonymize a real Novatek freeGPS MP4 that STARTS UNSYNCED into a
// public-safe cold-start fixture: unlike anonymize-novatek-mp4.mjs (which
// keeps only active-fix blocks), this keeps the pre-fix RTC blocks
// immediately before the first fix - they carry the clock-jump evidence the
// local-as-UTC correction measures (see coldStartClockJumpSec in
// src/parsers/internal/freegps.ts).
//
// Usage:
//   node scripts/anonymize-viofo-coldstart-mp4.mjs <input.mp4> <output.mp4> [preFix=4] [active=4]
//
// Anonymization contract (same as anonymize-novatek-mp4.mjs):
//   - active blocks: lat/lon replaced with the 50.0N/30.0E sentinel (+tiny
//     per-record drift), hemispheres forced to N/E; datetime/speed/course
//     preserved (not PII, and the datetimes ARE the fixture's subject);
//   - pre-fix blocks: verified to carry NO coordinates (the fix region must
//     be all zero) and copied verbatim - the script aborts otherwise.

import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";

const SCAN_LIMIT = 512 << 20;
const BLOCK_SIZE = 256;
const MAGIC = Buffer.from("freeGPS ");

// Fixed Type-3 sub-layouts (literal offsets), mirroring pickLayout in
// src/parsers/internal/freegps.ts.
const LAYOUTS = [
    { name: "default", datetime: 44, active: 68, ns: 69, ew: 70, lat: 72, lon: 76 },
    { name: "legacy", datetime: 16, active: 40, ns: 41, ew: 42, lat: 44, lon: 48 },
    { name: "alt", datetime: 12, active: 36, ns: 37, ew: 38, lat: 40, lon: 44 },
];

function pickLayoutByActive(block) {
    for (const l of LAYOUTS) {
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

const [, , inputPath, outputPath, preFixArg, activeArg] = process.argv;
if (!inputPath || !outputPath) {
    console.error("usage: anonymize-viofo-coldstart-mp4.mjs <input.mp4> <output.mp4> [preFix=4] [active=4]");
    process.exit(1);
}
const wantPreFix = Number(preFixArg ?? 4);
const wantActive = Number(activeArg ?? 4);

const fd = openSync(inputPath, "r");
const stat = statSync(inputPath);
const scanEnd = Math.min(stat.size, SCAN_LIMIT);
const scanBuf = Buffer.alloc(scanEnd);
readSync(fd, scanBuf, 0, scanEnd, 0);

const offsets = findByteOffsets(scanBuf, MAGIC);
console.error(`found ${offsets.length} freeGPS markers`);

const blocks = offsets.map((o) => {
    const block = Buffer.alloc(BLOCK_SIZE);
    readSync(fd, block, 0, BLOCK_SIZE, o);
    return block;
});
closeSync(fd);

// First block with a valid active-'A' signature = the first fix.
const firstFixIdx = blocks.findIndex((b) => {
    const layout = pickLayoutByActive(b);
    return layout !== null && b[layout.active] === 0x41;
});
if (firstFixIdx <= 0) {
    console.error("no cold-start transition found (file starts synced or never syncs) - aborting");
    process.exit(1);
}

const preFixBlocks = blocks.slice(Math.max(0, firstFixIdx - wantPreFix), firstFixIdx);
const activeBlocks = blocks.slice(firstFixIdx, firstFixIdx + wantActive);
const layout = pickLayoutByActive(activeBlocks[0]);
console.error(
    `transition at block ${firstFixIdx}; keeping ${preFixBlocks.length} pre-fix + ${activeBlocks.length} active (layout: ${layout.name})`,
);

// Pre-fix blocks must carry no fix data: everything past the status triple is
// zero on the known firmware. A nonzero byte means unknown content - refuse
// to publish it.
for (const block of preFixBlocks) {
    for (let i = layout.lat; i < BLOCK_SIZE; i++) {
        if (block[i] !== 0) {
            console.error(`pre-fix block carries nonzero byte at ${i} - refusing to publish unknown content`);
            process.exit(1);
        }
    }
}

// Sentinel coordinates in the active blocks.
for (let i = 0; i < activeBlocks.length; i++) {
    const block = activeBlocks[i];
    block.writeFloatLE(ddmm(50.0 + i * 0.0001), layout.lat);
    block.writeFloatLE(ddmm(30.0 + i * 0.0001), layout.lon);
    block[layout.ns] = "N".charCodeAt(0);
    block[layout.ew] = "E".charCodeAt(0);
}

const ftyp = box("ftyp", Buffer.concat([fourCC("isom"), u32be(512), fourCC("isom"), fourCC("avc1"), fourCC("mp41")]));
const freeBoxes = [...preFixBlocks, ...activeBlocks].map((block) => box("free", block));
const moov = box("moov", box("mvhd", Buffer.alloc(108)));
const out = Buffer.concat([ftyp, ...freeBoxes, moov]);
writeFileSync(outputPath, out);
console.error(`wrote ${out.length} bytes to ${outputPath}`);

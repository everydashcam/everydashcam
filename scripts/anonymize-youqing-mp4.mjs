#!/usr/bin/env node
import { box, fourCC } from "./_mp4-fixture.mjs";
// Build a public-safe YOUQINGGPS fixture from a real MP4. Known telemetry
// fields are copied, coordinates are rounded to whole degrees, and every
// unknown field is zeroed because the format carries opaque identifiers and
// coordinate-like doubles outside the decoded record.
//
// Usage: node scripts/anonymize-youqing-mp4.mjs <input.mp4> <output.mp4> [numBlocks]

import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";

const SCAN_LIMIT = 64 << 20;
const READ_SIZE = 160;
const ATOM_SIZE = 0x4000;
const MAGIC = Buffer.from("freeGPS ");
const BANNER = Buffer.from("YOUQINGGPS");

function ddmmToDegrees(value) {
    const degrees = Math.floor(value / 100);
    const minutes = value - degrees * 100;
    return degrees + minutes / 60;
}

function isYouqingFix(block) {
    if (!block.subarray(0, 8).equals(MAGIC)) return false;
    if (!block.subarray(12, 22).equals(BANNER)) return false;
    if (block[68] !== 0x41) return false;
    if (block[69] !== 0x4e && block[69] !== 0x53) return false;
    if (block[70] !== 0x45 && block[70] !== 0x57) return false;
    const lat = block.readFloatLE(36);
    const lon = block.readFloatLE(40);
    return Number.isFinite(lat) && Number.isFinite(lon) && lat > 0 && lon > 0;
}

function anonymizeBlock(source) {
    const out = Buffer.alloc(READ_SIZE);
    source.copy(out, 0, 0, 22); // magic, declared payload size, format banner
    source.copy(out, 44, 44, 71); // UTC fields and A/NS/EW status
    source.copy(out, 92, 92, 100); // speed in knots and course
    source.copy(out, 132, 132, 156); // camera-local OSD clock

    const latDegrees = Math.round(ddmmToDegrees(source.readFloatLE(36)));
    const lonDegrees = Math.round(ddmmToDegrees(source.readFloatLE(40)));
    out.writeFloatLE(Math.abs(latDegrees) * 100, 36);
    out.writeFloatLE(Math.abs(lonDegrees) * 100, 40);
    return out;
}

function fixedFreeAtom(block) {
    const atom = Buffer.alloc(ATOM_SIZE);
    atom.writeUInt32BE(ATOM_SIZE, 0);
    block.copy(atom, 4);
    return atom;
}

function canonicalGpsTable(offsets) {
    const payload = Buffer.alloc(8 + offsets.length * 8);
    payload.writeUInt32BE(0x00000101, 0);
    payload.writeUInt32BE(offsets.length, 4);
    for (let i = 0; i < offsets.length; i++) {
        payload.writeUInt32BE(offsets[i], 8 + i * 8);
        payload.writeUInt32BE(ATOM_SIZE, 12 + i * 8);
    }
    return box("gps ", payload);
}

const [, , inputPath, outputPath, countArg] = process.argv;
if (!inputPath || !outputPath) {
    console.error("usage: anonymize-youqing-mp4.mjs <input.mp4> <output.mp4> [numBlocks=5]");
    process.exit(1);
}

const requested = Number(countArg ?? 5);
if (!Number.isInteger(requested) || requested < 1 || requested > 20) {
    console.error("numBlocks must be an integer from 1 to 20");
    process.exit(1);
}

const fd = openSync(inputPath, "r");
const scanSize = Math.min(statSync(inputPath).size, SCAN_LIMIT);
const scan = Buffer.alloc(scanSize);
readSync(fd, scan, 0, scan.length, 0);

const blocks = [];
let offset = -1;
while (blocks.length < requested) {
    offset = scan.indexOf(MAGIC, offset + 1);
    if (offset === -1) break;
    const source = Buffer.alloc(READ_SIZE);
    readSync(fd, source, 0, source.length, offset);
    if (!isYouqingFix(source)) continue;
    blocks.push(anonymizeBlock(source));
}
closeSync(fd);

if (blocks.length !== requested) {
    console.error(`found ${blocks.length} valid YOUQINGGPS blocks, need ${requested}`);
    process.exit(1);
}

const ftyp = box("ftyp", Buffer.concat([fourCC("isom"), Buffer.from([0, 0, 2, 0]), fourCC("isommp42")]));
const freeAtoms = blocks.map(fixedFreeAtom);
const offsets = freeAtoms.map((_, index) => ftyp.length + index * ATOM_SIZE);
const moov = box("moov", Buffer.concat([box("mvhd", Buffer.alloc(108)), canonicalGpsTable(offsets)]));
const output = Buffer.concat([ftyp, ...freeAtoms, moov]);

writeFileSync(outputPath, output);
console.error(`wrote ${blocks.length} anonymized blocks (${output.length} bytes)`);

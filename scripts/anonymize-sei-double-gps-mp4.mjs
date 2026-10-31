#!/usr/bin/env node
import { box } from "./_mp4-fixture.mjs";
// Build a metadata-only MP4 fixture. No source video, audio, other tracks,
// or proprietary file trailer is copied into the result.

import { readFileSync, writeFileSync } from "node:fs";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
    throw new Error("usage: anonymize-sei-double-gps-mp4.mjs <input.mp4> <output.mp4>");
}

const source = readFileSync(inputPath);

function* boxes(buffer, start, end) {
    let pos = start;
    while (pos + 8 <= end) {
        const size = buffer.readUInt32BE(pos);
        if (size < 8 || pos + size > end) throw new Error("invalid mp4 box");
        yield { type: buffer.toString("ascii", pos + 4, pos + 8), start: pos, end: pos + size };
        pos += size;
    }
    if (pos !== end) throw new Error("trailing mp4 box bytes");
}

function child(buffer, parent, type) {
    for (const item of boxes(buffer, parent.start + 8, parent.end)) {
        if (item.type === type) return item;
    }
    return null;
}

function path(buffer, parent, ...types) {
    let current = parent;
    for (const type of types) {
        current = child(buffer, current, type);
        if (!current) return null;
    }
    return current;
}

const top = [...boxes(source, 0, source.length)];
const ftyp = top.find((item) => item.type === "ftyp");
const moov = top.find((item) => item.type === "moov");
if (!ftyp || !moov) throw new Error("source needs ftyp and moov");
const mvhd = child(source, moov, "mvhd");
if (!mvhd) throw new Error("source needs mvhd");

let gpsTrack = null;
let sourceOffsets = null;
for (const item of boxes(source, moov.start + 8, moov.end)) {
    if (item.type !== "trak") continue;
    const stbl = path(source, item, "mdia", "minf", "stbl");
    if (!stbl) continue;
    const stsd = child(source, stbl, "stsd");
    const stsz = child(source, stbl, "stsz");
    const stsc = child(source, stbl, "stsc");
    const stco = child(source, stbl, "stco");
    if (!stsd || !stsz || !stsc || !stco) continue;
    const format = source.toString("ascii", stsd.start + 20, stsd.start + 24);
    const count = source.readUInt32BE(stsz.start + 16);
    const chunkCount = source.readUInt32BE(stco.start + 12);
    if (
        format !== "hvc1" ||
        count < 2 ||
        count !== chunkCount ||
        source.readUInt32BE(stsc.start + 12) !== 1 ||
        source.readUInt32BE(stsc.start + 20) !== 1 ||
        source.readUInt32BE(stsz.start + 12) !== 0
    )
        continue;
    const sizes = Array.from({ length: count }, (_, i) => source.readUInt32BE(stsz.start + 20 + i * 4));
    if (!sizes.every((size) => size === 40)) continue;
    const offsets = Array.from({ length: count }, (_, i) => source.readUInt32BE(stco.start + 16 + i * 4));
    if (!offsets.every((offset) => offset + 40 <= source.length)) continue;
    const first = source.subarray(offsets[0], offsets[0] + 40);
    if (first.readUInt32BE(0) !== 36 || first.readUInt16BE(4) !== 0x4e01 || first.readUInt16BE(6) !== 0xf000) continue;
    gpsTrack = item;
    sourceOffsets = offsets;
    break;
}
if (!gpsTrack || !sourceOffsets) throw new Error("no sei double gps track");

const packets = sourceOffsets.map((offset) => {
    const input = source.subarray(offset, offset + 40);
    if (input.readUInt32BE(0) !== 36 || input.readUInt16BE(4) !== 0x4e01 || input.readUInt16BE(6) !== 0xf000) {
        throw new Error("unexpected packet layout");
    }
    const output = Buffer.alloc(40);
    output.writeUInt32BE(36, 0);
    output.writeUInt16BE(0x4e01, 4);
    output.writeUInt16BE(0xf000, 6);
    output.writeUInt16BE(input.readUInt16BE(8), 8);
    output.writeUInt16BE(0x00b5, 14);
    output.writeUInt16BE(0xff04, 16);
    if (
        "EW".includes(String.fromCharCode(input[18])) &&
        "NS".includes(String.fromCharCode(input[19])) &&
        input[20] === 1
    ) {
        output.write("EN", 18, "ascii");
        output[20] = 1;
        // Whole-degree fictional coordinates cannot disclose the source route.
        output.writeDoubleLE(30, 21);
        output.writeDoubleLE(50, 29);
    } else if (input[18] === 0 && input[19] === 0 && input[20] === 2) {
        output[20] = 2;
    } else {
        throw new Error("unknown gps packet status");
    }
    return output;
});

const ftypBytes = source.subarray(ftyp.start, ftyp.end);
const mdat = box("mdat", Buffer.concat(packets));
const trackBytes = Buffer.from(source.subarray(gpsTrack.start, gpsTrack.end));
const trackRoot = { start: 0, end: trackBytes.length };
const outputStco = path(trackBytes, trackRoot, "mdia", "minf", "stbl", "stco");
if (!outputStco) throw new Error("copied track has no stco");
for (let i = 0; i < packets.length; i++) {
    trackBytes.writeUInt32BE(ftypBytes.length + 8 + i * 40, outputStco.start + 16 + i * 4);
}
const result = Buffer.concat([
    ftypBytes,
    mdat,
    box("moov", Buffer.concat([source.subarray(mvhd.start, mvhd.end), trackBytes])),
]);
writeFileSync(outputPath, result);
console.log(`wrote ${packets.length} redacted gps packets (${result.length} bytes)`);

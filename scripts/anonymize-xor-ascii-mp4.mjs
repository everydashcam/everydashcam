#!/usr/bin/env node
// Extract XOR-0xAA freeGPS records into a public-safe, playable MP4 fixture.
// Coordinates are rounded to whole degrees; labels and unknown payload bytes
// are zeroed. Only the signature, clock, speed and validated accel fields
// survive. Video is generated from testsrc2, with no original audio or metadata.
//
// Usage: node scripts/anonymize-xor-ascii-mp4.mjs <input.mp4> <output.mp4> [startRecord=0]
// startRecord is the zero-based index among complete GPS records.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAGIC = Buffer.from("freeGPS ");
const SIGNATURE = Buffer.from([0xaa, 0xaa, 0xf2, 0xe1, 0xf0, 0xee, 0x54, 0x54]);
const XOR_START = 14;
const XOR_LENGTH = 257;
const RECORD_COUNT = 2;

function xor(bytes) {
    return Buffer.from(Uint8Array.from(bytes, (byte) => byte ^ 0xaa));
}

function roundedCoordinate(digits, width, maximum) {
    const ddmm = Number(digits) / 1e4;
    const degrees = Math.floor(ddmm / 100);
    const minutes = ddmm - degrees * 100;
    if (minutes >= 60 || degrees + minutes / 60 > maximum) throw new Error("invalid coordinate");
    return String(Math.round(degrees + minutes / 60) * 1_000_000).padStart(width, "0");
}

function anonymizeBlock(source) {
    const decoded = xor(source.subarray(XOR_START, XOR_START + XOR_LENGTH));
    const text = decoded.toString("latin1");
    if (!/^.{8}\d{14}.{16}[NS]\d{8}[EW]\d{9}\d{8}/s.test(text)) return null;
    const clean = Buffer.alloc(XOR_LENGTH);
    decoded.copy(clean, 0, 0, 23); // preamble, timestamp and fixed flag
    clean[37] = decoded[37];
    clean[38] = decoded[38];
    clean[47] = decoded[47];
    clean.write(roundedCoordinate(text.slice(39, 47), 8, 90), 39, "ascii");
    clean.write(roundedCoordinate(text.slice(48, 57), 9, 180), 48, "ascii");
    decoded.copy(clean, 57, 57, 65); // inline km/h speed
    for (const offset of [65, 173]) {
        if (/^([-+]\d{3}){3}$/.test(text.slice(offset, offset + 12))) {
            decoded.copy(clean, offset, offset, offset + 12);
        }
    }
    const literal = Buffer.alloc(XOR_START + XOR_LENGTH);
    source.copy(literal, 0, 0, XOR_START);
    xor(clean).copy(literal, XOR_START);
    return literal;
}

const [, , inputPath, outputPath, startRecordArg] = process.argv;
if (!inputPath || !outputPath) {
    throw new Error("usage: anonymize-xor-ascii-mp4.mjs <input.mp4> <output.mp4> [startRecord=0]");
}
const startRecord = Number(startRecordArg ?? 0);
if (!Number.isSafeInteger(startRecord) || startRecord < 0) {
    throw new Error("start record must be a nonnegative integer");
}
const source = readFileSync(inputPath);
const atoms = [];
let offset = -1;
let recordIndex = 0;
while (atoms.length < RECORD_COUNT) {
    offset = source.indexOf(MAGIC, offset + 1);
    if (offset === -1) break;
    if (!source.subarray(offset + XOR_START, offset + XOR_START + SIGNATURE.length).equals(SIGNATURE)) continue;
    if (offset < 4 || offset + XOR_START + XOR_LENGTH > source.length) continue;
    const atomSize = source.readUInt32BE(offset - 4);
    if (atomSize < XOR_START + XOR_LENGTH + 4 || atomSize > 64 * 1024) continue;
    const literal = anonymizeBlock(source.subarray(offset, offset + XOR_START + XOR_LENGTH));
    if (!literal) continue;
    const shouldSkip = recordIndex < startRecord;
    recordIndex += 1;
    if (shouldSkip) continue;
    // Keep the real free atom size and header. The unused region is zeroed,
    // never copied from the source recording.
    const atom = Buffer.alloc(atomSize);
    atom.writeUInt32BE(atomSize, 0);
    literal.copy(atom, 4);
    atoms.push(atom);
}
if (atoms.length !== RECORD_COUNT) throw new Error("not enough complete xor-ascii gps records");

const work = mkdtempSync(join(tmpdir(), "xor-ascii-fixture-"));
try {
    const videoPath = join(work, "video.mp4");
    execFileSync("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=2:duration=2",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-map_metadata",
        "-1",
        "-movflags",
        "+faststart",
        videoPath,
    ]);
    const output = Buffer.concat([readFileSync(videoPath), ...atoms]);
    writeFileSync(outputPath, output);
    console.error(`wrote ${atoms.length} anonymized gps records (${output.length} bytes)`);
} finally {
    rmSync(work, { recursive: true, force: true });
}

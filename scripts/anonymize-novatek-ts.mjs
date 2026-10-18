#!/usr/bin/env node
// Anonymizes a Novatek-TS file (MPEG-TS with the Novatek GPS record struct in
// a private PES - see docs/format-novatek-ts.md) into a snapshot fixture.
//
// Strategy (differs from anonymize-juscar-ts.mjs on purpose): the GPS PES in
// this format is NOT advertised in the PMT, so ffmpeg cannot -map/-c:d copy
// it reliably. Instead of recoding the original container we:
//   1. Extract N GPS PES packet groups (all 6 TS packets each, byte-exact -
//      PES header, continuation split and AF stuffing are the container quirks
//      the fixture exists to preserve). When a clip starts without a fix, keep
//      the last three no-fix groups and the first fixed groups.
//   2. Patch the coordinates in each PUSI packet to a moving sentinel
//      (50 N / 30 E + i*0.0001 deg, the repo-wide convention). Timestamps
//      are kept (not sensitive without coordinates); speed/course are kept
//      too - a few seconds of motion data with no origin is not identifying,
//      and real values keep the unit-conversion assertions meaningful.
//   3. Generate a fresh synthetic HEVC/H.264+AAC MPEG-TS base via ffmpeg (testsrc2
//      + sine, mirroring anonymize-ts-generic.mjs) - no original video/audio
//      bytes reach the fixture at all.
//   4. Interleave the patched GPS groups into the base at ~1 s spacing.
//
// Dependencies: ffmpeg in PATH.
//
// Usage:
//   node scripts/anonymize-novatek-ts.mjs <input.ts> <output.ts> [records=10] [hevc|h264]
// Use H.264 for browser GPS checks that must run without OS-specific HEVC support.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const [, , inputPath, outputPath, recordsArg, codecArg] = process.argv;
if (!inputPath || !outputPath) {
    console.error("usage: anonymize-novatek-ts.mjs <input.ts> <output.ts> [records=10] [hevc|h264]");
    process.exit(1);
}
if (!existsSync(inputPath)) {
    console.error(`input not found: ${inputPath}`);
    process.exit(1);
}
const maxRecords = Number(recordsArg ?? 10);
const codec = codecArg ?? "hevc";
if (!["hevc", "h264"].includes(codec)) {
    console.error(`invalid video codec: ${codec}`);
    process.exit(1);
}
if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) {
    console.error(`invalid records count: ${recordsArg}`);
    process.exit(1);
}

const TS_SIZE = 188;
const TS_SYNC = 0x47;
const SENTINEL_LAT = 50; // degrees N
const SENTINEL_LON = 30; // degrees E

// ---- step 1: collect GPS PES packet groups from the input ----

const input = readFileSync(inputPath);
const allGroups = []; // Array<{ packets: Buffer[], isActive: boolean }>
let gpsPid = null;
let current = null;

for (let off = 0; off + TS_SIZE <= input.length; off += TS_SIZE) {
    if (input[off] !== TS_SYNC) continue;
    const b1 = input[off + 1];
    const pid = ((b1 & 0x1f) << 8) | input[off + 2];
    const pusi = (b1 & 0x40) !== 0;
    if (gpsPid !== null && pid !== gpsPid) continue;
    if (pusi) {
        if (current) {
            allGroups.push(current);
            current = null;
        }
        const bodyOff = pesBodyOffset(input, off);
        if (bodyOff !== null && isGpsRecordAt(input, bodyOff, off + TS_SIZE)) {
            gpsPid = pid;
            current = {
                packets: [Buffer.from(input.subarray(off, off + TS_SIZE))],
                isActive: input[bodyOff + 24] === 0x41,
            };
        }
    } else if (current) {
        current.packets.push(Buffer.from(input.subarray(off, off + TS_SIZE)));
    }
}
if (current) allGroups.push(current);

if (allGroups.length === 0) {
    console.error("no gps pes found in input - not a novatek-ts file?");
    process.exit(1);
}
const firstActive = allGroups.findIndex((group) => group.isActive);
const start = firstActive > 0 ? Math.max(0, firstActive - Math.min(3, maxRecords - 1)) : 0;
const groups = allGroups.slice(start, start + maxRecords);
console.error(`collected ${groups.length} of ${allGroups.length} gps pes groups on pid 0x${gpsPid.toString(16)}`);

// ---- step 2: patch coordinates to the moving sentinel ----

function ddmm(deg) {
    const abs = Math.abs(deg);
    return Math.floor(abs) * 100 + (abs - Math.floor(abs)) * 60;
}

let activeIdx = 0;
groups.forEach((group) => {
    const pusiPkt = group.packets[0];
    const bodyOff = pesBodyOffset(pusiPkt, 0);
    if (!group.isActive) {
        // A void fix can retain the receiver's last known coordinates.
        pusiPkt.fill(0, bodyOff + 28, bodyOff + 36);
        return;
    }
    pusiPkt[bodyOff + 25] = "N".charCodeAt(0);
    pusiPkt[bodyOff + 26] = "E".charCodeAt(0);
    pusiPkt.writeFloatLE(ddmm(SENTINEL_LAT + activeIdx * 0.0001), bodyOff + 28);
    pusiPkt.writeFloatLE(ddmm(SENTINEL_LON + activeIdx * 0.0001), bodyOff + 32);
    activeIdx++;
});
console.error(`patched coordinates to sentinel ${SENTINEL_LAT}N/${SENTINEL_LON}E in ${activeIdx} records`);

// ---- step 3: synthetic video base ----

const baseTmp = `${outputPath}.base.ts`;
const durationSec = groups.length;
const ffArgs = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=320x180:rate=30:duration=${durationSec}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=1000:sample_rate=16000:duration=${durationSec}`,
    "-c:v",
    codec === "hevc" ? "libx265" : "libx264",
    "-preset",
    "ultrafast",
    ...(codec === "hevc" ? ["-x265-params", "log-level=error:crf=35"] : ["-crf", "35"]),
    "-pix_fmt",
    "yuv420p",
    ...(codec === "hevc" ? ["-tag:v", "hvc1"] : []),
    "-c:a",
    "aac",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "16k",
    "-f",
    "mpegts",
    baseTmp,
];
const ff = spawnSync("ffmpeg", ffArgs, { stdio: ["ignore", "ignore", "inherit"] });
if (ff.status !== 0) {
    console.error("ffmpeg failed");
    process.exit(1);
}

// ---- step 4: interleave GPS groups into the base at ~1 s spacing ----

const base = readFileSync(baseTmp);
const basePackets = Math.floor(base.length / TS_SIZE);
const stride = Math.max(1, Math.floor(basePackets / (groups.length + 1)));
const parts = [];
let cursor = 0;
groups.forEach((group, i) => {
    const upTo = Math.min((i + 1) * stride * TS_SIZE, base.length);
    parts.push(base.subarray(cursor, upTo));
    cursor = upTo;
    parts.push(...group.packets);
});
parts.push(base.subarray(cursor));
writeFileSync(outputPath, Buffer.concat(parts));
unlinkSync(baseTmp);
console.error(`done -> ${outputPath} (${Buffer.concat(parts).length} bytes)`);

// ---- helpers (same packet walk as internal/novatek-ts-extract.ts) ----

function pesBodyOffset(buf, off) {
    const b3 = buf[off + 3];
    const af = (b3 & 0x30) >> 4;
    if (af === 2) return null;
    let payOff = off + 4;
    if (af === 3) payOff += 1 + buf[payOff];
    if (payOff + 6 > off + TS_SIZE) return null;
    if (buf[payOff] !== 0 || buf[payOff + 1] !== 0 || buf[payOff + 2] !== 1) return null;
    const streamId = buf[payOff + 3];
    if (streamId === 0xbf) return payOff + 6;
    if (payOff + 9 > off + TS_SIZE) return null;
    return payOff + 9 + buf[payOff + 8];
}

function isGpsRecordAt(buf, off, end) {
    if (off + 44 > end) return false;
    const fix = buf[off + 24];
    if (fix !== 0x41 && fix !== 0x56) return false;
    const ns = buf[off + 25];
    const ew = buf[off + 26];
    if (fix === 0x56 && ns === 0x30 && ew === 0x30 && buf[off + 27] === 0) {
        for (let i = off + 28; i < off + 44; i++) {
            if (buf[i] !== 0) return false;
        }
        return true;
    }
    if (ns !== 0x4e && ns !== 0x53) return false;
    if (ew !== 0x45 && ew !== 0x57) return false;
    if (buf[off + 27] !== 0) return false;
    const h = buf.readUInt32LE(off);
    const mi = buf.readUInt32LE(off + 4);
    const s = buf.readUInt32LE(off + 8);
    const y = buf.readUInt32LE(off + 12);
    const mo = buf.readUInt32LE(off + 16);
    const d = buf.readUInt32LE(off + 20);
    if (h > 23 || mi > 59 || s > 59) return false;
    if (!((y <= 99 || (y >= 2000 && y <= 2099)) && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return false;
    return true;
}

#!/usr/bin/env node
import { box, fourCC, u32be } from "./_mp4-fixture.mjs";
// Anonymize a Vueroid TXET MP4 into a public-safe fixture:
// 1. Walk the moov, find the 'tvxt'/'mp4s' track (72-byte GPS samples).
// 2. Take the first N fix samples + the file's final zeroed terminator row.
// 3. Replace lat/lon with a sentinel (50.0 N / 30.0 W-or-E per the file's
//    own hemisphere flags, +0.0001 deg per clock second). Everything else -
//    accel, speed, altitude, flags, timestamps - is kept verbatim
//    (timestamps are not sensitive without coordinates; the rest carries
//    real firmware quirks the tests should see).
// 4. Pack into a minimal MP4: ftyp + the original freeRECO config boxes
//    (codec/track config, no PII) + a rebuilt tvxt-only moov (mvhd
//    creation_time and the real per-sample stts deltas preserved) + mdat.
//
// Usage:
//   node scripts/anonymize-vueroid-mp4.mjs <input.mp4> <output.mp4> [numFixSamples=60]

import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";

const SAMPLE_SIZE = 72;
const OFF_LAT = 0x3c;
const OFF_LON = 0x40;
const OFF_UNIX = 0x44;

function readAt(fd, off, len) {
    const b = Buffer.alloc(len);
    const n = readSync(fd, b, 0, len, off);
    return b.subarray(0, n);
}

function* iterBoxes(buf, start, end) {
    let pos = start;
    while (pos + 8 <= end) {
        const size = buf.readUInt32BE(pos);
        const type = buf.toString("latin1", pos + 4, pos + 8);
        if (size < 8 || pos + size > end) return;
        yield { type, start: pos, end: pos + size, payloadStart: pos + 8 };
        pos += size;
    }
}
function findBox(buf, start, end, type) {
    for (const b of iterBoxes(buf, start, end)) if (b.type === type) return b;
    return null;
}

const [, , inputPath, outputPath, numArg] = process.argv;
if (!inputPath || !outputPath) {
    console.error("usage: anonymize-vueroid-mp4.mjs <input.mp4> <output.mp4> [numFixSamples=60]");
    process.exit(1);
}
const numFixSamples = Number(numArg ?? 60);

const fd = openSync(inputPath, "r");
const fileSize = statSync(inputPath).size;

// Top-level walk: locate moov and the small head 'free' boxes whose payload
// starts with "RECO" (device config - kept verbatim, carries no location).
let moovOff = null;
let moovSize = null;
const recoBoxes = [];
{
    let pos = 0;
    while (pos + 8 <= fileSize) {
        const hdr = readAt(fd, pos, 8);
        if (hdr.length < 8) break;
        const size = hdr.readUInt32BE(0);
        const type = hdr.toString("latin1", 4, 8);
        if (size < 8) break;
        if (type === "moov") {
            moovOff = pos;
            moovSize = size;
        }
        if (type === "free" && size <= 256 && pos < 4096) {
            const payload = readAt(fd, pos + 8, size - 8);
            if (payload.toString("latin1", 0, 4) === "RECO") recoBoxes.push(box("free", payload));
        }
        pos += size;
    }
}
if (moovOff === null) {
    console.error("no moov box");
    process.exit(1);
}
const moov = readAt(fd, moovOff, moovSize);
console.error(`moov @${moovOff} ${moovSize} B, ${recoBoxes.length} freeRECO config boxes kept`);

// mvhd creation_time (kept - a timestamp, not a location).
const mvhdBox = findBox(moov, 8, moov.length, "mvhd");
const mvhdCreation = moov.readUInt32BE(mvhdBox.payloadStart + 4);

// Find the tvxt track and its sample table.
let mdiaBox = null;
for (const trak of iterBoxes(moov, 8, moov.length)) {
    if (trak.type !== "trak") continue;
    const mdia = findBox(moov, trak.payloadStart, trak.end, "mdia");
    if (!mdia) continue;
    const hdlr = findBox(moov, mdia.payloadStart, mdia.end, "hdlr");
    if (moov.toString("latin1", hdlr.payloadStart + 8, hdlr.payloadStart + 12) === "tvxt") mdiaBox = mdia;
}
if (!mdiaBox) {
    console.error("no tvxt track");
    process.exit(1);
}

const mdhd = findBox(moov, mdiaBox.payloadStart, mdiaBox.end, "mdhd");
const timescale = moov.readUInt32BE(mdhd.payloadStart + 12);
const minf = findBox(moov, mdiaBox.payloadStart, mdiaBox.end, "minf");
const stbl = findBox(moov, minf.payloadStart, minf.end, "stbl");
const stsz = findBox(moov, stbl.payloadStart, stbl.end, "stsz");
const fixedSize = moov.readUInt32BE(stsz.payloadStart + 4);
const sampleCount = moov.readUInt32BE(stsz.payloadStart + 8);
if (fixedSize !== SAMPLE_SIZE) {
    console.error(`unexpected sample size ${fixedSize}`);
    process.exit(1);
}

// Real per-sample stts deltas (50/51 ms alternating in observed firmware).
const stts = findBox(moov, stbl.payloadStart, stbl.end, "stts");
const sttsN = moov.readUInt32BE(stts.payloadStart + 4);
const deltas = [];
for (let i = 0; i < sttsN; i++) {
    const count = moov.readUInt32BE(stts.payloadStart + 8 + i * 8);
    const delta = moov.readUInt32BE(stts.payloadStart + 12 + i * 8);
    for (let k = 0; k < count && deltas.length < sampleCount; k++) deltas.push(delta);
}

// Chunk offsets: the real track is 1 sample per chunk (stsc {1,1}).
const stco = findBox(moov, stbl.payloadStart, stbl.end, "stco");
const chunkN = moov.readUInt32BE(stco.payloadStart + 4);
const offsets = [];
for (let i = 0; i < chunkN; i++) offsets.push(moov.readUInt32BE(stco.payloadStart + 8 + i * 4));

// Collect the first N fix samples plus the final terminator row.
const picked = [];
const pickedDeltas = [];
for (let i = 0; i < offsets.length && picked.length < numFixSamples; i++) {
    const s = readAt(fd, offsets[i], SAMPLE_SIZE);
    if (s.readFloatLE(OFF_LAT) === 0 && s.readFloatLE(OFF_LON) === 0) continue; // skip no-fix rows
    picked.push(s);
    pickedDeltas.push(deltas[i] ?? deltas[deltas.length - 1] ?? 50);
}
const lastRow = readAt(fd, offsets[offsets.length - 1], SAMPLE_SIZE);
const lastIsTerminator = lastRow.readFloatLE(OFF_LAT) === 0 && lastRow.readFloatLE(OFF_LON) === 0;
if (lastIsTerminator) {
    picked.push(lastRow);
    pickedDeltas.push(deltas[deltas.length - 1] ?? 50);
}
closeSync(fd);
if (picked.length === 0) {
    console.error("no fix samples found");
    process.exit(1);
}
console.error(`picked ${picked.length} samples (terminator ${lastIsTerminator ? "kept" : "absent"})`);

// Sentinel coordinates: 50.0 / 30.0 in NMEA DDmm.mmmm, advancing +0.0001 deg
// per clock second like the 1 Hz fix cadence of the real stream. Hemisphere
// flags are kept as the file wrote them.
const baseUnix = picked[0].readUInt32LE(OFF_UNIX);
for (const s of picked) {
    if (s.readFloatLE(OFF_LAT) === 0 && s.readFloatLE(OFF_LON) === 0) continue; // terminator stays zeroed
    const sec = s.readUInt32LE(OFF_UNIX) - baseUnix;
    s.writeFloatLE(5000.0 + sec * 0.006, OFF_LAT); // 50 deg + 0.0001 deg/s in minutes
    s.writeFloatLE(3000.0 + sec * 0.006, OFF_LON); // 30 deg + 0.0001 deg/s
}

// Rebuild a minimal MP4 with a tvxt-only moov.
const n = picked.length;
const totalTicks = pickedDeltas.reduce((a, b) => a + b, 0);

const mvhdOut = (() => {
    const p = Buffer.alloc(108);
    p.writeUInt32BE(mvhdCreation, 4); // creation_time kept (timestamp, no PII)
    p.writeUInt32BE(1000, 12);
    p.writeUInt32BE(totalTicks, 16);
    return box("mvhd", p);
})();
const hdlrOut = (() => {
    const p = Buffer.alloc(33);
    fourCC("tvxt").copy(p, 8);
    return box("hdlr", p);
})();
const mdhdOut = (() => {
    const p = Buffer.alloc(24);
    p.writeUInt32BE(timescale, 12);
    p.writeUInt32BE(totalTicks, 16);
    return box("mdhd", p);
})();
const stsdOut = (() => {
    const entry = Buffer.alloc(16);
    entry.writeUInt32BE(16, 0);
    fourCC("mp4s").copy(entry, 4);
    return box("stsd", Buffer.concat([Buffer.alloc(4), u32be(1), entry]));
})();
// Run-length encode the picked deltas back into stts entries.
const sttsEntries = [];
for (const d of pickedDeltas) {
    const last = sttsEntries[sttsEntries.length - 1];
    if (last && last.delta === d) last.count++;
    else sttsEntries.push({ count: 1, delta: d });
}
const sttsOut = box(
    "stts",
    Buffer.concat([
        Buffer.alloc(4),
        u32be(sttsEntries.length),
        ...sttsEntries.flatMap((e) => [u32be(e.count), u32be(e.delta)]),
    ]),
);
const stscOut = box("stsc", Buffer.concat([Buffer.alloc(4), u32be(1), u32be(1), u32be(n), u32be(1)]));
const stszOut = box("stsz", Buffer.concat([Buffer.alloc(4), u32be(SAMPLE_SIZE), u32be(n)]));
const stcoPlaceholder = box("stco", Buffer.concat([Buffer.alloc(4), u32be(1), u32be(0)]));
const dinfOut = box(
    "dinf",
    box("dref", Buffer.concat([Buffer.alloc(4), u32be(1), u32be(12), fourCC("url "), Buffer.from([0, 0, 0, 1])])),
);
const stblOut = box("stbl", Buffer.concat([stsdOut, sttsOut, stscOut, stszOut, stcoPlaceholder]));
const minfOut = box("minf", Buffer.concat([dinfOut, stblOut]));
const mdiaOut = box("mdia", Buffer.concat([mdhdOut, hdlrOut, minfOut]));
const tkhdOut = (() => {
    const p = Buffer.alloc(84);
    p.writeUInt32BE(7, 0);
    p.writeUInt32BE(1, 12);
    p.writeUInt32BE(totalTicks, 20);
    return box("tkhd", p);
})();
const trakOut = box("trak", Buffer.concat([tkhdOut, mdiaOut]));
const moovOut = box("moov", Buffer.concat([mvhdOut, trakOut]));
const ftypOut = box("ftyp", Buffer.concat([fourCC("mp41"), u32be(1), fourCC("isom"), fourCC("avc1"), fourCC("mp41")]));
const mdatOut = box("mdat", Buffer.concat(picked));

const headLen = ftypOut.length + recoBoxes.reduce((a, b) => a + b.length, 0);
const stcoPos = moovOut.indexOf(stcoPlaceholder);
moovOut.writeUInt32BE(headLen + moovOut.length + 8, stcoPos + 8 + 4 + 4);

const out = Buffer.concat([ftypOut, ...recoBoxes, moovOut, mdatOut]);
writeFileSync(outputPath, out);
console.error(`wrote ${out.length} bytes to ${outputPath}`);

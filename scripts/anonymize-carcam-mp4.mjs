#!/usr/bin/env node
import { box, fourCC, u32be } from "./_mp4-fixture.mjs";
// Anonymize CARCAM 4CH 360-WiFi MP4 into a public-safe fixture:
// 1. Parse the MP4 -> find the meta-track with LigoGPS samples (sampleSize ~184).
// 2. Take the first N samples, decrypt each, replace lat/lon/datetime with a
//    sentinel in the decoded ASCII, re-encrypt via the plain 0xc0 4-byte branch
//    (identity XOR with 0x20, see internal/ligogps.ts).
// 3. Pre-SKIP preamble (30 bytes) - lat double + lon double + datetime
//    metadata - zeroed out (the parser ignores it, but the binary still
//    carries PII).
// 4. Pack into a minimal MP4 with a single meta-track and a rebuilt
//    sample table.
//
// Usage:
//   node scripts/anonymize-carcam-mp4.mjs <input.mp4> <output.mp4> [numSamples]

import { openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";

const SCAN_HEAD_LIMIT = 16 << 20;

// ===== MP4 walker (minimal) =====

function* iterBoxes(buf, start, end) {
    let pos = start;
    while (pos + 8 <= end) {
        let size = buf.readUInt32BE(pos);
        const t = buf.toString("ascii", pos + 4, pos + 8);
        let header = 8;
        if (size === 1) {
            if (pos + 16 > end) return;
            const hi = buf.readUInt32BE(pos + 8);
            const lo = buf.readUInt32BE(pos + 12);
            size = hi * 0x100000000 + lo;
            header = 16;
        } else if (size === 0) size = end - pos;
        if (size < header || pos + size > end) return;
        yield { type: t, start: pos, end: pos + size, payloadStart: pos + header };
        pos += size;
    }
}
function findBox(buf, start, end, type) {
    for (const b of iterBoxes(buf, start, end)) if (b.type === type) return b;
    return null;
}
function walkPath(buf, root, ...types) {
    let cur = root;
    for (const t of types) {
        if (!cur) return null;
        cur = findBox(buf, cur.payloadStart, cur.end, t);
    }
    return cur;
}

// ===== LigoGPS decrypt + encrypt =====

function decryptLigoGps(chunk) {
    if (chunk.length < 8) return null;
    const num = chunk.readUInt32LE(4);
    if (num < 4) return null;
    const len = Math.min(num, 0x84);
    if (chunk.length < 8 + len) return null;
    const inBuf = chunk.subarray(8, 8 + len);
    const out = [];
    let i = 0;
    while (i < inBuf.length) {
        const b = inBuf[i++];
        const steering = b & 0xe0;
        if (steering >= 0xc0) {
            if (i + 4 > inBuf.length) return null;
            const a = inBuf[i++],
                c = inBuf[i++],
                d = inBuf[i++],
                e = inBuf[i++];
            out.push(((a | (b & 0x01)) ^ 0x20) & 0xff);
            out.push(((c | (b & 0x02)) ^ 0x20) & 0xff);
            out.push(((d | (b & 0x0c)) ^ 0x20) & 0xff);
            out.push(((e ^ 0x20) | (b & 0x30)) & 0xff);
        } else if (steering >= 0x40) {
            if (i + 3 > inBuf.length) return null;
            const a = inBuf[i++],
                c = inBuf[i++],
                d = inBuf[i++];
            if (steering === 0x40) {
                out.push(0x20);
                out.push(((a | (b & 0x01)) ^ 0x20) & 0xff);
                out.push(((c | (b & 0x06)) ^ 0x20) & 0xff);
                out.push(((d | (b & 0x18)) ^ 0x20) & 0xff);
            } else if (steering === 0x60) {
                out.push(((a | (b & 0x03)) ^ 0x20) & 0xff);
                out.push(0x20);
                out.push(((c | (b & 0x04)) ^ 0x20) & 0xff);
                out.push(((d | (b & 0x18)) ^ 0x20) & 0xff);
            } else if (steering === 0x80) {
                out.push(((a | (b & 0x03)) ^ 0x20) & 0xff);
                out.push(((c | (b & 0x0c)) ^ 0x20) & 0xff);
                out.push(0x20);
                out.push(((d | (b & 0x10)) ^ 0x20) & 0xff);
            } else {
                out.push(((a | (b & 0x01)) ^ 0x20) & 0xff);
                out.push(((c | (b & 0x06)) ^ 0x20) & 0xff);
                out.push(((d | (b & 0x18)) ^ 0x20) & 0xff);
                out.push(0x20);
            }
        } else if (steering === 0x00) {
            if (i + 1 > inBuf.length) return null;
            const a = inBuf[i++];
            out.push((a | (b & 0x13)) & 0xff);
        } else {
            return null;
        }
    }
    return Buffer.from(out);
}

// Encode ASCII -> encrypted body. Uses the b=0xc0 4-byte branch:
// all masks are zero when b=0xc0, so output[i] = input[i] ^ 0x20.
// pad text to multiple of 4 chars.
function encodeLigoGps(text) {
    const padded = text + "\0".repeat((4 - (text.length % 4)) % 4);
    const out = [];
    for (let i = 0; i < padded.length; i += 4) {
        out.push(0xc0);
        out.push(padded.charCodeAt(i) ^ 0x20);
        out.push(padded.charCodeAt(i + 1) ^ 0x20);
        out.push(padded.charCodeAt(i + 2) ^ 0x20);
        out.push(padded.charCodeAt(i + 3) ^ 0x20);
    }
    return Buffer.from(out);
}

function findLigoGpsChunkOffset(payload) {
    const magic = Buffer.from("LIGOGPSINFO");
    const i = payload.indexOf(magic);
    if (i < 0) return null;
    const chunkStart = i + 0x14;
    if (chunkStart + 8 > payload.length) return null;
    if (
        payload[chunkStart] !== 0x23 ||
        payload[chunkStart + 1] !== 0x23 ||
        payload[chunkStart + 2] !== 0x23 ||
        payload[chunkStart + 3] !== 0x23
    )
        return null;
    return chunkStart;
}

// ===== Sample-table walker =====

function readSamples(buf, trak) {
    const stbl = walkPath(buf, trak, "mdia", "minf", "stbl");
    if (!stbl) return null;
    const stsz = findBox(buf, stbl.payloadStart, stbl.end, "stsz");
    const stco = findBox(buf, stbl.payloadStart, stbl.end, "stco") ?? findBox(buf, stbl.payloadStart, stbl.end, "co64");
    if (!stsz || !stco) return null;
    const fixedSize = buf.readUInt32BE(stsz.payloadStart + 4);
    const sampleCount = buf.readUInt32BE(stsz.payloadStart + 8);
    const isCo64 = stco.type === "co64";
    const chunkCount = buf.readUInt32BE(stco.payloadStart + 4);
    const samples = [];
    for (let i = 0; i < Math.min(sampleCount, chunkCount); i++) {
        const offBytes = stco.payloadStart + 8 + i * (isCo64 ? 8 : 4);
        const off = isCo64
            ? buf.readUInt32BE(offBytes) * 0x100000000 + buf.readUInt32BE(offBytes + 4)
            : buf.readUInt32BE(offBytes);
        const size = fixedSize > 0 ? fixedSize : buf.readUInt32BE(stsz.payloadStart + 12 + i * 4);
        samples.push({ offset: off, size });
    }
    return samples;
}

function readHandlerType(buf, trak) {
    const hdlr = walkPath(buf, trak, "mdia", "hdlr");
    if (!hdlr) return null;
    return buf.toString("ascii", hdlr.payloadStart + 8, hdlr.payloadStart + 12);
}

// ===== Anonymize sample text =====

// Replaces datetime/lat/lon/speed with a sentinel, preserving structure:
//   `\0\0\0\02025/06/07 18:06:17 N:55.123 E:33.456 25.5`
// -> `\0\0\0\02000/01/01 00:00:00 N:50.000000 E:30.000000 0.0`
function anonymizeText(decoded, recordIdx) {
    const ascii = decoded.toString("ascii");
    // Regex captures: datetime, NS, lat, EW, lon, speed.
    const m = ascii.match(
        /^(.{4})(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([NS?]):(-?[.\d]+) ([EW?]):(-?[.\d]+) ([.\d]+)/,
    );
    if (!m) {
        // Parse failed - return a zero-filled buffer of the same size.
        const zeros = Buffer.alloc(decoded.length);
        return zeros;
    }
    const prefix = m[1];
    // Datetime: fixed 2025-06-07 18:06:00 + recordIdx seconds (sentinel
    // trip starts at a "round" moment so it's convenient in snapshots).
    const baseDate = new Date(Date.UTC(2025, 5, 7, 18, 6, 0));
    baseDate.setUTCSeconds(baseDate.getUTCSeconds() + recordIdx);
    const yyyy = baseDate.getUTCFullYear();
    const mm = String(baseDate.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(baseDate.getUTCDate()).padStart(2, "0");
    const hh = String(baseDate.getUTCHours()).padStart(2, "0");
    const mi = String(baseDate.getUTCMinutes()).padStart(2, "0");
    const ss = String(baseDate.getUTCSeconds()).padStart(2, "0");
    // Sentinel coords - 50.0 N / 30.0 E + tiny offset per record.
    const lat = (50 + recordIdx * 0.0001).toFixed(6);
    const lon = (30 + recordIdx * 0.0001).toFixed(6);
    const speed = "10.0";
    const text = `${prefix}${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss} N:${lat} E:${lon} ${speed}`;
    return Buffer.from(text, "ascii");
}

// ===== Main =====

const [, , inputPath, outputPath, numSamplesArg] = process.argv;
if (!inputPath || !outputPath) {
    console.error("usage: anonymize-carcam-mp4.mjs <input.mp4> <output.mp4> [numSamples=3]");
    process.exit(1);
}
const numSamples = Number(numSamplesArg ?? 3);

const fd = openSync(inputPath, "r");
const stat = statSync(inputPath);
const headSz = Math.min(stat.size, SCAN_HEAD_LIMIT);
const headerBuf = Buffer.alloc(headSz);
readSync(fd, headerBuf, 0, headSz, 0);

// Find LigoGPS meta-track
const moov = findBox(headerBuf, 0, headerBuf.length, "moov");
if (!moov) {
    console.error("no moov in first 16MB");
    process.exit(1);
}

let ligoTrak = null;
let ligoSamples = null;
for (const trak of iterBoxes(headerBuf, moov.payloadStart, moov.end)) {
    if (trak.type !== "trak") continue;
    if (readHandlerType(headerBuf, trak) !== "meta") continue;
    const samples = readSamples(headerBuf, trak);
    if (!samples || samples.length === 0) continue;
    // LigoGPS meta-track: sample size ~184 bytes.
    if (samples[0].size < 64 || samples[0].size > 1024) continue;
    // Probe first sample for LIGOGPSINFO magic.
    const probe = Buffer.alloc(samples[0].size);
    readSync(fd, probe, 0, samples[0].size, samples[0].offset);
    if (findLigoGpsChunkOffset(probe) === null) continue;
    ligoTrak = trak;
    ligoSamples = samples;
    break;
}
if (!ligoTrak || !ligoSamples) {
    console.error("no LigoGPS meta-track found");
    process.exit(1);
}
console.error(`found LigoGPS track with ${ligoSamples.length} samples`);

// Re-build numSamples samples with sentinel coords.
const newSamples = [];
let processed = 0;
for (let i = 0; i < ligoSamples.length && newSamples.length < numSamples; i++) {
    const s = ligoSamples[i];
    const orig = Buffer.alloc(s.size);
    readSync(fd, orig, 0, s.size, s.offset);
    const chunkOff = findLigoGpsChunkOffset(orig);
    if (chunkOff === null) continue;
    const chunkLen = Math.min(s.size - chunkOff, 0x84);
    const decrypted = decryptLigoGps(orig.subarray(chunkOff, chunkOff + chunkLen));
    if (!decrypted) continue;
    const anonText = anonymizeText(decrypted, processed);
    const reEncrypted = encodeLigoGps(anonText.toString("ascii"));

    // Re-build sample: zeros preamble (chunkOff bytes) + LIGOGPSINFO header
    // (between original sample structure preserved) + new chunk.
    // More precisely: skip-box header + LIGOGPSINFO magic preserved, only the
    // chunk payload and pre-SKIP preamble get replaced.
    const newSample = Buffer.alloc(s.size);
    // Copy bytes from chunkOff (= LIGOGPSINFO + 0x14, i.e. start of chunk).
    // Bytes [0..chunkOff): zero-fill (preamble + SKIP-box header + LIGOGPSINFO + spare).
    // We need to preserve SKIP-box structure - actually the parser doesn't look
    // at it, it just scans for the LIGOGPSINFO substring. Copy the magic region.
    // Pre-SKIP (bytes 0..chunkOff-0x14-11) - PII (binary lat/lon doubles), zero them.
    const magicStart = chunkOff - 0x14; // LIGOGPSINFO position
    // [0..magicStart-8): zero-fill (binary preamble).
    // [magicStart-8..magicStart): SKIP-box header (size + "SKIP"). Keep as-is.
    if (magicStart >= 8) {
        orig.copy(newSample, magicStart - 8, magicStart - 8, magicStart);
    }
    // [magicStart..chunkOff): "LIGOGPSINFO" + 4 zero pad + 5 spare. Keep as-is.
    orig.copy(newSample, magicStart, magicStart, chunkOff);
    // [chunkOff..chunkOff+4): "####".
    Buffer.from("####", "ascii").copy(newSample, chunkOff);
    // [chunkOff+4..chunkOff+8): u32 LE num.
    newSample.writeUInt32LE(reEncrypted.length, chunkOff + 4);
    // [chunkOff+8..]: encrypted body.
    reEncrypted.copy(newSample, chunkOff + 8);

    newSamples.push(newSample);
    processed++;
}
closeSync(fd);

if (newSamples.length === 0) {
    console.error("no samples could be anonymized");
    process.exit(1);
}
console.error(`anonymized ${newSamples.length} samples`);

// Build minimal MP4 with single meta-track.
const ftyp = box("ftyp", Buffer.concat([fourCC("isom"), u32be(512), fourCC("isom"), fourCC("avc1"), fourCC("mp41")]));

const mdat = box("mdat", Buffer.concat(newSamples));

const stsdPayload = Buffer.concat([
    Buffer.alloc(4),
    u32be(1),
    Buffer.concat([u32be(16), fourCC("ssmd"), Buffer.alloc(8)]),
]);
const stsd = box("stsd", stsdPayload);
const stts = box("stts", Buffer.concat([Buffer.alloc(4), u32be(1), u32be(newSamples.length), u32be(1)]));
const stsc = box("stsc", Buffer.concat([Buffer.alloc(4), u32be(1), u32be(1), u32be(1), u32be(1)]));

const sizesTable = Buffer.alloc(newSamples.length * 4);
for (let i = 0; i < newSamples.length; i++) sizesTable.writeUInt32BE(newSamples[i].length, i * 4);
const stsz = box("stsz", Buffer.concat([Buffer.alloc(4), u32be(0), u32be(newSamples.length), sizesTable]));

const stco = box(
    "stco",
    Buffer.concat([Buffer.alloc(4), u32be(newSamples.length), Buffer.alloc(newSamples.length * 4)]),
);
const stbl = box("stbl", Buffer.concat([stsd, stts, stsc, stsz, stco]));

const hdlr = box(
    "hdlr",
    Buffer.concat([Buffer.alloc(8), fourCC("meta"), Buffer.alloc(12), Buffer.from("\0", "ascii")]),
);
const mdhd = box(
    "mdhd",
    Buffer.concat([
        Buffer.alloc(4),
        Buffer.alloc(4),
        Buffer.alloc(4),
        u32be(1),
        u32be(newSamples.length),
        Buffer.alloc(4),
    ]),
);
const minf = box("minf", stbl);
const mdia = box("mdia", Buffer.concat([mdhd, hdlr, minf]));
const tkhd = box("tkhd", Buffer.alloc(84));
const trak = box("trak", Buffer.concat([tkhd, mdia]));
const mvhd = box("mvhd", Buffer.alloc(108));
const moovOut = box("moov", Buffer.concat([mvhd, trak]));

// Patch stco offsets after we know mdat-payload start.
const mdatPayloadStart = ftyp.length + moovOut.length + 8;
const stcoMagic = Buffer.from("stco", "ascii");
const stcoIdx = moovOut.indexOf(stcoMagic);
if (stcoIdx < 0) {
    console.error("stco not found in moov");
    process.exit(1);
}
let writeOff = stcoIdx + 4 + 4 + 4;
let cumulativeOffset = mdatPayloadStart;
for (const s of newSamples) {
    moovOut.writeUInt32BE(cumulativeOffset, writeOff);
    cumulativeOffset += s.length;
    writeOff += 4;
}

const out = Buffer.concat([ftyp, moovOut, mdat]);
writeFileSync(outputPath, out);
console.error(`wrote ${out.length} bytes to ${outputPath}`);

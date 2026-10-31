#!/usr/bin/env node
import { u32le } from "./_mp4-fixture.mjs";
// Anonymizes an MPEG-TS recording with an enciphered, fuzzed LigoGPS PES
// (docs/format-ligogps-ts-pes.md) into a snapshot fixture.
//
// The video body carries no real bytes: HEVC + AAC are generated from scratch
// via ffmpeg testsrc2 + sine on the PIDs of the source. What is kept:
//   - the source PMT packet verbatim (stream types incl. the 0x82 GPS PID and
//     the 0x80 thumbnail PID - the AV-side DTS mask and the parser gate key on
//     them); the thumbnail packets themselves are dropped (a real image);
//   - `records` consecutive GPS PES packets starting at `startRecord`, with
//     their chunk header, record counter, timestamps, speed, course, sats and
//     accelerometer bytes. Coordinates are unfuzzed (ExifTool scale 3),
//     truncated to whole degrees, fuzzed back and re-enciphered; altitude
//     digits are zeroed. Every PES is re-deciphered and checked before
//     writing.
//
// Dependencies: ffmpeg with libx265 in PATH.
//
// Usage:
//   node scripts/anonymize-ligogps-ts-pes.mjs <input.TS> <output.TS> [records=6] [startRecord=0]

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";

const [, , inputPath, outputPath, recordsArg, startArg] = process.argv;
if (!inputPath || !outputPath) {
    console.error("usage: anonymize-ligogps-ts-pes.mjs <input.TS> <output.TS> [records=6] [startRecord=0]");
    process.exit(1);
}
if (!existsSync(inputPath)) throw new Error(`input not found: ${inputPath}`);
const recordCount = Number(recordsArg ?? 6);
const startRecord = Number(startArg ?? 0);
if (!Number.isInteger(recordCount) || recordCount <= 0 || !Number.isInteger(startRecord) || startRecord < 0) {
    throw new Error("invalid records or startRecord");
}

const TS_SIZE = 188;
const TS_SYNC = 0x47;
const FUZZ_SCALE = 1.15368;
const GPS_STREAM_TYPE = 0x82;
const CHUNK_OFFSET = 20; // '####' after LIGOGPSINFO + nine header bytes
const MAX_CIPHER = 0x84;
const SCAN_LIMIT = 256 * 1024 * 1024;
// Reject extra fields instead of copying unknown private bytes into a fixture.
const RECORD_RX =
    /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} [NS]:-?\d+\.\d+ [EW]:-?\d+\.\d+ -?\d+(?:\.\d+)? km\/h -?\d+(?:\.\d+)? -?\d+(?:\.\d+)? \d+ x:-?\d+(?:\.\d+)? y:-?\d+(?:\.\d+)? z:-?\d+(?:\.\d+)?\0*$/;

// --- Step 1: PMT and GPS packets from the source.
const fd = openSync(inputPath, "r");
const packet = Buffer.alloc(TS_SIZE);
let pmtPid = null;
let pmtPacket = null;
let gpsPid = null;
const gpsPackets = [];
for (let off = 0; off < SCAN_LIMIT && gpsPackets.length < startRecord + recordCount; off += TS_SIZE) {
    if (readSync(fd, packet, 0, TS_SIZE, off) !== TS_SIZE) break;
    if (packet[0] !== TS_SYNC) throw new Error(`lost packet sync at ${off}`);
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    const pusi = (packet[1] & 0x40) !== 0;
    if (pid === 0 && pusi && pmtPid === null) {
        const section = 5 + packet[4];
        pmtPid = ((packet[section + 10] & 0x1f) << 8) | packet[section + 11];
    } else if (pid === pmtPid && pusi && pmtPacket === null) {
        pmtPacket = Buffer.from(packet);
        gpsPid = gpsPidFromPmt(pmtPacket);
    } else if (gpsPid !== null && pid === gpsPid) {
        if (!pusi) throw new Error("gps pes spans packets; this script expects one packet per pes");
        gpsPackets.push(Buffer.from(packet));
    }
}
closeSync(fd);
if (pmtPacket === null || gpsPid === null) throw new Error("no pmt with a 0x82 gps stream");
const selected = gpsPackets.slice(startRecord, startRecord + recordCount);
if (selected.length !== recordCount)
    throw new Error(`found ${gpsPackets.length} gps pes, need ${startRecord + recordCount}`);
console.error(`gps pid 0x${gpsPid.toString(16)}, records ${startRecord}..${startRecord + recordCount - 1}`);

// --- Step 2: synthetic AV with the source's PIDs.
const avTmp = `${outputPath}.av.ts`;
const ff = spawnSync(
    "ffmpeg",
    [
        ["-y", "-hide_banner", "-loglevel", "error"],
        ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25"],
        ["-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=16000"],
        ["-t", String(recordCount)],
        ["-map", "0:v", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-crf", "40"],
        ["-pix_fmt", "yuv420p", "-map", "1:a", "-c:a", "aac", "-b:a", "16k", "-ac", "1"],
        ["-mpegts_pmt_start_pid", "0xfff", "-mpegts_start_pid", "0x100", "-muxdelay", "0", "-muxpreload", "0"],
        ["-f", "mpegts", avTmp],
    ].flat(),
    { stdio: ["ignore", "ignore", "inherit"] },
);
if (ff.status !== 0) throw new Error("ffmpeg failed");
const av = readFileSync(avTmp);
unlinkSync(avTmp);

// --- Step 3: anonymize the GPS packets.
const anonymized = selected.map((source, index) => anonymizeGpsPacket(source, index));

// --- Step 4: splice. The source PMT replaces ffmpeg's; GPS packet k goes in
// front of the first video PES at or after k seconds.
const firstVideoPts = videoPtsList(av)[0];
const out = [];
let nextGps = 0;
for (let off = 0; off + TS_SIZE <= av.length; off += TS_SIZE) {
    const pkt = Buffer.from(av.subarray(off, off + TS_SIZE));
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    if (pid === pmtPid && (pkt[1] & 0x40) !== 0) {
        // Keep ffmpeg's continuity counter, take the source's field layout.
        pkt[3] = (pmtPacket[3] & 0xf0) | (pkt[3] & 0x0f);
        pmtPacket.copy(pkt, 4, 4);
    }
    const pts = pid === 0x100 && (pkt[1] & 0x40) !== 0 ? pesPts(pkt) : null;
    while (pts !== null && nextGps < anonymized.length && pts >= firstVideoPts + nextGps * 90000) {
        out.push(withPts(anonymized[nextGps], firstVideoPts + nextGps * 90000));
        nextGps++;
    }
    out.push(pkt);
}
while (nextGps < anonymized.length) {
    out.push(withPts(anonymized[nextGps], firstVideoPts + nextGps * 90000));
    nextGps++;
}
writeFileSync(outputPath, Buffer.concat(out));
console.error(`done -> ${outputPath} (${out.length * TS_SIZE} bytes)`);

// --------- helpers ---------

function gpsPidFromPmt(pmt) {
    const section = 5 + pmt[4];
    const sectionEnd = section + 3 + (((pmt[section + 1] & 0x0f) << 8) | pmt[section + 2]);
    let entry = section + 12 + (((pmt[section + 10] & 0x0f) << 8) | pmt[section + 11]);
    while (entry + 5 <= sectionEnd - 4) {
        if (pmt[entry] === GPS_STREAM_TYPE) return ((pmt[entry + 1] & 0x1f) << 8) | pmt[entry + 2];
        entry += 5 + (((pmt[entry + 3] & 0x0f) << 8) | pmt[entry + 4]);
    }
    return null;
}

function payloadOffset(pkt) {
    const afc = (pkt[3] >> 4) & 0x03;
    return afc & 0x02 ? 5 + pkt[4] : 4;
}

function pesPts(pkt) {
    const pay = payloadOffset(pkt);
    if (pkt[pay] !== 0 || pkt[pay + 1] !== 0 || pkt[pay + 2] !== 1 || (pkt[pay + 7] & 0x80) === 0) return null;
    const p = pay + 9;
    return (
        (pkt[p] & 0x0e) * 2 ** 29 +
        pkt[p + 1] * 2 ** 22 +
        (pkt[p + 2] >> 1) * 2 ** 15 +
        pkt[p + 3] * 2 ** 7 +
        (pkt[p + 4] >> 1)
    );
}

function videoPtsList(ts) {
    const list = [];
    for (let off = 0; off + TS_SIZE <= ts.length; off += TS_SIZE) {
        const pkt = ts.subarray(off, off + TS_SIZE);
        if ((((pkt[1] & 0x1f) << 8) | pkt[2]) !== 0x100 || (pkt[1] & 0x40) === 0) continue;
        const pts = pesPts(pkt);
        if (pts !== null) list.push(pts);
    }
    if (list.length === 0) throw new Error("no video pts in synthetic av");
    return list.sort((a, b) => a - b);
}

function withPts(pkt, pts) {
    const copy = Buffer.from(pkt);
    const p = payloadOffset(copy) + 9;
    copy[p] = 0x21 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1);
    copy[p + 1] = Math.floor(pts / 2 ** 22) & 0xff;
    copy[p + 2] = ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 1;
    copy[p + 3] = Math.floor(pts / 2 ** 7) & 0xff;
    copy[p + 4] = ((pts & 0x7f) << 1) | 1;
    return copy;
}

function anonymizeGpsPacket(source, index) {
    const pay = payloadOffset(source);
    const pesHeaderLength = 9 + source[pay + 8];
    const bodyStart = pay + pesHeaderLength;
    const bodyLength = ((source[pay + 4] << 8) | source[pay + 5]) - 3 - source[pay + 8];
    const body = source.subarray(bodyStart, bodyStart + bodyLength);
    if (
        body.subarray(0, 11).toString("latin1") !== "LIGOGPSINFO" ||
        body.subarray(20, 24).toString("latin1") !== "####"
    ) {
        throw new Error(`gps pes ${index}: unexpected chunk header`);
    }
    const plain = decrypt(body.subarray(CHUNK_OFFSET));
    if (plain === null) throw new Error(`gps pes ${index}: decrypt failed`);
    const text = Buffer.from(plain).toString("latin1");
    const scrubbed = scrubRecord(text);
    const cipher = encrypt(Buffer.from(scrubbed, "latin1"));
    const roundTrip = decrypt(Buffer.concat([Buffer.from("####"), u32le(cipher.length), cipher]));
    if (roundTrip === null || Buffer.from(roundTrip).toString("latin1") !== scrubbed) {
        throw new Error(`gps pes ${index}: re-encipher round trip failed`);
    }
    const newBody = Buffer.concat([body.subarray(0, CHUNK_OFFSET), Buffer.from("####"), u32le(cipher.length), cipher]);
    const paddedBody = Buffer.concat([newBody, Buffer.alloc(Math.max(0, bodyLength - newBody.length))]);
    const pesHeader = Buffer.from(source.subarray(pay, pay + pesHeaderLength));
    pesHeader.writeUInt16BE(3 + source[pay + 8] + paddedBody.length, 4);
    const pes = Buffer.concat([pesHeader, paddedBody]);
    const stuffing = TS_SIZE - 4 - pes.length;
    if (stuffing < 0) throw new Error(`gps pes ${index}: re-enciphered record outgrew the packet`);
    const header = Buffer.from([
        TS_SYNC,
        0x40 | (gpsPid >> 8),
        gpsPid & 0xff,
        (stuffing > 0 ? 0x30 : 0x10) | (index & 0x0f),
    ]);
    const adaptation =
        stuffing > 0
            ? Buffer.concat([
                  Buffer.from([stuffing - 1]),
                  stuffing > 1 ? Buffer.from([0]) : Buffer.alloc(0),
                  Buffer.alloc(Math.max(0, stuffing - 2), 0xff),
              ])
            : Buffer.alloc(0);
    return Buffer.concat([header, adaptation, pes]);
}

function scrubRecord(text) {
    if (!RECORD_RX.test(text.slice(4))) throw new Error("unsupported decrypted record shape");
    const coords = text.match(/([NS]):(-?)(\d+\.\d+) ([EW]):(-?)(\d+\.\d+)/);
    if (!coords) throw new Error("no fix in decrypted record");
    const [whole, ns, latSign, latText, ew, lonSign, lonText] = coords;
    const latFuzzed = Number(latText);
    const lonFuzzed = Number(lonText);
    const latCell = Math.trunc(latFuzzed / 10) * 10;
    const lonCell = Math.trunc(lonFuzzed / 10) * 10;
    // Unfuzz (ExifTool UnfuzzLigoGPS), truncate to whole degrees, fuzz back.
    const lat = Math.trunc(latCell + (lonFuzzed - lonCell) * FUZZ_SCALE);
    const lon = Math.trunc(lonCell + (latFuzzed - latCell) * FUZZ_SCALE);
    const latBack = latCell + (lon - lonCell) / FUZZ_SCALE;
    const lonBack = lonCell + (lat - latCell) / FUZZ_SCALE;
    const replacement = `${ns}:${latSign}${latBack.toFixed(6)} ${ew}:${lonSign}${lonBack.toFixed(6)}`;
    if (replacement.length !== whole.length) throw new Error("coordinate width changed");
    // "<speed> km/h <course> <altitude> <sats>" - zero the altitude digits.
    return text
        .replace(whole, replacement)
        .replace(/(km\/h -?[\d.]+ )(-?[\d.]+)/, (_m, lead, altitude) => lead + altitude.replace(/\d/g, "0"));
}

// ExifTool LigoGPS.pm DecryptLigoGPS, same port as src/parsers/internal/ligogps.ts.
function decrypt(chunk) {
    if (chunk.length < 8) return null;
    let num = chunk.readUInt32LE(4);
    if (num < 4) return null;
    if (num > MAX_CIPHER) num = MAX_CIPHER;
    if (chunk.length < 8 + num) return null;
    const input = chunk.subarray(8, 8 + num);
    const out = [];
    let i = 0;
    while (i < input.length) {
        const b = input[i++];
        const steering = b & 0xe0;
        if (steering >= 0xc0) {
            if (i + 4 > input.length) return null;
            const [a, c, d, e] = input.subarray(i, i + 4);
            i += 4;
            out.push(
                (a | (b & 0x01)) ^ 0x20,
                (c | (b & 0x02)) ^ 0x20,
                (d | (b & 0x0c)) ^ 0x20,
                (e ^ 0x20) | (b & 0x30),
            );
        } else if (steering >= 0x40) {
            if (i + 3 > input.length) return null;
            const [a, c, d] = input.subarray(i, i + 3);
            i += 3;
            if (steering === 0x40)
                out.push(0x20, (a | (b & 0x01)) ^ 0x20, (c | (b & 0x06)) ^ 0x20, (d | (b & 0x18)) ^ 0x20);
            else if (steering === 0x60)
                out.push((a | (b & 0x03)) ^ 0x20, 0x20, (c | (b & 0x04)) ^ 0x20, (d | (b & 0x18)) ^ 0x20);
            else if (steering === 0x80)
                out.push((a | (b & 0x03)) ^ 0x20, (c | (b & 0x0c)) ^ 0x20, 0x20, (d | (b & 0x10)) ^ 0x20);
            else out.push((a | (b & 0x01)) ^ 0x20, (c | (b & 0x06)) ^ 0x20, (d | (b & 0x18)) ^ 0x20, 0x20);
        } else if (steering === 0x00) {
            if (i + 1 > input.length) return null;
            out.push(input[i++] | (b & 0x13));
        } else {
            return null;
        }
    }
    return Uint8Array.from(out);
}

// Inverse of decrypt. Each branch hides some low bits of its output bytes in
// the control byte; a 4-byte group with a space costs 4 cipher bytes, any
// other 4-byte group 5, a single byte 2. Shortest encoding by dynamic
// programming, so a record stays within the 0x84 cipher cap.
function encrypt(plain) {
    const n = plain.length;
    const cost = new Array(n + 1).fill(Number.POSITIVE_INFINITY);
    const choice = new Array(n + 1).fill(null);
    cost[n] = 0;
    for (let i = n - 1; i >= 0; i--) {
        const options = [{ size: 1, bytes: 2, kind: "single" }];
        if (i + 4 <= n) {
            const spaceAt = [0, 1, 2, 3].find((k) => plain[i + k] === 0x20);
            options.push(
                spaceAt === undefined
                    ? { size: 4, bytes: 5, kind: "full" }
                    : { size: 4, bytes: 4, kind: `space${spaceAt}` },
            );
        }
        for (const option of options) {
            const total = option.bytes + cost[i + option.size];
            if (total < cost[i]) {
                cost[i] = total;
                choice[i] = option;
            }
        }
    }
    const out = [];
    for (let i = 0; i < n; ) {
        const { kind, size } = choice[i];
        const p = plain.subarray(i, i + size);
        const x = (k) => p[k] ^ 0x20;
        if (kind === "single") {
            out.push(p[0] & 0x13, p[0] & ~0x13 & 0xff);
        } else if (kind === "full") {
            const e = p[3] & ~0x30 & 0xff;
            out.push(
                0xc0 | (x(0) & 0x01) | (x(1) & 0x02) | (x(2) & 0x0c) | (p[3] & 0x30),
                x(0) & ~0x01,
                x(1) & ~0x02,
                x(2) & ~0x0c,
                e ^ 0x20,
            );
        } else if (kind === "space0") {
            out.push(0x40 | (x(1) & 0x01) | (x(2) & 0x06) | (x(3) & 0x18), x(1) & ~0x01, x(2) & ~0x06, x(3) & ~0x18);
        } else if (kind === "space1") {
            out.push(0x60 | (x(0) & 0x03) | (x(2) & 0x04) | (x(3) & 0x18), x(0) & ~0x03, x(2) & ~0x04, x(3) & ~0x18);
        } else if (kind === "space2") {
            out.push(0x80 | (x(0) & 0x03) | (x(1) & 0x0c) | (x(3) & 0x10), x(0) & ~0x03, x(1) & ~0x0c, x(3) & ~0x10);
        } else {
            out.push(0xa0 | (x(0) & 0x01) | (x(1) & 0x06) | (x(2) & 0x18), x(0) & ~0x01, x(1) & ~0x06, x(2) & ~0x18);
        }
        i += size;
    }
    const cipher = Buffer.from(out.map((b) => b & 0xff));
    if (cipher.length > MAX_CIPHER) throw new Error(`cipher ${cipher.length} bytes exceeds the 0x84 cap`);
    return cipher;
}

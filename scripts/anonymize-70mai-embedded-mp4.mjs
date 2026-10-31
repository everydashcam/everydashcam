#!/usr/bin/env node
import { u32be } from "./_mp4-fixture.mjs";
// Anonymize a real 70mai 4K (A810/M500) embedded-freeGPS MP4 into a public-safe
// fixture that exercises the STRUCTURAL path: moov -> `gps ` index atom with a
// (offset,size) table pointing at freeGPS blocks (ddmm.mmmm*1e5 dialect).
//
// Unlike anonymize-novatek-mp4.mjs (DDmm-float, streaming), this preserves the
// real `gps ` atom table shape and real block signatures, replacing only the
// coordinates. The rebuilt container is tiny: ftyp + moov(just the `gps ` atom
// with a rewritten table) + mdat holding N short real block windows.
//
// Usage:
//   node scripts/anonymize-70mai-embedded-mp4.mjs <input.mp4> <output.mp4> [numBlocks]
//
// What is kept REAL (proves the parser sees genuine firmware bytes): the
// `gps ` table layout (version word, big-endian count + entry pairs), the
// freeGPS magic, the self-referential 70mai tag (u16@8==u16@14, u16@10==0),
// the active/void byte and the heading. What is ANONYMIZED: lat/lon only,
// snapped to whole-degree sentinels (50 N / 30 E) plus a small per-block step
// so the synthetic track moves. The per-record window (64 bytes) stops
// well before the block-start unix at literal+0x169, so no timestamp is copied.

import { openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";

const MAGIC = Buffer.from("freeGPS ");
// Bytes kept per block, from the block-atom start. Covers the parser window
// (heading ends at literal+38 = atom+42) with slack; stays far below the
// block-start unix at literal+0x169, so it never enters the fixture.
const BLOCK_WINDOW = 64;
// Coordinate sentinels: whole degrees, clearly outside any real city.
const LAT_BASE_DEG = 50;
const LON_BASE_DEG = 30;
const STEP_DEG = 0.0002; // ~22 m between fixes (~22 m/s, a plausible speed under the cap)

// Decimal degrees -> the firmware's int32: NMEA ddmm.mmmm * 1e5, sign = hemisphere.
function encodeDdmm(degrees) {
    const abs = Math.abs(degrees);
    const dd = Math.floor(abs);
    const minutes = (abs - dd) * 60;
    return Math.round(Math.sign(degrees) * (dd * 100 + minutes) * 1e5);
}

// 70mai block field offsets from the freeGPS literal (see freegps-70mai.ts).
const OFF_TAG = 8;
const OFF_TAG_ZERO = 10;
const OFF_TAG_MIRROR = 14;
const OFF_ACTIVE = 26;
const OFF_LAT = 27;
const OFF_LON = 31;

function readBox(fd, off) {
    const hdr = Buffer.alloc(16);
    readSync(fd, hdr, 0, 16, off);
    let size = hdr.readUInt32BE(0);
    let headerSize = 8;
    if (size === 1) {
        size = Number(hdr.readBigUInt64BE(8));
        headerSize = 16;
    }
    const type = hdr.subarray(4, 8).toString("latin1");
    return { off, size, type, headerSize };
}

function walkTopLevel(fd, fileSize) {
    const boxes = [];
    let off = 0;
    while (off + 8 <= fileSize) {
        const box = readBox(fd, off);
        if (box.size < 8) break;
        boxes.push(box);
        off += box.size;
    }
    return boxes;
}

// Finds a direct child box of the given type inside [start, end).
function findChild(buf, start, end, wantType) {
    let off = start;
    while (off + 8 <= end) {
        let size = buf.readUInt32BE(off);
        let headerSize = 8;
        if (size === 1) {
            size = Number(buf.readBigUInt64BE(off + 8));
            headerSize = 16;
        }
        if (size < 8 || off + size > end) break;
        const type = buf.subarray(off + 4, off + 8).toString("latin1");
        if (type === wantType) return { off, size, payloadStart: off + headerSize };
        off += size;
    }
    return null;
}

// Locates the "freeGPS " literal in a block-atom window: canonical entries
// point at the atom start ([u32 size]['freeGPS ']) so the literal is at 4;
// a legacy layout points straight at the literal (0).
function literalOffset(win) {
    if (win.subarray(0, 8).equals(MAGIC)) return 0;
    if (win.length >= 12 && win.subarray(4, 12).equals(MAGIC)) return 4;
    return -1;
}

function is70maiBlock(win, lit) {
    const dv = new DataView(win.buffer, win.byteOffset, win.byteLength);
    if (win.length < lit + OFF_LAT + 8) return false;
    if (dv.getUint16(lit + OFF_TAG, true) !== dv.getUint16(lit + OFF_TAG_MIRROR, true)) return false;
    if (dv.getUint16(lit + OFF_TAG_ZERO, true) !== 0) return false;
    const active = win[lit + OFF_ACTIVE];
    return active === 0x41 || active === 0x56;
}

function main() {
    const [input, output, numArg] = process.argv.slice(2);
    if (!input || !output) {
        console.error("usage: anonymize-70mai-embedded-mp4.mjs <input.mp4> <output.mp4> [numBlocks]");
        process.exit(1);
    }
    const numBlocks = Number(numArg ?? 10);
    const fd = openSync(input, "r");
    try {
        const fileSize = statSync(input).size;
        const top = walkTopLevel(fd, fileSize);
        const ftyp = top.find((b) => b.type === "ftyp");
        const moov = top.find((b) => b.type === "moov");
        if (!ftyp) throw new Error("no ftyp box");
        if (!moov) throw new Error("no moov box");

        // Load moov, find the lowercase `gps ` index atom and its table.
        const moovBuf = Buffer.alloc(moov.size);
        readSync(fd, moovBuf, 0, moov.size, moov.off);
        const gps = findChild(moovBuf, 8, moov.size, "gps ");
        if (!gps) throw new Error("no `gps ` atom inside moov - not a structural-path 70mai file");

        // Canonical table: version word @0, big-endian count @4, then
        // (offset u32 BE, size u32 BE) pairs from @8.
        const tStart = gps.payloadStart;
        const versionWord = moovBuf.readUInt32BE(tStart);
        const declared = moovBuf.readUInt32BE(tStart + 4);
        const capacity = Math.floor((gps.off + gps.size - (tStart + 8)) / 8);
        const total = Math.min(declared, capacity);
        const take = Math.min(numBlocks, total);
        if (take <= 0) throw new Error(`empty gps table (declared=${declared}, capacity=${capacity})`);

        // Read + anonymize the first `take` real block windows.
        const windows = [];
        for (let i = 0; i < take; i++) {
            const eOff = moovBuf.readUInt32BE(tStart + 8 + i * 8);
            const win = Buffer.alloc(BLOCK_WINDOW);
            readSync(fd, win, 0, BLOCK_WINDOW, eOff);
            const lit = literalOffset(win);
            if (lit < 0) throw new Error(`entry ${i} @${eOff}: no freeGPS literal`);
            if (!is70maiBlock(win, lit)) throw new Error(`entry ${i} @${eOff}: not a 70mai block`);
            const dv = new DataView(win.buffer, win.byteOffset, win.byteLength);
            // Whole-degree sentinel plus a per-block step (northbound track).
            const lat = LAT_BASE_DEG + i * STEP_DEG;
            const lon = LON_BASE_DEG;
            dv.setInt32(lit + OFF_LAT, encodeDdmm(lat), true);
            dv.setInt32(lit + OFF_LON, encodeDdmm(lon), true);
            windows.push(win);
        }

        // Rebuild container. Layout is deterministic, so absolute block offsets
        // are known before writing the table.
        const ftypBuf = Buffer.alloc(ftyp.size);
        readSync(fd, ftypBuf, 0, ftyp.size, ftyp.off);

        const tablePayloadLen = 8 + take * 8; // version + count + entries
        const gpsBoxSize = 8 + tablePayloadLen;
        const moovSize = 8 + gpsBoxSize;
        const mdatDataStart = ftyp.size + moovSize + 8; // ftyp + moov + mdat header

        const table = Buffer.alloc(tablePayloadLen);
        table.writeUInt32BE(versionWord >>> 0, 0);
        table.writeUInt32BE(take, 4);
        for (let i = 0; i < take; i++) {
            table.writeUInt32BE(mdatDataStart + i * BLOCK_WINDOW, 8 + i * 8);
            table.writeUInt32BE(BLOCK_WINDOW, 8 + i * 8 + 4);
        }
        const gpsBox = Buffer.concat([u32be(gpsBoxSize), Buffer.from("gps "), table]);
        const moovOut = Buffer.concat([u32be(moovSize), Buffer.from("moov"), gpsBox]);
        const mdatPayload = Buffer.concat(windows);
        const mdatOut = Buffer.concat([u32be(8 + mdatPayload.length), Buffer.from("mdat"), mdatPayload]);

        writeFileSync(output, Buffer.concat([ftypBuf, moovOut, mdatOut]));
        console.log(
            `wrote ${output}: ${take}/${total} blocks, version=0x${(versionWord >>> 0).toString(16)}, ` +
                `mdat blocks @${mdatDataStart}, total ${ftyp.size + moovSize + mdatOut.length} bytes`,
        );
    } finally {
        closeSync(fd);
    }
}

main();

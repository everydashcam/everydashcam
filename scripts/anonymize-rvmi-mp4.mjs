#!/usr/bin/env node
import { findFirstChild, readBoxBytes, box, fourCC, u32be, readBoxHeader } from "./_mp4-fixture.mjs";
// Anonymize a real RegistratorViewer-output .mp4 (with an RVMI metadata track)
// into a public-safe fixture for the extractor test.
//
// Source: one of the `Fragment of *.mp4` files from the Russian dashcam
// viewer RegistratorViewer (Vlad Antoshin, http://registratorviewer.com).
//
// Anonymization:
//   1. Walk the MP4 structure, find the RVMI track in moov (stsd entry='RVMI').
//   2. Read stsc/stsz/stco/stts/mdhd for the track, collect sample offsets.
//   3. Read the first N samples of the RVMI track from mdat (30 by default -
//      mix of 1x tReV + a handful of gReV (1Hz) + the rest sReV (9Hz)).
//   4. Redact gReV samples: bytes 4..7 (lon) and 8..11 (lat) rewritten to
//      sentinel coordinates (50.0/30.0 µdeg + per-record offset). sReV
//      acceleration and tReV OLE date are left as-is (not PII).
//   5. Assemble a minimal MP4: ftyp + moov with a single RVMI track and a
//      sample table for N samples + mdat with the redacted samples.
//
// Keeps the real cadence (stts deltas) - the extractor must correctly compute
// unixSeconds for each sample relative to the tReV baseline.
//
// Usage:
//   node scripts/anonymize-rvmi-mp4.mjs <input.mp4> <output.mp4> [numSamples=30]

import { openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";

const [, , inputPath, outputPath, numSamplesArg] = process.argv;
if (!inputPath || !outputPath) {
    console.error("usage: anonymize-rvmi-mp4.mjs <input.mp4> <output.mp4> [numSamples=30]");
    process.exit(1);
}
const numSamples = Number(numSamplesArg ?? 30);

const stat = statSync(inputPath);
const fd = openSync(inputPath, "r");

// Step 1: walk top-level, find moov.
let moov = null;
{
    let pos = 0;
    while (pos + 8 <= stat.size) {
        const h = readBoxHeader(fd, pos, stat.size);
        if (!h) break;
        if (h.type === "moov") {
            moov = { offset: pos, ...h };
            break;
        }
        pos += h.size;
    }
}
if (!moov) {
    console.error("no moov found");
    process.exit(1);
}

// Step 2: find RVMI trak inside moov.
let rvmiTrak = null;
{
    let pos = moov.offset + moov.headerSize;
    const end = moov.offset + moov.size;
    while (pos + 8 <= end) {
        const h = readBoxHeader(fd, pos, stat.size);
        if (!h) break;
        if (h.type === "trak") {
            // Check stsd entry type via mdia/minf/stbl/stsd.
            const mdia = findFirstChild(fd, { offset: pos, ...h }, stat.size, "mdia");
            if (mdia) {
                const minf = findFirstChild(fd, mdia, stat.size, "minf");
                if (minf) {
                    const stbl = findFirstChild(fd, minf, stat.size, "stbl");
                    if (stbl) {
                        const stsd = findFirstChild(fd, stbl, stat.size, "stsd");
                        if (stsd) {
                            // stsd payload: version(1)+flags(3)+entry_count(4)+entry: size(4)+type(4)
                            const stsdBuf = Buffer.alloc(stsd.size);
                            readSync(fd, stsdBuf, 0, stsd.size, stsd.offset);
                            const entryType = stsdBuf.toString(
                                "ascii",
                                stsd.headerSize + 8 + 4,
                                stsd.headerSize + 8 + 8,
                            );
                            if (entryType === "RVMI") {
                                rvmiTrak = { offset: pos, ...h, mdia, minf, stbl, stsd };
                                break;
                            }
                        }
                    }
                }
            }
        }
        pos += h.size;
    }
}
if (!rvmiTrak) {
    console.error("no RVMI track found");
    process.exit(1);
}

// Step 3: read sample-table from RVMI trak.
function readBoxFromStbl(typeName) {
    const b = findFirstChild(fd, rvmiTrak.stbl, stat.size, typeName);
    if (!b) throw new Error(`stbl missing ${typeName}`);
    const buf = readBoxBytes(fd, b);
    return { box: b, buf };
}

const stsc = readBoxFromStbl("stsc");
const stsz = readBoxFromStbl("stsz");
const stco = readBoxFromStbl("stco");
const stts = readBoxFromStbl("stts");
const mdhd = (() => {
    const b = findFirstChild(fd, rvmiTrak.mdia, stat.size, "mdhd");
    if (!b) throw new Error("mdia missing mdhd");
    const buf = readBoxBytes(fd, b);
    return { box: b, buf };
})();

// Parse mdhd to get timescale.
const mdhdPayload = mdhd.box.headerSize;
const mdhdVersion = mdhd.buf.readUInt8(mdhdPayload);
const mediaTimescale =
    mdhdVersion === 1 ? mdhd.buf.readUInt32BE(mdhdPayload + 4 + 16) : mdhd.buf.readUInt32BE(mdhdPayload + 4 + 8);

// Parse stsc - array of {first_chunk, samples_per_chunk, sdi}.
function parseStsc(buf, h) {
    const payload = h.headerSize;
    const count = buf.readUInt32BE(payload + 4);
    const arr = [];
    for (let i = 0; i < count; i++) {
        const off = payload + 8 + i * 12;
        arr.push({
            firstChunk: buf.readUInt32BE(off),
            samplesPerChunk: buf.readUInt32BE(off + 4),
        });
    }
    return arr;
}

// Parse stsz - per-sample sizes (or constant sample_size).
function parseStsz(buf, h) {
    const payload = h.headerSize;
    const ss = buf.readUInt32BE(payload + 4);
    const cnt = buf.readUInt32BE(payload + 8);
    const sizes = [];
    if (ss > 0) for (let i = 0; i < cnt; i++) sizes.push(ss);
    else for (let i = 0; i < cnt; i++) sizes.push(buf.readUInt32BE(payload + 12 + i * 4));
    return sizes;
}

// Parse stco - chunk offsets (absolute).
function parseStco(buf, h) {
    const payload = h.headerSize;
    const count = buf.readUInt32BE(payload + 4);
    const arr = [];
    for (let i = 0; i < count; i++) arr.push(buf.readUInt32BE(payload + 8 + i * 4));
    return arr;
}

// Parse stts - array of [sample_count, sample_delta].
function parseStts(buf, h) {
    const payload = h.headerSize;
    const count = buf.readUInt32BE(payload + 4);
    const arr = [];
    for (let i = 0; i < count; i++) {
        const off = payload + 8 + i * 8;
        arr.push({ sampleCount: buf.readUInt32BE(off), sampleDelta: buf.readUInt32BE(off + 4) });
    }
    return arr;
}

const stscArr = parseStsc(stsc.buf, stsc.box);
const sizes = parseStsz(stsz.buf, stsz.box);
const chunkOffsets = parseStco(stco.buf, stco.box);
const sttsArr = parseStts(stts.buf, stts.box);

// Compute absolute sample offsets per sample (samples-to-chunk).
function samplesPerChunkAt(stscArr, chunkIdx0) {
    const chunkIdx1 = chunkIdx0 + 1;
    let cur = 0;
    for (const e of stscArr) {
        if (e.firstChunk <= chunkIdx1) cur = e.samplesPerChunk;
        else break;
    }
    return cur;
}

const sampleAbsOffsets = [];
let sIdx = 0;
for (let ci = 0; ci < chunkOffsets.length; ci++) {
    const spc = samplesPerChunkAt(stscArr, ci);
    let off = chunkOffsets[ci];
    for (let i = 0; i < spc && sIdx < sizes.length; i++) {
        sampleAbsOffsets.push(off);
        off += sizes[sIdx];
        sIdx++;
    }
}

// Expand stts to per-sample deltas (for our preserved-cadence stts).
const perSampleDeltas = [];
for (const e of sttsArr) for (let i = 0; i < e.sampleCount; i++) perSampleDeltas.push(e.sampleDelta);

// Step 4: read first numSamples sample bytes; redact gReV coords.
const keepCount = Math.min(numSamples, sampleAbsOffsets.length);
const sampleBuffers = [];
let gReVRedactIdx = 0;
const baseLatMicroDeg = 50_000_000;
const baseLonMicroDeg = 30_000_000;
for (let i = 0; i < keepCount; i++) {
    const sz = sizes[i];
    const buf = Buffer.alloc(sz);
    readSync(fd, buf, 0, sz, sampleAbsOffsets[i]);
    const magic = buf.toString("ascii", 0, 4);
    if (magic === "gReV" && sz >= 12) {
        // bytes 4..7 = i32 LE lon, bytes 8..11 = i32 LE lat.
        const lonMicro = baseLonMicroDeg + gReVRedactIdx * 100; // 0.0001° per record
        const latMicro = baseLatMicroDeg + gReVRedactIdx * 100;
        buf.writeInt32LE(lonMicro, 4);
        buf.writeInt32LE(latMicro, 8);
        gReVRedactIdx++;
    }
    sampleBuffers.push(buf);
}
closeSync(fd);

console.error(`kept ${keepCount} samples (timescale=${mediaTimescale}, ${gReVRedactIdx} gReV redacted)`);

// Step 5: build minimal MP4 with one RVMI trak + N samples.

// hdlr: handler_type='data'.
const hdlr = (() => {
    const p = Buffer.alloc(33);
    fourCC("data").copy(p, 8); // handler_type at offset 8 (after version+flags+pre_defined)
    return box("hdlr", p);
})();

// mdhd: version=0, creation/modification=0, timescale, duration=sum of deltas.
let totalDuration = 0;
for (let i = 0; i < keepCount; i++) totalDuration += perSampleDeltas[i] ?? 0;
const mdhdNew = (() => {
    const p = Buffer.alloc(24);
    p.writeUInt32BE(0, 0); // version+flags
    p.writeUInt32BE(0, 4); // creation
    p.writeUInt32BE(0, 8); // modification
    p.writeUInt32BE(mediaTimescale, 12);
    p.writeUInt32BE(totalDuration, 16);
    p.writeUInt16BE(0x55c4, 20); // language 'und'
    p.writeUInt16BE(0, 22);
    return box("mdhd", p);
})();

// stsd: 1 entry of format 'RVMI', minimal 16-byte sample entry.
const stsdNew = (() => {
    const entry = Buffer.alloc(16);
    entry.writeUInt32BE(16, 0);
    fourCC("RVMI").copy(entry, 4);
    // reserved (6) + data_reference_index (2) = zeros
    const p = Buffer.concat([Buffer.alloc(4), u32be(1), entry]);
    return box("stsd", p);
})();

// stts: per-sample deltas (one entry per unique run, but we could just as
// well emit one entry per sample - even with sample_count=1 for each).
const sttsNew = (() => {
    // Group consecutive equal deltas into runs for smaller stts.
    const runs = [];
    let curDelta = -1;
    let curCount = 0;
    for (let i = 0; i < keepCount; i++) {
        const d = perSampleDeltas[i] ?? 0;
        if (d === curDelta) {
            curCount++;
        } else {
            if (curCount > 0) runs.push({ count: curCount, delta: curDelta });
            curDelta = d;
            curCount = 1;
        }
    }
    if (curCount > 0) runs.push({ count: curCount, delta: curDelta });
    const p = Buffer.concat([
        Buffer.alloc(4),
        u32be(runs.length),
        ...runs.flatMap((r) => [u32be(r.count), u32be(r.delta)]),
    ]);
    return box("stts", p);
})();

// stsc: a single entry first_chunk=1 samples_per_chunk=keepCount.
const stscNew = (() => {
    const p = Buffer.concat([Buffer.alloc(4), u32be(1), u32be(1), u32be(keepCount), u32be(1)]);
    return box("stsc", p);
})();

// stsz: per-sample sizes for first keepCount.
const stszNew = (() => {
    const arr = sampleBuffers.map((b) => b.length);
    const p = Buffer.concat([Buffer.alloc(4), u32be(0), u32be(keepCount), ...arr.map(u32be)]);
    return box("stsz", p);
})();

// stco - placeholder, patched once we know the moov+ftyp size.
const stcoPlaceholder = box("stco", Buffer.concat([Buffer.alloc(4), u32be(1), u32be(0)]));

const dinf = (() => {
    const dref = box(
        "dref",
        Buffer.concat([Buffer.alloc(4), u32be(1), u32be(12), fourCC("url "), Buffer.from([0, 0, 0, 1])]),
    );
    return box("dinf", dref);
})();

const stbl = box("stbl", Buffer.concat([stsdNew, sttsNew, stscNew, stszNew, stcoPlaceholder]));
const minf = box("minf", Buffer.concat([dinf, stbl]));
const mdia = box("mdia", Buffer.concat([mdhdNew, hdlr, minf]));

const tkhd = (() => {
    const p = Buffer.alloc(84);
    p.writeUInt32BE(0x000007, 0); // version=0, flags=enabled+used+poster
    p.writeUInt32BE(1, 12); // track_id
    p.writeUInt32BE(totalDuration, 20);
    return box("tkhd", p);
})();

const trak = box("trak", Buffer.concat([tkhd, mdia]));

const mvhd = (() => {
    const p = Buffer.alloc(108);
    p.writeUInt32BE(1000, 12); // timescale
    p.writeUInt32BE(0, 16); // duration (0 - mvhd duration isn't used by our extractor)
    p.writeUInt32BE(2, 96 + 4); // next_track_id... actually offset is at end
    return box("mvhd", p);
})();

const moovNew = box("moov", Buffer.concat([mvhd, trak]));
const ftypNew = box(
    "ftyp",
    Buffer.concat([fourCC("isom"), u32be(512), fourCC("isom"), fourCC("avc1"), fourCC("mp41")]),
);

const mdat = box("mdat", Buffer.concat(sampleBuffers));
const mdatDataOffset = ftypNew.length + moovNew.length + 8;

// Patch stco placeholder inside moovNew.
const stcoOffsetInMoov = moovNew.indexOf(stcoPlaceholder);
const chunkOffsetPos = stcoOffsetInMoov + 8 + 4 + 4;
const moovPatched = Buffer.from(moovNew);
moovPatched.writeUInt32BE(mdatDataOffset, chunkOffsetPos);

const out = Buffer.concat([ftypNew, moovPatched, mdat]);
writeFileSync(outputPath, out);
console.error(`wrote ${out.length} bytes to ${outputPath}`);

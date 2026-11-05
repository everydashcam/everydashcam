#!/usr/bin/env node
// Builds a public-safe openpilot segment fixture from a real qlog.
//
// qlog: keeps only the events the viewer decodes - GPS fixes, the four camera
// encode indexes and system clock samples (src/parsers/internal/openpilot-log.ts)
// - and drops everything else, including initData, which carries the dongle id,
// device parameters and git remotes. Encode indexes are trimmed to the first
// <frames> frames of each camera and GPS/clock events to a short window after
// the first frame. Latitude and longitude are rounded to whole degrees and
// altitude zeroed, in place; timestamps stay untouched (without position and
// footage they identify nothing). Messages are copied verbatim otherwise, so
// the fixture exercises the real Cap'n Proto layout.
//
// Video: every camera stream is replaced by an ffmpeg test pattern (one per
// camera) with the same frame count at openpilot's 20 fps - raw HEVC for
// fcamera/ecamera/dcamera, H.264 MPEG-TS for qcamera - so the log's frame index
// matches the files.
//
// Usage:
//   node scripts/anonymize-openpilot-segment.mjs <qlog.zst> <out-dir> <name-prefix> \
//       [--frames 60] [--gps-window 10] [--videos fcamera,ecamera,dcamera,qcamera]
// --videos picks the video files to synthesize (a connect download may hold
// only the qcamera preview); the qlog keeps the frame index of all four.
// <name-prefix> is the connect-download prefix of the output files, e.g.
// 0123456789abcdef_00000001--0000000000--19 (use a synthetic dongle id and route).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

const FRAME_RATE = 20;
// Event union discriminants and field offsets: see openpilot-log.ts.
const EVENT_DISCRIMINANT = 8;
const GPS_EVENTS = new Set([20, 47]);
const CLOCKS_EVENT = 34;
const ENCODE_INDEX_EVENTS = new Map([
    [14, "fcamera"],
    [74, "dcamera"],
    [75, "ecamera"],
    [88, "qcamera"],
]);
const GPS_LATITUDE = 8;
const GPS_LONGITUDE = 16;
const GPS_ALTITUDE = 24;
const ENCODE_SEGMENT_ID = 16;
const ENCODE_TIMESTAMP_SOF = 24;

const [, , qlogPath, outDir, prefix, ...rest] = process.argv;
if (!qlogPath || !outDir || !prefix) {
    console.error(
        "usage: anonymize-openpilot-segment.mjs <qlog.zst> <out-dir> <name-prefix> [--frames N] [--gps-window S] [--videos a,b]",
    );
    process.exit(1);
}
const option = (name, fallback) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : fallback;
};
const frames = Number(option("frames", "60"));
const gpsWindowSec = Number(option("gps-window", "10"));
const videos = option("videos", "fcamera,ecamera,dcamera,qcamera").split(",");
if (!Number.isInteger(frames) || frames <= 0 || !(gpsWindowSec > 0)) {
    console.error("invalid --frames or --gps-window");
    process.exit(1);
}

const bytes = new Uint8Array(zstdDecompressSync(readFileSync(qlogPath)));
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Root struct and union pointer target of each message, plus its byte range. */
function* messages() {
    let pos = 0;
    while (pos < bytes.byteLength) {
        const segments = view.getUint32(pos, true) + 1;
        const table = Math.ceil((4 + 4 * segments) / 8) * 8;
        let words = 0;
        for (let i = 0; i < segments; i++) words += view.getUint32(pos + 4 + 4 * i, true);
        const body = pos + table;
        const end = body + 8 * words;
        const event = structAt(body);
        if (!event) throw new Error(`message root at ${pos} is not a struct`);
        const discriminant = view.getUint16(event.data + EVENT_DISCRIMINANT, true);
        // Only single-segment payloads are followed (as in the decoder). Large
        // events such as initData span segments; they are dropped regardless.
        const payload = segments === 1 && event.pointers !== null ? structAt(event.pointers) : null;
        yield { start: pos, end, monoNs: view.getBigUint64(event.data, true), discriminant, payload };
        pos = end;
    }
}

function structAt(pointerPos) {
    const lo = view.getUint32(pointerPos, true);
    const hi = view.getUint32(pointerPos + 4, true);
    // List payloads (CAN frames, log text) are not decoded; they are dropped.
    if ((lo & 3) !== 0) return null;
    const data = pointerPos + 8 + 8 * (lo >> 2);
    const dataWords = hi & 0xffff;
    return { data, pointers: hi >>> 16 > 0 ? data + 8 * dataWords : null };
}

// First pass: the window starts at the earliest frame 0 of any camera.
let firstFrameNs = null;
for (const m of messages()) {
    if (!ENCODE_INDEX_EVENTS.has(m.discriminant) || !m.payload) continue;
    if (view.getUint32(m.payload.data + ENCODE_SEGMENT_ID, true) !== 0) continue;
    const sof = view.getBigUint64(m.payload.data + ENCODE_TIMESTAMP_SOF, true);
    if (firstFrameNs === null || sof < firstFrameNs) firstFrameNs = sof;
}
if (firstFrameNs === null) throw new Error("no frame 0 in any encode index");
const windowEndNs = firstFrameNs + BigInt(Math.round(gpsWindowSec * 1e9));

const kept = [];
let gpsKept = 0;
for (const m of messages()) {
    if (ENCODE_INDEX_EVENTS.has(m.discriminant)) {
        if (!m.payload) continue;
        if (view.getUint32(m.payload.data + ENCODE_SEGMENT_ID, true) >= frames) continue;
    } else if (GPS_EVENTS.has(m.discriminant)) {
        if (!m.payload || m.monoNs < firstFrameNs || m.monoNs > windowEndNs) continue;
        view.setFloat64(
            m.payload.data + GPS_LATITUDE,
            Math.round(view.getFloat64(m.payload.data + GPS_LATITUDE, true)),
            true,
        );
        view.setFloat64(
            m.payload.data + GPS_LONGITUDE,
            Math.round(view.getFloat64(m.payload.data + GPS_LONGITUDE, true)),
            true,
        );
        view.setFloat64(m.payload.data + GPS_ALTITUDE, 0, true);
        gpsKept++;
    } else if (m.discriminant === CLOCKS_EVENT) {
        if (m.monoNs < firstFrameNs || m.monoNs > windowEndNs) continue;
    } else {
        continue;
    }
    kept.push(bytes.slice(m.start, m.end));
}
const out = new Uint8Array(kept.reduce((sum, m) => sum + m.byteLength, 0));
let offset = 0;
for (const m of kept) {
    out.set(m, offset);
    offset += m.byteLength;
}
mkdirSync(outDir, { recursive: true });
const qlogOut = join(outDir, `${prefix}--qlog.zst`);
writeFileSync(qlogOut, zstdCompressSync(out));
console.error(`qlog: ${kept.length} events (${gpsKept} gps) -> ${qlogOut}`);

// A distinct pattern per camera: identical bytes would make the cameras of a
// segment look like copies of one recording to ingest deduplication.
const SOURCES = { fcamera: "testsrc2", ecamera: "smptehdbars", dcamera: "testsrc", qcamera: "testsrc2" };
const durationSec = frames / FRAME_RATE;
for (const stream of videos) {
    const isPreview = stream === "qcamera";
    // Upper-case .TS, like the repository's other MPEG-TS fixtures: TypeScript
    // would compile a .ts file under src/. openpilot names match in any case.
    const outPath = join(outDir, `${prefix}--${stream}.${isPreview ? "TS" : "hevc"}`);
    const source = SOURCES[stream];
    if (!source) throw new Error(`unknown video stream ${stream}`);
    const args = [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `${source}=size=${isPreview ? "264x166" : "320x192"}:rate=${FRAME_RATE}:duration=${durationSec}`,
        "-frames:v",
        String(frames),
        "-pix_fmt",
        "yuv420p",
        ...(isPreview
            ? ["-c:v", "libx264", "-preset", "ultrafast", "-g", "15", "-bf", "0", "-f", "mpegts"]
            : [
                  "-c:v",
                  "libx265",
                  "-preset",
                  "ultrafast",
                  // As openpilot encodes: no B-frames, closed GOPs (IDR every
                  // second) and two slices per picture.
                  "-x265-params",
                  "log-level=error:keyint=20:min-keyint=20:bframes=0:open-gop=0:slices=2:info=0",
                  "-f",
                  "hevc",
              ]),
        outPath,
    ];
    const res = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
    if (res.status !== 0) throw new Error(`ffmpeg failed for ${stream}`);
    if (!isPreview) writeFileSync(outPath, leadingParameterSetsOnly(readFileSync(outPath)));
    console.error(`${stream}: ${frames} synthetic frames -> ${outPath}`);
}

/**
 * Drops VPS/SPS/PPS that repeat after the first picture. ffmpeg's raw HEVC
 * output always repeats them before every key frame; openpilot writes one set
 * at the start of each file, which is what the viewer's hvc1 path expects.
 */
function leadingParameterSetsOnly(stream) {
    const starts = [];
    for (let i = 2; i < stream.length; i++) {
        if (stream[i] === 1 && stream[i - 1] === 0 && stream[i - 2] === 0) {
            let zeros = i - 2;
            while (zeros > 0 && stream[zeros - 1] === 0) zeros--;
            starts.push({ unit: zeros, type: (stream[i + 1] >> 1) & 0x3f });
        }
    }
    const kept = [];
    let seenPicture = false;
    starts.forEach(({ unit, type }, n) => {
        const end = n + 1 < starts.length ? starts[n + 1].unit : stream.length;
        if (type < 32) seenPicture = true;
        else if (seenPicture && type >= 32 && type <= 34) return;
        kept.push(stream.subarray(unit, end));
    });
    return Buffer.concat(kept);
}

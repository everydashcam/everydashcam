#!/usr/bin/env node
// Anonymizes real 70mai $V02 GPS logs from private/ into committed
// test fixtures. Keeps exactly the structure the parser depends on (format,
// delimiters, validity flags, column order, accel columns) but strips location
// by rounding lat/lon to whole degrees (~110 km - the region stays undisclosed).
//
// The default pair exists on purpose: the accelerometer's gravity-bearing
// axis is MODEL-DEPENDENT - x800 carries ~1g on field6/ay (column 7), A810 on
// field5/ax (column 6). Both fixtures exist so the regression test can prove
// gravity removal is model-agnostic (see csv-70mai.ts and real-anonymized.test.ts).
//
// Timestamps and MP4 filenames carry over as-is: recording time without
// coordinates or video content isn't sensitive, and shifting it would only
// confuse debugging given this script ships in the repo.
//
// Run:
//   node scripts/anonymize-70mai-log.mjs
//   node scripts/anonymize-70mai-log.mjs <input.txt> <output.txt> [--from-utc <ISO-UTC>]
// --from-utc selects records by their corrected UTC clock without changing
// the stored timestamp. Useful for whole-card logs whose first session does
// not overlap the supplied video.
//
// Idempotent w.r.t. its inputs: re-running gives the same output (determined
// only by input content + the constants below).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// input -> output. Inputs live in the gitignored private/ (never
// committed); outputs are the committed fixtures.
const SAMPLES = [
    {
        input: "private/samples/70mai-x800-GPSData000001.txt",
        output: "src/parsers/__fixtures__/70mai/real-anonymized-x800.txt",
    },
    {
        input: "private/samples/70mai-a810-GPSData000001.txt",
        output: "src/parsers/__fixtures__/70mai/real-anonymized-a810.txt",
    },
];

// Records per fixture: enough to show the accel axis and a session, small
// enough to keep the diff readable.
const MAX_LINES = 50;
const FIELDS_PER_ROW = 13;
// Same firmware clock correction as csv-70mai.ts; selection only.
const GPS_TIMESTAMP_FIRMWARE_OFFSET_SEC = 8 * 3600;

// Rounds one log's records to whole-degree coordinates, keeping the first
// MAX_LINES well-formed rows after the optional UTC boundary. Session
// separators remain intact so an unnamed log keeps its recording boundaries.
// Preserve the optional write-cursor header as metadata. Its original byte
// offset describes the source log, not this shortened fixture.
// Malformed rows are covered by synthetic-edge.txt, not the real fixture.
function anonymizeLog(text, fromUtcSec = -Infinity) {
    const lines = text.split(/\r?\n/);
    const out = [];
    let signature = null;
    let session = 0;
    let writtenSession = -1;
    let seekPosition = null;

    let kept = 0;
    for (let i = 0; i < lines.length && kept < MAX_LINES; i++) {
        const raw = lines[i].trim();
        if (raw === "") continue;
        if (/^\$V\d{2}$/.test(raw)) {
            signature = raw;
            session++;
            continue;
        }
        if (/^gSeekPos=\s*\d+$/.test(raw)) {
            seekPosition = raw;
            continue;
        }
        const parts = raw.split(",");
        if (signature === null || parts.length !== FIELDS_PER_ROW) continue;
        const timestamp = Number(parts[0]);
        const latitude = Number(parts[2]);
        const longitude = Number(parts[3]);
        if (
            !Number.isFinite(timestamp) ||
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude) ||
            Math.abs(latitude) > 90 ||
            Math.abs(longitude) > 180
        ) {
            continue;
        }
        if (timestamp + GPS_TIMESTAMP_FIRMWARE_OFFSET_SEC < fromUtcSec) continue;

        const lat = Math.round(latitude).toFixed(6);
        const lon = Math.round(longitude).toFixed(6);
        if (session !== writtenSession) {
            const isFirstSession = out.length === 0;
            out.push(signature);
            if (isFirstSession && seekPosition !== null) out.push(seekPosition);
            writtenSession = session;
        }

        out.push(
            [
                parts[0],
                parts[1],
                lat,
                lon,
                parts[4],
                parts[5],
                parts[6],
                parts[7],
                parts[8],
                parts[9],
                parts[10],
                parts[11],
                parts[12],
            ].join(","),
        );
        kept++;
    }
    if (kept === 0) throw new Error("no matching gps records");

    out.push("");
    return { text: out.join("\n"), kept };
}

function samplesFromArgs(args) {
    if (args.length === 0) return SAMPLES;
    if (args.length !== 2 && args.length !== 4) {
        throw new Error("usage: anonymize-70mai-log.mjs <input.txt> <output.txt> [--from-utc <ISO-UTC>]");
    }
    const [input, output, flag, utc] = args;
    if (args.length === 2) return [{ input, output }];
    if (flag !== "--from-utc" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(utc)) {
        throw new Error("--from-utc requires an ISO timestamp ending in Z");
    }
    const fromUtcSec = Date.parse(utc) / 1000;
    if (!Number.isFinite(fromUtcSec)) throw new Error("invalid UTC timestamp");
    return [{ input, output, fromUtcSec }];
}

function main() {
    for (const { input, output, fromUtcSec } of samplesFromArgs(process.argv.slice(2))) {
        const { text, kept } = anonymizeLog(readFileSync(resolve(REPO_ROOT, input), "utf8"), fromUtcSec);
        const outPath = resolve(REPO_ROOT, output);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, text);
        console.log(`wrote ${kept} anonymized records -> ${output}`);
    }
}

main();

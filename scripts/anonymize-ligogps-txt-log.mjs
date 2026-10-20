#!/usr/bin/env node
// Anonymizes a LigoGPS TXT log (the plaintext twin of an enciphered .TS PES,
// docs/format-ligogps-ts-pes.md) into a snapshot fixture.
//
//   - "N:dd.dddddd" / "E:ddd.dddddd" fraction digits are zeroed (whole
//     degrees, same byte length);
//   - the altitude field after the course has its digits zeroed;
//   - timestamps, speed, course, satellite count and accelerometer values are
//     the camera's own (without coordinates they are not sensitive, and real
//     values keep the snapshot meaningful);
//   - the log is trimmed to `records` lines from `startRecord`.
//
// Usage:
//   node scripts/anonymize-ligogps-txt-log.mjs <input.TXT> <output.TXT> [records=40] [startRecord=0]

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [, , inputPath, outputPath, recordsArg, startArg] = process.argv;
if (!inputPath || !outputPath) {
    console.error("usage: anonymize-ligogps-txt-log.mjs <input.TXT> <output.TXT> [records=40] [startRecord=0]");
    process.exit(1);
}
if (!existsSync(inputPath)) throw new Error(`input not found: ${inputPath}`);
const recordCount = Number(recordsArg ?? 40);
const startRecord = Number(startArg ?? 0);
if (!Number.isInteger(recordCount) || recordCount <= 0 || !Number.isInteger(startRecord) || startRecord < 0) {
    throw new Error("invalid records or startRecord");
}

const text = readFileSync(inputPath, "latin1");
const newline = text.includes("\r\n") ? "\r\n" : "\n";
const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
const selected = lines.slice(startRecord, startRecord + recordCount);
if (selected.length !== recordCount)
    throw new Error(`log has ${lines.length} lines, need ${startRecord + recordCount}`);

// Fail closed: unknown lines or extra fields may contain coordinates or an
// identifier that the replacements below do not know how to anonymize.
const RECORD_RX =
    /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} [NS?]:-?\d+\.\d+ [EW?]:-?\d+\.\d+ -?\d+(?:\.\d+)? km\/h -?\d+(?:\.\d+)? -?\d+(?:\.\d+)? \d+ x:-?\d+(?:\.\d+)? y:-?\d+(?:\.\d+)? z:-?\d+(?:\.\d+)?$/;

const scrubbed = selected.map((line, index) => {
    if (!RECORD_RX.test(line)) throw new Error(`line ${index}: unsupported record shape`);
    const out = line
        .replace(
            /([NSEW?]):(-?\d+)\.(\d+)/g,
            (_m, hemisphere, whole, fraction) => `${hemisphere}:${whole}.${"0".repeat(fraction.length)}`,
        )
        .replace(/(km\/h -?[\d.]+ )(-?[\d.]+)/, (_m, lead, altitude) => lead + altitude.replace(/\d/g, "0"));
    if (out.length !== line.length) throw new Error(`line ${index}: length changed`);
    if (/\d+\.\d*[1-9]\d* [EW]:|[NS]:\d+\.\d*[1-9]/.test(out))
        throw new Error(`line ${index}: coordinate fraction survived`);
    return out;
});

writeFileSync(outputPath, scrubbed.join(newline) + newline, "latin1");
console.error(`done -> ${outputPath} (${scrubbed.length} records)`);

#!/usr/bin/env node
// Anonymizes a real 70mai dated GPS log (eight fields per row, no `$Vxx`
// header; see src/parsers/primitives/csv-70mai-dated.ts) into a committed
// test fixture. Coordinates are rounded to whole degrees (~110 km), so the
// region stays undisclosed. Timestamps, speeds, flags and clip names carry
// over as-is: without coordinates or video they are not sensitive, and the
// parser's binding and clock behavior depend on them.
//
// A whole-card log is hundreds of thousands of rows. The fixture keeps
// explicit 1-based source line ranges so each firmware quirk (session start,
// clip rollover, no-fix placeholders before an `N` row, unnamed fixes, a
// camera clock change) stays visible in a short, reviewable file.
//
// Run:
//   node scripts/anonymize-70mai-dated-log.mjs <input.txt> <output.txt> --lines 1-6,137-141
//
// Deterministic: the output depends only on the input content and the ranges.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const RX_ROW =
    /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),([A-Z]),([AV]),(\d{3}km\/h),(\s*-?\d+\.\d+),(\s*-?\d+\.\d+),([01]),(\d{8}-\d{6}-\d+[A-Z]\.MP4|0+)$/;

function parseRanges(spec) {
    if (!/^\d+-\d+(?:,\d+-\d+)*$/.test(spec)) throw new Error("--lines expects ranges like 1-6,137-141");
    const ranges = spec.split(",").map((range) => range.split("-").map(Number));
    let previousEnd = 0;
    for (const [start, end] of ranges) {
        if (start < 1 || end < start || start <= previousEnd) {
            throw new Error(`line ranges must be ascending and non-overlapping: ${spec}`);
        }
        previousEnd = end;
    }
    return ranges;
}

// Keeps the zero coordinates of no-fix placeholders as written, including the
// firmware's leading space, because the parser must accept that exact shape.
function roundCoordinate(field) {
    const value = Number(field);
    if (value === 0) return field;
    return Math.round(value).toFixed(6);
}

function anonymizeLog(text, ranges) {
    const lines = text.split("\n");
    const out = [];
    for (const [start, end] of ranges) {
        if (end > lines.length) throw new Error(`line ${end} is past the end of the log (${lines.length} lines)`);
        for (let lineNumber = start; lineNumber <= end; lineNumber++) {
            const raw = lines[lineNumber - 1];
            const match = RX_ROW.exec(raw);
            if (!match) throw new Error(`line ${lineNumber} is not a dated 70mai row`);
            const [, time, mark, status, speed, lat, lon, sessionStart, clip] = match;
            out.push(
                [time, mark, status, speed, roundCoordinate(lat), roundCoordinate(lon), sessionStart, clip].join(","),
            );
        }
    }
    out.push("");
    return out.join("\n");
}

function main(args) {
    if (args.length !== 4 || args[2] !== "--lines") {
        throw new Error("usage: anonymize-70mai-dated-log.mjs <input.txt> <output.txt> --lines <a-b,c-d,...>");
    }
    const [input, output, , spec] = args;
    const text = anonymizeLog(readFileSync(resolve(input), "utf8"), parseRanges(spec));
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(resolve(output), text);
    console.log(`${input} -> ${output}: ${text.split("\n").length - 1} rows`);
}

main(process.argv.slice(2));

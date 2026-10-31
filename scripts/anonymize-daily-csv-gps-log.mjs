#!/usr/bin/env node
// Preserve camera-local timestamps, hemisphere columns, speed and altitude;
// replace DDmm coordinates with whole degrees and retain a short clip boundary.
// Usage: node scripts/anonymize-daily-csv-gps-log.mjs input.dat output.dat startClock [count]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [input, output, start, countText = "50"] = process.argv.slice(2);
const count = Number(countText);
if (!input || !output || !/^\d{14}$/.test(start ?? "") || !Number.isInteger(count) || count < 1 || count > 50) {
    throw new Error("expected input, output, 14-digit start clock and count from 1 to 50");
}
const lines = readFileSync(resolve(input), "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
const selected = [];
let records = 0;
let previous = "";
let changedCoordinates = 0;
for (const line of lines) {
    if (records === count) break;
    const raw = line.trim();
    if (raw === "#") {
        if (records > 0) selected.push("#");
        continue;
    }
    const fields = raw.split(",");
    if (fields.length !== 7 || !/^\d{14}$/.test(fields[0]) || fields[0] < start) continue;
    if (fields[0] <= previous) throw new Error("source clock is not monotonic");
    previous = fields[0];
    for (const index of [1, 3]) {
        const rawCoordinate = Number(fields[index]);
        const degrees = Math.floor(rawCoordinate / 100);
        const minutes = rawCoordinate - degrees * 100;
        if (!Number.isFinite(rawCoordinate) || rawCoordinate < 0 || minutes >= 60) {
            throw new Error("invalid source coordinate");
        }
        const rounded = Math.round(degrees + minutes / 60);
        const rewritten = rounded * 100;
        if (rewritten === rawCoordinate) throw new Error("source coordinate was not changed");
        fields[index] = rewritten.toFixed(5);
        changedCoordinates++;
    }
    selected.push(fields.join(","));
    records++;
}
if (records !== count || changedCoordinates !== count * 2) throw new Error("not enough anonymized source rows");
const text = `#\n${selected.join("\n")}\n`;
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(resolve(output), text);
console.log(`wrote ${records} rows with ${changedCoordinates} rounded coordinates`);

// End-to-end parse of anonymized real 70mai $V02 logs. Coordinates are
// rounded to whole degrees (see scripts/anonymize-70mai-log.mjs), everything
// else is byte-for-byte from real cards. The gravity-bearing
// accel axis is model-dependent (x800 on ay/field 7, A810 on ax/field 6), yet
// gravity must be removed without a hard-coded axis. A500S has no video
// filenames at all and retains its UTC fixes for scoped time association.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
    matchFilenameChannel,
    matchFilenameMode,
    matchFilenameSequence,
    matchFilenameTime,
} from "../../filename/index.js";
import { csv70maiPrimitive } from "../../primitives/csv-70mai.js";
import { makeVendorFile } from "../helpers.js";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

// Per-axis mean of the RAW accel columns (6=ax, 7=ay, 8=az), in g, over the
// fix-valid rows of a fixture. Used to assert which axis carries gravity before
// the parser removes it.
function rawAxisMeans(text: string): { x: number; y: number; z: number } {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let n = 0;
    for (const line of text.split(/\r?\n/).slice(1)) {
        const p = line.split(",");
        if (p.length !== 13 || p[1] !== "A") continue;
        sx += Number(p[6]) / 100;
        sy += Number(p[7]) / 100;
        sz += Number(p[8]) / 100;
        n++;
    }
    return { x: sx / n, y: sy / n, z: sz / n };
}

async function parseFixture(name: string) {
    const text = readFileSync(resolve(FIXTURES_DIR, name), "utf8");
    const result = await csv70maiPrimitive.parse(makeVendorFile(name, text));
    return { text, result };
}

describe("70mai real-anonymized fixtures", () => {
    it.each([
        ["NO20261020-162549-000239F.MP4", "2026-10-20T16:25:49Z", 239],
        ["NO20261020-163049-000244F.MP4", "2026-10-20T16:30:49Z", 244],
    ])("a500s: classifies all filename fields of %s", (name, localClock, sequence) => {
        const file = makeVendorFile(name, "");
        expect(matchFilenameTime(file)).toEqual({
            matchedId: "70mai-time",
            value: new Date(localClock),
        });
        expect(matchFilenameChannel(file)).toEqual({
            matchedId: "70mai-channel",
            value: { channel: "front", confident: true },
        });
        expect(matchFilenameMode(file)).toEqual({ matchedId: "70mai-mode", value: "normal" });
        expect(matchFilenameSequence(file)).toEqual({ matchedId: "70mai-sequence", value: sequence });
    });

    it("x800: carries gravity on the ay axis (field 7) in the raw log", async () => {
        const { text } = await parseFixture("real-anonymized-x800.txt");
        const raw = rawAxisMeans(text);
        expect(Math.abs(raw.y)).toBeGreaterThan(0.8); // ~1g on ay
        expect(Math.abs(raw.x)).toBeLessThan(0.3);
    });

    it("a810: carries gravity on the ax axis (field 6) in the raw log", async () => {
        const { text } = await parseFixture("real-anonymized-a810.txt");
        const raw = rawAxisMeans(text);
        expect(Math.abs(raw.x)).toBeGreaterThan(0.8); // ~1g on ax
        expect(Math.abs(raw.y)).toBeLessThan(0.3);
    });

    it.each(["real-anonymized-x800.txt", "real-anonymized-a810.txt", "real-anonymized-a500s.txt"])(
        "%s: parses into plausible, anonymized records with gravity removed",
        async (name) => {
            const { result } = await parseFixture(name);
            const recs = result.records;
            expect(recs.length).toBeGreaterThanOrEqual(45);

            for (const r of recs) {
                expect(Number.isFinite(r.lat)).toBe(true);
                expect(Number.isFinite(r.lon)).toBe(true);
                // Coordinates are anonymized to whole degrees - a leak of real
                // fractional coordinates would fail this.
                expect(Math.abs(r.lat - Math.round(r.lat))).toBeLessThan(1e-6);
                expect(Math.abs(r.lon - Math.round(r.lon))).toBeLessThan(1e-6);
                expect(r.speedMs).toBeGreaterThanOrEqual(0);
                expect(r.unixSeconds).toBeGreaterThan(1262304000); // synced clock, >= 2010
            }

            // Per-axis DC block applied: no axis keeps a residual ~1g gravity
            // offset, whichever axis carried it. Reverting to a hard-coded axis
            // would leave the other model's gravity axis at ~1g here.
            const mean = (sel: (r: (typeof recs)[number]) => number) => recs.reduce((s, r) => s + sel(r), 0) / recs.length;
            expect(Math.abs(mean((r) => r.accelXg))).toBeLessThan(0.02);
            expect(Math.abs(mean((r) => r.accelYg))).toBeLessThan(0.02);
            expect(Math.abs(mean((r) => r.accelZg))).toBeLessThan(0.02);
        },
    );

    it("a500s: preserves 50 unnamed UTC fixes with their original cadence", async () => {
        const name = "real-anonymized-a500s.txt";
        const { text, result } = await parseFixture(name);
        const rows = text.trim().split(/\r?\n/).slice(1).map((line) => line.split(","));
        expect(rows).toHaveLength(50);
        expect(rows.every((row) => row.slice(9).every((field) => field === "0"))).toBe(true);
        expect(result.records).toHaveLength(50);
        expect(result.skipped).toEqual([]);
        expect(result.records[0]!.unixSeconds).toBe(Date.parse("2026-10-20T13:25:50Z") / 1000);
        expect(result.records.at(-1)!.unixSeconds).toBe(Date.parse("2026-10-20T13:27:02Z") / 1000);
        for (let i = 0; i < result.records.length; i++) {
            const record = result.records[i]!;
            expect(record.mp4Filename).toBe(name);
            expect(record.videoKey).toBeUndefined();
            expect(record.timeAssociation).toEqual({ sourcePath: name, extractorId: "csv-70mai" });
            expect(record.trackSegment).toBe(0);
            expect(record.timeUnsynced).toBeUndefined();
            expect(record.unixSeconds).toBe(Number(rows[i]![0]) + 8 * 3600);
            expect(record.speedMs).toBeCloseTo(Number(rows[i]![5]) / 100, 6);
            if (i > 0) expect(record.unixSeconds).toBeGreaterThan(result.records[i - 1]!.unixSeconds);
        }
    });

    it("a810 (stationary capture): every axis is near zero at rest after gravity removal", async () => {
        // The A810 fixture is a parked window - true accel is ~0 on every axis.
        // If the field-6 gravity were left in (e.g. a hard-coded ay-1g), accelXg
        // would sit at ~1g and the magnitude would blow past this bound.
        const { result } = await parseFixture("real-anonymized-a810.txt");
        for (const r of result.records) {
            expect(Math.abs(r.accelXg)).toBeLessThan(0.3);
            expect(Math.abs(r.accelYg)).toBeLessThan(0.3);
            expect(Math.abs(r.accelZg)).toBeLessThan(0.3);
        }
    });
});

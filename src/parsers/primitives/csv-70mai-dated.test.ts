// Synthetic edges and format isolation for the dated 70mai log. Real-card
// behavior lives in __fixtures__/70mai-dated/real-anonymized.test.ts.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { makeVendorFile } from "../__fixtures__/helpers.js";
import { classifyOneNonVideo } from "../registry.js";
import { WrongFormatError } from "../types.js";
import { csv70maiPrimitive } from "./csv-70mai.js";
import { _internal, csv70maiDatedPrimitive } from "./csv-70mai-dated.js";

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../__fixtures__");
const DATED_FIXTURE = resolve(FIXTURES_DIR, "70mai-dated/real-anonymized-gps-folder.txt");
// Every `$V02` fixture, including csv-70mai's own negative sample, must stay
// outside the dated format; the real ones must still belong to csv-70mai.
const V02_FIXTURES = readdirSync(resolve(FIXTURES_DIR, "70mai")).filter((name) => name.endsWith(".txt"));
const REAL_V02_FIXTURES = V02_FIXTURES.filter((name) => name.startsWith("real-anonymized-"));

function readV02Fixture(name: string): string {
    return readFileSync(resolve(FIXTURES_DIR, "70mai", name), "utf8");
}

const ROW = "2026-08-01 20:30:59,B,A,074km/h,43.000000,-9.000000,0,20260801-223057-000001F.MP4";
const PLACEHOLDER = "2000-00-00 00:00:00,B,V,000km/h,0.000000, 0.000000,0,000000000000000000000000000";

function logFile(text: string, path = ".GPS/GPSData000001.txt") {
    return makeVendorFile(path, text);
}

describe("csv-70mai-dated marker", () => {
    it("claims the real dated log", async () => {
        expect(await csv70maiDatedPrimitive.marker(logFile(readFileSync(DATED_FIXTURE, "utf8")))).toBe(true);
    });

    it("claims a renamed copy, a BOM and CRLF line endings", async () => {
        const text = `\uFEFF${[ROW, PLACEHOLDER, ROW].join("\r\n")}\r\n`;
        expect(await csv70maiDatedPrimitive.marker(logFile(text, "copy of gps.TXT"))).toBe(true);
    });

    it("claims rear-camera rows", async () => {
        const rear = ROW.replace("000001F.MP4", "000001B.MP4");
        expect(await csv70maiDatedPrimitive.marker(logFile(`${rear}\n${ROW}\n`))).toBe(true);
    });

    it("claims a log that starts with no-fix placeholders", async () => {
        expect(await csv70maiDatedPrimitive.marker(logFile(`${PLACEHOLDER}\n${ROW}\n`))).toBe(true);
    });

    it.each([
        ["a damaged first row", [ROW.replace("074km/h", "bad"), ROW, ROW], 1],
        ["a damaged middle row", [ROW, ROW.replace("074km/h", "bad"), ROW], 2],
        ["a truncated final row", [ROW, ROW, "2026-08-01 20:31"], 3],
    ])("classifies and recovers a log with %s", async (_label, rows, damagedLine) => {
        const file = logFile(rows.join("\n"));
        const classified = await classifyOneNonVideo(file, new Set(), [], []);
        expect(classified.role).toBe("gps-log");
        expect(classified.logExtractorId).toBe(csv70maiDatedPrimitive.id);
        const { records, skipped } = await csv70maiDatedPrimitive.parse(file);
        expect(records).toHaveLength(2);
        expect(skipped).toHaveLength(1);
        expect(skipped[0]!.line).toBe(damagedLine);
    });

    it.each(V02_FIXTURES)("rejects the 70mai fixture %s", async (name) => {
        expect(await csv70maiDatedPrimitive.marker(logFile(readV02Fixture(name)))).toBe(false);
    });

    it.each(REAL_V02_FIXTURES)("leaves the real $V02 fixture %s to csv-70mai", async (name) => {
        expect(await csv70maiPrimitive.marker(logFile(readV02Fixture(name)))).toBe(true);
    });

    it("is not claimed by the $V02 marker", async () => {
        expect(await csv70maiPrimitive.marker(logFile(readFileSync(DATED_FIXTURE, "utf8")))).toBe(false);
    });

    it.each([
        ["a non-text name", ROW, "GPSData000001.dat"],
        ["an empty file", "", "GPSData000001.txt"],
        ["a foreign dated CSV", "2026-08-01 20:31:00,1,A,74,43.0,-9.0,0,clip.mp4\n", "GPSData000001.txt"],
        ["a versioned log containing a dated row", `$V02\n${ROW}\n`, "GPSData000001.txt"],
        ["a row without the speed unit", ROW.replace("074km/h", "074"), "GPSData000001.txt"],
        ["a NMEA log", "$GPRMC,203059.00,A,4300.0000,N,00900.0000,W,40.0,90.0,010826,,,A*00\n", "nmea.txt"],
    ])("rejects %s", async (_label, text, name) => {
        expect(await csv70maiDatedPrimitive.marker(logFile(text, name))).toBe(false);
    });
});

describe("csv-70mai-dated parse", () => {
    it("converts the UTC clock and km/h speed without the $V02 +8 h bias", async () => {
        const { records, skipped } = await csv70maiDatedPrimitive.parse(logFile(`${ROW}\n`));
        expect(skipped).toEqual([]);
        expect(records).toHaveLength(1);
        const record = records[0]!;
        expect(record.unixSeconds).toBe(Date.parse("2026-08-01T20:30:59Z") / 1000);
        expect(record.speedMs).toBeCloseTo(74 / 3.6, 6);
        expect(record.lat).toBe(43);
        expect(record.lon).toBe(-9);
        expect(record.active).toBe(true);
        expect(record.mp4Filename).toBe("20260801-223057-000001F.MP4");
        expect([record.accelXg, record.accelYg, record.accelZg]).toEqual([0, 0, 0]);
    });

    it("drops no-fix rows silently and reports broken rows by source line", async () => {
        const lines = [
            ROW,
            PLACEHOLDER,
            "2026-08-01 20:31:00,N,A,075km/h,43.000000,-9.000000,0,20260801-223057-000001F.MP4",
            "",
            "2026-13-01 20:31:01,B,A,075km/h,43.000000,-9.000000,0,20260801-223057-000001F.MP4",
            "2026-08-01 20:31:02,B,A,fast,43.000000,-9.000000,0,20260801-223057-000001F.MP4",
            "2026-08-01 20:31:03,B,A,075km/h,95.000000,-9.000000,0,20260801-223057-000001F.MP4",
            "2026-08-01 20:31:04,B,A,000km/h,43.000000,-9.000000,0,000000000000000000000000000",
            "2026-08-01 20:31:05,B,X,075km/h,43.000000,-9.000000,0,20260801-223057-000001F.MP4",
            "2026-08-01 20:31:06,B,A,075km/h",
        ];
        const { records, skipped } = await csv70maiDatedPrimitive.parse(logFile(`${lines.join("\n")}\n`));
        expect(records.map((record) => record.unixSeconds - records[0]!.unixSeconds)).toEqual([0, 1]);
        expect(skipped).toEqual([
            { line: 5, raw: lines[4], reason: "bad timestamp" },
            { line: 6, raw: lines[5], reason: "bad speed" },
            { line: 7, raw: lines[6], reason: "bad coordinates" },
            { line: 8, raw: lines[7], reason: "missing or sentinel mp4 filename" },
            { line: 9, raw: lines[8], reason: 'bad validity flag "X"' },
            { line: 10, raw: lines[9], reason: "expected 8 fields, got 4" },
        ]);
    });

    it.each([
        ["a foreign row", "2026-08-01 20:31:00,1,A,74,43.0,-9.0,0,clip.mp4", "bad row flags"],
        ["a foreign no-fix row", "unrelated,B,V,0,0,0,0,clip.mp4", "bad no-fix row"],
        ["an invalid row flag", ROW.replace(",B,A,", ",1,A,"), "bad row flags"],
        ["an invalid session flag", ROW.replace(",0,20260801", ",x,20260801"), "bad row flags"],
        ["a foreign clip name", ROW.replace("20260801-223057-000001F.MP4", "clip.mp4"), "bad mp4 filename"],
    ])("skips %s next to a recognizable dated row", async (_label, row, reason) => {
        const file = logFile(`${ROW}\n${row}\n`);
        expect(await csv70maiDatedPrimitive.marker(file)).toBe(true);
        const { records, skipped } = await csv70maiDatedPrimitive.parse(file);
        expect(records).toHaveLength(1);
        expect(skipped).toEqual([{ line: 2, raw: row, reason }]);
    });

    it.each([
        ["empty latitude", 4, ""],
        ["whitespace latitude", 4, "   "],
        ["empty longitude", 5, ""],
        ["whitespace longitude", 5, "   "],
    ])("rejects %s both inside and after the marker probe", async (_label, field, value) => {
        const fields = ROW.split(",");
        fields[field] = value;
        const broken = fields.join(",");
        const rows = [broken, ...Array<string>(7).fill(ROW), broken];
        const file = logFile(rows.join("\n"));
        expect(await csv70maiDatedPrimitive.marker(file)).toBe(true);
        const { records, skipped } = await csv70maiDatedPrimitive.parse(file);
        expect(records).toHaveLength(7);
        expect(records.every((record) => record.lat === 43 && record.lon === -9)).toBe(true);
        expect(skipped).toEqual([
            { line: 1, raw: broken, reason: "bad coordinates" },
            { line: 9, raw: broken, reason: "bad coordinates" },
        ]);
    });

    it.each([
        ["latitude", "43.000000", 0, -9],
        ["longitude", "-9.000000", 43, 0],
    ])("preserves a genuine zero %s", async (_label, field, lat, lon) => {
        const file = logFile(ROW.replace(field, "0.000000"));
        expect(await csv70maiDatedPrimitive.marker(file)).toBe(true);
        const { records, skipped } = await csv70maiDatedPrimitive.parse(file);
        expect(skipped).toEqual([]);
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBe(lat);
        expect(records[0]!.lon).toBe(lon);
    });

    it("infers course inside each clip without crossing into the next one", async () => {
        const text = [
            "2026-08-01 20:30:59,B,A,036km/h,43.000000,-9.000000,0,20260801-223057-000001F.MP4",
            "2026-08-01 20:31:00,B,A,036km/h,43.000100,-9.000000,0,20260801-223057-000001F.MP4",
            "2026-08-01 20:31:01,B,A,036km/h,43.000100,-8.999900,0,20260801-223101-000002F.MP4",
            "2026-08-01 20:31:02,B,A,036km/h,43.000100,-8.999800,0,20260801-223101-000002F.MP4",
        ].join("\n");
        const { records } = await csv70maiDatedPrimitive.parse(logFile(text));
        expect(records[0]!.bearingDeg, "first clip heads north").toBeCloseTo(0, 0);
        // A whole-log fill would point the first clip's last fix east, at the
        // second clip's first position.
        expect(records[1]!.bearingDeg, "first clip keeps its own heading").toBeCloseTo(0, 0);
        expect(records[2]!.bearingDeg, "second clip heads east").toBeCloseTo(90, 0);
    });

    it("rejects an implausible pre-2010 clock on a valid fix", () => {
        expect(_internal.parseRow(ROW.replace("2026-08-01", "2000-01-01"))).toEqual({ error: "implausible timestamp" });
    });

    it.each(V02_FIXTURES)("throws WrongFormatError on the 70mai fixture %s", async (name) => {
        await expect(csv70maiDatedPrimitive.parse(logFile(readV02Fixture(name)))).rejects.toBeInstanceOf(
            WrongFormatError,
        );
    });

    it("leaves the dated log to its own parser in csv-70mai", async () => {
        await expect(csv70maiPrimitive.parse(logFile(readFileSync(DATED_FIXTURE, "utf8")))).rejects.toBeInstanceOf(
            WrongFormatError,
        );
    });
});

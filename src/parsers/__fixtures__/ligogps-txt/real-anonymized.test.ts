// Regression tests on the real-anonymized LigoGPS TXT log (the plaintext twin
// of the enciphered PES in the .TS of the same name). Coordinate fractions and
// altitude digits are zeroed; timestamps, speed, course, satellites and
// accelerometer values are the camera's own.
//
// Source: scripts/anonymize-ligogps-txt-log.mjs (first 40 lines of the sample).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ACCEL_SIDECARS, classifyOneNonVideo, SIDECARS } from "../../registry.js";
import { ligoGpsTxtSidecar } from "../../sidecars/ligogps-txt.js";
import { WrongFormatError } from "../../types.js";
import { expectPlausibleGpsTrack } from "../helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(resolve(HERE, "real-anonymized.TXT"));
const VIDEO = "2026_10_18_130426_00.TS";
const LOG = "2026_10_18_130426_00.TXT";

function vendorFile(content: string | Uint8Array, name = LOG) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : Uint8Array.from(content);
    return { file: new File([bytes], name), relativePath: `DCIM/${name}` };
}

describe("real-anonymized LigoGPS TXT log", () => {
    it("pairs with the same-name video as a ligogps-txt sidecar", async () => {
        const classified = await classifyOneNonVideo(vendorFile(FIXTURE), new Set([VIDEO]), SIDECARS, ACCEL_SIDECARS);
        expect(classified.role).toBe("sidecar");
        expect(classified.sidecarId).toBe("ligogps-txt");
        expect(classified.sidecarMp4).toBe(VIDEO);
    });

    it("parses every line with speed in km/h and the positional course", async () => {
        const records = await ligoGpsTxtSidecar.parse(vendorFile(FIXTURE), VIDEO);
        expectPlausibleGpsTrack(records, { minCount: 40, monotonicTime: true });
        expect(records).toHaveLength(40);
        const first = records[0]!;
        // Camera-local clock parsed as UTC; the log opens one second before
        // the 13:04:26 name stamp.
        expect(first.unixSeconds).toBe(Date.UTC(2026, 9, 18, 13, 4, 25) / 1000);
        expect(records[39]!.unixSeconds - first.unixSeconds).toBe(39);
        expect(first.speedMs).toBe(0);
        expect(first.bearingDeg).toBeCloseTo(237.8, 6);
        const moving = records[5]!;
        expect(moving.speedMs).toBeCloseTo(5.8 / 3.6, 6);
        expect(moving.bearingDeg).toBeCloseTo(237.21, 6);
        for (const record of records) {
            expect(record.lat).toBe(41);
            expect(record.lon).toBe(69);
            expect(record.mp4Filename).toBe(VIDEO);
            expect(Math.hypot(record.accelXg, record.accelYg, record.accelZg)).toBeLessThan(0.3);
        }
    });

    it("drops no-fix and 0,0 lines and ignores lines of another shape", async () => {
        const text = [
            "2026/10/18 13:04:25 N:41.000000 E:69.000000 0.0 km/h 237.80 000.00 12 x:-0.04 y:-4.14 z:2.02",
            "2026/10/18 13:04:26 ?:0.000000 ?:0.000000 0.0 km/h 0.00 0.00 0 x:-0.01 y:-4.13 z:2.02",
            "2026/10/18 13:04:27 N:0.000000 E:0.000000 0.0 km/h 0.00 0.00 3 x:-0.04 y:-4.15 z:2.02",
            "garbage line",
            "2026/10/18 13:04:28 N:41.000000 E:69.000000 3.6 km/h 12.50 000.00 12 x:-0.02 y:-4.13 z:2.16",
            "",
        ].join("\r\n");
        const records = await ligoGpsTxtSidecar.parse(vendorFile(text), VIDEO);
        expect(records.map((record) => record.unixSeconds - Date.UTC(2026, 9, 18, 13, 4, 25) / 1000)).toEqual([0, 3]);
        expect(records[1]!.speedMs).toBeCloseTo(1, 6);
        expect(records[1]!.bearingDeg).toBeCloseTo(12.5, 6);
    });

    it.each([
        ["a same-name text file of another kind", "camera firmware v1.2\nmode=loop\n"],
        ["an empty file", ""],
    ])("rejects %s as a wrong format", async (_label, text) => {
        await expect(ligoGpsTxtSidecar.parse(vendorFile(text), VIDEO)).rejects.toBeInstanceOf(WrongFormatError);
    });

    it.each([FIXTURE, Buffer.from("another text format")])("propagates cancellation before probing", async (bytes) => {
        const controller = new AbortController();
        controller.abort();
        await expect(ligoGpsTxtSidecar.parse(vendorFile(bytes), VIDEO, controller.signal)).rejects.toMatchObject({
            name: "AbortError",
        });
    });

    it("propagates cancellation during the head probe before checking its format", async () => {
        const controller = new AbortController();
        const pending = ligoGpsTxtSidecar.parse(vendorFile("another text format"), VIDEO, controller.signal);
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    });
});

describe("LigoGPS TXT fixture anonymizer", () => {
    const script = resolve(HERE, "../../../..", "scripts/anonymize-ligogps-txt-log.mjs");

    it.each([
        "unrecognized location field: 12.345678, 34.567890",
        `${FIXTURE.toString("latin1").split(/\r?\n/)[0]} device=private-identifier`,
    ])("rejects unrecognized content without publishing it", (line) => {
        const dir = mkdtempSync(resolve(tmpdir(), "ligogps-anonymizer-"));
        try {
            const input = resolve(dir, "input.TXT");
            const output = resolve(dir, "output.TXT");
            writeFileSync(input, `${line}\n`, "latin1");
            const result = spawnSync(process.execPath, [script, input, output, "1"], { encoding: "utf8" });
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain("unsupported record shape");
            expect(result.stderr).not.toContain(line);
            expect(existsSync(output)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// End-to-end parse of an anonymized real 70mai dated log (owner-reported
// A800, `.GPS/GPSData000001.txt`). Coordinates are rounded to whole degrees;
// everything else is byte-for-byte from the card. Regenerate with:
//   node scripts/anonymize-70mai-dated-log.mjs <GPSData000001.txt> \
//     src/parsers/__fixtures__/70mai-dated/real-anonymized-gps-folder.txt \
//     --lines 1-6,137-141,5217-5224,214768-214772,215045-215048,215227-215231,263200-263210,319207-319211

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { associateRecordsWithVideos, recordsForVideo } from "../../../gps-association.js";
import { mergeIntoGpsLog, rebindOrphanLogRecords } from "../../../parser.js";
import { deriveStartUtc } from "../../../trips.js";
import { vendorFileKey } from "../../../vendor-file-key.js";
import {
    matchFilenameChannel,
    matchFilenameMode,
    matchFilenameSequence,
    matchFilenameTime,
} from "../../filename/index.js";
import { csv70maiDatedPrimitive } from "../../primitives/csv-70mai-dated.js";
import { expectPlausibleGpsTrack, makeVendorFile } from "../helpers.js";

const FIXTURE = "real-anonymized-gps-folder.txt";
const text = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), FIXTURE), "utf8");
const rows = text.trim().split("\n");

async function parseFixture() {
    return csv70maiDatedPrimitive.parse(makeVendorFile(`.GPS/${FIXTURE}`, text));
}

describe("70mai dated real-anonymized fixture", () => {
    it("is claimed by its marker", async () => {
        expect(await csv70maiDatedPrimitive.marker(makeVendorFile(".GPS/GPSData000001.txt", text))).toBe(true);
    });

    it("keeps every fix with its UTC clock, speed and clip name", async () => {
        const { records } = await parseFixture();
        const fixRows = rows.filter((row) => row.split(",")[2] === "A" && !/,0+$/.test(row)).map((row) => row.split(","));
        expect(fixRows).toHaveLength(35);
        expect(records).toHaveLength(fixRows.length);
        expectPlausibleGpsTrack(records, { minCount: 35 });
        for (let i = 0; i < records.length; i++) {
            const record = records[i]!;
            const row = fixRows[i]!;
            expect(record.unixSeconds).toBe(Date.parse(`${row[0]!.replace(" ", "T")}Z`) / 1000);
            expect(record.speedMs).toBeCloseTo(Number.parseInt(row[3]!, 10) / 3.6, 6);
            expect(record.lat).toBe(Number(row[4]));
            expect(record.lon).toBe(Number(row[5]));
            expect(record.mp4Filename).toBe(row[7]);
            expect(record.timeUnsynced).toBeUndefined();
        }
    });

    it("keeps the first fix after lost signal and drops the placeholders", async () => {
        const { records, skipped } = await parseFixture();
        const placeholders = rows.filter((row) => row.startsWith("2000-00-00 00:00:00,"));
        expect(placeholders).toHaveLength(9);
        expect(records.some((record) => record.unixSeconds === Date.parse("2026-08-02T15:43:21Z") / 1000)).toBe(true);
        expect(records.some((record) => record.unixSeconds === Date.parse("2026-10-08T00:16:02Z") / 1000)).toBe(true);
        expect(skipped.map((line) => line.raw)).not.toEqual(expect.arrayContaining(placeholders));
    });

    it("reports the unnamed fixes instead of guessing their clip", async () => {
        const { skipped } = await parseFixture();
        const unnamed = rows
            .map((raw, index) => ({ line: index + 1, raw, reason: "missing or sentinel mp4 filename" }))
            .filter(({ raw }) => raw.split(",")[2] === "A" && raw.endsWith(",000000000000000000000000000"));
        expect(unnamed).toHaveLength(5);
        expect(skipped).toEqual(unnamed);
    });

    it.each([
        ["NO20261021-211901-002571F.MP4", "2026-10-21T21:19:01Z", "normal", 2571],
        ["EV20261008-011452-002127F.MP4", "2026-10-08T01:14:52Z", "event", 2127],
    ])("classifies the filename fields of the card clip %s", (name, localClock, mode, sequence) => {
        const file = makeVendorFile(name, "");
        expect(matchFilenameTime(file)).toEqual({ matchedId: "70mai-time", value: new Date(localClock) });
        expect(matchFilenameChannel(file)).toEqual({
            matchedId: "70mai-channel",
            value: { channel: "front", confident: true },
        });
        expect(matchFilenameMode(file)).toEqual({ matchedId: "70mai-mode", value: mode });
        expect(matchFilenameSequence(file)).toEqual({ matchedId: "70mai-sequence", value: sequence });
    });

    it("binds prefix-less clip names to the loaded normal and event files during ingest", async () => {
        const { records } = await parseFixture();
        const source = makeVendorFile(".GPS/GPSData000001.txt", "");
        const normal = makeVendorFile("Normal/Front/NO20261021-211901-002571F.MP4", "");
        const event = makeVendorFile("Event/Front/EV20261008-011452-002127F.MP4", "");
        const videos = [normal, event];
        // The rows carry no mode prefix, so no exact basename exists; the
        // source-scoped join resolves them through the 70mai name core.
        associateRecordsWithVideos(records, source, videos);
        const ownedBy = (video: typeof normal) => records.filter((record) => record.videoKey === vendorFileKey(video));
        expect(ownedBy(normal).map((record) => record.mp4Filename)).toEqual(Array(4).fill(normal.file.name));
        expect(ownedBy(event).map((record) => record.mp4Filename)).toEqual(Array(5).fill(event.file.name));

        let log = mergeIntoGpsLog(null, { records, skipped: [], appliedExtractors: [csv70maiDatedPrimitive.id] });
        expect(rebindOrphanLogRecords(log, [normal.file.name, event.file.name]), "nothing left for the late rebind").toBe(
            0,
        );
        log = mergeIntoGpsLog(null, log);
        expect(recordsForVideo(log, normal, videos)).toHaveLength(4);
        expect(recordsForVideo(log, event, videos)).toHaveLength(5);
        // Clips that are no longer on the card keep their bare names and stay inert.
        expect(log.byFilename.has("20260801-223057-000001F.MP4")).toBe(true);
    });

    it("anchors consecutive clips across the camera clock moving back one hour", async () => {
        const { records } = await parseFixture();
        const log = mergeIntoGpsLog(null, { records, skipped: [], appliedExtractors: [csv70maiDatedPrimitive.id] });
        // Filename clocks: 12:52:00 (UTC+2) then 11:55:00 (UTC+1) while the GPS
        // clock runs on continuously from 10:54:58Z to 10:55:03Z.
        const starts = [
            ["20261004-125200-001753F.MP4", "NO20261004-125200-001753F.MP4", "2026-10-04T10:52:00Z"],
            ["20261004-115500-001754F.MP4", "NO20261004-115500-001754F.MP4", "2026-10-04T10:55:00Z"],
        ].map(([logName, diskName, expected]) => {
            const file = makeVendorFile(diskName!, "");
            const localClock = matchFilenameTime(file)!.value;
            const anchor = deriveStartUtc({
                file,
                fingerprint: "70mai",
                // 70mai mvhd stores the local recording start as naive time.
                createdUtc: localClock,
                durationSec: 180,
                records: log.byFilename.get(logName!)!,
                fingerprintTz: { filenameTzSec: 3600, mvhdTzSec: 3600 },
                parseFilenameLocalTime: (candidate) => matchFilenameTime(candidate)?.value ?? null,
                preciseFilenameOffsetSec: 3600,
                embeddedStartUtcHint: null,
                isTimelapse: false,
                wallDurationSec: null,
            });
            return { startUtc: anchor.startUtc, expected: Date.parse(expected!) / 1000 };
        });
        for (const { startUtc, expected } of starts) expect(startUtc).toBe(expected);
    });
});

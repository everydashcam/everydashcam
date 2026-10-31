import { describe, expect, it } from "vitest";

import { associateRecordsWithVideos, buildVideoAssociationIndex } from "../../gps-association.js";
import { isSameTrackSegment } from "../../gps-telemetry.js";
import { interpolatePosition, rebuildLog, recordsHaveGps, totalDistanceKm } from "../../parser.js";
import { normalizeTripTrackSegments } from "../../trip-track-segments.js";
import { vendorFileKey } from "../../vendor-file-key.js";
import { matchDailyCsvVideoPath, parseDailyCsvVideoName } from "../internal/daily-csv-path.js";
import { ACCEL_SIDECARS, SIDECARS, classifyOneNonVideo } from "../registry.js";
import { KNOTS_TO_MS, type VendorFile, WrongFormatError } from "../types.js";
import { dailyCsvGpsPrimitive } from "./daily-csv-gps.js";
import type { PrimitiveVideoRef } from "./types.js";

const FIRST = "20240112181400_10.MP4";
const SECOND = "20240112181410_10.MP4";
const EVENT = "20240112181405_10.MP4";

function source(text: string, relativePath = "card/gps/20240112.dat", sourceKey = "pick"): VendorFile {
    return { file: new File([text], relativePath.split("/").at(-1)!), relativePath, sourceKey };
}

function video(name: string, folder = "100video", root = "card", sourceKey = "pick"): PrimitiveVideoRef {
    return { name, relativePath: `${root}/DCIM/${folder}/${name}`, sourceKey };
}

function row(second: number, coordinates = "2512.60000,N,01234.50000,E", speed = "10.5", altitude = ""): string {
    return `202401121814${String(second).padStart(2, "0")},${coordinates},${speed},${altitude}`;
}

function parse(text: string, videos = [video(FIRST), video(SECOND)], file = source(text)) {
    return dailyCsvGpsPrimitive.parse(file, undefined, undefined, { knownVideos: videos });
}

describe("daily DDmm CSV log", () => {
    it("classifies the real signature while leaving unrelated DAT and NMEA files alone", async () => {
        const text = `\uFEFF\r\n#\r\n${row(0)}\r\n`;
        const classified = await classifyOneNonVideo(source(text), new Set([FIRST]), SIDECARS, ACCEL_SIDECARS);
        expect(classified).toMatchObject({ role: "gps-log", logExtractorId: "daily-csv-gps" });
        for (const file of [
            source(row(0)),
            source("#\nordinary,database,content"),
            source(`#\n${row(0)}`, "20240113.dat"),
            source(`#\n${row(0)}`, "renamed.dat"),
            source("$GPSCAMTIME 20240112181400\n$GPRMC,181400,A"),
        ]) {
            expect(await dailyCsvGpsPrimitive.marker(file)).toBe(false);
        }
    });

    it("uses DDmm coordinates, knots and camera-local relative time without claiming UTC", async () => {
        const result = await parse(`#\n${row(0)}\n${row(1, "2512.60000,S,01234.50000,W", "0", "-12.5")}\n`);
        expect(result.skipped).toEqual([]);
        expect(result.records).toHaveLength(2);
        expect(result.records[0]!.lat).toBeCloseTo(25.21);
        expect(result.records[0]!.lon).toBeCloseTo(12.575);
        expect(result.records[0]!.speedMs).toBeCloseTo(10.5 * KNOTS_TO_MS);
        expect(result.records[1]!.lat).toBeCloseTo(-25.21);
        expect(result.records[1]!.lon).toBeCloseTo(-12.575);
        expect(result.records[1]).toMatchObject({
            unixSeconds: Date.UTC(2024, 0, 12, 18, 14, 1) / 1000,
            timeUnsynced: true,
            relStartSeconds: 1,
            mp4Filename: FIRST,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
        });
    });

    it("uses half-open duration windows and also attaches overlapping event footage", async () => {
        const text = `#\n${[0, 5, 9, 10, 14, 15, 19, 20].map((second) => row(second)).join("\n")}\n`;
        const result = await parse(text, [video(FIRST), video(SECOND), video(EVENT, "101video")]);
        expect(
            result.records.filter((record) => record.mp4Filename === FIRST).map((record) => record.relStartSeconds),
        ).toEqual([0, 5, 9]);
        expect(
            result.records.filter((record) => record.mp4Filename === SECOND).map((record) => record.relStartSeconds),
        ).toEqual([0, 4, 5, 9]);
        expect(
            result.records.filter((record) => record.mp4Filename === EVENT).map((record) => record.relStartSeconds),
        ).toEqual([0, 4, 5, 9]);
        expect(result.skipped.map((item) => item.reason)).toEqual(["no video for gps timestamp"]);
    });

    it("does not stretch a selected clip over gaps or the rest of the daily log", async () => {
        const result = await parse(`#\n${row(9)}\n${row(10)}\n${row(59)}\n`, [video(FIRST)]);
        expect(result.records).toHaveLength(1);
        expect(result.skipped).toHaveLength(2);
    });

    it("restarts the window scan after a reboot even when videos arrive out of order", async () => {
        const result = await parse(`#\n${row(0)}\n${row(15)}\n#\n${row(0)}\n`, [video(SECOND), video(FIRST)]);
        expect(result.records.map((record) => record.mp4Filename)).toEqual([FIRST, SECOND, FIRST]);
        expect(result.records.map((record) => record.trackSegment)).toEqual([0, 0, 1]);
    });

    it("retains both exact owners when normal and event folders share a basename", async () => {
        const result = await parse(`#\n${row(0)}\n`, [
            { ...video(FIRST), videoKey: "normal" },
            { ...video(FIRST, "101video"), videoKey: "event" },
        ]);
        expect(result.records.map((record) => record.videoKey).sort()).toEqual(["event", "normal"]);
    });

    it("isolates cards with overlapping clocks even within one folder picker", async () => {
        const text = `#\n${row(0)}\n`;
        const own = video(FIRST);
        const other = video("20240112181400_20.MP4", "100video", "another-card");
        expect((await parse(text, [own, other])).records.map((record) => record.mp4Filename)).toEqual([FIRST]);
        expect((await parse(text, [other])).records).toEqual([]);
    });

    it("supports a later log drop by preserved card path but rejects ambiguous flat cards", async () => {
        const text = `#\n${row(0)}\n`;
        const late = source(text, "card/gps/20240112.dat", "later-pick");
        expect((await parse(text, [video(FIRST)], late)).records).toHaveLength(1);
        const flat = source(text, "20240112.dat", "later-pick");
        const a = video(FIRST, "100video", "card-a", "a");
        const b = video(SECOND, "100video", "card-b", "b");
        expect((await parse(text, [a, b], flat)).records).toEqual([]);
        expect((await parse(text, [a], flat)).records).toHaveLength(1);
    });

    it("accepts a flat video/log selection when its source is unambiguous", async () => {
        const text = `#\n${row(0)}\n`;
        const result = await parse(
            text,
            [{ name: FIRST, relativePath: FIRST, sourceKey: "pick" }],
            source(text, "20240112.dat"),
        );
        expect(result.records).toHaveLength(1);
    });

    it.each(["100video", "DCIM/100video"])("binds a later gps folder to a unique %s selection", async (folder) => {
        const text = `#\n${row(0)}\n`;
        const result = await parse(
            text,
            [{ name: FIRST, relativePath: `${folder}/${FIRST}`, sourceKey: "video-pick" }],
            source(text, "gps/20240112.dat", "log-pick"),
        );
        expect(result.records.map((record) => record.mp4Filename)).toEqual([FIRST]);
    });

    it.each(["later-pick", "second-pick"])(
        "binds all preserved card fragments with log source %s",
        async (logSource) => {
            const text = `#\n${row(5)}\n`;
            const videos = [
                video(FIRST, "100video", "card", "first-pick"),
                video(EVENT, "101video", "card", "second-pick"),
            ];
            const result = await parse(text, videos, source(text, "card/gps/20240112.dat", logSource));
            expect(result.records.map((record) => record.mp4Filename)).toEqual([FIRST, EVENT]);
        },
    );

    it("keeps distinct root-level cards ambiguous unless the log shares a picker", async () => {
        const text = `#\n${row(0)}\n`;
        const videos = ["a", "b"].map((sourceKey) => ({
            name: FIRST,
            relativePath: `DCIM/100video/${FIRST}`,
            sourceKey,
            videoKey: `owner-${sourceKey}`,
        }));
        expect((await parse(text, videos, source(text, "gps/20240112.dat", "later"))).records).toEqual([]);
        expect(
            (await parse(text, videos, source(text, "gps/20240112.dat", "b"))).records.map((r) => r.videoKey),
        ).toEqual(["owner-b"]);
    });

    it("rejects conflicting copies of the same named root but accepts a canonical recording copy", async () => {
        const text = `#\n${row(0)}\n`;
        const a = { ...video(FIRST, "100video", "card", "a"), videoKey: "owner-a" };
        const b = { ...video(FIRST, "100video", "card", "b"), videoKey: "owner-b" };
        const late = source(text, "card/gps/20240112.dat", "later");
        expect((await parse(text, [a, b], late)).records).toEqual([]);
        expect(
            (await parse(text, [a, b], source(text, "card/gps/20240112.dat", "b"))).records.map((r) => r.videoKey),
        ).toEqual(["owner-b"]);
        expect((await parse(text, [a, { ...b, videoKey: a.videoKey }], late)).records).toHaveLength(1);
    });

    it("preserves the selected card owner through basename association", async () => {
        const text = `#\n${row(0)}\n`;
        const own = source("", `card-a/DCIM/100video/${FIRST}`, "old-pick");
        const other = source("different bytes", `card-b/DCIM/100video/${FIRST}`, "new-pick");
        const log = source(text, "card-a/gps/20240112.dat", "new-pick");
        const videos = [own, other];
        const result = await parse(
            text,
            videos.map((v) => ({
                name: v.file.name,
                relativePath: v.relativePath,
                sourceKey: v.sourceKey,
                videoKey: vendorFileKey(v),
            })),
            log,
        );
        associateRecordsWithVideos(result.records, log, buildVideoAssociationIndex(videos));
        expect(result.records.map((record) => record.videoKey)).toEqual([vendorFileKey(own)]);
    });

    it("preserves no-fix rows and separates reboots while rejecting malformed and stale rows", async () => {
        const text = `#\n${row(0)}\n${row(1, "2561.000,N,01234.500,E")}\n${row(1, "2512.600,N,01234.500,E", "NaN")}\n${row(2, "0000.000,N,00000.000,E")}\n${row(0)}\n#\n${row(0)}\n`;
        const result = await parse(text);
        expect(result.records.map((record) => record.active)).toEqual([true, false, true]);
        expect(isSameTrackSegment(result.records[0]!, result.records[2]!)).toBe(false);
        expect(result.records[1]).toMatchObject({ speedMs: 0, speedSource: "unavailable" });
        expect(result.skipped.map((item) => item.reason)).toEqual([
            "bad daily csv row",
            "bad daily csv row",
            "non-increasing timestamp",
        ]);
    });

    it("keeps a reported GPS loss out of interpolation and trip distance", async () => {
        const text = `#\n${[
            row(0, "2512.600,N,01234.500,E"),
            row(1, "2512.660,N,01234.500,E"),
            row(2, "0000.000,N,00000.000,E"),
            row(3, "0000.000,N,00000.000,E"),
            row(4, "2600.000,N,01234.500,E"),
            row(5, "2600.060,N,01234.500,E"),
        ].join("\n")}\n`;
        const result = await parse(text, [video(FIRST)]);
        const startUtc = Date.UTC(2024, 0, 12, 18, 14) / 1000;
        const [normalized] = normalizeTripTrackSegments([
            { records: result.records, channel: "front", startUtc, endUtc: startUtc + 10 },
        ]);
        const records = [...normalized!];
        expect(records).toHaveLength(6);
        expect(isSameTrackSegment(records[0]!, records[1]!)).toBe(true);
        expect(isSameTrackSegment(records[1]!, records[4]!)).toBe(false);
        expect(isSameTrackSegment(records[4]!, records[5]!)).toBe(true);
        expect(records.slice(2, 4).every((record) => !record.active && record.speedSource === "unavailable")).toBe(
            true,
        );
        expect(interpolatePosition(records, startUtc + 2)).toBeNull();
        expect(interpolatePosition(records, startUtc + 4)?.lat).toBeCloseTo(26);
        expect(totalDistanceKm(records)).toBeCloseTo(
            totalDistanceKm(records.slice(0, 2)) + totalDistanceKm(records.slice(4)),
        );
    });

    it("recognizes an all-no-fix log without claiming position or speed", async () => {
        const text = `#\n${row(0, "0000.000,N,00000.000,E")}\n${row(1, "0000.000,N,00000.000,E")}\n`;
        expect(await dailyCsvGpsPrimitive.marker(source(text))).toBe(true);
        const { records } = await parse(text, [video(FIRST)]);
        expect(records).toHaveLength(2);
        expect(recordsHaveGps(records)).toBe(false);
        expect(records.every((record) => !record.active && record.speedSource === "unavailable")).toBe(true);
        expect(interpolatePosition(records, records[0]!.unixSeconds)).toBeNull();
    });

    it("starts bearing inference afresh after a reported fix loss", async () => {
        const text = `#\n${[
            row(0, "2500.000,N,01200.000,E"),
            row(1, "2500.000,N,01200.060,E"),
            row(2, "0000.000,N,00000.000,E"),
            row(3, "2600.000,N,01200.060,E"),
        ].join("\n")}\n`;
        const { records } = await parse(text, [video(FIRST)]);
        expect(records[0]!.bearingDeg).toBeCloseTo(90, 2);
        expect(records[3]!.bearingDeg).toBe(0);
    });

    it.each(["terminal", "initial"])("preserves a %s fix loss at a clip boundary", async (endpoint) => {
        const noFix = "0000.000,N,00000.000,E";
        const text = `#\n${[
            row(8),
            row(9, endpoint === "terminal" ? noFix : undefined),
            row(10, endpoint === "initial" ? noFix : undefined),
            row(11),
        ].join("\n")}\n`;
        const result = await parse(text);
        const startUtc = Date.UTC(2024, 0, 12, 18, 14) / 1000;
        const [first, second] = normalizeTripTrackSegments(
            [FIRST, SECOND].map((name, index) => ({
                records: result.records.filter((record) => record.mp4Filename === name),
                channel: "front",
                startUtc: startUtc + index * 10,
                endUtc: startUtc + (index + 1) * 10,
            })),
        );
        expect(first).toHaveLength(2);
        expect(second).toHaveLength(2);
        expect(isSameTrackSegment(first![0]!, second![1]!)).toBe(false);
        expect(interpolatePosition([...first!, ...second!], startUtc + 9.5)).toBeNull();
    });

    it("preserves a restart marker at an adjacent clip boundary", async () => {
        const result = await parse(`#\n${row(8)}\n${row(9)}\n#\n${row(10)}\n${row(11)}\n`);
        const startUtc = Date.UTC(2024, 0, 12, 18, 14) / 1000;
        const [first, second] = normalizeTripTrackSegments(
            [FIRST, SECOND].map((name, index) => ({
                records: result.records.filter((record) => record.mp4Filename === name),
                channel: "front",
                startUtc: startUtc + index * 10,
                endUtc: startUtc + (index + 1) * 10,
            })),
        );
        expect(isSameTrackSegment(first![1]!, second![0]!)).toBe(false);
        expect(interpolatePosition([...first!, ...second!], startUtc + 9.5)).toBeNull();
    });

    it("keeps a fix loss between selected video windows from reconnecting their route", async () => {
        const later = "20240112181412_10.MP4";
        const result = await parse(
            `#\n${row(8)}\n${row(9)}\n${row(10, "0000.000,N,00000.000,E")}\n${row(12)}\n${row(13)}\n`,
            [video(FIRST), video(later)],
        );
        const startUtc = Date.UTC(2024, 0, 12, 18, 14) / 1000;
        const [first, second] = normalizeTripTrackSegments(
            [FIRST, later].map((name, index) => ({
                records: result.records.filter((record) => record.mp4Filename === name),
                channel: "front",
                startUtc: startUtc + index * 12,
                endUtc: startUtc + index * 12 + 10,
            })),
        );
        expect(result.skipped.map((item) => item.reason)).toEqual(["no video for gps timestamp"]);
        expect(isSameTrackSegment(first![1]!, second![0]!)).toBe(false);
        expect(interpolatePosition([...first!, ...second!], startUtc + 10)).toBeNull();
    });

    it.each(["terminal", "initial"])("preserves a %s fix loss across daily logs", async (endpoint) => {
        const coordinates = "2512.600,N,01234.500,E";
        const noFix = "0000.000,N,00000.000,E";
        const videos = [video("20240112235955_20.MP4")];
        const previous = `#\n20240112235958,${coordinates},10,\n20240112235959,${endpoint === "terminal" ? noFix : coordinates},10,\n`;
        const next = `#\n20240113000000,${endpoint === "initial" ? noFix : coordinates},10,\n20240113000001,${coordinates},10,\n`;
        const a = await parse(previous, videos);
        const b = await parse(next, videos, source(next, "card/gps/20240113.dat"));
        const startUtc = Date.UTC(2024, 0, 12, 23, 59, 55) / 1000;
        const [records] = normalizeTripTrackSegments([
            { records: [...a.records, ...b.records], channel: "front", startUtc, endUtc: startUtc + 20 },
        ]);
        expect(records).toHaveLength(4);
        expect(isSameTrackSegment(records![0]!, records![3]!)).toBe(false);
        expect(interpolatePosition([...records!], startUtc + 4.5)).toBeNull();
    });

    it("rejects a claimed file with no valid dated rows and propagates cancellation", async () => {
        await expect(parse("#\n20240230181400,2512.6,N,1234.5,E,10,2")).rejects.toBeInstanceOf(WrongFormatError);
        await expect(parse("ordinary data")).rejects.toBeInstanceOf(WrongFormatError);
        await expect(
            dailyCsvGpsPrimitive.parse(source(`#\n${row(0)}`), undefined, AbortSignal.abort()),
        ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("reads a next-day daily file for a clip crossing midnight", async () => {
        const text = "#\n20240113000000,2512.6,N,1234.5,E,10,2\n";
        const result = await parse(text, [video("20240112235955_10.MP4")], source(text, "card/gps/20240113.dat"));
        expect(result.records[0]?.relStartSeconds).toBe(5);
    });

    it("joins midnight continuity while preserving restarts with reused segment numbers", async () => {
        const videos = [video("20240112235955_20.MP4")];
        const datedRow = (clock: string) => `${clock},2512.6,N,1234.5,E,10,2`;
        const previous = `#\n${datedRow("20240112120000")}\n#\n${datedRow("20240112235958")}\n${datedRow("20240112235959")}\n`;
        const next = `#\n${datedRow("20240113000000")}\n${datedRow("20240113000001")}\n#\n${datedRow("20240113000002")}\n${datedRow("20240113000003")}\n`;
        const a = await parse(previous, videos);
        const b = await parse(next, videos, source(next, "card/gps/20240113.dat"));
        const log = rebuildLog(["daily-csv-gps"], [...b.records, ...a.records], []);
        const [records] = normalizeTripTrackSegments([
            {
                records: log.byFilename.get(videos[0]!.name)!,
                channel: "front",
                startUtc: Date.UTC(2024, 0, 12, 23, 59, 55) / 1000,
                endUtc: Date.UTC(2024, 0, 13, 0, 0, 15) / 1000,
            },
        ]);
        expect(records!.map((record) => record.trackSegment)).toEqual([0, 0, 0, 0, 1, 1]);
        expect(records!.every((record) => record.trackSegmentSource === undefined)).toBe(true);
    });
});

describe("daily CSV recording path", () => {
    it("reads the duration and mode without interpreting the suffix as a counter", () => {
        expect(matchDailyCsvVideoPath("Card/DCIM/101video/20240113175916_10.MP4")).toMatchObject({
            root: "card",
            durationSec: 10,
            mode: "event",
        });
        expect(matchDailyCsvVideoPath("Card/DCIM/100video/20240112181119_180.MP4")).toMatchObject({
            durationSec: 180,
            mode: "normal",
        });
        expect(matchDailyCsvVideoPath(FIRST)).toBeNull();
        expect(parseDailyCsvVideoName("20240230181119_180.MP4")).toBeNull();
        expect(parseDailyCsvVideoName("20240112181119_0.MP4")).toBeNull();
        expect(parseDailyCsvVideoName("20190719161640_0060.mp4")).toBeNull();
    });
});

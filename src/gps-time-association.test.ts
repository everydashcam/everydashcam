import { describe, expect, it } from "vitest";

import { recordsForVideo } from "./gps-association.js";
import { bindRecordsByTimeRange } from "./gps-time-association.js";
import { mergeIntoGpsLog, rebuildLog } from "./parser.js";
import { csv70maiPrimitive } from "./parsers/primitives/csv-70mai.js";
import type { GpsRecord, VendorFile } from "./parsers/types.js";
import type { VideoCandidate } from "./trips.js";
import { vendorFileKey } from "./vendor-file-key.js";

function file(path: string, sourceKey = "card-a"): VendorFile {
    return {
        file: new File(["video"], path.split("/").pop()!, { lastModified: 1 }),
        relativePath: path,
        sourceKey,
    };
}

function video(path: string, startUtc = 100, overrides: Partial<VideoCandidate> = {}): VideoCandidate {
    return {
        ...file(path),
        fingerprint: "directory-log-camera",
        appliedExtractors: [],
        classifierMatches: { time: null, channel: null, mode: null, sequence: null },
        channel: null,
        channelConfident: false,
        sequence: null,
        recordingMode: null,
        isTimelapse: false,
        startUtc,
        durationSec: 60,
        wallDurationSec: null,
        driftLeadSec: null,
        startSource: "mp4",
        cameraTzSec: null,
        createdUtc: new Date(startUtc * 1000),
        records: [],
        codec: null,
        codecParam: null,
        videoCodecString: null,
        rotation: 0,
        width: null,
        height: null,
        fps: null,
        audio: null,
        canPlay: true,
        needsHevcRemux: false,
        isTransportStream: false,
        isMatroska: false,
        audioNeedsTranscode: false,
        embeddedStartUtcHint: null,
        localClockOffsetHintSec: null,
        ...overrides,
    };
}

function point(unixSeconds: number, overrides: Partial<GpsRecord> = {}): GpsRecord {
    return {
        unixSeconds,
        active: true,
        lat: 45,
        lon: 75,
        bearingDeg: 90,
        speedMs: 10,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename: "GPSData000001.txt",
        timeAssociation: { sourcePath: "Card/GPSData000001.txt", sourceKey: "card-a", extractorId: "70mai-v02" },
        ...overrides,
    };
}

function gpsLog(...records: GpsRecord[]) {
    return mergeIntoGpsLog(null, { records, appliedExtractors: ["70mai-v02"], skipped: [] });
}

describe("directory GPS time association", () => {
    it("splits a root route between descendant clip intervals and keeps original rows pending", () => {
        const first = video("Card/Normal/Front/first.mp4");
        const next = video("Card/Normal/Front/next.mp4", 160);
        const originals = [99, 100, 159, 160, 219, 220].map((time) => point(time));
        const originalLog = gpsLog(...originals);

        const result = bindRecordsByTimeRange(originalLog, [first, next]);

        expect(result.boundRecords).toBe(4);
        expect(result.boundVideos).toBe(2);
        expect(recordsForVideo(result.log, first, [first, next]).map((record) => record.unixSeconds)).toEqual([
            100, 159,
        ]);
        expect(recordsForVideo(result.log, next, [first, next]).map((record) => record.unixSeconds)).toEqual([
            160, 219,
        ]);
        expect(result.log.pendingByFilename.get("GPSData000001.txt")).toEqual(originals);
        expect(originals.every((record) => record.videoKey === undefined)).toBe(true);
        expect(first.appliedExtractors).toEqual(["70mai-v02"]);
        expect(result.log.byVideoKey.get(vendorFileKey(first))![0]).not.toBe(originals[1]);
    });

    it("requires the same source and a complete ancestor directory path", () => {
        const candidates = [
            video("Card/Normal/right.mp4"),
            video("Card-other/Normal/wrong-prefix.mp4"),
            video("Elsewhere/Normal/wrong-root.mp4"),
            video("Card/Normal/wrong-card.mp4", 100, { sourceKey: "card-b" }),
        ];

        const result = bindRecordsByTimeRange(gpsLog(point(110)), candidates);

        expect(result.boundVideos).toBe(1);
        expect([...result.log.byVideoKey.keys()]).toEqual([vendorFileKey(candidates[0]!)]);
        const otherCardOnly = bindRecordsByTimeRange(gpsLog(point(110)), [candidates[3]!]);
        expect(otherCardOnly.boundRecords).toBe(0);
    });

    it("uses a recording copy beneath the source directory to find its canonical owner", () => {
        const kept = video("Saved/event.mp4", 100, {
            sourceKey: "later-drop",
            recordingCopies: [file("Card/Normal/original.mp4")],
        });

        const result = bindRecordsByTimeRange(gpsLog(point(110)), [kept]);

        expect(result.log.byVideoKey.get(vendorFileKey(kept))?.[0]?.mp4Filename).toBe("event.mp4");
        expect(result.boundVideos).toBe(1);
    });

    it("uses wall-clock duration and excludes the end boundary", () => {
        const candidate = video("Card/Parking/clip.mp4", 100, { durationSec: 5, wallDurationSec: 120 });
        const result = bindRecordsByTimeRange(gpsLog(point(105), point(219), point(220)), [candidate]);

        expect(result.log.byVideoKey.get(vendorFileKey(candidate))?.map((record) => record.unixSeconds)).toEqual([
            105, 219,
        ]);
    });

    it.each<Partial<VideoCandidate>>([
        { metadataReady: false },
        { metadataFailed: true },
        { startSource: "mtime" },
        { hasUncalibratedClock: true },
        { durationSec: 0 },
        { startUtc: Number.NaN },
    ])("leaves records pending while a recording interval is untrustworthy: %j", (overrides) => {
        const log = gpsLog(point(110));
        const result = bindRecordsByTimeRange(log, [video("Card/clip.mp4", 100, overrides)]);

        expect(result.log).toBe(log);
        expect(result.boundRecords).toBe(0);
    });

    it("ignores unsynchronized record timestamps", () => {
        const log = gpsLog(point(110, { timeUnsynced: true }));
        const result = bindRecordsByTimeRange(log, [video("Card/clip.mp4")]);

        expect(result.log).toBe(log);
        expect(result.boundRecords).toBe(0);
    });

    it("clones a route for distinct simultaneous channels of the same recording", () => {
        const front = video("Card/Normal/front.mp4", 100, { channel: "front" });
        const rear = video("Card/Normal/rear.mp4", 100, { channel: "rear" });

        const result = bindRecordsByTimeRange(gpsLog(point(110)), [front, rear]);

        expect(result.boundVideos).toBe(2);
        expect(result.boundRecords).toBe(2);
        const frontRow = result.log.byVideoKey.get(vendorFileKey(front))![0]!;
        const rearRow = result.log.byVideoKey.get(vendorFileKey(rear))![0]!;
        expect(frontRow.unixSeconds).toBe(rearRow.unixSeconds);
        expect(frontRow).not.toBe(rearRow);
    });

    it.each<Partial<VideoCandidate>>([
        { fingerprint: "other-camera", channel: "rear" },
        { channel: "front" },
        { channel: null },
        { channel: "rear", startUtc: 101 },
    ])("rejects ambiguous overlapping recordings: %j", (overrides) => {
        const front = video("Card/Normal/front.mp4", 100, { channel: "front" });
        const other = video("Card/Normal/other.mp4", 100, overrides);
        const log = gpsLog(point(110));

        const result = bindRecordsByTimeRange(log, [front, other]);

        expect(result.log).toBe(log);
        expect(result.boundRecords).toBe(0);
    });

    it.each([false, true])("preserves independently attached GPS with externalTrack=%s", (externalTrack) => {
        const candidate = video("Card/Normal/clip.mp4");
        const native = point(115, {
            mp4Filename: candidate.file.name,
            videoKey: vendorFileKey(candidate),
            timeAssociation: undefined,
            externalTrack,
            lat: 46,
        });
        const log = gpsLog(point(110), native);

        const result = bindRecordsByTimeRange(log, [candidate]);

        expect(result.log).toBe(log);
        expect(result.log.byVideoKey.get(vendorFileKey(candidate))).toEqual([native]);
    });

    it("keeps independently owned overlapping cameras as ambiguity blockers", () => {
        const first = video("Card/first.mp4", 100, { records: [point(110, { timeAssociation: undefined })] });
        const second = video("Card/second.mp4", 100, { fingerprint: "other-camera" });
        const log = gpsLog(point(110));

        expect(bindRecordsByTimeRange(log, [first, second]).log).toBe(log);
    });

    it("is idempotent and binds later videos or additional source rows", () => {
        const first = video("Card/Normal/first.mp4");
        const later = video("Card/Normal/later.mp4", 160);
        const initial = bindRecordsByTimeRange(gpsLog(point(110), point(170)), [first]);
        first.records = recordsForVideo(initial.log, first, [first]);

        const repeated = bindRecordsByTimeRange(initial.log, [first]);
        expect(repeated.log).toBe(initial.log);
        expect(repeated.boundRecords).toBe(0);

        const withLater = bindRecordsByTimeRange(initial.log, [first, later]);
        expect(withLater.boundVideos).toBe(1);
        expect(withLater.boundRecords).toBe(1);
        const extended = mergeIntoGpsLog(withLater.log, { records: [point(120)], appliedExtractors: [], skipped: [] });
        const result = bindRecordsByTimeRange(extended, [first, later]);
        expect(result.boundRecords).toBe(1);
        expect(result.log.byVideoKey.get(vendorFileKey(first))?.map((record) => record.unixSeconds)).toEqual([
            110, 120,
        ]);
    });

    it("removes obsolete derived rows when a clock or overlap changes", () => {
        const candidate = video("Card/Normal/first.mp4");
        const initial = bindRecordsByTimeRange(gpsLog(point(110)), [candidate]);
        const changedClock = { ...candidate, startUtc: 200 };
        const moved = bindRecordsByTimeRange(initial.log, [changedClock]);
        expect(moved.log.byVideoKey.size).toBe(0);
        expect(moved.log.records).toHaveLength(1);
        expect(moved.boundRecords).toBe(0);
        expect(moved.log).not.toBe(initial.log);

        const overlapping = video("Card/Normal/other.mp4", 100, { fingerprint: "other-camera" });
        const ambiguous = bindRecordsByTimeRange(initial.log, [candidate, overlapping]);
        expect(ambiguous.log.byVideoKey.size).toBe(0);
    });

    it("prefers the closest ancestor log and replaces earlier root-derived rows", () => {
        const candidate = video("Card/Normal/Front/clip.mp4");
        const root = point(110);
        const nested = point(110, {
            lat: 46,
            timeAssociation: {
                sourcePath: "Card/Normal/GPSData000001.txt",
                sourceKey: "card-a",
                extractorId: "70mai-v02",
            },
        });
        const initial = bindRecordsByTimeRange(gpsLog(root), [candidate]);
        const extended = mergeIntoGpsLog(initial.log, { records: [nested], appliedExtractors: [], skipped: [] });

        const result = bindRecordsByTimeRange(extended, [candidate]);

        expect(result.log.byVideoKey.get(vendorFileKey(candidate))?.map((record) => record.lat)).toEqual([46]);
        expect(result.log.records.filter((record) => record.videoKey === undefined)).toHaveLength(2);
    });

    it("leaves competing logs at the same directory depth unresolved", () => {
        const first = point(110);
        const second = point(110, {
            mp4Filename: "other.txt",
            timeAssociation: { sourcePath: "Card/other.txt", sourceKey: "card-a", extractorId: "70mai-v02" },
            lat: 46,
        });
        const log = gpsLog(first, second);

        expect(bindRecordsByTimeRange(log, [video("Card/Normal/clip.mp4")]).log).toBe(log);
    });

    it("combines rotated files covering disjoint times in the same clip and later clips", () => {
        const rotated = (time: number): GpsRecord =>
            point(time, {
                mp4Filename: "GPSData000002.txt",
                timeAssociation: {
                    sourcePath: "Card/GPSData000002.txt",
                    sourceKey: "card-a",
                    extractorId: "70mai-v02",
                },
            });
        const first = video("Card/Normal/first.mp4");
        const next = video("Card/Normal/next.mp4", 160);
        const log = gpsLog(point(110), point(120), rotated(130), rotated(170));

        const result = bindRecordsByTimeRange(log, [first, next]);

        expect(result.boundRecords).toBe(4);
        expect(result.log.byVideoKey.get(vendorFileKey(first))?.map((record) => record.unixSeconds)).toEqual([
            110, 120, 130,
        ]);
        expect(result.log.byVideoKey.get(vendorFileKey(next))?.map((record) => record.unixSeconds)).toEqual([170]);
    });

    it("deduplicates identical overlapping sources but rejects conflicting timestamps", () => {
        const rotated = (time: number, lat = 45): GpsRecord =>
            point(time, {
                lat,
                mp4Filename: "GPSData000002.txt",
                timeAssociation: {
                    sourcePath: "Card/GPSData000002.txt",
                    sourceKey: "card-a",
                    extractorId: "70mai-v02",
                },
            });
        const candidate = video("Card/Normal/clip.mp4");
        const log = gpsLog(point(110), point(120), point(130), rotated(110), rotated(120, 46), rotated(130));

        const result = bindRecordsByTimeRange(log, [candidate]);

        expect(result.boundRecords).toBe(2);
        expect(result.log.byVideoKey.get(vendorFileKey(candidate))?.map((record) => record.unixSeconds)).toEqual([
            110, 130,
        ]);
        expect(bindRecordsByTimeRange(result.log, [candidate]).log).toBe(result.log);
    });

    it("preserves a bound route when the same card is reimported through recording copies", () => {
        const candidate = video("Card/Normal/clip.mp4");
        const initial = bindRecordsByTimeRange(gpsLog(point(110), point(120)), [candidate]);
        candidate.records = recordsForVideo(initial.log, candidate, [candidate]);
        candidate.recordingCopies = [file(candidate.relativePath, "second-import")];
        const repeatedRows = [110, 120].map((time) =>
            point(time, {
                timeAssociation: {
                    sourcePath: "Card/GPSData000001.txt",
                    sourceKey: "second-import",
                    extractorId: "70mai-v02",
                },
            }),
        );
        const extended = mergeIntoGpsLog(initial.log, {
            records: repeatedRows,
            appliedExtractors: ["70mai-v02"],
            skipped: [],
        });

        const result = bindRecordsByTimeRange(extended, [candidate]);

        expect(result.log).toBe(extended);
        expect(result.boundRecords).toBe(0);
        expect(result.log.byVideoKey.get(vendorFileKey(candidate))?.map((record) => record.unixSeconds)).toEqual([
            110, 120,
        ]);
        expect(result.log.records.filter((record) => record.videoKey === undefined)).toHaveLength(4);
    });

    it("keeps original timestamps once when an appended CSV log changes its acceleration baseline", async () => {
        const rows = [
            "1700000000,A,45.0,75.0,9000,1000,100,0,0,0,0,0,0",
            "1700000001,A,45.0,75.0,9000,1000,100,0,0,0,0,0,0",
            "1700000002,A,45.0,75.0,9000,1000,130,0,0,0,0,0,0",
        ];
        const parse = (count: number, sourceKey: string) =>
            csv70maiPrimitive.parse({
                file: new File([`$V02\n${rows.slice(0, count).join("\n")}\n`], "GPSData000001.txt"),
                relativePath: "Card/GPSData000001.txt",
                sourceKey,
            });
        const previous = await parse(2, "card-a");
        const extended = await parse(3, "second-import");
        expect(previous.records[0]!.accelXg).toBeCloseTo(0);
        expect(extended.records[0]!.accelXg).toBeCloseTo(-0.1);
        const candidate = video("Card/Normal/clip.mp4", 1700028800);
        const initial = bindRecordsByTimeRange(
            mergeIntoGpsLog(null, { ...previous, appliedExtractors: ["csv-70mai"] }),
            [candidate],
        );
        candidate.records = recordsForVideo(initial.log, candidate, [candidate]);
        candidate.recordingCopies = [file(candidate.relativePath, "second-import")];
        const merged = mergeIntoGpsLog(initial.log, { ...extended, appliedExtractors: ["csv-70mai"] });

        const result = bindRecordsByTimeRange(merged, [candidate]);

        expect(result.boundRecords).toBe(1);
        expect(result.log.byVideoKey.get(vendorFileKey(candidate))?.map((record) => record.unixSeconds)).toEqual([
            1700028800, 1700028801, 1700028802,
        ]);
        expect(bindRecordsByTimeRange(result.log, [candidate]).log).toBe(result.log);
    });

    it("emits equivalent rotated sessions once despite different segment ordinals and bearings", () => {
        const candidate = video("Card/Normal/clip.mp4");
        const first = point(110, { trackSegment: 3, bearingDeg: 120, accelXg: 0.1 });
        const rotated = point(110, {
            trackSegment: 0,
            bearingDeg: 90,
            accelXg: 0.2,
            mp4Filename: "GPSData000002.txt",
            timeAssociation: {
                sourcePath: "Card/GPSData000002.txt",
                sourceKey: "card-a",
                extractorId: "70mai-v02",
            },
        });

        const result = bindRecordsByTimeRange(gpsLog(first, rotated), [candidate]);

        expect(result.boundRecords).toBe(1);
        expect(result.log.byVideoKey.get(vendorFileKey(candidate))).toHaveLength(1);
        expect(result.log.byVideoKey.get(vendorFileKey(candidate))![0]).toMatchObject({
            unixSeconds: 110,
            trackSegment: 3,
            bearingDeg: 120,
            accelXg: 0.1,
        });
    });

    it("rejects conflicting positions at one timestamp inside a single source", () => {
        const candidate = video("Card/Normal/clip.mp4");
        const log = gpsLog(
            point(110, { trackSegment: 0 }),
            point(110, { trackSegment: 1, lat: 46 }),
            point(120, { trackSegment: 1 }),
        );

        const result = bindRecordsByTimeRange(log, [candidate]);

        expect(result.log.byVideoKey.get(vendorFileKey(candidate))?.map((record) => record.unixSeconds)).toEqual([120]);
    });

    it("does not derive ordinary named records or reassign absent owners", () => {
        const absent = video("Card/Normal/absent.mp4");
        const present = video("Card/Normal/present.mp4", 160);
        const initial = bindRecordsByTimeRange(gpsLog(point(110), point(170)), [absent]);
        const result = bindRecordsByTimeRange(initial.log, [present]);

        expect(result.log.byVideoKey.has(vendorFileKey(absent))).toBe(true);
        expect(result.log.byVideoKey.has(vendorFileKey(present))).toBe(true);

        const named = rebuildLog([], [point(110, { timeAssociation: undefined })], []);
        expect(bindRecordsByTimeRange(named, [absent]).log).toBe(named);
    });
});

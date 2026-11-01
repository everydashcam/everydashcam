import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
    associateRecordsWithVideos,
    bindRecordsByFilename,
    bindRecordsByRecordingStart,
    buildVideoAssociationIndex,
    rebindRecordingCopyRecords,
    recordsForVideo,
    resolveVideoKey,
    settleFilenameAssociations,
} from "./gps-association.js";
import { mergeIntoGpsLog, rebuildLog, rebindOrphanLogRecords } from "./parser.js";
import { csv70maiDatedPrimitive } from "./parsers/primitives/csv-70mai-dated.js";
import type { GpsRecord, VendorFile, VideoWithRecordingCopies } from "./parsers/types.js";
import type { VideoCandidate } from "./trips.js";
import { vendorFileKey } from "./vendor-file-key.js";

function video(path: string, sourceKey: string): VendorFile {
    return {
        file: new File([sourceKey], path.split("/").pop()!, { lastModified: 1 }),
        relativePath: path,
        sourceKey,
    };
}

function record(lat: number): GpsRecord {
    return {
        unixSeconds: 100,
        active: true,
        lat,
        lon: 20,
        bearingDeg: 0,
        speedMs: 0,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename: "clip.mp4",
    };
}

function recordingCandidate(path: string, sourceKey: string, startUtc: number): VideoCandidate {
    const vf = video(path, sourceKey);
    return {
        ...vf,
        fingerprint: "recording-scoped-log",
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
    };
}

function recordingRecord(startUtc: number, sourceKey?: string): GpsRecord {
    return {
        ...record(10),
        mp4Filename: `[pending:${startUtc}]`,
        recordingAssociation: {
            startUtc,
            extractorId: "sectioned-nmea-log",
            ...(sourceKey === undefined ? {} : { sourceKey }),
        },
    };
}

const datedLogText = readFileSync(
    new URL("./parsers/__fixtures__/70mai-dated/real-anonymized-gps-folder.txt", import.meta.url),
    "utf8",
);

async function datedLog(sourceKey: string, text = datedLogText) {
    const source = {
        file: new File([text], "GPSData000001.txt"),
        relativePath: "CARD/.GPS/GPSData000001.txt",
        sourceKey,
    };
    const parsed = await csv70maiDatedPrimitive.parse(source);
    return { source, ...parsed, appliedExtractors: [csv70maiDatedPrimitive.id] };
}

describe("delayed filename GPS association", () => {
    it("binds a real dated log when its videos arrive later and deduplicates a re-drop", async () => {
        const parsed = await datedLog("card");
        associateRecordsWithVideos(parsed.records, parsed.source, [], csv70maiDatedPrimitive.id);
        const original = mergeIntoGpsLog(null, parsed);
        const normal = video("CARD/Normal/Front/NO20261021-211901-002571F.MP4", "card");
        const event = video("CARD/Event/Front/EV20261008-011452-002127F.MP4", "card");
        const videos = [normal, event];

        expect(original.pendingByFilename.size, "filename hints do not enter progressive time binding").toBe(0);
        expect(recordsForVideo(original, normal, videos)).toEqual([]);
        const bound = bindRecordsByFilename(original, videos);
        expect(bound.boundRecords).toBe(9);
        expect(recordsForVideo(bound.log, normal, videos)).toHaveLength(4);
        expect(recordsForVideo(bound.log, event, videos)).toHaveLength(5);
        expect(bound.extractorByFileKey).toEqual(
            new Map(videos.map((file) => [vendorFileKey(file), csv70maiDatedPrimitive.id])),
        );
        expect(
            original.records.every((record) => record.videoKey === undefined),
            "previous log is unchanged",
        ).toBe(true);
        expect(bound.log.byVideoKey.get(vendorFileKey(normal))![0]!.filenameAssociation?.mp4Filename).toBe(
            "20261021-211901-002571F.MP4",
        );
        settleFilenameAssociations(bound.log, videos);
        expect(bound.log.byVideoKey.get(vendorFileKey(normal))!.every((record) => !record.filenameAssociation)).toBe(
            true,
        );
        expect(bindRecordsByFilename(bound.log, videos).boundRecords).toBe(0);

        const repeated = await datedLog("card");
        associateRecordsWithVideos(repeated.records, repeated.source, videos, csv70maiDatedPrimitive.id);
        const merged = mergeIntoGpsLog(bound.log, repeated);
        expect(merged.records).toHaveLength(bound.log.records.length);
        expect(recordsForVideo(merged, normal, videos)).toHaveLength(4);
    });

    it.each(["immediate", "delayed"])(
        "restores a cancelled %s binding for retry and protects committed owners",
        async (timing) => {
            const parsed = await datedLog("log-drop", `${datedLogText.split("\n")[0]}\n`);
            const referenceName = parsed.records[0]!.mp4Filename;
            const abandoned = video(`CARD/Normal/NO${referenceName}`, "cancelled-video-drop");
            associateRecordsWithVideos(
                parsed.records,
                parsed.source,
                timing === "immediate" ? [abandoned] : [],
                csv70maiDatedPrimitive.id,
            );
            let log = mergeIntoGpsLog(null, parsed);
            if (timing === "delayed") log = bindRecordsByFilename(log, [abandoned]).log;
            expect(recordsForVideo(log, abandoned, [abandoned])).toHaveLength(1);

            log = settleFilenameAssociations(log, []);
            expect(log.byVideoKey.size, "abandoned ownership is removed").toBe(0);
            expect(log.records[0]!.mp4Filename).toBe(referenceName);
            expect(log.records[0]!.filenameAssociation?.sourceKey).toBe("log-drop");
            expect(log.byFilename.has(abandoned.file.name)).toBe(false);

            const retry = video(abandoned.relativePath, "retry-video-drop");
            const bound = bindRecordsByFilename(log, [retry]);
            expect(bound.boundRecords).toBe(1);
            expect(bound.extractorByFileKey.get(vendorFileKey(retry))).toBe(csv70maiDatedPrimitive.id);
            log = settleFilenameAssociations(bound.log, [retry]);
            expect(log.records[0]!.filenameAssociation).toBeUndefined();
            expect(recordsForVideo(log, retry, [retry])).toHaveLength(1);

            const foreign = video(abandoned.relativePath, "foreign-card");
            log = settleFilenameAssociations(log, [foreign]);
            expect(bindRecordsByFilename(log, [foreign]).boundRecords).toBe(0);
            associateRecordsWithVideos(log.records, parsed.source, [foreign], csv70maiDatedPrimitive.id);
            expect(log.records[0]!.videoKey).toBe(vendorFileKey(retry));
            expect(recordsForVideo(log, foreign, [foreign])).toEqual([]);
        },
    );

    it("keeps committed bindings while restoring another uncommitted recording", async () => {
        const parsed = await datedLog("card");
        const normal = video("CARD/Normal/Front/NO20261021-211901-002571F.MP4", "card");
        const event = video("CARD/Event/Front/EV20261008-011452-002127F.MP4", "card");
        associateRecordsWithVideos(parsed.records, parsed.source, [normal, event], csv70maiDatedPrimitive.id);
        const log = settleFilenameAssociations(mergeIntoGpsLog(null, parsed), [normal]);
        expect(recordsForVideo(log, normal, [normal])).toHaveLength(4);
        expect(log.byVideoKey.has(vendorFileKey(event))).toBe(false);
        expect(log.byFilename.get("20261008-011452-002127F.MP4")).toHaveLength(5);
        expect(log.byVideoKey.get(vendorFileKey(normal))!.every((record) => !record.filenameAssociation)).toBe(true);
    });

    it("preserves pending rows independently by source and front/rear filename", async () => {
        const frontRow = datedLogText.split("\n")[0]!;
        const twoChannels = `${frontRow}\n${frontRow.replace(/F\.MP4$/, "B.MP4")}\n`;
        const first = await datedLog("a", twoChannels);
        const second = await datedLog("b", twoChannels);
        for (const parsed of [first, second]) {
            associateRecordsWithVideos(parsed.records, parsed.source, [], csv70maiDatedPrimitive.id);
        }
        let log = mergeIntoGpsLog(mergeIntoGpsLog(null, first), second);
        expect(log.records).toHaveLength(4);
        const repeated = await datedLog("a", twoChannels);
        associateRecordsWithVideos(repeated.records, repeated.source, [], csv70maiDatedPrimitive.id);
        log = mergeIntoGpsLog(log, repeated);
        expect(log.records).toHaveLength(4);

        const videos = ["a", "b"].flatMap((sourceKey) =>
            first.records.map((record) => video(`CARD/Normal/NO${record.mp4Filename}`, sourceKey)),
        );
        const bound = bindRecordsByFilename(log, videos);
        expect(bound.boundRecords).toBe(4);
        expect(bound.log.records).toHaveLength(4);
        for (const file of videos) expect(recordsForVideo(bound.log, file, videos)).toHaveLength(1);
    });

    it("leaves ambiguous source matches pending and blocks legacy basename recovery", async () => {
        const parsed = await datedLog("third", `${datedLogText.split("\n")[0]}\n`);
        associateRecordsWithVideos(parsed.records, parsed.source, [], csv70maiDatedPrimitive.id);
        const log = mergeIntoGpsLog(null, parsed);
        const bareName = parsed.records[0]!.mp4Filename;
        const a = video(`CARD/Normal/NO${bareName}`, "a");
        const b = video(`CARD/Normal/NO${bareName}`, "b");
        expect(bindRecordsByFilename(log, [a, b])).toEqual({
            log,
            boundRecords: 0,
            extractorByFileKey: new Map(),
        });
        expect(rebindOrphanLogRecords(log, [a.file.name])).toBe(0);
        expect(log.records[0]!.mp4Filename).toBe(bareName);

        const bareCopy = video(`CARD/Normal/${bareName}`, "a");
        const survivor = { ...a, recordingCopies: [bareCopy] };
        expect(recordsForVideo(log, bareCopy, [bareCopy])).toEqual([]);
        expect(rebindRecordingCopyRecords(log, [survivor])).toEqual({ log, reboundRecords: 0 });
    });

    it("keeps recording and directory hints out of filename association", () => {
        const source = video("CARD/GPSData.txt", "card");
        const recording = recordingRecord(100, "card");
        const directory = {
            ...record(10),
            timeAssociation: { sourcePath: source.relativePath, sourceKey: source.sourceKey, extractorId: "nmea" },
        };
        associateRecordsWithVideos([recording, directory], source, [], "nmea");
        expect(recording.filenameAssociation).toBeUndefined();
        expect(directory).not.toHaveProperty("filenameAssociation");
    });
});

describe("GPS video association", () => {
    it("leaves an ordinary log unchanged when no recording copies are known", () => {
        const ordinary = video("Normal/clip.mp4", "card-a");
        const unowned = record(10);
        const original = rebuildLog([], [unowned], []);

        const result = rebindRecordingCopyRecords(original, [ordinary]);

        expect(result.log).toBe(original);
        expect(result.reboundRecords).toBe(0);
        expect(unowned.videoKey).toBeUndefined();
    });

    it("leaves ordinary recordings unowned when another recording has copies", () => {
        const ordinary = video("Normal/clip.mp4", "card-a");
        const withCopy: VideoWithRecordingCopies = {
            ...video("Event/event.mp4", "card-a"),
            recordingCopies: [video("Normal/copied.mp4", "card-a")],
        };
        const unowned = record(10);
        const original = rebuildLog([], [unowned], []);

        const result = rebindRecordingCopyRecords(original, [ordinary, withCopy]);

        expect(result.log).toBe(original);
        expect(result.reboundRecords).toBe(0);
        expect(unowned.videoKey).toBeUndefined();
    });

    it.each(["normal", "event"])("binds both protected-copy filenames to the %s survivor", (survivorMode) => {
        const normal = video("Normal/Front/NO20260101-120000-000001F.MP4", "card-a");
        const event = video("Event/Front/EV20260101-120000-000001F.MP4", "card-a");
        const [kept, copy] = survivorMode === "normal" ? [normal, event] : [event, normal];
        const survivor: VideoWithRecordingCopies = { ...kept!, recordingCopies: [copy!] };
        const index = buildVideoAssociationIndex([survivor]);
        const source = video("GPSData.txt", "card-a");
        const records = [
            { ...record(10), mp4Filename: normal.file.name },
            { ...record(10), mp4Filename: event.file.name, accelXg: 2 },
        ];

        associateRecordsWithVideos(records, source, index);
        const log = mergeIntoGpsLog(null, { records, appliedExtractors: [], skipped: [] });

        expect([...index.videosByFilename.keys()]).toEqual([kept!.file.name, copy!.file.name]);
        expect(records.map((rec) => rec.videoKey)).toEqual([vendorFileKey(survivor), vendorFileKey(survivor)]);
        expect(records.map((rec) => rec.mp4Filename)).toEqual([survivor.file.name, survivor.file.name]);
        expect(log.records).toHaveLength(1);
        expect(recordsForVideo(log, survivor, index)[0]?.accelXg).toBe(2);
    });

    it("treats same-named physical copies as one owner without hiding unowned rows", () => {
        const normal = video("Normal/clip.mp4", "card-a");
        const event = video("Event/clip.mp4", "card-a");
        const survivor: VideoWithRecordingCopies = { ...normal, recordingCopies: [event] };
        const source = video("GPSData.txt", "late-drop");
        const rec = record(10);
        const index = buildVideoAssociationIndex([survivor]);

        expect(resolveVideoKey(source, "clip.mp4", index)).toBe(vendorFileKey(normal));
        expect(recordsForVideo(rebuildLog([], [rec], []), survivor, index)).toEqual([rec]);
    });

    it("uses each copy's source and directory before choosing the canonical recording", () => {
        const first: VideoWithRecordingCopies = {
            ...video("A/Event/event.mp4", "card-a"),
            recordingCopies: [video("A/Normal/clip.mp4", "card-a")],
        };
        const second: VideoWithRecordingCopies = {
            ...video("B/Event/event.mp4", "card-b"),
            recordingCopies: [video("B/Normal/clip.mp4", "card-b")],
        };
        const index = buildVideoAssociationIndex([first, second]);

        expect(resolveVideoKey(video("logs/GPSData.txt", "card-b"), "clip.mp4", index)).toBe(vendorFileKey(second));
        expect(resolveVideoKey(video("B/Normal/clip.gpx", "late-drop"), "clip.mp4", index)).toBe(vendorFileKey(second));
        expect(resolveVideoKey(video("logs/GPSData.txt", "late-drop"), "clip.mp4", index)).toBeNull();
        const unowned = record(10);
        expect(recordsForVideo(rebuildLog([], [unowned], []), first, index)).toEqual([]);
        expect(recordsForVideo(rebuildLog([], [unowned], []), second, index)).toEqual([]);
    });

    it("rebinds earlier keyed and unowned copy rows once without mutating the previous log", () => {
        const normal = video("Normal/clip.mp4", "card-a");
        const event = video("Event/event.mp4", "card-a");
        const survivor: VideoWithRecordingCopies = { ...event, recordingCopies: [normal] };
        const ownedCopy = { ...record(10), videoKey: vendorFileKey(normal) };
        const unownedCopy = { ...record(11), unixSeconds: 101 };
        const canonical = { ...record(10), mp4Filename: event.file.name, videoKey: vendorFileKey(event), accelXg: 2 };
        const original = rebuildLog(["csv-70mai"], [ownedCopy, unownedCopy, canonical], []);

        const rebound = rebindRecordingCopyRecords(original, [survivor]);

        expect(rebound.reboundRecords).toBe(2);
        expect(ownedCopy.videoKey).toBe(vendorFileKey(normal));
        expect(unownedCopy.videoKey).toBeUndefined();
        expect(rebound.log.records).toHaveLength(2);
        expect(recordsForVideo(rebound.log, survivor, [survivor]).map((rec) => rec.unixSeconds)).toEqual([100, 101]);
        expect(rebound.log.records.every((rec) => rec.mp4Filename === event.file.name)).toBe(true);
        expect(rebound.log.records[0]?.accelXg).toBe(2);
        expect(rebindRecordingCopyRecords(rebound.log, [survivor])).toEqual({ log: rebound.log, reboundRecords: 0 });
    });

    it("preserves unknown concrete owners and ambiguous unowned rows when copies arrive", () => {
        const first: VideoWithRecordingCopies = {
            ...video("A/Event/event.mp4", "card-a"),
            recordingCopies: [video("A/Normal/clip.mp4", "card-a")],
        };
        const second: VideoWithRecordingCopies = {
            ...video("B/Event/event.mp4", "card-b"),
            recordingCopies: [video("B/Normal/clip.mp4", "card-b")],
        };
        const foreign = { ...record(10), videoKey: vendorFileKey(video("C/clip.mp4", "card-c")) };
        const unowned = record(11);
        const original = rebuildLog([], [foreign, unowned], []);

        const rebound = rebindRecordingCopyRecords(original, [first, second]);
        associateRecordsWithVideos([foreign], video("A/GPSData.txt", "card-a"), [first, second]);

        expect(rebound).toEqual({ log: original, reboundRecords: 0 });
        expect(foreign.videoKey).toBe(vendorFileKey(video("C/clip.mp4", "card-c")));
        expect(foreign.mp4Filename).toBe("clip.mp4");
        expect(unowned.videoKey).toBeUndefined();
    });

    it("does not attach a foreign owner's GPS to the only same-named recording", () => {
        const local = video("A/clip.mp4", "card-a");
        const foreign = { ...record(10), videoKey: vendorFileKey(video("B/clip.mp4", "card-b")) };
        const owner = foreign.videoKey;

        associateRecordsWithVideos([foreign], video("A/GPSData.txt", "card-a"), [local]);

        expect(foreign.videoKey).toBe(owner);
        expect(recordsForVideo(rebuildLog([], [foreign], []), local, [local])).toEqual([]);
    });

    it("reads canonical-owned rows across alias names in chronological order before normalization", () => {
        const survivor: VideoWithRecordingCopies = {
            ...video("Event/event.mp4", "card-a"),
            recordingCopies: [video("Normal/clip.mp4", "card-a")],
        };
        const early = { ...record(10), videoKey: vendorFileKey(survivor) };
        const late = {
            ...record(11),
            unixSeconds: 200,
            mp4Filename: survivor.file.name,
            videoKey: vendorFileKey(survivor),
        };
        const log = rebuildLog([], [late, early], []);

        expect(recordsForVideo(log, survivor, [survivor])).toEqual([early, late]);
    });

    it("indexes pending sections through incremental merges and removes resolved hints", () => {
        const startUtc = 1_777_777_777;
        const first = recordingRecord(startUtc, "card-a");
        const second = { ...recordingRecord(startUtc, "card-a"), unixSeconds: 101 };
        const unresolved = recordingRecord(startUtc + 100, "card-a");
        const candidate = recordingCandidate("A/MAH00001.MP4", "card-a", startUtc);
        const log = mergeIntoGpsLog(rebuildLog([], [record(10), first], []), {
            records: [second, unresolved],
            appliedExtractors: [],
            skipped: [],
        });
        expect(log.pendingByFilename.size).toBe(2);
        expect(log.pendingByFilename.get(first.mp4Filename)).toBe(log.byFilename.get(first.mp4Filename));
        const result = bindRecordsByRecordingStart(log, [candidate]);
        expect(result.boundRecords).toBe(2);
        expect(result.log.pendingByFilename.size).toBe(1);
        expect(result.log.pendingByFilename.get(unresolved.mp4Filename)).toEqual([unresolved]);
        expect(recordsForVideo(result.log, candidate, [candidate])).toHaveLength(2);
    });

    it("does not inspect settled record buckets while binding a new section", () => {
        const settled = record(10);
        const startUtc = 1_777_777_777;
        const pending = recordingRecord(startUtc);
        const log = rebuildLog([], [settled, pending], []);
        let settledReads = 0;
        Object.defineProperty(settled, "recordingAssociation", {
            get() {
                settledReads++;
                return undefined;
            },
        });
        const candidate = recordingCandidate("A/MAH00001.MP4", "card-a", startUtc + 10);
        expect(bindRecordsByRecordingStart(log, [candidate]).boundRecords).toBe(0);
        expect(settledReads).toBe(0);
    });

    it("resolves an external source to the matching source scope", () => {
        const a = video("CARD/DCIM/clip.mp4", "card-a");
        const b = video("CARD/DCIM/clip.mp4", "card-b");
        const sidecar = video("CARD/DCIM/clip.gpx", "card-b");
        expect(resolveVideoKey(sidecar, "clip.mp4", [a, b])).toBe(vendorFileKey(b));
    });

    it("uses directory proximity when a later sidecar drop has a new scope", () => {
        const a = video("A/DCIM/clip.mp4", "old-a");
        const b = video("B/DCIM/clip.mp4", "old-b");
        const sidecar = video("B/DCIM/clip.gpx", "late-drop");
        expect(resolveVideoKey(sidecar, "clip.mp4", [a, b])).toBe(vendorFileKey(b));
    });

    it("falls back to the 70mai name core only when no exact basename is loaded", () => {
        const normal = video("CARD/Normal/Front/NO20261021-211901-002571F.MP4", "card");
        const event = video("CARD/Event/Front/EV20261021-211901-002571F.MP4", "card");
        const log = video("CARD/.GPS/GPSData000001.txt", "card");
        // A dated log names the clip without a mode prefix; an exact name, when
        // loaded, still beats a same-core sibling.
        expect(resolveVideoKey(log, "20261021-211901-002571F.MP4", [event])).toBe(vendorFileKey(event));
        expect(resolveVideoKey(log, "EV20261021-211901-002571F.MP4", [normal, event])).toBe(vendorFileKey(event));
    });

    it("scopes a name-core match to the log's own card", () => {
        const here = video("A/Event/Front/EV20261021-211901-002571F.MP4", "a");
        const other = video("B/Normal/Front/NO20261021-211901-002571F.MP4", "b");
        const log = video("A/.GPS/GPSData000001.txt", "a");
        expect(resolveVideoKey(log, "20261021-211901-002571F.MP4", [here, other])).toBe(vendorFileKey(here));
    });

    it("keeps a name core shared by two recordings of one card unowned", () => {
        const normal = video("CARD/Normal/Front/NO20261021-211901-002571F.MP4", "card");
        const event = video("CARD/Event/Front/EV20261021-211901-002571F.MP4", "card");
        const log = video("CARD/.GPS/GPSData000001.txt", "card");
        expect(resolveVideoKey(log, "20261021-211901-002571F.MP4", [normal, event])).toBeNull();
    });

    it("does not extend the name-core fallback to non-70mai names", () => {
        const clip = video("CARD/DCIM/20261021-211901.MP4", "card");
        const log = video("CARD/gps.txt", "card");
        expect(resolveVideoKey(log, "NO20261021-211901.MP4", [clip])).toBeNull();
        expect(resolveVideoKey(log, "clip.mp4", [clip])).toBeNull();
    });

    it("keeps an unresolved basename unowned instead of guessing", () => {
        const a = video("A/clip.mp4", "card-a");
        const b = video("B/clip.mp4", "card-b");
        const source = video("logs/GPSData.txt", "third-source");
        const rec = record(10);
        associateRecordsWithVideos([rec], source, [a, b]);
        expect(rec.videoKey).toBeUndefined();

        const log = rebuildLog([], [rec], []);
        expect(recordsForVideo(log, a, [a, b])).toEqual([]);
        expect(recordsForVideo(log, b, [a, b])).toEqual([]);
    });

    it("keeps equal basename/time/position records separate by concrete video", () => {
        const a = video("A/clip.mp4", "card-a");
        const b = video("B/clip.mp4", "card-b");
        const aRecord = { ...record(10), videoKey: vendorFileKey(a) };
        const bRecord = { ...record(10), videoKey: vendorFileKey(b) };
        const log = mergeIntoGpsLog(null, { records: [aRecord, bRecord], skipped: [], appliedExtractors: [] });

        expect(log.records).toHaveLength(2);
        expect(recordsForVideo(log, a, [a, b])).toEqual([aRecord]);
        expect(recordsForVideo(log, b, [a, b])).toEqual([bRecord]);
    });

    it("stabilizes stationary bearings independently for equal basenames", () => {
        const a = video("A/clip.mp4", "card-a");
        const b = video("B/clip.mp4", "card-b");
        const aMoving = { ...record(10), unixSeconds: 100, speedMs: 5, bearingDeg: 90, videoKey: vendorFileKey(a) };
        const bStopped = {
            ...record(20),
            unixSeconds: 101,
            speedMs: 0,
            bearingDeg: 210,
            videoKey: vendorFileKey(b),
        };
        const aStopped = {
            ...record(11),
            unixSeconds: 102,
            speedMs: 0,
            bearingDeg: 0,
            videoKey: vendorFileKey(a),
        };

        mergeIntoGpsLog(null, { records: [aMoving, bStopped, aStopped], skipped: [], appliedExtractors: [] });

        expect(aStopped.bearingDeg).toBe(90);
        expect(bStopped.bearingDeg).toBe(210);
    });

    it("keeps a concrete-owner bucket sorted for binary-search consumers", () => {
        const a = video("A/clip.mp4", "card-a");
        const key = vendorFileKey(a);
        const late = { ...record(11), unixSeconds: 200, videoKey: key };
        const early = { ...record(10), unixSeconds: 100, videoKey: key };

        const log = rebuildLog([], [late, early], []);

        expect(log.byVideoKey.get(key)?.map((item) => item.unixSeconds)).toEqual([100, 200]);
    });

    it("binds a recording-scoped section to the unique matching creation time", () => {
        const startUtc = 1_777_777_777;
        const rec = recordingRecord(startUtc, "card-a");
        const candidate = recordingCandidate("MP_ROOT/100ANV01/MAH00384.MP4", "card-a", startUtc + 0.8);
        const log = rebuildLog(["sectioned-nmea-log"], [rec], []);

        const result = bindRecordsByRecordingStart(log, [candidate]);

        expect(result.boundRecords).toBe(1);
        expect(result.boundVideos).toBe(1);
        expect(rec.mp4Filename).toBe("MAH00384.MP4");
        expect(rec.videoKey).toBe(vendorFileKey(candidate));
        expect(rec.recordingAssociation).toBeUndefined();
        expect(candidate.appliedExtractors).toEqual(["sectioned-nmea-log"]);
    });

    it.each([-1, -0.8, 0, 0.8, 1])("binds a creation time %s seconds from a fractional section start", (offset) => {
        const startUtc = 1_777_777_777.5;
        const rec = recordingRecord(startUtc);
        const candidate = recordingCandidate("A/clip.mp4", "card-a", startUtc + offset);

        const result = bindRecordsByRecordingStart(rebuildLog([], [rec], []), [candidate]);

        expect(result.boundRecords).toBe(1);
        expect(rec.videoKey).toBe(vendorFileKey(candidate));
    });

    it.each([-1.001, 1.001])("leaves a creation time %s seconds outside the section tolerance unbound", (offset) => {
        const startUtc = 1_777_777_777.5;
        const rec = recordingRecord(startUtc);
        const candidate = recordingCandidate("A/clip.mp4", "card-a", startUtc + offset);

        expect(bindRecordsByRecordingStart(rebuildLog([], [rec], []), [candidate]).boundRecords).toBe(0);
        expect(rec.recordingAssociation).toBeDefined();
    });

    it("leaves matching starts in neighboring seconds ambiguous", () => {
        const startUtc = 1_777_777_777;
        const rec = recordingRecord(startUtc);
        const candidates = [
            recordingCandidate("A/first.mp4", "card-a", startUtc - 0.8),
            recordingCandidate("A/second.mp4", "card-a", startUtc + 0.8),
        ];

        expect(bindRecordsByRecordingStart(rebuildLog([], [rec], []), candidates).boundRecords).toBe(0);
        expect(rec.recordingAssociation).toBeDefined();
    });

    it("checks each candidate's external route once for a batch of pending sections", () => {
        const startUtc = 1_777_777_777;
        let externalTrackReads = 0;
        const candidates = Array.from({ length: 20 }, (_, index) => {
            const candidate = recordingCandidate(`A/clip-${index}.mp4`, "card-a", startUtc + index * 60);
            const telemetry = record(10);
            Object.defineProperty(telemetry, "externalTrack", {
                get() {
                    externalTrackReads++;
                    return false;
                },
            });
            candidate.records = [telemetry];
            return candidate;
        });
        const pending = candidates.map((candidate) => recordingRecord(candidate.startUtc));

        const result = bindRecordsByRecordingStart(rebuildLog([], pending, []), candidates);

        expect(result.boundVideos).toBe(candidates.length);
        expect(result.boundRecords).toBe(pending.length);
        expect(externalTrackReads).toBe(candidates.length);
        for (const [index, rec] of pending.entries()) {
            expect(rec.videoKey).toBe(vendorFileKey(candidates[index]!));
        }
    });

    it("prefers the matching source scope when two cards contain the same start time", () => {
        const startUtc = 1_777_777_777;
        const a = recordingCandidate("MP_ROOT/100ANV01/MAH00001.MP4", "card-a", startUtc);
        const b = recordingCandidate("MP_ROOT/100ANV01/MAH00001.MP4", "card-b", startUtc);
        const rec = recordingRecord(startUtc, "card-b");

        const result = bindRecordsByRecordingStart(rebuildLog([], [rec], []), [a, b]);

        expect(result.boundRecords).toBe(1);
        expect(rec.videoKey).toBe(vendorFileKey(b));
        expect(a.appliedExtractors).toEqual([]);
        expect(b.appliedExtractors).toEqual(["sectioned-nmea-log"]);
    });

    it("uses a unique cross-source start for a log added after its video", () => {
        const startUtc = 1_777_777_777;
        const candidate = recordingCandidate("MP_ROOT/100ANV01/MAH00001.MP4", "earlier-video-drop", startUtc);
        const rec = recordingRecord(startUtc, "later-log-drop");

        const result = bindRecordsByRecordingStart(rebuildLog([], [rec], []), [candidate]);

        expect(result.boundRecords).toBe(1);
        expect(rec.videoKey).toBe(vendorFileKey(candidate));
    });

    it("does not mix a late recording-scoped log into an explicitly assigned external track", () => {
        const startUtc = 1_777_777_777;
        const candidate = recordingCandidate("MP_ROOT/100ANV01/MAH00001.MP4", "card-a", startUtc);
        candidate.records = [{ ...record(startUtc), externalTrack: true }];
        const rec = recordingRecord(startUtc, "card-a");
        const log = rebuildLog(["sectioned-nmea-log"], [rec], []);

        const result = bindRecordsByRecordingStart(log, [candidate]);

        expect(result.boundRecords).toBe(0);
        expect(rec.recordingAssociation).toBeDefined();
        expect(rec.videoKey).toBeUndefined();
    });

    it("waits for a same-source candidate instead of binding to a ready clip from another card", () => {
        const startUtc = 1_777_777_777;
        const pendingSameSource = recordingCandidate("A/MAH00001.MP4", "card-a", startUtc);
        pendingSameSource.createdUtc = null;
        const readyOtherSource = recordingCandidate("B/MAH00001.MP4", "card-b", startUtc);
        const rec = recordingRecord(startUtc, "card-a");

        const result = bindRecordsByRecordingStart(rebuildLog([], [rec], []), [pendingSameSource, readyOtherSource]);

        expect(result.boundRecords).toBe(0);
        expect(rec.recordingAssociation).toBeDefined();
        expect(readyOtherSource.appliedExtractors).toEqual([]);
    });

    it("leaves an ambiguous recording start unbound instead of guessing", () => {
        const startUtc = 1_777_777_777;
        const a = recordingCandidate("A/MAH00001.MP4", "card-a", startUtc);
        const b = recordingCandidate("B/MAH00001.MP4", "card-b", startUtc);
        const rec = recordingRecord(startUtc);
        const log = rebuildLog([], [rec], []);

        const result = bindRecordsByRecordingStart(log, [a, b]);

        expect(result).toEqual({ log, boundRecords: 0, boundVideos: 0 });
        expect(rec.mp4Filename).toBe(`[pending:${startUtc}]`);
        expect(rec.videoKey).toBeUndefined();
        expect(rec.recordingAssociation).toBeDefined();
    });

    it("leaves a bucket with conflicting recording hints unbound", () => {
        const first = recordingRecord(1_777_777_777, "card-a");
        const second = recordingRecord(1_777_777_900, "card-a");
        second.mp4Filename = first.mp4Filename;
        const candidates = [
            recordingCandidate("A/MAH00001.MP4", "card-a", 1_777_777_777),
            recordingCandidate("A/MAH00002.MP4", "card-a", 1_777_777_900),
        ];
        const log = rebuildLog([], [first, second], []);

        const result = bindRecordsByRecordingStart(log, candidates);

        expect(result.boundRecords).toBe(0);
        expect(first.recordingAssociation).toBeDefined();
        expect(second.recordingAssociation).toBeDefined();
    });
});

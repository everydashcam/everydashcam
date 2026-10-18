import { describe, expect, it } from "vitest";

import {
    associateRecordsWithVideos,
    bindRecordsByRecordingStart,
    buildVideoAssociationIndex,
    rebindRecordingCopyRecords,
    recordsForVideo,
    resolveVideoKey,
} from "./gps-association.js";
import { mergeIntoGpsLog, rebuildLog } from "./parser.js";
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

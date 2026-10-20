import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    _resetForTests,
    applyStoredCameraTimezones,
    cameraTimezonePeers,
    directoryGpsRecordsForFile,
    directoryGpsScopeKeysForFile,
    hasDirectoryGpsForFile,
    isCameraTimezoneOffset,
    setCameraTimezoneForRecordings,
} from "./camera-timezone.js";
import { attachRecordsToCandidates } from "./gps-association.js";
import { bindRecordsByTimeRange } from "./gps-time-association.js";
import { mergeIntoGpsLog } from "./parser.js";
import { classifyFilenameClockTimelapse, classifyFilenameTime } from "./parsers/filename/index.js";
import { csv70maiPrimitive } from "./parsers/primitives/csv-70mai.js";
import type { VendorFile } from "./parsers/types.js";
import { rederiveStartUtcForCandidates, type VideoCandidate } from "./trips.js";

const storage = new Map<string, string>();
const STORAGE_KEY = "everydashcam:recordings:cameraTimezone";
const fixture = readFileSync(
    new URL("./parsers/__fixtures__/70mai/real-anonymized-a500s.txt", import.meta.url),
    "utf8",
);

function file(path: string, sourceKey = "drop:1"): VendorFile {
    return {
        file: new File(["video"], path.split("/").pop()!, { lastModified: 1234 }),
        relativePath: path,
        sourceKey,
    };
}

function video(path: string, sourceKey = "drop:1"): VideoCandidate {
    return {
        ...file(path, sourceKey),
        fingerprint: "directory-log-camera",
        appliedExtractors: [],
        classifierMatches: { time: null, channel: null, mode: null, sequence: null },
        channel: null,
        channelConfident: false,
        sequence: null,
        recordingMode: null,
        isTimelapse: false,
        startUtc: 0,
        durationSec: 60,
        wallDurationSec: null,
        driftLeadSec: null,
        startSource: "name",
        cameraTzSec: null,
        createdUtc: null,
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

async function directoryLog(path = "Card/GPSData000001.txt", sourceKey = "drop:1") {
    const result = await csv70maiPrimitive.parse({
        file: new File([fixture], path.split("/").pop()!, { lastModified: 1 }),
        relativePath: path,
        sourceKey,
    });
    return mergeIntoGpsLog(null, { ...result, appliedExtractors: ["csv-70mai"] });
}

beforeEach(() => {
    storage.clear();
    _resetForTests();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
    });
});

afterEach(() => vi.unstubAllGlobals());

describe("camera timezone preferences", () => {
    it("accepts UTC and quarter-hour zones within the selector range", () => {
        for (const offset of [-43200, 0, 20700, 50400]) expect(isCameraTimezoneOffset(offset)).toBe(true);
        for (const offset of [NaN, Infinity, -44100, 51300, 1, "10800", null]) {
            expect(isCameraTimezoneOffset(offset)).toBe(false);
        }
    });

    it("shares a root log's zone with descendant recordings and isolates other cards", async () => {
        const log = await directoryLog("Cards/A/GPSData000001.txt");
        const first = video("Cards/A/Normal/first.mp4");
        const sibling = video("Cards/A/Event/second.mp4");
        const otherRoot = video("Cards/B/Normal/third.mp4");
        const otherSource = video(first.relativePath, "drop:2");
        const candidates = [first, sibling, otherRoot, otherSource];

        expect(hasDirectoryGpsForFile(first, log)).toBe(true);
        expect(hasDirectoryGpsForFile(otherRoot, log)).toBe(false);
        expect(hasDirectoryGpsForFile(otherSource, log)).toBe(false);
        expect(directoryGpsScopeKeysForFile(first, log)).toEqual(directoryGpsScopeKeysForFile(sibling, log));
        expect(directoryGpsRecordsForFile(first, log)).toEqual([...log.pendingByFilename.values()].flat());
        expect(directoryGpsRecordsForFile(otherSource, log)).toEqual([]);
        expect(cameraTimezonePeers([first], candidates, log)).toEqual([first, sibling]);

        setCameraTimezoneForRecordings([first], candidates, log, 10800);
        expect(candidates.map((candidate) => candidate.cameraTimezoneOverrideSec)).toEqual([10800, 10800, null, null]);
    });

    it("restores the same recordings across drop ids and applies the preference to new siblings", async () => {
        const original = video("Card/Normal/first.mp4");
        setCameraTimezoneForRecordings([original], [original], await directoryLog(), 20700);
        _resetForTests();

        const reopened = video(original.relativePath, "drop:7");
        const sibling = video("Card/Event/later.mp4", "drop:7");
        const unrelated = video("Other/first.mp4", "drop:7");
        applyStoredCameraTimezones(
            [reopened, sibling, unrelated],
            await directoryLog("Card/GPSData000001.txt", "drop:7"),
        );
        expect([reopened, sibling, unrelated].map((candidate) => candidate.cameraTimezoneOverrideSec)).toEqual([
            20700,
            20700,
            null,
        ]);
    });

    it("keeps remembered physical folders separate even when filenames and metadata match", () => {
        const first = video("Normal/first.mp4", "folder:a");
        const second = video(first.relativePath, "folder:b");
        setCameraTimezoneForRecordings([first], [first, second], null, 0);
        _resetForTests();
        applyStoredCameraTimezones([first, second], null);
        expect(first.cameraTimezoneOverrideSec).toBe(0);
        expect(second.cameraTimezoneOverrideSec).toBeNull();
        const later = video("Normal/later.mp4", "folder:a");
        _resetForTests();
        applyStoredCameraTimezones([later], null);
        expect(later.cameraTimezoneOverrideSec).toBe(0);
    });

    it("keeps separate session choices for cards with an indistinguishable recording identity", () => {
        const first = video("Card/Normal/shared.mp4", "drop:1");
        const firstSibling = video("Card/Normal/first-only.mp4", "drop:1");
        const second = video(first.relativePath, "drop:2");
        const secondSibling = video("Card/Normal/second-only.mp4", "drop:2");
        const candidates = [first, firstSibling, second, secondSibling];
        setCameraTimezoneForRecordings([first], candidates, null, 10800);
        setCameraTimezoneForRecordings([second], candidates, null, 19800);
        applyStoredCameraTimezones(candidates, null);
        expect(candidates.map((candidate) => candidate.cameraTimezoneOverrideSec)).toEqual([
            10800, 10800, 19800, 19800,
        ]);
        _resetForTests();
        applyStoredCameraTimezones([firstSibling, secondSibling], null);
        expect(firstSibling.cameraTimezoneOverrideSec).toBe(10800);
        expect(secondSibling.cameraTimezoneOverrideSec).toBe(19800);
    });

    it("forgets a previously saved identity after another card makes it ambiguous", () => {
        const first = video("Card/Normal/shared.mp4", "drop:1");
        setCameraTimezoneForRecordings([first], [first], null, 10800);
        const second = video(first.relativePath, "drop:2");
        applyStoredCameraTimezones([first, second], null);
        expect(first.cameraTimezoneOverrideSec).toBe(10800);
        expect(second.cameraTimezoneOverrideSec).toBeNull();

        _resetForTests();
        const reopenedSecond = video(second.relativePath, "drop:3");
        applyStoredCameraTimezones([reopenedSecond], null);
        expect(reopenedSecond.cameraTimezoneOverrideSec).toBeNull();
    });

    it("remembers inherited siblings when a later opening contains only the new recording", async () => {
        const first = video("Card/Normal/first.mp4");
        setCameraTimezoneForRecordings([first], [first], await directoryLog(), 20700);
        _resetForTests();
        const reopened = video(first.relativePath, "drop:7");
        const later = video("Card/Event/later.mp4", "drop:7");
        applyStoredCameraTimezones([reopened, later], await directoryLog("Card/GPSData000001.txt", "drop:7"));
        expect(later.cameraTimezoneOverrideSec).toBe(20700);

        _resetForTests();
        const laterAlone = video(later.relativePath, "drop:8");
        applyStoredCameraTimezones([laterAlone], await directoryLog("Card/GPSData000001.txt", "drop:8"));
        expect(laterAlone.cameraTimezoneOverrideSec).toBe(20700);
    });

    it("keeps Auto reset for unopened members of the same remembered cohort", async () => {
        const first = video("Card/Normal/first.mp4");
        const second = video("Card/Event/second.mp4");
        setCameraTimezoneForRecordings([first], [first, second], await directoryLog(), 10800);
        _resetForTests();

        const reopenedFirst = video(first.relativePath, "drop:7");
        const nextLog = await directoryLog("Card/GPSData000001.txt", "drop:7");
        applyStoredCameraTimezones([reopenedFirst], nextLog);
        setCameraTimezoneForRecordings([reopenedFirst], [reopenedFirst], nextLog, null);
        _resetForTests();

        const reopenedSecond = video(second.relativePath, "drop:8");
        const finalLog = await directoryLog("Card/GPSData000001.txt", "drop:8");
        applyStoredCameraTimezones([reopenedSecond], finalLog);
        expect(reopenedSecond.cameraTimezoneOverrideSec).toBeNull();
        const all = [video(first.relativePath, "drop:8"), reopenedSecond];
        applyStoredCameraTimezones(all, finalLog);
        expect(all.map((candidate) => candidate.cameraTimezoneOverrideSec)).toEqual([null, null]);
    });

    it("persists every loaded sibling and removes its override on reset to Auto", async () => {
        const log = await directoryLog();
        const first = video("Card/Normal/first.mp4");
        const second = video("Card/Event/second.mp4");
        setCameraTimezoneForRecordings([first], [first, second], log, 10800);
        _resetForTests();
        applyStoredCameraTimezones([second], log);
        expect(second.cameraTimezoneOverrideSec).toBe(10800);

        setCameraTimezoneForRecordings([second], [first, second], log, null);
        expect(first.cameraTimezoneOverrideSec).toBeNull();
        expect(second.cameraTimezoneOverrideSec).toBeNull();
        _resetForTests();
        applyStoredCameraTimezones([first, second], log);
        expect(first.cameraTimezoneOverrideSec).toBeNull();
        expect(second.cameraTimezoneOverrideSec).toBeNull();
    });

    it("remembers recording-copy aliases when either copy is reopened alone", () => {
        const first = video("Card/Normal/first.mp4");
        first.recordingCopies = [file("Backup/Normal/first.mp4", "drop:2")];
        const sibling = video("Backup/Event/later.mp4", "drop:2");
        setCameraTimezoneForRecordings([first], [first, sibling], null, 10800);
        expect(sibling.cameraTimezoneOverrideSec).toBe(10800);
        _resetForTests();
        const reopened = video("Backup/Normal/first.mp4", "drop:9");
        applyStoredCameraTimezones([reopened], null);
        expect(reopened.cameraTimezoneOverrideSec).toBe(10800);
    });

    it("keeps settings and Auto resets usable when browser storage is blocked", () => {
        vi.stubGlobal("localStorage", {
            getItem: () => {
                throw new Error("blocked");
            },
            setItem: () => {
                throw new Error("blocked");
            },
        });
        const first = video("Card/first.mp4");
        const sibling = video("Card/later.mp4");
        setCameraTimezoneForRecordings([first], [first], null, 0);
        applyStoredCameraTimezones([first, sibling], null);
        expect(sibling.cameraTimezoneOverrideSec).toBe(0);
        setCameraTimezoneForRecordings([first], [first, sibling], null, null);
        applyStoredCameraTimezones([first, sibling], null);
        expect(sibling.cameraTimezoneOverrideSec).toBeNull();
    });

    it("ignores corrupt preferences and rejects invalid updates without losing a valid selection", () => {
        storage.set(STORAGE_KEY, '{"broken":true}');
        const first = video("Card/first.mp4");
        applyStoredCameraTimezones([first], null);
        expect(first.cameraTimezoneOverrideSec).toBeNull();
        setCameraTimezoneForRecordings([first], [first], null, 10800);
        setCameraTimezoneForRecordings([first], [first], null, 1);
        expect(first.cameraTimezoneOverrideSec).toBe(10800);
        storage.set(STORAGE_KEY, "[invalid");
        applyStoredCameraTimezones([first], null);
        expect(first.cameraTimezoneOverrideSec).toBe(10800);
    });

    it("rebinds real A500S fixes on a zone change and removes them on Auto without shifting originals", async () => {
        let log = await directoryLog();
        const candidate = video("Card/Normal/Front/NO20261020-162549-000239F.MP4");
        candidate.createdUtc = new Date("2026-10-20T16:26:49Z");
        const originals = [...log.pendingByFilename.values()].flat();
        const rawTimes = originals.map((record) => record.unixSeconds);

        const rebind = () => {
            applyStoredCameraTimezones([candidate], log);
            rederiveStartUtcForCandidates([candidate], classifyFilenameTime, classifyFilenameClockTimelapse);
            log = bindRecordsByTimeRange(log, [candidate]).log;
            attachRecordsToCandidates(log, [candidate], [candidate]);
        };
        rebind();
        expect(candidate.records).toHaveLength(0);
        setCameraTimezoneForRecordings([candidate], [candidate], log, 10800);
        rebind();
        expect(candidate.startUtc).toBe(Date.parse("2026-10-20T13:25:49Z") / 1000);
        expect(candidate.records.length).toBeGreaterThan(0);
        expect(
            candidate.records.every(
                (record) => record.unixSeconds >= candidate.startUtc && record.unixSeconds < candidate.startUtc + 60,
            ),
        ).toBe(true);

        setCameraTimezoneForRecordings([candidate], [candidate], log, null);
        rebind();
        expect(candidate.records).toHaveLength(0);
        expect(candidate.startUtc).toBe(Date.parse("2026-10-20T16:25:49Z") / 1000);
        expect(originals.map((record) => record.unixSeconds)).toEqual(rawTimes);
        expect(originals.every((record) => record.videoKey === undefined)).toBe(true);
    });
});

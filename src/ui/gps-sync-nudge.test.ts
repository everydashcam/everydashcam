import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachRecordsToCandidates } from "../gps-association.js";
import { bindRecordsByTimeRange } from "../gps-time-association.js";
import { mergeIntoGpsLog } from "../parser.js";
import { csv70maiPrimitive } from "../parsers/primitives/csv-70mai.js";
import { groupTrips, type Trip, type VideoCandidate } from "../trips.js";

import { _resetForTests, notifyUnmatchedDirectoryGps } from "./gps-sync-nudge.js";
import { notify } from "./notifications.js";
import { state } from "./state.js";

// Notifications own DOM rendering; the nudge decision and callback stay real.
vi.mock("./notifications.js", () => ({ notify: vi.fn() }));

const fixture = readFileSync(
    new URL("../parsers/__fixtures__/70mai/real-anonymized-a500s.txt", import.meta.url),
    "utf8",
);
const cameraNaive = Date.UTC(2026, 9, 20, 16, 25, 49) / 1000;
const originalState = { trips: state.trips, active: state.active, gpsLog: state.gpsLog };

function candidate(path = "Cards/A/Normal/NO20261020-162549-000239F.MP4", sourceKey = "drop:1"): VideoCandidate {
    return {
        file: new File(["video"], path.split("/").pop()!, { lastModified: 1 }),
        relativePath: path,
        sourceKey,
        fingerprint: "directory-log-camera",
        appliedExtractors: [],
        classifierMatches: { time: null, channel: null, mode: null, sequence: null },
        channel: "front",
        channelConfident: true,
        sequence: null,
        recordingMode: "normal",
        isTimelapse: false,
        startUtc: cameraNaive - 5 * 3600,
        durationSec: 60,
        wallDurationSec: null,
        driftLeadSec: null,
        startSource: "name",
        cameraTzSec: null,
        createdUtc: null,
        records: [],
        codec: "avc",
        codecParam: "avc1",
        videoCodecString: null,
        rotation: 0,
        width: 1920,
        height: 1080,
        fps: 30,
        audio: null,
        canPlay: true,
        metadataReady: true,
        needsHevcRemux: false,
        isTransportStream: false,
        isMatroska: false,
        audioNeedsTranscode: false,
        embeddedStartUtcHint: null,
        localClockOffsetHintSec: null,
    };
}

function makeTrip(video = candidate()): Trip {
    return groupTrips([video])[0]!;
}

async function loadLog(text = fixture, root = "Cards/A", sourceKey = "drop:1"): Promise<void> {
    const parsed = await csv70maiPrimitive.parse({
        file: new File([text], "GPSData000001.txt"),
        relativePath: `${root}/GPSData000001.txt`,
        sourceKey,
    });
    state.gpsLog = mergeIntoGpsLog(state.gpsLog, { ...parsed, appliedExtractors: ["csv-70mai"] });
}

beforeEach(() => {
    _resetForTests();
    vi.mocked(notify).mockClear();
    state.trips = [];
    state.active = null;
    state.gpsLog = null;
});

afterEach(() => Object.assign(state, originalState));

describe("unmatched directory GPS notice", () => {
    it("offers sync when another permitted zone places valid fixes in the clip", async () => {
        await loadLog();
        const trip = makeTrip();
        state.trips = [trip];
        state.active = { trip: 0, frame: 0 };
        const openSync = vi.fn();

        notifyUnmatchedDirectoryGps(trip, openSync);

        expect(notify).toHaveBeenCalledWith(
            expect.objectContaining({
                messageKey: "gpsSync.timezone.unmatchedNotification",
                actionKey: "gpsSync.open",
                severity: "info",
            }),
        );
        vi.mocked(notify).mock.calls[0]![0].onAction?.();
        expect(openSync).toHaveBeenCalledOnce();
    });

    it("stays quiet for missing, other-folder, other-source, and unrelated-day tracks", async () => {
        const trip = makeTrip();
        notifyUnmatchedDirectoryGps(trip, vi.fn());
        await loadLog();
        notifyUnmatchedDirectoryGps(makeTrip(candidate("Cards/B/NO20261020-162549-000239F.MP4")), vi.fn());
        notifyUnmatchedDirectoryGps(makeTrip(candidate(undefined, "drop:2")), vi.fn());
        notifyUnmatchedDirectoryGps(makeTrip(candidate("Cards/A/NO20261025-162549-000239F.MP4")), vi.fn());
        expect(notify).not.toHaveBeenCalled();
    });

    it("stays quiet for no-fix-only and zero-coordinate logs", async () => {
        await loadLog(fixture.replaceAll(",A,", ",V,"));
        notifyUnmatchedDirectoryGps(makeTrip(), vi.fn());
        expect(notify).not.toHaveBeenCalled();

        state.gpsLog = null;
        const zeroCoords = fixture
            .split("\n")
            .map((line) => {
                const fields = line.split(",");
                if (fields.length === 13) {
                    fields[2] = "0";
                    fields[3] = "0";
                }
                return fields.join(",");
            })
            .join("\n");
        await loadLog(zeroCoords);
        notifyUnmatchedDirectoryGps(makeTrip(), vi.fn());
        expect(notify).not.toHaveBeenCalled();
    });

    it("requires two distinct fixes and completed recording metadata", async () => {
        const firstRow = fixture.split("\n").find((line) => line.includes(",A,"))!;
        await loadLog(`$V02\n${firstRow}\n${firstRow}\n`);
        notifyUnmatchedDirectoryGps(makeTrip(), vi.fn());
        expect(notify).not.toHaveBeenCalled();

        state.gpsLog = null;
        await loadLog();
        const pending = candidate();
        pending.metadataReady = false;
        notifyUnmatchedDirectoryGps(makeTrip(pending), vi.fn());
        const failed = candidate();
        failed.metadataFailed = true;
        notifyUnmatchedDirectoryGps(makeTrip(failed), vi.fn());
        expect(notify).not.toHaveBeenCalled();
    });

    it("stays quiet when this trip or another trip in the same folder already has GPS", async () => {
        await loadLog();
        const matched = candidate();
        matched.startUtc = cameraNaive - 3 * 3600;
        const bound = bindRecordsByTimeRange(state.gpsLog!, [matched]);
        state.gpsLog = bound.log;
        attachRecordsToCandidates(bound.log, [matched], [matched]);
        expect(matched.records.length).toBeGreaterThan(1);
        const matchedTrip = makeTrip(matched);
        const unmatchedTrip = makeTrip(candidate("Cards/A/Event/NO20261020-162549-000240F.MP4"));
        state.trips = [matchedTrip, unmatchedTrip];

        notifyUnmatchedDirectoryGps(matchedTrip, vi.fn());
        notifyUnmatchedDirectoryGps(unmatchedTrip, vi.fn());
        expect(notify).not.toHaveBeenCalled();
    });

    it("does not repeat for sibling trips or a rebuilt log, and allows a fresh drop", async () => {
        await loadLog();
        const first = makeTrip();
        const sibling = makeTrip(candidate("Cards/A/Event/NO20261020-162549-000240F.MP4"));
        const openSync = vi.fn();
        notifyUnmatchedDirectoryGps(first, openSync);
        await loadLog();
        notifyUnmatchedDirectoryGps(sibling, openSync);
        expect(notify).toHaveBeenCalledOnce();

        state.gpsLog = null;
        await loadLog(fixture, "Cards/A", "drop:2");
        notifyUnmatchedDirectoryGps(makeTrip(candidate(undefined, "drop:2")), openSync);
        expect(notify).toHaveBeenCalledTimes(2);
    });

    it("keeps each action with its original folder even after another folder is notified", async () => {
        await loadLog();
        await loadLog(fixture, "Cards/B");
        const first = makeTrip();
        const sibling = makeTrip(candidate("Cards/A/Event/NO20261020-162549-000240F.MP4"));
        const other = makeTrip(candidate("Cards/B/NO20261020-162549-000239F.MP4"));
        state.trips = [first, sibling, other];
        state.active = { trip: 0, frame: 0 };
        const openSync = vi.fn();
        notifyUnmatchedDirectoryGps(first, openSync);
        const firstNotice = vi.mocked(notify).mock.calls[0]![0];
        notifyUnmatchedDirectoryGps(other, openSync);
        const otherNotice = vi.mocked(notify).mock.calls[1]![0];
        expect(firstNotice.dedupKey).not.toBe(otherNotice.dedupKey);

        state.active = { trip: 2, frame: 0 };
        firstNotice.onAction?.();
        expect(openSync).not.toHaveBeenCalled();
        state.active = { trip: 1, frame: 0 };
        firstNotice.onAction?.();
        expect(openSync).toHaveBeenCalledOnce();
    });
});

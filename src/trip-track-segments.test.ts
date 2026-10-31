import { describe, expect, it } from "vitest";
import { isSameTrackSegment } from "./gps-telemetry.js";
import type { Channel, GpsRecord } from "./parsers/types.js";
import { normalizeTripTrackSegments, type TripGpsSource } from "./trip-track-segments.js";

function record(seconds: number, trackSegment?: number): GpsRecord {
    return {
        unixSeconds: 1000 + seconds,
        active: true,
        lat: 50 + seconds * 0.0001,
        lon: 30,
        bearingDeg: 0,
        speedMs: 11,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename: "clip.mp4",
        ...(trackSegment === undefined ? {} : { trackSegment }),
    };
}

function source(records: GpsRecord[], channel: Channel = "front", startSeconds = 0, endSeconds = 10): TripGpsSource {
    return { records, channel, startUtc: 1000 + startSeconds, endUtc: 1000 + endSeconds };
}

describe("normalizeTripTrackSegments", () => {
    it("does not join a gap across log collections with equal segment counters", () => {
        const input = source([
            { ...record(0, 0), trackSegmentSource: "first.dat" },
            { ...record(1, 0), trackSegmentSource: "first.dat" },
            { ...record(9, 0), trackSegmentSource: "second.dat" },
            { ...record(10, 0), trackSegmentSource: "second.dat" },
        ]);
        const [records] = normalizeTripTrackSegments([input]);
        expect(records!.map((value) => value.trackSegment)).toEqual([0, 0, 1, 1]);
        expect(input.records.map((value) => value.trackSegmentSource)).toEqual([
            "first.dat",
            "first.dat",
            "second.dat",
            "second.dat",
        ]);
    });

    it("keeps explicit segments within one source disconnected", () => {
        const input = source([record(0, 7), record(1, 7), record(2, 8), record(3, 8)]);
        const [records] = normalizeTripTrackSegments([input]);
        expect(isSameTrackSegment(records![0]!, records![1]!), "first source segment stays connected").toBe(true);
        expect(isSameTrackSegment(records![2]!, records![3]!), "second source segment stays connected").toBe(true);
        expect(isSameTrackSegment(records![1]!, records![2]!), "explicit cut survives normalization").toBe(false);
    });

    it.each([0, 1])("preserves daily log continuity across adjacent clips with next counter %s", (nextSegment) => {
        const first = source(
            [record(0, 0), record(9, 0)].map((value) => ({ ...value, trackSegmentSource: "20240112.dat" })),
            "front",
            0,
            10,
        );
        const second = source(
            [record(10, nextSegment), record(19, nextSegment)].map((value) => ({
                ...value,
                trackSegmentSource: "20240112.dat",
            })),
            "front",
            10,
            20,
        );
        const [firstRecords, secondRecords] = normalizeTripTrackSegments([first, second]);
        expect(
            isSameTrackSegment(firstRecords![1]!, secondRecords![0]!),
            "a video boundary cannot erase a restart in their shared log",
        ).toBe(nextSegment === 0);
    });

    it("uses a continuous second channel to cover a first channel's gap", () => {
        const front = source([record(0, 0), record(1, 0), record(2, 1), record(3, 1)]);
        const rear = source([record(0.5, 0), record(2.5, 0)], "rear");
        const [frontRecords, rearRecords] = normalizeTripTrackSegments([front, rear]);
        for (const value of [...frontRecords!, ...rearRecords!]) {
            expect(isSameTrackSegment(frontRecords![0]!, value), "the second channel supplies continuity").toBe(true);
        }
    });

    it("does not use a channel without valid fixes to reconnect another channel's gap", () => {
        const front = source([record(0, 0), record(1, 0), record(9, 1), record(10, 1)]);
        const rear = source(
            [0, 10].map((seconds) => ({ ...record(seconds), active: false })),
            "rear",
        );
        const [frontRecords, rearRecords] = normalizeTripTrackSegments([front, rear]);
        expect(isSameTrackSegment(frontRecords![1]!, frontRecords![2]!), "inactive samples supply no coverage").toBe(
            false,
        );
        expect(isSameTrackSegment(frontRecords![0]!, rearRecords![0]!), "a no-fix source remains separate").toBe(false);
    });

    it("keeps an interior fix loss from connecting separated spans through another channel", () => {
        const front = source([record(0, 0), record(1, 0), record(9, 1), record(10, 1)]);
        const rear = source(
            [record(0, 0), record(1, 0), { ...record(5, 0), active: false }, record(9, 0), record(10, 0)],
            "rear",
        );
        const [frontRecords, rearRecords] = normalizeTripTrackSegments([front, rear]);
        expect(isSameTrackSegment(frontRecords![0]!, rearRecords![0]!), "valid spans before the loss overlap").toBe(
            true,
        );
        expect(isSameTrackSegment(frontRecords![3]!, rearRecords![4]!), "valid spans after the loss overlap").toBe(
            true,
        );
        expect(
            isSameTrackSegment(frontRecords![1]!, frontRecords![2]!),
            "the rear fix loss cannot transitively erase the front cut",
        ).toBe(false);
        expect(
            isSameTrackSegment(rearRecords![1]!, rearRecords![3]!),
            "a source segment does not imply continuity through no-fix samples",
        ).toBe(false);
    });

    it("preserves overlapping source cuts when one external track is copied to multiple videos", () => {
        const original = [record(0, 7), record(1, 8), record(2, 7), record(3, 8)].map((value) => ({
            ...value,
            externalTrack: true,
            externalTrackKey: "route.gpx",
        }));
        const copied = original.map((value) => ({ ...value, mp4Filename: "rear.mp4", videoKey: "rear" }));
        const [frontRecords, rearRecords] = normalizeTripTrackSegments([source(original), source(copied, "rear")]);
        expect(
            isSameTrackSegment(frontRecords![0]!, frontRecords![1]!),
            "copies are not independent continuity evidence",
        ).toBe(false);
        expect(
            isSameTrackSegment(frontRecords![0]!, rearRecords![0]!),
            "copies retain their shared source identity",
        ).toBe(true);
        expect(
            isSameTrackSegment(frontRecords![1]!, rearRecords![1]!),
            "copies agree on the second source segment",
        ).toBe(true);
    });

    it("preserves overlapping restart spans copied from one daily log to event clips", () => {
        const original = [record(5, 0), record(6, 1), record(8, 0), record(9, 1)].map((value) => ({
            ...value,
            trackSegmentSource: "20240112.dat",
        }));
        const copied = original.map((value) => ({ ...value, mp4Filename: "event.mp4", videoKey: "event" }));
        const [loopRecords, eventRecords] = normalizeTripTrackSegments([
            source(original, "front", 0, 10),
            source(copied, "front", 5, 15),
        ]);
        expect(
            isSameTrackSegment(loopRecords![0]!, loopRecords![1]!),
            "a protected copy cannot bridge a restart with an overlapping clock range",
        ).toBe(false);
        for (let i = 0; i < original.length; i++) {
            expect(
                isSameTrackSegment(loopRecords![i]!, eventRecords![i]!),
                "copies of the same daily segment retain continuity",
            ).toBe(true);
        }
    });

    it("attaches a daily log singleton to its matching restart span", () => {
        const original = [record(5, 0), record(6, 1), record(8, 0), record(9, 1)].map((value) => ({
            ...value,
            trackSegmentSource: "20240112.dat",
        }));
        const copied = [{ ...original[1]!, mp4Filename: "event.mp4", videoKey: "event" }];
        const [loopRecords, eventRecords] = normalizeTripTrackSegments([
            source(original, "front", 0, 20),
            source(copied, "front", 5, 15),
        ]);
        expect(isSameTrackSegment(loopRecords![0]!, eventRecords![0]!)).toBe(false);
        expect(
            isSameTrackSegment(loopRecords![1]!, eventRecords![0]!),
            "the first overlapping span from another restart does not hide the matching one",
        ).toBe(true);
    });

    it.each([
        [4, false],
        [5, true],
    ])("joins adjacent clips only when the last fix at +%s is near the boundary", (lastFix, connected) => {
        const first = source([record(0, 0), record(lastFix, 0)], "front", 0, 10);
        const second = source([record(10, 0), record(11, 0)], "front", 10, 20);
        const [firstRecords, secondRecords] = normalizeTripTrackSegments([first, second]);
        expect(isSameTrackSegment(firstRecords![1]!, secondRecords![0]!)).toBe(connected);
    });

    it.each(["terminal", "initial"])(
        "does not use an inactive %s sample to prove file rollover continuity",
        (endpoint) => {
            const first = source(
                [record(0, 0), record(8, 0), { ...record(9, 0), active: endpoint !== "terminal" }],
                "front",
                0,
                10,
            );
            const second = source(
                [{ ...record(10, 0), active: endpoint !== "initial" }, record(11, 0), record(12, 0)],
                "front",
                10,
                20,
            );
            const [firstRecords, secondRecords] = normalizeTripTrackSegments([first, second]);
            expect(
                isSameTrackSegment(firstRecords![1]!, secondRecords![1]!),
                "nearby valid fixes do not erase an explicit fix loss at rollover",
            ).toBe(false);
        },
    );

    it("keeps a file rollover connected when a shorter event copy overlaps the preceding clip", () => {
        const first = source([record(0, 0), record(59, 0)], "front", 0, 60);
        const eventCopy = source([record(10, 0), record(19, 0)], "front", 10, 20);
        const next = source([record(60, 0), record(119, 0)], "front", 60, 120);
        const [firstRecords, eventRecords, nextRecords] = normalizeTripTrackSegments([first, eventCopy, next]);
        expect(isSameTrackSegment(firstRecords![0]!, eventRecords![0]!), "the event copy overlaps its original").toBe(
            true,
        );
        expect(
            isSameTrackSegment(firstRecords![1]!, nextRecords![0]!),
            "the longest preceding clip defines the rollover",
        ).toBe(true);
    });

    it("does not let a singleton reconnect two explicit segments touching at its timestamp", () => {
        const front = source([record(0, 0), record(1, 0), record(1, 1), record(2, 1)]);
        const rear = source([record(1, 0)], "rear");
        const [frontRecords, rearRecords] = normalizeTripTrackSegments([front, rear]);
        expect(
            isSameTrackSegment(frontRecords![0]!, frontRecords![3]!),
            "a point supplies no interval across the cut",
        ).toBe(false);
        const connections = [frontRecords![0]!, frontRecords![3]!].filter((value) =>
            isSameTrackSegment(value, rearRecords![0]!),
        );
        expect(connections, "the singleton attaches to only one covered component").toHaveLength(1);
    });

    it("does not confuse independent record arrays with equal video filenames", () => {
        const first = source([record(0, 0), record(1, 0)]);
        const second = source([record(9, 0), record(10, 0)], "rear");
        const [firstRecords, secondRecords] = normalizeTripTrackSegments([first, second]);
        expect(isSameTrackSegment(firstRecords![0]!, firstRecords![1]!)).toBe(true);
        expect(
            isSameTrackSegment(firstRecords![1]!, secondRecords![0]!),
            "file-local segment numbers are independent",
        ).toBe(false);
    });

    it("preserves legacy records without introducing segment boundaries", () => {
        const first = source([record(0), record(1)]);
        const second = source([record(9), record(10)], "rear");
        const snapshots = [first.records.map((value) => ({ ...value })), second.records.map((value) => ({ ...value }))];
        const normalized = normalizeTripTrackSegments([first, second]);
        expect(normalized).toEqual(snapshots);
        expect(isSameTrackSegment(normalized[0]![1]!, normalized[1]![0]!), "legacy continuity stays unchanged").toBe(
            true,
        );
        for (const value of normalized.flat()) expect(value).not.toHaveProperty("trackSegment");
    });
});

import { describe, expect, it } from "vitest";
import type { Trip } from "../trips.js";
import {
    PARKING_RUN_MAX_GAP_SEC,
    dayStripSegments,
    foldParkingRuns,
    groupByMonthDay,
    type TripListNode,
} from "./trip-list-layout.js";

interface TripFacts {
    start: number;
    end?: number;
    tz?: number | null;
    parking?: boolean;
    events?: number[];
}

/** A Trip carrying only the fields the layout reads. */
function trip({ start, end = start + 60, tz = 0, parking = false, events = [] }: TripFacts): Trip {
    return {
        startUtc: start,
        endUtc: end,
        cameraTzSec: tz,
        isParking: parking,
        events: events.map((unixSeconds) => ({ kind: "brake", unixSeconds, relSec: 0, severity: 1, recordIndex: 0 })),
    } as unknown as Trip;
}

const at = (month: number, day: number, hour: number, minute = 0): number =>
    Date.UTC(2026, month, day, hour, minute) / 1000;

const nodes = (trips: Trip[]): TripListNode[] =>
    trips.map((t, tripIdx) => ({ kind: "trip", entry: { trip: t, tripIdx } }));

describe("groupByMonthDay", () => {
    it("splits list order into months and days with stable keys", () => {
        const months = groupByMonthDay(
            nodes([trip({ start: at(10, 1, 9) }), trip({ start: at(9, 31, 21) }), trip({ start: at(9, 31, 8) })]),
        );
        expect(months.map((m) => m.key)).toEqual(["m:2026-11", "m:2026-10"]);
        expect(months[1]!.days.map((d) => d.key)).toEqual(["d:2026-10-31"]);
        expect(months[1]!.days[0]!.nodes.map((n) => (n.kind === "trip" ? n.entry.tripIdx : -1))).toEqual([1, 2]);
    });

    it("assigns a trip to its camera-clock day", () => {
        // 23:00 UTC is already the next day on a +2 h camera clock.
        const [month] = groupByMonthDay(nodes([trip({ start: at(5, 14, 23), tz: 7200 })]));
        expect(month!.days[0]!.key).toBe("d:2026-06-15");
    });

    it("merges a day that cameras in different zones interleave by instant", () => {
        const months = groupByMonthDay(
            nodes([
                trip({ start: at(5, 15, 10), tz: 0 }),
                trip({ start: at(5, 15, 9), tz: 15 * 3600 }), // Jun 16 on this camera
                trip({ start: at(5, 15, 8), tz: 0 }),
            ]),
        );
        expect(months[0]!.days.map((d) => [d.key, d.nodes.length])).toEqual([
            ["d:2026-06-15", 2],
            ["d:2026-06-16", 1],
        ]);
    });
});

describe("dayStripSegments", () => {
    it("places footage and events as fractions of the day", () => {
        const [month] = groupByMonthDay(
            nodes([trip({ start: at(5, 15, 6), end: at(5, 15, 12), events: [at(5, 15, 9)] })]),
        );
        const { segments, events } = dayStripSegments(month!.days[0]!);
        expect(segments).toHaveLength(1);
        expect(segments[0]!.from).toBeCloseTo(0.25);
        expect(segments[0]!.to).toBeCloseTo(0.5);
        expect(segments[0]!.isParking).toBe(false);
        expect(events).toHaveLength(1);
        expect(events[0]).toBeCloseTo(0.375);
    });

    it("clips a trip that runs past midnight and drops events on the next day", () => {
        const [month] = groupByMonthDay(
            nodes([trip({ start: at(5, 15, 22), end: at(5, 16, 2), parking: true, events: [at(5, 16, 1)] })]),
        );
        const { segments, events } = dayStripSegments(month!.days[0]!);
        expect(segments[0]!.from).toBeCloseTo(22 / 24);
        expect(segments[0]!.to).toBe(1);
        expect(segments[0]!.isParking).toBe(true);
        expect(events).toEqual([]);
    });
});

const entries = (trips: Trip[]) => trips.map((t, tripIdx) => ({ trip: t, tripIdx }));
const identity = (t: Trip): string => `id${t.startUtc}`;

describe("foldParkingRuns", () => {
    it("folds neighbouring parking trips and keeps drives and lone parking trips as trips", () => {
        const folded = foldParkingRuns(
            entries([
                trip({ start: at(10, 1, 9) }),
                trip({ start: at(10, 1, 6), parking: true }),
                trip({ start: at(10, 1, 3), parking: true }),
                trip({ start: at(9, 31, 23), parking: true }),
                trip({ start: at(9, 31, 18) }),
                trip({ start: at(9, 31, 12), parking: true }),
                trip({ start: at(9, 31, 8) }),
            ]),
            identity,
        );
        expect(folded.map((node) => node.kind)).toEqual(["trip", "parking", "trip", "trip", "trip"]);
        const run = folded[1]!;
        expect(run.kind === "parking" && run.entries.map((e) => e.tripIdx)).toEqual([1, 2, 3]);
        // The key follows the earliest trip, whichever end of the run it is on.
        expect(run.kind === "parking" && run.key).toBe(`p:id${at(9, 31, 23)}`);
    });

    it("splits a run at a pause longer than the limit", () => {
        const first = at(9, 30, 22);
        const folded = foldParkingRuns(
            entries([
                trip({ start: first, parking: true }),
                trip({ start: first + 3600, parking: true }),
                trip({ start: first + 3600 + 60 + PARKING_RUN_MAX_GAP_SEC + 1, parking: true }),
            ]),
            identity,
        );
        expect(folded.map((node) => node.kind)).toEqual(["parking", "trip"]);
    });

    it("puts a run that crosses midnight on the day it began", () => {
        const months = groupByMonthDay(
            foldParkingRuns(
                entries([trip({ start: at(10, 1, 5), parking: true }), trip({ start: at(9, 31, 23), parking: true })]),
                identity,
            ),
        );
        expect(months.map((m) => m.days.map((d) => d.key))).toEqual([["d:2026-10-31"]]);
    });
});

describe("dayStripSegments with a parking run", () => {
    it("draws the run as one span from its first start to its last end", () => {
        const months = groupByMonthDay(
            foldParkingRuns(
                entries([
                    trip({ start: at(5, 15, 20), parking: true }),
                    trip({ start: at(5, 15, 14), end: at(5, 15, 14, 1), parking: true }),
                ]),
                identity,
            ),
        );
        const { segments } = dayStripSegments(months[0]!.days[0]!);
        expect(segments).toHaveLength(1);
        expect(segments[0]!.from).toBeCloseTo(14 / 24);
        expect(segments[0]!.to).toBeCloseTo((20 * 60 + 1) / 1440);
        expect(segments[0]!.isParking).toBe(true);
    });
});

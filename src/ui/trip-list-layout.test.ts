import { describe, expect, it } from "vitest";
import type { Trip } from "../trips.js";
import {
    PARKING_RUN_MAX_GAP_SEC,
    foldParkingRuns,
    groupByMonthDay,
    nodeEntries,
    tripDayKey,
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

    it.each(["asc", "desc"])("keeps stays separate when the drive between them is hidden in %s order", (dir) => {
        const chronology = entries([
            trip({ start: at(9, 31, 9), parking: true }),
            trip({ start: at(9, 31, 9, 30), parking: true }),
            trip({ start: at(9, 31, 10) }),
            trip({ start: at(9, 31, 11), parking: true }),
            trip({ start: at(9, 31, 11, 30), parking: true }),
        ]);
        if (dir === "desc") chronology.reverse();
        const folded = foldParkingRuns(chronology, identity, new Set([0, 1, 3, 4]));
        expect(folded.map((node) => node.kind)).toEqual(["parking", "parking"]);
        expect(folded.map((node) => nodeEntries(node).map((entry) => entry.tripIdx))).toEqual(
            dir === "asc"
                ? [
                      [0, 1],
                      [3, 4],
                  ]
                : [
                      [4, 3],
                      [1, 0],
                  ],
        );
    });

    it("keeps a stay's identity when its earliest trip is hidden and unfolds a lone match", () => {
        const chronology = entries([
            trip({ start: at(9, 31, 23), parking: true }),
            trip({ start: at(10, 1, 1), parking: true }),
            trip({ start: at(10, 1, 3), parking: true }),
        ]);
        const full = foldParkingRuns(chronology, identity);
        const filtered = foldParkingRuns(chronology, identity, new Set([1, 2]));
        expect(filtered[0]).toEqual({ ...full[0], entries: chronology.slice(1) });
        expect(foldParkingRuns(chronology, identity, new Set([1]))).toEqual([{ kind: "trip", entry: chronology[1] }]);
        expect(foldParkingRuns(chronology, identity, new Set())).toEqual([]);
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

describe("tripDayKey", () => {
    it("keeps each trip's camera-clock date inside an overnight stay", () => {
        const night = entries([
            trip({ start: at(9, 31, 21), tz: 7200, parking: true }),
            trip({ start: at(9, 31, 23), tz: 7200, parking: true }),
        ]);
        const [month] = groupByMonthDay(foldParkingRuns(night, identity));
        const heading = month!.days[0]!.key;
        expect(heading).toBe("d:2026-10-31");
        expect(night.map(({ trip }) => tripDayKey(trip))).toEqual([heading, "d:2026-11-01"]);
    });
});

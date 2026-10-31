import { describe, expect, it } from "vitest";
import type { Trip } from "../trips.js";
import { dayStripSegments, groupByMonthDay, type TripListNode } from "./trip-list-layout.js";

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
        expect(months[1]!.days[0]!.nodes.map((n) => n.entry.tripIdx)).toEqual([1, 2]);
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

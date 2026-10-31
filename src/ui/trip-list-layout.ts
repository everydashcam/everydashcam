// Display structure of the date-sorted trip list: month and day sections on the
// display clock (camera clock when known). Pure - no DOM, no app state - so the
// grouping rules stay unit-testable apart from the sidebar that renders them.

import { displayClockDate } from "../trips.js";
import type { Trip } from "../trips.js";

/** One displayed trip together with its index in state.trips. */
export interface TripListEntry {
    readonly trip: Trip;
    /** The list renders and dispatches actions by this index. */
    readonly tripIdx: number;
}

export interface TripListTripNode {
    readonly kind: "trip";
    readonly entry: TripListEntry;
}

export type TripListNode = TripListTripNode;

/** One calendar day on the display clock, in list order. */
export interface TripListDay {
    /** "d:YYYY-MM-DD"; stable across re-renders, used for the collapsed state. */
    readonly key: string;
    readonly year: number;
    /** 0-based, like Date. */
    readonly month: number;
    readonly day: number;
    /** The day's midnight on the display clock, in the frame displayClockDate returns. */
    readonly startSec: number;
    readonly nodes: TripListNode[];
}

/** One calendar month on the display clock, in list order. */
export interface TripListMonth {
    /** "m:YYYY-MM"; stable across re-renders, used for the collapsed state. */
    readonly key: string;
    readonly year: number;
    readonly month: number;
    readonly days: TripListDay[];
}

/** Every trip a node stands for, in list order. */
export function nodeEntries(node: TripListNode): readonly TripListEntry[] {
    return [node.entry];
}

/** The node's earliest start: a run of trips belongs to the day it began. */
function nodeStartTrip(node: TripListNode): Trip {
    let earliest = node.entry.trip;
    for (const entry of nodeEntries(node)) if (entry.trip.startUtc < earliest.startUtc) earliest = entry.trip;
    return earliest;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * Splits list-ordered nodes into months and days by the display-clock date of
 * each node's start. Sections appear in the order their first node does and
 * nodes keep their relative order inside a section. A library from cameras in
 * different zones can interleave calendar days by instant; merging those into
 * one section is what keeps a day from showing up twice.
 */
export function groupByMonthDay(nodes: readonly TripListNode[]): TripListMonth[] {
    const months: TripListMonth[] = [];
    const monthsByKey = new Map<string, TripListMonth>();
    const daysByKey = new Map<string, TripListDay>();
    for (const node of nodes) {
        const start = nodeStartTrip(node);
        const date = displayClockDate(start.startUtc, start.cameraTzSec);
        const year = date.getUTCFullYear();
        const month = date.getUTCMonth();
        const day = date.getUTCDate();
        const monthKey = `m:${year}-${pad2(month + 1)}`;
        let monthGroup = monthsByKey.get(monthKey);
        if (!monthGroup) {
            monthGroup = { key: monthKey, year, month, days: [] };
            monthsByKey.set(monthKey, monthGroup);
            months.push(monthGroup);
        }
        const dayKey = `d:${year}-${pad2(month + 1)}-${pad2(day)}`;
        let dayGroup = daysByKey.get(dayKey);
        if (!dayGroup) {
            dayGroup = { key: dayKey, year, month, day, startSec: Date.UTC(year, month, day) / 1000, nodes: [] };
            daysByKey.set(dayKey, dayGroup);
            monthGroup.days.push(dayGroup);
        }
        dayGroup.nodes.push(node);
    }
    return months;
}

/** A segment of the 24-hour day strip, as fractions of the day in [0, 1]. */
export interface DayStripSegment {
    readonly from: number;
    readonly to: number;
    readonly isParking: boolean;
}

const DAY_SEC = 86_400;

/** Projects an instant onto the day as a fraction; values outside [0, 1] fall on other days. */
function dayFraction(unixSec: number, trip: Trip, day: TripListDay): number {
    return (displayClockDate(unixSec, trip.cameraTzSec).getTime() / 1000 - day.startSec) / DAY_SEC;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Footage and event positions for a day's 24-hour strip. A trip that runs past
 * midnight is clipped to the day; event instants outside the day are dropped.
 */
export function dayStripSegments(day: TripListDay): { segments: DayStripSegment[]; events: number[] } {
    const segments: DayStripSegment[] = [];
    const events: number[] = [];
    for (const node of day.nodes) {
        for (const { trip } of nodeEntries(node)) {
            const from = clamp01(dayFraction(trip.startUtc, trip, day));
            const to = clamp01(dayFraction(trip.endUtc, trip, day));
            if (to > from || (to === from && from > 0 && from < 1)) {
                segments.push({ from, to, isParking: trip.isParking });
            }
            for (const event of trip.events) {
                const at = dayFraction(event.unixSeconds, trip, day);
                if (at >= 0 && at <= 1) events.push(at);
            }
        }
    }
    return { segments, events };
}

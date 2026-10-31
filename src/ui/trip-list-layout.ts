// Display structure of the date-sorted trip list: month and day sections on the
// display clock (camera clock when known) and runs of parking trips folded into
// one row. Pure - no DOM, no app state - so the grouping rules stay
// unit-testable apart from the sidebar that renders them.

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

/**
 * Consecutive parking trips shown as one expandable row. Display only: each
 * trip stays a trip for playback, export and notes.
 */
export interface TripListParkingNode {
    readonly kind: "parking";
    /** "p:" plus the earliest trip's identity, so it survives re-renders. */
    readonly key: string;
    /** Two or more parking trips in list order. */
    readonly entries: readonly TripListEntry[];
}

export type TripListNode = TripListTripNode | TripListParkingNode;

/**
 * Longest pause between two parking trips that still reads as one stay.
 * Motion-triggered cameras can stay silent through a quiet night, so the gap
 * between clips easily reaches eight hours; half a day without a recording
 * more likely means the car left without the camera recording the drive.
 */
export const PARKING_RUN_MAX_GAP_SEC = 12 * 3600;

/** One calendar day on the display clock, in list order. */
export interface TripListDay {
    /** "d:YYYY-MM-DD"; stable across re-renders, used for the collapsed state. */
    readonly key: string;
    readonly year: number;
    /** 0-based, like Date. */
    readonly month: number;
    readonly day: number;
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
    return node.kind === "trip" ? [node.entry] : node.entries;
}

function earliestEntry(entries: readonly TripListEntry[]): TripListEntry {
    let earliest = entries[0]!;
    for (const entry of entries) if (entry.trip.startUtc < earliest.trip.startUtc) earliest = entry;
    return earliest;
}

/** The node's earliest start: a run of trips belongs to the day it began. */
function nodeStartTrip(node: TripListNode): Trip {
    return earliestEntry(nodeEntries(node)).trip;
}

/** Pause between two trips regardless of list direction; overlap counts as none. */
function pauseSec(a: Trip, b: Trip): number {
    const [earlier, later] = a.startUtc <= b.startUtc ? [a, b] : [b, a];
    return Math.max(0, later.startUtc - earlier.endUtc);
}

/**
 * Folds runs of parking trips that are neighbours in list order - no other
 * trip between them, pauses up to PARKING_RUN_MAX_GAP_SEC - into parking
 * nodes. A lone parking trip stays a trip node. `identity` returns a trip's
 * recording identity, which keys the run for its expanded state.
 */
export function foldParkingRuns(entries: readonly TripListEntry[], identity: (trip: Trip) => string): TripListNode[] {
    const nodes: TripListNode[] = [];
    let run: TripListEntry[] = [];
    const flushRun = (): void => {
        if (run.length >= 2) {
            nodes.push({ kind: "parking", key: `p:${identity(earliestEntry(run).trip)}`, entries: run });
        } else {
            for (const entry of run) nodes.push({ kind: "trip", entry });
        }
        run = [];
    };
    for (const entry of entries) {
        const previous = run[run.length - 1];
        if (!entry.trip.isParking || (previous && pauseSec(previous.trip, entry.trip) > PARKING_RUN_MAX_GAP_SEC)) {
            flushRun();
        }
        if (entry.trip.isParking) run.push(entry);
        else nodes.push({ kind: "trip", entry });
    }
    flushRun();
    return nodes;
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
            dayGroup = { key: dayKey, year, month, day, nodes: [] };
            daysByKey.set(dayKey, dayGroup);
            monthGroup.days.push(dayGroup);
        }
        dayGroup.nodes.push(node);
    }
    return months;
}

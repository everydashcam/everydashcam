// "Read now" on the map of all trips. A GPS track that lives inside a video is
// read only when its trip opens; this reads those tracks for the trips the
// list shows, one trip at a time, through the loader a trip open uses. Each
// read can regroup the trips, so the queue holds recording keys, never trip
// indices. No DOM: the map's counter shows the progress.

import { createLogger } from "../log.js";
import { createSubscribers } from "../subscribers.js";
import { tripAllCandidates, type Trip } from "../trips.js";
import { vendorFileKey } from "../vendor-file-key.js";
import { state } from "./state.js";
import { tripMapEntries } from "./trip-map-library.js";
import { tripMapScope } from "./trip-map-search.js";

const log = createLogger("trip-map-read");

/** Reads the pending GPS of one trip; "busy" while another read owns the storage. */
export type TripGpsReader = (
    tripIndex: number,
    signal: AbortSignal,
) => Promise<"ready" | "cancelled" | "failed" | "busy">;

/** Trips in the scope without a route, by why they have none. */
export interface UntrackedTrips {
    withoutGps: number;
    unread: number;
}

export interface TrackReadProgress {
    done: number;
    total: number;
}

interface ReadRun extends TrackReadProgress {
    controller: AbortController;
}

let run: ReadRun | null = null;
const listeners = createSubscribers<[]>("trip-map-read");

/** Keys of the trip's recordings whose GPS track still waits inside the video. */
function unreadKeys(trip: Trip): string[] {
    const keys: string[] = [];
    for (const candidate of tripAllCandidates(trip)) {
        const key = vendorFileKey(candidate);
        // A failed read stays pending for a retry from the trip itself;
        // reading it again from here would only fail the same way.
        if (state.pendingHeavyEmbeddedGps.has(key) && !state.failedEmbeddedGps.has(key)) keys.push(key);
    }
    return keys;
}

function isBeingRead(trip: Trip): boolean {
    return tripAllCandidates(trip).some((candidate) => state.inflightEmbeddedGps.has(vendorFileKey(candidate)));
}

function hasRoute(tripIndex: number): boolean {
    return Boolean(tripMapEntries()[tripIndex]?.track);
}

/** Splits the scope's trips without a route into those with an unread track and the rest. */
export function untrackedTrips(): UntrackedTrips {
    const counts: UntrackedTrips = { withoutGps: 0, unread: 0 };
    for (const index of tripMapScope()) {
        const trip = state.trips[index];
        if (!trip || hasRoute(index)) continue;
        if (unreadKeys(trip).length > 0 || isBeingRead(trip)) counts.unread++;
        else counts.withoutGps++;
    }
    return counts;
}

/** How far the current reading got; null when nothing is being read. */
export function trackReadProgress(): TrackReadProgress | null {
    return run ? { done: run.done, total: run.total } : null;
}

/** Fires when a reading starts, advances or ends. */
export function subscribeTrackRead(listener: () => void): () => void {
    return listeners.subscribe(listener);
}

/**
 * Reads the unread tracks of the scope's trips in list order. A trip open or a
 * new folder stops the reading: the opened trip gets the storage, and the
 * trips left unread stay offered.
 */
export function startReadingTracks(readTrip: TripGpsReader): void {
    if (run) return;
    const queue: string[][] = [];
    for (const index of tripMapScope()) {
        const trip = state.trips[index];
        if (!trip || hasRoute(index)) continue;
        const keys = unreadKeys(trip);
        if (keys.length > 0) queue.push(keys);
    }
    if (queue.length === 0) return;
    const current: ReadRun = { controller: new AbortController(), done: 0, total: queue.length };
    run = current;
    listeners.emit();
    void readQueue(current, queue, readTrip)
        .catch((error: unknown) => log.error("track reading failed", error))
        .finally(() => {
            if (run === current) run = null;
            listeners.emit();
        });
}

/** Stops the reading; the trip being read goes back to unread. */
export function stopReadingTracks(): void {
    run?.controller.abort();
}

async function readQueue(current: ReadRun, queue: readonly string[][], readTrip: TripGpsReader): Promise<void> {
    for (const keys of queue) {
        if (current.controller.signal.aborted) return;
        // An earlier read may have merged this trip into another one and read it along.
        const stillUnread = keys.filter((key) => state.pendingHeavyEmbeddedGps.has(key));
        const tripIndex =
            stillUnread.length === 0
                ? -1
                : state.trips.findIndex((trip) =>
                      tripAllCandidates(trip).some((candidate) => stillUnread.includes(vendorFileKey(candidate))),
                  );
        if (tripIndex >= 0) {
            const result = await readTrip(tripIndex, current.controller.signal);
            if (result === "cancelled" || result === "busy") return;
            // "failed" leaves the trip's files pending as failed; the rest still get read.
        }
        current.done++;
        listeners.emit();
    }
}

export function _resetForTests(): void {
    run?.controller.abort();
    run = null;
    listeners.clear();
}

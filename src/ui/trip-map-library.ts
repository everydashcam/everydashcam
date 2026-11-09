// Simplified tracks of every loaded trip, for the map of all trips. Trip
// objects and indices change on every regroup, so a track is keyed by a
// signature of what it was built from; a regroup that keeps a trip's
// recordings and GPS reuses the track, and only changed trips go to the worker.

import { isValidGpsFix } from "../parser.js";
import { createSubscribers } from "../subscribers.js";
import type { TripMapTrack } from "../trip-map/track-geometry.js";
import { packTripRecords } from "../trip-map/track-input.js";
import { tripAllCandidates, type Trip } from "../trips.js";
import { vendorFileKey } from "../vendor-file-key.js";
import { createLogger } from "../log.js";
import { releaseTripMapTracks, requestTripMapTrack, setTripMapWorkerCrashHandler } from "./trip-map-worker-client.js";

const log = createLogger("trip-map");

/** One distinct trip geometry; `track` stays null until the worker returns it. */
export interface TripMapEntry {
    /** Never reused, so the worker's caches keyed by ids cannot go stale. */
    id: number;
    track: TripMapTrack | null;
}

interface TripSignature {
    records: Trip["records"];
    recordCount: number;
    /** Null when the trip has no valid fix: it has nothing to draw. */
    signature: string | null;
}

const signatures = new WeakMap<Trip, TripSignature>();
const entries = new Map<string, TripMapEntry>();
let nextId = 1;
let tripEntries: (TripMapEntry | null)[] = [];
let lastTrips: readonly Trip[] = [];
let isCrashHandlerSet = false;
const listeners = createSubscribers<[]>("trip-map-library");

function signatureOf(trip: Trip): string | null {
    const cached = signatures.get(trip);
    if (cached && cached.records === trip.records && cached.recordCount === trip.records.length)
        return cached.signature;
    const records = trip.records;
    const hasFix = records.some(isValidGpsFix);
    const signature = hasFix
        ? [
              tripAllCandidates(trip).map(vendorFileKey).sort().join("\n"),
              records.length,
              records[0]!.unixSeconds,
              records.at(-1)!.unixSeconds,
              trip.gpsOffsetSec ?? 0,
              trip.gpsTrimToVideo === true,
          ].join("|")
        : null;
    signatures.set(trip, { records, recordCount: records.length, signature });
    return signature;
}

function requestTrack(trip: Trip, signature: string): TripMapEntry {
    const entry: TripMapEntry = { id: nextId++, track: null };
    entries.set(signature, entry);
    requestTripMapTrack(entry.id, packTripRecords(trip.records)).then(
        (track) => {
            // A newer sync may have dropped this geometry while it was built.
            if (entries.get(signature) !== entry) return;
            entry.track = track;
            listeners.emit();
        },
        (error: unknown) => {
            if (entries.get(signature) !== entry) return;
            // A crash resends everything; any other failure leaves the trip off the map.
            log.warn("trip track failed", error instanceof Error ? error : { error: String(error) });
        },
    );
    return entry;
}

/**
 * Matches the library to `trips`: new geometries go to the worker, unchanged
 * ones keep their tracks, and geometries no trip has any more are released.
 * Cheap when nothing changed; listeners hear about it only on a change.
 */
export function syncTripMapLibrary(trips: readonly Trip[]): void {
    if (!isCrashHandlerSet) {
        isCrashHandlerSet = true;
        setTripMapWorkerCrashHandler(rebuildAfterCrash);
    }
    lastTrips = trips;
    const used = new Set<string>();
    let isChanged = trips.length !== tripEntries.length;
    const next: (TripMapEntry | null)[] = [];
    for (const trip of trips) {
        const signature = signatureOf(trip);
        let entry: TripMapEntry | null = null;
        if (signature !== null) {
            used.add(signature);
            entry = entries.get(signature) ?? requestTrack(trip, signature);
        }
        if (tripEntries[next.length] !== entry) isChanged = true;
        next.push(entry);
    }
    const released: number[] = [];
    for (const [signature, entry] of entries) {
        if (used.has(signature)) continue;
        entries.delete(signature);
        released.push(entry.id);
    }
    releaseTripMapTracks(released);
    tripEntries = next;
    if (isChanged) listeners.emit();
}

/** The library entry per trip index of the last sync; null for a trip without GPS. */
export function tripMapEntries(): readonly (TripMapEntry | null)[] {
    return tripEntries;
}

/** Called after any sync that changed the entries and whenever a track arrives. */
export function subscribeTripMapLibrary(listener: () => void): () => void {
    return listeners.subscribe(listener);
}

function rebuildAfterCrash(): void {
    log.warn("trip map worker crashed, rebuilding tracks");
    entries.clear();
    tripEntries = [];
    syncTripMapLibrary(lastTrips);
}

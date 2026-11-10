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
    fileKeys: readonly string[];
}

/** A geometry the library holds, with the recordings it was built from. */
interface LibraryRecord {
    entry: TripMapEntry;
    fileKeys: readonly string[];
    /** The worker could not build it: the trip has no route until its GPS changes. */
    hasFailed: boolean;
}

const signatures = new WeakMap<Trip, TripSignature>();
const records = new Map<string, LibraryRecord>();
let nextId = 1;
let tripEntries: (TripMapEntry | null)[] = [];
let lastTrips: readonly Trip[] = [];
let isCrashHandlerSet = false;
const listeners = createSubscribers<[]>("trip-map-library");

function signatureOf(trip: Trip): TripSignature {
    const cached = signatures.get(trip);
    if (cached && cached.records === trip.records && cached.recordCount === trip.records.length) return cached;
    const tripRecords = trip.records;
    const hasFix = tripRecords.some(isValidGpsFix);
    const fileKeys = hasFix ? tripAllCandidates(trip).map(vendorFileKey).sort() : [];
    const signature = hasFix
        ? [
              fileKeys.join("\n"),
              tripRecords.length,
              tripRecords[0]!.unixSeconds,
              tripRecords.at(-1)!.unixSeconds,
              trip.gpsOffsetSec ?? 0,
              trip.gpsTrimToVideo === true,
          ].join("|")
        : null;
    const computed: TripSignature = { records: tripRecords, recordCount: tripRecords.length, signature, fileKeys };
    signatures.set(trip, computed);
    return computed;
}

function requestTrack(trip: Trip, signature: string, fileKeys: readonly string[]): LibraryRecord {
    const record: LibraryRecord = { entry: { id: nextId++, track: null }, fileKeys, hasFailed: false };
    records.set(signature, record);
    requestTripMapTrack(record.entry.id, packTripRecords(trip.records)).then(
        (track) => {
            // A newer sync may have dropped this geometry while it was built.
            if (records.get(signature) !== record) return;
            record.entry.track = track;
            // The trip may still stand on its previous geometry: swap it in.
            syncEntries(lastTrips);
            listeners.emit();
        },
        (error: unknown) => {
            if (records.get(signature) !== record) return;
            // A crash resends everything; any other failure leaves the trip off the map.
            log.warn("trip track failed", error instanceof Error ? error : { error: String(error) });
            record.hasFailed = true;
            if (syncEntries(lastTrips)) listeners.emit();
        },
    );
    return record;
}

/** Signature of a geometry with a track per recording key, for trips whose new geometry is still in the worker. */
function drawnByFileKey(): Map<string, string> {
    const drawn = new Map<string, string>();
    for (const [signature, record] of records) {
        if (!record.entry.track) continue;
        for (const key of record.fileKeys) if (!drawn.has(key)) drawn.set(key, signature);
    }
    return drawn;
}

/**
 * Matches the entries to `trips` and releases geometries no trip uses.
 * Returns whether any trip's entry changed.
 *
 * A trip whose GPS changed (more of it read, a new sync offset, a regroup)
 * needs a new geometry from the worker. Until it arrives the trip keeps
 * standing on a drawn geometry of its recordings: dropped meanwhile, it would
 * leave a place or map area filtered list and come back a moment later.
 */
function syncEntries(trips: readonly Trip[]): boolean {
    lastTrips = trips;
    const used = new Set<string>();
    let drawn: Map<string, string> | null = null;
    let isChanged = trips.length !== tripEntries.length;
    const next: (TripMapEntry | null)[] = [];
    for (const trip of trips) {
        const { signature, fileKeys } = signatureOf(trip);
        let entry: TripMapEntry | null = null;
        if (signature !== null) {
            used.add(signature);
            const record = records.get(signature) ?? requestTrack(trip, signature, fileKeys);
            entry = record.entry;
            if (!entry.track && !record.hasFailed) {
                drawn ??= drawnByFileKey();
                const standing = fileKeys.map((key) => drawn!.get(key)).find((found) => found !== undefined);
                if (standing !== undefined) {
                    used.add(standing);
                    entry = records.get(standing)!.entry;
                }
            }
        }
        if (tripEntries[next.length] !== entry) isChanged = true;
        next.push(entry);
    }
    const released: number[] = [];
    for (const [signature, record] of records) {
        if (used.has(signature)) continue;
        records.delete(signature);
        released.push(record.entry.id);
    }
    releaseTripMapTracks(released);
    tripEntries = next;
    return isChanged;
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
    if (syncEntries(trips)) listeners.emit();
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
    records.clear();
    tripEntries = [];
    syncTripMapLibrary(lastTrips);
}

export function _resetForTests(): void {
    records.clear();
    tripEntries = [];
    lastTrips = [];
    listeners.clear();
}

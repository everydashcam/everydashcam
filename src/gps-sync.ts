// GPS-to-video synchronization preferences and Trip hydration.
//
// The parser-owned record clocks stay untouched. Per-trip overrides live in
// localStorage, anchored to a recording's stable file identity. The resolved
// preference is applied to each freshly-derived Trip at the regroup boundary.

import { isValidGpsFix, recordsHaveGps } from "./parser.js";
import { usableCandidateRecords } from "./stale-gps.js";
import { fileIdentityKey } from "./persist/identity.js";
import { applyGpsSyncToTrip, rawTripGpsRecords, type Trip, tripAllCandidates } from "./trips.js";

const TRIP_SYNC_STORAGE_KEY = "everydashcam:trips:gpsSync";
const MAX_STORED_TRIPS = 200;

// A camera reset to 1970 needs decades of correction. Two centuries cover
// plausible recording clocks while still bounding corrupt storage and input.
export const GPS_OFFSET_MAX_SEC = 200 * 366 * 24 * 60 * 60;

interface StoredTripGpsSync {
    anchorKey: string;
    /** Present for a manually attached GPX. Prevents a calibration saved for
     *  one track from being reused when another GPX is attached to the same
     *  recording later. */
    trackKey?: string;
    offsetSec?: number;
    trimToVideo?: boolean;
    updatedAt: number;
}

export interface ResolvedGpsSync {
    offsetSec: number;
    trimToVideo: boolean;
    hasOffsetOverride: boolean;
}

let memoryEntries: StoredTripGpsSync[] = [];
let hasUnsavedEntries = false;

export function normalizeGpsOffsetSec(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(GPS_OFFSET_MAX_SEC, Math.max(-GPS_OFFSET_MAX_SEC, Math.round(value * 1000) / 1000));
}

function isStoredEntry(value: unknown): value is StoredTripGpsSync {
    if (typeof value !== "object" || value === null) return false;
    const entry = value as Record<string, unknown>;
    if (typeof entry.anchorKey !== "string" || entry.anchorKey === "") return false;
    if (entry.trackKey !== undefined && (typeof entry.trackKey !== "string" || entry.trackKey === "")) return false;
    if (typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt) || entry.updatedAt < 0) return false;
    if (
        entry.offsetSec !== undefined &&
        (typeof entry.offsetSec !== "number" ||
            !Number.isFinite(entry.offsetSec) ||
            Math.abs(entry.offsetSec) > GPS_OFFSET_MAX_SEC)
    ) {
        return false;
    }
    return entry.trimToVideo === undefined || typeof entry.trimToVideo === "boolean";
}

function loadEntries(): StoredTripGpsSync[] {
    // A readable stale copy must not undo a calibration whose write failed.
    if (hasUnsavedEntries) return memoryEntries;
    try {
        const raw = localStorage.getItem(TRIP_SYNC_STORAGE_KEY);
        if (raw === null) return memoryEntries;
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return memoryEntries;
        memoryEntries = parsed.filter(isStoredEntry).map((entry) => ({
            ...entry,
            ...(entry.offsetSec !== undefined ? { offsetSec: normalizeGpsOffsetSec(entry.offsetSec) } : {}),
        }));
    } catch {
        // Corrupt/blocked storage falls back to the last valid session copy.
    }
    return memoryEntries;
}

function saveEntries(entries: StoredTripGpsSync[]): void {
    memoryEntries = [...entries].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_STORED_TRIPS);
    hasUnsavedEntries = true;
    try {
        localStorage.setItem(TRIP_SYNC_STORAGE_KEY, JSON.stringify(memoryEntries));
        hasUnsavedEntries = false;
    } catch {
        // Storage blocked: preferences remain in memory for this session.
    }
}

function candidateIdentityKey(trip: Trip): string[] {
    return tripAllCandidates(trip).map((candidate) =>
        fileIdentityKey({
            relativePath: candidate.relativePath,
            size: candidate.file.size,
            lastModified: candidate.file.lastModified,
        }),
    );
}

function externalTrackKey(trip: Trip): string | null {
    const keys = new Set<string>();
    for (const candidate of tripAllCandidates(trip)) {
        for (const record of candidate.records) {
            if (record.externalTrack === true && record.externalTrackKey) keys.add(record.externalTrackKey);
        }
    }
    return keys.size === 1 ? [...keys][0]! : null;
}

function storedEntryForTrip(entries: readonly StoredTripGpsSync[], trip: Trip): StoredTripGpsSync | null {
    const keys = new Set(candidateIdentityKey(trip));
    const trackKey = externalTrackKey(trip);
    let best: StoredTripGpsSync | null = null;
    for (const entry of entries) {
        if (!keys.has(entry.anchorKey)) continue;
        // Legacy entries without a track key remain valid for native/basename
        // GPS, but deliberately do not migrate onto a manually attached GPX.
        if ((entry.trackKey ?? null) !== trackKey) continue;
        if (best === null || entry.updatedAt > best.updatedAt) best = entry;
    }
    return best;
}

function resolvedGpsSyncForTripFromEntries(entries: readonly StoredTripGpsSync[], trip: Trip): ResolvedGpsSync {
    const entry = storedEntryForTrip(entries, trip);
    return {
        offsetSec: entry?.offsetSec ?? 0,
        trimToVideo: entry?.trimToVideo ?? false,
        hasOffsetOverride: entry?.offsetSec !== undefined && entry.offsetSec !== 0,
    };
}

export function resolvedGpsSyncForTrip(trip: Trip): ResolvedGpsSync {
    return resolvedGpsSyncForTripFromEntries(loadEntries(), trip);
}

function upsertTripEntry(trip: Trip, patch: (entry: StoredTripGpsSync) => void): void {
    const entries = [...loadEntries()];
    const existing = storedEntryForTrip(entries, trip);
    const anchorKey = existing?.anchorKey ?? candidateIdentityKey(trip)[0];
    if (!anchorKey) return;
    const trackKey = externalTrackKey(trip);
    const entry: StoredTripGpsSync = existing
        ? { ...existing }
        : { anchorKey, ...(trackKey === null ? {} : { trackKey }), updatedAt: 0 };
    patch(entry);
    entry.updatedAt = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
    const without = entries.filter((item) => item !== existing);
    if (entry.offsetSec === undefined && entry.trimToVideo === undefined) saveEntries(without);
    else saveEntries([entry, ...without]);
}

/** Stores one trip's offset. Zero and null both restore the raw GPS clock. */
export function setTripGpsOffsetSec(trip: Trip, value: number | null): void {
    upsertTripEntry(trip, (entry) => {
        const normalized = value === null ? 0 : normalizeGpsOffsetSec(value);
        if (normalized === 0) delete entry.offsetSec;
        else entry.offsetSec = normalized;
    });
}

/** The complete track is visible by default so a mismatched GPX can be found
 *  and aligned. Only an explicit opt-in trims points outside the footage. */
export function setTripGpsTrimToVideo(trip: Trip, trimToVideo: boolean): void {
    upsertTripEntry(trip, (entry) => {
        if (trimToVideo) entry.trimToVideo = true;
        else delete entry.trimToVideo;
    });
}

export function applyStoredGpsSyncToTrip(trip: Trip): void {
    const sync = resolvedGpsSyncForTrip(trip);
    applyGpsSyncToTrip(trip, sync.offsetSec, sync.trimToVideo);
}

export function applyStoredGpsSyncToTrips(trips: readonly Trip[]): void {
    const entries = loadEntries();
    for (const trip of trips) {
        const sync = resolvedGpsSyncForTripFromEntries(entries, trip);
        applyGpsSyncToTrip(trip, sync.offsetSec, sync.trimToVideo);
    }
}

/** Raw-GPS predicate for launch controls. Unlike trip.records it stays true
 *  when a bad offset plus trimming temporarily moves every point off-video. */
export function tripHasRawGps(trip: Trip | null): boolean {
    return (
        trip !== null && tripAllCandidates(trip).some((candidate) => recordsHaveGps(usableCandidateRecords(candidate)))
    );
}

function tripCameraFingerprint(trip: Trip): string | null {
    const fingerprints = new Set(tripAllCandidates(trip).map((candidate) => candidate.fingerprint));
    return fingerprints.size === 1 ? [...fingerprints][0]! : null;
}

function tripHasExternalTrack(trip: Trip): boolean {
    return tripAllCandidates(trip).some((candidate) =>
        candidate.records.some((record) => record.externalTrack === true),
    );
}

/** Other loaded trips whose native GPS follows the same physical camera
 *  clock. Loose GPX tracks stay trip-specific even when their video came from
 *  the same camera because every attached source owns a separate clock. */
export function gpsSyncPeerTrips(trip: Trip, trips: readonly Trip[]): Trip[] {
    const fingerprint = tripCameraFingerprint(trip);
    if (fingerprint === null || tripHasExternalTrack(trip)) return [];
    return trips.filter(
        (candidate) =>
            candidate !== trip &&
            tripHasRawGps(candidate) &&
            !tripHasExternalTrack(candidate) &&
            tripCameraFingerprint(candidate) === fingerprint,
    );
}

export function rawGpsStartUnix(trip: Trip): number | null {
    return rawTripGpsRecords(trip).find(isValidGpsFix)?.unixSeconds ?? null;
}

/** Edge overhang after applying an offset. It intentionally measures only the
 *  track prefix/suffix; recording pauses inside a trip are explained separately
 *  by the timeline and do not read as an accidentally long GPX. */
export function gpsTrackOverhangSec(trip: Trip, offsetSec: number): number {
    const fixes = rawTripGpsRecords(trip).filter(isValidGpsFix);
    const first = fixes[0];
    const last = fixes[fixes.length - 1];
    const firstSegment = trip.timeline.segments[0];
    const lastSegment = trip.timeline.segments[trip.timeline.segments.length - 1];
    if (!first || !last || !firstSegment || !lastSegment) return 0;
    const videoStart = firstSegment.wallStart;
    const videoEnd = lastSegment.wallStart + lastSegment.wallDurationSec;
    const before = Math.max(0, videoStart - (first.unixSeconds + offsetSec));
    const after = Math.max(0, last.unixSeconds + offsetSec - videoEnd);
    return before + after;
}

/** Clears module-level fallbacks between deterministic unit tests. */
export function _resetForTests(): void {
    memoryEntries = [];
    hasUnsavedEntries = false;
}

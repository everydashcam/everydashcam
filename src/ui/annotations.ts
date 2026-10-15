// Session layer over the annotation store: loads records into memory, anchors
// trip metadata to FILE identity (trips are derived entities - a parser bump
// or gap-setting change regroups them, so the anchor file, not the Trip
// object, is the stable thing), and persists edits fire-and-forget. Store
// unavailability degrades to session-only annotations, never an error.

import { createLogger } from "../log.js";
import { captureSentryMessage } from "../sentry.js";
import {
    compareAnnotationVersions,
    loadAllAnnotations,
    saveAnnotation,
    saveAnnotations,
} from "../persist/annotations.js";
import { fileIdentityKey, parseFileIdentityKey } from "../persist/identity.js";
import type { AnnotationRecord, MarkerAnnotation, TripMetaAnnotation } from "../persist/types.js";
import type { Trip, VideoCandidate } from "../trips.js";
import {
    contentToFrame,
    contentToWallUtc,
    frameChannels,
    frameMediaOffset,
    needsRecordingMetadata,
    tripAllCandidates,
    wallToContentSec,
} from "../trips.js";
import { vendorFileKey } from "../vendor-file-key.js";
import { folderIdForFileKey } from "./folder-sources.js";
import { state } from "./state.js";

const log = createLogger("annotations");

// id -> record, tombstones included (an edit after a delete must LWW-win).
const recordsById = new Map<string, AnnotationRecord>();
// anchor file identity -> every trip-meta record on that anchor, tombstones
// included. More than one physical folder can contain a byte-identical clip;
// retaining each record lets folder ownership choose independently instead of
// letting the newest folder hide the other folder's note.
const tripMetasByAnchor = new Map<string, Map<string, TripMetaAnnotation>>();
// id -> LIVE timeline marker (tombstones excluded).
const markersById = new Map<string, MarkerAnnotation>();
let isStoreAvailable = true;
let hasOpenedStore = false;
let persistenceStatusHook: ((available: boolean) => void) | null = null;
let initialLoadSettled: Promise<void> = Promise.resolve();

function markPersistenceFailure(error: unknown, operation: "load" | "save" | "merge" | "import"): void {
    if (!isStoreAvailable) return;
    isStoreAvailable = false;
    // Unavailable storage at startup is an expected session-only mode. Report
    // a later loss of durability once per outage, without annotation content or
    // browser exception text (a structured-clone error can describe the note).
    if (hasOpenedStore && operation !== "load" && !(error instanceof Error && error.name === "AbortError")) {
        const errorKind =
            error instanceof Error &&
            [
                "QuotaExceededError",
                "UnknownError",
                "InvalidStateError",
                "DataCloneError",
                "TransactionInactiveError",
            ].includes(error.name)
                ? error.name
                : "unknown";
        captureSentryMessage("annotation persistence failed", {
            level: "error",
            fingerprint: ["annotation_persistence_failed", errorKind],
            tags: { feature: "annotations", operation, error_kind: errorKind },
        });
    }
    persistenceStatusHook?.(false);
}

function markPersistenceSuccess(): void {
    hasOpenedStore = true;
    if (isStoreAvailable) return;
    isStoreAvailable = true;
    persistenceStatusHook?.(true);
}

export function annotationStoreAvailable(): boolean {
    return isStoreAvailable;
}

export function registerAnnotationPersistenceStatusHook(callback: (available: boolean) => void): void {
    persistenceStatusHook = callback;
}

/** Settles after the first IndexedDB load succeeds or degrades to session-only.
 * User-triggered exports/imports wait for this so a click during startup cannot
 * snapshot an incomplete in-memory record set. */
export function waitForAnnotationsReady(): Promise<void> {
    return initialLoadSettled;
}

/** Loads the stored annotations into the in-memory index. Call once at app
 *  start; until it resolves, lookups just return nothing. `onLoaded` fires
 *  when the load actually added records - the caller re-renders surfaces
 *  that may have painted before the store answered. */
export function initAnnotations(onLoaded?: () => void): void {
    initialLoadSettled = loadAllAnnotations()
        .then((records) => {
            markPersistenceSuccess();
            let applied = 0;
            for (const record of records) {
                // A sidecar merge can land before this load resolves (chip
                // click on a cold start) - the older DB snapshot must not
                // override what the merge just wrote.
                const existing = recordsById.get(record.id);
                if (existing && compareAnnotationVersions(existing, record) >= 0) continue;
                indexRecord(record);
                applied++;
            }
            if (applied > 0) {
                log.info("annotations loaded", { count: applied });
                onLoaded?.();
            }
        })
        .catch((err: unknown) => {
            log.warn("annotation store unavailable, session-only annotations", {
                err: err instanceof Error ? err.message : String(err),
            });
            markPersistenceFailure(err, "load");
        });
}

function indexRecord(record: AnnotationRecord): void {
    const previous = recordsById.get(record.id);
    if (previous?.kind === "tripMeta") {
        const bucket = tripMetasByAnchor.get(previous.anchor.fileIdentityKey);
        bucket?.delete(previous.id);
        if (bucket?.size === 0) tripMetasByAnchor.delete(previous.anchor.fileIdentityKey);
    } else if (previous?.kind === "marker") {
        markersById.delete(previous.id);
    }
    recordsById.set(record.id, record);
    if (record.kind === "tripMeta") {
        const key = record.anchor.fileIdentityKey;
        const bucket = tripMetasByAnchor.get(key) ?? new Map<string, TripMetaAnnotation>();
        bucket.set(record.id, record);
        tripMetasByAnchor.set(key, bucket);
    } else if (record.kind === "marker") {
        if (record.deleted) markersById.delete(record.id);
        else markersById.set(record.id, record);
    }
}

function candidateIdentityKey(candidate: VideoCandidate): string {
    return fileIdentityKey({
        relativePath: candidate.relativePath,
        size: candidate.file.size,
        lastModified: candidate.file.lastModified,
    });
}

function candidateClockPending(candidate: VideoCandidate): boolean {
    const key = vendorFileKey(candidate);
    return (
        needsRecordingMetadata(candidate) ||
        state.pendingHeavyEmbeddedGps.has(key) ||
        state.inflightEmbeddedGps.has(key)
    );
}

/**
 * The trip's metadata annotation, or null. Matched by containment: the record
 * anchors to one file, and whichever trip holds that file after the current
 * grouping owns the annotation.
 */
export function tripMetaFor(trip: Trip): TripMetaAnnotation | null {
    // No annotations at all (the common case) - skip the candidate walk;
    // this runs per card on the render path, including mid-ingest repaints.
    if (tripMetasByAnchor.size === 0) return null;
    // The NEWEST of them, not the first: a regroup can pull two separately
    // annotated trips into one, and picking by frame order would show whichever
    // clip happens to sort first - and hide an edit made after it.
    const matching = liveTripMetas(trip);
    let best: TripMetaAnnotation | null = null;
    for (const meta of matching) {
        if (best === null || compareTripMetaVersions(meta, best) > 0) best = meta;
    }
    return best;
}

/** Every live trip-meta record anchored inside this trip. More than one only
 *  after a regroup merged separately annotated trips. */
function liveTripMetas(trip: Trip): TripMetaAnnotation[] {
    if (tripMetasByAnchor.size === 0) return [];
    const out: TripMetaAnnotation[] = [];
    const visitedAnchors = new Set<string>();
    let hasExactWinner = false;
    for (const candidate of tripAllCandidates(trip)) {
        const anchorKey = candidateIdentityKey(candidate);
        if (visitedAnchors.has(anchorKey)) continue;
        visitedAnchors.add(anchorKey);
        const winner = exactTripMetaWinner(anchorKey, trip);
        if (!winner) continue;
        hasExactWinner = true;
        if (!winner.deleted && !out.includes(winner)) out.push(winner);
    }
    if (out.length === 0 && !hasExactWinner) {
        const recovered = recoverRenamedTripMeta(trip);
        if (recovered) out.push(recovered);
    }
    return out;
}

function exactTripMetaWinner(anchorKey: string, trip: Trip): TripMetaAnnotation | null {
    const bucket = tripMetasByAnchor.get(anchorKey);
    if (!bucket) return null;
    return bestTripMeta([...bucket.values()].filter((meta) => exactTripMetaBelongsTo(meta, trip)));
}

function bestTripMeta(records: readonly TripMetaAnnotation[]): TripMetaAnnotation | null {
    let best: TripMetaAnnotation | null = null;
    for (const record of records) {
        if (best === null || compareTripMetaVersions(record, best) > 0) best = record;
    }
    return best;
}

function exactTripMetaBelongsTo(meta: TripMetaAnnotation, trip: Trip): boolean {
    const targetFolderIds = nonEmptyFolderIdsForTrip(trip);
    const matchingTrips = state.trips.filter((candidateTrip) =>
        tripAllCandidates(candidateTrip).some(
            (candidate) => candidateIdentityKey(candidate) === meta.anchor.fileIdentityKey,
        ),
    );
    if (matchingTrips.length === 0) {
        return !meta.folderId || targetFolderIds.size === 0 || targetFolderIds.has(meta.folderId);
    }
    if (meta.folderId) {
        const owned = matchingTrips.filter((candidateTrip) => folderIdsForTrip(candidateTrip).has(meta.folderId));
        if (owned.length > 0) return owned.length === 1 && owned[0] === trip;
        // A remembered target explicitly belongs to another folder. Exact
        // bytes are not enough to borrow a note from a different copied card.
        if (targetFolderIds.size > 0) return false;
    }
    return matchingTrips.length === 1 && matchingTrips[0] === trip;
}

const RECOVERY_START_TOLERANCE_MS = 5 * 60 * 1000;

/** Finds one safe fallback after path-root or mtime changes. The start time and
 * byte length must still agree, and any tie means no match. */
function recoverRenamedTripMeta(trip: Trip): TripMetaAnnotation | null {
    let bestScore = 0;
    let winner: TripMetaAnnotation | null = null;
    let isTied = false;
    for (const bucket of tripMetasByAnchor.values()) {
        const meta = bestTripMeta([...bucket.values()].filter((record) => recoveryTripMetaBelongsTo(record, trip)));
        if (!meta || meta.deleted) continue;
        const score = renamedTripMetaScore(meta, trip);
        if (score > bestScore) {
            bestScore = score;
            winner = meta;
            isTied = false;
        } else if (score > 0 && score === bestScore && winner?.id !== meta.id) {
            isTied = true;
        }
    }
    if (bestScore === 0 || isTied || !winner) return null;
    const matchesAnotherTrip = state.trips.some(
        (candidateTrip) => candidateTrip !== trip && renamedTripMetaScore(winner, candidateTrip) >= bestScore,
    );
    return matchesAnotherTrip ? null : winner;
}

function recoveryTripMetaBelongsTo(meta: TripMetaAnnotation, trip: Trip): boolean {
    if (!meta.folderId) return true;
    const targetFolderIds = nonEmptyFolderIdsForTrip(trip);
    return targetFolderIds.size === 0 || targetFolderIds.has(meta.folderId);
}

function renamedTripMetaScore(meta: TripMetaAnnotation, trip: Trip): number {
    if (!recoveryTripMetaBelongsTo(meta, trip)) return 0;
    if (Math.abs(meta.anchor.startUtc - trip.startUtc * 1000) > RECOVERY_START_TOLERANCE_MS) return 0;
    const stored = parseFileIdentityKey(meta.anchor.fileIdentityKey);
    if (!stored) return 0;
    let bestScore = 0;
    for (const candidate of tripAllCandidates(trip)) {
        if (candidate.file.size !== stored.size) continue;
        bestScore = Math.max(bestScore, recoveryPathScore(stored.relativePath, candidate.relativePath));
    }
    return bestScore;
}

/** Unique current trip for one orphaned trip-meta record. Folder ownership is
 * deliberately ignored here; the caller is trying to recover that ownership
 * and verifies the matched candidate itself before re-keying. */
function uniqueTripForTripMetaRecord(meta: TripMetaAnnotation): Trip | null {
    const exact = state.trips.filter((trip) =>
        tripAllCandidates(trip).some((candidate) => candidateIdentityKey(candidate) === meta.anchor.fileIdentityKey),
    );
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) return null;

    const unowned = meta.folderId ? { ...meta, folderId: "" } : meta;
    let bestTrip: Trip | null = null;
    let bestScore = 0;
    let isTied = false;
    for (const trip of state.trips) {
        const score = renamedTripMetaScore(unowned, trip);
        if (score > bestScore) {
            bestTrip = trip;
            bestScore = score;
            isTied = false;
        } else if (score > 0 && score === bestScore) {
            isTied = true;
        }
    }
    return bestScore > 0 && !isTied ? bestTrip : null;
}

function recoveryCandidate(meta: TripMetaAnnotation, trip: Trip): VideoCandidate | null {
    if (tripAllCandidates(trip).some((candidate) => candidateIdentityKey(candidate) === meta.anchor.fileIdentityKey)) {
        return null;
    }
    const stored = parseFileIdentityKey(meta.anchor.fileIdentityKey);
    if (!stored) return null;
    let bestScore = 0;
    let best: VideoCandidate | null = null;
    let isTied = false;
    for (const candidate of tripAllCandidates(trip)) {
        if (candidate.file.size !== stored.size) continue;
        const score = recoveryPathScore(stored.relativePath, candidate.relativePath);
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
            isTied = false;
        } else if (score > 0 && score === bestScore && best && vendorFileKey(candidate) !== vendorFileKey(best)) {
            isTied = true;
        }
    }
    return bestScore > 0 && !isTied ? best : null;
}

function tripMetaAnchorCandidate(meta: TripMetaAnnotation, trip: Trip): VideoCandidate | null {
    const exact = uniqueAnchorCandidate(
        trip,
        (candidate) => candidateIdentityKey(candidate) === meta.anchor.fileIdentityKey,
    );
    if (exact) return exact;
    return recoveryCandidate(meta, trip);
}

function uniqueAnchorCandidate(trip: Trip, matches: (candidate: VideoCandidate) => boolean): VideoCandidate | null {
    const candidates = new Map<string, VideoCandidate>();
    for (const candidate of tripAllCandidates(trip)) {
        if (matches(candidate)) candidates.set(vendorFileKey(candidate), candidate);
    }
    return candidates.size === 1 ? [...candidates.values()][0]! : null;
}

function recoveryPathScore(storedPathValue: string, currentPathValue: string): number {
    const currentPath = normalizedPath(currentPathValue);
    const storedPath = normalizedPath(storedPathValue);
    return currentPath === storedPath
        ? 3
        : withoutRoot(currentPath) === withoutRoot(storedPath)
          ? 2
          : basename(currentPath) === basename(storedPath)
            ? 1
            : 0;
}

function normalizedPath(path: string): string {
    return path
        .replaceAll("\\", "/")
        .replace(/^\/+|\/+$/g, "")
        .toLocaleLowerCase("en-US");
}

function withoutRoot(path: string): string {
    const slash = path.indexOf("/");
    return slash < 0 ? path : path.slice(slash + 1);
}

function basename(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? path : path.slice(slash + 1);
}

/** User-editable subset of a trip-meta annotation. */
export interface TripMetaPatch {
    name?: string;
    note?: string;
    isFavorite?: boolean;
}

/**
 * Applies a patch to the trip's metadata annotation, creating it (anchored to
 * the trip's first file) when absent. A record whose fields all end up empty
 * turns into a tombstone - clearing the last field must not leave a ghost.
 * Persisted fire-and-forget; the in-memory index updates synchronously so the
 * caller can re-render immediately.
 */
export function setTripMeta(trip: Trip, patch: TripMetaPatch): void {
    const existing = tripMetaFor(trip);
    const previousAnchorWinner = existing ? exactTripMetaWinner(existing.anchor.fileIdentityKey, trip) : null;
    // Captured before the edit: any OTHER record anchored in this trip is a
    // leftover of a regroup that merged two annotated trips. Only the newest is
    // ever shown, so leaving one live means clearing the visible name uncovers
    // a name the user thought was gone. They are folded in ONLY when this edit
    // clears the trip (below) - trip membership is derived and reversible, so
    // tombstoning on an ordinary edit would destroy the other trip's name the
    // moment the gap setting puts the two back apart.
    const superseded = liveTripMetas(trip).filter((meta) => meta.id !== existing?.id);
    const firstCandidate = tripAllCandidates(trip)[0];
    if (!firstCandidate) return;
    const base: TripMetaAnnotation = existing
        ? { ...existing }
        : {
              id: crypto.randomUUID(),
              // "" when the trip's files did not come out of a remembered
              // folder (ad-hoc drop). The annotation still works; ownership
              // can be adopted if that source is remembered later.
              folderId: folderIdForFileKey(candidateIdentityKey(firstCandidate), firstCandidate.sourceKey),
              updatedAt: 0,
              deleted: false,
              kind: "tripMeta",
              anchor: {
                  fileIdentityKey: candidateIdentityKey(firstCandidate),
                  startUtc: Math.round(trip.startUtc * 1000),
              },
          };
    if (existing) {
        const recovered = recoveryCandidate(existing, trip);
        if (recovered) {
            base.anchor = {
                fileIdentityKey: candidateIdentityKey(recovered),
                startUtc: Math.round(trip.startUtc * 1000),
            };
            base.folderId = folderIdForFileKey(candidateIdentityKey(recovered), recovered.sourceKey);
        }
    }
    if (patch.name !== undefined) setOrDrop(base, "name", patch.name.trim());
    if (patch.note !== undefined) setOrDrop(base, "note", patch.note.trim());
    if (patch.isFavorite !== undefined) {
        if (patch.isFavorite) base.isFavorite = true;
        else delete base.isFavorite;
    }
    // Past this trip's anchor winner, not just "now": another machine's fast clock
    // can leave a future-stamped record (a tombstone in particular) on this
    // anchor, and a wall-clock stamp behind it loses LWW when the notes file
    // reaches the other machine. Bounded by the skew that already exists; it
    // never invents more.
    const anchorWinner = exactTripMetaWinner(base.anchor.fileIdentityKey, trip);
    base.updatedAt = Math.max(
        Date.now(),
        (anchorWinner?.updatedAt ?? 0) + 1,
        (previousAnchorWinner?.updatedAt ?? 0) + 1,
    );
    base.deleted = !base.name && !base.note && base.isFavorite !== true;
    if (base.deleted) {
        // Tombstones need the anchor for merge/rebinding, but not the note the
        // user explicitly removed. Do not keep deleted private text forever in
        // IndexedDB and every future copy of the notes file.
        delete base.name;
        delete base.note;
        delete base.isFavorite;
    }
    persistRecord(base);
    // Clearing is still a deliberate change that must reach the notes file.
    userAnnotationHook?.(base);
    // Clearing the card means "this trip has no annotation" - so the leftovers
    // it was hiding go with it, or the next render uncovers one of them.
    // Anything short of a clear leaves them alone: they still belong to the
    // trip they were written on, which a different gap setting brings back.
    if (base.deleted) {
        for (const meta of superseded) {
            persistRecord({
                id: meta.id,
                folderId: meta.folderId,
                updatedAt: base.updatedAt,
                deleted: true,
                kind: "tripMeta",
                anchor: meta.anchor,
            });
        }
    }
}

/** Sets a string field, or removes it when empty - the stored record then
 *  reads the same as "never set" (drives the tombstone check above). */
function setOrDrop(record: TripMetaAnnotation, field: "name" | "note", value: string): void {
    if (value) record[field] = value;
    else delete record[field];
}

/** Live markers belonging to this trip, oldest first. New records use a
 * clip-relative anchor that survives path/mtime changes; older records fall
 * back to UTC plus folder ownership. */
export function markersForTrip(trip: Trip): MarkerAnnotation[] {
    return [...markersById.values()]
        .flatMap((marker) => {
            if (marker.anchor) {
                return uniqueTripForMarkerAnchor(marker) === trip ? [markerAtAnchoredUtc(marker, trip)] : [];
            }
            return uniqueTripForLegacyMarker(marker) === trip ? [marker] : [];
        })
        .sort((a, b) => a.utc - b.utc);
}

/** Projects the persistent clip-relative anchor onto the current timeline.
 * The stored UTC remains a legacy/fallback value; parser clock refinements,
 * regrouping and a restored sidecar must not move the visible pin away from
 * the same instant inside its clip. */
function markerAtAnchoredUtc(marker: MarkerAnnotation, trip: Trip): MarkerAnnotation {
    const anchor = marker.anchor;
    if (!anchor || !trip.timeline?.segments.length) return marker;
    const candidate = markerAnchorCandidate(anchor.fileIdentityKey, trip);
    if (!candidate) return marker;
    const contentSec = markerAnchorContentSec(trip, candidate, anchor.offsetSec);
    if (contentSec === null) return marker;
    const utc = Math.round(contentToWallUtc(trip.timeline, contentSec) * 1000);
    return utc === marker.utc ? marker : { ...marker, utc };
}

function markerAnchorCandidate(fileKey: string, trip: Trip): VideoCandidate | null {
    const exact = uniqueAnchorCandidate(trip, (candidate) => candidateIdentityKey(candidate) === fileKey);
    if (exact) return exact;
    const stored = parseFileIdentityKey(fileKey);
    if (!stored) return null;
    return uniqueAnchorCandidate(trip, (candidate) => {
        if (candidate.file.size !== stored.size) return false;
        return withoutRoot(normalizedPath(candidate.relativePath)) === withoutRoot(normalizedPath(stored.relativePath));
    });
}

/** A source file can span several timeline intervals when cameras cut separately. */
function markerAnchorContentSec(trip: Trip, candidate: VideoCandidate, offsetSec: number): number | null {
    let closest: number | null = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const segment of trip.timeline.segments) {
        const frame = trip.frames[segment.frameIndex]!;
        for (const channel of frameChannels(frame)) {
            if (frame.channels[channel] !== candidate) continue;
            const offset = offsetSec - frameMediaOffset(frame, channel);
            const clamped = Math.max(0, Math.min(offset, segment.durationSec));
            const delta = Math.abs(clamped - offset);
            if (delta < distance) {
                closest = segment.contentStart + clamped;
                distance = delta;
            }
        }
    }
    return closest;
}

function uniqueTripForMarkerAnchor(marker: MarkerAnnotation): Trip | null {
    if (!marker.anchor) return null;
    const matching = state.trips.filter((trip) => {
        const exact = tripAllCandidates(trip).some(
            (candidate) => candidateIdentityKey(candidate) === marker.anchor!.fileIdentityKey,
        );
        if (exact) return true;
        const stored = parseFileIdentityKey(marker.anchor!.fileIdentityKey);
        if (!stored) return false;
        return tripAllCandidates(trip).some((candidate) => {
            if (Math.abs(marker.anchor!.startUtc - candidate.startUtc * 1000) > RECOVERY_START_TOLERANCE_MS) {
                return false;
            }
            if (candidate.file.size !== stored.size) return false;
            const currentPath = normalizedPath(candidate.relativePath);
            const storedPath = normalizedPath(stored.relativePath);
            return withoutRoot(currentPath) === withoutRoot(storedPath);
        });
    });
    if (marker.folderId) {
        const owned = matching.filter((trip) => folderIdsForTrip(trip).has(marker.folderId));
        if (owned.length === 1) return owned[0]!;
        return null;
    }
    return matching.length === 1 ? matching[0]! : null;
}

/** Older marker records have no clip anchor. Folder ownership disambiguates
 * them when possible; otherwise only one trip may contain their UTC. */
function uniqueTripForLegacyMarker(marker: MarkerAnnotation): Trip | null {
    const matching = state.trips.filter(
        (trip) => marker.utc >= trip.startUtc * 1000 && marker.utc <= trip.endUtc * 1000,
    );
    if (marker.folderId) {
        const owned = matching.filter((trip) => folderIdsForTrip(trip).has(marker.folderId));
        if (owned.length === 1) return owned[0]!;
        return null;
    }
    return matching.length === 1 ? matching[0]! : null;
}

function folderIdsForTrip(trip: Trip): Set<string> {
    return new Set(
        tripAllCandidates(trip).map((candidate) =>
            folderIdForFileKey(candidateIdentityKey(candidate), candidate.sourceKey),
        ),
    );
}

/** A marker by id, or null (deleted/unknown). */
export function markerById(id: string): MarkerAnnotation | null {
    return markersById.get(id) ?? null;
}

/** Creates a marker at the given UTC (epoch ms) inside the trip. */
export function addMarker(trip: Trip, utcMs: number, text: string): MarkerAnnotation {
    const firstCandidate = tripAllCandidates(trip)[0];
    const record: MarkerAnnotation = {
        id: crypto.randomUUID(),
        folderId: firstCandidate
            ? folderIdForFileKey(candidateIdentityKey(firstCandidate), firstCandidate.sourceKey)
            : "",
        updatedAt: Date.now(),
        deleted: false,
        kind: "marker",
        utc: Math.round(utcMs),
        text: text.trim(),
    };
    captureMarkerAnchor(trip, record, utcMs);
    persistRecord(record);
    return record;
}

// === Re-stamping markers placed on a provisional timeline ===
//
// A marker's playback position begins as UTC computed from a trip start that
// may still rely on filename evidence. Metadata or GPS can refine that clock
// and move the trip out from under the marker: the stored UTC
// lands at the wrong moment, on the wrong trip, or outside every trip, and
// the broken value flows into the notes file. Every marker records a persistent
// clip anchor for portable restore; while candidates are pending the same data
// also stays in this session map so UTC can be recomputed and re-saved.

interface ProvisionalMarkerAnchor {
    /** Identity key of the clip file the marker was placed in. */
    fileKey: string;
    /** Session-scoped identity, including the physical ingest source. Two
     * byte-identical cards can otherwise pull the marker onto whichever trip
     * happened to be indexed first. */
    candidateKey: string;
    /** Content seconds from that clip's segment start to the marker. */
    offsetSec: number;
}

// marker id -> anchor for markers created before all clock evidence is available.
const provisionalMarkerAnchors = new Map<string, ProvisionalMarkerAnchor>();

// Repaints the timeline pins after a re-stamp. Registered from app.ts -
// importing timeline-markers here would cycle (it imports this module).
let markersRestampedHook: (() => void) | null = null;

/** Registers the after-re-stamp repaint. */
export function registerMarkersRestampedHook(callback: () => void): void {
    markersRestampedHook = callback;
}

/** Records the marker's persistent clip-relative position. If its absolute
 * clock is still provisional, also retain the anchor for an in-session
 * re-stamp that updates the stored UTC. */
function captureMarkerAnchor(trip: Trip, record: MarkerAnnotation, utcMs: number): void {
    const contentSec = wallToContentSec(trip.timeline, utcMs / 1000);
    const { index: frameIndex, offsetInFrame } = contentToFrame(trip.timeline, contentSec);
    const segment = trip.timeline.segments.find((candidate) => candidate.frameIndex === frameIndex);
    if (!segment) return;
    const frame = trip.frames[frameIndex];
    const channel = frame ? frameChannels(frame)[0] : undefined;
    const candidate = frame && channel ? frame.channels[channel] : undefined;
    if (!candidate || !frame || !channel) return;
    const anchor = {
        fileIdentityKey: candidateIdentityKey(candidate),
        startUtc: Math.round(candidate.startUtc * 1000),
        offsetSec: frameMediaOffset(frame, channel) + Math.min(offsetInFrame, segment.durationSec),
    };
    record.anchor = anchor;
    // A trip can span independently opened sources. The notes file must live
    // beside the clip under the playhead, not unconditionally beside the
    // trip's first clip.
    record.folderId = folderIdForFileKey(anchor.fileIdentityKey, candidate.sourceKey);
    if (!tripAllCandidates(trip).some(candidateClockPending)) return;
    provisionalMarkerAnchors.set(record.id, {
        fileKey: anchor.fileIdentityKey,
        candidateKey: vendorFileKey(candidate),
        offsetSec: anchor.offsetSec,
    });
}

/**
 * Recomputes the UTC of provisionally-placed markers from their clip anchors
 * against the CURRENT trip timelines, re-saving the ones that moved. Call
 * after progressive clock refinement rebuilds affected trips, and once more with
 * `final` after the closing regroup sweep - that sweep reconciles trip
 * boundaries with the real durations and can shift startUtc again, so an
 * anchor consumed at per-trip metadata read would leave the marker on the
 * intermediate timeline. An anchor whose clip left the session is dropped as
 * unfixable; one whose clip still has pending metadata or telemetry waits for
 * the next pass. `final` releases every settled anchor. Returns how many moved.
 */
export function restampProvisionalMarkers(opts?: {
    final?: boolean;
    finalCandidates?: readonly VideoCandidate[];
}): number {
    if (provisionalMarkerAnchors.size === 0) return 0;
    // One index for the whole pass: anchors are held until the closing sweep,
    // so a per-anchor walk of every trip's every frame would repeat that scan
    // on each of the per-trip metadata read passes.
    const byCandidateKey = indexCandidatesBySessionKey();
    const pending = new Set<string>();
    let moved = 0;
    for (const [markerId, anchor] of [...provisionalMarkerAnchors]) {
        const marker = markersById.get(markerId);
        if (!marker) {
            // Deleted meanwhile - the tombstone's UTC does not matter.
            provisionalMarkerAnchors.delete(markerId);
            continue;
        }
        const located = byCandidateKey.get(anchor.candidateKey) ?? null;
        if (!located) {
            provisionalMarkerAnchors.delete(markerId);
            continue;
        }
        // Any sibling can still contribute fingerprint-wide clock evidence or
        // alter the trip boundary. Keep the anchor until the whole owning trip
        // is terminal, not merely until this one clip is ready.
        if (tripAllCandidates(located.trip).some(candidateClockPending)) {
            pending.add(markerId);
            continue;
        }
        const contentSec = markerAnchorContentSec(located.trip, located.candidate, anchor.offsetSec);
        if (contentSec === null) continue;
        const utcMs = Math.round(contentToWallUtc(located.trip.timeline, contentSec) * 1000);
        // Sub-half-second drift is invisible on the timeline - not worth a
        // store write and a notes-file flush.
        if (Math.abs(utcMs - marker.utc) < 500) continue;
        // A fresh updatedAt: the corrected UTC must LWW-win over the wrong
        // value that may already sit in the notes file or on another machine.
        persistRecord({
            ...marker,
            utc: utcMs,
            anchor: {
                fileIdentityKey: anchor.fileKey,
                startUtc: Math.round(located.candidate.startUtc * 1000),
                offsetSec: anchor.offsetSec,
            },
            updatedAt: nextUpdatedAt(marker),
        });
        moved++;
    }
    if (opts?.final) {
        const finalKeys = opts.finalCandidates
            ? new Set(opts.finalCandidates.map((candidate) => vendorFileKey(candidate)))
            : null;
        for (const [markerId, anchor] of provisionalMarkerAnchors) {
            if (!pending.has(markerId) && (!finalKeys || finalKeys.has(anchor.candidateKey))) {
                provisionalMarkerAnchors.delete(markerId);
            }
        }
    }
    if (moved > 0) markersRestampedHook?.();
    return moved;
}

/** Clears the in-memory indexes and provisional anchors between unit tests. */
export function _resetForTests(): void {
    recordsById.clear();
    tripMetasByAnchor.clear();
    markersById.clear();
    provisionalMarkerAnchors.clear();
    isStoreAvailable = true;
    hasOpenedStore = false;
    persistenceStatusHook = null;
    initialLoadSettled = Promise.resolve();
}

interface LocatedCandidate {
    trip: Trip;
    candidate: VideoCandidate;
}

/** Session candidate key -> the trip currently holding that clip. */
function indexCandidatesBySessionKey(): Map<string, LocatedCandidate> {
    const out = new Map<string, LocatedCandidate>();
    for (const trip of state.trips) {
        for (const candidate of tripAllCandidates(trip)) {
            const key = vendorFileKey(candidate);
            if (!out.has(key)) out.set(key, { trip, candidate });
        }
    }
    return out;
}

/** Replaces a marker's text. No-op for a deleted/unknown id. */
export function updateMarkerText(id: string, text: string): void {
    const marker = markersById.get(id);
    if (!marker) return;
    const updated = { ...marker, text: text.trim(), updatedAt: nextUpdatedAt(marker) };
    persistRecord(updated);
    userAnnotationHook?.(updated);
}

/** Tombstones a marker - the record survives for merge, the pin disappears.
 * A just-created marker cancelled from its editor is not a user write choice,
 * so that caller suppresses the user-edit hook. */
export function deleteMarker(id: string, userInitiated = true): void {
    const marker = markersById.get(id);
    if (!marker) return;
    const deleted = { ...marker, text: "", deleted: true, updatedAt: nextUpdatedAt(marker) };
    persistRecord(deleted);
    if (userInitiated) userAnnotationHook?.(deleted);
}

function nextUpdatedAt(record: AnnotationRecord): number {
    return Math.max(Date.now(), record.updatedAt + 1);
}

function compareTripMetaVersions(a: TripMetaAnnotation, b: TripMetaAnnotation): number {
    const contentOrder = compareAnnotationVersions(a, b);
    if (contentOrder !== 0 || a.id === b.id) return contentOrder;
    return a.id > b.id ? 1 : -1;
}

function nonEmptyFolderIdsForTrip(trip: Trip): Set<string> {
    const folderIds = folderIdsForTrip(trip);
    folderIds.delete("");
    return folderIds;
}

function persistRecord(record: AnnotationRecord): void {
    indexRecord(record);
    void saveAnnotation(record)
        .then(markPersistenceSuccess)
        .catch((err: unknown) => {
            log.warn("annotation save failed", { err: err instanceof Error ? err.message : String(err) });
            markPersistenceFailure(err, "save");
        });
    annotationsChangedHook?.();
}

// The sidecar layer (annotations-sidecar.ts) hangs off this hook - a direct
// import here would cycle (it reads records back through this module).
let annotationsChangedHook: (() => void) | null = null;

/** Registers the app-wide after-change hook. */
export function registerAnnotationsChangedHook(callback: () => void): void {
    annotationsChangedHook = callback;
}

// Fired ONLY by completed user-invoked edit paths - never by re-keying,
// re-stamping, a cancelled new marker, or merge bookkeeping. The blocking
// notes-storage choice hangs off this, so folder opens stay prompt-free.
let userAnnotationHook: ((record: AnnotationRecord) => void) | null = null;

/** Registers the after-user-edit hook. */
export function registerUserAnnotationHook(callback: (record: AnnotationRecord) => void): void {
    userAnnotationHook = callback;
}

/** Every record currently owned by one local folder, tombstones included. */
export function recordsForFolder(folderId: string): AnnotationRecord[] {
    return [...recordsById.values()].filter((record) => record.folderId === folderId);
}

/** Every annotation, tombstones included, for a portable notes file. */
export function allAnnotationRecords(): AnnotationRecord[] {
    return [...recordsById.values()];
}

/** Gives a copied backup its own local record ids when the same ids already
 * belong to another remembered folder. Without this, opening the second copy
 * would move the records out of the first folder because IndexedDB is keyed by
 * id alone. The deterministic id also prevents another clone on a failed write
 * followed by a reopen. */
export function scopeAnnotationRecordsToFolder(
    records: readonly AnnotationRecord[],
    folderId: string,
    liveFolderIds?: ReadonlySet<string>,
): AnnotationRecord[] {
    return records.map((record) => {
        const existing = recordsById.get(record.id);
        const hasLiveOtherOwner =
            existing !== undefined &&
            existing.folderId !== "" &&
            existing.folderId !== folderId &&
            (liveFolderIds === undefined || liveFolderIds.has(existing.folderId));
        if (!hasLiveOtherOwner) return record.folderId === folderId ? record : { ...record, folderId };

        const baseId = `copy:${folderId}:${record.id}`;
        let scopedId = baseId;
        let suffix = 2;
        for (;;) {
            const scoped = recordsById.get(scopedId);
            const scopedHasLiveOtherOwner =
                scoped !== undefined &&
                scoped.folderId !== "" &&
                scoped.folderId !== folderId &&
                (liveFolderIds === undefined || liveFolderIds.has(scoped.folderId));
            if (!scopedHasLiveOtherOwner) break;
            scopedId = `${baseId}:${suffix++}`;
        }
        return { ...record, id: scopedId, folderId };
    });
}

/**
 * Applies externally merged records (sidecar import): re-indexes them in
 * memory and batch-saves to IndexedDB. Returns how many records changed
 * user-visibly relative to the in-memory state (0 = nothing new, skip
 * re-render). A record whose only difference is folderId adopts the incoming
 * id silently: folderId is per-profile bookkeeping (restamped by the sidecar
 * reader), and without adoption a record imported on another machine - or
 * kept through a forget/re-remember cycle - would stay keyed to a dead id
 * and stop attaching to that folder. A portable import passes
 * preserveFolderIds to keep bindings that still refer to remembered folders;
 * dead bindings remain adoptable.
 */
export function applyMergedRecords(
    records: AnnotationRecord[],
    options?: { preserveFolderIds?: ReadonlySet<string> },
): number {
    let changed = 0;
    const toSave: AnnotationRecord[] = [];
    for (const record of records) {
        const existing = recordsById.get(record.id);
        const preserveFolder = existing && options?.preserveFolderIds?.has(existing.folderId);
        const incoming = preserveFolder ? { ...record, folderId: existing.folderId } : record;
        if (existing) {
            const localWins = compareAnnotationVersions(existing, incoming) >= 0;
            if (localWins) {
                if (!preserveFolder && existing.folderId !== incoming.folderId) {
                    const restamped = { ...existing, folderId: incoming.folderId };
                    indexRecord(restamped);
                    toSave.push(restamped);
                }
                continue;
            }
        }
        indexRecord(incoming);
        toSave.push(incoming);
        changed++;
    }
    if (toSave.length > 0) {
        void saveAnnotations(toSave)
            .then(markPersistenceSuccess)
            .catch((err: unknown) => {
                log.warn("merged annotation save failed", { err: err instanceof Error ? err.message : String(err) });
                markPersistenceFailure(err, "merge");
            });
    }
    return changed;
}

/** An import is durable only after the current versions commit, including retries. */
export async function persistImportedRecords(records: readonly AnnotationRecord[]): Promise<boolean> {
    const current = records.flatMap(({ id }) => {
        const record = recordsById.get(id);
        return record ? [record] : [];
    });
    if (current.length === 0) return true;
    try {
        await saveAnnotations(current);
        markPersistenceSuccess();
        return true;
    } catch (err) {
        log.warn("imported annotation save failed", { err: err instanceof Error ? err.message : String(err) });
        markPersistenceFailure(err, "import");
        return false;
    }
}

/**
 * Re-keys records onto `folderId` when they clearly belong to that folder
 * but are stranded on "" (created before the folder was remembered) or on a
 * dead id (the folder was forgotten and re-remembered under a fresh UUID).
 * Records owned by another still-existing folder are left alone. Trip
 * metadata re-associates by its anchor file; new markers do the same, while
 * older markers without an anchor fall back to UTC containment. Returns how
 * many records moved.
 */
export function rebindFolderAnnotations(folderId: string, existingFolderIds: ReadonlySet<string>): number {
    let rebound = 0;
    for (const record of [...recordsById.values()]) {
        if (record.folderId === folderId) continue;
        if (record.folderId !== "" && existingFolderIds.has(record.folderId)) continue;
        let belongs = false;
        if (record.kind === "tripMeta") {
            belongs = folderIdForFileKey(record.anchor.fileIdentityKey) === folderId;
            if (!belongs) {
                const owningTrip = uniqueTripForTripMetaRecord(record);
                const candidate = owningTrip ? tripMetaAnchorCandidate(record, owningTrip) : null;
                belongs = candidate ? folderIdForCandidate(candidate) === folderId : false;
            }
        } else if (record.kind === "marker") {
            if (record.anchor && folderIdForFileKey(record.anchor.fileIdentityKey) === folderId) {
                // The stable clip identity is enough even before ingest has
                // built state.trips. This is the folder-open order on restore.
                belongs = true;
            } else {
                const unownedRecord = record.folderId ? { ...record, folderId: "" } : record;
                const owningTrip = record.anchor
                    ? uniqueTripForMarkerAnchor(unownedRecord)
                    : uniqueTripForLegacyMarker(unownedRecord);
                if (owningTrip && record.anchor) {
                    const candidate = markerAnchorCandidate(record.anchor.fileIdentityKey, owningTrip);
                    belongs = candidate ? folderIdForCandidate(candidate) === folderId : false;
                } else if (owningTrip) {
                    belongs = folderIdAtMarkerUtc(owningTrip, record.utc) === folderId;
                }
            }
        }
        if (!belongs) continue;
        // updatedAt stays: re-keying is not a content edit and must not win
        // LWW against a real edit made elsewhere.
        persistRecord({ ...record, folderId });
        rebound++;
    }
    return rebound;
}

function folderIdForCandidate(candidate: VideoCandidate): string {
    return folderIdForFileKey(candidateIdentityKey(candidate), candidate.sourceKey);
}

function folderIdAtMarkerUtc(trip: Trip, utcMs: number): string {
    if (!trip.timeline?.segments.length) {
        const folderIds = nonEmptyFolderIdsForTrip(trip);
        return folderIds.size === 1 ? [...folderIds][0]! : "";
    }
    const contentSec = wallToContentSec(trip.timeline, utcMs / 1000);
    const { index } = contentToFrame(trip.timeline, contentSec);
    const frame = trip.frames[index];
    if (!frame) return "";
    const folderIds = new Set<string>();
    for (const candidate of Object.values(frame.channels)) {
        if (!candidate) continue;
        const candidateFolderId = folderIdForCandidate(candidate);
        if (candidateFolderId) folderIds.add(candidateFolderId);
    }
    return folderIds.size === 1 ? [...folderIds][0]! : "";
}

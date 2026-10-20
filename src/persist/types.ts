// Contracts for the persistent-folder feature: remembered folder handles, the
// versioned index cache and user annotations. Everything here is stored in
// IndexedDB (db.ts) and must stay structured-cloneable: no live File objects.
// FileSystemHandle objects are the one exception - browsers clone them
// natively, which is the whole mechanism this feature stands on.

import type { AccelSample, GpsRecord } from "../parsers/types.js";
import type { IndexedMp4, IndexerRepair } from "../workers/indexer-protocol.js";

export { RECORDING_METADATA_CACHE_REVISION } from "./cache-revisions.generated.js";

/**
 * Stored-record shape only. Parser compatibility is carried by each embedded
 * GPS artifact; container metadata has its own revision. Derived candidate
 * fields and external sidecars are never persisted.
 */
export const INDEX_CACHE_FORMAT = 2;

/**
 * Cheap cross-session identity of a file inside a picked folder, matchable
 * from directory enumeration alone (no byte reads). No content hash on
 * purpose: dashcams loop-record onto reused filenames, and (size,
 * lastModified) catches an overwrite at the same path. Mirrors the in-session
 * This intentionally omits vendorFileKey's session-only source scope so the
 * same remembered folder can reuse entries after a reload.
 */
export interface FileIdentity {
    /** Path relative to the remembered folder root, filename included. */
    relativePath: string;
    size: number;
    lastModified: number;
}

/**
 * A folder the user explicitly asked to remember. The handle is the live
 * FileSystemDirectoryHandle persisted via structured clone; permission on it
 * must be re-verified on every restore (queryPermission does NOT check that
 * the folder still exists - only an actual read does). An unavailable folder
 * (unplugged drive, revoked permission) stays in the list greyed out; it is
 * never auto-deleted.
 */
export interface RememberedFolder {
    id: string;
    handle: FileSystemDirectoryHandle;
    /** Display name, captured from handle.name at remember time. */
    label: string;
    addedAt: number;
    /** Orders the folder list and the landing chips, most recent first. */
    lastOpenedAt: number;
}

/** Last notes file used by the app, independently of remembered folders.
 * A discovered handle is read-only until a file picker returns an independent
 * handle for it, keeping every write grant scoped to one file. */
export interface NotesFileRecord {
    id: "global";
    handle?: FileSystemFileHandle;
    access?: "file" | "derived";
    /** The user explicitly chose browser storage instead of a notes file. */
    storage?: "browser";
}

export interface CachedRecordingMetadata {
    revision: string;
    indexed: IndexedMp4;
    repair?: IndexerRepair;
}

/** Session ownership, external-track choices, and post-parse clock corrections
 * are rebuilt on restore rather than persisted with byte-derived GPS. */
export type CachedEmbeddedGpsRecord = Omit<
    GpsRecord,
    | "videoKey"
    | "recordingAssociation"
    | "timeAssociation"
    | "externalTrack"
    | "externalTrackKey"
    | "localClockOffsetAppliedSec"
>;

export interface CachedParsedEmbeddedGps {
    status: "parsed";
    /** Winner plus every primitive that preceded it in dispatch order. */
    dispatchRevision: string;
    extractorId: string;
    /** Persistent identity of the file whose bytes were parsed. Differs from
     *  the owning entry for cloneAcrossGroup followers. */
    sourceIdentityKey: string;
    records: CachedEmbeddedGpsRecord[];
    videoStartUtcHint?: number;
    localClockOffsetHintSec?: number;
    accelSamples?: AccelSample[];
}

export interface CachedNoEmbeddedGps {
    status: "none";
    /** Full registry revision: every primitive participated in this negative. */
    dispatchRevision: string;
}

export type CachedEmbeddedGps = CachedParsedEmbeddedGps | CachedNoEmbeddedGps;

/** One cached indexing result, keyed by the file identity. */
export interface CachedFileIndex {
    /** fileIdentityKey() of the source file. */
    identityKey: string;
    /** INDEX_CACHE_FORMAT at write time; a mismatch means legacy data. */
    cacheFormat: number;
    /** Last write OR last cache hit (refreshed on use, so the prune evicts
     *  what is not being opened, not what was merely written first). */
    savedAt: number;
    /** Approximate stored size (see approxEntryBytes) - the unit of the
     *  volume-based prune. Absent on entries written before it existed;
     *  those are evicted first when the prune runs. */
    bytes?: number;
    metadata: CachedRecordingMetadata;
    /** Absent means embedded extraction was not completed (for example a
     *  sidecar already supplied GPS, or a heavy scan is still pending). */
    embeddedGps?: CachedEmbeddedGps;
}

/**
 * Anchor for trip-level annotations. Trips are derived entities - regrouping
 * (parser version bump, trip-gap setting) rebuilds them - so annotations
 * anchor to the identity of the trip's first video file plus its start time,
 * and re-attach to whichever trip contains that file after a restore.
 */
export interface TripAnchor {
    /** fileIdentityKey() of the trip's first video file. */
    fileIdentityKey: string;
    /** Trip start, epoch ms UTC. */
    startUtc: number;
}

interface AnnotationBase {
    id: string;
    /** RememberedFolder.id the annotation belongs to. */
    folderId: string;
    /** Last-write-wins merge key across IndexedDB and the sidecar copy. */
    updatedAt: number;
    /** Tombstone: deletions must survive merging with an older copy, so a
     *  deleted annotation keeps its record with this flag instead of being
     *  removed from the store. */
    deleted: boolean;
}

/** User-editable trip metadata: custom name, free-text note, favorite flag. */
export interface TripMetaAnnotation extends AnnotationBase {
    kind: "tripMeta";
    anchor: TripAnchor;
    name?: string;
    note?: string;
    isFavorite?: boolean;
}

/** A point on the timeline. UTC remains the legacy/fallback position; new
 * records also carry a stable clip-relative anchor for restore and regroup. */
export interface MarkerAnnotation extends AnnotationBase {
    kind: "marker";
    utc: number;
    text: string;
    /** Stable clip-relative location for portable restore. Older v1 records
     * omit it and continue to resolve by folder + UTC. */
    anchor?: {
        fileIdentityKey: string;
        /** Anchored clip start when the marker was created, epoch ms UTC. */
        startUtc: number;
        /** Content seconds from the anchored clip's segment start. */
        offsetSec: number;
    };
}

export type AnnotationRecord = TripMetaAnnotation | MarkerAnnotation;

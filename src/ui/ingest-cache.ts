// Cross-session artifact-cache glue for progressive ingest. The cache stores
// only expensive byte-derived facts: container metadata and raw embedded GPS.
// Filename classification, external inputs, clocks, and trip grouping always
// run under the current code after a hit.

import { extendArray } from "../array-extend.js";
import { recordsForVideo, type VideoAssociationIndex } from "../gps-association.js";
import { createLogger } from "../log.js";
import { cameraFingerprint } from "../parsers/camera-fingerprint.js";
import { classifyFilenameTime } from "../parsers/filename/index.js";
import { embeddedGpsDispatchRevision, noEmbeddedGpsDispatchRevision } from "../parsers/primitives/cache-revisions.js";
import type { ClassifiedFile, DispatchedEmbeddedGpsResult } from "../parsers/registry.js";
import { shouldTryEmbeddedGps } from "../parsers/gps-source-hints.js";
import type { AccelSample, GpsRecord, ParsedLog } from "../parsers/types.js";
import { fileIdentityKey, fileIdentityOf } from "../persist/identity.js";
import {
    buildCacheEntry,
    getIndexCacheEntries,
    putIndexCacheEntries,
    touchIndexCacheEntries,
} from "../persist/index-cache.js";
import {
    type CachedEmbeddedGps,
    type CachedFileIndex,
    type CachedRecordingMetadata,
    type FileIdentity,
    RECORDING_METADATA_CACHE_REVISION,
} from "../persist/types.js";
import { deriveStartUtc, type VideoCandidate } from "../trips.js";
import type { IndexedMp4, IndexerRepair } from "../workers/indexer-protocol.js";
import { buildEmbeddedGpsCacheArtifactUpdates } from "./ingest-cache-artifacts.js";
import {
    applyIndexedMetadata,
    buildProvisionalCandidate,
    filenameClassifierFields,
    vendorFileKey,
} from "./ingest-candidate.js";

const log = createLogger("ingest-cache");

// Completed artifacts from this session. Progressive metadata and deferred GPS
// settle at different times, so writes assemble the latest pair by persistent
// file identity. Raw GPS is cloned before current-session clock/accel passes can
// mutate it.
const metadataByIdentity = new Map<string, CachedRecordingMetadata>();
const embeddedGpsByIdentity = new Map<string, CachedEmbeddedGps>();
const writeBlockLeasesByIdentity = new Map<string, Set<symbol>>();
let writeBlockLeaseByCandidate = new WeakMap<VideoCandidate, { identityKey: string; token: symbol }>();

function candidateIdentityKey(candidate: VideoCandidate): string {
    return fileIdentityKey({
        relativePath: candidate.relativePath,
        size: candidate.file.size,
        lastModified: candidate.file.lastModified,
    });
}

/** Binds one collision/invalid-input write guard to the live candidate that
 * will eventually either finish or remain retryable in state. */
export function bindIndexCacheWriteBlock(candidate: VideoCandidate, token: symbol): void {
    const identityKey = candidateIdentityKey(candidate);
    let leases = writeBlockLeasesByIdentity.get(identityKey);
    if (!leases) {
        leases = new Set();
        writeBlockLeasesByIdentity.set(identityKey, leases);
    }
    leases.add(token);
    writeBlockLeaseByCandidate.set(candidate, { identityKey, token });
}

/** Releases only this candidate's guard; sibling batches sharing the cheap
 * identity remain blocked until every owning candidate has settled. */
export function releaseIndexCacheWriteBlocks(candidates: Iterable<VideoCandidate>): void {
    for (const candidate of candidates) {
        const lease = writeBlockLeaseByCandidate.get(candidate);
        if (!lease) continue;
        writeBlockLeaseByCandidate.delete(candidate);
        const leases = writeBlockLeasesByIdentity.get(lease.identityKey);
        if (!leases) continue;
        leases.delete(lease.token);
        if (leases.size === 0) writeBlockLeasesByIdentity.delete(lease.identityKey);
    }
}

/** Keys whose metadata snapshot must survive this write because some GPS work
 * still owns it. `ownedInflightKeys` removes the caller's already-completed
 * light-scan reference while preserving a concurrent deferred owner's ref. */
export function cacheRetentionKeysForGpsWork(
    pendingKeys: Iterable<string>,
    inflight: ReadonlyMap<string, number>,
    ownedInflightKeys: ReadonlySet<string> = new Set(),
): Set<string> {
    const retained = new Set(pendingKeys);
    for (const [key, count] of inflight) {
        const ownedHere = ownedInflightKeys.has(key) ? 1 : 0;
        if (count > ownedHere) retained.add(key);
    }
    return retained;
}

/** Records byte-derived metadata before it is applied to the live candidate. */
export function registerCandidateMetadata(
    identity: FileIdentity,
    indexed: IndexedMp4,
    repair: IndexerRepair | undefined,
): { identityKey: string; metadata: CachedRecordingMetadata } {
    const identityKey = fileIdentityKey(identity);
    const metadata: CachedRecordingMetadata = {
        revision: RECORDING_METADATA_CACHE_REVISION,
        indexed,
    };
    if (repair) metadata.repair = repair;
    metadataByIdentity.set(identityKey, metadata);
    // A fresh metadata pass starts a new parse attempt for this identity. Do
    // not let a GPS artifact left in this module from an earlier ingest/reset
    // hitch a ride on the new write if an external log now suppresses embedded
    // parsing or the current embedded parse fails before publishing a result.
    embeddedGpsByIdentity.delete(identityKey);
    return { identityKey, metadata };
}

/** Releases snapshots owned by an aborted/failed batch without deleting a
 * newer batch's replacement for the same persistent identity. */
export function releaseIndexCacheSnapshots(
    snapshots: Iterable<{ identityKey: string; metadata: CachedRecordingMetadata }>,
): void {
    for (const { identityKey, metadata } of snapshots) {
        if (metadataByIdentity.get(identityKey) !== metadata) continue;
        metadataByIdentity.delete(identityKey);
        embeddedGpsByIdentity.delete(identityKey);
    }
}

/**
 * Captures raw per-file embedded results before they enter mutable session
 * state. Excluded, errored, and heavy-deferred files deliberately keep no GPS
 * artifact, so the next open retries instead of blessing a partial negative.
 */
export function registerEmbeddedGpsCacheArtifacts(
    targets: readonly ClassifiedFile[],
    result: DispatchedEmbeddedGpsResult,
    excludedKeys: ReadonlySet<string> = new Set(),
): void {
    for (const [identityKey, artifact] of buildEmbeddedGpsCacheArtifactUpdates(targets, result, excludedKeys)) {
        if (artifact) embeddedGpsByIdentity.set(identityKey, artifact);
        else embeddedGpsByIdentity.delete(identityKey);
    }
}

export { buildEmbeddedGpsCacheArtifactUpdates } from "./ingest-cache-artifacts.js";

export interface IndexCacheExternalInputs {
    gpsLog: ParsedLog | null;
    extractorByFileKey: readonly ReadonlyMap<string, string>[];
    /** False after any log/sidecar read failed: artifacts may still be read,
     *  but this ingest must not replace the last known-good cache entry. */
    areValid: boolean;
}

export interface IndexCachePartition {
    cachedCandidates: VideoCandidate[];
    /** Current metadata for files whose embedded artifact alone must rerun. */
    cachedMetadataByFileKey: Map<string, CachedRecordingMetadata>;
    /** Raw embedded records restored into candidates and awaiting GpsLog merge. */
    restoredEmbeddedRecords: GpsRecord[];
    /** Cached high-rate accel streams for the current post-derive merge. */
    restoredEmbeddedAccelByFileKey: Map<string, AccelSample[]>;
    /** Per-run leases that forbid ambiguous/invalid-input cache writes. */
    writeBlockLeaseByFileKey: Map<string, symbol>;
    misses: ClassifiedFile[];
    cacheAvailable: boolean;
}

function emptyPartition(misses: ClassifiedFile[], cacheAvailable: boolean): IndexCachePartition {
    return {
        cachedCandidates: [],
        cachedMetadataByFileKey: new Map(),
        restoredEmbeddedRecords: [],
        restoredEmbeddedAccelByFileKey: new Map(),
        writeBlockLeaseByFileKey: new Map(),
        misses,
        cacheAvailable,
    };
}

function cacheKeyOf(cf: ClassifiedFile): string {
    return fileIdentityKey(fileIdentityOf(cf.file.file, cf.file.relativePath));
}

/** Whether two distinct session files collapse onto one cheap persistent key. */
export function hasIndexCacheIdentityCollision(video: ClassifiedFile, videos: VideoAssociationIndex): boolean {
    const persistentKey = cacheKeyOf(video);
    const sessionKey = vendorFileKey(video.file);
    return (videos.videosByFilename.get(video.file.file.name) ?? []).some(
        (peer) =>
            vendorFileKey(peer) !== sessionKey &&
            fileIdentityKey(fileIdentityOf(peer.file, peer.relativePath)) === persistentKey,
    );
}

/** Pure compatibility gate, exported so revision behavior stays unit-tested. */
export function isIndexCacheEntryCompatible(
    entry: CachedFileIndex,
    needsEmbeddedGps: boolean,
    availableIdentityKeys: ReadonlySet<string>,
): boolean {
    if (!isCurrentRecordingMetadata(entry.metadata)) return false;
    if (!needsEmbeddedGps) return true;
    const embedded = entry.embeddedGps;
    return isCurrentEmbeddedGps(embedded, availableIdentityKeys);
}

function isFiniteNullableNumber(value: unknown): value is number | null {
    return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isCurrentEmbeddedGps(value: unknown, availableIdentityKeys: ReadonlySet<string>): value is CachedEmbeddedGps {
    if (typeof value !== "object" || value === null) return false;
    const embedded = value as Partial<CachedEmbeddedGps>;
    if (embedded.status === "none") {
        return embedded.dispatchRevision === noEmbeddedGpsDispatchRevision();
    }
    if (
        embedded.status !== "parsed" ||
        typeof embedded.extractorId !== "string" ||
        typeof embedded.sourceIdentityKey !== "string" ||
        embedded.dispatchRevision !== embeddedGpsDispatchRevision(embedded.extractorId) ||
        !availableIdentityKeys.has(embedded.sourceIdentityKey) ||
        !Array.isArray(embedded.records) ||
        !embedded.records.every((record) => {
            if (typeof record !== "object" || record === null) return false;
            const raw = record as Record<string, unknown>;
            return (
                isFiniteNumber(raw.unixSeconds) &&
                typeof raw.active === "boolean" &&
                isFiniteNumber(raw.lat) &&
                isFiniteNumber(raw.lon) &&
                isFiniteNumber(raw.bearingDeg) &&
                isFiniteNumber(raw.speedMs) &&
                (raw.speedSource === undefined ||
                    raw.speedSource === "measured" ||
                    raw.speedSource === "estimated" ||
                    raw.speedSource === "unavailable") &&
                (raw.trackSegment === undefined ||
                    (isFiniteNumber(raw.trackSegment) &&
                        Number.isInteger(raw.trackSegment) &&
                        raw.trackSegment >= 0)) &&
                isFiniteNumber(raw.accelXg) &&
                isFiniteNumber(raw.accelYg) &&
                isFiniteNumber(raw.accelZg) &&
                typeof raw.mp4Filename === "string" &&
                (raw.timeUnsynced === undefined || typeof raw.timeUnsynced === "boolean") &&
                (raw.relStartSeconds === undefined || isFiniteNumber(raw.relStartSeconds)) &&
                raw.videoKey === undefined &&
                raw.trackSegmentSource === undefined &&
                raw.recordingAssociation === undefined &&
                raw.timeAssociation === undefined &&
                raw.externalTrack === undefined &&
                raw.externalTrackKey === undefined &&
                raw.localClockOffsetAppliedSec === undefined
            );
        }) ||
        (embedded.videoStartUtcHint !== undefined && !isFiniteNumber(embedded.videoStartUtcHint)) ||
        (embedded.localClockOffsetHintSec !== undefined && !isFiniteNumber(embedded.localClockOffsetHintSec)) ||
        (embedded.accelSamples !== undefined &&
            (!Array.isArray(embedded.accelSamples) ||
                !embedded.accelSamples.every(
                    (sample) =>
                        typeof sample === "object" &&
                        sample !== null &&
                        isFiniteNumber(sample.msSinceStart) &&
                        isFiniteNumber(sample.accelXg) &&
                        isFiniteNumber(sample.accelYg) &&
                        isFiniteNumber(sample.accelZg),
                )))
    ) {
        return false;
    }
    return true;
}

/** A corrupt cache entry may cost a re-index, but must never poison ingest. */
export function isCurrentRecordingMetadata(value: unknown): value is CachedRecordingMetadata {
    if (typeof value !== "object" || value === null) return false;
    const metadata = value as Partial<CachedRecordingMetadata>;
    const indexed = metadata.indexed as Partial<IndexedMp4> | undefined;
    if (
        metadata.revision !== RECORDING_METADATA_CACHE_REVISION ||
        typeof indexed !== "object" ||
        indexed === null ||
        typeof indexed.durationSec !== "number" ||
        !Number.isFinite(indexed.durationSec) ||
        indexed.durationSec < 0 ||
        (indexed.createdUtc !== null &&
            (!(indexed.createdUtc instanceof Date) || !Number.isFinite(indexed.createdUtc.getTime()))) ||
        !isNullableString(indexed.codec) ||
        !isNullableString(indexed.codecParam) ||
        !isNullableString(indexed.videoCodecString) ||
        !([0, 90, 180, 270] as unknown[]).includes(indexed.rotation) ||
        !isFiniteNullableNumber(indexed.width) ||
        !isFiniteNullableNumber(indexed.height) ||
        !isFiniteNullableNumber(indexed.fps) ||
        typeof indexed.needsHevcRemux !== "boolean" ||
        typeof indexed.audioNeedsTranscode !== "boolean"
    ) {
        return false;
    }
    if (indexed.audio !== null) {
        if (typeof indexed.audio !== "object" || indexed.audio === null) return false;
        const audio = indexed.audio as Partial<NonNullable<IndexedMp4["audio"]>>;
        if (
            !isNullableString(audio.codec) ||
            typeof audio.channels !== "number" ||
            !Number.isFinite(audio.channels) ||
            typeof audio.sampleRate !== "number" ||
            !Number.isFinite(audio.sampleRate)
        ) {
            return false;
        }
    }
    const repair = metadata.repair;
    if (repair !== undefined) {
        if (
            typeof repair !== "object" ||
            repair === null ||
            !(repair.patchedMoov instanceof Uint8Array) ||
            !Number.isSafeInteger(repair.moovFileStart) ||
            !Number.isSafeInteger(repair.moovFileEnd) ||
            repair.moovFileStart < 0 ||
            repair.moovFileEnd < repair.moovFileStart ||
            repair.patchedMoov.byteLength !== repair.moovFileEnd - repair.moovFileStart ||
            !Array.isArray(repair.phantomNeutralized) ||
            !repair.phantomNeutralized.every((handler) => typeof handler === "string")
        ) {
            return false;
        }
        if (
            repair.hvcc !== null &&
            (typeof repair.hvcc !== "object" ||
                typeof repair.hvcc.needsHevcRemux !== "boolean" ||
                (repair.hvcc.reason !== "header" && repair.hvcc.reason !== "arrays") ||
                !isNullableString(repair.hvcc.videoCodecString))
        ) {
            return false;
        }
    }
    return true;
}

/** Ensures a cached repair can be spliced into this concrete file. */
export function isRecordingMetadataApplicableToFile(metadata: unknown, fileSize: number): boolean {
    if (!isCurrentRecordingMetadata(metadata)) return false;
    return metadata.repair === undefined || metadata.repair.moovFileEnd <= fileSize;
}

function currentExternalExtractorIds(
    videoKey: string,
    extractorMaps: readonly ReadonlyMap<string, string>[],
): string[] {
    const ids = new Set<string>();
    for (const map of extractorMaps) {
        const id = map.get(videoKey);
        if (id) ids.add(id);
    }
    return [...ids];
}

export function hydrateCandidate(
    file: ClassifiedFile,
    entry: CachedFileIndex,
    externalRecords: GpsRecord[],
    extractorMaps: readonly ReadonlyMap<string, string>[],
): { candidate: VideoCandidate; embeddedRecords: GpsRecord[]; accel: AccelSample[] | null } {
    if (!isRecordingMetadataApplicableToFile(entry.metadata, file.file.file.size)) {
        throw new Error("cached recording repair is outside the current file");
    }
    const freshVideoKey = vendorFileKey(file.file);
    const needsEmbeddedGps = shouldTryEmbeddedGps(file.file, externalRecords.length > 0);
    const embedded = needsEmbeddedGps && entry.embeddedGps?.status === "parsed" ? entry.embeddedGps : null;
    const embeddedRecords: GpsRecord[] = embedded
        ? embedded.records.map((record) => ({ ...record, videoKey: freshVideoKey }))
        : [];
    const records = externalRecords.length > 0 ? externalRecords : embeddedRecords;
    const fingerprint = cameraFingerprint(file.file);
    const classifierFields = filenameClassifierFields(file.file);
    const appliedExtractors = currentExternalExtractorIds(freshVideoKey, extractorMaps);
    if (embedded && !appliedExtractors.includes(embedded.extractorId)) appliedExtractors.push(embedded.extractorId);
    const derived = deriveStartUtc({
        file: file.file,
        fingerprint,
        createdUtc: entry.metadata.indexed.createdUtc,
        durationSec: entry.metadata.indexed.durationSec,
        records,
        fingerprintTz: null,
        parseFilenameLocalTime: classifyFilenameTime,
        preciseFilenameOffsetSec: null,
        embeddedStartUtcHint: embedded?.videoStartUtcHint ?? null,
        isTimelapse: classifierFields.isTimelapse,
        wallDurationSec: null,
    });
    const candidate = buildProvisionalCandidate({
        file: file.file,
        fingerprint,
        startUtc: derived.startUtc,
        startSource: derived.source,
        cameraTzSec: null,
        durationSec: entry.metadata.indexed.durationSec,
        records,
        appliedExtractors,
        classifierFields,
    });
    candidate.embeddedStartUtcHint = embedded?.videoStartUtcHint ?? null;
    candidate.localClockOffsetHintSec = embedded?.localClockOffsetHintSec ?? null;
    applyIndexedMetadata(candidate, entry.metadata.indexed, entry.metadata.repair);
    return {
        candidate,
        embeddedRecords,
        accel: embedded?.accelSamples?.map((sample) => ({ ...sample })) ?? null,
    };
}

export type IndexCacheReuse = "full" | "metadata" | "none";

/** Decides artifact reuse without touching IndexedDB or live candidates. */
export function indexCacheReuseKind(
    entry: CachedFileIndex | undefined,
    needsEmbeddedGps: boolean,
    availableIdentityKeys: ReadonlySet<string>,
    deferForLooseGpx = false,
): IndexCacheReuse {
    if (!entry || !isCurrentRecordingMetadata(entry.metadata)) return "none";
    // Loose-GPX selection is based on the provisional, pre-index trip layout.
    // Keep that input identical on cold and warm ingest: no cached file may
    // contribute mvhd duration/timing until after the resolver has run.
    if (deferForLooseGpx) return "metadata";
    return isIndexCacheEntryCompatible(entry, needsEmbeddedGps, availableIdentityKeys) ? "full" : "metadata";
}

/** Splits new videos into current artifact hits and files needing byte reads. */
export async function partitionByIndexCache(
    videos: ClassifiedFile[],
    classified: readonly ClassifiedFile[],
    videoAssociation: VideoAssociationIndex,
    external: IndexCacheExternalInputs,
): Promise<IndexCachePartition> {
    if (videos.length === 0) return emptyPartition(videos, true);
    const collisionKeys = new Set<string>();
    for (const video of videos) {
        const key = cacheKeyOf(video);
        if (hasIndexCacheIdentityCollision(video, videoAssociation)) collisionKeys.add(key);
    }
    let entries: Map<string, CachedFileIndex>;
    try {
        entries = await getIndexCacheEntries(videos.map(cacheKeyOf));
    } catch (err) {
        log.warn("index cache unavailable, running full pipeline", {
            err: err instanceof Error ? err.message : String(err),
        });
        const unavailable = emptyPartition(videos, false);
        for (const video of videos) {
            const identityKey = cacheKeyOf(video);
            if (!external.areValid || collisionKeys.has(identityKey)) {
                unavailable.writeBlockLeaseByFileKey.set(vendorFileKey(video.file), Symbol(identityKey));
            }
        }
        return unavailable;
    }

    const availableIdentityKeys = new Set(
        classified
            .filter((file) => file.role === "video" && !hasIndexCacheIdentityCollision(file, videoAssociation))
            .map((file) => cacheKeyOf(file)),
    );
    const cachedCandidates: VideoCandidate[] = [];
    const cachedMetadataByFileKey = new Map<string, CachedRecordingMetadata>();
    const restoredEmbeddedRecords: GpsRecord[] = [];
    const restoredEmbeddedAccelByFileKey = new Map<string, AccelSample[]>();
    const writeBlockLeaseByFileKey = new Map<string, symbol>();
    const misses: ClassifiedFile[] = [];
    const hitKeys: string[] = [];
    const deferEmbeddedForLooseGpx = classified.some(
        (file) => file.role === "unknown" && /\.gpx$/i.test(file.file.file.name),
    );
    for (const file of videos) {
        const identityKey = cacheKeyOf(file);
        const entry = entries.get(identityKey);
        const externalRecords = external.gpsLog ? recordsForVideo(external.gpsLog, file.file, videoAssociation) : [];
        const needsEmbeddedGps = shouldTryEmbeddedGps(file.file, externalRecords.length > 0);
        const reuse =
            collisionKeys.has(identityKey) ||
            (entry !== undefined && !isRecordingMetadataApplicableToFile(entry.metadata, file.file.file.size))
                ? "none"
                : indexCacheReuseKind(entry, needsEmbeddedGps, availableIdentityKeys, deferEmbeddedForLooseGpx);
        if (reuse === "none" || !entry) {
            misses.push(file);
            continue;
        }
        if (reuse === "metadata") {
            // Metadata and GPS are independent artifacts: a parser change or
            // unfinished heavy scan reruns only embedded extraction. Loose GPX
            // assignment also takes this cold-equivalent path so a warm cache
            // cannot disable a choice that was available on first ingest.
            misses.push(file);
            cachedMetadataByFileKey.set(vendorFileKey(file.file), entry.metadata);
            hitKeys.push(identityKey);
            continue;
        }
        // Only hydration may fail over to a miss. Publishing the hit stays
        // outside the try: a throw after cachedCandidates.push would leave the
        // same file both restored and queued for re-indexing.
        let restored: ReturnType<typeof hydrateCandidate>;
        try {
            restored = hydrateCandidate(file, entry, externalRecords, external.extractorByFileKey);
        } catch (err) {
            log.warn("invalid index cache entry, re-indexing file", {
                file: file.file.file.name,
                err: err instanceof Error ? err.message : String(err),
            });
            misses.push(file);
            continue;
        }
        cachedCandidates.push(restored.candidate);
        // A whole-card log restores past the engine's spread-argument ceiling.
        extendArray(restoredEmbeddedRecords, restored.embeddedRecords);
        if (restored.accel) restoredEmbeddedAccelByFileKey.set(vendorFileKey(file.file), restored.accel);
        hitKeys.push(identityKey);
    }
    if (hitKeys.length > 0) {
        log.info("index cache hits", { hits: hitKeys.length, total: videos.length });
        void touchIndexCacheEntries(hitKeys).catch(() => {});
    }
    for (const miss of misses) {
        const identityKey = cacheKeyOf(miss);
        if (!external.areValid || collisionKeys.has(identityKey)) {
            writeBlockLeaseByFileKey.set(vendorFileKey(miss.file), Symbol(identityKey));
        }
    }
    return {
        cachedCandidates,
        cachedMetadataByFileKey,
        restoredEmbeddedRecords,
        restoredEmbeddedAccelByFileKey,
        writeBlockLeaseByFileKey,
        misses,
        cacheAvailable: true,
    };
}

/** Writes completed artifacts, then releases their potentially dense session
 *  snapshots. Metadata explicitly retained for pending heavy/error retries is
 *  released by the later deferred write. */
export function scheduleIndexCacheWrite(
    candidates: VideoCandidate[],
    retainMetadataForVideoKeys: ReadonlySet<string> = new Set(),
): void {
    const entries: CachedFileIndex[] = [];
    const releases: Array<{
        candidate: VideoCandidate;
        identityKey: string;
        metadata: CachedRecordingMetadata | undefined;
        embeddedGps: CachedEmbeddedGps | undefined;
        retain: boolean;
    }> = [];
    for (const candidate of candidates) {
        const videoKey = vendorFileKey(candidate);
        const identityKey = candidateIdentityKey(candidate);
        const metadata = metadataByIdentity.get(identityKey);
        const embeddedGps = embeddedGpsByIdentity.get(identityKey);
        const writeBlocked = (writeBlockLeasesByIdentity.get(identityKey)?.size ?? 0) > 0;
        releases.push({
            candidate,
            identityKey,
            metadata,
            embeddedGps,
            retain: retainMetadataForVideoKeys.has(videoKey),
        });
        if (writeBlocked) continue;
        if (!metadata) continue;
        entries.push(buildCacheEntry(identityKey, metadata, embeddedGps));
    }

    const releaseCompletedArtifacts = (): void => {
        for (const release of releases) {
            if (release.retain) continue;
            if (release.metadata && metadataByIdentity.get(release.identityKey) === release.metadata) {
                metadataByIdentity.delete(release.identityKey);
            }
            if (release.embeddedGps && embeddedGpsByIdentity.get(release.identityKey) === release.embeddedGps) {
                embeddedGpsByIdentity.delete(release.identityKey);
            }
            releaseIndexCacheWriteBlocks([release.candidate]);
        }
    };
    if (entries.length === 0) {
        releaseCompletedArtifacts();
        return;
    }
    void putIndexCacheEntries(entries)
        .then(() => log.info("index cache written", { entries: entries.length }))
        .catch((err: unknown) => {
            log.warn("index cache write failed", { err: err instanceof Error ? err.message : String(err) });
        })
        .finally(releaseCompletedArtifacts);
}

/** Clears module-owned session registries between isolated unit tests. */
export function _resetForTests(): void {
    metadataByIdentity.clear();
    embeddedGpsByIdentity.clear();
    writeBlockLeasesByIdentity.clear();
    writeBlockLeaseByCandidate = new WeakMap();
}

/** Inspect one private snapshot without exposing mutable registries. */
export function _cacheMetadataForTests(identityKey: string): CachedRecordingMetadata | undefined {
    return metadataByIdentity.get(identityKey);
}

export function _isIndexCacheWriteBlockedForTests(candidate: VideoCandidate): boolean {
    return (writeBlockLeasesByIdentity.get(candidateIdentityKey(candidate))?.size ?? 0) > 0;
}

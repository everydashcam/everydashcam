import { mergeIntoGpsLog } from "./parser.js";
import {
    mai70NameCore,
    openpilotLookupCores,
    openpilotVideoCores,
    parseOpenpilotFileName,
} from "./parsers/filename/_patterns.js";
import { classifyFilenameRecordingKey } from "./parsers/filename/index.js";
import type { GpsRecord, ParsedLog, VendorFile, VideoTimingHint, VideoWithRecordingCopies } from "./parsers/types.js";
import type { VideoCandidate } from "./trips.js";
import { vendorFileKey } from "./vendor-file-key.js";

export interface VideoAssociationIndex {
    videosByFilename: ReadonlyMap<string, readonly VendorFile[]>;
    // 70mai logs can name a clip by another mode prefix, no prefix at all, or
    // with bytes after ".MP4" (see mai70NameCore); an openpilot log predicts
    // a file's name in its own layout, without its letter case or download
    // suffix, and names its segment's full-res road file when only another
    // camera of the segment may be loaded (openpilotVideoCores).
    // Exact names always win; cores are fallback keys, so these rows still get a
    // concrete owner and extractor attribution instead of a later name-only
    // rebind.
    videosByNameCore: ReadonlyMap<string, readonly VendorFile[]>;
    canonicalByFileKey: ReadonlyMap<string, VideoWithRecordingCopies>;
}

export interface RecordingStartAssociationResult {
    log: ParsedLog;
    boundRecords: number;
    boundVideos: number;
}

// ISO BMFF creation_time is integer-second resolution on the cameras that
// write recording-scoped logs. One second covers rounding without letting
// adjacent clips claim the same section.
const RECORDING_START_TOLERANCE_SEC = 1;

function sameRecordingAssociation(a: NonNullable<GpsRecord["recordingAssociation"]>, b: typeof a): boolean {
    return a.startUtc === b.startUtc && a.extractorId === b.extractorId && a.sourceKey === b.sourceKey;
}

interface RecordingStartIndex {
    sources: Set<string | undefined>;
    bySecond: Map<number, VideoCandidate[]>;
}

function indexRecordingStarts(candidates: readonly VideoCandidate[]): RecordingStartIndex {
    const sources = new Set<string | undefined>();
    const bySecond = new Map<number, VideoCandidate[]>();
    for (const candidate of candidates) {
        // Include sources still waiting for metadata so another card cannot claim their logs.
        sources.add(candidate.sourceKey);
        const createdMs = candidate.createdUtc?.getTime();
        if (createdMs === undefined || !Number.isFinite(createdMs)) continue;
        // An explicitly assigned external route must never absorb a late recording log.
        if (candidate.records.some((record) => record.externalTrack)) continue;
        const second = Math.floor(createdMs / 1000);
        const bucket = bySecond.get(second);
        if (bucket) bucket.push(candidate);
        else bySecond.set(second, [candidate]);
    }
    return { sources, bySecond };
}

function findRecordingStartCandidate(
    index: RecordingStartIndex,
    hint: NonNullable<GpsRecord["recordingAssociation"]>,
): VideoCandidate | null {
    const sameSourceOnly = hint.sourceKey !== undefined && index.sources.has(hint.sourceKey);
    const second = Math.floor(hint.startUtc);
    let match: VideoCandidate | null = null;
    for (let offset = -RECORDING_START_TOLERANCE_SEC; offset <= RECORDING_START_TOLERANCE_SEC; offset++) {
        const bucket = index.bySecond.get(second + offset);
        if (!bucket) continue;
        for (const candidate of bucket) {
            if (sameSourceOnly && candidate.sourceKey !== hint.sourceKey) continue;
            if (Math.abs(candidate.createdUtc!.getTime() / 1000 - hint.startUtc) > RECORDING_START_TOLERANCE_SEC) {
                continue;
            }
            if (match) return null;
            match = candidate;
        }
    }
    return match;
}

function pushToBucket<T>(map: Map<string, T[]>, key: string, value: T): void {
    const bucket = map.get(key);
    if (bucket) bucket.push(value);
    else map.set(key, [value]);
}

export function buildVideoAssociationIndex(videos: readonly VideoWithRecordingCopies[]): VideoAssociationIndex {
    const mutable = new Map<string, VendorFile[]>();
    const videosByNameCore = new Map<string, VendorFile[]>();
    const canonicalByFileKey = new Map<string, VideoWithRecordingCopies>();
    for (const video of videos) {
        for (const physical of [video, ...(video.recordingCopies ?? [])]) {
            const key = vendorFileKey(physical);
            const existing = canonicalByFileKey.get(key);
            if (existing) {
                if (vendorFileKey(existing) !== vendorFileKey(video)) {
                    throw new Error("recording copy has multiple canonical owners");
                }
                continue;
            }
            canonicalByFileKey.set(key, video);
            pushToBucket(mutable, physical.file.name, physical);
            for (const core of videoIndexCores(physical)) {
                pushToBucket(videosByNameCore, core, physical);
            }
        }
    }
    return { videosByFilename: mutable, videosByNameCore, canonicalByFileKey };
}

/**
 * Binds recording-scoped log sections once MP4 creation metadata is known.
 * A section is accepted only when exactly one candidate starts at its header
 * time. Source scope wins when available; an unresolved tie stays inert.
 */
export function bindRecordsByRecordingStart(
    log: ParsedLog,
    candidates: readonly VideoCandidate[],
): RecordingStartAssociationResult {
    let boundRecords = 0;
    const boundCandidates = new Set<VideoCandidate>();
    let startIndex: RecordingStartIndex | undefined;

    for (const bucket of log.pendingByFilename.values()) {
        const pending: GpsRecord[] = [];
        for (const record of bucket) {
            if (record.recordingAssociation !== undefined) pending.push(record);
        }
        const hint = pending[0]?.recordingAssociation;
        if (
            !hint ||
            pending.some(
                (record) =>
                    record.recordingAssociation === undefined ||
                    !sameRecordingAssociation(record.recordingAssociation, hint),
            )
        ) {
            continue;
        }

        startIndex ??= indexRecordingStarts(candidates);
        const candidate = findRecordingStartCandidate(startIndex, hint);
        if (!candidate) continue;
        const key = vendorFileKey(candidate);
        for (const record of pending) {
            if (record.recordingAssociation === undefined) continue;
            record.mp4Filename = candidate.file.name;
            record.videoKey = key;
            delete record.recordingAssociation;
            boundRecords++;
        }
        if (!candidate.appliedExtractors.includes(hint.extractorId)) {
            candidate.appliedExtractors.push(hint.extractorId);
        }
        boundCandidates.add(candidate);
    }

    if (boundRecords === 0) return { log, boundRecords, boundVideos: 0 };
    return {
        log: mergeIntoGpsLog(null, {
            records: log.records,
            appliedExtractors: log.appliedExtractors,
            skipped: log.skipped,
        }),
        boundRecords,
        boundVideos: boundCandidates.size,
    };
}

type VideosOrIndex = readonly VideoWithRecordingCopies[] | VideoAssociationIndex;

function asIndex(videos: VideosOrIndex): VideoAssociationIndex {
    return "videosByFilename" in videos ? videos : buildVideoAssociationIndex(videos);
}

function parentSegments(path: string): string[] {
    const segments = path.split("/").filter(Boolean);
    segments.pop();
    return segments;
}

function commonPrefixLength(a: string[], b: string[]): number {
    const length = Math.min(a.length, b.length);
    let common = 0;
    while (common < length && a[common]!.toLowerCase() === b[common]!.toLowerCase()) common++;
    return common;
}

/**
 * Resolves a basename carried by a log/sidecar to one concrete video. An exact
 * basename wins; only when none is loaded does a 70mai name core stand in for
 * it. Source scope wins, then directory proximity; an unresolved tie stays
 * unowned so it cannot contaminate several same-named recordings.
 */
export function resolveVideoKey(source: VendorFile, mp4Filename: string, videos: VideosOrIndex): string | null {
    const video = resolveVideo(source, mp4Filename, asIndex(videos));
    return video ? vendorFileKey(video) : null;
}

function uniqueCanonicalVideo(videos: readonly VendorFile[], index: VideoAssociationIndex): VendorFile | null {
    let canonical: VendorFile | null = null;
    for (const video of videos) {
        const candidate = index.canonicalByFileKey.get(vendorFileKey(video)) ?? video;
        if (canonical && vendorFileKey(canonical) !== vendorFileKey(candidate)) return null;
        canonical = candidate;
    }
    return canonical;
}

/**
 * What a log's video name may stand for when no file has that exact name:
 * "file" - the same file spelled differently; "view" - also another file of
 * the same recording (an openpilot preview or side camera for its full-res
 * road file).
 */
type NameScope = "file" | "view";

/** Fallback keys a loaded video answers to. */
function videoIndexCores(video: VendorFile): string[] {
    const core = mai70NameCore(video.file.name);
    return [...(core === null ? [] : [core]), ...openpilotVideoCores(video)];
}

/** Fallback keys a log's video name looks up, most specific first. */
function videoLookupCores(sourcePath: string, name: string, scope: NameScope): string[] {
    const core = mai70NameCore(name);
    const namedBy = { file: { name: baseName(sourcePath) }, relativePath: sourcePath };
    return [...(core === null ? [] : [core]), ...openpilotLookupCores(namedBy, name, scope === "view")];
}

function baseName(relativePath: string): string {
    return relativePath.slice(relativePath.lastIndexOf("/") + 1);
}

/** Recording that a log's own name identifies (an openpilot segment's log), or null. */
function logRecordingKey(relativePath: string): string | null {
    return classifyFilenameRecordingKey({ file: new File([], baseName(relativePath)), relativePath });
}

/**
 * The loaded video a log names. A log whose own name identifies a recording
 * binds only to videos of that recording: the same basename in a sibling
 * segment folder is another recording, however close its path. scope says
 * what the name may stand for; data that describes one exact file (its frame
 * count, say) resolves with "file".
 */
function resolveVideo(
    source: Pick<VendorFile, "relativePath" | "sourceKey">,
    mp4Filename: string,
    index: VideoAssociationIndex,
    scope: NameScope = "view",
): VendorFile | null {
    const recording = logRecordingKey(source.relativePath);
    const ofRecording = (videos: readonly VendorFile[] | undefined): VendorFile[] =>
        (videos ?? []).filter((video) => recording === null || classifyFilenameRecordingKey(video) === recording);
    let candidates = ofRecording(index.videosByFilename.get(mp4Filename));
    for (const core of videoLookupCores(source.relativePath, mp4Filename, scope)) {
        if (candidates.length > 0) break;
        candidates = ofRecording(index.videosByNameCore.get(core));
    }
    if (candidates.length === 0) return null;

    if (source.sourceKey !== undefined) {
        const sameSource = candidates.filter((video) => video.sourceKey === source.sourceKey);
        if (sameSource.length > 0) candidates = sameSource;
    }

    const sourceParent = parentSegments(source.relativePath);
    let bestScore = -1;
    let best: VendorFile[] = [];
    for (const candidate of candidates) {
        const score = commonPrefixLength(sourceParent, parentSegments(candidate.relativePath));
        if (score > bestScore) {
            bestScore = score;
            best = [candidate];
        } else if (score === bestScore) {
            best.push(candidate);
        }
    }
    return uniqueCanonicalVideo(best, index);
}

/** Adds a concrete video owner while the external source file is still known. */
export function associateRecordsWithVideos(
    records: readonly GpsRecord[],
    source: VendorFile,
    videos: VideosOrIndex,
    extractorId?: string,
): void {
    const index = asIndex(videos);
    const videoByFilename = new Map<string, VendorFile | null>();
    for (const record of records) {
        if (
            record.videoKey === undefined &&
            (record.timeAssociation !== undefined || record.recordingAssociation !== undefined)
        )
            continue;
        let video: VendorFile | null | undefined;
        if (record.videoKey !== undefined) {
            // A concrete owner from another source is stronger than a matching
            // basename. Only a matched copy permits replacing that owner.
            // Keep an absent owner's key: removing it would let basename-only
            // fallback attach another source's GPS to this recording.
            video = index.canonicalByFileKey.get(record.videoKey);
            if (!video) continue;
        } else {
            if (extractorId !== undefined) {
                record.filenameAssociation ??= {
                    mp4Filename: record.mp4Filename,
                    sourcePath: source.relativePath,
                    ...(source.sourceKey === undefined ? {} : { sourceKey: source.sourceKey }),
                    extractorId,
                };
            }
            video = videoByFilename.get(record.mp4Filename);
            if (video === undefined) {
                video = resolveVideo(source, record.mp4Filename, index);
                videoByFilename.set(record.mp4Filename, video);
            }
        }
        if (video) {
            record.videoKey = vendorFileKey(video);
            record.mp4Filename = video.file.name;
        }
    }
}

/** A log's timing hint plus the log reference that resolves it on later ingests. */
export interface LogVideoTimingHint extends VideoTimingHint {
    sourcePath: string;
    sourceKey?: string;
    extractorId: string;
}

/** Timing a log established for one loaded video. */
export interface LogVideoTiming {
    startUtc: number | null;
    durationSec: number | null;
}

/**
 * Keeps the newest hint per (log source, log path, video name): a re-dropped
 * log replaces its own earlier hints and leaves other logs' hints alone.
 */
export function mergeLogVideoTimingHints(
    existing: readonly LogVideoTimingHint[],
    incoming: readonly LogVideoTimingHint[],
): LogVideoTimingHint[] {
    const byReference = new Map<string, LogVideoTimingHint>();
    for (const hint of [...existing, ...incoming]) {
        byReference.set(JSON.stringify([hint.sourceKey ?? null, hint.sourcePath, hint.mp4Filename]), hint);
    }
    return [...byReference.values()];
}

/**
 * Resolves log timing hints to loaded videos, keyed by vendorFileKey. An exact
 * owner from the parse context wins while it is loaded; otherwise the hint's
 * name resolves from the log's own source and folder, as a named GPS record
 * does, but only to the same file: a frame count describes one stream, not
 * the preview standing in for it. Unresolved hints stay inert until an
 * ingest loads their video.
 */
export function resolveLogVideoTimingHints(
    hints: readonly LogVideoTimingHint[],
    videos: VideosOrIndex,
): Map<string, LogVideoTiming> {
    const index = asIndex(videos);
    const timing = new Map<string, LogVideoTiming>();
    for (const hint of hints) {
        const exact = hint.videoKey === undefined ? undefined : index.canonicalByFileKey.get(hint.videoKey);
        const video =
            exact ??
            resolveVideo({ relativePath: hint.sourcePath, sourceKey: hint.sourceKey }, hint.mp4Filename, index, "file");
        if (video) timing.set(vendorFileKey(video), { startUtc: hint.startUtc, durationSec: hint.durationSec });
    }
    return timing;
}

/**
 * Applies resolved log timing to candidates: the start becomes the frame-0
 * hint deriveStartUtc trusts first, the duration replaces what metadata could
 * not count. Returns whether any candidate changed, so the caller re-derives
 * start times and regroups.
 */
export function applyLogVideoTiming(
    candidates: readonly VideoCandidate[],
    timingByFileKey: ReadonlyMap<string, LogVideoTiming>,
): boolean {
    if (timingByFileKey.size === 0) return false;
    let changed = false;
    for (const candidate of candidates) {
        const timing = timingByFileKey.get(vendorFileKey(candidate));
        if (!timing) continue;
        if (timing.startUtc !== null && candidate.embeddedStartUtcHint !== timing.startUtc) {
            candidate.embeddedStartUtcHint = timing.startUtc;
            changed = true;
        }
        if (timing.durationSec !== null && candidate.logDurationSec !== timing.durationSec) {
            candidate.logDurationSec = timing.durationSec;
            candidate.durationSec = timing.durationSec;
            changed = true;
        }
    }
    return changed;
}

/** Resolves named logs retained from earlier drops with their original source scope. */
export function bindRecordsByFilename(
    log: ParsedLog,
    videos: VideosOrIndex,
): { log: ParsedLog; boundRecords: number; extractorByFileKey: Map<string, string> } {
    const index = asIndex(videos);
    const videoByReference = new Map<string, VendorFile | null>();
    const replacements = new Map<GpsRecord, GpsRecord>();
    const extractorByFileKey = new Map<string, string>();
    // Filename hints resolve only on ingest, not during each metadata update.
    // Keep them outside pendingByFilename so large card logs do not slow the
    // recording-start and directory-time binders' progressive passes.
    for (const bucket of log.byFilename.values()) {
        for (const record of bucket) {
            const hint = record.filenameAssociation;
            if (!hint || record.videoKey !== undefined) continue;
            const reference = JSON.stringify([hint.sourceKey ?? null, hint.sourcePath, record.mp4Filename]);
            let video = videoByReference.get(reference);
            if (video === undefined) {
                video = resolveVideo(
                    { relativePath: hint.sourcePath, sourceKey: hint.sourceKey },
                    record.mp4Filename,
                    index,
                );
                videoByReference.set(reference, video);
            }
            if (!video) continue;
            const videoKey = vendorFileKey(video);
            const bound = { ...record, videoKey, mp4Filename: video.file.name };
            replacements.set(record, bound);
            if (!extractorByFileKey.has(videoKey)) extractorByFileKey.set(videoKey, hint.extractorId);
        }
    }
    if (replacements.size === 0) return { log, boundRecords: 0, extractorByFileKey };
    return {
        log: mergeIntoGpsLog(null, {
            records: log.records.map((record) => replacements.get(record) ?? record),
            appliedExtractors: log.appliedExtractors,
            skipped: log.skipped,
        }),
        boundRecords: replacements.size,
        extractorByFileKey,
    };
}

/**
 * Moves GPS owned by openpilot cameras that failed to load to the camera of
 * the same segment next in GPS-owner order (OPENPILOT_GPS_OWNER_STREAMS). A
 * qlog names its owner before any video metadata is read, so a road file that
 * then fails to index would keep the segment's track from the cameras that did
 * load. Owners of other formats keep their key: there no other file stands
 * for the failed one. Records stay put when no camera of the segment loaded.
 */
export function rebindFailedOpenpilotOwners(
    log: ParsedLog,
    failedVideos: readonly VendorFile[],
    loadedVideos: VideosOrIndex,
): { log: ParsedLog; reboundRecords: number } {
    const index = asIndex(loadedVideos);
    const standInByFailedKey = new Map<string, VendorFile>();
    for (const failed of failedVideos) {
        const key = vendorFileKey(failed);
        if (!log.byVideoKey.has(key) || parseOpenpilotFileName(failed) === null) continue;
        // The failed file names itself the way its segment's log does, so it
        // resolves like the log would after a later drop.
        const standIn = resolveVideo(failed, failed.file.name, index, "view");
        if (standIn && vendorFileKey(standIn) !== key) standInByFailedKey.set(key, standIn);
    }
    if (standInByFailedKey.size === 0) return { log, reboundRecords: 0 };
    let reboundRecords = 0;
    const records = log.records.map((record) => {
        const standIn = record.videoKey === undefined ? undefined : standInByFailedKey.get(record.videoKey);
        if (!standIn) return record;
        reboundRecords++;
        return { ...record, videoKey: vendorFileKey(standIn), mp4Filename: standIn.file.name };
    });
    return {
        log: mergeIntoGpsLog(null, { records, appliedExtractors: log.appliedExtractors, skipped: log.skipped }),
        reboundRecords,
    };
}

/**
 * Settles provisional named bindings against the committed trip list. Mutates
 * shared records so candidate views lose the hint too; abandoned bindings
 * return to their original references for the next ingest to retry safely.
 * Concrete owners without a provisional hint are never reconsidered.
 */
export function settleFilenameAssociations(log: ParsedLog, committedVideos: VideosOrIndex): ParsedLog {
    const index = asIndex(committedVideos);
    let restored = false;
    for (const record of log.records) {
        const hint = record.filenameAssociation;
        if (!hint || record.videoKey === undefined) continue;
        if (index.canonicalByFileKey.has(record.videoKey)) {
            delete record.filenameAssociation;
        } else {
            record.mp4Filename = hint.mp4Filename;
            delete record.videoKey;
            restored = true;
        }
    }
    return restored ? mergeIntoGpsLog(null, log) : log;
}

/**
 * Reconciles logs loaded before physical recording copies were identified.
 * Exact owners survive source/path ambiguity; unowned rows can move only when
 * their basename has one canonical recording. A new log is returned so callers
 * can commit refreshed candidate records together with the copy metadata.
 */
export function rebindRecordingCopyRecords(
    log: ParsedLog,
    videos: VideosOrIndex,
): { log: ParsedLog; reboundRecords: number } {
    const index = asIndex(videos);
    const copyOwners = new Set<VideoWithRecordingCopies>();
    for (const video of index.canonicalByFileKey.values()) {
        if (video.recordingCopies?.length) copyOwners.add(video);
    }
    if (copyOwners.size === 0) return { log, reboundRecords: 0 };
    const canonicalByFilename = new Map<string, VideoWithRecordingCopies | null>();
    let reboundRecords = 0;
    const records = log.records.map((record) => {
        if (
            record.recordingAssociation !== undefined ||
            (record.filenameAssociation !== undefined && record.videoKey === undefined) ||
            (record.timeAssociation !== undefined && record.videoKey === undefined)
        )
            return record;
        let canonical: VideoWithRecordingCopies | null | undefined;
        if (record.videoKey !== undefined) {
            canonical = index.canonicalByFileKey.get(record.videoKey);
        } else {
            canonical = canonicalByFilename.get(record.mp4Filename);
            if (canonical === undefined) {
                canonical = uniqueCanonicalVideo(index.videosByFilename.get(record.mp4Filename) ?? [], index);
                canonicalByFilename.set(record.mp4Filename, canonical);
            }
        }
        if (!canonical || !copyOwners.has(canonical)) return record;
        const videoKey = vendorFileKey(canonical);
        if (record.videoKey === videoKey && record.mp4Filename === canonical.file.name) return record;
        reboundRecords++;
        return { ...record, videoKey, mp4Filename: canonical.file.name };
    });
    if (reboundRecords === 0) return { log, reboundRecords };
    return {
        log: mergeIntoGpsLog(null, { records, appliedExtractors: log.appliedExtractors, skipped: log.skipped }),
        reboundRecords,
    };
}

/**
 * Returns only records safe for one candidate. Raw basename-only records are
 * accepted when that basename names one loaded file; an ambiguous basename
 * requires an exact videoKey.
 */
export function recordsForVideo(log: ParsedLog, video: VendorFile, loadedVideos: VideosOrIndex): GpsRecord[] {
    const index = asIndex(loadedVideos);
    const canonical = index.canonicalByFileKey.get(vendorFileKey(video)) ?? video;
    const key = vendorFileKey(canonical);
    const sameNameVideos = index.videosByFilename.get(canonical.file.name) ?? [];
    const owned = log.byVideoKey.get(key) ?? [];
    const unowned =
        sameNameVideos.length > 1 && !uniqueCanonicalVideo(sameNameVideos, index)
            ? []
            : (log.byFilename.get(canonical.file.name) ?? []).filter(
                  (record) =>
                      record.videoKey === undefined &&
                      record.filenameAssociation === undefined &&
                      record.recordingAssociation === undefined &&
                      record.timeAssociation === undefined,
              );
    if (owned.length === 0) return unowned;
    if (unowned.length === 0 && !index.canonicalByFileKey.get(key)?.recordingCopies?.length) return owned;
    // A newly bound alias can still carry its old basename until the next log
    // merge. Gather by owner and restore chronological order across those buckets.
    return owned.concat(unowned).sort((a, b) => a.unixSeconds - b.unixSeconds);
}

/** Rebinds candidate.records without ever falling back across an ambiguous basename. */
export function attachRecordsToCandidates(
    log: ParsedLog,
    candidates: readonly VideoCandidate[],
    loadedVideos: VideosOrIndex,
): void {
    const index = asIndex(loadedVideos);
    for (const candidate of candidates) {
        candidate.records = recordsForVideo(log, candidate, index);
    }
}

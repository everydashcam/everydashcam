import { mergeIntoGpsLog } from "./parser.js";
import type { GpsRecord, ParsedLog, VendorFile, VideoWithRecordingCopies } from "./parsers/types.js";
import type { VideoCandidate } from "./trips.js";
import { vendorFileKey } from "./vendor-file-key.js";

export interface VideoAssociationIndex {
    videosByFilename: ReadonlyMap<string, readonly VendorFile[]>;
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

export function buildVideoAssociationIndex(videos: readonly VideoWithRecordingCopies[]): VideoAssociationIndex {
    const mutable = new Map<string, VendorFile[]>();
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
            let sameName = mutable.get(physical.file.name);
            if (!sameName) {
                sameName = [];
                mutable.set(physical.file.name, sameName);
            }
            sameName.push(physical);
        }
    }
    return { videosByFilename: mutable, canonicalByFileKey };
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
 * Resolves a basename carried by a log/sidecar to one concrete video. Source
 * scope wins, then directory proximity; an unresolved tie stays unowned so it
 * cannot contaminate several same-named recordings.
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

function resolveVideo(source: VendorFile, mp4Filename: string, index: VideoAssociationIndex): VendorFile | null {
    let candidates = [...(index.videosByFilename.get(mp4Filename) ?? [])];
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
): void {
    const index = asIndex(videos);
    const videoByFilename = new Map<string, VendorFile | null>();
    for (const record of records) {
        let video: VendorFile | null | undefined;
        if (record.videoKey !== undefined) {
            // A concrete owner from another source is stronger than a matching
            // basename. Only a matched copy permits replacing that owner.
            // Keep an absent owner's key: removing it would let basename-only
            // fallback attach another source's GPS to this recording.
            video = index.canonicalByFileKey.get(record.videoKey);
            if (!video) continue;
        } else {
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
        if (record.recordingAssociation !== undefined) return record;
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
            : (log.byFilename.get(canonical.file.name) ?? []).filter((record) => record.videoKey === undefined);
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

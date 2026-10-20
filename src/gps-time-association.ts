import { bindRecordsByRecordingStart, buildVideoAssociationIndex, recordsForVideo } from "./gps-association.js";
import { mergeIntoGpsLog } from "./parser.js";
import type { GpsRecord, ParsedLog, VendorFile } from "./parsers/types.js";
import type { VideoCandidate } from "./trips.js";
import { vendorFileKey } from "./vendor-file-key.js";

interface TimeSource {
    hint: NonNullable<GpsRecord["timeAssociation"]>;
    directory: string[];
    records: GpsRecord[];
    firstUtc: number;
    lastUtc: number;
    signaturesByTime: Map<number, Set<string>>;
}

interface RecordingWindow {
    candidate: VideoCandidate;
    key: string;
    start: number;
    end: number;
    hasIndependentGps: boolean;
    sources: TimeSource[];
}

function pathSegments(path: string): string[] {
    return path
        .split("/")
        .filter(Boolean)
        .map((part) => part.toLowerCase());
}

function sourceContainsFile(source: TimeSource, file: VendorFile): boolean {
    if (source.hint.sourceKey !== undefined && source.hint.sourceKey !== file.sourceKey) return false;
    const path = pathSegments(file.relativePath || file.file.name);
    return path.length > source.directory.length && source.directory.every((part, index) => path[index] === part);
}

function independentGps(record: GpsRecord): boolean {
    return (
        record.externalTrack === true ||
        (record.timeAssociation === undefined && record.recordingAssociation === undefined)
    );
}

function pointSignature(record: GpsRecord): string {
    // Acceleration baselines, stationary bearings, and segment ordinals depend
    // on the surrounding source file, so appending or rotating a log may change
    // them without changing the original GPS observation.
    return JSON.stringify([
        record.unixSeconds,
        record.active,
        record.lat,
        record.lon,
        record.speedMs,
        record.speedSource,
    ]);
}

function unambiguousSourceRecord(record: GpsRecord, source: TimeSource, sources: readonly TimeSource[]): boolean {
    if (source.signaturesByTime.get(record.unixSeconds)?.size !== 1) return false;
    let signature: string | undefined;
    for (const other of sources) {
        if (other === source || record.unixSeconds < other.firstUtc || record.unixSeconds > other.lastUtc) continue;
        signature ??= pointSignature(record);
        const signatures = other.signaturesByTime.get(record.unixSeconds);
        if (signatures?.size !== 1 || !signatures.has(signature)) return false;
    }
    return true;
}

/** A shared clock alone cannot distinguish overlapping cameras. Only distinct
 * channels of one camera at the exact same recording start may share a route. */
function sameRecording(windows: readonly RecordingWindow[]): boolean {
    const first = windows[0]!.candidate;
    const channels = new Set<VideoCandidate["channel"]>();
    for (const { candidate } of windows) {
        if (
            candidate.sourceKey !== first.sourceKey ||
            candidate.fingerprint !== first.fingerprint ||
            candidate.startUtc !== first.startUtc ||
            candidate.channel === null ||
            channels.has(candidate.channel)
        ) {
            return false;
        }
        channels.add(candidate.channel);
    }
    return true;
}

function recordCounts(records: readonly GpsRecord[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const record of records) {
        const signature = JSON.stringify(record);
        counts.set(signature, (counts.get(signature) ?? 0) + 1);
    }
    return counts;
}

/**
 * Applies an unnamed directory GPS log to the recordings beneath it using their
 * resolved UTC intervals. Clock resolution, including the existing browser-zone
 * fallback, belongs to the recording clock layer; this association adds no zone
 * inference. Original rows remain pending for recordings
 * loaded later. Derived rows retain provenance so clock changes, new competing
 * recordings, and more specific directory logs can safely replace them.
 */
export function bindRecordsByTimeRange(
    log: ParsedLog,
    candidates: readonly VideoCandidate[],
): { log: ParsedLog; boundRecords: number; boundVideos: number } {
    const sources = new Map<string, TimeSource>();
    for (const bucket of log.pendingByFilename.values()) {
        for (const record of bucket) {
            const hint = record.timeAssociation;
            if (!hint || record.videoKey !== undefined || record.timeUnsynced || !Number.isFinite(record.unixSeconds)) {
                continue;
            }
            const key = JSON.stringify([hint.sourceKey ?? null, hint.sourcePath, hint.extractorId]);
            let source = sources.get(key);
            if (!source) {
                const directory = pathSegments(hint.sourcePath);
                directory.pop();
                source = {
                    hint,
                    directory,
                    records: [],
                    firstUtc: record.unixSeconds,
                    lastUtc: record.unixSeconds,
                    signaturesByTime: new Map(),
                };
                sources.set(key, source);
            }
            source.records.push(record);
            source.firstUtc = Math.min(source.firstUtc, record.unixSeconds);
            source.lastUtc = Math.max(source.lastUtc, record.unixSeconds);
            let signatures = source.signaturesByTime.get(record.unixSeconds);
            if (!signatures) {
                signatures = new Set();
                source.signaturesByTime.set(record.unixSeconds, signatures);
            }
            signatures.add(pointSignature(record));
        }
    }
    if (sources.size === 0 || candidates.length === 0) return { log, boundRecords: 0, boundVideos: 0 };

    const videoIndex = buildVideoAssociationIndex(candidates);
    const candidateKeys = new Set(candidates.map(vendorFileKey));
    const windowsBySource = new Map<TimeSource, RecordingWindow[]>();
    for (const candidate of candidates) {
        const span = candidate.wallDurationSec ?? candidate.durationSec;
        if (
            candidate.metadataReady === false ||
            candidate.metadataFailed === true ||
            candidate.startSource === "mtime" ||
            candidate.hasUncalibratedClock === true ||
            !Number.isFinite(candidate.startUtc) ||
            !Number.isFinite(span) ||
            span <= 0
        ) {
            continue;
        }
        let nearest: TimeSource[] = [];
        let nearestDepth = -1;
        for (const source of sources.values()) {
            if (source.lastUtc < candidate.startUtc || source.firstUtc >= candidate.startUtc + span) continue;
            if (![candidate, ...(candidate.recordingCopies ?? [])].some((file) => sourceContainsFile(source, file))) {
                continue;
            }
            if (source.directory.length > nearestDepth) {
                nearest = [source];
                nearestDepth = source.directory.length;
            } else if (source.directory.length === nearestDepth) {
                nearest.push(source);
            }
        }
        if (nearest.length === 0) continue;
        const window: RecordingWindow = {
            candidate,
            key: vendorFileKey(candidate),
            start: candidate.startUtc,
            end: candidate.startUtc + span,
            hasIndependentGps:
                candidate.records.some(independentGps) ||
                recordsForVideo(log, candidate, videoIndex).some(independentGps),
            sources: nearest,
        };
        for (const source of nearest) {
            const windows = windowsBySource.get(source);
            if (windows) windows.push(window);
            else windowsBySource.set(source, [window]);
        }
    }

    const additions = new Map<string, GpsRecord>();
    for (const [source, windows] of windowsBySource) {
        windows.sort((a, b) => a.start - b.start);
        source.records.sort((a, b) => a.unixSeconds - b.unixSeconds);
        let next = 0;
        let active: RecordingWindow[] = [];
        for (const record of source.records) {
            active = active.filter((window) => window.end > record.unixSeconds);
            while (next < windows.length && windows[next]!.start <= record.unixSeconds) {
                const window = windows[next++]!;
                if (window.end > record.unixSeconds) active.push(window);
            }
            if (active.length === 0 || (active.length > 1 && !sameRecording(active))) continue;
            for (const window of active) {
                if (window.hasIndependentGps || !unambiguousSourceRecord(record, source, window.sources)) continue;
                // Equivalent files may number their sessions differently. Pick
                // one source before generic deduplication, which intentionally
                // preserves records from distinct track segments.
                const key = JSON.stringify([window.key, record.unixSeconds]);
                if (!additions.has(key)) {
                    additions.set(key, { ...record, mp4Filename: window.candidate.file.name, videoKey: window.key });
                }
            }
        }
    }

    const isDerivedForCandidate = (record: GpsRecord): boolean =>
        record.timeAssociation !== undefined &&
        record.videoKey !== undefined &&
        candidateKeys.has(record.videoKey) &&
        record.externalTrack !== true;
    const existing = log.records.filter(isDerivedForCandidate);
    if (additions.size === 0 && existing.length === 0) return { log, boundRecords: 0, boundVideos: 0 };
    const rebuilt = mergeIntoGpsLog(null, {
        records: log.records.filter((record) => !isDerivedForCandidate(record)).concat([...additions.values()]),
        appliedExtractors: log.appliedExtractors,
        skipped: log.skipped,
    });
    const remaining = recordCounts(existing);
    let boundRecords = 0;
    const boundKeys = new Set<string>();
    for (const record of rebuilt.records) {
        if (!isDerivedForCandidate(record)) continue;
        const signature = JSON.stringify(record);
        const count = remaining.get(signature) ?? 0;
        if (count > 0) {
            if (count === 1) remaining.delete(signature);
            else remaining.set(signature, count - 1);
        } else {
            boundRecords++;
            boundKeys.add(record.videoKey!);
        }
    }
    if (boundRecords === 0 && remaining.size === 0) return { log, boundRecords: 0, boundVideos: 0 };
    for (const candidate of candidates) {
        for (const record of rebuilt.byVideoKey.get(vendorFileKey(candidate)) ?? []) {
            const extractorId = record.timeAssociation?.extractorId;
            if (extractorId && !candidate.appliedExtractors.includes(extractorId)) {
                candidate.appliedExtractors.push(extractorId);
            }
        }
    }
    return { log: rebuilt, boundRecords, boundVideos: boundKeys.size };
}

/** Resolves exact recording headers before applying directory-wide routes. */
export function bindRecordingLogs(
    log: ParsedLog,
    candidates: readonly VideoCandidate[],
): { log: ParsedLog; boundRecords: number; boundVideos: number } {
    const recording = bindRecordsByRecordingStart(log, candidates);
    const directory = bindRecordsByTimeRange(recording.log, candidates);
    return {
        log: directory.log,
        boundRecords: recording.boundRecords + directory.boundRecords,
        boundVideos: recording.boundVideos + directory.boundVideos,
    };
}

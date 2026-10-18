// Pre-ingest duplicate-file exclusion. A drop that contains byte-identical
// copies of a recording in different subfolders (the user copied the SD card
// and dropped both the original and the backup) would otherwise double trip
// footage: groupTrips puts the copy into a `|dup` frame at the same startUtc,
// so the player replays the same minute twice and totalBytes doubles.
//
// Two-tier check, designed to cost zero IO on a clean drop:
//   1. Group by filename time technique, timestamp and size, falling back to
//      basename and size when no time is recognised. A protected copy can have
//      another name; mode, channel and camera scope gate those comparisons.
//   2. Inside a colliding group, an exact session identity (source + path +
//      size + mtime) needs no IO. Otherwise compare at most eight evenly spaced
//      64 KiB windows, including head and tail. This is a bounded heuristic:
//      differences outside the sampled windows can go unnoticed.
//
// Runs at the ingest chokepoint (ui/ingest.ts) BEFORE classify/indexing, so a
// duplicate never reaches indexing. The comparison set includes files already
// loaded into trips, so a later "drop the Backup folder too" is deduped as
// well. A re-read through the same remembered-folder/handle source is metadata-
// only; an ad-hoc second drop deliberately pays the probe because the browser
// exposes no trustworthy physical-source identity. Known limitation: a
// candidate already repaired in-memory (hvcC / phantom-track byte patches)
// without a retained raw copy can stop matching its on-disk original, so an
// ad-hoc copy can slip through. Same-source, same-metadata re-drops still match
// its session identity; retained raw aliases remain valid comparison sources.

import { cameraFingerprint } from "./parsers/camera-fingerprint.js";
import {
    classifyFilenameTimelapse,
    matchFilenameChannel,
    matchFilenameMode,
    matchFilenameTime,
} from "./parsers/filename/index.js";
import { RX_VIDEO_EXT } from "./parsers/registry-light.js";
import type { Channel, RecordingMode, VendorFile, VideoWithRecordingCopies } from "./parsers/types.js";
import { vendorFileKey } from "./vendor-file-key.js";

// The same fixed sampling budget applies to backup and protected copies.
const PROBE_BYTES = 64 * 1024;
const MAX_PROBES = 8;

// A dropped duplicate and the copy it duplicated - for the ingest log, so a
// "my files did not load" report can be traced to the surviving path.
export interface DroppedDuplicate {
    droppedPath: string;
    keptPath: string;
}

/** A duplicate matched against a file already represented by a loaded source.
 * The UI uses this evidence to keep a classic re-open on the existing source
 * row even when only auxiliary files survive the dedup pass. */
export interface DuplicateSourceMatch {
    incoming: VendorFile;
    loaded: VendorFile;
}

/** A copy matched by session identity or bounded samples and its survivor. It may match
 * several owners; callers must retain that ambiguity rather
 * than choose an owner for GPS or recording-mode evidence arbitrarily. */
export interface RecordingCopy {
    kept: VendorFile;
    duplicate: VendorFile;
}

export interface DedupResult {
    // Surviving files, in the original incoming order.
    kept: VendorFile[];
    dropped: DroppedDuplicate[];
    sourceMatches: DuplicateSourceMatch[];
    copies: RecordingCopy[];
}

/** Metadata grouping key. Only files agreeing on it are content-probed. */
function dedupKey(file: File): string {
    // Ignore directory-derived clocks here: copies with equal basenames must
    // retain one comparison key even when their enclosing folders differ.
    // Renamed copies with a different filename timestamp or time technique
    // stay separate; a trigger-time name does not identify the original span.
    const time = matchFilenameTime({ file, relativePath: file.name });
    return time.value === null
        ? `name:${file.name}|${file.size}`
        : `time:${time.matchedId}|${time.value.getTime()}|${file.size}`;
}

async function readBytes(file: File, start: number, end: number): Promise<Uint8Array> {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

type ProbeReader = (file: File, start: number, end: number) => Promise<Uint8Array>;

/** Keep probes only for one collision group; input arrays keep File keys alive. */
function createProbeReader(): ProbeReader {
    const cache = new WeakMap<File, Map<string, Promise<Uint8Array>>>();
    return (file, start, end) => {
        let cached = cache.get(file);
        if (!cached) {
            cached = new Map();
            cache.set(file, cached);
        }
        const key = `${start}:${end}`;
        const existing = cached.get(key);
        if (existing) return existing;
        const pending = readBytes(file, start, end);
        cached.set(key, pending);
        // Retain failures too: another comparison must not exceed this pass's
        // read budget. A later import gets a fresh cache and can retry.
        return pending;
    };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Samples same-size files within a fixed IO budget. Head and tail are checked
 * first, followed by evenly spaced interior windows. Matching samples are a
 * heuristic, never a full-file equality guarantee; there is no fallback scan.
 */
async function sameSampledContent(a: File, b: File, readProbe: ProbeReader, signal?: AbortSignal): Promise<boolean> {
    const count = Math.max(1, Math.min(MAX_PROBES, Math.ceil(a.size / PROBE_BYTES)));
    const lastStart = Math.max(0, a.size - PROBE_BYTES);
    const indices = count === 1 ? [0] : [0, count - 1, ...Array.from({ length: count - 2 }, (_, i) => i + 1)];
    for (const index of indices) {
        const start = count === 1 ? 0 : Math.round((index * lastStart) / (count - 1));
        const end = Math.min(a.size, start + PROBE_BYTES);
        // Settle both reads before moving on, even if one fails immediately.
        const [chunkA, chunkB] = await Promise.allSettled([readProbe(a, start, end), readProbe(b, start, end)]);
        if (signal?.aborted) throw new DOMException("ingest aborted", "AbortError");
        for (const chunk of [chunkA, chunkB]) {
            if (chunk.status === "rejected" && chunk.reason instanceof Error && chunk.reason.name === "AbortError") {
                throw chunk.reason;
            }
        }
        if (chunkA.status === "rejected") throw chunkA.reason;
        if (chunkB.status === "rejected") throw chunkB.reason;
        if (!bytesEqual(chunkA.value, chunkB.value)) return false;
    }
    return true;
}

interface KeepPreferenceRank {
    channelRank: 0 | 1;
    channel: Channel | null;
    eventRank: 0 | 1;
    mode: RecordingMode | null;
    isTimelapse: boolean;
    depth: number;
}

function parentPath(relativePath: string, excludeRoot = false): string {
    const segments = relativePath.split(/[/\\]/).filter(Boolean);
    return segments.slice(excludeRoot ? 1 : 0, -1).join("/");
}

/**
 * Drops likely video duplicates using metadata and bounded samples, both within the
 * drop and against `alreadyLoaded` (files currently in trips - a copy of an
 * already-loaded file is dropped even across separate drops). Returns the
 * survivors in the original order plus the dropped pairs for logging.
 *
 * Files with unique metadata comparison keys pass through with zero IO. A read error
 * treats the pair as distinct - the file is kept and the real failure surfaces
 * later in indexing, where it is reported properly.
 *
 * Throws DOMException("AbortError") when `signal` aborts mid-probe.
 */
export async function dropDuplicateFiles(
    incoming: VendorFile[],
    alreadyLoaded: VideoWithRecordingCopies[],
    signal?: AbortSignal,
): Promise<DedupResult> {
    if (signal?.aborted) throw new DOMException("ingest aborted", "AbortError");
    const keyCache = new WeakMap<File, string>();
    const keyOf = (file: File): string => {
        const cached = keyCache.get(file);
        if (cached !== undefined) return cached;
        const key = dedupKey(file);
        keyCache.set(file, key);
        return key;
    };
    const keep = new Set<VendorFile>();
    const groups = new Map<string, VendorFile[]>();
    for (const vf of incoming) {
        // Equal external bytes can belong to different recordings. Their
        // association must survive until the parser knows the video owner.
        if (!RX_VIDEO_EXT.test(vf.file.name)) {
            keep.add(vf);
            continue;
        }
        const key = keyOf(vf.file);
        const group = groups.get(key);
        if (group) group.push(vf);
        else groups.set(key, [vf]);
    }

    // Already-loaded files matter only for keys present in the drop.
    const loadedByKey = new Map<string, VendorFile[]>();
    const loadedPhysicalFiles = new Map<VendorFile, readonly VendorFile[]>();
    for (const vf of alreadyLoaded) {
        const physical = [vf, ...(vf.recordingCopies ?? [])];
        loadedPhysicalFiles.set(vf, physical);
        for (const key of new Set(physical.map((file) => keyOf(file.file)))) {
            if (!groups.has(key)) continue;
            const bucket = loadedByKey.get(key);
            if (bucket) bucket.push(vf);
            else loadedByKey.set(key, [vf]);
        }
    }

    // Sort may invoke its comparator repeatedly for the same file. These ranks
    // depend only on immutable VendorFile metadata, so calculate each once.
    const rankCache = new WeakMap<VendorFile, KeepPreferenceRank>();
    const rankOf = (vf: VendorFile): KeepPreferenceRank => {
        const cached = rankCache.get(vf);
        if (cached) return cached;
        const channelMatch = matchFilenameChannel(vf);
        const mode = matchFilenameMode(vf).value;
        const rank: KeepPreferenceRank = {
            channelRank: channelMatch.matchedId !== null ? 0 : 1,
            channel: channelMatch.value?.channel ?? null,
            eventRank: mode === "event" ? 0 : 1,
            mode,
            isTimelapse: classifyFilenameTimelapse(vf),
            depth: vf.relativePath.split(/[/\\]/).length,
        };
        rankCache.set(vf, rank);
        return rank;
    };

    const fingerprintCache = new WeakMap<VendorFile, string>();
    const fingerprintOf = (vf: VendorFile): string => {
        const cached = fingerprintCache.get(vf);
        if (cached !== undefined) return cached;
        const fingerprint = cameraFingerprint(vf);
        fingerprintCache.set(vf, fingerprint);
        return fingerprint;
    };

    const rootlessFingerprintCache = new WeakMap<VendorFile, string>();
    const rootlessFingerprintOf = (vf: VendorFile): string => {
        const cached = rootlessFingerprintCache.get(vf);
        if (cached !== undefined) return cached;
        // Independent folder picks can add different leading selection names.
        // Keep inner camera paths: card-a/camera-1 and card-b/camera-2 must not
        // become one recording just because their mode prefixes differ.
        const segments = vf.relativePath.split(/[/\\]/).filter(Boolean);
        const relativePath = segments.length > 1 ? segments.slice(1).join("/") : vf.relativePath;
        const fingerprint = cameraFingerprint({ ...vf, relativePath });
        rootlessFingerprintCache.set(vf, fingerprint);
        return fingerprint;
    };

    const canCompare = (a: VendorFile, b: VendorFile): boolean => {
        const aRank = rankOf(a);
        const bRank = rankOf(b);
        if (aRank.channel !== null && bRank.channel !== null && aRank.channel !== bRank.channel) return false;
        // Preserve the existing backup-copy contract for equal basenames.
        if (a.file.name === b.file.name) return true;
        if (
            aRank.mode === null ||
            bRank.mode === null ||
            aRank.mode === "parking" ||
            bRank.mode === "parking" ||
            (aRank.mode === "normal" && bRank.mode === "normal") ||
            aRank.isTimelapse !== bRank.isTimelapse
        )
            return false;
        if (fingerprintOf(a) === fingerprintOf(b)) return true;
        if (a.sourceKey === b.sourceKey && parentPath(a.relativePath) === parentPath(b.relativePath)) return true;
        return (
            a.sourceKey !== undefined &&
            b.sourceKey !== undefined &&
            a.sourceKey !== b.sourceKey &&
            (rootlessFingerprintOf(a) === rootlessFingerprintOf(b) ||
                parentPath(a.relativePath, true) === parentPath(b.relativePath, true))
        );
    };

    // Camera-fingerprint frequency over the whole comparison set (the drop plus
    // already-loaded files). compareKeepPreference uses it to keep a camera's
    // channels in one folder so dedup never splits a multichannel trip into
    // sequential single-channel frames.
    //
    // Built lazily on first demand: only colliding groups consult it (via
    // compareKeepPreference). A card with unique comparison keys has none,
    // so it pays zero cameraFingerprint() calls here. Each call walks
    // the filename technique regexes, so the unconditional per-file pass it
    // replaces was pure waste on every clean drop. Memoized, so it is still
    // computed exactly once (over the full set) when at least one group collides.
    let fingerprintFreq: Map<string, number> | null = null;
    const getFingerprintFreq = (): Map<string, number> => {
        if (fingerprintFreq) return fingerprintFreq;
        const freq = new Map<string, number>();
        const bump = (vf: VendorFile) => {
            const fp = fingerprintOf(vf);
            freq.set(fp, (freq.get(fp) ?? 0) + 1);
        };
        for (const vf of incoming) bump(vf);
        for (const vf of alreadyLoaded) bump(vf);
        fingerprintFreq = freq;
        return freq;
    };

    /** Orders copies by recognised channel path, camera cohesion, event mode
     * within one camera, path depth, then path. Classifiers stay cached. */
    const compareKeepPreference = (a: VendorFile, b: VendorFile, preferEvent: boolean): number => {
        const aRank = rankOf(a);
        const bRank = rankOf(b);
        if (aRank.channelRank !== bRank.channelRank) return aRank.channelRank - bRank.channelRank;
        const freq = getFingerprintFreq();
        const aFreq = freq.get(fingerprintOf(a)) ?? 0;
        const bFreq = freq.get(fingerprintOf(b)) ?? 0;
        if (aFreq !== bFreq) return bFreq - aFreq;
        if (preferEvent && aRank.eventRank !== bRank.eventRank) {
            return aRank.eventRank - bRank.eventRank;
        }
        if (aRank.depth !== bRank.depth) return aRank.depth - bRank.depth;
        return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
    };

    const dropped: DroppedDuplicate[] = [];
    const sourceMatches: DuplicateSourceMatch[] = [];
    const copies: RecordingCopy[] = [];
    const loadedFiles = new Set(alreadyLoaded);
    for (const [key, group] of groups) {
        const loaded = loadedByKey.get(key);
        if (group.length === 1 && !loaded) {
            // Fast path: unique metadata comparison key - no probe, no IO.
            keep.add(group[0]!);
            continue;
        }
        // Probe in keep-preference order so the best copy becomes the unique
        // representative and the worse-path copies get dropped against it.
        // Already-loaded copies always win - they cannot be replaced anyway.
        const fingerprint = fingerprintOf(group[0]!);
        const preferEvent = group.every((vf) => fingerprintOf(vf) === fingerprint);
        const ordered = [...group].sort((a, b) => compareKeepPreference(a, b, preferEvent));
        const uniques: VendorFile[] = loaded ? [...loaded] : [];
        const readProbe = createProbeReader();
        for (const vf of ordered) {
            if (signal?.aborted) throw new DOMException("ingest aborted", "AbortError");
            let duplicateOf: VendorFile | null = null;
            for (const unique of uniques) {
                // A path is only identity inside one source, and dashcams reuse
                // paths. The full session key also carries source + size + mtime;
                // a retained physical alias provides that same identity even
                // after the canonical playback File has a repaired container.
                const physical = loadedPhysicalFiles.get(unique) ?? [unique];
                const incomingKey = vendorFileKey(vf);
                let equal = physical.some((file) => vendorFileKey(file) === incomingKey);
                if (!equal) {
                    for (const file of physical) {
                        if (keyOf(file.file) !== key || !canCompare(file, vf)) continue;
                        try {
                            equal = await sameSampledContent(file.file, vf.file, readProbe, signal);
                        } catch (err) {
                            if (err instanceof Error && err.name === "AbortError") throw err;
                            // Try another retained physical copy after a read
                            // failure. If none match, indexing reports the error.
                            equal = false;
                        }
                        if (signal?.aborted) throw new DOMException("ingest aborted", "AbortError");
                        if (equal) break;
                    }
                }
                if (equal) {
                    duplicateOf ??= unique;
                    copies.push({ kept: unique, duplicate: vf });
                    if (loadedFiles.has(unique)) {
                        // Report every already-loaded source matched by the
                        // heuristic. The folder layer must see the tie and refuse
                        // to alias a later notes-only reopen to whichever card
                        // happened to sort first.
                        sourceMatches.push({ incoming: vf, loaded: unique });
                    }
                    // An incoming copy can match several independently kept
                    // owners too. Report every direct match; compatibility is
                    // not transitive through an unknown-channel or event file.
                }
            }
            if (duplicateOf) {
                dropped.push({ droppedPath: vf.relativePath, keptPath: duplicateOf.relativePath });
            } else {
                uniques.push(vf);
                keep.add(vf);
            }
        }
    }

    return { kept: incoming.filter((vf) => keep.has(vf)), dropped, sourceMatches, copies };
}

import type { GpsRecord, ParsedLog, VendorFile, VideoWithRecordingCopies } from "./parsers/types.js";
import { fileIdentityKey } from "./persist/identity.js";
import type { VideoCandidate } from "./trips.js";

const STORAGE_KEY = "everydashcam:recordings:cameraTimezone";
const MAX_STORED_RECORDINGS = 2000;
const MIN_OFFSET_SEC = -12 * 3600;
const MAX_OFFSET_SEC = 14 * 3600;

interface StoredTimezone extends SessionTimezone {
    key: string;
}

interface SessionTimezone {
    // Shared by recordings that have inherited one folder/card preference.
    // Keeps Auto resets effective for known members that are not open now.
    cohortKey: string;
    offsetSec: number | null;
    updatedAt: number;
}

interface DirectoryScope {
    directory: string[];
    sourceKey?: string;
    records: GpsRecord[];
}

let entries: StoredTimezone[] = [];
let hasUnsavedEntries = false;
let sessionOverrides = new Map<string, SessionTimezone>();
let logScopes = new WeakMap<ParsedLog, DirectoryScope[]>();

export function isCameraTimezoneOffset(value: unknown): value is number {
    return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= MIN_OFFSET_SEC &&
        value <= MAX_OFFSET_SEC &&
        value % 900 === 0
    );
}

function pathParts(path: string): string[] {
    return path
        .split("/")
        .filter(Boolean)
        .map((part) => part.toLowerCase());
}

function directoryScopes(log: ParsedLog | null): DirectoryScope[] {
    if (!log) return [];
    const cached = logScopes.get(log);
    if (cached) return cached;
    const scopes = new Map<string, DirectoryScope>();
    for (const bucket of log.pendingByFilename.values()) {
        for (const record of bucket) {
            const hint = record.timeAssociation;
            if (!hint || record.videoKey !== undefined) continue;
            const directory = pathParts(hint.sourcePath).slice(0, -1);
            const key = JSON.stringify([hint.sourceKey ?? null, directory]);
            let scope = scopes.get(key);
            if (!scope) {
                scope = { directory, sourceKey: hint.sourceKey, records: [] };
                scopes.set(key, scope);
            }
            scope.records.push(record);
        }
    }
    const result = [...scopes.values()];
    logScopes.set(log, result);
    return result;
}

function directoryContains(scope: DirectoryScope, file: VendorFile): boolean {
    if (scope.sourceKey !== undefined && scope.sourceKey !== file.sourceKey) return false;
    const parts = pathParts(file.relativePath || file.file.name);
    return parts.length > scope.directory.length && scope.directory.every((part, index) => parts[index] === part);
}

function recordingViews(file: VideoWithRecordingCopies): readonly VendorFile[] {
    return [file, ...(file.recordingCopies ?? [])];
}

/** A pending route makes calibration available before any point matches video. */
export function hasDirectoryGpsForFile(file: VideoWithRecordingCopies, log: ParsedLog | null): boolean {
    return directoryGpsScopeKeysForFile(file, log).length > 0;
}

/** Identifies matching logs without requiring a time overlap with the recording. */
export function directoryGpsScopeKeysForFile(file: VideoWithRecordingCopies, log: ParsedLog | null): string[] {
    return [
        ...new Set(
            recordingViews(file).flatMap((view) =>
                directoryScopes(log)
                    .filter((scope) => directoryContains(scope, view))
                    .map((scope) => JSON.stringify([view.sourceKey ?? null, scope.directory])),
            ),
        ),
    ];
}

/** Pending source rows within the recording's directory scopes, without copies. */
export function directoryGpsRecordsForFile(
    file: VideoWithRecordingCopies,
    log: ParsedLog | null,
): readonly GpsRecord[] {
    const views = recordingViews(file);
    return directoryScopes(log)
        .filter((scope) => views.some((view) => directoryContains(scope, view)))
        .flatMap((scope) => scope.records);
}

function scopeKeys(file: VideoWithRecordingCopies, log: ParsedLog | null): string[] {
    return recordingViews(file).map((view) => {
        const nearest = directoryScopes(log)
            .filter((scope) => directoryContains(scope, view))
            .sort((a, b) => b.directory.length - a.directory.length)[0];
        // A shared GPS log identifies its card even when several card folders
        // were dropped together. Otherwise use the selected root folder.
        const parts = pathParts(view.relativePath || view.file.name);
        const directory = nearest?.directory ?? (parts.length > 1 ? parts.slice(0, 1) : []);
        return JSON.stringify([view.sourceKey ?? null, directory]);
    });
}

function persistentKeys(file: VideoWithRecordingCopies, log: ParsedLog | null): string[] {
    return recordingViews(file).flatMap((view) => {
        const identity = fileIdentityKey({
            relativePath: view.relativePath || view.file.name,
            size: view.file.size,
            lastModified: view.file.lastModified,
        });
        // Remembered folders have a stable physical-source identity. Ad-hoc
        // drop ids are session-only and cannot identify a later reopening.
        const folder = view.sourceKey?.startsWith("folder:") ? view.sourceKey : null;
        const key = JSON.stringify([folder, identity]);
        // A remembered folder remains identifiable after every old recording
        // has rotated away. Ad-hoc drops still need a known recording identity.
        return folder === null ? [key] : [key, JSON.stringify(["folder-scope", scopeKeys(view, log)[0]])];
    });
}

function loadEntries(): StoredTimezone[] {
    if (hasUnsavedEntries) return entries;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return entries;
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return entries;
        entries = parsed
            .filter((value): value is StoredTimezone => {
                if (typeof value !== "object" || value === null) return false;
                const item = value as Record<string, unknown>;
                return (
                    typeof item.key === "string" &&
                    item.key.length > 0 &&
                    (item.cohortKey === undefined ||
                        (typeof item.cohortKey === "string" && item.cohortKey.length > 0)) &&
                    (item.offsetSec === null || isCameraTimezoneOffset(item.offsetSec)) &&
                    typeof item.updatedAt === "number" &&
                    Number.isFinite(item.updatedAt) &&
                    item.updatedAt >= 0
                );
            })
            .slice(0, MAX_STORED_RECORDINGS)
            .map((entry) => ({
                ...entry,
                cohortKey: entry.cohortKey ?? entry.key,
            }));
    } catch {
        // Blocked or corrupt browser storage keeps the last usable session copy.
    }
    return entries;
}

function saveEntries(next: StoredTimezone[]): void {
    entries = next.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_STORED_RECORDINGS);
    hasUnsavedEntries = true;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
        hasUnsavedEntries = false;
    } catch {
        // The current page can still use the selected zone.
    }
}

/** Expands the selected recordings to their source folders, including copy aliases. */
export function cameraTimezonePeers(
    selected: readonly VideoCandidate[],
    candidates: readonly VideoCandidate[],
    log: ParsedLog | null,
): VideoCandidate[] {
    const keys = new Set(selected.flatMap((candidate) => scopeKeys(candidate, log)));
    return candidates.filter((candidate) => scopeKeys(candidate, log).some((key) => keys.has(key)));
}

function ambiguousPersistentKeys(candidates: readonly VideoCandidate[], log: ParsedLog | null): Set<string> {
    const scopesByIdentity = new Map<string, Set<string>>();
    const ambiguousIdentities = new Set<string>();
    for (const candidate of candidates) {
        const scopes = scopeKeys(candidate, log);
        for (const key of persistentKeys(candidate, log)) {
            const previous = scopesByIdentity.get(key);
            if (previous && !scopes.some((scope) => previous.has(scope))) ambiguousIdentities.add(key);
            const combined = previous ?? new Set<string>();
            for (const scope of scopes) combined.add(scope);
            scopesByIdentity.set(key, combined);
        }
    }
    return ambiguousIdentities;
}

/** Applies preferences before clock resolution; no raw GPS or cache bytes change. */
export function applyStoredCameraTimezones(candidates: readonly VideoCandidate[], log: ParsedLog | null): void {
    const saved = new Map(loadEntries().map((entry) => [entry.key, entry]));
    const preferences = new Map<string, SessionTimezone>();
    const cohortsByScope = new Map<string, Set<string>>();
    const ambiguousIdentities = ambiguousPersistentKeys(candidates, log);
    let changed = false;
    for (const key of ambiguousIdentities) {
        // Once an identity proves ambiguous it cannot safely restore a zone
        // when just one of those cards is reopened in a later session.
        if (saved.delete(key)) changed = true;
    }
    for (const candidate of candidates) {
        const matches = persistentKeys(candidate, log).flatMap((key) => {
            // Equal metadata in two simultaneously loaded cards cannot prove
            // which one owns a persisted ad-hoc identity. Session choices still
            // apply to their exact scopes, and known copy aliases stay connected.
            if (ambiguousIdentities.has(key)) return [];
            const match = saved.get(key);
            return match ? [match] : [];
        });
        for (const key of scopeKeys(candidate, log)) {
            const session = sessionOverrides.get(key);
            const cohorts = cohortsByScope.get(key) ?? new Set<string>();
            cohortsByScope.set(key, cohorts);
            for (const match of session ? [...matches, session] : matches) {
                cohorts.add(match.cohortKey);
                const current = preferences.get(key);
                if (!current || match.updatedAt > current.updatedAt) preferences.set(key, match);
            }
        }
    }
    // If two previously remembered subsets meet in the same scope, their
    // newest choice governs every known member, including unopened recordings.
    const cohortPreferences = new Map<string, SessionTimezone>();
    for (const [scope, cohorts] of cohortsByScope) {
        const preference = preferences.get(scope);
        if (!preference) continue;
        for (const cohort of cohorts) {
            const current = cohortPreferences.get(cohort);
            if (!current || preference.updatedAt > current.updatedAt) cohortPreferences.set(cohort, preference);
        }
    }
    const remember = (key: string, preference: SessionTimezone): void => {
        const previous = saved.get(key);
        if (
            previous?.cohortKey === preference.cohortKey &&
            previous.offsetSec === preference.offsetSec &&
            previous.updatedAt === preference.updatedAt
        )
            return;
        saved.set(key, {
            key,
            cohortKey: preference.cohortKey,
            offsetSec: preference.offsetSec,
            updatedAt: preference.updatedAt,
        });
        changed = true;
    };
    for (const entry of saved.values()) {
        const preference = cohortPreferences.get(entry.cohortKey);
        if (preference) remember(entry.key, preference);
    }
    for (const candidate of candidates) {
        let newest: SessionTimezone | undefined;
        for (const key of scopeKeys(candidate, log)) {
            const preference = preferences.get(key);
            if (preference && (!newest || preference.updatedAt > newest.updatedAt)) newest = preference;
        }
        candidate.cameraTimezoneOverrideSec = newest?.offsetSec ?? null;
        if (newest) {
            for (const key of persistentKeys(candidate, log)) {
                if (!ambiguousIdentities.has(key)) remember(key, newest);
            }
        }
    }
    if (changed) saveEntries([...saved.values()]);
}

export function setCameraTimezoneForRecordings(
    selected: readonly VideoCandidate[],
    candidates: readonly VideoCandidate[],
    log: ParsedLog | null,
    offsetSec: number | null,
): void {
    if (offsetSec !== null && !isCameraTimezoneOffset(offsetSec)) return;
    const peers = cameraTimezonePeers(selected, candidates, log);
    if (peers.length === 0) return;
    const previous = loadEntries();
    const updatedAt = Math.max(
        Date.now(),
        ...previous.map((entry) => entry.updatedAt + 1),
        ...[...sessionOverrides.values()].map((entry) => entry.updatedAt + 1),
    );
    const ambiguousIdentities = ambiguousPersistentKeys(candidates, log);
    const keys = new Set(
        peers.flatMap((candidate) => persistentKeys(candidate, log)).filter((key) => !ambiguousIdentities.has(key)),
    );
    const cohorts = new Set(previous.filter((entry) => keys.has(entry.key)).map((entry) => entry.cohortKey));
    const preference: SessionTimezone = {
        cohortKey:
            cohorts.values().next().value ??
            keys.values().next().value ??
            JSON.stringify(["session-scope", scopeKeys(peers[0]!, log)]),
        offsetSec,
        updatedAt,
    };
    const next = previous
        .map((entry) => (cohorts.has(entry.cohortKey) ? { ...entry, ...preference } : entry))
        .filter((entry) => !keys.has(entry.key));
    for (const key of peers.flatMap((candidate) => scopeKeys(candidate, log))) {
        sessionOverrides.set(key, preference);
    }
    for (const key of keys) next.push({ key, ...preference });
    saveEntries(next);
    applyStoredCameraTimezones(candidates, log);
}

export function _resetForTests(): void {
    entries = [];
    hasUnsavedEntries = false;
    sessionOverrides = new Map();
    logScopes = new WeakMap();
}

import { directoryGpsRecordsForFile, directoryGpsScopeKeysForFile } from "../camera-timezone.js";
import { tripHasRawGps } from "../gps-sync.js";
import { isValidGpsFix } from "../parser.js";
import { classifyFilenameTime } from "../parsers/filename/index.js";
import type { ParsedLog } from "../parsers/types.js";
import { type Trip, tripAllCandidates, type VideoCandidate } from "../trips.js";

import { getTripCameraTimezoneState } from "./camera-timezone.js";
import { notify } from "./notifications.js";
import { activeTrip, state } from "./state.js";

let notifiedScopes = new Set<string>();
let timestampsByLog = new WeakMap<ParsedLog, Map<string, number[]>>();

function directoryScopesForTrip(trip: Trip): string[] {
    return tripAllCandidates(trip).flatMap((candidate) => directoryGpsScopeKeysForFile(candidate, state.gpsLog));
}

function validDirectoryTimes(candidate: VideoCandidate, log: ParsedLog): number[] {
    let byScope = timestampsByLog.get(log);
    if (!byScope) {
        byScope = new Map();
        timestampsByLog.set(log, byScope);
    }
    const key = JSON.stringify(directoryGpsScopeKeysForFile(candidate, log).sort());
    const cached = byScope.get(key);
    if (cached) return cached;
    const times = [
        ...new Set(
            directoryGpsRecordsForFile(candidate, log)
                .filter(
                    (record) => isValidGpsFix(record) && !record.timeUnsynced && Number.isFinite(record.unixSeconds),
                )
                .map((record) => record.unixSeconds),
        ),
    ].sort((a, b) => a - b);
    byScope.set(key, times);
    return times;
}

function firstAtOrAfter(times: readonly number[], target: number): number {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (times[mid]! < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** This is only a reason to offer calibration, never evidence to bind a route.
 * Require two distinct valid fixes under one alternative supported zone, so a
 * no-fix log or an unrelated day's route does not imply a clock problem. */
function hasPlausibleTimezone(trip: Trip, log: ParsedLog): boolean {
    const windows = tripAllCandidates(trip).flatMap((candidate) => {
        const span = candidate.wallDurationSec ?? candidate.durationSec;
        if (
            candidate.metadataReady === false ||
            candidate.metadataFailed ||
            candidate.startSource === "mtime" ||
            !Number.isFinite(candidate.startUtc) ||
            !Number.isFinite(span) ||
            span <= 0
        ) {
            return [];
        }
        const clock = classifyFilenameTime(candidate);
        if (!clock) return [];
        const naive = clock.getTime() / 1000;
        const times = validDirectoryTimes(candidate, log);
        return Number.isFinite(naive) && times.length > 0
            ? [{ naive, span, currentOffset: naive - candidate.startUtc, times }]
            : [];
    });
    for (let offset = -12 * 3600; offset <= 14 * 3600; offset += 900) {
        let firstFix: number | undefined;
        for (const { naive, span, currentOffset, times } of windows) {
            if (Math.abs(currentOffset - offset) < 1) continue;
            const start = naive - offset;
            const index = firstAtOrAfter(times, start);
            const fix = times[index];
            if (fix === undefined || fix >= start + span) continue;
            if (firstFix !== undefined && fix !== firstFix) return true;
            if (times[index + 1] !== undefined && times[index + 1]! < start + span) return true;
            firstFix = fix;
        }
    }
    return false;
}

/** Call only after the selected trip's metadata and GPS preparation completes.
 * Source keys keep the hint to one notice per opened folder, even when a
 * rebind replaces the log or the user opens another trip beneath that folder. */
export function notifyUnmatchedDirectoryGps(trip: Trip | null, openSync: () => void): void {
    if (!trip || tripHasRawGps(trip) || getTripCameraTimezoneState(trip) === null) return;
    const scopes = new Set(directoryScopesForTrip(trip));
    if (!state.gpsLog || ![...scopes].some((scope) => !notifiedScopes.has(scope))) return;
    if (
        state.trips.some(
            (other) =>
                other !== trip &&
                tripHasRawGps(other) &&
                directoryScopesForTrip(other).some((scope) => scopes.has(scope)),
        ) ||
        !hasPlausibleTimezone(trip, state.gpsLog)
    ) {
        return;
    }
    for (const scope of scopes) notifiedScopes.add(scope);

    notify({
        severity: "info",
        messageKey: "gpsSync.timezone.unmatchedNotification",
        actionKey: "gpsSync.open",
        dedupKey: JSON.stringify([...scopes].sort()),
        onAction: () => {
            // A toast can outlive its trip. Follow a sibling's current panel,
            // but never open calibration for an unrelated folder.
            const current = activeTrip();
            if (
                current &&
                getTripCameraTimezoneState(current) !== null &&
                directoryScopesForTrip(current).some((scope) => scopes.has(scope))
            ) {
                openSync();
            }
        },
    });
}

export function _resetForTests(): void {
    notifiedScopes = new Set();
    timestampsByLog = new WeakMap();
}

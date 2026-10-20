import { hasDirectoryGpsForFile, isCameraTimezoneOffset } from "../camera-timezone.js";
import { tripHasRawGps } from "../gps-sync.js";
import { classifyFilenameTime } from "../parsers/filename/index.js";
import { type Trip, tripAllCandidates } from "../trips.js";

import { state } from "./state.js";

export interface TripCameraTimezoneState {
    overrideSec: number | null;
    effectiveSec: number;
    fromDevice: boolean;
    cameraUnix: number;
    utcUnix: number;
}

let applyTimezone: ((trip: Trip, offsetSec: number | null) => void) | null = null;

/** Keeps the small dialog/launcher path independent of the ingest orchestrator. */
export function registerCameraTimezoneHandler(handler: (trip: Trip, offsetSec: number | null) => void): void {
    applyTimezone = handler;
}

export function getTripCameraTimezoneState(trip: Trip | null): TripCameraTimezoneState | null {
    if (!trip) return null;
    for (const candidate of tripAllCandidates(trip)) {
        const clock = classifyFilenameTime(candidate);
        if (!clock) continue;
        const cameraUnix = clock.getTime() / 1000;
        const overrideSec = candidate.cameraTimezoneOverrideSec ?? null;
        const inferred = candidate.cameraTzSec;
        const fromDevice = overrideSec === null && inferred === null;
        // Resolve the browser offset at the recording's date, including DST.
        const localDate = new Date(
            clock.getUTCFullYear(),
            clock.getUTCMonth(),
            clock.getUTCDate(),
            clock.getUTCHours(),
            clock.getUTCMinutes(),
            clock.getUTCSeconds(),
        );
        const effectiveSec = overrideSec ?? inferred ?? -localDate.getTimezoneOffset() * 60;
        return { overrideSec, effectiveSec, fromDevice, cameraUnix, utcUnix: cameraUnix - effectiveSec };
    }
    return null;
}

export function tripCanSyncGps(trip: Trip | null): boolean {
    if (tripHasRawGps(trip)) return true;
    if (!trip || !getTripCameraTimezoneState(trip)) return false;
    return tripAllCandidates(trip).some(
        (candidate) => candidate.cameraTimezoneOverrideSec != null || hasDirectoryGpsForFile(candidate, state.gpsLog),
    );
}

export function setTripCameraTimezone(trip: Trip, offsetSec: number | null): void {
    if (offsetSec !== null && !isCameraTimezoneOffset(offsetSec)) return;
    applyTimezone?.(trip, offsetSec);
}

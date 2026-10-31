import { applyStoredGpsSyncToFreshTrip } from "../gps-sync.js";
import { applyStoredCameraTimezones, setCameraTimezoneForRecordings } from "../camera-timezone.js";
import { attachRecordsToCandidates } from "../gps-association.js";
import { bindRecordingLogs } from "../gps-time-association.js";
import { classifyFilenameClockTimelapse, classifyFilenameTime } from "../parsers/filename/index.js";
import {
    finalizeTripFromFrames,
    rederiveStartUtcForCandidates,
    type Trip,
    tripAllCandidates,
    type VideoCandidate,
} from "../trips.js";

import { applyRegroup } from "./apply-regroup.js";
import { carryBlurRegions } from "./blur-regions-state.js";
import { rebuildChartFromTrip } from "./chart.js";
import { refreshMap } from "./map.js";
import { state } from "./state.js";
import { carryOverTripPreviews } from "./trip-preview.js";

interface RecordingWorkCoordinator {
    pauseForRegroup: () => boolean;
    resumeAfterRegroup: () => void;
}

let workCoordinator: RecordingWorkCoordinator | null = null;

/** Connects the progressive scheduler without importing it back into this
 * commit-boundary module (which would create a dependency cycle). */
export function registerRecordingWorkCoordinator(coordinator: RecordingWorkCoordinator): void {
    workCoordinator = coordinator;
}

/** Recomputes absolute recording clocks without replacing the current trip list.
 * Returns how many pending log rows the new clocks bound to recordings. */
export function reanchorRecordingCandidates(candidates: VideoCandidate[]): {
    boundRecords: number;
    boundVideos: number;
} {
    applyStoredCameraTimezones(candidates, state.gpsLog);
    rederiveStartUtcForCandidates(candidates, classifyFilenameTime, classifyFilenameClockTimelapse);
    // Deferred embedded GPS or a camera-zone choice can move the clocks that
    // both recording-start and directory-window hints are matched against, so
    // every pending log is re-offered on the new clock.
    if (!state.gpsLog || state.gpsLog.pendingByFilename.size === 0) return { boundRecords: 0, boundVideos: 0 };
    const bound = bindRecordingLogs(state.gpsLog, candidates);
    state.gpsLog = bound.log;
    attachRecordsToCandidates(bound.log, candidates, candidates);
    return { boundRecords: bound.boundRecords, boundVideos: bound.boundVideos };
}

/** A camera-zone edit changes recording ownership before rebuilding the viewer. */
export function applyRecordingCameraTimezone(trip: Trip, offsetSec: number | null): void {
    const coordinator = workCoordinator;
    const paused = coordinator?.pauseForRegroup() ?? false;
    try {
        const candidates = state.trips.flatMap(tripAllCandidates);
        setCameraTimezoneForRecordings(tripAllCandidates(trip), candidates, state.gpsLog, offsetSec);
        reanchorRecordingCandidates(candidates);
        commitRecordingTrips(candidates);
    } finally {
        if (paused) coordinator?.resumeAfterRegroup();
    }
}

/** Groups already-anchored candidates and atomically replaces the trip list. */
export function commitRecordingTrips(candidates: VideoCandidate[]): void {
    applyRegroup(candidates);
}

/** External metadata/settings changes use this boundary so index-keyed reads
 * cannot write through a regroup. The scheduler resumes from live trip objects. */
export function commitRecordingTripsWhilePreservingIngest(candidates: VideoCandidate[]): void {
    const coordinator = workCoordinator;
    const paused = coordinator?.pauseForRegroup() ?? false;
    try {
        commitRecordingTrips(candidates);
    } finally {
        if (paused) coordinator?.resumeAfterRegroup();
    }
}

/** Rebuilds aggregates after the caller has attached current records and timing. */
export function refreshRecordingTrip(tripIdx: number): void {
    const old = state.trips[tripIdx];
    if (!old) return;
    const refreshed = finalizeTripFromFrames(old.frames);
    applyStoredGpsSyncToFreshTrip(refreshed);
    carryOverTripPreviews([old], [refreshed]);
    state.trips[tripIdx] = refreshed;
    // Same frames mean the same content timeline; blur keyframes remain valid.
    // Notify only after the slot swap so listeners read the new trip.
    carryBlurRegions([old], [refreshed]);

    if (state.active?.trip === tripIdx) {
        rebuildChartFromTrip(refreshed);
        refreshMap(refreshed);
    }
}

// Resolves only genuine loose XML GPX files: classification has already given
// model-specific logs/sidecars and exact-basename GPX their authoritative
// owners before this module sees the remaining role=unknown files.

import { throwIfCancelled } from "../abort-signals.js";
import { parseGpxTrack } from "../parsers/sidecars/gpx.js";
import type { ClassifiedFile } from "../parsers/registry-light.js";
import type { GpsRecord } from "../parsers/types.js";
import { fileIdentityKey, fileIdentityOf } from "../persist/identity.js";
import type { Trip } from "../trips.js";
import { showGpxAssignmentModal } from "./gpx-assignment-modal.js";
import { looseGpxTargets, planLooseGpxAssignments, recordsForLooseGpxAssignments } from "./loose-gpx-assignment.js";
import { looseGpxFiles, type ParsedLooseGpx } from "./loose-gpx.js";

interface LooseGpxCopy {
    tripLabel: (name: string) => string;
    unassigned: string;
    alreadyHasGps: string;
    timeMatches: string;
    timeMismatch: string;
    timeUncertain: string;
}

export interface LooseGpxResolution {
    records: GpsRecord[];
    assignedFiles: number;
    needsTrip: boolean;
    errors: Array<{ file: string; sidecarId: string; message: string }>;
}

async function parseLooseTracks(
    files: readonly ClassifiedFile[],
    signal?: AbortSignal,
): Promise<{ tracks: ParsedLooseGpx[]; errors: LooseGpxResolution["errors"] }> {
    const tracks: ParsedLooseGpx[] = [];
    const errors: LooseGpxResolution["errors"] = [];
    for (const item of files) {
        throwIfCancelled(signal);
        try {
            // The temporary filename is replaced with the confirmed trip anchor
            // before records enter GpsLog.
            const parsed = await parseGpxTrack(item.file, item.file.file.name, signal);
            tracks.push({
                file: item,
                records: parsed.records,
                timeRanges: parsed.timeRanges,
                hasExplicitTimezone: parsed.hasExplicitTimezone,
                trackKey: fileIdentityKey(fileIdentityOf(item.file.file, item.file.relativePath)),
            });
        } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") throw err;
            errors.push({
                file: item.file.file.name,
                sidecarId: "gpx",
                message: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return { tracks, errors };
}

export async function resolveLooseGpxFiles(
    classified: readonly ClassifiedFile[],
    trips: readonly Trip[],
    protectedGpsVideoKeys: ReadonlySet<string>,
    copy: LooseGpxCopy,
    signal?: AbortSignal,
): Promise<LooseGpxResolution> {
    const files = looseGpxFiles(classified);
    if (files.length === 0) return { records: [], assignedFiles: 0, needsTrip: false, errors: [] };

    const parsed = await parseLooseTracks(files, signal);
    const targets = looseGpxTargets(trips, protectedGpsVideoKeys);
    if (targets.length === 0) {
        return { records: [], assignedFiles: 0, needsTrip: true, errors: parsed.errors };
    }

    const plans = planLooseGpxAssignments(parsed.tracks, targets);
    if (plans.length === 0) {
        return { records: [], assignedFiles: 0, needsTrip: false, errors: parsed.errors };
    }
    const assignments = await showGpxAssignmentModal(plans, copy, signal);
    throwIfCancelled(signal);
    return {
        records: recordsForLooseGpxAssignments(assignments),
        assignedFiles: assignments.length,
        needsTrip: false,
        errors: parsed.errors,
    };
}

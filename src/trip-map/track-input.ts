// Packs a trip's GPS records into transferable arrays for the trip-map worker.
// Kept apart from track-geometry.ts so the worker bundle does not pull in the
// parser module just for the fix-validity check.

import { isSameTrackSegment } from "../gps-telemetry.js";
import { isValidGpsFix } from "../parser.js";
import type { GpsRecord } from "../parsers/types.js";

/** Valid fixes of one trip in time order, one array element per fix. */
export interface PackedTripTrack {
    lat: Float64Array;
    lon: Float64Array;
    unixSeconds: Float64Array;
    /** 1 when the source declares a continuity cut before this fix (trackSegment). */
    cutBefore: Uint8Array;
}

/**
 * Copies the usable fixes of `records` (already GPS-synced trip records) into
 * flat arrays. Invalid fixes are skipped; a declared track-segment change
 * between two kept fixes is preserved as a cut, so the geometry never bridges
 * a restart the source itself reported.
 */
export function packTripRecords(records: readonly GpsRecord[]): PackedTripTrack {
    let count = 0;
    for (const record of records) if (isValidGpsFix(record)) count++;
    const packed: PackedTripTrack = {
        lat: new Float64Array(count),
        lon: new Float64Array(count),
        unixSeconds: new Float64Array(count),
        cutBefore: new Uint8Array(count),
    };
    let index = 0;
    let previous: GpsRecord | null = null;
    for (const record of records) {
        if (!isValidGpsFix(record)) continue;
        packed.lat[index] = record.lat;
        packed.lon[index] = record.lon;
        packed.unixSeconds[index] = record.unixSeconds;
        packed.cutBefore[index] = previous && !isSameTrackSegment(previous, record) ? 1 : 0;
        previous = record;
        index++;
    }
    return packed;
}

/** Transferable buffers of a packed track, for a zero-copy hand-off to the worker. */
export function packedTrackTransfer(packed: PackedTripTrack): Transferable[] {
    return [packed.lat.buffer, packed.lon.buffer, packed.unixSeconds.buffer, packed.cutBefore.buffer];
}

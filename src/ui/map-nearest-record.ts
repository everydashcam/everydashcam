// Nearest-GPS-fix lookup for map hover and click. Pointer moves query the same
// track many times per second, so the per-record projection (a log/tan per
// latitude) is done once per track instead of once per query.

import { mercatorY, wrapDegrees } from "../coordinates.js";
import { isValidGpsFix } from "../parser.js";
import type { GpsRecord } from "../parsers/types.js";

/** Valid fixes of one record array, projected for repeated nearest-point queries. */
export interface ProjectedTrack {
    /** The array this projection was built from, as an identity for staleness checks. */
    readonly records: readonly GpsRecord[];
    /** records.length at projection time: appending in place also makes it stale. */
    readonly recordCount: number;
    /** Index into records of each projected fix, in record order. */
    readonly recordIndices: Int32Array;
    readonly lons: Float64Array;
    readonly mercatorYs: Float64Array;
}

/** Projects every valid GPS fix of `records`; invalid fixes are left out. */
export function projectTrack(records: readonly GpsRecord[]): ProjectedTrack {
    const recordIndices = new Int32Array(records.length);
    const lons = new Float64Array(records.length);
    const mercatorYs = new Float64Array(records.length);
    let count = 0;
    for (let i = 0; i < records.length; i++) {
        const record = records[i]!;
        if (!isValidGpsFix(record)) continue;
        recordIndices[count] = i;
        lons[count] = record.lon;
        mercatorYs[count] = mercatorY(record.lat);
        count++;
    }
    return {
        records,
        recordCount: records.length,
        recordIndices: recordIndices.subarray(0, count),
        lons: lons.subarray(0, count),
        mercatorYs: mercatorYs.subarray(0, count),
    };
}

/** Whether `track` was built from exactly this array at its current length. */
export function isProjectionOf(track: ProjectedTrack | null, records: readonly GpsRecord[]): track is ProjectedTrack {
    return track !== null && track.records === records && track.recordCount === records.length;
}

/**
 * Returns the index into the projected records of the fix nearest to (lat, lng)
 * in Web Mercator degrees, or -1 when the track has no valid fix. Longitude is
 * compared across the antimeridian. Ties keep the earliest record, so a route
 * that passes the same spot twice resolves to its first pass.
 */
export function nearestProjectedRecordIndex(track: ProjectedTrack, lat: number, lng: number): number {
    const targetY = mercatorY(lat);
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let k = 0; k < track.recordIndices.length; k++) {
        const dLat = track.mercatorYs[k]! - targetY;
        const dLon = wrapDegrees(track.lons[k]! - lng);
        const distance = dLat * dLat + dLon * dLon;
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = track.recordIndices[k]!;
        }
    }
    return bestIndex;
}

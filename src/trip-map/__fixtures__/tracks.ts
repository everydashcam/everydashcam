// Synthetic tracks for the trip-map unit tests and bench: a local metric frame
// around a reference point, so tests describe drives in metres and seconds.

import { buildTripMapTrack, type TripMapTrack } from "../track-geometry.js";
import type { PackedTripTrack } from "../track-input.js";

export const ORIGIN_LAT = 52.37;
export const ORIGIN_LON = 4.89;
export const START_SEC = 1_700_000_000;
const METERS_PER_DEGREE_LAT = 111_320;

export interface LocalFix {
    eastM: number;
    northM: number;
    unixSeconds: number;
    /** Declared continuity cut before this fix. */
    isCut?: boolean;
}

export function latForNorth(northM: number): number {
    return ORIGIN_LAT + northM / METERS_PER_DEGREE_LAT;
}

export function lonForEast(eastM: number): number {
    return ORIGIN_LON + eastM / (METERS_PER_DEGREE_LAT * Math.cos((ORIGIN_LAT * Math.PI) / 180));
}

export function northForLat(lat: number): number {
    return (lat - ORIGIN_LAT) * METERS_PER_DEGREE_LAT;
}

export function eastForLon(lon: number): number {
    return (lon - ORIGIN_LON) * METERS_PER_DEGREE_LAT * Math.cos((ORIGIN_LAT * Math.PI) / 180);
}

export function packLocalFixes(fixes: readonly LocalFix[]): PackedTripTrack {
    return {
        lat: Float64Array.from(fixes, (fix) => latForNorth(fix.northM)),
        lon: Float64Array.from(fixes, (fix) => lonForEast(fix.eastM)),
        unixSeconds: Float64Array.from(fixes, (fix) => fix.unixSeconds),
        cutBefore: Uint8Array.from(fixes, (fix) => (fix.isCut ? 1 : 0)),
    };
}

/**
 * A drive through local waypoints at a constant speed, one fix per second.
 * `lateralM` shifts the whole drive sideways from its direction of travel,
 * which turns repeated drives into parallel strands.
 */
export function driveThrough(
    waypoints: readonly [eastM: number, northM: number][],
    options: { speedMs?: number; startSec?: number; lateralM?: number } = {},
): LocalFix[] {
    const speed = options.speedMs ?? 12;
    const lateral = options.lateralM ?? 0;
    const start = options.startSec ?? START_SEC;
    const fixes: LocalFix[] = [];
    for (let w = 0; w < waypoints.length - 1; w++) {
        const [ax, ay] = waypoints[w]!;
        const [bx, by] = waypoints[w + 1]!;
        const length = Math.hypot(bx - ax, by - ay);
        const nx = -(by - ay) / length;
        const ny = (bx - ax) / length;
        const steps = Math.max(1, Math.round(length / speed));
        for (let s = w === 0 ? 0 : 1; s <= steps; s++) {
            const f = s / steps;
            fixes.push({
                eastM: ax + (bx - ax) * f + nx * lateral,
                northM: ay + (by - ay) * f + ny * lateral,
                unixSeconds: start + fixes.length,
            });
        }
    }
    return fixes;
}

export function trackFromFixes(fixes: readonly LocalFix[]): TripMapTrack {
    return buildTripMapTrack(packLocalFixes(fixes));
}

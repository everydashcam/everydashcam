// ASXT-tagged freeGPS records with clock-indexed coordinate factors.
// Format reference: docs/format-freegps-asxt.md.
// Offsets here start at the freeGPS literal, four bytes after the box size.

import { type GpsRecord, KNOTS_TO_MS } from "../types.js";
import { isDashcamYear, utcMillisecondsFromParts } from "./calendar.js";
import { ddmmToDegrees, isCoordinateInRange } from "./ddmm.js";

const HEADER_LENGTH = 120;
const RECORD_LENGTH = 156;
const FACTORS: readonly number[] = [
    25, 25, 36, 38, 46, 53, 33, 25, 31, 31, 21, 57, 17, 44, 27, 76, 22, 26, 56, 29, 63, 26, 12, 86, 46, 14, 49, 75, 44,
    26, 87, 12, 56, 38, 35, 47, 58, 32, 34, 26, 66, 25, 26, 68, 47, 14, 33, 66, 28, 57, 23, 26, 28, 64, 66, 78, 17, 61,
    43, 12,
];

/** Keeps incomplete ASXT records out of the generic freeGPS coordinate decoder. */
export function hasAsxtFreeGpsSignature(payload: DataView): boolean {
    if (payload.byteLength < HEADER_LENGTH) return false;
    if (payload.getUint32(0) !== 0x66726565 || payload.getUint32(4) !== 0x47505320) return false; // freeGPS
    if (payload.getUint32(8, true) !== 1008) return false;
    for (const offset of [12, 28]) {
        if (payload.getUint32(offset) !== 0x495a4545 || payload.getUint32(offset + 4) !== 0x4b455200) return false; // IZEEKER\0
    }
    if (payload.getUint32(116) !== 0x41535854) return false; // ASXT
    for (let offset = 100; offset < 116; offset++) {
        const byte = payload.getUint8(offset);
        if (!((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46))) return false;
    }
    return true;
}

/** Returns a timezone-free clock value, including timed records without a fix. */
export function readAsxtWallClock(payload: DataView): number | null {
    if (payload.byteLength < RECORD_LENGTH || !hasAsxtFreeGpsSignature(payload)) return null;
    const status = payload.getUint8(68);
    if ((status !== 0x41 && status !== 0x56) || payload.getUint8(71) !== 0) return null;
    const year = payload.getUint32(144, true);
    if (!isDashcamYear(year)) return null;
    const milliseconds = utcMillisecondsFromParts(
        year,
        payload.getUint32(148, true),
        payload.getUint32(152, true),
        payload.getUint32(132, true),
        payload.getUint32(136, true),
        payload.getUint32(140, true),
    );
    // UTC arithmetic preserves wall-clock intervals without the browser's
    // timezone. This value is not evidence of a UTC recording timestamp.
    return milliseconds === null ? null : milliseconds / 1000;
}

export function parseAsxtFreeGps(payload: DataView, mp4Filename: string): GpsRecord[] {
    const unixSeconds = readAsxtWallClock(payload);
    if (unixSeconds === null || payload.getUint8(68) !== 0x41) return [];

    const hour = payload.getUint32(44, true);
    const minute = payload.getUint32(48, true);
    const second = payload.getUint32(52, true);
    if (hour > 23 || minute > 59 || second > 59) return [];
    const latHemisphere = payload.getUint8(69);
    const lonHemisphere = payload.getUint8(70);
    if (latHemisphere !== 0x4e && latHemisphere !== 0x53) return [];
    if (lonHemisphere !== 0x45 && lonHemisphere !== 0x57) return [];

    const latDdmm = ((payload.getFloat64(76, true) - 287.111) * 10) / FACTORS[second]!;
    const lonDdmm = ((payload.getFloat64(84, true) - 125.854) * 10) / FACTORS[minute]!;
    if (latDdmm < 0 || lonDdmm < 0) return [];
    const lat = ddmmToDegrees(latDdmm) * (latHemisphere === 0x53 ? -1 : 1);
    const lon = ddmmToDegrees(lonDdmm) * (lonHemisphere === 0x57 ? -1 : 1);
    if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) return [];

    const speedKnots = payload.getFloat32(92, true);
    const bearingDeg = payload.getFloat32(96, true);
    if (!Number.isFinite(speedKnots) || speedKnots < 0 || speedKnots > 1000) return [];
    if (!Number.isFinite(bearingDeg) || bearingDeg < 0 || bearingDeg >= 360) return [];
    return [
        {
            unixSeconds,
            timeUnsynced: true,
            active: true,
            lat,
            lon,
            speedMs: speedKnots * KNOTS_TO_MS,
            bearingDeg,
            // The three signed ASXT sensor fields have no established unit or
            // axis convention, so raw counts cannot populate acceleration in g.
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename,
        },
    ];
}

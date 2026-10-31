import { matchesBytesAt } from "./byte-search.js";
import { type GpsRecord, KMH_TO_MS } from "../types.js";
import { utcMillisecondsFromParts } from "./calendar.js";

const MAGIC = new TextEncoder().encode("Viidure");
const decoder = new TextDecoder();
const RECORD =
    /^Viidure(20\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([NS]):(\d+(?:\.\d+)?) ([EW]):(\d+(?:\.\d+)?) (\d+(?:\.\d+)?) km\/h (\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) (\d+) x:(-?\d+(?:\.\d+)?) y:(-?\d+(?:\.\d+)?) z:(-?\d+(?:\.\d+)?)$/;

export function hasViidureBody(body: Uint8Array): boolean {
    return matchesBytesAt(body, 0, MAGIC);
}

export function parseViidureBody(body: Uint8Array, mp4Filename: string): GpsRecord | null {
    const end = body.indexOf(0);
    const match = decoder.decode(end < 0 ? body : body.subarray(0, end)).match(RECORD);
    if (!match) return null;
    const timestamp = utcMillisecondsFromParts(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
    );
    const lat = Number(match[8]) * (match[7] === "S" ? -1 : 1);
    const lon = Number(match[10]) * (match[9] === "W" ? -1 : 1);
    const speedMs = Number(match[11]) * KMH_TO_MS;
    const bearingDeg = Number(match[12]);
    if (
        timestamp === null ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180 ||
        (lat === 0 && lon === 0) ||
        !Number.isFinite(speedMs) ||
        !Number.isFinite(bearingDeg) ||
        bearingDeg > 360
    )
        return null;
    return {
        unixSeconds: timestamp / 1000,
        active: true,
        lat,
        lon,
        speedMs,
        bearingDeg,
        // N2 samples carry constant -0.001 axis placeholders; scale and mount are unknown.
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename,
    };
}

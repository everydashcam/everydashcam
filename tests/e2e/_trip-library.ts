// A small synthetic library for the map of all trips: copies of one public
// corpus video, each with its own NMEA track on its own day, plus optional
// clips without GPS and a clip whose GPS is read only in full (one freeGPS
// block, as in progressive-ingest.spec.ts).

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { REPO_ROOT, SAMPLE_NOGPS } from "./_fixtures.js";

const VIDEO = path.join(REPO_ROOT, "tests/testdata/dashcam-viewer-corpus/MOV_0581.mp4");
const ORIGIN_LAT = 52.37;
const ORIGIN_LON = 4.89;
const METERS_PER_DEGREE = 111_320;
const SPEED_MS = 12;
export const DEFERRED_GPS_FILENAME = "2021_1013_183759_050.MP4";

/** A road in local metres east/north of the library origin. */
export type Road = readonly (readonly [eastM: number, northM: number])[];

export const EAST_ROAD: Road = [
    [0, 0],
    [3000, 0],
];
export const NORTH_ROAD: Road = [
    [0, 4000],
    [3000, 4000],
];

export interface TripLibraryOptions {
    /** One trip per road, in day order. */
    roads: readonly Road[];
    withoutGps?: number;
    hasDeferredGps?: boolean;
}

/** Longitude/latitude of a point of a road, for projecting it on the map. */
export function roadPoint(eastM: number, northM: number): [lon: number, lat: number] {
    return [
        ORIGIN_LON + eastM / (METERS_PER_DEGREE * Math.cos((ORIGIN_LAT * Math.PI) / 180)),
        ORIGIN_LAT + northM / METERS_PER_DEGREE,
    ];
}

function nmeaLine(body: string): string {
    let sum = 0;
    for (const ch of body) sum ^= ch.charCodeAt(0);
    return `$${body}*${sum.toString(16).toUpperCase().padStart(2, "0")}`;
}

function nmeaCoordinate(value: number, degreeDigits: number): string {
    const degrees = Math.floor(Math.abs(value));
    const minutes = (Math.abs(value) - degrees) * 60;
    return `${String(degrees).padStart(degreeDigits, "0")}${minutes.toFixed(4).padStart(7, "0")}`;
}

function nmeaFor(road: Road, startMs: number): string {
    const lines: string[] = [];
    let second = 0;
    for (let i = 0; i + 1 < road.length; i++) {
        const [ax, ay] = road[i]!;
        const [bx, by] = road[i + 1]!;
        const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / SPEED_MS));
        for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
            const [lon, lat] = roadPoint(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps);
            const t = new Date(startMs + second++ * 1000);
            const pad = (value: number) => String(value).padStart(2, "0");
            const hms = `${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}.000`;
            const dmy = `${pad(t.getUTCDate())}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCFullYear() % 100)}`;
            const knots = (SPEED_MS / 0.514444).toFixed(2);
            lines.push(
                nmeaLine(
                    `GPRMC,${hms},A,${nmeaCoordinate(lat, 2)},N,${nmeaCoordinate(lon, 3)},E,${knots},90.00,${dmy},,,A`,
                ),
            );
        }
    }
    return `${lines.join("\r\n")}\r\n`;
}

function withMvhdCreationTime(source: string, iso: string): Buffer {
    const bytes = readFileSync(source);
    const marker = bytes.indexOf("mvhd", 0, "ascii");
    if (marker < 0 || bytes[marker + 4] !== 0) throw new Error("fixture needs a version-0 mvhd box");
    const quickTimeSeconds = Date.parse(iso) / 1000 + 2_082_844_800;
    bytes.writeUInt32BE(quickTimeSeconds, marker + 8);
    bytes.writeUInt32BE(quickTimeSeconds, marker + 12);
    return bytes;
}

function freeGpsBlock(): Buffer {
    const gps = readFileSync(path.join(REPO_ROOT, "tests/testdata/novatek-real-anonymized/2e-drive-730.mp4"));
    for (let offset = 0; offset + 8 <= gps.length; ) {
        const size = gps.readUInt32BE(offset);
        if (size < 8 || offset + size > gps.length) break;
        if (gps.toString("ascii", offset + 4, offset + 8) === "free") return gps.subarray(offset, offset + size);
        offset += size;
    }
    throw new Error("missing freeGPS fixture box");
}

const writtenLibraries: string[] = [];

/** Removes every library this worker wrote; for the spec's afterAll. */
export function removeTripLibraries(): void {
    for (const directory of writtenLibraries.splice(0)) rmSync(directory, { recursive: true, force: true });
}

/** Writes the library into a new temporary directory and returns its path; removeTripLibraries deletes it. */
export function writeTripLibrary(options: TripLibraryOptions): string {
    const directory = mkdtempSync(path.join(tmpdir(), "everydashcam-trip-map-"));
    writtenLibraries.push(directory);
    options.roads.forEach((road, index) => {
        const name = `MOV_${String(index + 1).padStart(4, "0")}`;
        copyFileSync(VIDEO, path.join(directory, `${name}.mp4`));
        writeFileSync(path.join(directory, `${name}.nmea`), nmeaFor(road, Date.UTC(2026, 8, 1 + index, 7, 30)));
    });
    const noGpsClip = path.join(SAMPLE_NOGPS, "clip-no-gps.mp4");
    for (let k = 0; k < (options.withoutGps ?? 0); k++) {
        const day = String(k + 1).padStart(2, "0");
        writeFileSync(
            path.join(directory, `NO202001${day}-120000-000001F.MP4`),
            withMvhdCreationTime(noGpsClip, `2020-01-${day}T12:00:00.000Z`),
        );
    }
    if (options.hasDeferredGps) {
        writeFileSync(
            path.join(directory, DEFERRED_GPS_FILENAME),
            Buffer.concat([withMvhdCreationTime(noGpsClip, "2021-10-13T18:37:59.000Z"), freeGpsBlock()]),
        );
    }
    return directory;
}

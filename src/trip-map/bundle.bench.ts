// Cost of the trip map on a whole library: track simplification and the first
// corridor computation run in the worker and must stay within seconds; place
// queries run on the main thread and must stay within milliseconds.
//
// The library is synthetic by default: three corridors driven 140, 45 and 12
// times with GPS-like noise plus 200 one-off drives, about 600k fixes. Set
// TRIP_MAP_LIBRARY to a reference real-data.js (window.REAL_DATA = [...], see
// private/plans/trip-map-search-reference) to add real tracks; their longest
// drives are then the corridors.

import { readFileSync } from "node:fs";
import { it } from "vitest";

import { buildTripBundle, type BundleTrack } from "./bundle.js";
import { foldFarTrips } from "./far-dots.js";
import { trackIntersectsArea, tripPassesThroughCircle } from "./queries.js";
import { buildTripMapTrack, type TripMapTrack } from "./track-geometry.js";
import type { PackedTripTrack } from "./track-input.js";
import { groundMetersPerWorldUnit } from "./world.js";

function mulberry32(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const random = mulberry32(11);
const gauss = (): number => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
const METERS_PER_DEGREE = 111_320;

interface RawDrive {
    lat: number[];
    lon: number[];
    time: number[];
}

function pack(drive: RawDrive): PackedTripTrack {
    return {
        lat: Float64Array.from(drive.lat),
        lon: Float64Array.from(drive.lon),
        unixSeconds: Float64Array.from(drive.time),
        cutBefore: new Uint8Array(drive.lat.length),
    };
}

/** A wandering drive at about 12 m/s, one fix per second. */
function randomDrive(lat0: number, lon0: number, seconds: number, start: number): RawDrive {
    const drive: RawDrive = { lat: [], lon: [], time: [] };
    let heading = random() * Math.PI * 2;
    let lat = lat0;
    let lon = lon0;
    for (let s = 0; s < seconds; s++) {
        heading += (random() - 0.5) * 0.08;
        lat += (12 * Math.cos(heading)) / METERS_PER_DEGREE;
        lon += (12 * Math.sin(heading)) / (METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
        drive.lat.push(lat);
        drive.lon.push(lon);
        drive.time.push(start + s);
    }
    return drive;
}

/** Repeats of a seed drive with a per-trip offset, slow drift and rare excursions, like the prototype. */
function repeats(seed: RawDrive, count: number): RawDrive[] {
    const out: RawDrive[] = [];
    const cosLat = Math.cos((seed.lat[0]! * Math.PI) / 180);
    for (let k = 0; k < count; k++) {
        const reverse = random() < 0.5;
        const offsetE = gauss() * 3;
        const offsetN = gauss() * 3;
        const waves = [0, 1].map(() => ({
            amp: 1.5 + random() * 3.5,
            period: 60 + random() * 180,
            phase: random() * 6.28,
            angle: random() * 6.28,
        }));
        const drive: RawDrive = { lat: [], lon: [], time: [] };
        const n = seed.lat.length;
        for (let q = 0; q < n; q++) {
            const j = reverse ? n - 1 - q : q;
            let east = offsetE + gauss() * 0.6;
            let north = offsetN + gauss() * 0.6;
            for (const wave of waves) {
                const v = wave.amp * Math.sin((6.2832 * q) / wave.period + wave.phase);
                east += v * Math.cos(wave.angle);
                north += v * Math.sin(wave.angle);
            }
            drive.lat.push(seed.lat[j]! + north / METERS_PER_DEGREE);
            drive.lon.push(seed.lon[j]! + east / (METERS_PER_DEGREE * cosLat));
            drive.time.push(1_750_000_000 + k * 86_400 + q);
        }
        out.push(drive);
    }
    return out;
}

function referenceDrives(path: string): RawDrive[] {
    const holder: { REAL_DATA?: { pts: number[] }[] } = {};
    new Function("window", readFileSync(path, "utf8"))(holder);
    return (holder.REAL_DATA ?? [])
        .map((entry) => {
            const drive: RawDrive = { lat: [], lon: [], time: [] };
            for (let i = 0; i + 2 < entry.pts.length; i += 3) {
                drive.lat.push(entry.pts[i]!);
                drive.lon.push(entry.pts[i + 1]!);
                drive.time.push(entry.pts[i + 2]! > 1e11 ? entry.pts[i + 2]! / 1000 : entry.pts[i + 2]!);
            }
            return drive;
        })
        .filter((drive) => drive.lat.length > 0);
}

function library(): RawDrive[] {
    const reference = process.env.TRIP_MAP_LIBRARY;
    const base = reference
        ? referenceDrives(reference)
        : Array.from({ length: 200 }, (_, k) =>
              randomDrive(52.3 + random() * 0.2, 4.8 + random() * 0.3, 1700, k * 7200),
          );
    const seeds = reference
        ? [...base].sort((a, b) => b.lat.length - a.lat.length).slice(0, 3)
        : [0, 1, 2].map((k) => randomDrive(52.37, 4.89, 1250, 1_740_000_000 + k));
    return [...base, ...repeats(seeds[0]!, 140), ...repeats(seeds[1]!, 45), ...repeats(seeds[2]!, 12)];
}

const drives = library();
const packed = drives.map(pack);
let tracks: TripMapTrack[] = packed.map(buildTripMapTrack);
const bundleInput = (): BundleTrack[] =>
    tracks.map((track, id) => ({ id, points: track.points, breaks: track.breaks, bounds: track.bounds }));
const fixCount = drives.reduce((sum, drive) => sum + drive.lat.length, 0);
const vertexTotal = tracks.reduce((sum, track) => sum + track.times.length, 0);
console.info(`trip-map bench: ${drives.length} trips, ${fixCount} fixes, ${vertexTotal} simplified vertices`);

// The street-level corridor takes about a second per run; 64 samples outlast the default timeout.
it("simplifies a library and draws its corridors within seconds in the worker", { timeout: 600_000 }, async ({
    bench,
}) => {
    await bench.compare(
        bench("simplify the library", () => {
            tracks = packed.map(buildTripMapTrack);
        }),
        ...[8, 11, 14].map((step) =>
            bench(`corridor lines at step ${step}`, () => {
                buildTripBundle(bundleInput(), step);
            }),
        ),
    );
});

it("answers place queries within milliseconds on the main thread", async ({ bench }) => {
    const seed = tracks.at(-1)!;
    const middle = Math.floor(seed.times.length / 2);
    const x = seed.points[middle * 2]!;
    const y = seed.points[middle * 2 + 1]!;
    const half = 3000 / groundMetersPerWorldUnit(y);
    await bench.compare(
        bench("trips in a 6 km map area", () => {
            for (const track of tracks)
                trackIntersectsArea(track, { minX: x - half, minY: y - half, maxX: x + half, maxY: y + half });
        }),
        bench("passes through a 40 m circle", () => {
            for (const track of tracks) tripPassesThroughCircle(track, { x, y, radiusMeters: 40 });
        }),
        bench("far dots at step 9", () => {
            foldFarTrips(
                tracks.map((track, id) => ({ id, bounds: track.bounds })),
                9,
            );
        }),
    );
});

import { describe, expect, it } from "vitest";

import { driveThrough, packLocalFixes, START_SEC, trackFromFixes, type LocalFix } from "./__fixtures__/tracks.js";
import { buildTripMapTrack, segmentDistanceSquared, vertexCount } from "./track-geometry.js";
import { groundMetersPerWorldUnit, worldX, worldY } from "./world.js";
import { latForNorth, lonForEast } from "./__fixtures__/tracks.js";

/** Distance in metres from a local fix to the simplified polyline. */
function distanceToTrackM(track: ReturnType<typeof trackFromFixes>, fix: LocalFix): number {
    const x = worldX(lonForEast(fix.eastM));
    const y = worldY(latForNorth(fix.northM));
    let best = Infinity;
    const p = track.points;
    for (let i = 0; i < vertexCount(track) - 1; i++) {
        best = Math.min(best, segmentDistanceSquared(x, y, p[i * 2]!, p[i * 2 + 1]!, p[i * 2 + 2]!, p[i * 2 + 3]!));
    }
    return Math.sqrt(best) * groundMetersPerWorldUnit(y);
}

describe("buildTripMapTrack", () => {
    it("keeps every fix within the simplification tolerance and keeps vertex times", () => {
        // A winding drive: a quarter circle of 300 m radius, one fix per second.
        const fixes: LocalFix[] = [];
        for (let s = 0; s <= 120; s++) {
            const angle = (s / 120) * (Math.PI / 2);
            fixes.push({
                eastM: 300 * Math.sin(angle),
                northM: 300 - 300 * Math.cos(angle),
                unixSeconds: START_SEC + s,
            });
        }
        const track = trackFromFixes(fixes);

        expect(vertexCount(track)).toBeLessThan(fixes.length / 3);
        for (const fix of fixes) expect(distanceToTrackM(track, fix)).toBeLessThanOrEqual(5.01);
        const original = new Set(fixes.map((fix) => fix.unixSeconds));
        for (const time of track.times) expect(original.has(time), "vertex time is an original fix time").toBe(true);
        expect(track.times[0]).toBe(START_SEC);
        expect(track.times[vertexCount(track) - 1]).toBe(START_SEC + 120);
    });

    it("reduces a straight drive to its two ends", () => {
        const track = trackFromFixes(
            driveThrough([
                [0, 0],
                [2000, 0],
            ]),
        );

        expect(vertexCount(track)).toBe(2);
        expect([...track.breaks]).toEqual([0]);
    });

    it("pins the arrival and departure of a stop at one place", () => {
        const fixes = [
            ...driveThrough(
                [
                    [0, 0],
                    [300, 0],
                ],
                { speedMs: 10 },
            ),
            // Sixty seconds of standstill with a little GPS jitter.
            ...Array.from({ length: 60 }, (_, s) => ({
                eastM: 300 + (s % 3),
                northM: s % 2,
                unixSeconds: START_SEC + 31 + s,
            })),
            ...driveThrough(
                [
                    [300, 0],
                    [1000, 0],
                ],
                { speedMs: 10, startSec: START_SEC + 91 },
            ).slice(1),
        ];
        const track = trackFromFixes(fixes);

        const arrival = track.times.indexOf(START_SEC + 30);
        expect(arrival, "arrival vertex kept").toBeGreaterThan(0);
        expect(track.times[arrival + 1], "departure vertex follows the arrival").toBe(START_SEC + 90);
        expect(track.points[arrival * 2 + 2]).toBe(track.points[arrival * 2]);
        expect(track.points[arrival * 2 + 3]).toBe(track.points[arrival * 2 + 1]);
    });

    it("breaks the line at an implausible jump, a long pause and a declared cut", () => {
        const jump = trackFromFixes([
            ...driveThrough([
                [0, 0],
                [600, 0],
            ]),
            ...driveThrough(
                [
                    [3000, 0],
                    [3600, 0],
                ],
                { startSec: START_SEC + 51 },
            ),
        ]);
        expect([...jump.breaks]).toEqual([0, 1, 0]);

        const pause = trackFromFixes([
            ...driveThrough([
                [0, 0],
                [600, 0],
            ]),
            ...driveThrough(
                [
                    [800, 0],
                    [1400, 0],
                ],
                { startSec: START_SEC + 50 + 60 },
            ),
        ]);
        expect([...pause.breaks]).toEqual([0, 1, 0]);

        const second = driveThrough(
            [
                [600, 0],
                [1200, 0],
            ],
            { startSec: START_SEC + 51 },
        ).slice(1);
        second[0] = { ...second[0]!, isCut: true };
        const cut = trackFromFixes([
            ...driveThrough([
                [0, 0],
                [600, 0],
            ]),
            ...second,
        ]);
        expect(cut.breaks.includes(1), "declared cut").toBe(true);
    });

    it("keeps a continuous drive with short fix gaps unbroken", () => {
        const fixes = driveThrough([
            [0, 0],
            [1200, 0],
        ]).filter((_, index) => index % 4 === 0);
        const track = trackFromFixes(fixes);

        expect(track.breaks.includes(1)).toBe(false);
    });

    it("keeps a single fix as a point and an empty input as nothing", () => {
        const point = trackFromFixes([{ eastM: 10, northM: 20, unixSeconds: START_SEC }]);
        expect(vertexCount(point)).toBe(1);
        expect(point.breaks.length).toBe(0);
        expect(point.bounds.minX).toBe(point.bounds.maxX);

        const empty = buildTripMapTrack(packLocalFixes([]));
        expect(vertexCount(empty)).toBe(0);
    });

    it("keeps a track crossing the antimeridian continuous", () => {
        const packed = {
            lat: Float64Array.from([10, 10, 10]),
            lon: Float64Array.from([179.999, -179.999, -179.997]),
            unixSeconds: Float64Array.from([0, 10, 20]),
            cutBefore: new Uint8Array(3),
        };
        const track = buildTripMapTrack(packed);

        expect(track.breaks.includes(1)).toBe(false);
        expect(track.bounds.maxX - track.bounds.minX).toBeLessThan(0.0001);
    });
});

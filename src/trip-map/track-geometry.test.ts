import { describe, expect, it } from "vitest";

import { driveThrough, packLocalFixes, START_SEC, trackFromFixes, type LocalFix } from "./__fixtures__/tracks.js";
import { buildTripMapTrack, segmentDistanceSquared, vertexCount } from "./track-geometry.js";
import { groundMetersPerWorldUnit, worldToLon, worldX, worldY } from "./world.js";
import { eastForLon, latForNorth, lonForEast } from "./__fixtures__/tracks.js";
import { trackPositionAt, tripPassesThroughCircle } from "./queries.js";

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

    it("keeps the times of a straight drive whose speed changes", () => {
        // A fast kilometre, then a kilometre of traffic jam on the same straight road.
        const fast = driveThrough(
            [
                [0, 0],
                [1000, 0],
            ],
            { speedMs: 25 },
        );
        const slow = driveThrough(
            [
                [1000, 0],
                [2000, 0],
            ],
            { speedMs: 1.5, startSec: fast.at(-1)!.unixSeconds },
        ).slice(1);
        const fixes = [...fast, ...slow];
        const track = trackFromFixes(fixes);

        expect(vertexCount(track)).toBeLessThan(10);
        for (const fix of fixes) {
            const position = trackPositionAt(track, fix.unixSeconds)!;
            const east = eastForLon(worldToLon(position.x));
            expect(Math.abs(east - fix.eastM), `position at ${fix.unixSeconds - START_SEC} s`).toBeLessThan(2 * 25 + 1);
        }
        const jam = tripPassesThroughCircle(track, {
            x: worldX(lonForEast(1500)),
            y: worldY(latForNorth(0)),
            radiusMeters: 20,
        });
        const truth = fixes.find((fix) => fix.eastM >= 1500)!.unixSeconds;
        expect(Math.abs(jam[0]!.unixSeconds - truth)).toBeLessThanOrEqual(2);
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

    it("keeps the departure time of a stop too short to pin", () => {
        // Eight seconds standing on one repeated fix, then on along the road.
        const fixes = [
            ...driveThrough(
                [
                    [0, 0],
                    [300, 0],
                ],
                { speedMs: 10 },
            ),
            ...Array.from({ length: 8 }, (_, s) => ({ eastM: 300, northM: 0, unixSeconds: START_SEC + 31 + s })),
            ...driveThrough(
                [
                    [300, 0],
                    [1000, 0],
                ],
                { speedMs: 10, startSec: START_SEC + 38 },
            ).slice(1),
        ];
        const track = trackFromFixes(fixes);
        const circle = { x: worldX(lonForEast(305)), y: worldY(latForNorth(0)), radiusMeters: 3 };

        const [pass] = tripPassesThroughCircle(track, circle);
        // Truth: the car leaves 300 m at +38 s and reaches 305 m half a second later.
        expect(pass!.unixSeconds).toBeCloseTo(START_SEC + 38.5, 0);
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

import { describe, expect, it } from "vitest";

import {
    driveThrough,
    eastForLon,
    latForNorth,
    lonForEast,
    START_SEC,
    trackFromFixes,
    type LocalFix,
} from "./__fixtures__/tracks.js";
import { trackIntersectsArea, trackPositionAt, tripPassesThroughCircle, type PlaceCircle } from "./queries.js";
import { buildTripMapTrack } from "./track-geometry.js";
import { groundMetersPerWorldUnit, worldToLon, worldX, worldY } from "./world.js";

function place(eastM: number, northM: number, radiusMeters: number): PlaceCircle {
    return { x: worldX(lonForEast(eastM)), y: worldY(latForNorth(northM)), radiusMeters };
}

function areaAround(eastM: number, northM: number, halfSizeM: number) {
    const x = worldX(lonForEast(eastM));
    const y = worldY(latForNorth(northM));
    const half = halfSizeM / groundMetersPerWorldUnit(y);
    return { minX: x - half, minY: y - half, maxX: x + half, maxY: y + half };
}

describe("tripPassesThroughCircle", () => {
    it("finds both passes of an out-and-back drive at their interpolated times", () => {
        const fixes = driveThrough(
            [
                [0, 0],
                [1000, 0],
                [0, 0],
            ],
            { speedMs: 10 },
        );
        const passes = tripPassesThroughCircle(trackFromFixes(fixes), place(500, 0, 20));

        expect(passes).toHaveLength(2);
        expect(passes[0]!.unixSeconds).toBeCloseTo(START_SEC + 50, 0);
        expect(passes[1]!.unixSeconds).toBeCloseTo(START_SEC + 150, 0);
        expect(eastForLon(worldToLon(passes[0]!.x))).toBeCloseTo(500, 0);
    });

    it("keeps a corner one pass when the circle sits inside the turn", () => {
        const fixes = driveThrough(
            [
                [0, 0],
                [500, 0],
                [500, 500],
            ],
            { speedMs: 10 },
        );
        // 14 m inside both legs with an 18 m radius: the corner vertex is 19.8 m away.
        const passes = tripPassesThroughCircle(trackFromFixes(fixes), place(486, 14, 18));

        expect(passes).toHaveLength(1);
        // Both legs come 14 m close, at 48.6 s and 51.4 s.
        expect(Math.abs(passes[0]!.unixSeconds - (START_SEC + 50))).toBeLessThan(1.5);
    });

    it("splits a hairpin whose turn lies outside the circle into two passes", () => {
        const fixes = driveThrough(
            [
                [0, 0],
                [500, 0],
                [0, 60],
            ],
            { speedMs: 10 },
        );
        const passes = tripPassesThroughCircle(trackFromFixes(fixes), place(460, 8, 18));

        expect(passes).toHaveLength(2);
    });

    it("dates a pass after a stop by the departure, not the arrival", () => {
        const fixes: LocalFix[] = [
            ...driveThrough(
                [
                    [0, 0],
                    [300, 0],
                ],
                { speedMs: 10 },
            ),
            ...Array.from({ length: 60 }, (_, s) => ({ eastM: 300, northM: 0, unixSeconds: START_SEC + 31 + s })),
            ...driveThrough(
                [
                    [300, 0],
                    [1000, 0],
                ],
                { speedMs: 10, startSec: START_SEC + 90 },
            ).slice(1),
        ];
        const passes = tripPassesThroughCircle(trackFromFixes(fixes), place(600, 0, 15));

        expect(passes).toHaveLength(1);
        expect(passes[0]!.unixSeconds).toBeCloseTo(START_SEC + 120, 0);
    });

    it("misses a trip that stays outside the radius", () => {
        const track = trackFromFixes(
            driveThrough([
                [0, 0],
                [1000, 0],
            ]),
        );

        expect(tripPassesThroughCircle(track, place(500, 40, 30))).toEqual([]);
        expect(tripPassesThroughCircle(track, place(500, 25, 30))).toHaveLength(1);
    });

    it("does not count a gap as a pass", () => {
        const track = trackFromFixes([
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

        expect(tripPassesThroughCircle(track, place(1800, 0, 50))).toEqual([]);
    });

    it("matches a parked trip by its single point", () => {
        const track = trackFromFixes([{ eastM: 100, northM: 100, unixSeconds: START_SEC + 7 }]);

        expect(tripPassesThroughCircle(track, place(110, 100, 20))).toEqual([
            expect.objectContaining({ unixSeconds: START_SEC + 7 }),
        ]);
        expect(tripPassesThroughCircle(track, place(200, 100, 20))).toEqual([]);
    });

    it("matches a lone fix between gaps by its point", () => {
        const fixes: LocalFix[] = [
            ...driveThrough([
                [0, 0],
                [600, 0],
            ]),
            // Lost signal on both sides: the fix is a piece of its own.
            { eastM: 3000, northM: 0, unixSeconds: START_SEC + 200 },
            ...driveThrough(
                [
                    [6000, 0],
                    [6600, 0],
                ],
                { startSec: START_SEC + 400 },
            ),
        ];
        const track = trackFromFixes(fixes);
        expect(
            Array.from(track.breaks).filter((isBreak) => isBreak === 1),
            "both gaps are cut",
        ).toHaveLength(2);

        expect(tripPassesThroughCircle(track, place(3010, 0, 20))).toEqual([
            expect.objectContaining({ unixSeconds: START_SEC + 200 }),
        ]);
        expect(tripPassesThroughCircle(track, place(3100, 0, 20))).toEqual([]);
    });

    it("matches both fixes of a two-fix trip split by a gap", () => {
        const track = trackFromFixes([
            { eastM: 0, northM: 0, unixSeconds: START_SEC },
            { eastM: 2000, northM: 0, unixSeconds: START_SEC + 600 },
        ]);

        expect(tripPassesThroughCircle(track, place(0, 0, 20))).toEqual([
            expect.objectContaining({ unixSeconds: START_SEC }),
        ]);
        expect(tripPassesThroughCircle(track, place(2000, 0, 20))).toEqual([
            expect.objectContaining({ unixSeconds: START_SEC + 600 }),
        ]);
        expect(tripPassesThroughCircle(track, place(1000, 0, 20)), "the gap is no pass").toEqual([]);
    });
});

describe("trackIntersectsArea", () => {
    it("finds a segment that crosses the area without a vertex inside", () => {
        const track = trackFromFixes(
            driveThrough([
                [0, 0],
                [2000, 0],
            ]),
        );

        expect(trackIntersectsArea(track, areaAround(1000, 0, 50)), "crossing").toBe(true);
        expect(trackIntersectsArea(track, areaAround(1000, 200, 50)), "beside").toBe(false);
    });

    it("ignores a gap that crosses the area", () => {
        const track = trackFromFixes([
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

        expect(trackIntersectsArea(track, areaAround(1800, 0, 100))).toBe(false);
    });

    it("finds a track in the neighbouring world copy", () => {
        const track = buildTripMapTrack({
            lat: Float64Array.from([10, 10]),
            lon: Float64Array.from([179.999, -179.999]),
            unixSeconds: Float64Array.from([0, 10]),
            cutBefore: new Uint8Array(2),
        });
        const y = worldY(10);

        expect(trackIntersectsArea(track, { minX: -0.000001, minY: y - 0.001, maxX: 0.000001, maxY: y + 0.001 })).toBe(
            true,
        );
    });
});

describe("trackPositionAt", () => {
    it("places a moment on the drawn route between its vertices", () => {
        const track = trackFromFixes(
            driveThrough(
                [
                    [0, 0],
                    [1000, 0],
                ],
                { speedMs: 10 },
            ),
        );
        const position = trackPositionAt(track, START_SEC + 25)!;
        const y = worldY(latForNorth(0));
        expect(eastForLon(worldToLon(position.x))).toBeCloseTo(250, 0);
        expect(position.y).toBeCloseTo(y, 9);
    });

    it("clamps moments outside the recording to the route's ends", () => {
        const track = trackFromFixes(
            driveThrough(
                [
                    [0, 0],
                    [1000, 0],
                ],
                { speedMs: 10 },
            ),
        );
        expect(eastForLon(worldToLon(trackPositionAt(track, START_SEC - 60)!.x))).toBeCloseTo(0, 0);
        expect(eastForLon(worldToLon(trackPositionAt(track, START_SEC + 600)!.x))).toBeCloseTo(1000, 0);
    });

    it("stays on the nearer end of a gap instead of crossing it", () => {
        const fixes: LocalFix[] = [
            ...driveThrough(
                [
                    [0, 0],
                    [100, 0],
                ],
                { speedMs: 10 },
            ),
            ...driveThrough(
                [
                    [5000, 0],
                    [5100, 0],
                ],
                { speedMs: 10, startSec: START_SEC + 300 },
            ),
        ];
        const track = trackFromFixes(fixes);
        const nearStart = eastForLon(worldToLon(trackPositionAt(track, START_SEC + 60)!.x));
        const nearEnd = eastForLon(worldToLon(trackPositionAt(track, START_SEC + 280)!.x));
        expect(nearStart).toBeCloseTo(100, 0);
        expect(nearEnd).toBeCloseTo(5000, 0);
    });

    it("has no position on an empty track", () => {
        expect(
            trackPositionAt(
                {
                    points: new Float64Array(),
                    times: new Float64Array(),
                    breaks: new Uint8Array(),
                    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
                },
                START_SEC,
            ),
        ).toBeNull();
    });
});

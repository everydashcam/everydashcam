import { describe, expect, it } from "vitest";

import { driveThrough, eastForLon, northForLat, START_SEC, trackFromFixes } from "./__fixtures__/tracks.js";
import { buildTripBundle, bundleStepForZoom, type BundleTrack, type TripBundle } from "./bundle.js";

function bundleTracks(drives: ReturnType<typeof driveThrough>[]): BundleTrack[] {
    return drives.map((fixes, id) => {
        const track = trackFromFixes(fixes);
        return { id, points: track.points, breaks: track.breaks, bounds: track.bounds };
    });
}

interface LocalVertex {
    eastM: number;
    northM: number;
    width: number;
}

function vertices(bundle: TripBundle): LocalVertex[] {
    return bundle.lines.flatMap((line) => {
        const out: LocalVertex[] = [];
        for (let v = 0; v < line.coords.length / 2; v++) {
            out.push({
                eastM: eastForLon(line.coords[v * 2]!),
                northM: northForLat(line.coords[v * 2 + 1]!),
                width: line.width,
            });
        }
        return out;
    });
}

/** Midpoint and width of every drawn edge; a vertex can end polylines of two widths. */
function edgeMidpoints(bundle: TripBundle): LocalVertex[] {
    return bundle.lines.flatMap((line) => {
        const out: LocalVertex[] = [];
        for (let p = 0; p < line.starts.length - 1; p++) {
            for (let v = line.starts[p]!; v < line.starts[p + 1]! - 1; v++) {
                out.push({
                    eastM: eastForLon((line.coords[v * 2]! + line.coords[v * 2 + 2]!) / 2),
                    northM: northForLat((line.coords[v * 2 + 1]! + line.coords[v * 2 + 3]!) / 2),
                    width: line.width,
                });
            }
        }
        return out;
    });
}

function maxWidth(bundle: TripBundle): number {
    return Math.max(...bundle.lines.map((line) => line.width));
}

describe("bundleStepForZoom", () => {
    it("rounds to half levels and stops at the reusable maximum", () => {
        expect(bundleStepForZoom(9.2)).toBe(9);
        expect(bundleStepForZoom(9.3)).toBe(9.5);
        expect(bundleStepForZoom(18)).toBe(14);
        expect(bundleStepForZoom(-1)).toBe(0);
    });
});

describe("buildTripBundle", () => {
    it("draws two parallel strands of one road as one line", () => {
        const drives = [
            ...Array.from({ length: 10 }, (_, k) =>
                driveThrough(
                    [
                        [0, 0],
                        [1500, 0],
                    ],
                    { lateralM: 3, startSec: START_SEC + k * 1000 },
                ),
            ),
            ...Array.from({ length: 10 }, (_, k) =>
                driveThrough(
                    [
                        [1500, 0],
                        [0, 0],
                    ],
                    { lateralM: 3, startSec: START_SEC + 50_000 + k * 1000 },
                ),
            ),
        ];
        const bundle = buildTripBundle(bundleTracks(drives), 14);
        const middle = vertices(bundle).filter((vertex) => vertex.eastM > 100 && vertex.eastM < 1400);

        expect(middle.length).toBeGreaterThan(10);
        for (const vertex of middle) expect(Math.abs(vertex.northM), "on the shared centreline").toBeLessThan(2.5);
        expect(
            bundle.lines.reduce((sum, line) => sum + line.starts.length - 1, 0),
            "one polyline",
        ).toBeLessThanOrEqual(3);
    });

    it("narrows a branch gradually instead of in one step", () => {
        const drives = [
            ...Array.from({ length: 32 }, (_, k) =>
                driveThrough(
                    [
                        [0, 0],
                        [2000, 0],
                    ],
                    { startSec: START_SEC + k * 1000 },
                ),
            ),
            driveThrough(
                [
                    [0, 0],
                    [1000, 0],
                    [1000, 800],
                ],
                { startSec: START_SEC + 90_000 },
            ),
        ];
        const bundle = buildTripBundle(bundleTracks(drives), 14);
        // Near the junction the mean shift pulls branch nodes onto the corridor,
        // so the first, widest branch edges are short; keep everything north of it.
        const branch = edgeMidpoints(bundle)
            .filter((vertex) => Math.abs(vertex.eastM - 1000) < 30 && vertex.northM > 1)
            .sort((a, b) => a.northM - b.northM || b.width - a.width);

        expect(branch.length).toBeGreaterThan(5);
        for (let i = 1; i < branch.length; i++) {
            expect(branch[i]!.width, "never widens away from the junction").toBeLessThanOrEqual(branch[i - 1]!.width);
        }
        const widths = new Set(branch.map((vertex) => vertex.width));
        expect(widths.size, "intermediate widths between corridor and branch").toBeGreaterThanOrEqual(3);
        expect(branch.at(-1)!.width).toBeLessThan(branch[0]!.width);
    });

    it("widens strictly as the number of trips doubles", () => {
        const widths = [1, 2, 4, 8, 16, 32].map((count) => {
            const drives = Array.from({ length: count }, (_, k) =>
                driveThrough(
                    [
                        [0, 0],
                        [1500, 0],
                    ],
                    { startSec: START_SEC + k * 1000 },
                ),
            );
            return maxWidth(buildTripBundle(bundleTracks(drives), 14));
        });

        for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThan(widths[i - 1]!);
    });

    it("returns the same lines for the same input", () => {
        const drives = [
            driveThrough([
                [0, 0],
                [800, 0],
                [800, 600],
            ]),
            driveThrough(
                [
                    [0, 10],
                    [900, 10],
                ],
                { startSec: START_SEC + 5000 },
            ),
            driveThrough(
                [
                    [-200, 300],
                    [800, 300],
                ],
                { startSec: START_SEC + 9000 },
            ),
        ];

        expect(buildTripBundle(bundleTracks(drives), 13.5)).toEqual(buildTripBundle(bundleTracks(drives), 13.5));
    });

    it("draws nothing for trips without movement", () => {
        const parked = [{ eastM: 0, northM: 0, unixSeconds: START_SEC }];

        expect(buildTripBundle(bundleTracks([parked]), 14).lines).toEqual([]);
    });
});

// Pins the distance metric of buildMercatorCumulativeDistances to Web Mercator.
// MapLibre measures line-progress in projected tile units (mercator), so the
// fractions fed to line-gradient stops and the trail veil MUST be computed in
// the same metric. A planar-degrees metric put the veil boundary whole percents
// of track length away from the car marker on mixed-direction routes (verified
// against MapLibre's rendering: a step gradient at the mercator-predicted
// fraction lands exactly on the route corner; a degree-predicted one does not).

import { describe, expect, it, vi } from "vitest";

import type { GpsRecord } from "../parser.js";
import { buildMercatorCumulativeDistances, buildSpeedGradient } from "./speed-gradient.js";

/** Mirrors speedKmhToColor's thresholds without reading CSS variables. */
function bucket(kmh: number): number {
    if (kmh < 20) return 0;
    if (kmh < 50) return 1;
    if (kmh < 80) return 2;
    if (kmh < 110) return 3;
    return 4;
}

// theme.js reads computed CSS custom properties, which Node has no document for.
vi.mock("./theme.js", () => ({
    speedKmhToColor: (kmh: number) => `c${bucket(kmh)}`,
    themeColors: () => ({ chartSpeed: "no-speed" }),
}));

/** Minimal record - the helper reads only lat/lon. */
function rec(lat: number, lon: number): GpsRecord {
    return { lat, lon } as GpsRecord;
}

describe("buildMercatorCumulativeDistances", () => {
    it("returns zero totals for empty and single-record input", () => {
        expect(buildMercatorCumulativeDistances([])).toEqual({ cumDist: [], total: 0 });
        expect(buildMercatorCumulativeDistances([rec(55, 30)])).toEqual({ cumDist: [0], total: 0 });
    });

    it("weighs a N-S degree 1/cos(lat) heavier than an E-W degree (mercator, not planar degrees)", () => {
        // L-route at 55°N with legs EQUAL IN DEGREES: 0.1° east, then 0.1° north.
        // Planar degrees would put the corner at fraction 0.5; mercator puts it
        // at legEW / (legEW + legNS/cos(55°)) ~= 0.365 - which is where MapLibre
        // actually renders line-progress 0.365 (the corner of the drawn line).
        const { cumDist, total } = buildMercatorCumulativeDistances([
            rec(55.0, 30.0),
            rec(55.0, 30.1),
            rec(55.1, 30.1),
        ]);
        const cornerFraction = cumDist[1]! / total;
        // 0.1 / (0.1 + (mercY(55.1)-mercY(55.0))) with the exact projection;
        // 4 decimal places separates it cleanly from both the planar-degree 0.5
        // and any accidental cos-at-wrong-latitude variant.
        expect(cornerFraction).toBeCloseTo(0.36422, 4);
        expect(cornerFraction).not.toBeCloseTo(0.5, 1);
    });

    it("gives zero length to repeated coordinates (deduped-line totals stay equal)", () => {
        // refreshMap builds the trail over activeRecs (with stationary
        // duplicates) but the line geometry over dedupedRecs; the fractions only
        // stay interchangeable if duplicate segments measure exactly 0.
        const withDups = buildMercatorCumulativeDistances([
            rec(55.0, 30.0),
            rec(55.0, 30.0),
            rec(55.05, 30.1),
            rec(55.05, 30.1),
            rec(55.1, 30.0),
        ]);
        const deduped = buildMercatorCumulativeDistances([rec(55.0, 30.0), rec(55.05, 30.1), rec(55.1, 30.0)]);
        expect(withDups.total).toBe(deduped.total);
        expect(withDups.cumDist[1]).toBe(0);
    });

    it("clamps poles instead of producing Infinity", () => {
        const { total } = buildMercatorCumulativeDistances([rec(-90, 0), rec(90, 0)]);
        expect(Number.isFinite(total)).toBe(true);
        expect(total).toBeGreaterThan(0);
    });

    it("measures the short path across the antimeridian", () => {
        const crossing = buildMercatorCumulativeDistances([rec(50, 179), rec(50, -179), rec(51, -179)]);
        const unwrapped = buildMercatorCumulativeDistances([rec(50, 179), rec(50, 181), rec(51, 181)]);
        expect(crossing.cumDist[1]).toBeCloseTo(2);
        expect(crossing.total).toBeCloseTo(unwrapped.total);
    });
});

describe("buildSpeedGradient", () => {
    /** Record with a position and speed; speeds pick the mocked color bucket. */
    function moving(lat: number, lon: number, speedKmh: number): GpsRecord {
        return { lat, lon, speedMs: speedKmh / 3.6, speedSource: "measured" } as GpsRecord;
    }

    /** Evaluates a linear line-progress interpolation the way MapLibre does:
     *  the bracketing stops and the fraction between them. Equal colors on
     *  both sides render that color regardless of the fraction. */
    function colorAt(expression: unknown[], t: number): string {
        const stops = expression.slice(3);
        let i = 0;
        while (i + 2 < stops.length && (stops[i + 2] as number) <= t) i += 2;
        const left = stops[i + 1] as string;
        const right = (stops[i + 3] as string | undefined) ?? left;
        if (left === right) return left;
        const from = stops[i] as number;
        const to = stops[i + 2] as number;
        return `${left}>${right}@${((t - from) / (to - from)).toFixed(9)}`;
    }

    const speeds = [5, 6, 7, 30, 35, 35, 40, 90, 120, 121, 10, 10];
    const recs = speeds.map((speed, i) => moving(55 + i * 0.001, 30 + (i % 3) * 0.0007, speed));
    const { cumDist, total } = buildMercatorCumulativeDistances(recs);
    const gradient = buildSpeedGradient(recs, cumDist, total);

    it("keeps only the first and last stop of each equal-color run", () => {
        const colors = gradient.slice(3).filter((_, i) => i % 2 === 1);
        expect(colors).toEqual(["c0", "c0", "c1", "c1", "c3", "c4", "c4", "c0", "c0"]);
    });

    it("renders the same colors as one stop per record", () => {
        const full: unknown[] = ["interpolate", ["linear"], ["line-progress"]];
        recs.forEach((record, i) => {
            full.push(i === recs.length - 1 ? 1 : cumDist[i]! / total, `c${bucket(record.speedMs! * 3.6)}`);
        });
        for (let step = 0; step <= 1000; step++) {
            const t = step / 1000;
            expect(colorAt(gradient, t), `t=${t}`).toBe(colorAt(full, t));
        }
    });
});

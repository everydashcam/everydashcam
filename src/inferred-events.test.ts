import { describe, expect, it, test } from "vitest";

import { detectDrivingDynamics, detectInferredSegments, type InferredSegmentKind } from "./inferred-events.js";
import type { GpsRecord } from "./parsers/types.js";

/** Builds a GpsRecord with sensible defaults. Tests override only the fields they care about. */
function rec(overrides: Partial<GpsRecord>): GpsRecord {
    return {
        unixSeconds: 0,
        active: true,
        lat: 55,
        lon: 37,
        bearingDeg: 0,
        speedMs: 10,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename: "test.mp4",
        ...overrides,
    };
}

/** Linear ramp of records between t=0 and t=n-1, speed/bearing interpolated. */
function ramp(n: number, fromSpeed: number, toSpeed: number, fromBearing = 0, toBearing = 0): GpsRecord[] {
    const out: GpsRecord[] = [];
    for (let i = 0; i < n; i++) {
        const k = n === 1 ? 0 : i / (n - 1);
        out.push(
            rec({
                unixSeconds: i,
                speedMs: fromSpeed + (toSpeed - fromSpeed) * k,
                bearingDeg: fromBearing + (toBearing - fromBearing) * k,
            }),
        );
    }
    return out;
}

function only(segs: ReturnType<typeof detectInferredSegments>, kind: InferredSegmentKind): typeof segs {
    return segs.filter((s) => s.kind === kind);
}

describe("detectInferredSegments", () => {
    test("returns [] for fewer than 2 records", () => {
        expect(detectInferredSegments([], 0)).toEqual([]);
        expect(detectInferredSegments([rec({ unixSeconds: 0 })], 0)).toEqual([]);
    });

    describe("stop", () => {
        test("emits a stop when speed stays below threshold long enough", () => {
            const records: GpsRecord[] = [];
            for (let i = 0; i < 10; i++) records.push(rec({ unixSeconds: i, speedMs: 0.1 }));
            const stops = only(detectInferredSegments(records, 0), "stop");
            expect(stops).toHaveLength(1);
            expect(stops[0]!.startRelSec).toBe(0);
            expect(stops[0]!.endRelSec).toBe(9);
            // Intensity scales with duration; 9 s out of 120 s cap.
            expect(stops[0]!.intensity).toBeCloseTo(9 / 120, 5);
        });

        test("long stop saturates intensity to 1.0", () => {
            const records: GpsRecord[] = [];
            // 5 minutes of standstill, well past the 120s cap.
            for (let i = 0; i <= 300; i++) records.push(rec({ unixSeconds: i, speedMs: 0 }));
            const stops = only(detectInferredSegments(records, 0), "stop");
            expect(stops).toHaveLength(1);
            expect(stops[0]!.intensity).toBe(1);
        });

        test("skips stops shorter than MIN_STOP_DURATION_SEC", () => {
            const records: GpsRecord[] = [
                rec({ unixSeconds: 0, speedMs: 10 }),
                rec({ unixSeconds: 1, speedMs: 0.1 }),
                rec({ unixSeconds: 2, speedMs: 0.1 }),
                rec({ unixSeconds: 3, speedMs: 0.1 }),
                rec({ unixSeconds: 4, speedMs: 10 }),
            ];
            expect(only(detectInferredSegments(records, 0), "stop")).toHaveLength(0);
        });

        test("ignores inactive (no-fix) records as not-stationary", () => {
            const records: GpsRecord[] = [];
            for (let i = 0; i < 10; i++) records.push(rec({ unixSeconds: i, speedMs: 0.1, active: false }));
            expect(only(detectInferredSegments(records, 0), "stop")).toHaveLength(0);
        });

        it("does not mistake a series of zero-pair positions for a stop", () => {
            const records = Array.from({ length: 10 }, (_, unixSeconds) =>
                rec({ unixSeconds, lat: 0, lon: 0, speedMs: 0 }),
            );
            expect(detectInferredSegments(records, 0)).toEqual([]);
        });

        test("respects tripStartUtc offset", () => {
            const tripStartUtc = 1_700_000_000;
            const records: GpsRecord[] = [];
            for (let i = 0; i < 10; i++) records.push(rec({ unixSeconds: tripStartUtc + i, speedMs: 0.1 }));
            const stops = only(detectInferredSegments(records, tripStartUtc), "stop");
            expect(stops[0]!.startRelSec).toBe(0);
            expect(stops[0]!.endRelSec).toBe(9);
        });
    });

    describe("brake", () => {
        test("emits a brake on sustained deceleration", () => {
            // 20 m/s -> 0 over 10 s -> 2 m/s/s deceleration, well above 0.83 threshold.
            const records = ramp(11, 20, 0);
            const brakes = only(detectInferredSegments(records, 0), "brake");
            expect(brakes).toHaveLength(1);
            expect(brakes[0]!.startRelSec).toBe(0);
            expect(brakes[0]!.endRelSec).toBe(10);
            // 2 m/s^2 peak / 3.0 cap = 0.667 intensity.
            expect(brakes[0]!.intensity).toBeCloseTo(2 / 3, 2);
        });

        test("panic brake saturates intensity to 1.0", () => {
            // 30 m/s -> 0 over 5 s -> 6 m/s/s, well beyond 3.0 cap.
            const records = ramp(6, 30, 0);
            const brakes = only(detectInferredSegments(records, 0), "brake");
            expect(brakes[0]!.intensity).toBe(1);
        });

        test("does not emit a brake on gentle deceleration below threshold", () => {
            // 10 m/s -> 5 over 10 s -> 0.5 m/s/s, below 0.83.
            const records = ramp(11, 10, 5);
            expect(only(detectInferredSegments(records, 0), "brake")).toHaveLength(0);
        });

        test("zero dt (same-second duplicates) does not crash and ends any open brake", () => {
            const records: GpsRecord[] = [
                rec({ unixSeconds: 0, speedMs: 20 }),
                rec({ unixSeconds: 1, speedMs: 10 }), // big brake
                rec({ unixSeconds: 1, speedMs: 10 }), // duplicate timestamp - dt=0 guard kicks in
                rec({ unixSeconds: 2, speedMs: 8 }),
            ];
            expect(() => detectInferredSegments(records, 0)).not.toThrow();
        });

        test("gap > 5s splits any active brake into two", () => {
            // Brake hard for 4s, then GPS drops out for 10s, then more brake.
            const records: GpsRecord[] = [
                rec({ unixSeconds: 0, speedMs: 25 }),
                rec({ unixSeconds: 1, speedMs: 22 }),
                rec({ unixSeconds: 2, speedMs: 19 }),
                rec({ unixSeconds: 3, speedMs: 16 }),
                // 10s gap.
                rec({ unixSeconds: 14, speedMs: 12 }),
                rec({ unixSeconds: 15, speedMs: 9 }),
                rec({ unixSeconds: 16, speedMs: 6 }),
            ];
            const brakes = only(detectInferredSegments(records, 0), "brake");
            // First segment ends at last sample before the gap.
            expect(brakes.length).toBeGreaterThanOrEqual(1);
            expect(brakes[0]!.endRelSec).toBeLessThanOrEqual(3);
        });
    });

    describe("accel", () => {
        test("emits accel on sustained positive dv/dt", () => {
            // 0 -> 20 m/s over 20 s -> 1 m/s/s, above 0.55 threshold.
            const records = ramp(21, 0, 20);
            const accels = only(detectInferredSegments(records, 0), "accel");
            expect(accels).toHaveLength(1);
            expect(accels[0]!.startRelSec).toBe(0);
            expect(accels[0]!.endRelSec).toBe(20);
            // 1 m/s^2 peak / 2.5 cap = 0.4 intensity.
            expect(accels[0]!.intensity).toBeCloseTo(0.4, 2);
        });

        test("brake and accel are mutually exclusive", () => {
            // Halfway: accelerate up, then brake down.
            const up = ramp(11, 0, 20);
            const down: GpsRecord[] = ramp(11, 20, 0).map((r) => ({ ...r, unixSeconds: r.unixSeconds + 10 }));
            const records = [...up, ...down.slice(1)];
            const segs = detectInferredSegments(records, 0);
            const accels = only(segs, "accel");
            const brakes = only(segs, "brake");
            expect(accels).toHaveLength(1);
            expect(brakes).toHaveLength(1);
            // No overlap.
            expect(accels[0]!.endRelSec).toBeLessThanOrEqual(brakes[0]!.startRelSec);
        });
    });

    describe("turn", () => {
        test("emits a turn on sustained bearing rotation above threshold", () => {
            // 0 -> 90 deg over 2 s while moving at 15 m/s = 45 deg/s, above 30 deg/s.
            const records = ramp(3, 15, 15, 0, 90);
            const turns = only(detectInferredSegments(records, 0), "turn");
            expect(turns).toHaveLength(1);
            // 45 deg/s peak / 90 deg/s cap = 0.5 intensity.
            expect(turns[0]!.intensity).toBeCloseTo(0.5, 2);
        });

        test("ignores bearing changes while stationary", () => {
            // GPS bearing flips around while parked - speed < 2 m/s gates it.
            const records: GpsRecord[] = [
                rec({ unixSeconds: 0, speedMs: 0.1, bearingDeg: 0 }),
                rec({ unixSeconds: 1, speedMs: 0.1, bearingDeg: 180 }),
                rec({ unixSeconds: 2, speedMs: 0.1, bearingDeg: 270 }),
            ];
            expect(only(detectInferredSegments(records, 0), "turn")).toHaveLength(0);
        });

        test("handles bearing wraparound at 360 -> 0", () => {
            // 350 -> 10 deg = +20 short arc, NOT -340. At 15 m/s over 2 s -> 10 deg/s, below threshold.
            // Confirms wrap math does not flag this as a 170 deg/s turn.
            const records: GpsRecord[] = [
                rec({ unixSeconds: 0, speedMs: 15, bearingDeg: 350 }),
                rec({ unixSeconds: 1, speedMs: 15, bearingDeg: 0 }),
                rec({ unixSeconds: 2, speedMs: 15, bearingDeg: 10 }),
            ];
            expect(only(detectInferredSegments(records, 0), "turn")).toHaveLength(0);
        });
    });

    describe("robustness", () => {
        test("two-record input does not crash", () => {
            const records: GpsRecord[] = [rec({ unixSeconds: 0, speedMs: 0 }), rec({ unixSeconds: 1, speedMs: 0 })];
            expect(() => detectInferredSegments(records, 0)).not.toThrow();
        });

        test("NaN speed does not produce phantom brake/accel", () => {
            // NaN in arithmetic: a <= -threshold and a >= threshold are both false,
            // so the segment stays closed.
            const records: GpsRecord[] = [
                rec({ unixSeconds: 0, speedMs: 10 }),
                rec({ unixSeconds: 1, speedMs: Number.NaN }),
                rec({ unixSeconds: 2, speedMs: 10 }),
            ];
            const segs = detectInferredSegments(records, 0);
            expect(only(segs, "brake")).toHaveLength(0);
            expect(only(segs, "accel")).toHaveLength(0);
        });

        test("no-fix (active=false) records do not produce phantom brake/accel/turn", () => {
            // Regression: parsers that emit inactive rows (escort .map status
            // "V") report speedMs=0 on a fix dropout - next to a 15 m/s moving
            // record that read as a full-intensity brake + accel pair (and the
            // garbage bearing as a turn). Inactive records must close the
            // segment like a time gap, same as detectStops' active gate.
            const records: GpsRecord[] = [
                rec({ unixSeconds: 0, speedMs: 15 }),
                rec({ unixSeconds: 1, speedMs: 15 }),
                rec({ unixSeconds: 2, speedMs: 0, bearingDeg: 180, active: false }),
                rec({ unixSeconds: 3, speedMs: 15 }),
                rec({ unixSeconds: 4, speedMs: 15 }),
            ];
            const segs = detectInferredSegments(records, 0);
            expect(only(segs, "brake")).toHaveLength(0);
            expect(only(segs, "accel")).toHaveLength(0);
            expect(only(segs, "turn")).toHaveLength(0);
        });

        it.each([0, 20])("does not infer motion from a zero-pair record carrying speed=%s", (speedMs) => {
            const records = [
                rec({ unixSeconds: 0, speedMs: 20 }),
                rec({ unixSeconds: 1, speedMs: 20 }),
                rec({ unixSeconds: 2, lat: 0, lon: 0, speedMs, bearingDeg: 180, accelXg: 0.8 }),
                rec({ unixSeconds: 3, speedMs: 20 }),
                rec({ unixSeconds: 4, speedMs: 20 }),
            ];
            expect(detectInferredSegments(records, 0)).toEqual([]);
            expect(records[2]).toMatchObject({ speedMs, bearingDeg: 180, accelXg: 0.8 });
        });

        test("intensity is always in [0, 1] regardless of input magnitude", () => {
            // Insanely high deceleration: speed drops 1000 m/s in 1s.
            const records: GpsRecord[] = [
                rec({ unixSeconds: 0, speedMs: 1000 }),
                rec({ unixSeconds: 1, speedMs: 0 }),
                rec({ unixSeconds: 2, speedMs: 0 }),
            ];
            const segs = detectInferredSegments(records, 0);
            for (const s of segs) {
                expect(s.intensity).toBeGreaterThanOrEqual(0);
                expect(s.intensity).toBeLessThanOrEqual(1);
            }
        });
    });

    test("output is sorted by startRelSec", () => {
        // Mixed scenario: accelerate, cruise, brake, stop.
        const records: GpsRecord[] = [];
        let t = 0;
        // accel 0->20 over 20s
        for (let i = 0; i <= 20; i++) records.push(rec({ unixSeconds: t++, speedMs: i * 1 }));
        // cruise 20 m/s for 5s
        for (let i = 0; i < 5; i++) records.push(rec({ unixSeconds: t++, speedMs: 20 }));
        // brake 20->0 over 10s
        for (let i = 0; i <= 10; i++) records.push(rec({ unixSeconds: t++, speedMs: 20 - i * 2 }));
        // stop 6s
        for (let i = 0; i < 6; i++) records.push(rec({ unixSeconds: t++, speedMs: 0 }));
        const segs = detectInferredSegments(records, 0);
        for (let i = 1; i < segs.length; i++) {
            expect(segs[i]!.startRelSec).toBeGreaterThanOrEqual(segs[i - 1]!.startRelSec);
        }
    });
});

describe("detectDrivingDynamics", () => {
    const relative = (unixSeconds: number): number => unixSeconds - 100;

    it("reports signed acceleration and turn rate on the caller's axis", () => {
        const speedingUp = [
            rec({ unixSeconds: 100, speedMs: 10, bearingDeg: 350 }),
            rec({ unixSeconds: 101, speedMs: 12, bearingDeg: 10 }),
            rec({ unixSeconds: 102, speedMs: 14, bearingDeg: 30 }),
        ];
        const spans = detectDrivingDynamics(speedingUp, relative);
        expect(spans.map((span) => [span.startSec, span.endSec])).toEqual([
            [0, 1],
            [1, 2],
        ]);
        for (const span of spans) {
            expect(span.accelMs2).toBeCloseTo(2, 5);
            expect(span.turnRateDegPerSec, "the turn crosses north by the short arc").toBeCloseTo(20, 5);
        }
        const slowingDown = [rec({ unixSeconds: 100, speedMs: 12 }), rec({ unixSeconds: 101, speedMs: 9 })];
        expect(detectDrivingDynamics(slowingDown, relative)[0]!.accelMs2, "slowing down is negative").toBe(-3);
    });

    it("averages a one-second flicker with its neighbours", () => {
        const speeds = [20, 20, 20, 21, 20, 20, 20];
        const records = speeds.map((speedMs, i) => rec({ unixSeconds: 100 + i, speedMs }));
        const spans = detectDrivingDynamics(records, relative);
        const peak = Math.max(...spans.map((span) => Math.abs(span.accelMs2)));
        expect(peak, "the 1 m/s^2 step is spread over the window").toBeLessThan(0.5);
        expect(peak).toBeGreaterThan(0);
    });

    it("measures high-rate tracks over spans of about a second", () => {
        const records: GpsRecord[] = [];
        for (let i = 0; i <= 20; i++) records.push(rec({ unixSeconds: 100 + i * 0.1, speedMs: 10 + i * 0.1 }));
        const spans = detectDrivingDynamics(records, relative);
        expect(spans).toHaveLength(2);
        for (const span of spans) {
            expect(span.endSec - span.startSec, "span length").toBeCloseTo(1, 5);
            expect(span.accelMs2).toBeCloseTo(1, 5);
        }
    });

    it("leaves holes at missing fixes and long pauses", () => {
        const records = [
            rec({ unixSeconds: 100, speedMs: 10 }),
            rec({ unixSeconds: 101, speedMs: 11 }),
            rec({ unixSeconds: 102, speedMs: 0, active: false }),
            rec({ unixSeconds: 103, speedMs: 11 }),
            rec({ unixSeconds: 104, speedMs: 12 }),
            rec({ unixSeconds: 120, speedMs: 20 }),
            rec({ unixSeconds: 121, speedMs: 21 }),
        ];
        const spans = detectDrivingDynamics(records, relative);
        expect(spans.map((span) => [span.startSec, span.endSec])).toEqual([
            [0, 1],
            [3, 4],
            [20, 21],
        ]);
    });

    it("averages on the recording clock, not on a time-lapse axis", () => {
        // A 3 s brake at -3 m/s^2 inside a steady drive, played back at 30x.
        const speeds = [...Array<number>(30).fill(20), 17, 14, 11, ...Array<number>(30).fill(11)];
        const records = speeds.map((speedMs, i) => rec({ unixSeconds: 100 + i, speedMs }));
        const timeLapse = (unixSeconds: number): number => (unixSeconds - 100) / 30;
        const spans = detectDrivingDynamics(records, timeLapse);
        const hardest = Math.min(...spans.map((span) => span.accelMs2));
        expect(hardest, "the brake keeps its strength").toBeLessThan(-2);
        expect(spans[1]!.endSec - spans[1]!.startSec, "spans still land on the footage axis").toBeCloseTo(1 / 30, 5);
    });

    it("does not average across a pause the footage axis drops", () => {
        // A brake runs into the end of one clip and a speed-up starts the next
        // one 100 s later; the footage axis joins the two clips at 5 s.
        const before = [20, 20, 20, 20, 17, 14].map((speedMs, i) => rec({ unixSeconds: 100 + i, speedMs }));
        const after = [14, 17, 20, 20, 20, 20].map((speedMs, i) => rec({ unixSeconds: 205 + i, speedMs }));
        const footage = (unixSeconds: number): number => {
            if (unixSeconds < 105) return unixSeconds - 100;
            return unixSeconds < 205 ? 5 : unixSeconds - 200;
        };
        const spans = detectDrivingDynamics([...before, ...after], footage);
        const brakeEnd = spans.find((span) => span.endSec === 5)!;
        const speedUpStart = spans.find((span) => span.startSec === 5)!;
        expect(brakeEnd.accelMs2, "the speed-up after the pause does not soften the brake").toBeCloseTo(-3, 5);
        expect(speedUpStart.accelMs2, "the brake before the pause does not soften the speed-up").toBeCloseTo(3, 5);
    });

    it("reads no turning below the speed where GPS bearing is meaningful", () => {
        const records = [
            rec({ unixSeconds: 100, speedMs: 1, bearingDeg: 0 }),
            rec({ unixSeconds: 101, speedMs: 1, bearingDeg: 120 }),
        ];
        expect(detectDrivingDynamics(records, relative)[0]!.turnRateDegPerSec).toBe(0);
    });
});

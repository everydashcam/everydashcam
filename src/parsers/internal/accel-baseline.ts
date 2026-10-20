// Shared accel-baseline (DC-block gravity removal) for subtitle-embedded accel
// tracks. Thinkware ($gsensori) and Nextbase both store per-sample accel with a
// static gravity bias; the per-axis mean over the clip approximates that bias,
// and subtracting it leaves the motion component. The two extractors differ only
// in their <2-sample policy (their wrappers keep that), so the mean-subtraction
// core lives here once instead of copied in each.

import type { GpsRecord } from "../types.js";

/** A 3-axis accel sample in g. */
export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

/**
 * Subtracts the per-axis mean of `samples` from every record's accel, in place.
 * Assumes `samples.length >= 2`: a single observation cannot separate the static
 * bias from motion, so the sub-2-sample policy is left to each caller.
 */
export function subtractAxisMean(records: GpsRecord[], samples: readonly Vec3[]): void {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const s of samples) {
        sx += s.x;
        sy += s.y;
        sz += s.z;
    }
    const mx = sx / samples.length;
    const my = sy / samples.length;
    const mz = sz / samples.length;
    for (const r of records) {
        r.accelXg -= mx;
        r.accelYg -= my;
        r.accelZg -= mz;
    }
}

/**
 * Removes the static gravity+tilt bias from records whose accel is
 * gravity-INCLUDED, or zeroes it when the clip has too few samples to separate
 * bias from motion (one observation cannot, and a raw ~1 g vector left in place
 * would false-trigger the impact detector on every record).
 *
 * Shared by every carrier that reports a gravity-included triple (grep the
 * callers for the current set). The estimate needs the whole clip, so a caller
 * runs this once after its full parse pass, never per record or per block.
 */
export function removeGravityBaselineOrZero(records: GpsRecord[]): void {
    const withAccel = records.filter((r) => r.accelXg !== 0 || r.accelYg !== 0 || r.accelZg !== 0);
    if (withAccel.length >= 2) {
        subtractAxisMean(
            withAccel,
            withAccel.map((r) => ({ x: r.accelXg, y: r.accelYg, z: r.accelZg })),
        );
        return;
    }
    for (const r of withAccel) {
        r.accelXg = 0;
        r.accelYg = 0;
        r.accelZg = 0;
    }
}

/**
 * removeGravityBaselineOrZero for a gravity-included triple in an undocumented
 * unit. The static reading of any accelerometer is gravity, and driving adds
 * little next to it, so the clip's median magnitude stands for 1 g: every
 * triple is divided by it before the bias is removed. On the real LigoGPS TS
 * sample (rest magnitude ~4.7 units) this puts the motion peaks at the speed
 * track's own deceleration scale; the raw units would read as hard braking.
 */
export function removeGravityBaselineInUnknownUnits(records: GpsRecord[]): void {
    const magnitudes = records
        .filter((r) => r.accelXg !== 0 || r.accelYg !== 0 || r.accelZg !== 0)
        .map((r) => Math.hypot(r.accelXg, r.accelYg, r.accelZg))
        .sort((a, b) => a - b);
    const gravity = magnitudes.length >= 2 ? magnitudes[magnitudes.length >> 1]! : 0;
    if (gravity > 0) {
        for (const r of records) {
            r.accelXg /= gravity;
            r.accelYg /= gravity;
            r.accelZg /= gravity;
        }
    }
    // Below two samples the helper zeroes the triple, so the scale is moot.
    removeGravityBaselineOrZero(records);
}

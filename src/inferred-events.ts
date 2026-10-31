import { wrapDegrees } from "./coordinates.js";
// Inferred (synthetic) event segments derived from speed and bearing.
//
// Stand-alone from events.ts (which produces discrete TripEvent markers from
// G-spikes). Where TripEvent is a point in time, InferredSegment is a [start, end]
// range - used to render colored bars under the chart timeline.
//
// Prior incidents documented in events.ts:
//  - turn by accumulated dbearing was previously tried as a discrete marker
//    and removed (winding roads produce constant noise). Re-added here as a
//    segment because the noise is bounded by sustained-duration thresholds
//    and the visual format (bar, not marker) is more forgiving of false positives.
//  - stop was previously dismissed as "visible on the chart as flat zero,
//    marker added no UX value". Re-added because bars index multiple signals
//    on one strip - the value comes from quick visual scanning across all
//    four tracks, not from any single one.
//
// Detection is intentionally conservative: thresholds favor missing real
// events over flagging spurious ones. Each segment also carries an intensity
// in [0..1] (peak physical magnitude divided by a "very strong" cap) so the
// strip renderer can render mild events dimmer than hard ones and an
// occasional false positive does not dominate the visual.
//
// Pure module - no DOM, no state. Tested in inferred-events.test.ts.
//
// All thresholds are SI in the record's native units (m/s, deg) - independent
// of the user's display preference.

import { hasMeasuredSpeed, isSameTrackSegment } from "./gps-telemetry.js";
import { isValidGpsFix } from "./parser.js";
import type { GpsRecord } from "./parsers/types.js";

export type InferredSegmentKind = "stop" | "brake" | "turn" | "accel";

/** A contiguous [start, end] range of trip-relative seconds where a given
 *  inferred signal was active. Multiple kinds may overlap on the same time
 *  window - the strip renderer stacks them on separate tracks. */
export interface InferredSegment {
    kind: InferredSegmentKind;
    /** Seconds from tripStartUtc to the segment's first sample. */
    startRelSec: number;
    /** Seconds from tripStartUtc to the segment's last sample (inclusive). */
    endRelSec: number;
    /** Peak intensity in [0..1]. Computed as peak-physical-magnitude divided
     *  by the per-kind "very strong" cap (see *_INTENSITY_CAP_* constants).
     *  For stop the magnitude is segment duration in seconds. Clamped to 1
     *  for events stronger than the cap. Strip renderer uses this for opacity
     *  / saturation. Threshold-level events get intensity ~ threshold/cap
     *  (e.g. ~0.27 for brake), not zero - they are still real, just mild. */
    intensity: number;
}

// --- Thresholds (segment qualifies if peak exceeds this) ---

/** Speed below which the vehicle is considered stationary. 0.5 m/s = 1.8 km/h -
 *  GPS jitter around true zero rarely exceeds this in modern receivers. */
const SPEED_STOP_THRESHOLD_MS = 0.5;

/** Minimum continuous duration to register as a stop. Below ~5 s it overlaps
 *  with traffic light deceleration and produces clutter. */
const MIN_STOP_DURATION_SEC = 5;

/** Sustained deceleration threshold (m/s^2, positive number).
 *  ~0.83 m/s^2 = ~3 km/h per second - confident braking, well above road-noise
 *  speed fluctuation at 1 Hz GPS. Lower would flag every traffic-light coast. */
const DECEL_THRESHOLD_MS2 = 0.83;

/** Sustained acceleration threshold (m/s^2). Slightly lower than brake -
 *  steady-state highway merge produces ~0.55 m/s^2 sustained for several
 *  seconds, which is exactly what we want to surface. */
const ACCEL_THRESHOLD_MS2 = 0.55;

/** Minimum continuous duration for brake / accel / turn segments.
 *  Below 0.5 s most "events" are single-sample GPS noise at 1 Hz. */
const MIN_ACTIVITY_DURATION_SEC = 0.5;

/** Bearing-change rate (deg/sec) above which the vehicle is turning.
 *  30 deg/s = full 90 deg turn in 3 s = typical urban corner.
 *  Tighter than typical highway lane changes (~5-10 deg/s). */
const TURN_RATE_DEG_PER_SEC = 30;

/** Minimum speed for bearing to be meaningful in turn detection. Below ~2 m/s
 *  (7 km/h) GPS bearing oscillates randomly and produces phantom turns.
 *  parser.ts uses a lower 0.5 m/s threshold for forward-filling bearings -
 *  different goal there (preserve last valid bearing across very slow moments),
 *  so we keep our own value here. */
const TURN_MIN_SPEED_MS = 2.0;

// --- Intensity caps (peak magnitude that maps to intensity=1.0) ---

/** Hard panic brake. ~0.3g - close to tire-grip limit for a passenger car
 *  on dry asphalt. Anything above this clamps to intensity=1.0. */
const BRAKE_INTENSITY_CAP_MS2 = 3.0;

/** Full-throttle launch. ~0.25g - typical for a strong economy car at the
 *  green light. Performance cars exceed this and clamp to 1.0. */
const ACCEL_INTENSITY_CAP_MS2 = 2.5;

/** Sharp U-turn at low speed produces ~90 deg/s. Highway emergency lane change
 *  also lives here. */
const TURN_INTENSITY_CAP_DEG_PER_SEC = 90;

/** Stop intensity scales by duration: a 2-minute parking-lot stop is more
 *  visually significant than a 6-second traffic light. 120 s caps it; longer
 *  stops all render at full intensity. */
const STOP_INTENSITY_CAP_SEC = 120;

/**
 * Detects all inferred segments in a trip's records.
 *
 * Records must be sorted by unixSeconds (as in Trip.records after finalizeTrip).
 * Empty / 1-record inputs return []. Pure - no side effects.
 *
 * Returns segments sorted by startRelSec.
 */
export function detectInferredSegments(records: GpsRecord[], tripStartUtc: number): InferredSegment[] {
    if (records.length < 2) return [];
    const out: InferredSegment[] = [];
    detectStops(records, tripStartUtc, out);
    detectBrakeAndAccel(records, tripStartUtc, out);
    detectTurns(records, tripStartUtc, out);
    out.sort((a, b) => a.startRelSec - b.startRelSec);
    return out;
}

/** Stop: speedMs < threshold sustained >= MIN_STOP_DURATION_SEC.
 *  Missing GPS fixes break the segment. Intensity is scaled by duration. */
function detectStops(records: GpsRecord[], tripStartUtc: number, out: InferredSegment[]): void {
    let segStart = -1;
    for (let i = 0; i < records.length; i++) {
        const r = records[i]!;
        if (
            segStart >= 0 &&
            i > 0 &&
            (!isSameTrackSegment(records[i - 1]!, r) || r.unixSeconds - records[i - 1]!.unixSeconds > 5)
        ) {
            flushStop(records, tripStartUtc, segStart, i - 1, out);
            segStart = -1;
        }
        const stationary = isValidGpsFix(r) && hasMeasuredSpeed(r) && r.speedMs < SPEED_STOP_THRESHOLD_MS;
        if (stationary) {
            if (segStart < 0) segStart = i;
        } else if (segStart >= 0) {
            flushStop(records, tripStartUtc, segStart, i - 1, out);
            segStart = -1;
        }
    }
    if (segStart >= 0) flushStop(records, tripStartUtc, segStart, records.length - 1, out);
}

/** Brake and accel: signed dspeed/dt. Sliding window of consecutive samples
 *  where |dv/dt| exceeds the appropriate threshold and sign matches. Sign
 *  flips end the current segment. Intensity tracks the peak |a| within the
 *  window. */
function detectBrakeAndAccel(records: GpsRecord[], tripStartUtc: number, out: InferredSegment[]): void {
    let brakeStart = -1;
    let brakePeak = 0;
    let accelStart = -1;
    let accelPeak = 0;
    const flushBrake = (toIdx: number): void => {
        if (brakeStart < 0) return;
        flushActivity(records, tripStartUtc, brakeStart, toIdx, "brake", brakePeak, BRAKE_INTENSITY_CAP_MS2, out);
        brakeStart = -1;
        brakePeak = 0;
    };
    const flushAccel = (toIdx: number): void => {
        if (accelStart < 0) return;
        flushActivity(records, tripStartUtc, accelStart, toIdx, "accel", accelPeak, ACCEL_INTENSITY_CAP_MS2, out);
        accelStart = -1;
        accelPeak = 0;
    };
    for (let i = 1; i < records.length; i++) {
        const prev = records[i - 1]!;
        const cur = records[i]!;
        const dt = cur.unixSeconds - prev.unixSeconds;
        // A missing fix can carry placeholder speed=0, which would create a
        // phantom brake/accel pair beside moving records. Invalid fixes split
        // the segment just like duplicate clocks or gaps longer than 5 s.
        if (
            dt <= 0 ||
            dt > 5 ||
            !isValidGpsFix(prev) ||
            !isValidGpsFix(cur) ||
            !hasMeasuredSpeed(prev) ||
            !hasMeasuredSpeed(cur) ||
            !isSameTrackSegment(prev, cur)
        ) {
            flushBrake(i - 1);
            flushAccel(i - 1);
            continue;
        }
        const dv = cur.speedMs - prev.speedMs;
        const a = dv / dt;
        if (a <= -DECEL_THRESHOLD_MS2) {
            if (brakeStart < 0) brakeStart = i - 1;
            // Peak is max |a| over the segment; |a| > current => new peak.
            if (-a > brakePeak) brakePeak = -a;
            // Brake and accel are mutually exclusive - close accel if we flipped.
            flushAccel(i - 1);
        } else if (a >= ACCEL_THRESHOLD_MS2) {
            if (accelStart < 0) accelStart = i - 1;
            if (a > accelPeak) accelPeak = a;
            flushBrake(i - 1);
        } else {
            flushBrake(i - 1);
            flushAccel(i - 1);
        }
    }
    flushBrake(records.length - 1);
    flushAccel(records.length - 1);
}

/** Turn: |dbearing|/dt above TURN_RATE_DEG_PER_SEC, with samples at
 *  speedMs >= TURN_MIN_SPEED_MS (slow / stationary records produce garbage
 *  bearing values). bearing wraps at 360 - resolve via shortest signed arc.
 *  Intensity tracks the peak rate within the window. */
function detectTurns(records: GpsRecord[], tripStartUtc: number, out: InferredSegment[]): void {
    let segStart = -1;
    let peakRate = 0;
    const flush = (toIdx: number): void => {
        if (segStart < 0) return;
        flushActivity(records, tripStartUtc, segStart, toIdx, "turn", peakRate, TURN_INTENSITY_CAP_DEG_PER_SEC, out);
        segStart = -1;
        peakRate = 0;
    };
    for (let i = 1; i < records.length; i++) {
        const prev = records[i - 1]!;
        const cur = records[i]!;
        const dt = cur.unixSeconds - prev.unixSeconds;
        const tooSlow = cur.speedMs < TURN_MIN_SPEED_MS || prev.speedMs < TURN_MIN_SPEED_MS;
        // Bearing on a no-fix record is garbage - same gating as
        // detectBrakeAndAccel (phantom events on fix dropouts).
        if (
            dt <= 0 ||
            dt > 5 ||
            tooSlow ||
            !isValidGpsFix(prev) ||
            !isValidGpsFix(cur) ||
            !hasMeasuredSpeed(prev) ||
            !hasMeasuredSpeed(cur) ||
            !isSameTrackSegment(prev, cur)
        ) {
            flush(i - 1);
            continue;
        }
        const rate = Math.abs(shortestBearingArc(cur.bearingDeg - prev.bearingDeg)) / dt;
        if (rate >= TURN_RATE_DEG_PER_SEC) {
            if (segStart < 0) segStart = i - 1;
            if (rate > peakRate) peakRate = rate;
        } else {
            flush(i - 1);
        }
    }
    flush(records.length - 1);
}

/** Emits a brake/accel/turn segment if it meets minimum duration. Intensity =
 *  peak / cap, clamped to [0..1]. Peak below threshold (impossible in our flow)
 *  would still emit a positive intensity - intentional: the threshold ensures
 *  we even started a segment, the cap defines the upper bound. */
function flushActivity(
    records: GpsRecord[],
    tripStartUtc: number,
    fromIdx: number,
    toIdx: number,
    kind: InferredSegmentKind,
    peak: number,
    cap: number,
    out: InferredSegment[],
): void {
    // fromIdx > toIdx would be a logic bug upstream; fromIdx == toIdx (one
    // sample window) means duration 0 and is rejected by the duration check
    // below anyway, but the explicit guard keeps the array access safe and
    // signals intent.
    if (fromIdx > toIdx) return;
    const startRel = records[fromIdx]!.unixSeconds - tripStartUtc;
    const endRel = records[toIdx]!.unixSeconds - tripStartUtc;
    if (endRel - startRel < MIN_ACTIVITY_DURATION_SEC) return;
    out.push({ kind, startRelSec: startRel, endRelSec: endRel, intensity: clamp01(peak / cap) });
}

/** Emits a stop segment if it meets minimum duration. Intensity scales by
 *  duration - long parking-lot stops appear brighter than short traffic lights. */
function flushStop(
    records: GpsRecord[],
    tripStartUtc: number,
    fromIdx: number,
    toIdx: number,
    out: InferredSegment[],
): void {
    if (fromIdx > toIdx) return;
    const startRel = records[fromIdx]!.unixSeconds - tripStartUtc;
    const endRel = records[toIdx]!.unixSeconds - tripStartUtc;
    const durationSec = endRel - startRel;
    if (durationSec < MIN_STOP_DURATION_SEC) return;
    out.push({
        kind: "stop",
        startRelSec: startRel,
        endRelSec: endRel,
        intensity: clamp01(durationSec / STOP_INTENSITY_CAP_SEC),
    });
}

/** Reduces a raw degree delta to the signed shortest arc in [-180, 180]. */
function shortestBearingArc(deltaDeg: number): number {
    return wrapDegrees(deltaDeg);
}

function clamp01(x: number): number {
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
}

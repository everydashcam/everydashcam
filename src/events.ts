// Automatic event detector for a trip.
// Pure function: input is trip records, output is an array of typed events with timestamps.
//
// Kept separate from UI code so detection rules and thresholds can be
// unit tested and tuned without touching app.ts.

import { readLocalStorage, writeLocalStorage } from "./local-storage.js";
import type { GpsRecord } from "./parser.js";

/**
 * Event kind. Currently only "brake" (impact / hard braking by |G| magnitude).
 * The union type is kept for future detectors.
 *
 * Previously tried and removed:
 *  - "turn" (sharp turn by accumulated Δbearing): on winding roads any normal
 *    driving produces constant noise; without accelerometer axis calibration
 *    there is no way to separate a dangerous maneuver from a routine turn.
 *  - "stop" (prolonged stop): more clearly visible on the speed chart (flat zero);
 *    a dedicated marker added no UX value.
 */
export type EventKind = "brake";

// Event tied to a moment in a trip.
export interface TripEvent {
    kind: EventKind;
    // absolute event time (UTC)
    unixSeconds: number;
    // seconds from trip.startUtc (used as chart x-axis position)
    relSec: number;
    // event strength (for brake: |G| in g). Used in tooltips.
    severity: number;
    // index into trip.records (for popup data)
    recordIndex: number;
}

// --- Detection thresholds ---
//
// Tuned for 70mai x800 (1 Hz GPS, accelerometer in g without explicit calibration).
// User can override the brake threshold via the settings modal; dedupe window
// stays hardcoded because it's not a personal preference - it controls how
// adjacent samples of a single impact collapse into one marker.

/**
 * Default hard-braking threshold: |G| above which we draw a marker.
 * 0.5g is the threshold above which an event is genuinely felt (hard brake,
 * strong impact, deep pothole). Below this, minor road bumps regularly hit
 * 0.3-0.4g and markers become noise. User-tuned in settings if their car /
 * suspension produces a different noise floor.
 */
const DEFAULT_BRAKE_G_THRESHOLD = 0.5;

/** Min / max allowed by the settings UI. Below 0.1g everything is a marker. */
export const BRAKE_G_THRESHOLD_MIN = 0.1;
export const BRAKE_G_THRESHOLD_MAX = 2;

/**
 * localStorage key for the user-configured brake threshold in g.
 * Special value "off" disables event detection entirely (no markers anywhere).
 */
const STORAGE_KEY_BRAKE_THRESHOLD = "everydashcam:events:brakeThresholdG";

/** Current brake threshold in g, or +Infinity when detection is disabled. */
export function getBrakeThresholdG(): number {
    const raw = readLocalStorage(STORAGE_KEY_BRAKE_THRESHOLD);
    if (raw === null) return DEFAULT_BRAKE_G_THRESHOLD;
    if (raw === "off") return Number.POSITIVE_INFINITY;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_BRAKE_G_THRESHOLD;
}

/**
 * Persists the brake threshold. Accepts a finite positive number of g,
 * or `Number.POSITIVE_INFINITY` to disable detection (no markers).
 * Out-of-range values are clamped to [BRAKE_G_THRESHOLD_MIN, BRAKE_G_THRESHOLD_MAX].
 */
export function setBrakeThresholdG(g: number): void {
    const value = Number.isFinite(g)
        ? String(Math.min(BRAKE_G_THRESHOLD_MAX, Math.max(BRAKE_G_THRESHOLD_MIN, g)))
        : "off";
    writeLocalStorage(STORAGE_KEY_BRAKE_THRESHOLD, value);
}

/**
 * Minimum gap between two adjacent brake events. Without this a single long
 * impact produces a cluster of markers (one per sample above threshold).
 * 3 seconds - two genuinely separate braking events always have a gap larger than this.
 */
const BRAKE_DEDUPE_WINDOW_SEC = 3;

/**
 * Dynamic-acceleration magnitude (0 at rest, rises to the corresponding g value
 * on maneuver/impact). GpsRecord.accelXg/Yg/Zg are gravity-removed by contract,
 * so the zero vector at rest gives magnitude 0 without special sentinel handling.
 *
 * Used both here (event detector) and in the chart/popup - single source of truth.
 */
export function gMagnitude(rec: GpsRecord): number {
    return Math.sqrt(rec.accelXg ** 2 + rec.accelYg ** 2 + rec.accelZg ** 2);
}

/**
 * Noise floor separating "camera ships an accelerometer" from "parser filled
 * zeros because the format carries no G data". A real sensor's gravity-removed
 * readings jitter well above this on any drive; a format without accel produces
 * exact zeros on every record.
 */
const ACCEL_PRESENT_EPSILON_G = 0.001;

// Presence is per-trip-constant but O(records) to compute; the chart rebuild
// and every hover tooltip ask repeatedly, so memoize on the records array.
const accelPresenceCache = new WeakMap<GpsRecord[], boolean>();

/**
 * Whether the record array carries real accelerometer data. False when the
 * format has no G channel (all magnitudes at zero) - callers hide the |G|
 * curve/axis and tooltip rows instead of showing a flat zero line.
 */
export function hasAccelData(records: GpsRecord[]): boolean {
    const cached = accelPresenceCache.get(records);
    if (cached !== undefined) return cached;
    const present = records.some((rec) => gMagnitude(rec) > ACCEL_PRESENT_EPSILON_G);
    accelPresenceCache.set(records, present);
    return present;
}

/**
 * Detects all events in a trip GPS record array.
 *
 * Records must be sorted by unixSeconds (as in Trip.records after finalizeTrip).
 * Brake detection does not require a GPS fix - the accelerometer is independent.
 *
 * Returns events sorted by unixSeconds.
 */
export function detectEvents(records: GpsRecord[] | null | undefined, tripStartUtc: number): TripEvent[] {
    if (!records || records.length === 0) return [];

    // Threshold is read once per detection pass - cheap, but avoids re-reading
    // localStorage in the hot loop below. +Infinity disables detection entirely.
    const threshold = getBrakeThresholdG();
    if (!Number.isFinite(threshold)) return [];

    const events: TripEvent[] = [];
    detectBrakes(records, tripStartUtc, threshold, events);
    return events;
}

/**
 * Brake/impact: |G| >= threshold (boundary inclusive). Deduplication over
 * BRAKE_DEDUPE_WINDOW_SEC: within the window keep the maximum severity
 * so a single long peak does not produce a cluster of markers.
 */
function detectBrakes(records: GpsRecord[], tripStartUtc: number, threshold: number, out: TripEvent[]): void {
    let pending: TripEvent | null = null;

    const flush = (): void => {
        if (pending) {
            out.push(pending);
            pending = null;
        }
    };

    for (let i = 0; i < records.length; i++) {
        const rec = records[i]!;
        const g = gMagnitude(rec);
        if (g < threshold) continue;

        const ev: TripEvent = {
            kind: "brake",
            unixSeconds: rec.unixSeconds,
            relSec: rec.unixSeconds - tripStartUtc,
            severity: g,
            recordIndex: i,
        };

        if (pending && rec.unixSeconds - pending.unixSeconds <= BRAKE_DEDUPE_WINDOW_SEC) {
            // within the window - keep the strongest peak
            if (g > pending.severity) pending = ev;
        } else {
            flush();
            pending = ev;
        }
    }
    flush();
}

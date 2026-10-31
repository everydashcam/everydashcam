// Generic utilities for GpsRecord arrays: distance, binary search for the
// nearest record, position interpolation. Vendor-agnostic.
//
// Vendor-specific parsing lives in src/parsers/<vendor>.ts (see registry).
// Domain types (GpsRecord, ParsedLog, SkippedLine) are defined in
// src/parsers/types.ts; this module re-exports them so existing
// imports `from "./parser.js"` continue to work.

export type { GpsRecord, ParsedLog, SkippedLine } from "./parsers/types.js";

import { mai70NameCore } from "./parsers/filename/_patterns.js";
import { blackvueChannelCloneGroup } from "./parsers/blackvue-clone-group.js";
import type {
    GpsRecord,
    InterpolatedPosition,
    ParsedLog,
    SkippedLine,
    VideoWithRecordingCopies,
} from "./parsers/types.js";
import { vendorFileKey } from "./vendor-file-key.js";
import { interpolateSpeed, isSameTrackSegment } from "./gps-telemetry.js";
import { wrapDegrees } from "./coordinates.js";

/**
 * Dynamic-acceleration magnitude from a gravity-removed accel triple. Single
 * definition for the max-|G|-wins transplant the merge/dedup layer performs in
 * four places (dedupRecords and thinDenseRecords here, finalizeTrip
 * cross-channel dedup, and registry.mergeAccelSamples), so a
 * collision/downsample never silently drops the strongest impact sample before
 * detectEvents runs. Component form (not a
 * GpsRecord) because mergeAccelSamples compares raw AccelSamples after
 * subtracting the per-file gravity offset. Mirrors events.gMagnitude, but lives
 * here because events.ts imports from this module (importing back would cycle).
 */
export function accelMagnitude(xg: number, yg: number, zg: number): number {
    return Math.hypot(xg, yg, zg);
}

function recordOwnerKey(record: GpsRecord): string {
    if (record.videoKey !== undefined) return record.videoKey;
    const hint = record.timeAssociation;
    return hint ? JSON.stringify([hint.sourceKey ?? null, hint.sourcePath, hint.extractorId]) : record.mp4Filename;
}

/**
 * Deduplicates records by composite key (unixSeconds, lat, lon, video owner).
 * Needed on merge from multiple sources / repeated drag-drops: a re-dropped
 * GPSData file would double brake events, distance, and chart density.
 *
 * Including position and concrete owner allows two files with the same raw
 * basename and timestamp to coexist (equal trees or multi-channel models).
 *
 * On a key collision the first-seen record wins its identity, but the stronger
 * accel triple is transplanted onto it (max-|G| wins). Reason: a parking-mode /
 * cold-start clip without relative offsets keeps identical lat/lon across every
 * row, so its records share one position key and collapse to the first. The
 * impact spike on a later row would be lost, and detectEvents would see no brake.
 * The kept record is cloned rather than mutated: these records are aliased by
 * state.gpsLog buckets and candidate.records, and the raw parser output must
 * stay untouched. Same policy dropTeleportOutliers already applies on drop.
 */
export function dedupRecords(records: GpsRecord[]): GpsRecord[] {
    const indexByKey = new Map<string, number>();
    const out: GpsRecord[] = [];
    for (const r of records) {
        // Relative offsets survive reanchoring and distinguish stationary
        // fixes. Without one, ignore the rewritten placeholder clock so a
        // re-drop still deduplicates against the already-reanchored copy.
        const owner = recordOwnerKey(r);
        const clock = r.timeUnsynced
            ? `u|${Number.isFinite(r.relStartSeconds) ? r.relStartSeconds : ""}`
            : r.unixSeconds;
        const key = `${clock}|${r.lat}|${r.lon}|${owner}|${r.trackSegmentSource ?? ""}|${r.trackSegment ?? ""}`;
        const existingIdx = indexByKey.get(key);
        if (existingIdx === undefined) {
            indexByKey.set(key, out.length);
            out.push(r);
            continue;
        }
        const kept = out[existingIdx]!;
        if (
            accelMagnitude(r.accelXg, r.accelYg, r.accelZg) > accelMagnitude(kept.accelXg, kept.accelYg, kept.accelZg)
        ) {
            out[existingIdx] = { ...kept, accelXg: r.accelXg, accelYg: r.accelYg, accelZg: r.accelZg };
        }
    }
    return out;
}

/**
 * Cap on stored GPS record density. 5 Hz keeps enough sub-second shape for the
 * exported gpmd/GPX tracks and near-exact event timing while still cutting the
 * densest sources (Vueroid ~20 Hz, GoPro ~18 Hz) to a quarter of the memory
 * and index-cache footprint. Thinning only collapses - a source at or below
 * this rate passes through unchanged, nothing is ever interpolated up.
 */
export const GPS_THIN_HZ = 5;

/**
 * Thins records to at most GPS_THIN_HZ per second per file. Denser GPS
 * (Nextbase fmt1 10 Hz, Vueroid ~20 Hz, GoPro ~18 Hz) buys nothing on a
 * map/chart sampled at 1 Hz everywhere else, but multiplies session memory and
 * the IndexedDB index cache by the rate factor - so the merge funnel drops the
 * extras and keeps the one signal that genuinely lives between samples: the
 * strongest gravity-removed accel triple of the bucket is transplanted onto
 * the survivor (max-|G| wins, same policy as dedupRecords), so detectEvents
 * still sees every braking peak.
 *
 * The survivor is the bucket's first record with a valid fix (first record at
 * all when none has one) - a fix acquired mid-bucket must not lose its
 * coordinates to a no-fix placeholder. Records are bucketed by
 * floor(unixSeconds * GPS_THIN_HZ); unsynced records bucket by
 * floor(relStartSeconds * GPS_THIN_HZ) instead (their unixSeconds is a
 * placeholder the time layer rewrites later), and an unsynced record without
 * relStartSeconds passes through untouched - there is no per-record clock to
 * bucket it by, and every such source is 1 Hz anyway.
 *
 * Kept records are referenced, never mutated (they are aliased by state.gpsLog
 * buckets and candidate.records); a transplant clones. Idempotent, so re-merging
 * an already-thinned bucket is a no-op.
 */
export function thinDenseRecords(records: GpsRecord[]): GpsRecord[] {
    const indexByKey = new Map<string, number>();
    const out: GpsRecord[] = [];
    for (const r of records) {
        let bucketKey: string;
        if (r.timeUnsynced) {
            if (r.relStartSeconds === undefined) {
                out.push(r);
                continue;
            }
            // "r|" keeps the relative-offset axis from colliding with a synced
            // record's wall-clock axis in the same bucket.
            bucketKey = `r|${Math.floor(r.relStartSeconds * GPS_THIN_HZ)}`;
        } else {
            bucketKey = String(Math.floor(r.unixSeconds * GPS_THIN_HZ));
        }
        const key = `${bucketKey}|${recordOwnerKey(r)}|${r.trackSegmentSource ?? ""}|${r.trackSegment ?? ""}`;
        const existingIdx = indexByKey.get(key);
        if (existingIdx === undefined) {
            indexByKey.set(key, out.length);
            out.push(r);
            continue;
        }
        const kept = out[existingIdx]!;
        const keptIsStrongest =
            accelMagnitude(kept.accelXg, kept.accelYg, kept.accelZg) >= accelMagnitude(r.accelXg, r.accelYg, r.accelZg);
        if (!isValidGpsFix(kept) && isValidGpsFix(r)) {
            // Fix acquired mid-bucket: this record's coordinates win, but the
            // strongest accel seen so far must ride along (kept already holds
            // the max of every earlier record in this bucket).
            out[existingIdx] = keptIsStrongest
                ? { ...r, accelXg: kept.accelXg, accelYg: kept.accelYg, accelZg: kept.accelZg }
                : r;
        } else if (!keptIsStrongest) {
            out[existingIdx] = { ...kept, accelXg: r.accelXg, accelYg: r.accelYg, accelZg: r.accelZg };
        }
    }
    return out;
}

/**
 * First record whose GPS clock was synced (a real wall-clock time). Cold-start
 * records (`timeUnsynced`) carry a near-epoch placeholder written before the
 * chip decoded satellite time; manually attached external tracks carry another
 * device's clock. Directory-log rows were selected using the video's clock,
 * so using them to calibrate it would be circular. None may anchor the video.
 * Returns null when every record is in one of these categories.
 */
export function firstSyncedRecord(records: GpsRecord[] | null | undefined): GpsRecord | null {
    if (!records) return null;
    for (const r of records) {
        if (!r.timeUnsynced && !r.externalTrack && !r.timeAssociation) return r;
    }
    return null;
}

/** Last record whose GPS clock may anchor the video. Counterpart to
 *  firstSyncedRecord; null when no record may anchor the video. */
export function lastSyncedRecord(records: GpsRecord[] | null | undefined): GpsRecord | null {
    if (!records) return null;
    for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i]!;
        if (!record.timeUnsynced && !record.externalTrack && !record.timeAssociation) return record;
    }
    return null;
}

/**
 * Total trip distance via haversine over all valid GPS fixes.
 * Only isValidGpsFix records are counted - lost-fix points produce
 * coordinate jumps that inflate distance.
 *
 * Accuracy is ~5-15% at 1 Hz with good sky visibility - sufficient for
 * the "distance driven" display, not for precise measurement.
 *
 * Returns distance in km, 0 if fewer than two records.
 */
export function totalDistanceKm(records: GpsRecord[] | null | undefined): number {
    if (!records || records.length < 2) return 0;
    let prev: GpsRecord | null = null;
    let sum = 0;
    for (const r of records) {
        if (!isValidGpsFix(r)) continue;
        if (prev !== null && isSameTrackSegment(prev, r)) {
            sum += haversineKm(prev.lat, prev.lon, r.lat, r.lon);
        }
        prev = r;
    }
    return sum;
}

/**
 * Running distance in km from the first record to each one, aligned
 * index-for-index with `records`. Same rule as totalDistanceKm - only
 * valid fixes advance the total, so a lost-fix jump does not
 * inflate it, and the last element equals totalDistanceKm(records).
 *
 * Precomputed per trip on purpose: the readout row wants "distance so far" at
 * every playhead position, and re-summing haversine over the whole track at
 * timeupdate rate is not something a playback path can afford.
 *
 * Empty input returns an empty array.
 */
export function cumulativeDistanceKm(records: GpsRecord[] | null | undefined): Float64Array {
    if (!records || records.length === 0) return new Float64Array(0);
    const out = new Float64Array(records.length);
    let prev: GpsRecord | null = null;
    let sum = 0;
    for (let i = 0; i < records.length; i++) {
        const r = records[i]!;
        if (isValidGpsFix(r)) {
            if (prev !== null && isSameTrackSegment(prev, r)) sum += haversineKm(prev.lat, prev.lon, r.lat, r.lon);
            prev = r;
        }
        out[i] = sum;
    }
    return out;
}

/**
 * True iff the records carry at least one valid GPS fix. Receiver status alone
 * is insufficient; missing/invalid positions do not count. This is the single
 * gate for every GPS-dependent export option - the GPS-track-only mode, the
 * embedded telemetry track, the .gpx sidecar, and the speed/coords/map overlays
 * - none of which produce anything without a fix. The export panel disables the
 * matching controls and the export pipeline ignores them on a trip that fails
 * this check.
 */
export function recordsHaveGps(records: GpsRecord[] | null | undefined): boolean {
    return !!records && records.some(isValidGpsFix);
}

/** A fix must be safe to project even when a malformed record escapes parsing.
 * Cameras can report (0, 0) during signal loss while still marking it active;
 * a single zero coordinate remains valid on the equator or prime meridian. */
export function isValidGpsFix(record: GpsRecord): boolean {
    return (
        record.active &&
        (record.lat !== 0 || record.lon !== 0) &&
        Number.isFinite(record.lat) &&
        Number.isFinite(record.lon) &&
        Math.abs(record.lat) <= 90 &&
        Math.abs(record.lon) <= 180
    );
}

/**
 * Fills bearingDeg in-place using initial bearing toward the next
 * sufficiently distant point. Use ONLY for formats that do not carry course
 * (GoPro GPMF GPS5/GPS9). NMEA-based vendors (70mai, Novatek, BlackVue,
 * Thinkware) carry bearing from RMC - do not overwrite.
 *
 * Look-ahead is needed because GoPro writes 18 Hz sub-points: at 1.5 m/s
 * adjacent points are ~8 cm apart and atan2 on that noise gives a random angle.
 * Scans forward to the first point at distance >= MIN_BEARING_DIST_DEG (~1 m),
 * computes bearing to it, copy-forwards to all intermediate points.
 *
 * Stationary points (speedMs < MIN_BEARING_SPEED_MS) inherit the last valid
 * bearing so the marker does not jitter on coordinate noise.
 * Missing fixes and source boundaries stop the look-ahead; their coordinates
 * cannot supply a heading for the valid track.
 *
 * Mutates input array in place.
 */
export function fillForwardBearings(records: GpsRecord[]): void {
    const MIN_BEARING_DIST_DEG = 1e-5; // ~1.1 m in latitude
    const MIN_BEARING_SPEED_MS = 0.5;
    // Look-ahead cap. Without it, slow movement or GPS noise on a stationary
    // car turns the inner loop into O(n^2): at GoPro 18 Hz for a 1-hour clip
    // (~65k records) a long stall scans tens of millions of pairs per record.
    // 120 samples = ~6.7 s at 18 Hz / ~120 s at 1 Hz - enough to clear 1 m of
    // displacement at any reasonable bearing-bearing speed. Beyond the cap,
    // we treat the segment as stationary noise and inherit lastValid.
    const LOOKAHEAD_CAP = 120;
    let lastValid = 0;
    for (let i = 0; i < records.length; i++) {
        const cur = records[i]!;
        if (!isValidGpsFix(cur)) continue;
        if (cur.speedMs < MIN_BEARING_SPEED_MS) {
            cur.bearingDeg = lastValid;
            continue;
        }
        // Scan forward for enough displacement.
        let next: GpsRecord | null = null;
        const jEnd = Math.min(records.length, i + 1 + LOOKAHEAD_CAP);
        for (let j = i + 1; j < jEnd; j++) {
            const cand = records[j]!;
            if (!isValidGpsFix(cand) || !isSameTrackSegment(cur, cand)) break;
            const dLat = cand.lat - cur.lat;
            const dLon = cand.lon - cur.lon;
            if (Math.hypot(dLat, dLon) >= MIN_BEARING_DIST_DEG) {
                next = cand;
                break;
            }
        }
        if (!next) {
            cur.bearingDeg = lastValid;
            continue;
        }
        // Initial bearing (forward azimuth).
        const lat1 = (cur.lat * Math.PI) / 180;
        const lat2 = (next.lat * Math.PI) / 180;
        const dLonRad = ((next.lon - cur.lon) * Math.PI) / 180;
        const y = Math.sin(dLonRad) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLonRad);
        let bearing = (Math.atan2(y, x) * 180) / Math.PI;
        if (bearing < 0) bearing += 360;
        cur.bearingDeg = bearing;
        lastValid = bearing;
    }
}

/**
 * Threshold below which a record is treated as stationary for bearing
 * purposes. 1.0 m/s (~3.6 km/h) covers GPS coordinate drift on a parked car
 * and slow rollback while still letting parking-lot maneuvers (5+ km/h) keep
 * their real heading.
 */
const STATIONARY_SPEED_MS = 1.0;

/**
 * Forces bearingDeg to inherit the last "moving" bearing for every record
 * with speedMs < STATIONARY_SPEED_MS. Reason: NMEA-RMC and similar native
 * course fields are noise on a stopped car (the GPS chip emits random
 * directions when the velocity vector is below its own threshold), which
 * makes the map arrow spin in place. Coordinates stay untouched - only
 * the displayed heading is stabilized.
 *
 * Records expected pre-sorted by unixSeconds. Idempotent.
 *
 * Initial lastValid is the first valid fix's bearingDeg, so a trip that starts
 * stationary at least holds one stable angle until the first movement
 * arrives and overwrites lastValid with real data.
 *
 * Mutates input in place.
 */
export function freezeStationaryBearings(records: GpsRecord[]): void {
    let lastValid = records.find(isValidGpsFix)?.bearingDeg ?? 0;
    for (const r of records) {
        if (!isValidGpsFix(r)) continue;
        if (r.speedMs < STATIONARY_SPEED_MS) {
            r.bearingDeg = lastValid;
        } else {
            lastValid = r.bearingDeg;
        }
    }
}

/** Keeps bearing stabilization inside one owner and continuous track segment. */
function freezeStationaryBearingsByOwner(records: GpsRecord[]): void {
    if (records.length < 2) {
        freezeStationaryBearings(records);
        return;
    }
    const bearingScope = (record: GpsRecord): string =>
        JSON.stringify([recordOwnerKey(record), record.trackSegmentSource ?? null, record.trackSegment ?? null]);
    const firstOwner = bearingScope(records[0]!);
    if (records.every((record) => bearingScope(record) === firstOwner)) {
        freezeStationaryBearings(records);
        return;
    }
    const recordsByOwner = new Map<string, GpsRecord[]>();
    for (const record of records) {
        // All records in this caller already share mp4Filename. Unowned rows
        // therefore form one safe legacy bucket; concrete owners stay isolated.
        const owner = bearingScope(record);
        let owned = recordsByOwner.get(owner);
        if (!owned) {
            owned = [];
            recordsByOwner.set(owner, owned);
        }
        owned.push(record);
    }
    for (const owned of recordsByOwner.values()) freezeStationaryBearings(owned);
}

/**
 * Calls fillForwardBearings on a per-file batch only when no valid fix carries
 * a non-zero bearing - i.e. the parser does not extract course at all.
 *
 * Used as a centralized normalization step in the dispatcher so individual
 * parsers do not need to remember to forward-fill (PNDM, Navitel gps0,
 * LigoGPS, GPX without <course>, etc.). A parser that does write course
 * (NMEA RMC, 70mai CSV, freeGPS, RVMI) keeps its values untouched because
 * at least one record will have bearingDeg != 0.
 *
 * Edge case: a real track strictly heading north (bearingDeg == 0 on every
 * sample) would also trigger the fill, but the forward-fill result there is
 * the same answer geometrically - no harm done.
 *
 * Must run per-file before records are merged across files; cross-file
 * forward-fill would use one file's last coordinate to bearing into the next
 * file's first coordinate, which is meaningless across recording gaps.
 */
export function forwardFillBearingsIfAllZero(records: GpsRecord[]): void {
    if (records.length < 2) return;
    for (const r of records) {
        if (isValidGpsFix(r) && r.bearingDeg !== 0) return;
    }
    fillForwardBearings(records);
}

/** Tuning knobs for dropTeleportOutliers. */
export interface TeleportFilterOptions {
    /** Implied-speed gate, m/s. 100 m/s = 360 km/h - no dashcam-bearing vehicle reaches it. */
    maxImpliedSpeedMs: number;
    /**
     * Distance floor, metres. Protects high-rate noisy data: at 18 Hz GoPro
     * with ±10 m urban-canyon jitter the implied speed alone is ~180 m/s
     * (10 m / 0.055 s) - jitter never reaches 200 m of displacement, so the
     * floor is what keeps those samples. Do NOT lower it without re-deriving
     * this bound.
     */
    minJumpMeters: number;
}

const DEFAULT_TELEPORT_FILTER: TeleportFilterOptions = { maxImpliedSpeedMs: 100, minJumpMeters: 200 };

/**
 * Trip-level teleport/spike filter: drops records whose position jump from the
 * last kept fix is physically impossible. Generalization of the navitel gps0
 * Pass-B continuity check (src/parsers/internal/navitel-gps0.ts
 * dropPositionOutliers, battle-tested on real iBOX data) with a distance floor
 * for rate-independence; navitel keeps its own in-primitive pass (it needs raw
 * row order + SkippedLine reporting), and this filter is idempotent on its
 * output.
 *
 * Input must be sorted by unixSeconds (finalizeTrip sorts right before the
 * call). Returns a NEW array - the input is never mutated, so candidate-level
 * records and state.gpsLog keep the raw parser output and re-grouping stays
 * reversible.
 *
 * Algorithm - anchor chain walk:
 *   - Only valid, time-synced fixes participate. Missing/invalid fixes and
 *     timeUnsynced rows (cold-start placeholders re-anchored onto the video
 *     window later) are ALWAYS kept with their telemetry, never become anchors,
 *     and are skipped by the lookahead.
 *     Consequence: fully-timeUnsynced formats (70mai freegps / gps-box,
 *     Wolfbox variant A) are entirely exempt from this filter.
 *   - A record is a drop candidate only when BOTH gates trip: displacement
 *     from the anchor > minJumpMeters AND implied speed > maxImpliedSpeedMs.
 *     Legit driving cannot trip both (>200 m jump AND >360 km/h); a recording
 *     resumed far away has a large dt, so its implied speed stays low.
 *   - dt <= 0 (cross-channel same-second merge) -> kept unconditionally, but
 *     such records do NOT replace the anchor: a same-second teleported
 *     duplicate that became anchor could wrongly drop a legitimate LAST
 *     record through the trailing-spike branch below.
 *   - Candidate confirmation via the next ELIGIBLE record (not literally
 *     records[i+1] - an escort-map or unsynced row adjacent to a spike must
 *     not corrupt the decision): drop only if skipping the candidate restores
 *     continuity anchor -> next, or there is no next (trailing spike). If the
 *     next eligible record also disagrees with the anchor, the candidate is a
 *     genuine new anchor (recording resumed elsewhere, constant
 *     super-threshold motion) and is kept.
 *   - Trailing-spike exception: when the anchor itself was accepted through
 *     the new-anchor branch, motion is already in a super-threshold regime
 *     (e.g. constant 250 m/s synthetic), so a follower-less candidate
 *     continues that motion and is kept - only a candidate that breaks a
 *     NORMAL regime with no follower to confirm it is a trailing spike.
 *   - Accel transplant on drop: accel lives ON the GpsRecord, and a hard
 *     impact can plausibly coincide with the very GPS glitch this filter
 *     drops - deleting the record whole would erase the auto-detected impact
 *     marker and the chart G spike (detectEvents runs AFTER this filter).
 *     When the dropped record's |G| exceeds the nearest kept eligible
 *     neighbor's, that neighbor is replaced by a clone carrying the dropped
 *     accel triple (max-|G|-wins; position/time of the neighbor untouched,
 *     input array never mutated).
 *
 * Known accepted limitation: a 2-point spike cluster survives (the continuity
 * check anchors on the first spike point). viofosync's median-of-5 window
 * would catch it but was rejected as a heavier policy.
 *
 * Diagnostics: trip-level drops intentionally bypass SkippedLine reporting -
 * the caller logs a debug count instead (finalizeTrip in trips.ts). The
 * asymmetry with navitel's in-primitive SkippedLine reporting is deliberate:
 * this filter re-runs on every regroup, and its drops are reversible
 * presentation-level cleanup, not parse-time data loss.
 */
export function dropTeleportOutliers(
    records: GpsRecord[],
    opts: TeleportFilterOptions = DEFAULT_TELEPORT_FILTER,
): GpsRecord[] {
    const isEligible = (r: GpsRecord): boolean => isValidGpsFix(r) && !r.timeUnsynced;
    // Thin record-shaped adapter over the shared accelMagnitude helper.
    const accelMag = (r: GpsRecord): number => accelMagnitude(r.accelXg, r.accelYg, r.accelZg);
    const out: GpsRecord[] = [];
    let anchor: GpsRecord | null = null;
    // Index of the current anchor inside `out` - the accel transplant
    // replaces it with a clone in place.
    let anchorOutIndex = -1;
    // True when the current anchor was accepted via the new-anchor branch -
    // i.e. motion is already super-threshold (see the trailing-spike exception).
    let anchorWasCandidate = false;
    // Accel transplant deferred onto a not-yet-pushed record (the dropped
    // spike's nearest kept neighbor is the upcoming confirmer). Applied when
    // that record is pushed; max-|G| donor wins across multiple drops.
    type PendingTransplant = { target: GpsRecord; donor: GpsRecord } | null;
    let pendingTransplant: PendingTransplant = null;

    const nextEligibleAfter = (idx: number): GpsRecord | null => {
        for (let j = idx + 1; j < records.length; j++) {
            if (isEligible(records[j]!)) return records[j]!;
        }
        return null;
    };

    // True when `rec` trips BOTH gates relative to `from` - the only
    // combination treated as a teleport. Requires dt > 0 to be judgeable.
    const isTeleportFrom = (from: GpsRecord, rec: GpsRecord, dt: number): boolean => {
        if (dt <= 0) return false;
        const jumpMeters = haversineKm(from.lat, from.lon, rec.lat, rec.lon) * 1000;
        return jumpMeters > opts.minJumpMeters && jumpMeters / dt > opts.maxImpliedSpeedMs;
    };

    // Keep-max-|G| transplant for a dropped record (see the contract above).
    // `next` is the upcoming confirmer (eligible, kept when it confirms
    // continuity) or null for a trailing spike. Returns the new pending
    // transplant (assigned at the call site - TS does not track narrowing
    // through closure assignments).
    const transplantAccelOfDropped = (
        dropped: GpsRecord,
        theAnchor: GpsRecord,
        next: GpsRecord | null,
        pending: PendingTransplant,
    ): PendingTransplant => {
        const donorG = accelMag(dropped);
        if (donorG === 0) return pending; // nothing to preserve
        const anchorDt = dropped.unixSeconds - theAnchor.unixSeconds;
        const nextDt = next ? next.unixSeconds - dropped.unixSeconds : Number.POSITIVE_INFINITY;
        if (next !== null && nextDt < anchorDt) {
            // Nearest kept neighbor is ahead - defer until it is pushed.
            if (donorG <= accelMag(next)) return pending;
            if (pending && pending.target === next && accelMag(pending.donor) >= donorG) return pending;
            return { target: next, donor: dropped };
        }
        if (donorG > accelMag(theAnchor)) {
            anchor = {
                ...theAnchor,
                accelXg: dropped.accelXg,
                accelYg: dropped.accelYg,
                accelZg: dropped.accelZg,
            };
            out[anchorOutIndex] = anchor;
        }
        return pending;
    };

    for (let i = 0; i < records.length; i++) {
        const rec = records[i]!;
        if (!isEligible(rec)) {
            out.push(rec);
            continue;
        }
        if (anchor === null) {
            out.push(rec);
            anchor = rec;
            anchorOutIndex = out.length - 1;
            continue;
        }
        const dt = rec.unixSeconds - anchor.unixSeconds;
        if (dt <= 0) {
            out.push(rec); // kept, but never an anchor (see contract)
            continue;
        }
        const isCandidate = isTeleportFrom(anchor, rec, dt);
        if (isCandidate) {
            const next = nextEligibleAfter(i);
            const nextDt = next ? next.unixSeconds - anchor.unixSeconds : 0;
            const nextContinuous = next !== null && nextDt > 0 && !isTeleportFrom(anchor, next, nextDt);
            const isTrailingSpike = next === null && !anchorWasCandidate;
            if (nextContinuous || isTrailingSpike) {
                // drop: skipping restores continuity / trailing spike. The
                // dropped position is garbage but its accel sample is real -
                // keep the max |G| on the nearest surviving neighbor.
                pendingTransplant = transplantAccelOfDropped(rec, anchor, next, pendingTransplant);
                continue;
            }
            // Both this record and the next eligible disagree with the anchor
            // (or super-threshold motion continues past the last record) -
            // a genuine new reality; fall through and accept as the new anchor.
        }
        let kept = rec;
        if (pendingTransplant && pendingTransplant.target === rec) {
            const donor = pendingTransplant.donor;
            kept = { ...rec, accelXg: donor.accelXg, accelYg: donor.accelYg, accelZg: donor.accelZg };
            pendingTransplant = null;
        }
        out.push(kept);
        anchor = kept;
        anchorOutIndex = out.length - 1;
        anchorWasCandidate = isCandidate;
    }
    return out;
}

/**
 * Haversine great-circle distance in km. Mean Earth radius 6371 km.
 * Ellipsoidal model is unnecessary given GPS fix accuracy.
 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R_KM = 6371;
    const toRad = (deg: number): number => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Binary search for the record nearest to targetUnixSeconds in a sorted array.
 * The player calls this on every timeupdate; linear scan over thousands of
 * points would be measurable.
 *
 * Returns the index of the nearest record (by absolute timestamp delta),
 * or -1 for an empty array.
 */
export function findNearestIndex(sortedRecords: GpsRecord[], targetUnixSeconds: number): number {
    if (sortedRecords.length === 0) return -1;

    let lo = 0;
    let hi = sortedRecords.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sortedRecords[mid]!.unixSeconds < targetUnixSeconds) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    // lo is the first index with timestamp >= target; compare with previous to pick the nearest.
    if (lo > 0) {
        const prev = sortedRecords[lo - 1]!;
        const cur = sortedRecords[lo]!;
        if (Math.abs(prev.unixSeconds - targetUnixSeconds) <= Math.abs(cur.unixSeconds - targetUnixSeconds)) {
            return lo - 1;
        }
    }
    return lo;
}

export const GPS_POSITION_TOLERANCE_SEC = 5;

/** Nearest sample's timestamp, resolving conflicting channel fixes at that instant. */
export function findNearestPositionIndex(records: GpsRecord[], target: number): number {
    const index = findNearestIndex(records, target);
    return index < 0 ? -1 : validPositionIndexAt(records, index);
}

/**
 * Linearly interpolated position between adjacent GPS samples.
 * GPS runs at ~1 Hz; the map marker needs to move at 60 fps.
 *
 * Linear coordinate interpolation over short segments (tens to hundreds of
 * meters) is visually indistinguishable from geodesic. Longitude and bearing
 * take the shortest arc through their wrap boundary.
 *
 * Invalid fixes break interpolation. Exact valid samples remain visible,
 * including the first fix after a gap. Endpoints have a 5 s tolerance,
 * including a one-record track, to avoid carrying a stale fix past its clock.
 */
export function interpolatePosition(
    sortedRecords: GpsRecord[],
    targetUnixSeconds: number,
): InterpolatedPosition | null {
    if (sortedRecords.length === 0 || !Number.isFinite(targetUnixSeconds)) return null;

    // Binary search for the first index with unixSeconds >= target.
    let lo = 0;
    let hi = sortedRecords.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sortedRecords[mid]!.unixSeconds < targetUnixSeconds) lo = mid + 1;
        else hi = mid;
    }

    const nextIndex = validPositionIndexAt(sortedRecords, lo);
    if (nextIndex < 0) return null;
    const next = sortedRecords[nextIndex]!;
    if (lo === 0 || targetUnixSeconds >= next.unixSeconds) {
        if (Math.abs(next.unixSeconds - targetUnixSeconds) > GPS_POSITION_TOLERANCE_SEC) return null;
        return positionFromRecord(next);
    }

    const prevIndex = validPositionIndexAt(sortedRecords, lo - 1);
    if (prevIndex < 0) return null;
    const prev = sortedRecords[prevIndex]!;
    if (!isSameTrackSegment(prev, next)) return null;
    const span = next.unixSeconds - prev.unixSeconds;
    if (span <= 0) return positionFromRecord(prev);
    const t = Math.max(0, Math.min(1, (targetUnixSeconds - prev.unixSeconds) / span));

    const lat = prev.lat + (next.lat - prev.lat) * t;
    const lon = wrapDegrees(prev.lon + wrapDegrees(next.lon - prev.lon) * t);
    const speed = interpolateSpeed(prev, next, t);

    const bearingDeg = (wrapDegrees(prev.bearingDeg + wrapDegrees(next.bearingDeg - prev.bearingDeg) * t) + 360) % 360;

    return { lat, lon, bearingDeg, ...speed };
}

function isValidPositionRecord(record: GpsRecord): boolean {
    return (
        isValidGpsFix(record) &&
        Number.isFinite(record.unixSeconds) &&
        Number.isFinite(record.bearingDeg) &&
        Number.isFinite(record.speedMs) &&
        record.speedMs >= 0
    );
}

function validPositionIndexAt(records: GpsRecord[], index: number): number {
    const record = records[index]!;
    if (isValidPositionRecord(record)) return index;
    // Concurrent channels can disagree on fix validity at the same instant.
    for (let i = index - 1; i >= 0 && records[i]!.unixSeconds === record.unixSeconds; i--) {
        if (isValidPositionRecord(records[i]!)) return i;
    }
    for (let i = index + 1; i < records.length && records[i]!.unixSeconds === record.unixSeconds; i++) {
        if (isValidPositionRecord(records[i]!)) return i;
    }
    return -1;
}

function positionFromRecord(record: GpsRecord): InterpolatedPosition {
    return {
        lat: record.lat,
        lon: wrapDegrees(record.lon),
        bearingDeg: (wrapDegrees(record.bearingDeg) + 360) % 360,
        speedMs: record.speedMs,
        ...(record.speedSource ? { speedSource: record.speedSource } : {}),
    };
}

/**
 * Re-keys log records whose mp4Filename matches NO loaded video onto the one
 * loaded video that shares the same 70mai name core (see mai70NameCore: the
 * firmware renames locked clips across mode prefixes and can append garbage
 * after ".MP4" in the log row, so the exact-name byFilename join misses them
 * and event clips silently lose their GPS). Mutates the records in place and
 * returns how many were re-keyed; on a non-zero result the caller must
 * rebuild the log (the byFilename buckets are stale). A core shared by more
 * than one loaded video (hand-renamed copies) is ambiguous - skipped rather
 * than guessed. Non-70mai names have no core and are never touched.
 */
export function rebindOrphanLogRecords(log: ParsedLog, loadedVideoNames: Iterable<string>): number {
    const loaded = new Set(loadedVideoNames);
    // Core -> the unique loaded video carrying it; null marks an ambiguous core.
    const coreToName = new Map<string, string | null>();
    for (const name of loaded) {
        const core = mai70NameCore(name);
        if (core === null) continue;
        coreToName.set(core, coreToName.has(core) ? null : name);
    }
    if (coreToName.size === 0) return 0;

    let rebound = 0;
    for (const [bucketName, bucket] of log.byFilename) {
        if (loaded.has(bucketName)) continue;
        const core = mai70NameCore(bucketName);
        if (core === null) continue;
        const target = coreToName.get(core);
        if (target === undefined || target === null) continue;
        for (const rec of bucket) rec.mp4Filename = target;
        rebound += bucket.length;
    }
    return rebound;
}

/**
 * Clones GPS records across the channels of a multi-channel recording so all of
 * them anchor identically.
 *
 * A BlackVue `.gps` sidecar is shared by the front/rear/interior clips of one
 * recording but classifies against a single clip (matchBlackvueSidecarBasename).
 * Left alone, only that clip carries GPS: the other channels fall back to a
 * filename anchor with NO measured clock offset, so their startUtc diverges from
 * the GPS-anchored clip by the camera's clock error and frame grouping (the 30 s
 * snap in groupTrips) splits front from rear into separate frames. Copying the
 * records onto the sibling clips makes the per-fingerprint clock-offset
 * measurement and the resulting startUtc symmetric across channels; the
 * duplicate track is collapsed later by Trip.records' (unixSeconds, lat, lon)
 * dedup, which keeps the max-|G| accel copy.
 *
 * Channels sharing a recording are keyed by source-local path plus
 * `date_time_mode` (channel dropped). Matched physical copies retain that
 * membership even when the playback survivor has a different mode or source.
 * Cloned rows always belong to the surviving recording. Only clones onto
 * siblings that carry no records, so it never overwrites a channel with its own
 * embedded GPS and is idempotent across re-ingest. Mutates `log.records`; the
 * caller must rebuild the byFilename buckets (they are now stale). Returns the
 * number of cloned records.
 */
export function cloneRecordsAcrossChannels(log: ParsedLog, loadedVideos: Iterable<VideoWithRecordingCopies>): number {
    // Source + normalized parent path isolate equal BlackVue names from another
    // folder/card; the channel-group key then joins only one recording's F/R/I.
    const owners = new Map<string, VideoWithRecordingCopies>();
    const physicalOwners = new Map<string, string | null>();
    const nameOwners = new Map<string, Set<string>>();
    for (const video of loadedVideos) {
        const ownerKey = vendorFileKey(video);
        owners.set(ownerKey, video);
        for (const physical of [video, ...(video.recordingCopies ?? [])]) {
            const physicalKey = vendorFileKey(physical);
            if (physicalOwners.has(physicalKey) && physicalOwners.get(physicalKey) !== ownerKey) {
                physicalOwners.set(physicalKey, null);
            } else {
                physicalOwners.set(physicalKey, ownerKey);
            }
            let named = nameOwners.get(physical.file.name);
            if (!named) {
                named = new Set();
                nameOwners.set(physical.file.name, named);
            }
            named.add(ownerKey);
        }
    }

    const groups = new Map<string, Set<string>>();
    const groupsByOwner = new Map<string, Set<string>>();
    const recordsByOwner = new Map<string, GpsRecord[]>();
    for (const [ownerKey, video] of owners) {
        for (const physical of [video, ...(video.recordingCopies ?? [])]) {
            const physicalKey = vendorFileKey(physical);
            if (physicalOwners.get(physicalKey) !== ownerKey) continue;
            // Both raw alias records and already-canonicalized records can be
            // present, depending on when a log or a copy joined the ingest.
            if (!recordsByOwner.has(ownerKey)) {
                const owned = log.byVideoKey.get(physicalKey);
                const records = owned?.length
                    ? owned
                    : nameOwners.get(physical.file.name)?.size === 1
                      ? (log.byFilename.get(physical.file.name) ?? []).filter((record) => record.videoKey === undefined)
                      : [];
                if (records.length > 0) recordsByOwner.set(ownerKey, records);
            }
            const recordingKey = blackvueChannelCloneGroup(physical);
            if (recordingKey === null) continue;
            const groupKey = `${physical.sourceKey ?? ""}\0${recordingKey}`;
            let siblings = groups.get(groupKey);
            if (!siblings) {
                siblings = new Set();
                groups.set(groupKey, siblings);
            }
            siblings.add(ownerKey);
            let ownerGroups = groupsByOwner.get(ownerKey);
            if (!ownerGroups) {
                ownerGroups = new Set();
                groupsByOwner.set(ownerKey, ownerGroups);
            }
            ownerGroups.add(groupKey);
        }
    }

    let cloned = 0;
    const pending = [...groups.keys()];
    const queued = new Set(pending);
    for (let cursor = 0; cursor < pending.length; cursor++) {
        const groupKey = pending[cursor]!;
        queued.delete(groupKey);
        const siblings = groups.get(groupKey)!;
        if (siblings.size < 2) continue;
        const source = [...siblings].find((ownerKey) => recordsByOwner.has(ownerKey));
        if (source === undefined) continue;
        const sourceRecords = recordsByOwner.get(source)!;
        for (const siblingKey of siblings) {
            if (recordsByOwner.has(siblingKey)) continue;
            const sibling = owners.get(siblingKey)!;
            const records = sourceRecords.map((record) => ({
                ...record,
                mp4Filename: sibling.file.name,
                videoKey: siblingKey,
            }));
            for (const record of records) log.records.push(record);
            cloned += records.length;
            recordsByOwner.set(siblingKey, records);
            // A physical copy can join another mode/source group. Revisit that
            // group after its first GPS arrives, independent of input order.
            for (const linked of groupsByOwner.get(siblingKey) ?? []) {
                if (linked === groupKey || queued.has(linked)) continue;
                pending.push(linked);
                queued.add(linked);
            }
        }
    }
    return cloned;
}

/**
 * Rebuilds a ParsedLog after manually merging records (e.g. dedupe across
 * ingest sources). Groups by mp4Filename and sorts each bucket by unixSeconds
 * so the player can binary-search a file's records in O(log n).
 *
 * Idempotent: calling it on an already-sorted/grouped log returns an
 * equivalent log with freshly built byFilename buckets.
 */
export function rebuildLog(appliedExtractors: string[], records: GpsRecord[], skipped: SkippedLine[]): ParsedLog {
    const byFilename = new Map<string, GpsRecord[]>();
    const byVideoKey = new Map<string, GpsRecord[]>();
    const pendingByFilename = new Map<string, GpsRecord[]>();
    for (const rec of records) {
        let bucket = byFilename.get(rec.mp4Filename);
        if (!bucket) {
            bucket = [];
            byFilename.set(rec.mp4Filename, bucket);
        }
        bucket.push(rec);
        if (
            rec.recordingAssociation !== undefined ||
            (rec.timeAssociation !== undefined && rec.videoKey === undefined)
        ) {
            pendingByFilename.set(rec.mp4Filename, bucket);
        }
    }
    for (const arr of byFilename.values()) {
        arr.sort((a, b) => a.unixSeconds - b.unixSeconds);
        // Per-bucket so the freeze never leaks bearing across recording gaps
        // or between channels of a multi-channel camera.
        freezeStationaryBearingsByOwner(arr);
        for (const rec of arr) {
            if (rec.videoKey === undefined) continue;
            let owned = byVideoKey.get(rec.videoKey);
            if (!owned) {
                owned = [];
                byVideoKey.set(rec.videoKey, owned);
            }
            owned.push(rec);
        }
    }
    return { appliedExtractors, records, byFilename, byVideoKey, pendingByFilename, skipped };
}

/**
 * Union of two string arrays without duplicates, preserving first-occurrence
 * order. Used to merge ParsedLog.appliedExtractors when records from
 * multiple extraction passes (log + sidecar + embedded) land in one log.
 */
export function unionStringArrays(a: string[], b: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of a) {
        if (!seen.has(s)) {
            seen.add(s);
            out.push(s);
        }
    }
    for (const s of b) {
        if (!seen.has(s)) {
            seen.add(s);
            out.push(s);
        }
    }
    return out;
}

/**
 * Merges a freshly parsed batch of GPS records into an existing ParsedLog, or
 * builds the first one when `existing` is null. Centralizes the merge every
 * ingest source uses (logs, sidecars and embedded tracks): dedupe
 * the combined records, union the applied-extractor labels, and concatenate
 * skipped-line diagnostics. Callers without extractor labels or skipped lines
 * (sidecars) pass empty arrays.
 */
export function mergeIntoGpsLog(
    existing: ParsedLog | null,
    batch: { records: GpsRecord[]; appliedExtractors: string[]; skipped: SkippedLine[] },
): ParsedLog {
    if (!existing) {
        return rebuildLog(batch.appliedExtractors, thinDenseRecords(dedupRecords(batch.records)), batch.skipped);
    }

    // A positive extractor result may carry only a clock hint/label and no GPS
    // rows. Preserve the existing record indexes by reference instead of copying
    // and flattening the complete log for an empty data batch.
    if (batch.records.length === 0) {
        if (batch.appliedExtractors.length === 0 && batch.skipped.length === 0) return existing;
        return {
            ...existing,
            appliedExtractors:
                batch.appliedExtractors.length === 0
                    ? existing.appliedExtractors
                    : unionStringArrays(existing.appliedExtractors, batch.appliedExtractors),
            skipped: batch.skipped.length === 0 ? existing.skipped : existing.skipped.concat(batch.skipped),
        };
    }

    // Incremental merge. The dedup key carries videoKey when known (and the raw
    // filename otherwise), so concrete files never collide. Dedup is effectively
    // per basename bucket, with ownership isolation inside it. That lets
    // us re-dedup/sort/freeze ONLY the byFilename buckets this batch touches and
    // reuse every untouched bucket by reference. This keeps each progressive
    // batch proportional to the files it changed instead of the full log.
    const batchByFile = new Map<string, GpsRecord[]>();
    for (const rec of batch.records) {
        let arr = batchByFile.get(rec.mp4Filename);
        if (!arr) {
            arr = [];
            batchByFile.set(rec.mp4Filename, arr);
        }
        arr.push(rec);
    }

    const byFilename = new Map<string, GpsRecord[]>(existing.byFilename);
    for (const [filename, batchRecs] of batchByFile) {
        const existingBucket = byFilename.get(filename);
        // dedupRecords over just this file's existing + incoming records yields
        // the same survivors (first-seen identity + max-|G| transplant) the
        // global dedup would, since no cross-file key can collide. Sort + freeze
        // only this one bucket. Bearing stabilization is applied independently
        // per concrete video owner, so equal basenames cannot leak headings.
        // Thin AFTER dedup: dedup keys on exact (time, position), thinning on
        // coarser time buckets - the wider net must see the deduped survivors so
        // its max-|G| transplant compounds instead of racing. Existing bucket
        // goes first, so an already-thinned survivor keeps its identity across
        // re-merges of the same source.
        const mergedBucket = thinDenseRecords(
            existingBucket ? dedupRecords(existingBucket.concat(batchRecs)) : dedupRecords(batchRecs),
        );
        mergedBucket.sort((a, b) => a.unixSeconds - b.unixSeconds);
        freezeStationaryBearingsByOwner(mergedBucket);
        byFilename.set(filename, mergedBucket);
    }

    // Flat records[] view. Order is not part of the contract (consumers read it
    // by length or through byFilename), so concatenating the buckets is
    // stable for consumers and keeps record identity shared
    // with the buckets - mergeAccelSamples mutates these same objects in place.
    const records: GpsRecord[] = [];
    const byVideoKey = new Map<string, GpsRecord[]>();
    const pendingByFilename = new Map<string, GpsRecord[]>();
    for (const bucket of byFilename.values()) {
        for (const rec of bucket) {
            records.push(rec);
            if (
                rec.recordingAssociation !== undefined ||
                (rec.timeAssociation !== undefined && rec.videoKey === undefined)
            ) {
                pendingByFilename.set(rec.mp4Filename, bucket);
            }
            if (rec.videoKey === undefined) continue;
            let owned = byVideoKey.get(rec.videoKey);
            if (!owned) {
                owned = [];
                byVideoKey.set(rec.videoKey, owned);
            }
            owned.push(rec);
        }
    }

    return {
        appliedExtractors: unionStringArrays(existing.appliedExtractors, batch.appliedExtractors),
        records,
        byFilename,
        byVideoKey,
        pendingByFilename,
        skipped: existing.skipped.concat(batch.skipped),
    };
}

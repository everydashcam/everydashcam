// GPMF (GoPro Metadata Format) extraction. Vendor-agnostic utility used by
// goproPlugin (when classified as gopro by filename or classifyByContent) and
// genericPlugin as a fallback. Format source of truth: github.com/gopro/gpmf-parser.
// Parsing logic (DEVC → STRM → GPS5/GPS9 + SCAL/GPSU/GPSF) is unchanged from
// the original goproPlugin (gopro.ts parameters were marked "not verified on
// HERO11+" - those caveats still apply).

import { extendArray } from "../../array-extend.js";
import type { GpsRecord, ParsedRecords, SkippedLine, VendorFile } from "../types.js";
import { decodeNumeric, decodeString, iterTokens, parseGpsuTimestamp, type GpmfToken } from "./gpmf.js";
import { readMediaTimescale, readSampleDurationsInTicks } from "./mp4-walker.js";
import { findTrackBySampleFormat, loadTrackSampleBuffers, type Mp4Index, type TrackInfo } from "./mp4-index.js";

const GPMF_FORMAT = "gpmd";

/** Returns the track with sample-format='gpmd' from Mp4Index, or null. */
export function findGpmdTrack(index: Mp4Index): TrackInfo | null {
    return findTrackBySampleFormat(index, [GPMF_FORMAT]);
}

/**
 * Extracts GPS from the gpmd track. Reads the sample table, loads all samples
 * in parallel, and parses each as GPMF KLV. Returns null if the track has no
 * samples ("GoPro format detected but track is empty" = corrupt file).
 */
export async function extractFromGpmdTrack(
    vf: VendorFile,
    index: Mp4Index,
    track: TrackInfo,
): Promise<ParsedRecords | null> {
    // Guard kept although loadTrackSampleBuffers re-checks: the reads below
    // need index.moovView narrowed to non-null.
    if (!index.moovView) return null;
    const sampleBuffers = await loadTrackSampleBuffers(vf.file, index, track);
    if (!sampleBuffers) return null;

    // Per-sample durations in seconds. GoPro emits ~1 GPMF sample per second
    // but the actual span depends on framerate and stts. Without this, GPS5
    // sub-samples assume each sample covers exactly 1.000 s and drift up to
    // a few seconds per hour against video.
    const durationsTicks = readSampleDurationsInTicks(index.moovView, track.trakBox);
    const mediaTimescale = readMediaTimescale(index.moovView, track.trakBox);
    const sampleDurationsSec: number[] | null =
        durationsTicks && mediaTimescale && mediaTimescale > 0 ? durationsTicks.map((d) => d / mediaTimescale) : null;

    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];
    // Per-record source-stream kind, parallel to `records` (kept out of the
    // public GpsRecord type on purpose). Feeds the per-file GPS9-over-GPS5
    // preference below.
    const streamKinds: GpmfGpsStreamKind[] = [];

    for (let sampleIdx = 0; sampleIdx < sampleBuffers.length; sampleIdx++) {
        const buf = sampleBuffers[sampleIdx]!;
        const sampleDv = new DataView(buf);
        // Fall back to 1 second if durations unavailable - matches pre-fix
        // behavior so degraded mode is no worse than before.
        const sampleDurSec = sampleDurationsSec?.[sampleIdx] ?? 1;
        try {
            extractGpsFromSample(sampleDv, vf.file.name, sampleDurSec, records, streamKinds);
        } catch (err) {
            skipped.push({
                line: sampleIdx + 1,
                raw: `<gpmd sample ${sampleIdx + 1} of ${sampleBuffers.length}>`,
                reason: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // GoPro GPMF does not record course/bearing - GPS5/GPS9 have only
    // lat/lon/alt/speed (bearingDeg=0 hardcoded in extractFromGps5/9). The
    // dispatcher detects "all zero" output and forward-fills from the
    // trajectory, so we don't run it here.
    //
    // The GPS5 discard runs per FILE, after the whole sample walk - never
    // inside extractGpsFromSample, whose ACCL merge indexes the records array
    // via sampleStartIdx/addedCount and assumes contiguous appends.
    return { records: dropGps5WhenGps9Present(records, streamKinds), skipped };
}

/** Source stream a GPS record was extracted from (internal to gpmf-extract). */
export type GpmfGpsStreamKind = "gps5" | "gps9";

/**
 * Per-file GPS9-over-GPS5 preference. HERO11 writes BOTH a GPS5 and a GPS9
 * stream over the same fixes (official gpmf-parser README HERO11 table lists
 * GPS5 as "unchanged but deprecated" alongside GPS9; gopro2gpx dedups the
 * same way in gpshelper.py:55-71 _prioritize_gps9). Their timestamps differ
 * sub-second (GPS5 = GPSU + i/rate vs GPS9 per-sample days/secs), so the
 * exact-key dedup layers downstream cannot collapse the duplicates - keeping
 * both doubles the track density. GPS9 is strictly the better source
 * (per-sample time/fix/DOP). Implemented from foreign source, not validated
 * against a real HERO11 dual-stream file; single-stream files (all current
 * real samples: hero5/6/8) are untouched - the discard only fires when both
 * kinds are present.
 *
 * `streamKinds` must be parallel to `records`; on a length mismatch (a decode
 * throw mid-stream would have to defeat the try/finally tagging) the input is
 * returned unfiltered - a doubled track beats a wrongly halved one.
 */
export function dropGps5WhenGps9Present(records: GpsRecord[], streamKinds: GpmfGpsStreamKind[]): GpsRecord[] {
    if (streamKinds.length !== records.length) return records;
    const hasGps9 = streamKinds.includes("gps9");
    const hasGps5 = streamKinds.includes("gps5");
    if (!hasGps9 || !hasGps5) return records;
    return records.filter((_, i) => streamKinds[i] === "gps9");
}

// ===== Internal GPMF parsing functions (unchanged from gopro.ts) =====

/**
 * Markers to distinguish current and legacy exports from third-party DEVC blocks
 * (GoPro Hero, Insta360, etc.), compared against the DVNM field.
 *
 * Why: accelerometer semantics differ across vendors. Our GpsRecord.accelXg/Yg/Zg
 * is gravity-removed dynamic acceleration (zero at rest). GoPro GPMF-ACCL writes
 * raw with-gravity (~1g on the vertical axis while parked). Merging raw GoPro
 * accel into GpsRecord would cause events.ts to flag every parked second as a
 * brake event (magnitude = sqrt(X²+Y²+Z²) ≈ 1g).
 *
 * So ACCL is merged only from our own DEVC blocks. Full GoPro accel support
 * is in the backlog (requires computing a gravity vector, non-trivial without
 * knowing the installation orientation).
 */
const OWN_DEVICE_NAMES = ["everydashcam", "dashcamigo"];

// Exported for tests: parses one gpmd sample (DEVC -> STRM -> GPS5/GPS9) into
// GpsRecord[]. Production callers go through extractFromGpmdTrack.
// `kindsOut`, when given, receives one stream-kind entry per record appended
// to `out` (kept parallel even if a decoder throws mid-stream - see the
// try/finally in extractGpsFromStreamTags).
export function extractGpsFromSample(
    dv: DataView,
    mp4Filename: string,
    sampleDurationSec: number,
    out: GpsRecord[],
    kindsOut?: GpmfGpsStreamKind[],
): void {
    for (const top of iterTokens(dv)) {
        if (top.fourCC !== "DEVC" || top.type !== 0) continue;

        // Check the DVNM of this DEVC block to decide whether to merge ACCL
        // (see OWN_DEVICE_NAMES).
        let isOwnDevice = false;
        for (const tag of iterTokens(top.payload)) {
            if (tag.fourCC === "DVNM") {
                isOwnDevice = OWN_DEVICE_NAMES.includes(decodeString(tag));
                break;
            }
        }

        const sampleStartIdx = out.length;
        const acclSamplesCollected: { x: number; y: number; z: number }[] = [];

        for (const strm of iterTokens(top.payload)) {
            if (strm.fourCC !== "STRM" || strm.type !== 0) continue;
            const tags = collectStrmTags(strm);
            if (tags.gps5 || tags.gps9) {
                extractGpsFromStreamTags(tags, mp4Filename, sampleDurationSec, out, kindsOut, isOwnDevice);
            } else if (tags.accl && isOwnDevice) {
                // Only for our own DEVC blocks - see OWN_DEVICE_NAMES.
                const samples = decodeAcclSamples(tags.accl, tags.scal);
                if (samples) extendArray(acclSamplesCollected, samples);
            }
        }

        // Merge ACCL into the GPS records from this DEVC block. For our own
        // export the structure is fixed: 1 GPS record + 1 ACCL sample per DEVC
        // at 1 Hz (trivial 1-to-1 mapping). mergeAcclIntoRecords keeps a
        // proportional fallback for N≠M (future GoPro support; currently
        // unreachable due to the isOwnDevice filter).
        const addedCount = out.length - sampleStartIdx;
        if (addedCount > 0 && acclSamplesCollected.length > 0) {
            mergeAcclIntoRecords(out, sampleStartIdx, addedCount, acclSamplesCollected);
        }
    }
}

interface StrmTags {
    gps5: GpmfToken | null;
    gps9: GpmfToken | null;
    scal: GpmfToken | null;
    gpsu: GpmfToken | null;
    gpsf: GpmfToken | null;
    gpsp: GpmfToken | null;
    accl: GpmfToken | null;
    speedSources: GpmfToken | null;
    trackSegments: GpmfToken | null;
}

function collectStrmTags(strm: GpmfToken): StrmTags {
    const tags: StrmTags = {
        gps5: null,
        gps9: null,
        scal: null,
        gpsu: null,
        gpsf: null,
        gpsp: null,
        accl: null,
        speedSources: null,
        trackSegments: null,
    };
    for (const tag of iterTokens(strm.payload)) {
        switch (tag.fourCC) {
            case "GPS5":
                tags.gps5 = tag;
                break;
            case "GPS9":
                tags.gps9 = tag;
                break;
            case "SCAL":
                tags.scal = tag;
                break;
            case "GPSU":
                tags.gpsu = tag;
                break;
            case "GPSF":
                tags.gpsf = tag;
                break;
            case "GPSP":
                tags.gpsp = tag;
                break;
            case "dcsp":
                tags.speedSources = tag;
                break;
            case "dcsg":
                tags.trackSegments = tag;
                break;
            case "ACCL":
                tags.accl = tag;
                break;
        }
    }
    return tags;
}

function extractGpsFromStreamTags(
    tags: StrmTags,
    mp4Filename: string,
    sampleDurationSec: number,
    out: GpsRecord[],
    kindsOut?: GpmfGpsStreamKind[],
    isOwnDevice = false,
): void {
    if (!tags.scal) return;
    const scalValues = decodeNumeric(tags.scal);
    if (!scalValues) return;

    // GPSF (fix quality) and GPSP (DOP × 100) indicate GPS fix validity at the
    // stream level. Without a fix (GPSF<2) coordinate values are garbage:
    // hero7.mp4 gives 0/0, hero8.mp4 wanders 35-42° N in the Pacific,
    // hero6.mp4 has samples with 2 km outliers. GPS9 has a per-sample fix field
    // and is filtered again internally.
    if (!isStreamFixUsable(tags.gpsf, tags.gpsp)) return;

    // GPS9-first: per-sample time/fix/DOP make it strictly the better source
    // when a single STRM ever carries both tags (gpmf-parser README marks GPS5
    // "deprecated" from HERO11 on). Normal HERO11 files put GPS5 and GPS9 in
    // SEPARATE STRMs - that case is handled per file by dropGps5WhenGps9Present.
    const kind: GpmfGpsStreamKind = tags.gps9 ? "gps9" : "gps5";
    const before = out.length;
    try {
        if (tags.gps9) {
            extractFromGps9(tags.gps9, scalValues, mp4Filename, out);
        } else if (tags.gps5) {
            extractFromGps5(
                tags.gps5,
                scalValues,
                tags.gpsu,
                sampleDurationSec,
                mp4Filename,
                out,
                isOwnDevice && tags.speedSources ? decodeNumeric(tags.speedSources) : null,
                isOwnDevice && tags.trackSegments ? decodeNumeric(tags.trackSegments) : null,
            );
        }
    } finally {
        // finally keeps kindsOut parallel to out even on a decode throw
        // (extractFromGpmdTrack catches per sample and keeps going).
        if (kindsOut) {
            for (let i = before; i < out.length; i++) kindsOut.push(kind);
        }
    }
}

/** Converts m/s² to g. Inverse of G_TO_MS2 in gpmf-pack.ts. */
const MS2_TO_G = 1 / 9.80665;

/**
 * Decodes an ACCL stream into {x,y,z} in g (gravity-removed per GpsRecord
 * contract). UNIT per spec = "m/s2", divided by 9.80665. SCAL may be a single
 * scalar (GoPro and our packer) or 3 scalars - applied per axis.
 */
function decodeAcclSamples(accl: GpmfToken, scal: GpmfToken | null): { x: number; y: number; z: number }[] | null {
    const raw = decodeNumeric(accl);
    if (!raw || raw.length === 0 || raw.length % 3 !== 0) return null;
    const scalValues = scal ? decodeNumeric(scal) : null;
    // One SCAL value → applied to all three axes. Three values → one per axis.
    // No SCAL → treat as 1 (raw values already in target units, rare but valid).
    const sx = scalValues?.[0] ?? 1;
    const sy = scalValues && scalValues.length >= 3 ? scalValues[1]! : sx;
    const sz = scalValues && scalValues.length >= 3 ? scalValues[2]! : sx;

    const out: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < raw.length; i += 3) {
        out.push({
            x: (raw[i]! / sx) * MS2_TO_G,
            y: (raw[i + 1]! / sy) * MS2_TO_G,
            z: (raw[i + 2]! / sz) * MS2_TO_G,
        });
    }
    return out;
}

/**
 * Maps M ACCL samples to N GPS records at sampleStartIdx..sampleStartIdx+N-1.
 * Proportional mapping: gps[i] gets accl[round(i × (M-1) / max(N-1, 1))].
 * For 1:1 (our export) this reduces to gps[i]=accl[i]. For GoPro 18:200 it is
 * an approximation (exact merge would require STMP timestamps).
 */
function mergeAcclIntoRecords(
    out: GpsRecord[],
    sampleStartIdx: number,
    addedCount: number,
    acclSamples: { x: number; y: number; z: number }[],
): void {
    const M = acclSamples.length;
    const N = addedCount;
    for (let i = 0; i < N; i++) {
        const acclIdx = N === 1 ? 0 : Math.min(M - 1, Math.round((i * (M - 1)) / (N - 1)));
        const a = acclSamples[acclIdx]!;
        const r = out[sampleStartIdx + i]!;
        r.accelXg = a.x;
        r.accelYg = a.y;
        r.accelZg = a.z;
    }
}

/**
 * A sample stream has a usable GPS fix when:
 *   - GPSF >= 2 (2D or 3D fix). 0 = no lock, 1 = stale - both yield garbage.
 *   - GPSP < DOP_NO_FIX_SENTINEL. Firmware often writes 9999 as "no fix" even
 *     when GPSF=3 (e.g. hero6.mp4 sample[1]: GPSF=3, GPSP=9999 - fix just
 *     acquired, DOP not yet computed).
 * If a tag is absent the condition is treated as satisfied (old HERO5 without
 * GPSP on some firmware versions).
 */
const DOP_NO_FIX_SENTINEL = 9000;
function isStreamFixUsable(gpsf: GpmfToken | null, gpsp: GpmfToken | null): boolean {
    if (gpsf) {
        const fix = decodeNumeric(gpsf)?.[0];
        if (typeof fix === "number" && fix < 2) return false;
    }
    if (gpsp) {
        const dop = decodeNumeric(gpsp)?.[0];
        if (typeof dop === "number" && dop >= DOP_NO_FIX_SENTINEL) return false;
    }
    return true;
}

function extractFromGps5(
    token: GpmfToken,
    scal: number[],
    gpsu: GpmfToken | null,
    sampleDurationSec: number,
    mp4Filename: string,
    out: GpsRecord[],
    speedSources: number[] | null,
    trackSegments: number[] | null,
): void {
    if (scal.length < 5) return;
    const [scalLat, scalLon, scalAlt, scalSpeed2d, scalSpeed3d] = scal as [number, number, number, number, number];
    void scalAlt;
    void scalSpeed3d;

    const samples = decodeNumeric(token);
    if (!samples) return;
    const numSamples = samples.length / 5;
    if (numSamples < 1) return;

    const baseUnix = gpsu ? parseGpsuTimestamp(decodeString(gpsu)) : null;
    if (baseUnix === null) return;

    // dt: time between sub-samples. Each gpmd sample covers sampleDurationSec
    // (from stts). Sub-samples are evenly spaced inside that window.
    const dt = numSamples > 1 ? sampleDurationSec / numSamples : 0;

    for (let i = 0; i < numSamples; i++) {
        const lat = samples[i * 5]! / scalLat;
        const lon = samples[i * 5 + 1]! / scalLon;
        const speed2d = samples[i * 5 + 3]! / scalSpeed2d;
        // NaN/Infinity slip through the range guards below (NaN comparisons
        // are false): a payload whose length is not a multiple of 5 yields
        // undefined -> NaN, a zero SCAL yields Infinity. Same guard as the
        // sibling extractors (freegps, navitel, rvmi).
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(speed2d)) continue;
        if (lat === 0 && lon === 0) continue;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
        out.push({
            unixSeconds: baseUnix + i * dt,
            active: true,
            lat,
            lon,
            bearingDeg: 0,
            speedMs: speedSources?.[i] === 2 ? 0 : speed2d,
            ...(speedSources?.[i] === 1
                ? { speedSource: "estimated" as const }
                : speedSources?.[i] === 2
                  ? { speedSource: "unavailable" as const }
                  : {}),
            ...(trackSegments?.[i] !== undefined && trackSegments[i]! >= 0 ? { trackSegment: trackSegments[i]! } : {}),
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename,
        });
    }
}

// GPS9 sample is TYPE=lllllllSS: 7 int32 + 2 uint16 = 32 bytes (NOT 9 int32).
//   lat@0 lon@4 alt@8 speed2d@12 speed3d@16 days@20 secs@24 (all int32),
//   dop@28 fix@30 (uint16). The KLV header carries the real stride in
//   token.sampleSize and the sample count in token.repeat - we drive off those
//   so a future firmware that appends fields keeps working as long as the first
//   32 bytes match.
const GPS9_MIN_SAMPLE_SIZE = 32;
const DAYS_2000_TO_1970 = 30 * 365 + 7;
const GPS9_EPOCH_OFFSET_SEC = DAYS_2000_TO_1970 * 86400;

function extractFromGps9(token: GpmfToken, scal: number[], mp4Filename: string, out: GpsRecord[]): void {
    if (scal.length < 5) return;
    const [scalLat, scalLon, scalAlt, scalSpeed2d, scalSpeed3d] = scal as [number, number, number, number, number];
    void scalAlt;
    void scalSpeed3d;

    const dv = token.payload;
    const stride = Math.max(token.sampleSize, GPS9_MIN_SAMPLE_SIZE);
    const numSamples = token.repeat;
    if (numSamples < 1) return;

    for (let i = 0; i < numSamples; i++) {
        const off = i * stride;
        if (off + GPS9_MIN_SAMPLE_SIZE > dv.byteLength) break; // truncated payload - stop
        const latRaw = dv.getInt32(off, false);
        const lonRaw = dv.getInt32(off + 4, false);
        const speed2dRaw = dv.getInt32(off + 12, false);
        const days = dv.getInt32(off + 20, false);
        const secsMs = dv.getInt32(off + 24, false);
        const fix = dv.getUint16(off + 30, false);

        const lat = latRaw / scalLat;
        const lon = lonRaw / scalLon;
        if (lat === 0 && lon === 0) continue;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
        if (fix < 2) continue;

        const speedMs = speed2dRaw / scalSpeed2d;
        const unixSeconds = GPS9_EPOCH_OFFSET_SEC + days * 86400 + secsMs / 1000;

        out.push({
            unixSeconds,
            active: true,
            lat,
            lon,
            bearingDeg: 0,
            speedMs,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename,
        });
    }
}

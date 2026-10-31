// SigmaStar ("SStar") firmware `ssmd` meta-track GPS extraction - constant
// samples at ~1 Hz. Coordinate encodings are selected by sample size and
// content flags; byte layouts and validation: docs/format-sstar-ssmd.md.
//
// The 40-byte dialect was reverse-engineered and validated against 3 real
// mirror-cam clips (528
// samples total; an all-fix day drive, a cold-start clip with sparse fixes
// and an unsynced-clock stretch, a night drive with sparse fixes) plus a
// 4K-cam day-drive clip (301 samples; the 0x067E flags base). Byte layout
// and the verification evidence: docs/format-sstar-ssmd.md.
//
// The `ssmd` sample-description name is multi-vendor (LigoGPS 64..1024-byte
// chunks, Chigee JPEG previews, Rove 32-byte GPS, Rove 12-byte accel). This
// Neoline firmware writes THREE ssmd meta tracks per file: a single-sample JPEG
// thumbnail, the 40-byte GPS track (ours), and a 12-byte ~15 Hz telemetry
// track (undeciphered - see the doc). Constant size plus the dialect-specific
// content probe keep all other ssmd dwellers out. The 56-byte iZEEKER layout
// has one ssmd track and is gated by its appended identifier/KTRX/clock tag.
//
// Sample layout (40 bytes, little-endian):
//   +0   f64  latitude, decimal degrees (NOT NMEA DDmm); no-fix sentinel
//        4294967295.0 (bytes 00 00 e0 ff ff ff ef 41 - same value the Rove
//        32-byte dialect uses)
//   +8   f64  longitude, same convention and sentinel
//   +16  i32  unused by us; smooth small values on good-signal rows, drifts
//        wildly (even negative) on poor-signal rows - altitude in meters is
//        the best fit (ruled out against movement course and speed), -1 on
//        no-fix. GpsRecord has no altitude field, so it is not extracted.
//   +20  u16  speed, km/h integer (verified against haversine distance of
//        consecutive fixes: mean error 4.4 km/h over 179 pairs on the
//        good-signal clip; /10 and knots candidates were off by 80+);
//        0xFFFF on no-fix
//   +22  u16  flags: a constant per-camera base plus a 0x0100 fix bit.
//        Observed bases: 0x047E (mirror cam), 0x067E (4K front cam); the
//        0x0200 delta is undeciphered. Agreement between the fix bit and
//        the coordinate sentinel was exact across every observed sample
//   +24  u8   day-of-month, +25 hour, +26 minute, +27 second. On FIX rows
//        this is the GPS clock in UTC; on NO-FIX rows the firmware falls
//        back to the camera RTC in LOCAL time (verified: +3 h vs fix rows
//        on a UTC+3 camera, on all three clips). No year/month anywhere in
//        the record - see the date-anchor logic below.
//   +28  u8   course over ground / 2 (2-degree units, 0..179; verified
//        against the movement bearing of consecutive fixes: mean circular
//        error 1.8 deg over 142 clean moving pairs). 0 also shows up on
//        clearly-moving rows (course not updated by the firmware), so 0 is
//        treated as "unknown" and forward-filled from the previous emitted
//        record at extraction time.
//   +29  u8[3] constant 01 01 00 on fix rows; +28..31 = ff 00 ff ff on
//        no-fix rows. Not decoded.
//   +32  u32  0/1 flag (flips to 1 at the first fix after boot and stays;
//        verified: exactly the first-fix sample index), +36 u32 zero. Not
//        decoded.
//
// Hemisphere: no N/S/E/W field; signed doubles assumed (all real samples
// are N/E) - same caveat as rove-ssmd/navitel-gps0.
//
// Cold-start caveat: the firmware can flag rows as "fix" while the GPS clock
// is not yet synced (observed: first fixes ~90-105 s ahead, then a backward
// jump once the clock locks) and the position can be off by tens of km. No
// in-record field distinguishes such rows, so the extractor drops every fix
// before the LAST anomalous clock step - a backward jump, or a forward step
// larger than the elapsed media time (the stale-BEHIND clock syncing) - see
// the post-pass in extractFromSstarSsmdTrack.
//
// Stale-clock caveat: a clip can carry fix rows whose clock is tens of
// seconds BEHIND real time with NO resync inside the clip (observed: ~104 s
// behind on a short-GPS-window clip; positions and speeds were real, only
// the clock was stale). Nothing intra-file reveals this, so the clock is
// cross-checked against the filename time: (filename local - fix UTC tied to
// media 0) must sit on the 15-min TZ grid within a small drift tolerance.
// Off-grid -> every fix is demoted to timeUnsynced (position kept, media
// offset kept), and no videoStartUtcHint is emitted - the time layer then
// anchors the file from the filename/run-offset machinery.
//
// Phantom-track caveat: under weak signal the receiver emits fully-flagged
// fixes carrying a self-consistent fictional trajectory (a parked car gets a
// smooth 113-137 km/h track; the OSD hides its speed readout but the ssmd
// rows are indistinguishable from good fixes). Defense: the whole-file gate
// above the PHANTOM_* constants - when it trips, every fix is dropped and
// only the frame-0 clock hint survives.

import { haversineKm } from "../../parser.js";
import { KMH_TO_MS, type GpsRecord, type ParsedRecords, type SkippedLine, type VendorFile } from "../types.js";
import { isDashcamYear, utcMillisecondsFromParts } from "./calendar.js";
import { ddmmToDegrees } from "./ddmm.js";
import { getFirstSampleOfTrack, type Mp4Index, type TrackInfo } from "./mp4-index.js";
import { loadSamples, readMediaTimescale, readSampleStartsInTicks, readSampleTable } from "./mp4-walker.js";

/** Direct-coordinate SStar ssmd GPS sample size (Neoline family). */
export const SSTAR_SSMD_SAMPLE_SIZE = 40;

/** Obfuscated-coordinate SStar ssmd GPS sample size (iZEEKER iD300). */
export const SSTAR_KTRX_SSMD_SAMPLE_SIZE = 56;

/** DDmm-coordinate SStar ssmd GPS sample size (iBox RoadScan 2K). */
export const SSTAR_DDMM_SSMD_SAMPLE_SIZE = 32;

// The DDmm dialect shares offsets 16..31 with direct-coordinate SStar:
// speed in km/h, flags, UTC day/time and course in 2-degree units. Its first
// two doubles use degrees*100 + minutes and there is no appended tail.
// This word occupies Rove's year/month slots, so its date probe rejects it.
export const SSTAR_DDMM_FLAGS_FIX = 0x097e;
// No-fix rows carry both coordinate sentinels and a camera-local RTC clock.
export const SSTAR_DDMM_FLAGS_NO_FIX = 0x087e;

/** Flags word at +22: a constant per-camera base plus the 0x0100 fix bit.
 *  Two bases observed across the firmware family: 0x047E (mirror cam) and
 *  0x067E (4K front cam). The 0x0200 delta between them is undeciphered;
 *  it never varied within a clip or a camera. */
export const SSTAR_FLAGS_FIX_BIT = 0x0100;
export const SSTAR_FLAGS_BASES: readonly number[] = [0x047e, 0x067e];
// Mirror-cam words, kept as named constants for the fixture builders.
export const SSTAR_FLAGS_FIX = 0x057e;
export const SSTAR_FLAGS_NO_FIX = 0x047e;

// iZEEKER iD300 `KTRX` dialect. All 180 rows of the real sample carried
// 0x087E; unlike the 40-byte dialect, no separate no-fix word was observed.
export const SSTAR_KTRX_FLAGS_FIX = 0x087e;

// The first two doubles of the KTRX dialect are reversible obfuscated
// coordinates rather than degrees. The same second-indexed factor table is
// used for latitude and minute-indexed for longitude:
//   encodedLat = latitude  * factor[second] / 10 + 114.712
//   encodedLon = longitude * factor[minute] / 10 + 224.222
// Recovered independently from 18 burned-in OSD checkpoints; see the format
// note for the cross-check against speed and movement.
export const SSTAR_KTRX_FACTORS: readonly number[] = [
    15, 25, 36, 63, 82, 13, 12, 15, 21, 31, 21, 57, 16, 29, 47, 26, 42, 26, 26, 12, 65, 28, 12, 26, 46, 24, 29, 25, 54,
    23, 87, 12, 46, 48, 35, 37, 68, 12, 24, 46, 76, 55, 26, 28, 67, 24, 43, 46, 68, 87, 23, 56, 78, 34, 16, 48, 27, 81,
    53, 82,
];
const SSTAR_KTRX_LAT_OFFSET = 114.712;
const SSTAR_KTRX_LON_OFFSET = 224.222;
const SSTAR_KTRX_ID_OFFSET = 32;
const SSTAR_KTRX_ID_LENGTH = 16;
const SSTAR_KTRX_MARKER_OFFSET = 48;
const SSTAR_KTRX_CLOCK_OFFSET = 52;

/**
 * Classifies the +22 flags word: "fix"/"nofix" when the word is a known
 * base with/without the fix bit, null for a foreign word (alien track
 * content or a junk row).
 */
export function classifySstarFlagsWord(word: number): "fix" | "nofix" | null {
    if (!SSTAR_FLAGS_BASES.includes(word & ~SSTAR_FLAGS_FIX_BIT)) return null;
    return (word & SSTAR_FLAGS_FIX_BIT) !== 0 ? "fix" : "nofix";
}

// No-fix coordinate sentinel: LE double 4294967295.0, written into BOTH the
// lat and lon slots (unlike Rove, which ExifTool documents for lat only).
const NO_FIX_COORD_SENTINEL = Uint8Array.of(0x00, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xef, 0x41);

const OFF_LAT = 0;
const OFF_LON = 8;
// +16..19 unused (altitude-like) - intentionally not read.
const OFF_SPEED = 20;
const OFF_FLAGS = 22;
const OFF_DAY = 24;
const OFF_HOUR = 25;
const OFF_MIN = 26;
const OFF_SEC = 27;
const OFF_COURSE = 28;

const SPEED_INVALID = 0xffff;
// Course byte ceiling: 179 * 2 = 358 deg. Above it the 2-degree-unit reading
// would exceed a full circle - unknown convention, treated as "no course"
// rather than dropping an otherwise valid coordinate row.
const COURSE_RAW_MAX = 179;

const DAY_MS = 86_400_000;

// Cold-start pre-sync detector threshold: adjacent synced fixes jitter by at
// most 1-2 s, while the observed pre-sync clock error is 90-105 s - any
// backward jump above this marks the sync step, never ordinary jitter. The
// same threshold bounds the (clock delta - media delta) excess of the
// anomaly scan: a synced clock advances with media time (a fix gap advances
// BOTH deltas equally), so an excess beyond jitter is a clock step.
const COLD_START_BACKWARD_JUMP_S = 5;

// Stale-clock gate: |filename local - (fix UTC - media)| distance to the
// 15-min TZ grid. Real TZ offsets sit on the grid; the camera RTC (which
// mints the filename) tracks the GPS clock within 1-2 s on every good real
// sample, while the observed stale clock was ~104 s off. 30 s splits the two
// populations with an order-of-magnitude margin on each side.
const STALE_CLOCK_GRID_TOLERANCE_S = 30;
const TZ_GRID_S = 900;

// Phantom-track gate. In a weak-signal environment (urban canyon) this
// receiver emits fully-flagged fixes carrying a self-consistent FICTIONAL
// trajectory: a parked car (video ground truth) gets a smooth 113-137 km/h
// track with a slowly rotating course and a correct GPS clock, while the
// firmware's own OSD hides its speed readout. No per-row field distinguishes
// such fixes, so the whole file is judged on two conjuncts and, when both
// trip, every fix is dropped (positions AND speeds are fabricated; only the
// clock survives, via videoStartUtcHint on the anchored path):
//   1. no-fix share of all rows - the receiver kept losing the fix, i.e. the
//      signal environment could not support a trustworthy solution;
//   2. share of adjacent emitted-fix pairs whose haversine-implied speed
//      disagrees with the recorded speed field beyond GPS noise, in EITHER
//      direction (position frozen while speed claims motion, or a jump the
//      recorded speed cannot cover). On good-signal real clips the two agree
//      to ~5 km/h; the mismatch is measured only across small media gaps,
//      where a real position cannot drift far from what the speed implies.
// Observed populations: good-signal clips 0.00-0.01 no-fix share with 0-1%
// violating pairs, weak-signal clips 0.51-0.87 with 15-29% - both thresholds
// sit an order of magnitude from the good side. The count floors keep the
// gate from firing on a handful of pairs where one glitch row dominates the
// share. Known cost: a weak-signal clip whose sparse fixes are genuine loses
// them too (its positions are 100+ m noisy anyway); known limitation: a
// phantom written under a clean sky (no no-fix rows) passes the gate.
const PHANTOM_MIN_NOFIX_SHARE = 0.3;
const PHANTOM_MAX_PAIR_GAP_S = 8;
const PHANTOM_SPEED_MISMATCH_KMH = 50;
const PHANTOM_MIN_PAIRS = 5;
const PHANTOM_MIN_VIOLATIONS = 2;
const PHANTOM_MIN_VIOLATION_SHARE = 0.1;

// Strict Neoline filename shape for the date anchor. Master regex:
// RX_NEOLINE in ../filename/_patterns.ts - duplicated here (not imported) to
// keep the parser layer decoupled from filename techniques, and relaxed to a
// suffix match so a renamed copy that keeps the original name at the end
// ("backup-... INF20260520-134803-14-F.mp4") still anchors on it.
const RX_NEOLINE_SUFFIX = /INF(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-\d+-[FR]\.mp4$/i;

// Shared by the DDmm and KTRX dialects; local for the same parser-layer
// decoupling reason as RX_NEOLINE_SUFFIX above.
const RX_REC_SUFFIX = /(?:REC|SOS|PAR)(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-\d+\.mp4$/i;

// Generic fallback: the first plausible YYYYMMDD run anywhere in the name.
const RX_GENERIC_DATE_RUN = /(?:^|\D)(20\d{2})(\d{2})(\d{2})(?=\D|$)/;

/**
 * Returns the first SStar GPS track with uniform supported samples and a
 * coherent first row. Foreign ssmd siblings can share the sample size, so
 * a failed content probe must not hide a later GPS track.
 */
export async function findSstarSsmdTrack(vf: VendorFile, index: Mp4Index): Promise<TrackInfo | null> {
    if (!index.moovView) return null;
    for (const t of index.tracks) {
        if (t.handlerType !== "meta" || t.sampleFormat !== "ssmd") continue;
        const samples = readSampleTable(index.moovView, t.trakBox);
        if (!samples || samples.length === 0) continue;
        const sampleSize = samples[0]!.size;
        if (!isSstarSampleSize(sampleSize)) continue;
        if (!samples.every((s) => s.size === sampleSize)) continue;
        const first = await getFirstSampleOfTrack(index, t, vf);
        if (!first || !looksLikeSstarSsmdSample(new DataView(first.buffer, first.byteOffset, first.byteLength)))
            continue;
        return t;
    }
    return null;
}

function isSstarSampleSize(size: number): boolean {
    return (
        size === SSTAR_SSMD_SAMPLE_SIZE || size === SSTAR_KTRX_SSMD_SAMPLE_SIZE || size === SSTAR_DDMM_SSMD_SAMPLE_SIZE
    );
}

/** True when both coordinate slots carry the 8-byte no-fix sentinel. */
export function hasSstarNoFixSentinel(dv: DataView): boolean {
    if (dv.byteLength < OFF_LON + NO_FIX_COORD_SENTINEL.length) return false;
    for (let i = 0; i < NO_FIX_COORD_SENTINEL.length; i++) {
        if (dv.getUint8(OFF_LAT + i) !== NO_FIX_COORD_SENTINEL[i]) return false;
        if (dv.getUint8(OFF_LON + i) !== NO_FIX_COORD_SENTINEL[i]) return false;
    }
    return true;
}

/** Calendar-field sanity for the day/hour/minute/second quartet. */
function timeBytesValid(day: number, hour: number, minute: number, second: number): boolean {
    return day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59;
}

function asciiDigit(dv: DataView, offset: number): number | null {
    const value = dv.getUint8(offset) - 0x30;
    return value >= 0 && value <= 9 ? value : null;
}

/** Strong content tag for the 56-byte iZEEKER dialect. */
export function hasSstarKtrxTag(dv: DataView): boolean {
    if (dv.byteLength !== SSTAR_KTRX_SSMD_SAMPLE_SIZE) return false;
    for (let i = 0; i < SSTAR_KTRX_ID_LENGTH; i++) {
        const c = dv.getUint8(SSTAR_KTRX_ID_OFFSET + i);
        if (!((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46))) return false;
    }
    if (
        dv.getUint8(SSTAR_KTRX_MARKER_OFFSET) !== 0x4b ||
        dv.getUint8(SSTAR_KTRX_MARKER_OFFSET + 1) !== 0x54 ||
        dv.getUint8(SSTAR_KTRX_MARKER_OFFSET + 2) !== 0x52 ||
        dv.getUint8(SSTAR_KTRX_MARKER_OFFSET + 3) !== 0x58
    ) {
        return false;
    }
    const h0 = asciiDigit(dv, SSTAR_KTRX_CLOCK_OFFSET);
    const h1 = asciiDigit(dv, SSTAR_KTRX_CLOCK_OFFSET + 1);
    const m0 = asciiDigit(dv, SSTAR_KTRX_CLOCK_OFFSET + 2);
    const m1 = asciiDigit(dv, SSTAR_KTRX_CLOCK_OFFSET + 3);
    if (h0 === null || h1 === null || m0 === null || m1 === null) return false;
    return h0 * 10 + h1 === dv.getUint8(OFF_HOUR) && m0 * 10 + m1 === dv.getUint8(OFF_MIN);
}

function decodeKtrxCoordinates(dv: DataView, minute: number, second: number): { lat: number; lon: number } {
    const latFactor = SSTAR_KTRX_FACTORS[second]! / 10;
    const lonFactor = SSTAR_KTRX_FACTORS[minute]! / 10;
    return {
        lat: (dv.getFloat64(OFF_LAT, true) - SSTAR_KTRX_LAT_OFFSET) / latFactor,
        lon: (dv.getFloat64(OFF_LON, true) - SSTAR_KTRX_LON_OFFSET) / lonFactor,
    };
}

/**
 * Content probe for the marker. A 40-byte meta/ssmd sample alone is a weak
 * signature, so the first sample must also carry the constant flags word AND
 * either be a coherent no-fix row (both coordinate sentinels) or decode as a
 * plausible fix (finite in-range degrees, valid time bytes).
 */
export function looksLikeSstarSsmdSample(dv: DataView): boolean {
    if (dv.byteLength === SSTAR_KTRX_SSMD_SAMPLE_SIZE || dv.byteLength === SSTAR_DDMM_SSMD_SAMPLE_SIZE) {
        return decodeSstarSsmdRow(dv) !== null;
    }
    if (dv.byteLength !== SSTAR_SSMD_SAMPLE_SIZE) return false;
    const cls = classifySstarFlagsWord(dv.getUint16(OFF_FLAGS, true));
    if (cls === "nofix") return hasSstarNoFixSentinel(dv);
    if (cls !== "fix") return false;
    const lat = dv.getFloat64(OFF_LAT, true);
    const lon = dv.getFloat64(OFF_LON, true);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return false;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) return false;
    return timeBytesValid(dv.getUint8(OFF_DAY), dv.getUint8(OFF_HOUR), dv.getUint8(OFF_MIN), dv.getUint8(OFF_SEC));
}

/**
 * Extracts the year/month anchor from a filename carrying a YYYYMMDD run
 * (Neoline: INF20260520-134803-14-F.mp4). The date is in CAMERA-LOCAL time -
 * that is fine, because it is only used as a +/-1-day anchor for the
 * records' UTC day-of-month, never as a TZ statement. The strict Neoline
 * shape wins over the generic scan: a user-renamed copy can carry a foreign
 * date run BEFORE the original name, and anchoring on it would either drop
 * every record (day-of-month never matches) or, worse, stamp them with a
 * wrong year/month as synced time. Returns the UTC midnight of that
 * calendar date in ms, or null when no plausible date run exists.
 */
export function localDateAnchorMsFromFilename(name: string): number | null {
    const m = RX_NEOLINE_SUFFIX.exec(name) ?? RX_REC_SUFFIX.exec(name) ?? RX_GENERIC_DATE_RUN.exec(name);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (!isDashcamYear(year)) return null;
    return utcMillisecondsFromParts(year, month, day, 0, 0, 0);
}

/**
 * Resolves a record's full UTC timestamp from the date anchor plus the
 * record's own UTC day-of-month and time. Invariant that makes this sound:
 * a clip is minutes long and |TZ| <= 14 h, so the record's true UTC date is
 * within one calendar day of the anchor date. Trying anchor-1/anchor/anchor+1
 * and matching day-of-month therefore has exactly one hit, and the Date
 * arithmetic carries month/year rollover for free (local May 1st with UTC
 * still on April 30th, New Year's Eve, leap Februaries). Returns unix ms, or
 * null when no candidate matches (record day byte inconsistent with the
 * anchor - corrupt row or a wrong anchor).
 */
export function utcMsFromAnchoredDayTime(
    anchorDayMs: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
): number | null {
    for (const shift of [-1, 0, 1]) {
        const candidate = new Date(anchorDayMs + shift * DAY_MS);
        if (candidate.getUTCDate() !== day) continue;
        return utcMillisecondsFromParts(
            candidate.getUTCFullYear(),
            candidate.getUTCMonth() + 1,
            day,
            hour,
            minute,
            second,
        );
    }
    return null;
}

/**
 * Full camera-local naive time from the strict Neoline filename shape, as
 * seconds on the Date.UTC axis (a NAIVE value - the camera TZ is unknown; it
 * is only ever compared against GPS UTC modulo the 15-min TZ grid). null when
 * the name does not match, e.g. a renamed copy - the stale-clock gate is then
 * unavailable and the GPS clock is trusted as before.
 */
export function localNaiveSecondsFromNeolineFilename(name: string): number | null {
    return localNaiveSecondsFromMatch(RX_NEOLINE_SUFFIX.exec(name));
}

/** Camera-local naive time from the shared REC filename shape. */
export function localNaiveSecondsFromRecFilename(name: string): number | null {
    return localNaiveSecondsFromMatch(RX_REC_SUFFIX.exec(name));
}

function localNaiveSecondsFromMatch(m: RegExpExecArray | null): number | null {
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = Number(h);
    const minute = Number(mi);
    const second = Number(s);
    if (!isDashcamYear(year)) return null;
    const timestampMs = utcMillisecondsFromParts(year, month, day, hour, minute, second);
    return timestampMs === null ? null : timestampMs / 1000;
}

/** Distance from a seconds value to the nearest 15-min TZ grid point. */
function distanceToTzGrid(deltaSec: number): number {
    const mod = ((deltaSec % TZ_GRID_S) + TZ_GRID_S) % TZ_GRID_S;
    return Math.min(mod, TZ_GRID_S - mod);
}

/** Decoded fields of one fix row - see decodeSstarSsmdRow. */
export interface SstarSsmdFix {
    lat: number;
    lon: number;
    speedMs: number;
    /** Raw course reading; 0 doubles as "not updated" - the extractor
     *  forward-fills it from the previous emitted record. */
    bearingDeg: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

/**
 * Decodes one supported SStar sample. Returns:
 *   - "nofix" for a no-fix row (no-fix flags word or the coordinate
 *     sentinel) - routine satellite acquisition, skipped silently;
 *   - null for an implausible row (foreign flags word, non-finite or
 *     out-of-range degrees, bad time bytes) - alien content or corruption;
 *   - the decoded fields otherwise. The caller assembles the GpsRecord -
 *     absolute-time resolution depends on per-file state.
 */
export function decodeSstarSsmdRow(dv: DataView): SstarSsmdFix | "nofix" | null {
    const isKtrx = dv.byteLength === SSTAR_KTRX_SSMD_SAMPLE_SIZE;
    const isDdmm = dv.byteLength === SSTAR_DDMM_SSMD_SAMPLE_SIZE;
    if (!isSstarSampleSize(dv.byteLength)) return null;

    if (isDdmm) {
        const flags = dv.getUint16(OFF_FLAGS, true);
        if (flags !== SSTAR_DDMM_FLAGS_FIX && flags !== SSTAR_DDMM_FLAGS_NO_FIX) return null;
        if (hasSstarNoFixSentinel(dv)) return "nofix";
        if (flags === SSTAR_DDMM_FLAGS_NO_FIX) return null;
    } else if (isKtrx) {
        if (!hasSstarKtrxTag(dv) || dv.getUint16(OFF_FLAGS, true) !== SSTAR_KTRX_FLAGS_FIX) return null;
        if (hasSstarNoFixSentinel(dv)) return "nofix";
    } else {
        const cls = classifySstarFlagsWord(dv.getUint16(OFF_FLAGS, true));
        if (cls === "nofix" || hasSstarNoFixSentinel(dv)) return "nofix";
        if (cls !== "fix") return null;
    }

    const day = dv.getUint8(OFF_DAY);
    const hour = dv.getUint8(OFF_HOUR);
    const minute = dv.getUint8(OFF_MIN);
    const second = dv.getUint8(OFF_SEC);
    if (!timeBytesValid(day, hour, minute, second)) return null;

    const coords = isKtrx
        ? decodeKtrxCoordinates(dv, minute, second)
        : { lat: dv.getFloat64(OFF_LAT, true), lon: dv.getFloat64(OFF_LON, true) };
    const lat = isDdmm ? ddmmToDegrees(coords.lat) : coords.lat;
    const lon = isDdmm ? ddmmToDegrees(coords.lon) : coords.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    // Zeros mean an empty fix - same convention as the other embedded decoders.
    if (lat === 0 && lon === 0) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

    // 0xFFFF is the no-fix filler; on a flagged fix row treat it as "speed
    // unknown" rather than dropping an otherwise valid coordinate.
    const speedRaw = dv.getUint16(OFF_SPEED, true);
    const speedMs = speedRaw === SPEED_INVALID ? 0 : speedRaw * KMH_TO_MS;

    // 2-degree units; 0 doubles as "not updated" (observed on moving rows).
    // The raw 0 is kept here; the extractor forward-fills it from the
    // previous emitted record so a stale course never snaps to due north.
    const courseRaw = dv.getUint8(OFF_COURSE);
    const bearingDeg = courseRaw > COURSE_RAW_MAX ? 0 : courseRaw * 2;

    return { lat, lon, speedMs, bearingDeg, day, hour, minute, second };
}

/** A decoded fix awaiting emission, with its resolved time for the
 *  cold-start post-pass. `utcMs` is set only on the anchored path. */
interface ResolvedFix {
    sampleIndex: number;
    fix: SstarSsmdFix;
    /** Seconds on a monotonic-if-synced axis: unix seconds when anchored,
     *  clock-derived relative seconds otherwise. Only compared, never shown. */
    resolvedSeconds: number;
    utcMs: number | null;
}

/**
 * Extracts GPS from a supported SStar ssmd track. No-fix rows are skipped
 * silently (routine during satellite acquisition; their time bytes are the
 * local RTC, not UTC - never trusted). Fix rows resolve to absolute UTC via
 * the filename date anchor (falling back to mvhd creation when the filename
 * carries no date). With no anchor - or when an anchor exists but EVERY fix
 * fails its day-of-month match, i.e. the anchor is a foreign date run in a
 * renamed file and must not be trusted - the records are emitted as
 * timeUnsynced with relStartSeconds taken from the track's media time, so
 * the time layer can re-anchor them onto the video window.
 *
 * Returns null when nothing in the track confirms the format (zero decoded
 * fixes AND zero no-fix rows); a no-fix-only track returns empty records
 * ("matches the format, carries no GPS"), per the Primitive contract. A file
 * caught by the phantom-track gate also returns empty records but KEEPS the
 * videoStartUtcHint - the registry treats that combination as a positive
 * claim, so the skip diagnostics and the frame-0 clock anchor survive while
 * the fabricated positions/speeds do not.
 */
export async function extractFromSstarSsmdTrack(
    vf: VendorFile,
    index: Mp4Index,
    track: TrackInfo,
): Promise<ParsedRecords | null> {
    if (!index.moovView) return null;
    const samples = readSampleTable(index.moovView, track.trakBox);
    if (!samples || samples.length === 0) return null;
    // Re-assert the constant size (cheap) - the caller normally got the track
    // from findSstarSsmdTrack, but extract must not misread a foreign track.
    const sampleSize = samples[0]!.size;
    if (!isSstarSampleSize(sampleSize)) return null;
    if (!samples.every((s) => s.size === sampleSize)) return null;

    const sampleBuffers = await loadSamples(vf.file, samples, index.sliceCost);
    const skipped: SkippedLine[] = [];
    const fixes: { sampleIndex: number; fix: SstarSsmdFix }[] = [];
    let noFixCount = 0;

    for (let i = 0; i < sampleBuffers.length; i++) {
        const buf = sampleBuffers[i];
        if (!buf) continue;
        const row = decodeSstarSsmdRow(new DataView(buf));
        if (row === "nofix") {
            noFixCount++;
            continue;
        }
        if (row === null) {
            // A non-no-fix sample that fails plausibility is NOT routine for
            // this format - keep a diagnostic trace per sample.
            skipped.push({
                line: i + 1,
                raw: `<sstar-ssmd sample ${i + 1}>`,
                reason: "implausible sstar ssmd record",
            });
            continue;
        }
        fixes.push({ sampleIndex: i, fix: row });
    }

    if (fixes.length === 0 && noFixCount === 0) return null;

    // Anchored time resolution. When SOME rows resolve, the ones that do not
    // are corrupt rows - skipped individually. When NONE resolve, the anchor
    // itself is wrong (a foreign date run in a renamed file) - fall through
    // to the unsynced path instead of silently dropping the whole track.
    const anchorDayMs = localDateAnchorMsFromFilename(vf.file.name) ?? mvhdDateAnchorMs(index);
    let resolved: ResolvedFix[] | null = null;
    if (anchorDayMs !== null && fixes.length > 0) {
        const ok: ResolvedFix[] = [];
        const unmatched: typeof fixes = [];
        for (const f of fixes) {
            const utcMs = utcMsFromAnchoredDayTime(anchorDayMs, f.fix.day, f.fix.hour, f.fix.minute, f.fix.second);
            if (utcMs === null) unmatched.push(f);
            else ok.push({ ...f, resolvedSeconds: utcMs / 1000, utcMs });
        }
        if (ok.length > 0) {
            resolved = ok;
            for (const f of unmatched) {
                skipped.push({
                    line: f.sampleIndex + 1,
                    raw: `<sstar-ssmd sample ${f.sampleIndex + 1}>`,
                    reason: "record day-of-month does not match the date anchor",
                });
            }
        }
    }

    // Unsynced path: no usable anchor. The cold-start scan still needs a
    // resolved time per fix, so derive relative seconds from the record clock
    // itself; a day-byte change mid-clip is one midnight crossing (clips are
    // minutes long), regardless of what value the day wraps to at month end.
    if (resolved === null) {
        let dayOffsetSeconds = 0;
        let prevDay: number | null = null;
        resolved = fixes.map((f) => {
            if (prevDay !== null && f.fix.day !== prevDay) dayOffsetSeconds += DAY_MS / 1000;
            prevDay = f.fix.day;
            const secondsOfDay = f.fix.hour * 3600 + f.fix.minute * 60 + f.fix.second;
            return { ...f, resolvedSeconds: dayOffsetSeconds + secondsOfDay, utcMs: null };
        });
    }

    // Media-time position of every sample, from the stts table. All paths need
    // it: the unsynced path spaces its records by media time (relStartSeconds),
    // the pre-sync anomaly scan compares clock steps against media steps, and
    // the anchored path ties wall-clock to frame 0 via the first emitted
    // sample's media offset (videoStartUtcHint below). Cheap stts walk.
    let mediaStartSeconds: number[] | null = null;
    {
        const timescale = readMediaTimescale(index.moovView, track.trakBox);
        const startTicks = readSampleStartsInTicks(index.moovView, track.trakBox);
        if (timescale && timescale > 0 && startTicks) {
            mediaStartSeconds = startTicks.map((t) => t / timescale);
        }
    }

    // Cold-start pre-sync drop. Invariant that makes the scan sound: a synced
    // GPS clock advances WITH media time (a fix gap advances both deltas
    // equally), and both rollover handlers (utcMsFromAnchoredDayTime and the
    // day-byte carry above) only step time FORWARD. So a clock step that
    // deviates from the elapsed media time beyond jitter can only be the
    // firmware's clock locking onto satellite time: backward when the
    // pre-sync clock ran AHEAD (observed ~90-105 s), a forward excess when it
    // ran BEHIND (observed ~104 s). Rows before the LAST such step carry the
    // pre-sync clock (and, on cold boots, positions tens of km off) and are
    // skipped rather than emitted. Without media times only the backward arm
    // is decidable (a forward excess is indistinguishable from a fix gap).
    let firstSyncedIdx = 0;
    for (let i = 1; i < resolved.length; i++) {
        const clockDelta = resolved[i]!.resolvedSeconds - resolved[i - 1]!.resolvedSeconds;
        const prevMedia = mediaStartSeconds?.[resolved[i - 1]!.sampleIndex];
        const curMedia = mediaStartSeconds?.[resolved[i]!.sampleIndex];
        const anomalous =
            prevMedia !== undefined && curMedia !== undefined
                ? Math.abs(clockDelta - (curMedia - prevMedia)) > COLD_START_BACKWARD_JUMP_S
                : clockDelta < -COLD_START_BACKWARD_JUMP_S;
        if (anomalous) firstSyncedIdx = i;
    }
    for (const f of resolved.slice(0, firstSyncedIdx)) {
        skipped.push({
            line: f.sampleIndex + 1,
            raw: `<sstar-ssmd sample ${f.sampleIndex + 1}>`,
            reason: "cold-start pre-sync row, clock stepped on sync",
        });
    }

    // Stale-clock gate (see the header). The GPS clock can be tens of seconds
    // behind real time with no resync inside the clip - undetectable from the
    // records alone. Cross-check against the camera RTC via the filename:
    // (filename local time - clip-start UTC implied by the LAST emitted fix)
    // must be a TZ offset, i.e. sit on the 15-min grid within the RTC drift
    // tolerance. Off-grid means the fix clock and the RTC disagree beyond any
    // real TZ - the GPS clock is stale, so every fix is demoted to the
    // unsynced path: positions and media offsets are kept, the absolute times
    // (and the videoStartUtcHint) are dropped, and the time layer re-anchors
    // the file from the filename/run-offset machinery instead. The LAST fix
    // is used because the anomaly scan above already trimmed everything
    // before the last clock step - the tail is the most-synced stretch.
    let anchored = resolved.some((f) => f.utcMs !== null);
    if (anchored && mediaStartSeconds) {
        const nameNaive =
            sampleSize === SSTAR_SSMD_SAMPLE_SIZE
                ? localNaiveSecondsFromNeolineFilename(vf.file.name)
                : localNaiveSecondsFromRecFilename(vf.file.name);
        const lastFix = resolved[resolved.length - 1];
        const lastMedia = lastFix ? mediaStartSeconds[lastFix.sampleIndex] : undefined;
        if (nameNaive !== null && lastFix?.utcMs != null && lastMedia !== undefined) {
            const impliedStartUtc = lastFix.utcMs / 1000 - lastMedia;
            if (distanceToTzGrid(nameNaive - impliedStartUtc) > STALE_CLOCK_GRID_TOLERANCE_S) {
                anchored = false;
                for (const f of resolved) f.utcMs = null;
            }
        }
    }

    const emitted = resolved.slice(firstSyncedIdx);

    // Tie absolute wall-clock to video frame 0, RVMI-style. The first EMITTED
    // fix (post cold-start) carries an accurate GPS-clock UTC and sits at a known
    // media time, so frame 0 = its UTC minus that media offset. This lets
    // deriveStartUtc anchor on the record's own clock (source "embedded") instead
    // of the filename-clock offset - which, on a lone Neoline clip with no mvhd,
    // is inherited from another recording session and can be tens of seconds
    // stale after an RTC resync, lagging the whole map behind the video by that
    // error. Only on the anchored path (unsynced records have no real UTC) and
    // only when the media time is known. Computed before the phantom gate: a
    // gated file keeps the hint - the gate condemns positions and speeds, not
    // the clock (the stale-clock gate above owns clock trust).
    let videoStartUtcHint: number | undefined;
    if (anchored && mediaStartSeconds) {
        const firstEmitted = emitted[0];
        const mediaSec = firstEmitted ? mediaStartSeconds[firstEmitted.sampleIndex] : undefined;
        if (firstEmitted?.utcMs != null && mediaSec !== undefined) {
            videoStartUtcHint = firstEmitted.utcMs / 1000 - mediaSec;
        }
    }

    // Phantom-track gate (constants and rationale at the top of the file).
    if (noFixCount / (noFixCount + fixes.length) >= PHANTOM_MIN_NOFIX_SHARE) {
        let pairs = 0;
        let violations = 0;
        for (let i = 1; i < emitted.length; i++) {
            const a = emitted[i - 1]!;
            const b = emitted[i]!;
            // Media time when available (immune to clock quirks); the
            // clock-derived axis is the fallback for a table-less track.
            const ta = mediaStartSeconds?.[a.sampleIndex] ?? a.resolvedSeconds;
            const tb = mediaStartSeconds?.[b.sampleIndex] ?? b.resolvedSeconds;
            const dt = tb - ta;
            if (dt <= 0 || dt > PHANTOM_MAX_PAIR_GAP_S) continue;
            pairs++;
            const impliedKmh = ((haversineKm(a.fix.lat, a.fix.lon, b.fix.lat, b.fix.lon) * 1000) / dt) * 3.6;
            const claimedKmh = Math.max(a.fix.speedMs, b.fix.speedMs) / KMH_TO_MS;
            if (Math.abs(impliedKmh - claimedKmh) > PHANTOM_SPEED_MISMATCH_KMH) violations++;
        }
        if (
            pairs >= PHANTOM_MIN_PAIRS &&
            violations >= PHANTOM_MIN_VIOLATIONS &&
            violations / pairs >= PHANTOM_MIN_VIOLATION_SHARE
        ) {
            for (const f of emitted) {
                skipped.push({
                    line: f.sampleIndex + 1,
                    raw: `<sstar-ssmd sample ${f.sampleIndex + 1}>`,
                    reason: "phantom-track quality gate: weak-signal fixes with fabricated motion",
                });
            }
            skipped.sort((a, b) => a.line - b.line);
            return { records: [], skipped, videoStartUtcHint };
        }
    }

    const records: GpsRecord[] = [];
    let lastBearingDeg = 0;
    for (const f of emitted) {
        // Course 0 means "not updated by the firmware" (observed on
        // clearly-moving rows) - carry the previous emitted bearing forward
        // instead of snapping the map marker to due north mid-drive; 0 stays
        // only when no prior bearing exists.
        const bearingDeg = f.fix.bearingDeg === 0 ? lastBearingDeg : f.fix.bearingDeg;
        lastBearingDeg = bearingDeg;

        const base: GpsRecord = {
            unixSeconds: 0,
            active: true,
            lat: f.fix.lat,
            lon: f.fix.lon,
            bearingDeg,
            speedMs: f.fix.speedMs,
            // Motion telemetry lives in the separate 12-byte ssmd track,
            // which stays undeciphered - see the doc.
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: vf.file.name,
        };
        if (f.utcMs !== null) {
            base.unixSeconds = f.utcMs / 1000;
        } else {
            base.timeUnsynced = true;
            if (mediaStartSeconds && mediaStartSeconds[f.sampleIndex] !== undefined) {
                base.relStartSeconds = mediaStartSeconds[f.sampleIndex];
            }
        }
        records.push(base);
    }

    // The multi-pass flow above appends diagnostics out of sample order -
    // restore it so the skip list reads like the file.
    skipped.sort((a, b) => a.line - b.line);
    return { records, skipped, videoStartUtcHint };
}

/**
 * mvhd creation date as a UTC-midnight anchor. Untested fallback in this
 * firmware family (every real Neoline sample writes creation_time = 0, so
 * Mp4Index yields null) - kept because the +/-1-day matching makes even a
 * local-time mvhd safe, and a renamed file otherwise loses wall-clock time.
 */
function mvhdDateAnchorMs(index: Mp4Index): number | null {
    if (!index.createdUtc) return null;
    const d = index.createdUtc;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

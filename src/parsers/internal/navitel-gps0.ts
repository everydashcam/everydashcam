import { wrapDegrees } from "../../coordinates.js";
import { matchesBytesAt } from "./byte-search.js";
// Extractor for the `gps0` tail atom (Navitel R-series and compatible
// Ambarella-tail firmware). Format-agnostic utility wrapped by the
// navitel-tail primitive.
//
// Tail atom layout (top-level boxes after moov):
//
//   IDIT  size + 'IDIT' + 20-byte ASCIIZ "YYYY-MM-DD HH:MM:SS" + trailing 0x00
//         Local recording-start time (camera TZ, not UTC). gps0 records carry
//         their own year/month (bytes 22-23); IDIT year+month is only the
//         fallback baseline for firmware that zero-fills those bytes.
//
//   gpsa  size + 'gpsa' + 4 bytes flags/record-size (not parsed in v1)
//
//   gps0  size + 'gps0' + N × 32-byte records
//         Each record (LE), layout per ExifTool QuickTimeStream.pl
//         Process_gps0 (DuDuBell M1 / VSYS M6L family), field-by-field
//         verified on real samples (Navitel R600-1, iBOX iCON, the .TS
//         motorcycle cam):
//           [0..7]   double lat in NMEA format `DDmm.mmmm`
//                      DD = floor(value/100), minutes = value % 100
//           [8..15]  double lon in NMEA format `DDDmm.mmmm`
//           [16..19] i32 altitude, metres (slow drift 128..158 on real
//                      samples; GpsRecord has no altitude field - not
//                      extracted, documented so nobody re-misreads it)
//           [20..21] u16 speed - UNIT VARIES BY FIRMWARE: km/h on the
//                      Navitel R600-1 / iBOX iCON samples (matches
//                      haversine), KNOTS on the .TS motorcycle cam
//                      (haversine ratio 1.87 across 7 files AND the
//                      burned-in OSD: field 25 while OSD says 46 km/h =
//                      25 kn). No byte-level discriminator found (gpsa
//                      flags not preserved for the km/h samples), so the
//                      unit is calibrated per file against the trajectory
//                      - see calibrateGps0SpeedAndCourse. (The PRE-FIX
//                      parser misread the altitude bytes at 16 as speed -
//                      constant ~14 km/h.)
//           [22]     u8 year - 2000
//           [23]     u8 month 1..12 (so records are self-describing; the
//                      IDIT baseline below stays as fallback for firmware
//                      that zero-fills these two bytes)
//           [24]     u8 day-of-month
//           [25]     u8 hour (UTC, not TZ - confirmed by IDIT comparison)
//           [26]     u8 minute
//           [27]     u8 second
//           [28]     u8 course - ENCODING VARIES BY FIRMWARE: course/2
//                      (ExifTool's reading, marked "NC") on the R600-1 /
//                      iBOX samples, but the LOW BYTE of the full course
//                      (mod 256, the u16-to-u8 cast loses the high bit) on
//                      the .TS motorcycle cam: raw byte tracks the
//                      trajectory bearing within ~1 deg median, and NW
//                      headings alias (269 deg stored as 13). Calibrated
//                      per file against the trajectory alongside speed.
//           [29..31] constant 0x01 0x01 0x00 (undecoded per ExifTool; NOT
//                      a course high byte - stays 0x01 0x01 0x00 on the
//                      mod-256 firmware at all headings)
//
//   gsea + gsen - g-sensor tail atoms. gsen is parsed (parseGsenAtom); the
//                 known local sample carries 0 records, so the decode itself
//                 is upstream-derived only.
//
// Hemisphere/direction: the known sample has positive doubles (Russia, northern
// hemisphere, eastern longitude). No direction-letter field was found - assuming
// negative values = S/W (signed DDmm.mmmm convention). Verify on S/W samples
// if they appear.

import { fillForwardBearings, haversineKm } from "../../parser.js";
import { KMH_TO_MS, KNOTS_TO_MS } from "../types.js";
import type { AccelSample, GpsRecord, ParsedRecords, SkippedLine } from "../types.js";
import { isDashcamYear, utcMillisecondsFromParts } from "./calendar.js";
import { ddmmToDegrees, isCoordinateInRange } from "./ddmm.js";
import { removeGravityBaselineOrZero } from "./accel-baseline.js";
import { decodeXorAsciiGpsText, decryptXorAscii } from "./xor-ascii-gps.js";

// ===== gsen g-sensor atom (ExifTool Process_gsen) =====
//
// 3-byte records, one signed byte per axis, each divided by 16. The records
// carry NO timestamps of any kind; upstream notes its test video sampled them
// at 5 Hz, which is the only cadence anyone has observed.
//
// That 5 Hz is therefore assumed, not read - and the assumption is made in the
// safe direction. Pacing by a fixed rate means a clip recorded at some other
// rate runs long and its tail simply lands past the video window, where
// mergeAccelSamples finds no record to attach to and drops it. Pacing by
// duration/count instead (stretching the samples to fit) would keep every
// sample but move them onto the WRONG seconds, inventing braking where there
// was none. Losing a tail beats fabricating an event.
//
// Gravity is left in: mergeAccelSamples removes the per-file per-axis mean.
//
// Implemented from foreign source (ExifTool 13.55 QuickTimeStream.pl:2769-2790),
// not validated against a real sample - the local one's gsen atom is empty.
const GSEN_RECORD_SIZE = 3;
const GSEN_SCALE = 16;
const GSEN_SAMPLE_INTERVAL_MS = 200; // 5 Hz

/**
 * Decodes the `gsen` atom (8-byte box header included) into accelerometer
 * samples paced at the assumed 5 Hz. Returns an empty array when the atom
 * holds no complete record - the known real sample's case.
 */
export function parseGsenAtom(gsenBytes: Uint8Array): AccelSample[] {
    const payloadStart = 8;
    if (gsenBytes.byteLength <= payloadStart) return [];
    const dv = new DataView(gsenBytes.buffer, gsenBytes.byteOffset, gsenBytes.byteLength);
    const count = Math.floor((gsenBytes.byteLength - payloadStart) / GSEN_RECORD_SIZE);

    const samples: AccelSample[] = [];
    for (let i = 0; i < count; i++) {
        const at = payloadStart + i * GSEN_RECORD_SIZE;
        samples.push({
            msSinceStart: i * GSEN_SAMPLE_INTERVAL_MS,
            accelXg: dv.getInt8(at) / GSEN_SCALE,
            accelYg: dv.getInt8(at + 1) / GSEN_SCALE,
            accelZg: dv.getInt8(at + 2) / GSEN_SCALE,
        });
    }
    return samples;
}

// Size of one gps0 record (after the 8-byte atom header).
const GPS0_RECORD_SIZE = 32;

// How many leading records the IDIT-less marker probe inspects. Cold-start
// records can be fully zero-filled (no fix, no date), so a record-0-only probe
// would reject a parseable file; 8 records (256 B + header) is a cheap slice
// that covers a realistic cold-start prefix.
const GPS0_DATE_PROBE_RECORDS = 8;

// Byte length the marker needs to slice for gps0HasSelfDescribedDates.
export const GPS0_DATE_PROBE_BYTES = 8 + GPS0_DATE_PROBE_RECORDS * GPS0_RECORD_SIZE;

/**
 * Plausibility check for the in-record date bytes (22 = year-2000, 23 = month).
 * Mirrors recordDateValid in decodeGps0Record except year 0 is excluded: a
 * zero year byte cannot be told apart from a blank (zero-filled) byte, and no
 * dashcam recorded in year 2000.
 */
function isPlausibleRecordDate(yearByte: number, monthByte: number): boolean {
    return monthByte >= 1 && monthByte <= 12 && yearByte >= 1 && yearByte <= 99;
}

/**
 * True when any of the first GPS0_DATE_PROBE_RECORDS complete records in the
 * gps0 atom bytes (8-byte box header included) carries a plausible
 * self-described date. The navitel-tail marker uses this to accept files
 * whose gps0 atom comes WITHOUT an IDIT baseline - the records then must
 * date themselves (see the IDIT-less path in parseNavitelTail).
 */
export function gps0HasSelfDescribedDates(gps0Bytes: Uint8Array): boolean {
    const payloadStart = 8;
    const completeRecords = Math.floor((gps0Bytes.byteLength - payloadStart) / GPS0_RECORD_SIZE);
    const probeCount = Math.min(GPS0_DATE_PROBE_RECORDS, completeRecords);
    for (let i = 0; i < probeCount; i++) {
        const off = payloadStart + i * GPS0_RECORD_SIZE;
        const yearByte = gps0Bytes[off + 22]!;
        const monthByte = gps0Bytes[off + 23]!;
        if (isPlausibleRecordDate(yearByte, monthByte)) return true;
    }
    return false;
}

// Stale-row glitch filter. The real iBOX iCON sample interleaves the valid
// 1 Hz track with firmware ring-buffer leftovers every ~8-10 rows (a third of
// the file): full-stale rows (timestamp ~1 min in the past + position from
// the already-driven path) and half-stale rows (fresh timestamp, stale
// position ~800 m back). Two passes:
//   A) backward time steps - on a conflict (a row older than the last kept
//      one) the side that disagrees with the FOLLOWING row's timeline is
//      dropped. Usually that is the backward row itself (a buffered stale
//      row from the past), but not always: the .TS motorcycle cam stamps the
//      FIRST fix row of a cold start with the camera-local RTC clock and
//      only the rows after it with satellite UTC, so the first kept row sits
//      hours in the future and a keep-max greedy pass would discard the
//      entire remaining track. Continuity with the next row tells the two
//      cases apart;
//   B) isolated position outliers - a row whose implied speed from the last
//      kept fix is impossible AND whose removal restores continuity to the
//      next row. The continuity check protects legitimate teleports (GPS
//      re-acquisition after a tunnel has a large dt, so implied speed stays
//      plausible).
// 100 m/s = 360 km/h - no dashcam-bearing vehicle reaches it.
const GLITCH_MAX_IMPLIED_SPEED_MS = 100;

// IDIT payload: 19-byte date string + trailing nulls.
const IDIT_DATE_LEN = 19; // "YYYY-MM-DD HH:MM:SS"

export interface IditDate {
    year: number;
    month: number; // 1..12
    day: number;
    hour: number;
    minute: number;
    second: number;
}

/**
 * Parses the IDIT payload (local recording-start time, camera TZ) as a full
 * date. Returns null if the payload does not look like "YYYY-MM-DD HH:MM:SS".
 * The parsed year+month serve as the FALLBACK baseline for records whose own
 * date bytes (22-23) are zero-filled, including the month/year rollover if
 * the recording crosses a UTC month boundary.
 */
export function parseIditDate(payload: Uint8Array): IditDate | null {
    if (payload.byteLength < IDIT_DATE_LEN) return null;
    // Read first 19 bytes as ASCII; the rest is padding/null-terminator.
    let text = "";
    for (let i = 0; i < IDIT_DATE_LEN; i++) {
        const c = payload[i]!;
        if (c === 0) break;
        text += String.fromCharCode(c);
    }
    const m = text.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = Number(m[6]);
    if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
    if (!isDashcamYear(year)) return null;
    if (utcMillisecondsFromParts(year, month, day, hour, minute, second) === null) return null;
    return { year, month, day, hour, minute, second };
}

/**
 * Decodes one 32-byte gps0 record into a GpsRecord. Year/month are read from
 * the record itself (bytes 22-23); baselineYear/Month from IDIT are used only
 * when the in-record month byte is out of range (defensive fallback for
 * firmware that zero-fills those bytes). Returns null for an empty fix
 * (lat=0 && lon=0) or corrupt data (out-of-range coordinates, NaN double).
 *
 * speedMs and bearingDeg are PROVISIONAL: the km/h + course/2 reading. Speed
 * unit and course encoding vary by firmware (see the layout comment above);
 * parseNavitelTail re-derives both via calibrateGps0SpeedAndCourse from the
 * raw field values once the whole track is available.
 */
export function decodeGps0Record(
    view: DataView,
    offset: number,
    baselineYear: number,
    baselineMonth: number,
    mp4Filename: string,
): GpsRecord | null {
    const latRaw = view.getFloat64(offset, true);
    const lonRaw = view.getFloat64(offset + 8, true);
    if (!Number.isFinite(latRaw) || !Number.isFinite(lonRaw)) return null;
    if (latRaw === 0 && lonRaw === 0) return null;

    const lat = ddmmToDegrees(latRaw);
    const lon = ddmmToDegrees(lonRaw);
    if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) return null;

    // bytes 16..19 = altitude i32 (metres) - GpsRecord has no altitude field,
    // intentionally not extracted.
    const speedKmh = view.getUint16(offset + 20, true);

    const yearByte = view.getUint8(offset + 22);
    const monthByte = view.getUint8(offset + 23);
    const day = view.getUint8(offset + 24);
    const hour = view.getUint8(offset + 25);
    const minute = view.getUint8(offset + 26);
    const second = view.getUint8(offset + 27);
    const courseByte = view.getUint8(offset + 28);
    // bytes 29..31 - constant 0x01 0x01 0x00, not validated.

    if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;

    // Prefer the in-record year/month (verified on both real samples: 20/11
    // matches IDIT 2020-11, 23/4 matches 2023-04). Fall back to the
    // IDIT-calibrated baseline when the month byte is implausible.
    const recordDateValid = monthByte >= 1 && monthByte <= 12 && yearByte <= 99;
    const year = recordDateValid ? 2000 + yearByte : baselineYear;
    const month = recordDateValid ? monthByte : baselineMonth;

    // UTC: date/time fields are real UTC (verified on sample: IDIT=16:30:14
    // local MSK, first record = 13:30:15 UTC).
    const baseMs = utcMillisecondsFromParts(year, month, day, hour, minute, second);
    if (baseMs === null) return null;

    // Provisional course/2 reading. >= 180 raw would mean >= 360 deg under
    // this encoding - treat as "no course"; the calibration pass in
    // parseNavitelTail decides whether the byte is actually halved or the
    // low byte of the full course.
    const bearingDeg = courseByte < 180 ? courseByte * 2 : 0;

    return {
        unixSeconds: baseMs / 1000,
        active: true,
        lat,
        lon,
        bearingDeg,
        speedMs: speedKmh * KMH_TO_MS,
        // gps0 has no acceleration (gsen tail atom is separate and empty on the
        // known sample); 0/0/0 means "no measurement".
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename,
    };
}

/**
 * Parses the gps0 atom (+ optional IDIT) into GpsRecord array. Receives
 * pre-read bytes (caller fetched them via sparse reads using Mp4Index
 * offsets); both include the size+type box header.
 *
 * Two time-base modes:
 *   - iditBytes present: IDIT year/month is the fallback baseline for records
 *     with zero-filled date bytes (the original, real-validated path: Navitel
 *     R600-1, iBOX iCON both carry IDIT). Returns null if IDIT is corrupt.
 *   - iditBytes === null: IDIT-less mode. Records MUST self-describe their
 *     date (bytes 22-23); records with blank date bytes are skipped (normal
 *     during GPS cold start). Implemented from foreign source (ExifTool 13.59
 *     QuickTimeStream.pl:2715-2745 Process_gps0 has no IDIT requirement), NOT
 *     validated against a real sample - n=0 real IDIT-less files seen so far;
 *     "DuDuBell M1 / VSYS M6L lack IDIT" is inferred from upstream's IDIT-free
 *     processing, not byte-verified. If a real IDIT-less file turns out to
 *     have blank in-record dates, it is rejected here (never misparsed).
 */
export function parseNavitelTail(
    iditBytes: Uint8Array | null,
    gps0Bytes: Uint8Array,
    mp4Filename: string,
): ParsedRecords | null {
    // gps0: first 8 bytes are the box header; the rest is 32-byte records.
    if (gps0Bytes.byteLength < 8 + GPS0_RECORD_SIZE) return null;
    const payloadStart = 8;
    const payloadLen = gps0Bytes.byteLength - payloadStart;

    // Foreign-dialect bail-outs run BEFORE the IDIT branch on purpose: both
    // dialects can carry valid-looking bytes at offsets 22-23 of their first
    // 32 bytes (Miltona's committed test record has 0x15 0x0c there), so they
    // pass the IDIT-less marker probe and must be rejected here.
    //
    // A DIFFERENT `gps0` dialect exists in the wild (Miltona MNCD60,
    // NovaTek-family): 56-byte records with scrambled f64 coordinates and a
    // `3c 99 a7 3a` framing magic at offset 44 of every record. Parsing it
    // with a 32-byte stride would misalign and risk garbage records, and the
    // coordinate encoding is not cracked (a per-clip linear fit exists in
    // trip-viewer, but the constants are location-bound) - recognize-and-bail.
    if (isMiltonaGps0Dialect(gps0Bytes, payloadStart)) return null;
    // Lamax S9 writes yet another gps0 dialect: XOR-0xAA encrypted text in
    // 311-byte records. Same payload format as the Azdome freeGPS blocks and
    // the Rove gpmd track, so it decodes through the shared helper instead of
    // the 32-byte stride below.
    if (isLamaxS9Gps0Dialect(gps0Bytes, payloadStart)) {
        return parseLamaxS9Gps0(gps0Bytes, payloadStart, mp4Filename);
    }

    // IDIT: first 8 bytes are the box header (size+'IDIT'); payload is the
    // date string. null = IDIT-less mode (see the contract above). An IDIT
    // that is present but corrupt still rejects the file - a firmware that
    // writes a broken IDIT is not a known-good signal.
    let idit: IditDate | null = null;
    if (iditBytes !== null) {
        if (iditBytes.byteLength < 8 + IDIT_DATE_LEN) return null;
        idit = parseIditDate(iditBytes.subarray(8));
        if (!idit) return null;
    }

    const recordCount = Math.floor(payloadLen / GPS0_RECORD_SIZE);
    if (recordCount === 0) return null;

    const view = new DataView(gps0Bytes.buffer, gps0Bytes.byteOffset + payloadStart, recordCount * GPS0_RECORD_SIZE);
    const rows: Gps0Row[] = [];
    const skipped: SkippedLine[] = [];

    // FALLBACK year/month baseline (IDIT mode only). Records normally carry
    // their own year/month (bytes 22-23, used by decodeGps0Record); this
    // machinery only matters for firmware that zero-fills those bytes. IDIT is
    // local-time and gps0 is UTC, so two cases:
    //   1) Initial month for the first valid record: IDIT.day may differ from
    //      first-record.day by 1 (TZ offset up to ±14h). If first-record.day
    //      is far from IDIT.day (e.g. IDIT=Feb 1 local, first UTC record day=31
    //      from January), the naive Date.UTC(idit.year, idit.month-1, 31) is
    //      either invalid or off by ~30 days. Pick the (year, month) among
    //      {-1, 0, +1} months from IDIT whose timestamp is closest to IDIT.
    //   2) Cross-midnight UTC mid-recording: when a record's day suddenly
    //      drops (e.g. 31 -> 1), the month has rolled over. Without this
    //      the post-midnight portion would be timestamped ~30 days back.
    // In IDIT-less mode there is no baseline to calibrate or roll over -
    // records with blank date bytes are skipped instead.
    let curYear = idit?.year ?? 0;
    let curMonth = idit?.month ?? 0;
    let prevDay: number | null = null;

    for (let i = 0; i < recordCount; i++) {
        // Peek the record's day to decide on month, then decode with the
        // adjusted year/month. decodeGps0Record will validate the rest.
        const day = view.getUint8(i * GPS0_RECORD_SIZE + 24);

        if (idit === null) {
            // IDIT-less mode: the record must self-describe its date. Blank
            // date bytes are skipped silently - normal at recording start
            // while GPS acquires satellites, same policy as empty fixes.
            const yearByte = view.getUint8(i * GPS0_RECORD_SIZE + 22);
            const monthByte = view.getUint8(i * GPS0_RECORD_SIZE + 23);
            if (!isPlausibleRecordDate(yearByte, monthByte)) continue;
            // curYear/curMonth stay 0/0 - unreachable in decodeGps0Record
            // because the in-record date is valid and always wins.
        } else if (prevDay === null) {
            // First valid record - calibrate month against IDIT.
            const iditMs = utcMillisecondsFromParts(
                idit.year,
                idit.month,
                idit.day,
                idit.hour,
                idit.minute,
                idit.second,
            );
            if (iditMs === null) return null;
            const hour = view.getUint8(i * GPS0_RECORD_SIZE + 25);
            const minute = view.getUint8(i * GPS0_RECORD_SIZE + 26);
            const second = view.getUint8(i * GPS0_RECORD_SIZE + 27);
            let bestDist = Infinity;
            for (let dm = -1; dm <= 1; dm++) {
                let y = idit.year;
                let m = idit.month + dm;
                if (m < 1) {
                    m = 12;
                    y--;
                }
                if (m > 12) {
                    m = 1;
                    y++;
                }
                const ms = utcMillisecondsFromParts(y, m, day, hour, minute, second);
                if (ms === null) continue;
                const dist = Math.abs(ms - iditMs);
                if (dist < bestDist) {
                    bestDist = dist;
                    curYear = y;
                    curMonth = m;
                }
            }
        } else if (day < prevDay - 7) {
            // Day jumped backwards by more than a week - rollover into the
            // next month. The -7 threshold tolerates noisy single-byte day
            // values without false-firing on intra-month transitions.
            curMonth++;
            if (curMonth > 12) {
                curMonth = 1;
                curYear++;
            }
        }

        const rec = decodeGps0Record(view, i * GPS0_RECORD_SIZE, curYear, curMonth, mp4Filename);
        if (rec === null) {
            // Silent skip - empty fixes are normal at recording start while
            // GPS acquires satellites. Do NOT update prevDay for an empty fix
            // (its day field is still valid, but skipping the prevDay update
            // keeps the rollover heuristic anchored to a known-good record).
            continue;
        }

        prevDay = day;
        rows.push({
            rec,
            recordIndex: i,
            speedField: view.getUint16(i * GPS0_RECORD_SIZE + 20, true),
            courseByte: view.getUint8(i * GPS0_RECORD_SIZE + 28),
        });
    }

    const cleaned = dropPositionOutliers(dropStaleTimeRows(rows, skipped), skipped);
    if (cleaned.length === 0) return null;
    calibrateGps0SpeedAndCourse(cleaned);
    return { records: cleaned.map((row) => row.rec), skipped };
}

// How many following rows vote on a backward-time conflict. A single-row
// arbiter would side with a PAIR of consecutive stale rows against the valid
// row before them; five rows out-vote any short stale burst.
const STALE_ARBITRATION_WINDOW = 5;

/**
 * Pass A of the stale-row glitch filter: resolves backward time steps. When a
 * row is older than the last kept one, the following rows vote: if most of
 * the next few rows lie between the current row and the kept one, the kept
 * row is the outlier (the RTC-stamped first fix of a cold start, stamped
 * hours ahead) and is dropped retroactively; otherwise the current row is the
 * stale one (a ring-buffer leftover from the past). Appends a SkippedLine per
 * dropped row.
 */
function dropStaleTimeRows(rows: Gps0Row[], skipped: SkippedLine[]): Gps0Row[] {
    const kept: Gps0Row[] = [];
    for (let i = 0; i < rows.length; i++) {
        const cur = rows[i]!;
        let dropCur = false;
        while (kept.length > 0 && cur.rec.unixSeconds < kept[kept.length - 1]!.rec.unixSeconds) {
            const top = kept[kept.length - 1]!;
            let continuingFromCur = 0;
            let voters = 0;
            for (let j = i + 1; j < rows.length && voters < STALE_ARBITRATION_WINDOW; j++, voters++) {
                const t = rows[j]!.rec.unixSeconds;
                if (t >= cur.rec.unixSeconds && t < top.rec.unixSeconds) continuingFromCur++;
            }
            if (continuingFromCur * 2 <= voters) {
                dropCur = true;
                break;
            }
            kept.pop();
            skipped.push({
                line: top.recordIndex + 1,
                raw: `<gps0 record ${top.recordIndex}>`,
                reason: "timestamp ahead of the following track (RTC-stamped row)",
            });
        }
        if (dropCur) {
            skipped.push({
                line: cur.recordIndex + 1,
                raw: `<gps0 record ${cur.recordIndex}>`,
                reason: "backward time step (stale firmware row)",
            });
            continue;
        }
        kept.push(cur);
    }
    return kept;
}

// One kept gps0 record plus the raw field bytes the calibration pass needs:
// the provisional GpsRecord cannot round-trip a course byte >= 180 (mapped to
// "no course" under the course/2 reading) and must not be trusted for the
// speed unit.
interface Gps0Row {
    rec: GpsRecord;
    recordIndex: number; // 0-based index in the raw gps0 payload, for skip diagnostics
    speedField: number; // u16 at 20-21, km/h or knots depending on firmware
    courseByte: number; // u8 at 28, course/2 or course mod 256 depending on firmware
}

// Calibration gates. Ratio/course statistics only use records that are
// genuinely moving (trajectory-implied speed and the raw field both above
// noise) over small gaps, and a verdict needs enough of them that one GPS
// glitch cannot flip it. Below the sample floor the provisional reading
// (km/h + course/2) stands - on a parked or fix-less clip the speeds are ~0
// and the unit does not matter.
const CALIBRATION_MIN_SAMPLES = 8;
const CALIBRATION_MAX_GAP_SEC = 5;
const CALIBRATION_MIN_IMPLIED_KMH = 10;
const CALIBRATION_MIN_SPEED_FIELD = 6;
// Midpoint of the two candidate units: ratio 1.0 = the field is km/h,
// 1.852 = knots. (A hypothetical mph firmware, 1.609, would be labeled knots
// - a 15% error instead of 61%; no such sample has been seen.)
const KNOTS_RATIO_THRESHOLD = 1.4;
// The raw-course hypothesis picks the best of two aliases per sample, which
// gives it an inherent fit advantage over course/2 - it must win by a margin,
// not a hair, before the provisional reading is dropped. Observed medians are
// far apart (~1 deg vs ~85+ deg on real samples of either firmware).
const RAW_COURSE_WIN_MARGIN_DEG = 10;

/** Shortest angular distance between two headings, degrees in [0, 180]. */
function angularGapDeg(a: number, b: number): number {
    return Math.abs(wrapDegrees(a - b));
}

/** Middle element of a sorted copy; callers guarantee a non-empty array. */
function median(values: number[]): number {
    const sorted = [...values].sort((x, y) => x - y);
    return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Resolves the two firmware-dependent gps0 fields in place by checking each
 * hypothesis against the trajectory:
 *
 *   - speed unit: median of (haversine-implied km/h / raw field) over moving
 *     records - ~1.0 means the field is km/h (keep the provisional m/s),
 *     ~1.852 means knots (recompute from the raw field);
 *   - course encoding: median angular error of course/2 vs the trajectory
 *     bearing against that of the raw byte (allowing the +256 alias - the
 *     mod-256 firmware casts a u16 course to u8, so headings >= 256 deg store
 *     only the low byte). If raw wins, each record gets whichever of
 *     {byte, byte+256} lies closer to its trajectory bearing.
 *
 * This is unit/encoding inference, not speed-from-coordinates: the emitted
 * values still come from the record fields. Undecidable input (too short,
 * parked, no displacement) keeps the provisional km/h + course/2 reading.
 */
function calibrateGps0SpeedAndCourse(rows: Gps0Row[]): void {
    if (rows.length < 2) return;

    // Trajectory-implied speed per row, from the previous kept row. null =
    // no usable pair (first row, duplicate second, gap too long).
    const impliedKmh: (number | null)[] = rows.map(() => null);
    for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1]!.rec;
        const cur = rows[i]!.rec;
        const dtSec = cur.unixSeconds - prev.unixSeconds;
        if (dtSec < 1 || dtSec > CALIBRATION_MAX_GAP_SEC) continue;
        impliedKmh[i] = (haversineKm(prev.lat, prev.lon, cur.lat, cur.lon) / dtSec) * 3600;
    }

    const speedRatios: number[] = [];
    for (let i = 1; i < rows.length; i++) {
        const implied = impliedKmh[i]!;
        const field = rows[i]!.speedField;
        if (implied === null || implied < CALIBRATION_MIN_IMPLIED_KMH || field < CALIBRATION_MIN_SPEED_FIELD) continue;
        speedRatios.push(implied / field);
    }
    if (speedRatios.length >= CALIBRATION_MIN_SAMPLES && median(speedRatios) > KNOTS_RATIO_THRESHOLD) {
        for (const row of rows) row.rec.speedMs = row.speedField * KNOTS_TO_MS;
    }

    // Reference bearings come from the same helper the course-less formats
    // use, computed on clones so a course/2 verdict leaves the native field
    // untouched. Runs after the speed verdict - fillForwardBearings treats
    // sub-0.5 m/s records as stationary, and knots-corrected speeds classify
    // slow rolling correctly.
    const clones = rows.map((row) => ({ ...row.rec }));
    fillForwardBearings(clones);

    const halfErrs: number[] = [];
    const rawErrs: number[] = [];
    for (let i = 1; i < rows.length; i++) {
        const implied = impliedKmh[i]!;
        if (implied === null || implied < CALIBRATION_MIN_IMPLIED_KMH) continue;
        const ref = clones[i]!.bearingDeg;
        const byte = rows[i]!.courseByte;
        // A byte >= 180 cannot be a halved course at all - hard penalty
        // instead of a skip, because its very presence is evidence for the
        // mod-256 encoding.
        halfErrs.push(byte < 180 ? angularGapDeg(byte * 2, ref) : 180);
        rawErrs.push(
            byte + 256 < 360
                ? Math.min(angularGapDeg(byte, ref), angularGapDeg(byte + 256, ref))
                : angularGapDeg(byte, ref),
        );
    }
    if (rawErrs.length < CALIBRATION_MIN_SAMPLES) return;
    if (median(rawErrs) + RAW_COURSE_WIN_MARGIN_DEG >= median(halfErrs)) return;

    for (let i = 0; i < rows.length; i++) {
        const byte = rows[i]!.courseByte;
        const ref = clones[i]!.bearingDeg;
        const aliased = byte + 256;
        rows[i]!.rec.bearingDeg =
            aliased < 360 && angularGapDeg(aliased, ref) < angularGapDeg(byte, ref) ? aliased : byte;
    }
}

/**
 * Pass B of the stale-row glitch filter: drops half-stale rows (fresh
 * timestamp, stale position). A row is an outlier when the implied speed from
 * the last kept fix is impossible (> GLITCH_MAX_IMPLIED_SPEED_MS) and either
 * skipping it restores continuity to the following row, or it is the last row
 * (no follower to confirm a genuine new position). Appends a SkippedLine per
 * dropped row.
 */
function dropPositionOutliers(rows: Gps0Row[], skipped: SkippedLine[]): Gps0Row[] {
    if (rows.length < 2) return rows;
    const kept: Gps0Row[] = [rows[0]!];
    for (let i = 1; i < rows.length; i++) {
        const rec = rows[i]!.rec;
        const prev = kept[kept.length - 1]!.rec;
        const dt = rec.unixSeconds - prev.unixSeconds;
        // dt=0 (duplicate second) has no defined implied speed - keep.
        if (dt >= 1) {
            const impliedMs = (haversineKm(prev.lat, prev.lon, rec.lat, rec.lon) * 1000) / dt;
            if (impliedMs > GLITCH_MAX_IMPLIED_SPEED_MS) {
                const next = rows[i + 1]?.rec;
                const nextDt = next ? next.unixSeconds - prev.unixSeconds : 0;
                const nextPlausible =
                    next !== undefined &&
                    nextDt >= 1 &&
                    (haversineKm(prev.lat, prev.lon, next.lat, next.lon) * 1000) / nextDt <=
                        GLITCH_MAX_IMPLIED_SPEED_MS;
                if (nextPlausible || next === undefined) {
                    skipped.push({
                        line: rows[i]!.recordIndex + 1,
                        raw: `<gps0 record ${rows[i]!.recordIndex}>`,
                        reason: "implausible displacement (stale firmware row)",
                    });
                    continue;
                }
                // Both this row and the next disagree with the previous fix -
                // a genuine new reality (e.g. recording resumed far away);
                // accept it as the new anchor.
            }
        }
        kept.push(rows[i]!);
    }
    return kept;
}

// Miltona 56-byte gps0 record size and the framing magic at offset 44.
const MILTONA_RECORD_SIZE = 56;
const MILTONA_MAGIC_OFFSET = 44;
const MILTONA_MAGIC = [0x3c, 0x99, 0xa7, 0x3a] as const;

/**
 * Detects the Miltona 56-byte gps0 dialect by its framing magic, checked in
 * the first two records (one match could be a coincidence inside coordinate
 * bytes of the 32-byte dialect; two aligned matches cannot).
 */
function isMiltonaGps0Dialect(gps0Bytes: Uint8Array, payloadStart: number): boolean {
    const hasMagicAt = (recordStart: number): boolean => {
        const off = payloadStart + recordStart + MILTONA_MAGIC_OFFSET;
        if (off + MILTONA_MAGIC.length > gps0Bytes.byteLength) return false;
        return matchesBytesAt(gps0Bytes, off, MILTONA_MAGIC);
    };
    if (!hasMagicAt(0)) return false;
    // Single-record payloads: one magic match is all the evidence there is.
    if (gps0Bytes.byteLength < payloadStart + 2 * MILTONA_RECORD_SIZE) return true;
    return hasMagicAt(MILTONA_RECORD_SIZE);
}

// Lamax S9 gps0 dialect: XOR-0xAA encrypted ASCII in 311-byte records,
// signature bytes f2 e1 f0 ee 54 54 98 ('TT' = 0x54 0x54) at payload offsets
// 2..8 (ExifTool QuickTimeStream.pl:2724-2735, v13.55, regex
// /^.{2}\xf2\xe1\xf0\xeeTT\x98/s). Implemented from foreign source, not
// validated against a real sample.
const LAMAX_S9_SIGNATURE = [0xf2, 0xe1, 0xf0, 0xee, 0x54, 0x54, 0x98] as const;
const LAMAX_S9_SIGNATURE_OFFSET = 2;

/** Detects the Lamax S9 encrypted gps0 dialect by its payload signature. */
function isLamaxS9Gps0Dialect(gps0Bytes: Uint8Array, payloadStart: number): boolean {
    const off = payloadStart + LAMAX_S9_SIGNATURE_OFFSET;
    if (off + LAMAX_S9_SIGNATURE.length > gps0Bytes.byteLength) return false;
    return matchesBytesAt(gps0Bytes, off, LAMAX_S9_SIGNATURE);
}

// Record stride of that dialect - upstream re-checks the signature at every
// record start and stops at the first miss, which is also the terminator here.
const LAMAX_S9_RECORD_SIZE = 311;

/**
 * Decodes the Lamax S9 dialect. The two leading bytes before the signature are
 * part of the record, so the decrypt starts at the record itself and the shared
 * decoder skips its own 8-byte preamble.
 *
 * Accel comes back gravity-INCLUDED (see the shared decoder), so the per-file
 * axis mean is removed here - the same treatment the freegps primitive gives
 * the Azdome carrier.
 */
function parseLamaxS9Gps0(gps0Bytes: Uint8Array, payloadStart: number, mp4Filename: string): ParsedRecords | null {
    const records: GpsRecord[] = [];
    for (let at = payloadStart; at + LAMAX_S9_RECORD_SIZE <= gps0Bytes.byteLength; at += LAMAX_S9_RECORD_SIZE) {
        if (!isLamaxS9Gps0Dialect(gps0Bytes, at)) break;
        const text = decryptXorAscii(gps0Bytes, at, LAMAX_S9_RECORD_SIZE);
        const record = decodeXorAsciiGpsText(text, mp4Filename);
        // A record with no fix carries accel and a clock only - skipped, not an
        // error (the firmware writes them whenever GPS has no lock).
        if (record) records.push(record);
    }
    if (records.length === 0) return null;
    removeGravityBaselineOrZero(records);
    return { records, skipped: [] };
}

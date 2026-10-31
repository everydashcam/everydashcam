import { nearestIndexBy } from "../../sorted-search.js";
// RVMI metadata-track extraction. Vendor-agnostic utility used in genericPlugin
// as one of the fallback attempts for files exported through RegistratorViewer.
//
// RVMI = "RegistratorViewer Metadata Info" - metadata written by the
// RegistratorViewer player (Vlad Antoshin, http://registratorviewer.com)
// when it exports a clip. The original dashcam file contains a vendor GPS
// format (Novatek freeGPS, Ambarella tail-gps0, etc.); RegistratorViewer
// decodes it and stores it in its own standardized format that it can read
// back. For us: the format is camera-agnostic, and the clip has GPS even
// if the original GPS track is lost.
//
// Inside MP4: a separate track with handler='data' and stsd entry='RVMI'.
// Each sample starts with a 4-byte ASCII magic, has a fixed-length payload
// for its type, and ends with a terminator `0x0c`:
//
//   tReV (1 sample, usually the first): 13 bytes
//     [0..3]   "tReV"
//     [4..11]  double LE - OLE date (days since 1899-12-30 UTC, fraction =
//              fraction of a day). Used as the UTC baseline for the track.
//     [12]     0x0c
//
//   gReV (~1 Hz): 21 bytes
//     [0..3]   "gReV"
//     [4..7]   i32 LE longitude (micro-degrees, /1e6)
//     [8..11]  i32 LE latitude  (micro-degrees, /1e6)
//     [12..15] i32 LE altitude (always 0 on known samples, not parsed in v1)
//     [16..17] u16 LE speed   (see SPEED_LSB_PER_KMH below)
//     [18..19] u16 LE bearing in half-degrees (0.5° per LSB, range 0..720;
//              multiply by 2 to get degrees). Confirmed by ExifTool
//              QuickTimeStream.pl RVMI_gReV table (ValueConv => '$val * 2').
//     [20]     0x0c
//
//   sReV (~9 Hz, accel): 11 bytes
//     [0..3]   "sReV"
//     [4..5]   i16 LE accel X
//     [6..7]   i16 LE accel Y
//     [8..9]   i16 LE accel Z
//     [10]     0x0c
//
// A zero gReV sample (lat=0 && lon=0) means GPS fix not yet acquired - skipped.
// The first non-zero sample typically appears 3-15 seconds after recording starts
// (cold-fix GPS receiver).
//
// Speed/accel scales are empirical, derived from one batch of 2014-2019 samples.
// RegistratorViewer has no public format spec; constants may drift with exotic
// export versions. If they diverge, fix SPEED_LSB_PER_KMH / ACCEL_LSB_PER_G
// in one place.

import { KMH_TO_MS } from "../types.js";
import type { GpsRecord, ParsedRecords, SkippedLine, VendorFile } from "../types.js";
import { loadSamples, readMediaTimescale, readSampleStartsInTicks, readSampleTable } from "./mp4-walker.js";
import type { Mp4Index, TrackInfo } from "./mp4-index.js";

const RVMI_STSD_TYPE = "RVMI";

// OLE epoch 1899-12-30 UTC is 25569 days before the Unix epoch 1970-01-01 UTC.
// RVMI OLE-date is treated as UTC, so `(oleDays - 25569) * 86400` gives
// Unix seconds directly. GpsRecord.unixSeconds contract = honest UTC.
const OLE_EPOCH_DAYS = 25569;
const SEC_PER_DAY = 86400;

// u16 speed scale: empirical - gReV.speed=140 at ~15 km/h movement between
// adjacent points. Divide by 10.
const SPEED_LSB_PER_KMH = 10;

// i16 accel scale: empirical. On a stationary sample (Fragment of AMBA*.mp4)
// accel reads (~-60, ~-70, 0) ≈ 0.06g/0.07g/0g at 1g=1024 - typical range
// for Bosch BMA250E ±2g. Matches the divisor used for NMEA $GSENSOR
// (see nmea.ts GSENSOR_LSB_PER_G). Adjust if a sample with a known g-event
// proves otherwise.
const ACCEL_LSB_PER_G = 1024;

/**
 * Finds the RVMI track in Mp4Index. Probe is index-only (stsdType='RVMI') -
 * no additional IO.
 */
export function findRvmiTrack(index: Mp4Index): TrackInfo | null {
    for (const t of index.tracks) {
        if (t.sampleFormat === RVMI_STSD_TYPE) return t;
    }
    return null;
}

/**
 * Extracts GpsRecords from an RVMI track. Uses the tReV sample as the absolute
 * time baseline, gReV samples for coordinates/speed/bearing, and sReV samples
 * for acceleration (merged into the nearest gReV record by time).
 * Returns null if the track is missing, the sample table is corrupt, or there
 * are no valid gReV fixes.
 */
export async function extractFromRvmiTrack(
    vf: VendorFile,
    index: Mp4Index,
    track: TrackInfo,
): Promise<ParsedRecords | null> {
    if (!index.moovView) return null;
    const samples = readSampleTable(index.moovView, track.trakBox);
    if (!samples || samples.length === 0) return null;

    const sampleStartTicks = readSampleStartsInTicks(index.moovView, track.trakBox);
    const mediaTimescale = readMediaTimescale(index.moovView, track.trakBox);
    if (!sampleStartTicks || !mediaTimescale || mediaTimescale <= 0) return null;
    if (sampleStartTicks.length < samples.length) return null;

    const buffers = await loadSamples(vf.file, samples, index.sliceCost);

    // Baseline from the tReV sample. tReV stores an OLE date (days since
    // 1899-12-30). GpsRecord.unixSeconds must be real UTC (see types.ts).
    //
    // Known limitation: RVMI has no TZ metadata. If RegistratorViewer wrote
    // the OLE date as camera-local time instead of UTC, unixSeconds will be
    // off by the TZ offset (e.g. -3 h for MSK). Fixture samples match UTC
    // (vitest runs with TZ=UTC). For real samples with TZ mismatch the user
    // will see a time offset in the UI - a lesser evil than a broken GPMF/GPX
    // export with wrong absolute timestamps.
    let baselineUnixSec: number | null = null;
    for (let i = 0; i < buffers.length; i++) {
        const buf = buffers[i];
        if (!buf || buf.byteLength < 13) continue;
        const view = new DataView(buf);
        if (readMagic(view, 0) !== "tReV") continue;
        const oleDays = view.getFloat64(4, true);
        if (!Number.isFinite(oleDays)) continue;
        baselineUnixSec = oleDaysToUtcUnixSec(oleDays);
        break;
    }
    if (baselineUnixSec === null) return null;

    // Collect gReV into records and sReV into a side array; merge sReV into
    // the nearest gReV by unixSeconds. Cadence: sReV ~9 Hz, gReV ~1 Hz,
    // delta <= 0.5 s - always a close neighbor.
    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];
    interface AccelEntry {
        unixSeconds: number;
        x: number;
        y: number;
        z: number;
    }
    const accels: AccelEntry[] = [];

    for (let i = 0; i < buffers.length; i++) {
        const buf = buffers[i];
        if (!buf || buf.byteLength < 5) {
            skipped.push({
                line: i + 1,
                raw: `<rvmi sample ${i + 1}: truncated>`,
                reason: "sample shorter than 5 bytes",
            });
            continue;
        }
        const view = new DataView(buf);
        const magic = readMagic(view, 0);
        const dtTicks = sampleStartTicks[i]!;
        const unixSeconds = baselineUnixSec + dtTicks / mediaTimescale;

        if (magic === "gReV") {
            if (buf.byteLength < 20) {
                skipped.push({
                    line: i + 1,
                    raw: `<rvmi sample ${i + 1}: gReV truncated>`,
                    reason: "gReV shorter than 20 bytes",
                });
                continue;
            }
            const lonRaw = view.getInt32(4, true);
            const latRaw = view.getInt32(8, true);
            // Altitude (offset 12, i32 LE) is always 0 on known samples and
            // GpsRecord has no altitude field.
            // GPSSpeed is int16s per ExifTool RVMI_gReV: a signed read avoids a
            // negative/glitched sample decoding to ~6553 km/h instead of a small
            // value. Bearing (heading 0-360) is naturally unsigned.
            const speedRaw = view.getInt16(16, true);
            const bearingRaw = view.getUint16(18, true);

            const lat = latRaw / 1_000_000;
            const lon = lonRaw / 1_000_000;
            // Zero fix (cold-start acquiring satellites) - silent skip.
            if (lat === 0 && lon === 0) continue;
            if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
                skipped.push({
                    line: i + 1,
                    raw: `<rvmi sample ${i + 1}: lat=${lat} lon=${lon}>`,
                    reason: "coordinates out of valid range",
                });
                continue;
            }

            const speedKmh = speedRaw / SPEED_LSB_PER_KMH;
            // ExifTool RVMI_gReV: GPSTrack ValueConv = '$val * 2'. Raw value is
            // in 0.5° units (0..720); %360 guards against the upper-bound edge
            // where 360° wraps to 0°.
            const bearingDeg = (bearingRaw * 2) % 360;

            records.push({
                unixSeconds,
                active: true,
                lat,
                lon,
                bearingDeg,
                speedMs: speedKmh * KMH_TO_MS,
                accelXg: 0,
                accelYg: 0,
                accelZg: 0,
                mp4Filename: vf.file.name,
            });
        } else if (magic === "sReV") {
            if (buf.byteLength < 10) {
                skipped.push({
                    line: i + 1,
                    raw: `<rvmi sample ${i + 1}: sReV truncated>`,
                    reason: "sReV shorter than 10 bytes",
                });
                continue;
            }
            const xRaw = view.getInt16(4, true);
            const yRaw = view.getInt16(6, true);
            const zRaw = view.getInt16(8, true);
            accels.push({
                unixSeconds,
                x: xRaw / ACCEL_LSB_PER_G,
                y: yRaw / ACCEL_LSB_PER_G,
                z: zRaw / ACCEL_LSB_PER_G,
            });
        }
        // tReV already handled above; unknown magic types are silently ignored.
    }

    if (records.length === 0) return null;

    // Merge accels into the nearest gReV record via binary search. records are
    // in monotonic stts order.
    if (accels.length > 0) {
        // gReV/sReV are interleaved by dt in the RVMI track but share one stts
        // so the sort is essentially a no-op - sort defensively anyway.
        accels.sort((a, b) => a.unixSeconds - b.unixSeconds);
        // Sort records in case a non-first tReV sample disrupts order.
        records.sort((a, b) => a.unixSeconds - b.unixSeconds);
        for (const r of records) {
            const idx = nearestAccelIndex(accels, r.unixSeconds);
            if (idx === -1) continue;
            const a = accels[idx]!;
            // sReV ~9 Hz, gReV ~1 Hz - max intra-pair gap < 0.5 s.
            if (Math.abs(a.unixSeconds - r.unixSeconds) > 0.5) continue;
            r.accelXg = a.x;
            r.accelYg = a.y;
            r.accelZg = a.z;
        }
    }

    // tReV sits at media-time 0 of the RVMI track, which is the same time as
    // video-track media-time 0. Returning baseline lets deriveStartUtc anchor
    // trip.startUtc to real video-frame-0 wall-clock instead of falling back
    // to firstGpsUnix (which is later by the GPS cold-fix delay, ~0.5-15 s,
    // and would shift the chart cursor ahead of the video by that amount).
    return { records, skipped, videoStartUtcHint: baselineUnixSec };
}

/** Top-level entry for genericPlugin fallback: finds the RVMI track and extracts records. */
export async function tryExtractRvmi(vf: VendorFile, index: Mp4Index): Promise<ParsedRecords | null> {
    const track = findRvmiTrack(index);
    if (!track) return null;
    return await extractFromRvmiTrack(vf, index, track);
}

function readMagic(view: DataView, offset: number): string {
    if (offset + 4 > view.byteLength) return "";
    return String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3),
    );
}

/** Converts OLE double-date (days since 1899-12-30) to Unix seconds UTC. */
function oleDaysToUtcUnixSec(oleDays: number): number {
    return (oleDays - OLE_EPOCH_DAYS) * SEC_PER_DAY;
}

/** Binary search for the accel sample nearest to the target unixSeconds. */
function nearestAccelIndex(accels: ReadonlyArray<{ unixSeconds: number }>, target: number): number {
    return nearestIndexBy(accels, target, (sample) => sample.unixSeconds, "later");
}

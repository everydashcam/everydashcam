// 70mai $V02 CSV-log parser. Sits next to MP4 files, named `GPSData*.txt`.
// 13-field CSV row; field[9] usually names the front MP4, with or without its
// extension. A500S sessions leave it at "0", so those UTC records wait for
// directory-scoped time association.
//
// 70mai firmware quirks (live here, not in a generic layer):
//   - 8-hour firmware bias on field[0] (timestamp) - known 70mai firmware
//     bug associated with the firmware's UTC+8 default. We apply a constant
//     +28800-second shift so unixSeconds on output is honest UTC. Sources:
//       https://dashcamtalk.com/forum/threads/unix-time-code-in-gps-txt-file-is-8-hours-out.51107/
//       https://dashcamtalk.com/forum/threads/date-and-time-reset.36547/
//       https://dashcamtalk.com/forum/threads/a810-clock-sync-with-gps.49529/
//     Empirically: file mtime - gps_first ~ 8h. Dashcam Viewer applies the
//     same bias as a workaround.
//   - Gravity removal on accel: GpsRecord.accel*g is gravity-removed by
//     contract (~0 at rest). The gravity-bearing (vertical) axis is
//     MODEL-DEPENDENT - x800 carries ~1g on ay (field 7), A810 on ax (field 6),
//     both confirmed on real cards - so hard-coding one axis is wrong on the
//     other model. Instead we subtract the per-axis mean over the whole log
//     (subtractAxisMean): the mean is dominated by static gravity + mount tilt,
//     because horizontal driving accel averages to ~0 over a full log, so it
//     lands accel*g at ~0 at rest for ANY mounting/model. Same DC-block the
//     subtitle-embedded accel formats use.

import { createLogger } from "../../log.js";
import { RX_70MAI } from "../filename/_patterns.js";
import { subtractAxisMean } from "../internal/accel-baseline.js";
import { isCoordinateInRange } from "../internal/ddmm.js";
import { type GpsRecord, type ParsedRecords, type SkippedLine, type VendorFile, WrongFormatError } from "../types.js";
import type { Primitive } from "./types.js";

const log = createLogger("primitive:csv-70mai");
const FORMAT_ID = "csv-70mai";

// Keep content probing to text files, but do not require the firmware basename:
// OS copies and exports commonly rename the log while its `$Vxx` signature and
// row grammar remain self-identifying.
const RX_TEXT_NAME = /\.txt$/i;

const EXPECTED_SIGNATURE_PREFIX = "$V";
const SUPPORTED_VERSION = "V02";
const FIELDS_PER_ROW = 13;
const GPS_TIMESTAMP_FIRMWARE_OFFSET_SEC = 8 * 3600;
const RX_SEEK_POSITION = /^gSeekPos=\s*\d+$/;

// Plausibility floor for a row timestamp (after the firmware offset). 70mai
// firmware quirk: right after a power-up / GPS-module reset (a fresh `$V02`
// session) the chip delivers a position fix BEFORE it decodes the GPS time
// message. Until then the RTC sits at ~epoch 0, so the firmware writes rows
// with status "A" (valid coordinates!) but a near-zero, often negative
// timestamp (e.g. raw -28801 -> -1 after the +8h offset). The position is
// real, only the clock is not - so we keep the record but flag it
// `timeUnsynced` (see GpsRecord). The time layer ignores those rows when
// deriving the file start / camera TZ and re-anchors them onto the video
// window, instead of throwing the whole file onto 1970. Any time before
// 2010-01-01 means the RTC was never synced - no real 70mai recording predates
// the brand.
const MIN_PLAUSIBLE_UNIX_SEC = 1262304000; // 2010-01-01 UTC

// Max plausible gap (seconds) between an orphan row and the anchor (last named
// row of the session) when carrying its filename forward. A rollover orphan
// burst sits within seconds of the file's last named row; a gap this large means
// recording stopped in between (e.g. firmware dropped the rollover/$V02 marker),
// so binding would extend a finished file's track - drop the row instead.
// Generous: well past any single clip length, tight enough to reject a
// resumed-after-stop gap. Only applied when both timestamps are synced - see the
// orphan branch in parseSingleLog.
const MAX_ORPHAN_GAP_SEC = 300;

// A single minutes-long clock excursion between nearby fixes of the same clip
// is corrupt timing. Requiring the clock to return within five seconds keeps
// real recording gaps and sustained clock changes out of this filter. X800
// logs include duplicate seconds, so corroborating fixes may share a timestamp.
const MIN_ISOLATED_CLOCK_JUMP_SEC = 300;
const MAX_CLOCK_NEIGHBOUR_GAP_SEC = 5;

// How many bytes to read for the marker check. ~512 covers the first line
// even with CRLF and BOM. parseSingleLog then re-reads the file in full via
// file.text().
const MARKER_PROBE_BYTES = 512;

export const csv70maiPrimitive: Primitive = {
    id: FORMAT_ID,
    displayName: "70mai $V02 CSV log",
    kind: "log-sidecar",

    async marker(file: VendorFile): Promise<boolean> {
        // Extension cutoff keeps binary sidecars out of the text probe.
        if (!RX_TEXT_NAME.test(file.file.name)) return false;
        const head = await file.file.slice(0, MARKER_PROBE_BYTES).text();
        // Signature may not be at byte 0 (BOM, empty line, CR/LF). One
        // occurrence of "$V" at the start of an early line is enough.
        for (const line of head.split(/\r?\n/)) {
            if (line.trim().startsWith(EXPECTED_SIGNATURE_PREFIX)) return true;
        }
        return false;
    },

    async parse(file: VendorFile, _index, signal): Promise<ParsedRecords> {
        // Abort shortcuts at the two real await boundaries. The inner row
        // loop is sync (~100 ms on a 50K-row log) and does not yield, so a
        // mid-parse signal.aborted is invisible - the contract documents
        // this. We catch the most common case: abort fired before we even
        // started, or while we were waiting on file.text().
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        const text = await file.file.text();
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        return parseSingleLog(text, file.file.name, file.relativePath || file.file.name, file.sourceKey);
    },
};

// Parses one log file. Throws WrongFormatError if no $V?? signature is found
// (the marker saw `$V`, but the full contents are alien or unsupported).
//
// $V?? can appear multiple times: firmware writes the signature on every
// re-init (new session after parking mode/reboot/SD removal). Repeated $V??
// is a session separator, silently skipped (not in skipped).
// Source: max2697/dashcam-gpx-converter treats $V02 as a track break.
function parseSingleLog(
    text: string,
    sourceFilename: string,
    sourcePath = sourceFilename,
    sourceKey?: string,
): ParsedRecords {
    const lines = text.split(/\r?\n/);

    let firstSignature: string | null = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith(EXPECTED_SIGNATURE_PREFIX)) {
            firstSignature = trimmed;
            break;
        }
    }
    if (firstSignature === null) {
        throw new WrongFormatError(`no ${EXPECTED_SIGNATURE_PREFIX}?? signature found in ${sourceFilename}`);
    }
    const version = firstSignature.slice(1);
    if (version !== SUPPORTED_VERSION) {
        log.warn("gps log version untested", { version, supported: SUPPORTED_VERSION });
    }

    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];

    // Carry-forward anchor: the last named file in the current $V02 session and
    // the timestamp of its last seen row. Orphan rows (empty/"0" name, see
    // parseRow) bind to it - the log writes a file's rows contiguously, so an
    // orphan belongs to whatever file was recording when it was written. Reset on
    // every session separator so a new session never inherits the previous file.
    let anchorMp4: string | null = null;
    let anchorUnix = 0;
    let sessionIndex = -1;
    const pendingOrphans: Array<{ record: GpsRecord; line: number; raw: string }> = [];
    const timeAssociation = {
        sourcePath,
        extractorId: FORMAT_ID,
        ...(sourceKey === undefined ? {} : { sourceKey }),
    };

    // A missing filename can mean a short rollover burst or an entirely
    // unnamed session. Wait until a real named fix or the session boundary
    // distinguishes them; early rows of a named session keep the old skip.
    const flushOrphans = (hasNamedFix: boolean): void => {
        for (const { record, line, raw } of pendingOrphans) {
            if (!hasNamedFix && record.timeUnsynced !== true) {
                record.mp4Filename = sourceFilename;
                record.timeAssociation = timeAssociation;
                record.trackSegment = Math.max(0, sessionIndex);
                records.push(record);
            } else {
                skipped.push({ line, raw, reason: "missing or sentinel mp4 filename" });
            }
        }
        pendingOrphans.length = 0;
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]!;
        const trimmed = raw.trim();
        // Preallocated logs carry a write cursor and space padding. The cursor
        // is metadata, not a GPS row or a new session; keep the filename anchor.
        if (trimmed === "" || RX_SEEK_POSITION.test(trimmed)) continue;
        if (trimmed.startsWith(EXPECTED_SIGNATURE_PREFIX)) {
            flushOrphans(anchorMp4 !== null);
            anchorMp4 = null;
            sessionIndex++;
            continue;
        }

        const parsed = parseRow(raw);
        if ("error" in parsed) {
            skipped.push({ line: i + 1, raw, reason: parsed.error });
            continue;
        }
        if ("orphan" in parsed) {
            if (anchorMp4 === null) {
                pendingOrphans.push({ record: parsed.orphan, line: i + 1, raw });
                continue;
            }
            // Bind to the anchor unless a synced-clock gap says recording stopped
            // between them (see MAX_ORPHAN_GAP_SEC) - that would extend a finished
            // file's track. Cold-start rows (timeUnsynced placeholder clock) skip
            // the gap check and fall back to pure row contiguity.
            const bothSynced = parsed.orphan.timeUnsynced !== true && anchorUnix >= MIN_PLAUSIBLE_UNIX_SEC;
            const gapTooLarge = bothSynced && Math.abs(parsed.orphan.unixSeconds - anchorUnix) > MAX_ORPHAN_GAP_SEC;
            if (!gapTooLarge) {
                parsed.orphan.mp4Filename = anchorMp4;
                records.push(parsed.orphan);
            } else {
                skipped.push({ line: i + 1, raw, reason: "missing or sentinel mp4 filename" });
            }
            continue;
        }
        // V (void / no-fix) rows return { record: null }: drop silently and do
        // NOT update the anchor - they carry no usable file/time context.
        if (parsed.record !== null) {
            if (isIsolatedClockJump(parsed.record, anchorMp4, anchorUnix, lines, i + 1)) {
                skipped.push({ line: i + 1, raw, reason: "isolated timestamp outlier" });
                continue;
            }
            flushOrphans(true);
            anchorMp4 = parsed.record.mp4Filename;
            anchorUnix = parsed.record.unixSeconds;
            records.push(parsed.record);
        }
    }
    flushOrphans(anchorMp4 !== null);
    // Deferred orphan decisions must not reorder the source-line diagnostics.
    skipped.sort((a, b) => a.line - b.line);

    // Gravity + mount-tilt removal (DC block). The vertical axis is
    // model-dependent (x800: ay, A810: ax), so we subtract the per-axis mean
    // over the whole log instead of a hard-coded axis - see the header note.
    // Needs >=2 samples to separate the static bias from motion (subtractAxisMean's
    // contract); a degenerate 1-row log keeps raw values, gravity included.
    if (records.length >= 2) {
        subtractAxisMean(
            records,
            records.map((r) => ({ x: r.accelXg, y: r.accelYg, z: r.accelZg })),
        );
    }

    return { records, skipped };
}

function isIsolatedClockJump(
    record: GpsRecord,
    previousFilename: string | null,
    previousUnix: number,
    lines: readonly string[],
    nextIndex: number,
): boolean {
    if (
        record.timeUnsynced ||
        previousUnix < MIN_PLAUSIBLE_UNIX_SEC ||
        previousFilename !== record.mp4Filename ||
        Math.abs(record.unixSeconds - previousUnix) <= MIN_ISOLATED_CLOCK_JUMP_SEC
    ) {
        return false;
    }
    // Probe only suspected jumps, through the same metadata and void rows the
    // main loop ignores. Stop at session boundaries, broken rows and other clips.
    // A rollover orphan inherits this clip's name, so its time can corroborate
    // the old anchor even when no more named fixes follow before end of log.
    for (let i = nextIndex; i < lines.length; i++) {
        const raw = lines[i]!;
        const trimmed = raw.trim();
        if (trimmed === "" || RX_SEEK_POSITION.test(trimmed)) continue;
        if (trimmed.startsWith(EXPECTED_SIGNATURE_PREFIX)) return false;
        const parsed = parseRow(raw);
        if ("error" in parsed) return false;
        const next = "orphan" in parsed ? parsed.orphan : parsed.record;
        if (next === null) continue;
        if (next.timeUnsynced) return false;
        if ("record" in parsed && next.mp4Filename !== record.mp4Filename) return false;
        const neighbourGap = next.unixSeconds - previousUnix;
        return (
            neighbourGap >= 0 &&
            neighbourGap <= MAX_CLOCK_NEIGHBOUR_GAP_SEC &&
            Math.abs(record.unixSeconds - next.unixSeconds) > MIN_ISOLATED_CLOCK_JUMP_SEC
        );
    }
    return false;
}

// `record: null` = void row (no fix), intentionally dropped. `orphan` = a valid
// fix whose front-MP4 name field is empty/"0". parseSingleLog either carries
// forward a named session's anchor or retains a wholly unnamed session for
// time association. `error` = a row we cannot use at all.
type RowResult = { record: GpsRecord | null } | { orphan: GpsRecord } | { error: string };

function parseRow(raw: string): RowResult {
    const parts = raw.split(",");
    if (parts.length !== FIELDS_PER_ROW) {
        return { error: `expected ${FIELDS_PER_ROW} fields, got ${parts.length}` };
    }

    const rawTimestamp = Number(parts[0]!);
    if (!Number.isFinite(rawTimestamp)) return { error: "bad timestamp" };
    const unixSeconds = rawTimestamp + GPS_TIMESTAMP_FIRMWARE_OFFSET_SEC;

    const validityRaw = parts[1]!;
    if (validityRaw !== "A" && validityRaw !== "V") {
        return { error: `bad validity flag ${JSON.stringify(validityRaw)}` };
    }
    // V = void (no GPS fix), standard "no fix, discard" semantics.
    if (validityRaw === "V") return { record: null };

    const lat = Number(parts[2]!);
    const lon = Number(parts[3]!);
    if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) {
        return { error: "bad coordinates" };
    }

    // Fields 4-8 are integer x 100, divide by 100 for human units.
    const bearing = Number(parts[4]!);
    const speed = Number(parts[5]!);
    const ax = Number(parts[6]!);
    const ay = Number(parts[7]!);
    const az = Number(parts[8]!);
    if (![bearing, speed, ax, ay, az].every(Number.isFinite)) {
        return { error: "bad numeric field" };
    }
    const bearingDeg = bearing / 100;
    const speedMs = speed / 100;
    if (bearingDeg < 0 || bearingDeg > 360) return { error: "bad bearing" };
    if (speedMs < 0) return { error: "bad speed" };

    // field[9] = front-MP4 name, the key a record binds to in byFilename.
    const rawFilename = (parts[9] ?? "").trim();
    // Some $V02 firmware writes only the clip stem. Restore its extension
    // before source-scoped association, which joins on the full MP4 basename.
    const mp4Filename = RX_70MAI.test(`${rawFilename}.MP4`) ? `${rawFilename}.MP4` : rawFilename;

    const record: GpsRecord = {
        unixSeconds,
        active: true,
        lat,
        lon,
        bearingDeg: bearingDeg === 360 ? 0 : bearingDeg,
        speedMs,
        accelXg: ax / 100,
        accelYg: ay / 100,
        accelZg: az / 100, // gravity removed post-parse, per-axis (see parseSingleLog)
        mp4Filename,
    };
    // Cold-start row: valid position, GPS clock not yet synced (see
    // MIN_PLAUSIBLE_UNIX_SEC). Flag the time so the downstream time layer
    // re-anchors it to the video window instead of trusting the placeholder.
    if (unixSeconds < MIN_PLAUSIBLE_UNIX_SEC) record.timeUnsynced = true;

    // Firmware sometimes writes an empty string or "0" into the front-MP4 name
    // field, in bursts at file-rollover boundaries: position and time are valid,
    // only the binding is missing. Hand it back as an orphan so parseSingleLog
    // can bind it to the session's current file - rows of one file are written
    // contiguously, so an orphan belongs to the last named file (subject to a
    // synced-clock gap sanity check there). A wholly unnamed session instead
    // keeps synced rows pending for directory-scoped time association.
    if (mp4Filename === "" || mp4Filename === "0") {
        return { orphan: record };
    }
    return { record };
}

// Export for synthetic edge-case tests.
export const _internal = { parseSingleLog, parseRow, GPS_TIMESTAMP_FIRMWARE_OFFSET_SEC };

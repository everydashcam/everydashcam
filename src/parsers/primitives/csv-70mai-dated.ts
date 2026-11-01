// 70mai dated CSV GPS log, observed as `.GPS/GPSData000001.txt` on a card the
// owner reported as an A800. The same row shape is publicly attributed to the
// older A800, including rear-clip ("...B.MP4") rows:
//   https://forum.mapillary.com/t/using-the-70mai-a810-dashcam-for-mapillary/9130/50
// A different firmware family from the `$V02` log in csv-70mai.ts: no header,
// eight fields per row, a calendar timestamp instead of unix seconds, and no
// course or accelerometer.
//
//   2026-08-01 20:30:59,B,A,074km/h,43.123456,-8.123456,1,20260801-223057-000001F.MP4
//
//   0  UTC date-time. Verified against the clip names on the real card: the
//      filename clock runs one or two hours ahead and changes mid-log, while
//      these timestamps stay continuous. No +8 h firmware bias here.
//   1  "B", or "N" on the first fix after a run of no-fix rows. Not needed.
//   2  A = fix, V = no fix.
//   3  integer km/h with the unit written into the field, zero-padded.
//   4  latitude, decimal degrees.
//   5  longitude, decimal degrees.
//   6  1 on the first row after power-on, otherwise 0. Not needed: rows bind to
//      clips by name, so a new session cannot inherit an older clip.
//   7  clip name WITHOUT the 70mai mode prefix ("20260801-223057-000001F.MP4"
//      for NO20260801-...). The row cannot tell normal from event clips, so
//      the name is kept as written; ingest rebinds it to the loaded NO/EV/...
//      file through the shared name core (mai70NameCore).
//
// No-fix rows are a literal placeholder ("2000-00-00 00:00:00,B,V,...,0000...")
// and are dropped silently, like `$V02` void rows. Real cards also carry short
// runs of valid fixes with an all-zero clip name; they are skipped with a
// reason rather than guessed onto a neighbouring clip.

import { throwIfCancelled } from "../../abort-signals.js";
import { forwardFillBearingsIfAllZero } from "../../parser.js";
import { isCoordinateInRange } from "../internal/ddmm.js";
import { type GpsRecord, type ParsedRecords, type SkippedLine, type VendorFile, WrongFormatError } from "../types.js";
import type { Primitive } from "./types.js";

const FORMAT_ID = "csv-70mai-dated";

// Content probing stays limited to text files; the basename is not required
// because copies and exports rename the log while its rows stay self-identifying.
const RX_TEXT_NAME = /\.txt$/i;
const FIELDS_PER_ROW = 8;
const KMH_TO_MS = 1 / 3.6;
const RX_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const RX_SPEED = /^(\d+)km\/h$/;
const RX_COORDINATE = /^-?\d+(?:\.\d+)?$/;
const RX_CLIP_NAME = /^\d{8}-\d{6}-\d+[A-Z]\.MP4$/;
const RX_SENTINEL_NAME = /^0+$/;

// One complete row with this distinctive grammar identifies the log. Other
// rows may be damaged, including a truncated final row after power loss; the
// parser reports those individually without losing the remaining fixes.
const RX_MARKER_ROW =
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},[A-Z],[AV],\d{3}km\/h,\s*-?\d+\.\d+,\s*-?\d+\.\d+,[01],(?:\d{8}-\d{6}-\d+[A-Z]\.MP4|0+)$/;
// One row is ~80 bytes, so the probe always holds several complete lines.
const MARKER_PROBE_BYTES = 512;

// Before 2010 the receiver clock was never synced; no real 70mai recording is
// older. Same floor as csv-70mai.ts.
const MIN_PLAUSIBLE_UNIX_SEC = 1262304000; // 2010-01-01 UTC

export const csv70maiDatedPrimitive: Primitive = {
    id: FORMAT_ID,
    displayName: "70mai dated CSV log",
    kind: "log-sidecar",

    async marker(file: VendorFile): Promise<boolean> {
        if (!RX_TEXT_NAME.test(file.file.name)) return false;
        const head = (await file.file.slice(0, MARKER_PROBE_BYTES).text()).replace(/^\uFEFF/, "");
        const lines = head.split(/\r?\n/);
        // The last piece is cut by the probe boundary unless the file ends here.
        if (file.file.size > MARKER_PROBE_BYTES) lines.pop();
        const rows = lines.map((line) => line.trim()).filter((line) => line !== "");
        // A versioned log belongs to csv-70mai even if it contains a stray
        // dated row; accepting damaged rows must not override its signature.
        if (rows.some((row) => row.startsWith("$V"))) return false;
        return rows.some((row) => RX_MARKER_ROW.test(row));
    },

    async parse(file: VendorFile, _index, signal): Promise<ParsedRecords> {
        throwIfCancelled(signal);
        const text = await file.file.text();
        throwIfCancelled(signal);
        return parseDatedLog(text, file.file.name);
    },
};

// Parses one log. Throws WrongFormatError when no line has the dated row shape
// (the marker matched, but the contents belong to another format).
function parseDatedLog(text: string, sourceFilename: string): ParsedRecords {
    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];
    const recordsByClip = new Map<string, GpsRecord[]>();
    let rowsWithShape = 0;

    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]!;
        if (raw.trim() === "") continue;
        const parsed = parseRow(raw);
        if ("error" in parsed) {
            skipped.push({ line: i + 1, raw, reason: parsed.error });
            continue;
        }
        rowsWithShape++;
        if (parsed.record === null) continue;
        records.push(parsed.record);
        let clipRecords = recordsByClip.get(parsed.record.mp4Filename);
        if (!clipRecords) {
            clipRecords = [];
            recordsByClip.set(parsed.record.mp4Filename, clipRecords);
        }
        clipRecords.push(parsed.record);
    }
    if (rowsWithShape === 0) {
        throw new WrongFormatError(`no dated 70mai gps rows in ${sourceFilename}`);
    }
    // The log has no course. Infer it per clip: one whole-card log spans many
    // recordings, and a heading must not point from one clip into the next.
    for (const clipRecords of recordsByClip.values()) forwardFillBearingsIfAllZero(clipRecords);
    return { records, skipped };
}

// `record: null` = a row of this format that carries no usable fix (void or
// placeholder), dropped without a diagnostic. `error` = a row we cannot use;
// the reason lands in skipped and the row does not count as evidence of the
// format for WrongFormatError.
type RowResult = { record: GpsRecord | null } | { error: string };

function parseRow(raw: string): RowResult {
    const parts = raw.trim().split(",");
    if (parts.length !== FIELDS_PER_ROW) {
        return { error: `expected ${FIELDS_PER_ROW} fields, got ${parts.length}` };
    }
    if (!/^[A-Z]$/.test(parts[1]!) || !/^[01]$/.test(parts[6]!)) return { error: "bad row flags" };
    const status = parts[2]!;
    if (status === "V") {
        return RX_MARKER_ROW.test(raw.trim()) ? { record: null } : { error: "bad no-fix row" };
    }
    if (status !== "A") return { error: `bad validity flag ${JSON.stringify(status)}` };

    const unixSeconds = parseUtcTimestamp(parts[0]!);
    if (unixSeconds === null) return { error: "bad timestamp" };
    if (unixSeconds < MIN_PLAUSIBLE_UNIX_SEC) return { error: "implausible timestamp" };

    const speed = RX_SPEED.exec(parts[3]!);
    if (!speed) return { error: "bad speed" };

    const latText = parts[4]!.trim();
    const lonText = parts[5]!.trim();
    const lat = Number(latText);
    const lon = Number(lonText);
    if (
        !RX_COORDINATE.test(latText) ||
        !RX_COORDINATE.test(lonText) ||
        !isCoordinateInRange(lat, "lat") ||
        !isCoordinateInRange(lon, "lon")
    ) {
        return { error: "bad coordinates" };
    }

    const mp4Filename = parts[7]!.trim();
    if (mp4Filename === "" || RX_SENTINEL_NAME.test(mp4Filename)) {
        return { error: "missing or sentinel mp4 filename" };
    }
    if (!RX_CLIP_NAME.test(mp4Filename)) return { error: "bad mp4 filename" };

    return {
        record: {
            unixSeconds,
            active: true,
            lat,
            lon,
            bearingDeg: 0,
            speedMs: Number(speed[1]) * KMH_TO_MS,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename,
        },
    };
}

// Returns unix seconds for a "YYYY-MM-DD hh:mm:ss" UTC timestamp, or null when
// a component is out of range. Date.UTC would silently roll "2026-13-40" over
// into a valid-looking date, so the components are checked after the round trip.
function parseUtcTimestamp(value: string): number | null {
    const match = RX_TIMESTAMP.exec(value);
    if (!match) return null;
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
        number,
        number,
        number,
        number,
        number,
        number,
    ];
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    const date = new Date(ms);
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day ||
        date.getUTCHours() !== hour ||
        date.getUTCMinutes() !== minute ||
        date.getUTCSeconds() !== second
    ) {
        return null;
    }
    return ms / 1000;
}

// Export for synthetic edge-case tests.
export const _internal = { parseDatedLog, parseRow, parseUtcTimestamp };

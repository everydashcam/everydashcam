// Columnar codec for the raw embedded GPS kept in the index cache. IndexedDB
// stores values by structured clone, whose cost follows the number of objects:
// a whole-card log as one object per record took hundreds of milliseconds to
// clone on every cache read, write and recency touch, where the same facts in a
// few typed arrays clone at memory speed. Everything outside the persist
// boundary keeps working with GpsRecord[]; only this module sees columns.
//
// Writes trust the static GpsRecord types; reads validate the stored columns.
// NaN and Infinity are still `number`, and parser arithmetic does produce them,
// so Float64 columns keep every value bit-exact (-0 included) and validation
// rejects non-finite ones exactly where the per-record check used to.

import type { AccelSample, GpsRecord } from "../parsers/types.js";
import type { CachedAccelColumns, CachedGpsRecordColumns } from "./types.js";

// Per-record flag bits. Optional fields get an explicit presence bit instead of
// a NaN sentinel: trackSegment and relStartSeconds are arithmetic results that
// can come out NaN, and such a record must keep failing validation rather than
// read back with the field silently absent.
const FLAG_ACTIVE = 1 << 0;
const FLAG_HAS_TIME_UNSYNCED = 1 << 1;
const FLAG_TIME_UNSYNCED = 1 << 2;
const FLAG_HAS_TRACK_SEGMENT = 1 << 3;
const FLAG_HAS_REL_START_SECONDS = 1 << 4;
const KNOWN_FLAGS =
    FLAG_ACTIVE | FLAG_HAS_TIME_UNSYNCED | FLAG_TIME_UNSYNCED | FLAG_HAS_TRACK_SEGMENT | FLAG_HAS_REL_START_SECONDS;

type SpeedSource = NonNullable<GpsRecord["speedSource"]>;

// Code 0 is reserved for an absent speedSource, which carries its own meaning
// (the device-parser default), so it is not folded into "measured".
const SPEED_SOURCE_CODES = {
    measured: 1,
    estimated: 2,
    unavailable: 3,
} as const satisfies Record<SpeedSource, number>;
const SPEED_SOURCE_BY_CODE: readonly (SpeedSource | undefined)[] = [undefined, "measured", "estimated", "unavailable"];

const REQUIRED_FLOAT64_COLUMNS = [
    "unixSeconds",
    "lat",
    "lon",
    "bearingDeg",
    "speedMs",
    "accelXg",
    "accelYg",
    "accelZg",
] as const satisfies readonly (keyof CachedGpsRecordColumns)[];

const ACCEL_COLUMNS = [
    "msSinceStart",
    "accelXg",
    "accelYg",
    "accelZg",
] as const satisfies readonly (keyof CachedAccelColumns)[];

/**
 * Packs one file's raw parser records into columns. Session-only fields
 * (ownership, external-track choices, clock bookkeeping) are not stored; the
 * time axis is the parser's own even when the record was already shifted by
 * the local-clock correction. An optional numeric column exists only when at
 * least one record carries that field. The result shares no memory with the
 * input, so later session mutation of the records cannot reach it.
 */
export function packGpsRecordColumns(records: readonly GpsRecord[]): CachedGpsRecordColumns {
    const count = records.length;
    const unixSeconds = new Float64Array(count);
    const lat = new Float64Array(count);
    const lon = new Float64Array(count);
    const bearingDeg = new Float64Array(count);
    const speedMs = new Float64Array(count);
    const accelXg = new Float64Array(count);
    const accelYg = new Float64Array(count);
    const accelZg = new Float64Array(count);
    const flags = new Uint8Array(count);
    const speedSource = new Uint8Array(count);
    const mp4FilenameIndex = new Uint32Array(count);
    const mp4Filenames: string[] = [];
    const filenameIndexByName = new Map<string, number>();
    let trackSegment: Float64Array | undefined;
    let relStartSeconds: Float64Array | undefined;
    for (let i = 0; i < count; i++) {
        const record = records[i]!;
        // Persist the parser's raw axis even if a call site captures this
        // record after applyLocalClockCorrections has already shifted it. The
        // marker is the amount subtracted from unixSeconds, so adding it
        // reverses the session mutation before the marker itself is discarded.
        unixSeconds[i] = record.localClockOffsetAppliedSec
            ? record.unixSeconds + record.localClockOffsetAppliedSec
            : record.unixSeconds;
        lat[i] = record.lat;
        lon[i] = record.lon;
        bearingDeg[i] = record.bearingDeg;
        speedMs[i] = record.speedMs;
        accelXg[i] = record.accelXg;
        accelYg[i] = record.accelYg;
        accelZg[i] = record.accelZg;
        let recordFlags = record.active ? FLAG_ACTIVE : 0;
        if (record.timeUnsynced !== undefined) {
            recordFlags |= FLAG_HAS_TIME_UNSYNCED;
            if (record.timeUnsynced) recordFlags |= FLAG_TIME_UNSYNCED;
        }
        if (record.trackSegment !== undefined) {
            recordFlags |= FLAG_HAS_TRACK_SEGMENT;
            trackSegment ??= new Float64Array(count);
            trackSegment[i] = record.trackSegment;
        }
        if (record.relStartSeconds !== undefined) {
            recordFlags |= FLAG_HAS_REL_START_SECONDS;
            relStartSeconds ??= new Float64Array(count);
            relStartSeconds[i] = record.relStartSeconds;
        }
        flags[i] = recordFlags;
        if (record.speedSource !== undefined) speedSource[i] = SPEED_SOURCE_CODES[record.speedSource];
        let filenameIndex = filenameIndexByName.get(record.mp4Filename);
        if (filenameIndex === undefined) {
            filenameIndex = mp4Filenames.length;
            mp4Filenames.push(record.mp4Filename);
            filenameIndexByName.set(record.mp4Filename, filenameIndex);
        }
        mp4FilenameIndex[i] = filenameIndex;
    }
    const columns: CachedGpsRecordColumns = {
        unixSeconds,
        lat,
        lon,
        bearingDeg,
        speedMs,
        accelXg,
        accelYg,
        accelZg,
        flags,
        speedSource,
        mp4Filenames,
        mp4FilenameIndex,
    };
    if (trackSegment) columns.trackSegment = trackSegment;
    if (relStartSeconds) columns.relStartSeconds = relStartSeconds;
    return columns;
}

/**
 * Rebuilds GpsRecord objects owned by `videoKey`, the restoring session's key
 * for the file. Optional fields appear exactly when they were present at pack
 * time. Precondition: the columns passed isValidGpsRecordColumns; unchecked
 * columns may throw or produce malformed records.
 */
export function unpackGpsRecordColumns(columns: CachedGpsRecordColumns, videoKey: string): GpsRecord[] {
    const { unixSeconds, lat, lon, bearingDeg, speedMs, accelXg, accelYg, accelZg } = columns;
    const { flags, speedSource, trackSegment, relStartSeconds, mp4Filenames, mp4FilenameIndex } = columns;
    const records: GpsRecord[] = [];
    for (let i = 0; i < unixSeconds.length; i++) {
        const recordFlags = flags[i]!;
        const record: GpsRecord = {
            unixSeconds: unixSeconds[i]!,
            active: (recordFlags & FLAG_ACTIVE) !== 0,
            lat: lat[i]!,
            lon: lon[i]!,
            bearingDeg: bearingDeg[i]!,
            speedMs: speedMs[i]!,
            accelXg: accelXg[i]!,
            accelYg: accelYg[i]!,
            accelZg: accelZg[i]!,
            mp4Filename: mp4Filenames[mp4FilenameIndex[i]!]!,
            videoKey,
        };
        const speedSourceCode = speedSource[i]!;
        if (speedSourceCode !== 0) record.speedSource = SPEED_SOURCE_BY_CODE[speedSourceCode];
        if ((recordFlags & FLAG_HAS_TRACK_SEGMENT) !== 0) record.trackSegment = trackSegment![i]!;
        if ((recordFlags & FLAG_HAS_TIME_UNSYNCED) !== 0) {
            record.timeUnsynced = (recordFlags & FLAG_TIME_UNSYNCED) !== 0;
        }
        if ((recordFlags & FLAG_HAS_REL_START_SECONDS) !== 0) record.relStartSeconds = relStartSeconds![i]!;
        records.push(record);
    }
    return records;
}

function isFloat64Column(value: unknown, length: number): value is Float64Array {
    return value instanceof Float64Array && value.length === length;
}

function isFiniteFloat64Column(value: unknown, length: number): value is Float64Array {
    if (!isFloat64Column(value, length)) return false;
    for (let i = 0; i < length; i++) {
        if (!Number.isFinite(value[i])) return false;
    }
    return true;
}

/**
 * Whether a stored value is a well-formed record column set. Guarantees every
 * record unpackGpsRecordColumns builds from it satisfies what restored records
 * have always promised downstream: finite numbers, a boolean fix status and
 * timeUnsynced, a known speedSource, a non-negative integer trackSegment, a
 * finite relStartSeconds, a string mp4Filename, and no session-only fields.
 * Corruption costs a re-index, never a poisoned ingest.
 */
export function isValidGpsRecordColumns(value: unknown): value is CachedGpsRecordColumns {
    if (typeof value !== "object" || value === null) return false;
    const columns = value as Partial<Record<keyof CachedGpsRecordColumns, unknown>>;
    if (!(columns.unixSeconds instanceof Float64Array)) return false;
    const count = columns.unixSeconds.length;
    for (const name of REQUIRED_FLOAT64_COLUMNS) {
        if (!isFiniteFloat64Column(columns[name], count)) return false;
    }
    const { flags, speedSource, trackSegment, relStartSeconds, mp4Filenames, mp4FilenameIndex } = columns;
    if (
        !(flags instanceof Uint8Array) ||
        flags.length !== count ||
        !(speedSource instanceof Uint8Array) ||
        speedSource.length !== count ||
        !(mp4FilenameIndex instanceof Uint32Array) ||
        mp4FilenameIndex.length !== count ||
        (trackSegment !== undefined && !isFloat64Column(trackSegment, count)) ||
        (relStartSeconds !== undefined && !isFloat64Column(relStartSeconds, count)) ||
        !Array.isArray(mp4Filenames) ||
        !mp4Filenames.every((filename) => typeof filename === "string")
    ) {
        return false;
    }
    for (let i = 0; i < count; i++) {
        const recordFlags = flags[i]!;
        if ((recordFlags & ~KNOWN_FLAGS) !== 0) return false;
        // A value bit without its presence bit is not something the packer writes.
        if ((recordFlags & FLAG_TIME_UNSYNCED) !== 0 && (recordFlags & FLAG_HAS_TIME_UNSYNCED) === 0) return false;
        if (speedSource[i]! >= SPEED_SOURCE_BY_CODE.length) return false;
        if (mp4FilenameIndex[i]! >= mp4Filenames.length) return false;
        if ((recordFlags & FLAG_HAS_TRACK_SEGMENT) !== 0) {
            const segment = trackSegment?.[i];
            if (segment === undefined || !Number.isInteger(segment) || segment < 0) return false;
        }
        if ((recordFlags & FLAG_HAS_REL_START_SECONDS) !== 0) {
            const offset = relStartSeconds?.[i];
            if (offset === undefined || !Number.isFinite(offset)) return false;
        }
    }
    return true;
}

/** Packs high-rate accelerometer samples into columns that share no memory
 *  with the input. */
export function packAccelColumns(samples: readonly AccelSample[]): CachedAccelColumns {
    const count = samples.length;
    const columns: CachedAccelColumns = {
        msSinceStart: new Float64Array(count),
        accelXg: new Float64Array(count),
        accelYg: new Float64Array(count),
        accelZg: new Float64Array(count),
    };
    for (let i = 0; i < count; i++) {
        const sample = samples[i]!;
        columns.msSinceStart[i] = sample.msSinceStart;
        columns.accelXg[i] = sample.accelXg;
        columns.accelYg[i] = sample.accelYg;
        columns.accelZg[i] = sample.accelZg;
    }
    return columns;
}

/** Rebuilds fresh AccelSample objects. Precondition: the columns passed
 *  isValidAccelColumns. */
export function unpackAccelColumns(columns: CachedAccelColumns): AccelSample[] {
    const { msSinceStart, accelXg, accelYg, accelZg } = columns;
    const samples: AccelSample[] = [];
    for (let i = 0; i < msSinceStart.length; i++) {
        samples.push({
            msSinceStart: msSinceStart[i]!,
            accelXg: accelXg[i]!,
            accelYg: accelYg[i]!,
            accelZg: accelZg[i]!,
        });
    }
    return samples;
}

/** Whether a stored value is four equal-length Float64 columns of finite
 *  numbers, the same guarantee the per-sample check gave. */
export function isValidAccelColumns(value: unknown): value is CachedAccelColumns {
    if (typeof value !== "object" || value === null) return false;
    const columns = value as Partial<Record<keyof CachedAccelColumns, unknown>>;
    if (!(columns.msSinceStart instanceof Float64Array)) return false;
    const count = columns.msSinceStart.length;
    return ACCEL_COLUMNS.every((name) => isFiniteFloat64Column(columns[name], count));
}

/** Stored payload of a record column set: exact typed-array bytes plus the
 *  filename dictionary at two bytes per UTF-16 code unit. */
export function gpsRecordColumnsByteLength(columns: CachedGpsRecordColumns): number {
    let bytes =
        columns.flags.byteLength +
        columns.speedSource.byteLength +
        columns.mp4FilenameIndex.byteLength +
        (columns.trackSegment?.byteLength ?? 0) +
        (columns.relStartSeconds?.byteLength ?? 0);
    for (const name of REQUIRED_FLOAT64_COLUMNS) bytes += columns[name].byteLength;
    for (const filename of columns.mp4Filenames) bytes += filename.length * 2;
    return bytes;
}

/** Stored payload of accel columns in bytes. */
export function accelColumnsByteLength(columns: CachedAccelColumns): number {
    let bytes = 0;
    for (const name of ACCEL_COLUMNS) bytes += columns[name].byteLength;
    return bytes;
}

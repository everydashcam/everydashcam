// Nextbase `gdat` - Base64-encoded JSON timed GPS in a TOP-LEVEL atom,
// registered on %QuickTime::Main (QuickTime.pm:945-951, v13.55) and decoded by
// Process_gdat (QuickTimeStream.pl:2795-2830, v13.55). Implemented from that
// source, NOT validated against a real sample.
//
// ExifTool attributes the format to "Nextbase software" rather than camera
// firmware, so the likely producer is the MyNextbase desktop app on export -
// worth knowing when hunting for a sample.
//
// Payload: the WHOLE atom is one Base64 blob decoding to ONE JSON object:
//
//   {"cameraModel": "...", "gpsData": [{"datetime": "2023-12-28T23:10:22",
//    "lat": 52.1, "lon": 6.6, "speed": 30, "bearing": 140,
//    "xAcc": .., "yAcc": .., "zAcc": .., "gpsStatus": "A"}, ...]}
//
// Field semantics, all from Process_gdat:
//   - gpsStatus 'A' gates the row, exactly as upstream.
//   - speed is MPH (upstream multiplies by mphToKph).
//   - datetime is ISO-shaped: upstream's `tr/-T/: /` turns `-` into `:` and
//     `T` into a space to reach its own YYYY:MM:DD HH:MM:SS form. It attaches
//     no zone, so UTC is an ASSUMPTION here - a defensible one (the value
//     comes off a GPS receiver, and upstream files it under GPSDateTime, which
//     is UTC by definition) but unverified. An explicit offset or Z in the
//     string IS honored when present.
//   - x/y/zAcc are emitted by upstream as an opaque "x y z" string with no
//     unit or axis order, so they are dropped rather than guessed. Do not
//     borrow the scale from the Nextbase SUBTITLE formats: same vendor, but a
//     different producer writes this one.
//   - cameraModel has no GpsRecord field and is dropped.
//
// Numbers may arrive as JSON numbers or as strings - Perl casts either way, so
// both are accepted here.

import { type GpsRecord, MPH_TO_MS, type ParsedRecords, type SkippedLine } from "../types.js";
import { parseIsoCalendarTime } from "./calendar.js";

/**
 * Base64 of a JSON object starts "e" + one of w/x/y/z: `{` alone fixes the
 * first character, and the second encodes the top 4 bits of the byte after it -
 * 'w' for 0x00-0x0f, 'x' for 0x10-0x1f, 'y' for 0x20-0x2f, 'z' for 0x30-0x3f.
 * That range is every byte that can legally follow `{`, so `{"` and `{ ` ("ey")
 * and an indented dump's `{\n` / `{\r\n` / `{\t` ("ew") all pass - the producer
 * is desktop software, and pinning the gate to compact output would make a
 * pretty-printed track unreachable rather than merely unparsed.
 * Cheap head-of-atom gate; the parse below does the rest.
 */
export function hasNextbaseGdatHead(head: Uint8Array): boolean {
    // Trailing NULs are the box's padding, not payload (decodeBase64Json strips
    // them too) - the alphabet check below must not trip over them.
    const text = new TextDecoder("latin1").decode(head).replace(/\0+$/, "");
    if (text.length < 8) return false;
    if (!/^e[w-z]/.test(text)) return false;
    // Base64 alphabet over the rest of the window - random binary that happens
    // to start with those two characters dies here.
    return /^[A-Za-z0-9+/=\s]+$/.test(text);
}

interface GdatFix {
    datetime?: unknown;
    lat?: unknown;
    lon?: unknown;
    speed?: unknown;
    bearing?: unknown;
    gpsStatus?: unknown;
}

/**
 * Decodes the atom payload. Returns null when the payload is not this format
 * or carries no usable fix, so a caller can fall through.
 */
export function parseNextbaseGdat(payload: Uint8Array, mp4Filename: string): ParsedRecords | null {
    const json = decodeBase64Json(payload);
    if (json === null) return null;

    let root: unknown;
    try {
        root = JSON.parse(json);
    } catch {
        return null;
    }
    if (typeof root !== "object" || root === null) return null;

    const fixes = (root as { gpsData?: unknown }).gpsData;
    if (!Array.isArray(fixes)) return null;

    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];

    for (let i = 0; i < fixes.length; i++) {
        const fix = fixes[i] as GdatFix | null;
        if (typeof fix !== "object" || fix === null) continue;
        // Upstream's gate: anything but a valid fix is not emitted at all.
        if (fix.gpsStatus !== "A") continue;

        const unixSeconds = parseIsoDatetime(fix.datetime);
        if (unixSeconds === null) {
            skipped.push({ line: i + 1, raw: String(fix.datetime ?? ""), reason: "unparseable datetime" });
            continue;
        }

        const lat = toFiniteNumber(fix.lat);
        const lon = toFiniteNumber(fix.lon);
        if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            skipped.push({ line: i + 1, raw: `${String(fix.lat)}/${String(fix.lon)}`, reason: "bad coordinates" });
            continue;
        }
        if (lat === 0 && lon === 0) {
            skipped.push({ line: i + 1, raw: "0/0", reason: "zero coordinates" });
            continue;
        }

        const speedMph = toFiniteNumber(fix.speed);
        const bearing = toFiniteNumber(fix.bearing);
        records.push({
            unixSeconds,
            active: true,
            lat,
            lon,
            bearingDeg: bearing === null ? 0 : ((bearing % 360) + 360) % 360,
            speedMs: speedMph === null || speedMph < 0 ? 0 : speedMph * MPH_TO_MS,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename,
        });
    }

    if (records.length === 0) return null;
    return { records, skipped };
}

/**
 * Base64 payload -> JSON text. Whitespace and the atom's NUL padding are
 * stripped first (atob rejects both); returns null when the result is not
 * decodable.
 */
function decodeBase64Json(payload: Uint8Array): string | null {
    const raw = new TextDecoder("latin1").decode(payload).replace(/[\s\0]+/g, "");
    if (raw.length === 0) return null;
    try {
        const binary = atob(raw);
        // The JSON itself may hold non-ASCII (a camera model with an accent),
        // so go back through bytes rather than trusting atob's latin1 chars.
        return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0) & 0xff));
    } catch {
        return null;
    }
}

/**
 * ISO-shaped datetime -> unix seconds. Assembled through Date.UTC rather than
 * Date.parse on purpose: for a date-time with no zone, Date.parse applies the
 * HOST timezone, which would make the parsed track depend on where the viewer
 * happens to be. An explicit trailing offset is applied when the string has
 * one. Returns null on anything unparseable or out of range.
 */
function parseIsoDatetime(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const parsed = parseIsoCalendarTime(value);
    return parsed === null ? null : parsed.baseMilliseconds / 1000 + parsed.fractionalSeconds - parsed.offsetSeconds;
}

/** JSON number or numeric string -> number; null for anything else. */
function toFiniteNumber(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || value.trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

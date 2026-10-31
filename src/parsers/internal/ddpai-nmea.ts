import { parseCompactTimestamp } from "./calendar.js";
import { dedupByUnixSeconds, parseNmeaText } from "./nmea.js";
import { type GpsRecord, WrongFormatError } from "../types.js";

export const RX_DDPAI_GPX_NAME = /^(\d{14})_(\d{2,7})(?:_[DT])?\.gpx$/i;

/** Pairs a DDPAI `.gpx` name with its MP4; the exact basename (front) outranks the `_A` rear. */
export function matchDdpaiVideo(gpsFilename: string, knownVideos: Iterable<string>): string | null {
    const base = gpsFilename.toLowerCase().replace(/(?:_[dt])?\.gpx$/, "");
    let rear: string | null = null;
    for (const name of knownVideos) {
        const videoBase = name.toLowerCase().replace(/\.mp4$/, "");
        if (videoBase === base) return name;
        if (videoBase === `${base}_a`) rear = name;
    }
    return rear;
}

// Preallocated files keep the previous recording's bytes after the current
// GPS section, which normally ends at the sensor block, the end marker or NUL
// padding. The firmware writes whole lines, so when a cut-short recording
// left no marker the recycled content begins mid-line: the first line without
// a `$` is that write boundary.
const RX_SECTION_END = /\$(?:GSENSORSTARTTIME|GPSENDTIME)\b|\0|\n(?![$\r\n])/;

// Camera clocks are local while RMC is UTC. Any zone plus the clip span still
// rejects a section that replays fixes from another date.
const MAX_ZONE_OFFSET_SEC = 14 * 3600;

/**
 * Parses one DDPAI GPS file or archive member into records for `mp4Filename`.
 * Returns an empty array when the content belongs to another recording (a
 * reused temporary whose header disagrees with its filename) or holds no fix
 * for this one. Throws WrongFormatError for XML so dispatch reaches the GPX
 * parser.
 */
export function parseDdpaiNmea(text: string, gpsFilename: string, mp4Filename: string): GpsRecord[] {
    const trimmed = text.trimStart();
    if (trimmed.startsWith("<")) throw new WrongFormatError("ddpai-gpx: content is XML, not NMEA");

    const end = trimmed.search(RX_SECTION_END);
    const gps = end < 0 ? trimmed : trimmed.slice(0, end);
    const header = /^\$GPSCAMTIME (\d{14})(?:\r?\n|$)/.exec(gps);
    const headerStart = header ? parseCompactTimestamp(header[1]!) : null;
    const name = RX_DDPAI_GPX_NAME.exec(gpsFilename);
    const namedStart = name ? parseCompactTimestamp(name[1]!) : null;
    const durationSec = name ? Number(name[2]) : 0;
    // A reused temporary file can contain an entirely different clip. The
    // header may lag the filename until logging starts; rounding can put it
    // one second before the filename.
    if (
        headerStart !== null &&
        namedStart !== null &&
        (headerStart < namedStart - 1 || headerStart > namedStart + durationSec)
    ) {
        return [];
    }
    // Both are the camera's clock, so the filename keeps the date gate when
    // the header line is missing.
    const start = headerStart ?? namedStart;

    const records: GpsRecord[] = [];
    for (const record of parseNmeaText(gps, mp4Filename).records) {
        if (start !== null && Math.abs(record.unixSeconds - start) > MAX_ZONE_OFFSET_SEC + durationSec) continue;
        // Recycled content was recorded earlier, so a fix running backwards in
        // time starts the previous recording's tail, not more of this clip.
        const previous = records.at(-1);
        if (previous !== undefined && record.unixSeconds < previous.unixSeconds) break;
        records.push(record);
    }
    return dedupByUnixSeconds(records);
}

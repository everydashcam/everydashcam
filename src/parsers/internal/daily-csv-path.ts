import { parseCompactTimestamp } from "./calendar.js";

export interface DailyCsvVideoName {
    startLocalSec: number;
    durationSec: number;
}

export interface DailyCsvVideoPath extends DailyCsvVideoName {
    root: string;
    mode: "normal" | "event";
}

/** Camera-local calendar fields represented without applying the host timezone. */
export function parseDailyCsvTimestamp(value: string): number | null {
    return parseCompactTimestamp(value);
}

/** Duration suffixes are unpadded; padded counters in this layout also occur
 *  on DDPai front/rear recordings and must retain their channel pairing. */
export function parseDailyCsvVideoName(name: string): DailyCsvVideoName | null {
    const match = /^(\d{14})_([1-9]\d{0,4})\.mp4$/i.exec(name);
    if (!match) return null;
    const startLocalSec = parseDailyCsvTimestamp(match[1]!);
    const durationSec = Number(match[2]);
    if (startLocalSec === null || durationSec < 1 || durationSec > 86400) return null;
    return { startLocalSec, durationSec };
}

export function matchDailyCsvVideoPath(relativePath: string): DailyCsvVideoPath | null {
    const match = /^(?:(.*)\/)?(100|101)video\/([^/]+)$/i.exec(relativePath.replaceAll("\\", "/"));
    if (!match) return null;
    const name = parseDailyCsvVideoName(match[3]!);
    if (!name) return null;
    const root = (match[1] ?? "").replace(/(?:^|\/)DCIM$/i, "").toLowerCase();
    return { ...name, root, mode: match[2] === "101" ? "event" : "normal" };
}

/** DDPai channel siblings share this layout. Normalize their suffix only for
 * mode/camera identity; it is not evidence that their counter is a duration. */
export function matchDailyCsvChannelPath(relativePath: string): DailyCsvVideoPath | null {
    return matchDailyCsvVideoPath(relativePath.replace(/_[a-z](?=\.mp4$)/i, ""));
}

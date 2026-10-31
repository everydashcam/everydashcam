// Daily DDmm/hemisphere CSV logs, observed in the Kaiser Baas R50 demo card.
// Source: jgOhYeah/dashcam-viewer README and src/app/{file,gps}.ts,
// commit 492240a16766bc68755b11b2e9af5fb1699b6169. The clock has no timezone;
// associate by local filename windows and keep it out of UTC calibration.

import { forwardFillBearingsIfAllZero } from "../../parser.js";
import { matchDailyCsvVideoPath, parseDailyCsvTimestamp, parseDailyCsvVideoName } from "../internal/daily-csv-path.js";
import { ddmmToDegrees, isCoordinateInRange } from "../internal/ddmm.js";
import { KNOTS_TO_MS, type GpsRecord, type ParsedRecords, type VendorFile, WrongFormatError } from "../types.js";
import type { Primitive, PrimitiveVideoRef } from "./types.js";

const RX_LOG_NAME = /^(\d{8})\.dat$/i;
const RX_NUMBER = /^\d+(?:\.\d+)?$/;
const MARKER_PROBE_BYTES = 1024;

interface CsvRow {
    localSec: number;
    lat: number;
    lon: number;
    speedMs: number;
}

interface VideoWindow {
    name: string;
    videoKey?: string;
    startLocalSec: number;
    durationSec: number;
}

function parseRow(raw: string, date: string): CsvRow | null {
    const fields = raw.split(",").map((field) => field.trim());
    if (fields.length !== 7 || !fields[0]!.startsWith(date)) return null;
    const localSec = parseDailyCsvTimestamp(fields[0]!);
    if (localSec === null || !/^[NS]$/.test(fields[2]!) || !/^[EW]$/.test(fields[4]!)) return null;
    if (![fields[1], fields[3], fields[5]].every((field) => field !== undefined && RX_NUMBER.test(field))) return null;
    // Altitude is optional and is not part of GpsRecord. Validate its syntax so
    // unrelated seven-column DAT files cannot satisfy the format signature.
    if (fields[6] !== "" && !/^-?\d+(?:\.\d+)?$/.test(fields[6]!)) return null;
    const lat = ddmmToDegrees(Number(fields[1])) * (fields[2] === "S" ? -1 : 1);
    const lon = ddmmToDegrees(Number(fields[3])) * (fields[4] === "W" ? -1 : 1);
    const speedMs = Number(fields[5]) * KNOTS_TO_MS;
    if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon") || !Number.isFinite(speedMs)) return null;
    return { localSec, lat, lon, speedMs };
}

function normalizedPath(path: string): string {
    return path.replaceAll("\\", "/");
}

function logCardRoot(file: VendorFile): string | null {
    const match = /^(?:(.*)\/)?gps\/[^/]+$/i.exec(normalizedPath(file.relativePath));
    return match ? (match[1] ?? "").toLowerCase() : null;
}

function videoWindows(source: VendorFile, videos: readonly PrimitiveVideoRef[]): VideoWindow[] {
    const candidates = videos.flatMap((video) => {
        const parsed = parseDailyCsvVideoName(video.name);
        if (!parsed) return [];
        return [{ video, parsed, path: matchDailyCsvVideoPath(video.relativePath) }];
    });
    const root = logCardRoot(source);
    // Nonempty roots survive separate selections. An empty root identifies no
    // card: two root-level folder picks can expose identical DCIM/gps trees.
    let scoped = root ? candidates.filter((candidate) => candidate.path?.root === root) : candidates;
    const hasPreservedCard = Boolean(root && scoped.length > 0);
    if (root && scoped.length === 0) {
        scoped = candidates.filter(
            (candidate) => candidate.path?.root === "" || !normalizedPath(candidate.video.relativePath).includes("/"),
        );
    }
    const sameSource = scoped.filter(
        (candidate) => source.sourceKey !== undefined && candidate.video.sourceKey === source.sourceKey,
    );
    if (!hasPreservedCard && sameSource.length > 0) {
        const roots = new Set(sameSource.map((candidate) => candidate.path?.root));
        const [onlyRoot] = roots;
        scoped =
            roots.size === 1 && onlyRoot ? scoped.filter((candidate) => candidate.path?.root === onlyRoot) : sameSource;
    }
    const identities = new Set(
        scoped.map((candidate) =>
            candidate.path?.root
                ? JSON.stringify(["root", candidate.path.root])
                : JSON.stringify([
                      "source",
                      candidate.video.sourceKey ?? null,
                      candidate.path?.root ??
                          normalizedPath(candidate.video.relativePath).split("/").slice(0, -1).join("/"),
                  ]),
        ),
    );
    if (identities.size > 1) return [];

    const ownerKey = (video: PrimitiveVideoRef) =>
        video.videoKey ?? JSON.stringify([video.sourceKey, video.relativePath]);
    const ownersByPath = new Map<string, string>();
    const hasConflict = scoped.some(({ video }) => {
        const previous = ownersByPath.get(normalizedPath(video.relativePath).toLowerCase());
        const key = ownerKey(video);
        ownersByPath.set(normalizedPath(video.relativePath).toLowerCase(), key);
        return previous !== undefined && previous !== key;
    });
    // Identically named preserved roots can still be two different cards.
    // Keep an explicit picker scope in that case, or leave the log unbound.
    if (hasConflict) {
        if (sameSource.length === 0) return [];
        scoped = sameSource;
    }
    const byOwner = new Map<string, VideoWindow>();
    const scopedPaths = new Map<string, string>();
    for (const { video, parsed } of scoped) {
        const key = ownerKey(video);
        const previous = scopedPaths.get(normalizedPath(video.relativePath).toLowerCase());
        if (previous !== undefined && previous !== key) return [];
        scopedPaths.set(normalizedPath(video.relativePath).toLowerCase(), key);
        byOwner.set(JSON.stringify([key, parsed.startLocalSec, parsed.durationSec]), {
            name: video.name,
            videoKey: video.videoKey,
            ...parsed,
        });
    }
    return [...byOwner.values()].sort((a, b) => a.startLocalSec - b.startLocalSec);
}

export const dailyCsvGpsPrimitive: Primitive = {
    id: "daily-csv-gps",
    displayName: "Daily DDmm CSV log",
    kind: "log-sidecar",
    async marker(file) {
        const name = RX_LOG_NAME.exec(file.file.name);
        if (!name) return false;
        const head = await file.file.slice(0, MARKER_PROBE_BYTES).text();
        const lines = head
            .replace(/^\uFEFF/, "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        // TODO: verify whether a native midnight rollover can omit the initial #.
        return lines[0] === "#" && lines.some((line) => parseRow(line, name[1]!) !== null);
    },
    async parse(file, _index, signal, context): Promise<ParsedRecords> {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        const date = RX_LOG_NAME.exec(file.file.name)?.[1];
        if (!date) throw new WrongFormatError("not a daily csv log filename");
        const lines = (await file.file.text()).replace(/^\uFEFF/, "").split(/\r?\n/);
        if (lines.find((line) => line.trim() !== "")?.trim() !== "#") {
            throw new WrongFormatError("missing daily csv restart marker");
        }
        const windows = videoWindows(file, context?.knownVideos ?? []);
        const result: ParsedRecords = { records: [], skipped: [] };
        const groups = new Map<string, GpsRecord[]>();
        let validRows = 0;
        let segment = -1;
        let previousSec = -Infinity;
        let previousHasFix: boolean | undefined;
        let nextWindow = 0;
        let activeWindows: VideoWindow[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (signal?.aborted) throw new DOMException("aborted", "AbortError");
            const raw = lines[i]!.trim();
            if (raw === "") continue;
            if (raw === "#") {
                segment++;
                previousSec = -Infinity;
                previousHasFix = undefined;
                nextWindow = 0;
                activeWindows = [];
                continue;
            }
            const row = parseRow(raw, date);
            if (!row) {
                result.skipped.push({ line: i + 1, raw, reason: "bad daily csv row" });
                continue;
            }
            validRows++;
            if (row.localSec <= previousSec) {
                result.skipped.push({ line: i + 1, raw, reason: "non-increasing timestamp" });
                continue;
            }
            previousSec = row.localSec;
            const hasFix = row.lat !== 0 || row.lon !== 0;
            // Retain loss samples so clip/day boundaries cannot reconnect a
            // reported gap; a recovered fix also starts fresh bearing inference.
            if (previousHasFix === false && hasFix) segment++;
            previousHasFix = hasFix;
            // Event clips may overlap a normal loop clip. Each clip receives its
            // own relative offsets, with half-open windows at adjacent boundaries.
            activeWindows = activeWindows.filter((window) => row.localSec < window.startLocalSec + window.durationSec);
            while (nextWindow < windows.length && windows[nextWindow]!.startLocalSec <= row.localSec) {
                const window = windows[nextWindow++]!;
                if (row.localSec < window.startLocalSec + window.durationSec) activeWindows.push(window);
            }
            if (activeWindows.length === 0) {
                result.skipped.push({ line: i + 1, raw, reason: "no video for gps timestamp" });
                continue;
            }
            for (const owner of activeWindows) {
                const record: GpsRecord = {
                    unixSeconds: row.localSec,
                    active: hasFix,
                    lat: row.lat,
                    lon: row.lon,
                    speedMs: hasFix ? row.speedMs : 0,
                    ...(hasFix ? {} : { speedSource: "unavailable" as const }),
                    bearingDeg: 0,
                    accelXg: 0,
                    accelYg: 0,
                    accelZg: 0,
                    mp4Filename: owner.name,
                    videoKey: owner.videoKey,
                    timeUnsynced: true,
                    relStartSeconds: row.localSec - owner.startLocalSec,
                    trackSegment: segment,
                    trackSegmentSource: file.file.name.toLowerCase(),
                };
                const key = JSON.stringify([owner.videoKey ?? owner.name, segment]);
                let group = groups.get(key);
                if (!group) {
                    group = [];
                    groups.set(key, group);
                }
                group.push(record);
                result.records.push(record);
            }
        }
        if (validRows === 0) throw new WrongFormatError("no daily csv gps rows");
        for (const group of groups.values()) forwardFillBearingsIfAllZero(group);
        return result;
    },
};

import { throwIfCancelled } from "../../abort-signals.js";
import { upperBoundBy } from "../../sorted-search.js";
// Whole-card GPS log used by the 360CARDVR firmware family. The file is a
// preallocated JSON-lines buffer: meaningful rows end at the first NUL byte,
// and a `360GPSINFO` footer near EOF records the used-byte count.
//
// Only the first row carries a local wall-clock. Later rows advance at a fixed
// five-second cadence, and the log spans many loop-recording MP4 files. Parsing
// therefore needs the video-name snapshot supplied by the ingest worker: each
// point is assigned to the filename window containing its local clock, then
// emitted timeUnsynced + relStartSeconds so the normal video clock pipeline
// anchors it without mistaking the camera-local timestamp for UTC.

import { parseCompactTimestamp, utcMillisecondsFromParts } from "../internal/calendar.js";
import { KNOTS_TO_MS, type GpsRecord, type ParsedRecords, type SkippedLine, type VendorFile } from "../types.js";
import { WrongFormatError } from "../types.js";
import type { Primitive, PrimitiveParseContext, PrimitiveVideoRef } from "./types.js";

const FORMAT_ID = "360gps-jsonl";
const RX_LOG_NAME = /^(\d{14})_(\d{6})GPS\.TXT$/i;
const RX_VIDEO_NAME = /^(\d{14})_(\d{6})A([AB])([A-Z])\.MP4$/i;
const RX_LOCAL_TIME = /^(\d{4}):(\d{2}):(\d{2})-(\d{2}):(\d{2}):(\d{2})$/;
const MARKER_PROBE_BYTES = 512;
const RECORD_INTERVAL_SEC = 5;
const DEFAULT_VIDEO_CADENCE_SEC = 60;
const VIDEO_WINDOW_TOLERANCE_SEC = 2;
const MIN_VIDEO_CADENCE_SEC = 10;
const MAX_VIDEO_CADENCE_SEC = 600;

interface SourceRow {
    lat: number;
    lon: number;
    speedKnots: number;
    bearingDeg: number;
    localTime?: string;
}

interface VideoSlot {
    name: string;
    startNaiveSec: number;
    endNaiveSec: number;
}

export const threeSixtyGpsJsonlPrimitive: Primitive = {
    id: FORMAT_ID,
    displayName: "360GPSINFO JSONL log",
    kind: "log-sidecar",

    async marker(file: VendorFile): Promise<boolean> {
        if (!RX_LOG_NAME.test(file.file.name)) return false;
        const head = await file.file.slice(0, MARKER_PROBE_BYTES).text();
        const nul = head.indexOf("\0");
        const firstLine = head.slice(0, nul < 0 ? undefined : nul).split(/\r?\n/)[0];
        if (!firstLine) return false;
        const parsed = parseJsonRow(firstLine);
        return !("error" in parsed) && parsed.row.localTime !== undefined && RX_LOCAL_TIME.test(parsed.row.localTime);
    },

    async parse(file: VendorFile, _index, signal, context): Promise<ParsedRecords> {
        throwIfCancelled(signal);
        const text = await file.file.text();
        throwIfCancelled(signal);
        return parseLog(text, file, context, signal);
    },
};

function parseLog(
    rawText: string,
    source: VendorFile,
    context?: PrimitiveParseContext,
    signal?: AbortSignal,
): ParsedRecords {
    const sourceFilename = source.file.name;
    const nul = rawText.indexOf("\0");
    const text = nul < 0 ? rawText : rawText.slice(0, nul);
    const lines = text.split(/\r?\n/);
    const firstLine = lines.find((line) => line.trim() !== "");
    if (firstLine === undefined) throw new WrongFormatError(`no JSONL records found in ${sourceFilename}`);

    const first = parseJsonRow(firstLine);
    if ("error" in first || first.row.localTime === undefined) {
        throw new WrongFormatError(`no timestamped 360GPSINFO row found in ${sourceFilename}`);
    }
    const anchorNaiveSec = parseLocalTime(first.row.localTime);
    if (anchorNaiveSec === null) {
        throw new WrongFormatError(`bad 360GPSINFO timestamp in ${sourceFilename}`);
    }

    const slots = buildVideoSlots(videoNamesForLog(source, context?.knownVideos ?? []));
    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];
    let sampleIndex = 0;

    for (let i = 0; i < lines.length; i++) {
        throwIfCancelled(signal);
        const raw = lines[i]!.trim();
        if (raw === "") continue;

        const parsed = parseJsonRow(raw);
        const rowNaiveSec = anchorNaiveSec + sampleIndex * RECORD_INTERVAL_SEC;
        sampleIndex++;
        if ("error" in parsed) {
            skipped.push({ line: i + 1, raw, reason: parsed.error });
            continue;
        }
        const row = parsed.row;
        if (isNoFixSentinel(row)) {
            skipped.push({ line: i + 1, raw, reason: "no gps fix" });
            continue;
        }
        if (row.lat < -90 || row.lat > 90 || row.lon < -180 || row.lon > 180) {
            skipped.push({ line: i + 1, raw, reason: "bad coordinates" });
            continue;
        }
        if (row.speedKnots < 0) {
            skipped.push({ line: i + 1, raw, reason: "bad speed" });
            continue;
        }
        if (row.bearingDeg < 0 || row.bearingDeg > 360) {
            skipped.push({ line: i + 1, raw, reason: "bad bearing" });
            continue;
        }

        const slot = findVideoSlot(slots, rowNaiveSec);
        if (slot === null) {
            skipped.push({ line: i + 1, raw, reason: "no video for gps timestamp" });
            continue;
        }
        records.push({
            unixSeconds: rowNaiveSec,
            active: true,
            lat: row.lat,
            lon: row.lon,
            bearingDeg: row.bearingDeg === 360 ? 0 : row.bearingDeg,
            speedMs: row.speedKnots * KNOTS_TO_MS,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: slot.name,
            timeUnsynced: true,
            relStartSeconds: rowNaiveSec - slot.startNaiveSec,
        });
    }

    return { records, skipped };
}

function parseJsonRow(raw: string): { row: SourceRow } | { error: string } {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return { error: "bad json" };
    }
    if (typeof value !== "object" || value === null) return { error: "expected object" };

    if (!("a" in value) || !("o" in value) || !("s" in value) || !("d" in value)) {
        return { error: "missing field" };
    }
    const { a, o, s, d } = value;
    const t = "t" in value ? value.t : undefined;
    if (
        typeof a !== "number" ||
        !Number.isFinite(a) ||
        typeof o !== "number" ||
        !Number.isFinite(o) ||
        typeof s !== "number" ||
        !Number.isFinite(s) ||
        typeof d !== "number" ||
        !Number.isFinite(d)
    ) {
        return { error: "bad numeric field" };
    }
    if (t !== undefined && typeof t !== "string") return { error: "bad timestamp" };
    return {
        row: {
            lat: a,
            lon: o,
            speedKnots: s,
            bearingDeg: d,
            ...(t === undefined ? {} : { localTime: t }),
        },
    };
}

function parseLocalTime(value: string): number | null {
    const match = RX_LOCAL_TIME.exec(value);
    if (!match) return null;
    const ms = utcMillisecondsFromParts(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
        true,
    );
    return ms === null ? null : ms / 1000;
}

function buildVideoSlots(names: readonly string[]): VideoSlot[] {
    interface Candidate {
        name: string;
        startNaiveSec: number;
        sequence: number;
        channel: string;
    }

    const byStart = new Map<number, Candidate[]>();
    for (const name of names) {
        const match = RX_VIDEO_NAME.exec(name);
        if (!match) continue;
        const startNaiveSec = parseCompactTimestamp(match[1]!, true);
        if (startNaiveSec === null) continue;
        let candidates = byStart.get(startNaiveSec);
        if (!candidates) {
            candidates = [];
            byStart.set(startNaiveSec, candidates);
        }
        candidates.push({
            name,
            startNaiveSec,
            sequence: Number(match[2]),
            channel: match[3]!.toUpperCase(),
        });
    }

    const selected = [...byStart.values()]
        .map((items) => items.find((item) => item.channel === "A") ?? items[0]!)
        .sort((a, b) => a.startNaiveSec - b.startNaiveSec);
    const positiveGaps: number[] = [];
    for (let i = 1; i < selected.length; i++) {
        const previous = selected[i - 1]!;
        const current = selected[i]!;
        const sequenceGap = current.sequence - previous.sequence;
        if (sequenceGap <= 0) continue;
        const elapsed = current.startNaiveSec - previous.startNaiveSec;
        // The counter advances per file, so a dual-channel card can jump by
        // two between adjacent starts. Conversely, a partial selection can
        // jump by several starts. Use the observed 60 s loop cadence to tell
        // those cases apart; fall back to the raw counter when the camera is
        // configured for a materially different loop length.
        const defaultCadenceSlots = Math.max(1, Math.round(elapsed / DEFAULT_VIDEO_CADENCE_SEC));
        const sequenceStride = sequenceGap / defaultCadenceSlots;
        const elapsedSlots = Number.isInteger(sequenceStride) ? defaultCadenceSlots : sequenceGap;
        const gap = elapsed / elapsedSlots;
        if (gap >= MIN_VIDEO_CADENCE_SEC && gap <= MAX_VIDEO_CADENCE_SEC) positiveGaps.push(gap);
    }
    positiveGaps.sort((a, b) => a - b);
    const cadence = positiveGaps.length > 0 ? positiveGaps[positiveGaps.length >> 1]! : DEFAULT_VIDEO_CADENCE_SEC;

    return selected.map((item, index) => {
        const next = selected[index + 1];
        const inferredEnd = item.startNaiveSec + cadence + VIDEO_WINDOW_TOLERANCE_SEC;
        return {
            name: item.name,
            startNaiveSec: item.startNaiveSec,
            endNaiveSec: next ? Math.min(next.startNaiveSec, inferredEnd) : inferredEnd,
        };
    });
}

function cardRootSegments(relativePath: string, childFolder: "gps" | "rec"): string[] | null {
    const segments = relativePath.split("/").filter(Boolean);
    const cardIndex = segments.findIndex((segment) => segment.toLowerCase() === "360cardvr");
    if (cardIndex < 0 || segments[cardIndex + 1]?.toLowerCase() !== childFolder) return null;
    return segments.slice(0, cardIndex + 1).map((segment) => segment.toLowerCase());
}

function sameSegments(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

function videoNamesForLog(source: VendorFile, videos: readonly PrimitiveVideoRef[]): string[] {
    const matching = videos.filter((video) => RX_VIDEO_NAME.test(video.name));
    const sameSource =
        source.sourceKey === undefined ? [] : matching.filter((video) => video.sourceKey === source.sourceKey);
    const scoped = sameSource.length > 0 ? sameSource : matching;
    const sourceRoot = cardRootSegments(source.relativePath, "gps");
    if (sourceRoot === null) return scoped.map((video) => video.name);

    const sameCard = scoped.filter((video) => {
        const videoRoot = cardRootSegments(video.relativePath, "rec");
        return videoRoot !== null && sameSegments(videoRoot, sourceRoot);
    });
    if (sameCard.length > 0) return sameCard.map((video) => video.name);

    // A log picked in a later drop has a fresh sourceKey. Its preserved path
    // can still identify the already-loaded card before the basename fallback.
    const crossSourceSameCard = matching.filter((video) => {
        const videoRoot = cardRootSegments(video.relativePath, "rec");
        return videoRoot !== null && sameSegments(videoRoot, sourceRoot);
    });
    return (crossSourceSameCard.length > 0 ? crossSourceSameCard : scoped).map((video) => video.name);
}

function findVideoSlot(slots: readonly VideoSlot[], timestamp: number): VideoSlot | null {
    const index = upperBoundBy(slots, timestamp, (slot) => slot.startNaiveSec) - 1;
    if (index < 0) return null;
    const slot = slots[index]!;
    return timestamp < slot.endNaiveSec ? slot : null;
}

function isNoFixSentinel(row: SourceRow): boolean {
    return row.lat === 99 && row.lon === 999 && row.speedKnots === 99;
}

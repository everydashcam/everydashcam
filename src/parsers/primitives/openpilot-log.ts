// comma.ai openpilot qlog: the per-segment log that comma connect uploads with
// every drive. It carries the GPS track and, for each camera stream, an encode
// index with the boot-clock time of every frame. Video files of a route carry no
// clock at all (raw HEVC, and an MPEG-TS preview without wall time), so this log
// is what dates them: GPS fixes pair boot-clock and UTC, which turns the first
// frame's start-of-frame time into the video's UTC start. The frame count gives
// the duration a raw HEVC stream cannot state without being read whole.
//
// Only qlog is read. rlog holds the same events undecimated (10 Hz GPS instead
// of 1 Hz) at ~20x the size; parsing both would double the track.
// Format notes and layout derivation: docs/format-openpilot.md.

import { throwIfCancelled } from "../../abort-signals.js";
import { createLogger } from "../../log.js";
import { isValidGpsFix } from "../../parser.js";
import { OPENPILOT_GPS_OWNER_STREAMS, type OpenpilotFileName, parseOpenpilotFileName } from "../filename/_patterns.js";
import { OPENPILOT_FRAME_RATE } from "../internal/openpilot.js";
import { type OpenpilotCameraStream, type OpenpilotLog, decodeOpenpilotLog } from "../internal/openpilot-log.js";
import { inflateZstdPrefix } from "../internal/zstd-prefix.js";
import {
    type GpsRecord,
    type ParsedRecords,
    type VendorFile,
    type VideoTimingHint,
    WrongFormatError,
} from "../types.js";
import type { Primitive, PrimitiveVideoRef } from "./types.js";

const FORMAT_ID = "openpilot-log";
const log = createLogger("primitive:openpilot-log");
// A real qlog decompresses to about 2.5 MB per one-minute segment.
const MAX_QLOG_BYTES = 64 * 1024 * 1024;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
// Clocks before this are unsynced placeholders, not drive times; openpilot
// routes in this layout postdate it by years.
const MIN_PLAUSIBLE_UNIX_SEC = 1577836800; // 2020-01-01 UTC
const CAMERA_STREAMS: readonly OpenpilotCameraStream[] = ["fcamera", "ecamera", "dcamera", "qcamera"];

export const openpilotLogPrimitive: Primitive = {
    id: FORMAT_ID,
    displayName: "openpilot qlog",
    kind: "log-sidecar",

    async marker(file: VendorFile): Promise<boolean> {
        if (parseOpenpilotFileName(file)?.stream !== "qlog") return false;
        const head = new Uint8Array(await file.file.slice(0, ZSTD_MAGIC.length).arrayBuffer());
        return ZSTD_MAGIC.every((byte, i) => head[i] === byte);
    },

    async parse(file: VendorFile, _index, signal, context): Promise<ParsedRecords> {
        const name = parseOpenpilotFileName(file);
        if (name?.stream !== "qlog") throw new WrongFormatError("not an openpilot qlog name");
        const compressed = new Uint8Array(await file.file.arrayBuffer());
        throwIfCancelled(signal);
        const inflated = await inflateZstdPrefix(compressed, MAX_QLOG_BYTES);
        if (inflated.kind === "invalid") throw new WrongFormatError("openpilot qlog is not a valid zstd stream");
        if (inflated.kind === "too-large")
            throw new WrongFormatError("openpilot qlog decompresses past its size limit");
        throwIfCancelled(signal);
        const decoded = decodeOpenpilotLog(inflated.bytes);
        if (decoded.messages === 0) throw new WrongFormatError("openpilot qlog holds no capnp messages");
        // A log cut short (crash, power loss, interrupted download) still
        // dates frame 0 and carries the GPS before the cut, but its frame
        // counts stop early: a raw stream keeps its nominal duration instead.
        const isComplete = inflated.complete && decoded.malformedAt === null;
        if (!isComplete) {
            log.warn("openpilot qlog is incomplete", {
                file: file.file.name,
                zstdComplete: inflated.complete,
                malformedAt: decoded.malformedAt,
                messages: decoded.messages,
            });
        }

        const videos = segmentVideos(file, name, context?.knownVideos ?? []);
        // GPS records belong to one loaded camera of the segment, in the owner
        // order later drops resolve by too (openpilotLookupCores).
        const loadedOwner = OPENPILOT_GPS_OWNER_STREAMS.map((stream) => videos.get(stream)).find(
            (video) => video !== undefined,
        );
        const owner = loadedOwner ?? { name: canonicalVideoName(file, name, "fcamera") };
        const records = gpsRecords(decoded, owner);
        const offsetNs = bootToUnixOffsetNs(decoded);
        const videoTimingHints: VideoTimingHint[] = [];
        for (const stream of CAMERA_STREAMS) {
            const frames = decoded.frames.get(stream);
            if (!frames || frames.segment !== name.segment || frames.frameCount === 0) continue;
            const video = videos.get(stream);
            videoTimingHints.push({
                mp4Filename: video?.name ?? canonicalVideoName(file, name, stream),
                ...(video?.videoKey === undefined ? {} : { videoKey: video.videoKey }),
                startUtc:
                    offsetNs !== null && frames.firstFrameSofNs !== null
                        ? (frames.firstFrameSofNs + offsetNs) / 1e9
                        : null,
                // Only raw HEVC lacks its own timestamps. The qcamera.ts
                // preview carries PTS; a truncated preview must keep the
                // duration its bytes support, not the frames the log counted.
                durationSec: stream === "qcamera" || !isComplete ? null : frames.frameCount / OPENPILOT_FRAME_RATE,
            });
        }
        return { records, skipped: [], videoTimingHints };
    },
};

/** GPS fixes as records of the segment's owning video, in time order. */
function gpsRecords(decoded: OpenpilotLog, owner: { name: string; videoKey?: string }): GpsRecord[] {
    const records: GpsRecord[] = [];
    for (const fix of decoded.gps) {
        const unixSeconds = fix.unixMillis / 1000;
        // A fix-less report repeats a stale or zero position; only fixes are track.
        if (!fix.hasFix || unixSeconds < MIN_PLAUSIBLE_UNIX_SEC) continue;
        const record: GpsRecord = {
            unixSeconds,
            active: true,
            lat: fix.lat,
            lon: fix.lon,
            bearingDeg: ((fix.bearingDeg % 360) + 360) % 360,
            speedMs: fix.speedMs,
            speedSource: "measured",
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: owner.name,
            ...(owner.videoKey === undefined ? {} : { videoKey: owner.videoKey }),
        };
        // The zstd stream has no checksum: a flipped bit on the card reaches
        // the fix as a coordinate off the globe.
        if (isValidGpsFix(record)) records.push(record);
    }
    return records.sort((a, b) => a.unixSeconds - b.unixSeconds);
}

/**
 * Offset that turns the device's boot clock (logMonoTime, frame timestamps)
 * into Unix nanoseconds. GPS fixes pair both clocks directly; the median
 * absorbs per-fix publish latency. Without a fix the system clock stands in,
 * but only samples openpilot itself marks valid: an unsynced device reports
 * its OS build date, which is recent enough to pass any fixed floor (timed.py
 * publishes clocks with valid = system_time_valid()). A fix is published tens
 * of milliseconds after it is taken, so the result runs early by that latency.
 */
function bootToUnixOffsetNs(decoded: OpenpilotLog): number | null {
    const fromGps = decoded.gps
        .filter((fix) => fix.hasFix && fix.unixMillis / 1000 >= MIN_PLAUSIBLE_UNIX_SEC)
        .map((fix) => fix.unixMillis * 1e6 - fix.monoNs);
    if (fromGps.length > 0) return median(fromGps);
    const fromClock = decoded.wallClock
        .filter((sample) => sample.isValid && sample.unixNanos / 1e9 >= MIN_PLAUSIBLE_UNIX_SEC)
        .map((sample) => sample.unixNanos - sample.monoNs);
    return fromClock.length > 0 ? median(fromClock) : null;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Loaded videos of the log's segment, by stream: same route, segment and
 * route folder. The log's own source wins; a log dropped later carries a
 * fresh source key, so any source is the fallback.
 */
function segmentVideos(
    logFile: VendorFile,
    name: OpenpilotFileName,
    knownVideos: readonly PrimitiveVideoRef[],
): Map<OpenpilotCameraStream, PrimitiveVideoRef> {
    const matching = knownVideos.filter((video) => {
        const videoName = parseOpenpilotFileName({ file: { name: video.name }, relativePath: video.relativePath });
        return (
            videoName !== null &&
            videoName.route === name.route &&
            videoName.segment === name.segment &&
            videoName.routeDir === name.routeDir
        );
    });
    const sameSource = matching.filter(
        (video) => logFile.sourceKey !== undefined && video.sourceKey === logFile.sourceKey,
    );
    const byStream = new Map<OpenpilotCameraStream, PrimitiveVideoRef>();
    for (const video of sameSource.length > 0 ? sameSource : matching) {
        const stream = parseOpenpilotFileName({ file: { name: video.name }, relativePath: video.relativePath })!.stream;
        if (stream === "qlog" || stream === "rlog" || byStream.has(stream)) continue;
        byStream.set(stream, video);
    }
    return byStream;
}

/** Name a segment's video has in the log's own layout, for a video that is not
 *  loaded yet. A browser's repeated-download suffix is not predictable and stays off. */
function canonicalVideoName(logFile: VendorFile, name: OpenpilotFileName, stream: OpenpilotCameraStream): string {
    const extension = stream === "qcamera" ? "ts" : "hevc";
    if (logFile.file.name.toLowerCase().startsWith("qlog")) return `${stream}.${extension}`;
    const prefix = logFile.file.name.slice(0, logFile.file.name.indexOf("_"));
    return `${prefix}_${name.route}--${name.segment}--${stream}.${extension}`;
}

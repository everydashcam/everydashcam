// Range/record selection helpers shared by the export pipelines AND the eager
// UI (export panel summary, blur tracking, trim bar). Split out of export.ts on
// purpose: export.ts carries value imports of mediabunny + the transcode audio
// stack, and a static import of it from any eagerly-loaded UI module drags that
// whole graph (~450 KB min) into the landing entry chunk. This module must stay
// dependency-light - no mediabunny value imports, no transcode imports (types
// are fine). See vite-plugins/lazy-boundaries.ts for the build-time guard.

import type { AudioCodec } from "mediabunny";

import { isValidGpsFix } from "./parser.js";
import type { Channel, GpsRecord } from "./parsers/types.js";
import { serializeGpx } from "./parsers/sidecars/gpx.js";
import type { Trip, TripTimeline, VideoCandidate } from "./trips.js";
import {
    contentToWallUtc,
    displayClockDate,
    frameMediaOffset,
    tripCandidatesByChannel,
    wallToContentSec,
    wallToContentSecIfCovered,
} from "./trips.js";

export interface FileSegment {
    file: File;
    startInFile: number;
    endInFile: number;
    /**
     * The file's start on the FOOTAGE (content) axis. On that axis files are
     * contiguous by construction (pauses are removed), so this is the cumulative
     * footage offset where the file begins. Consumers map a segment back to
     * absolute trip-time via contentToWallUtc(timeline, tripStart + offset).
     */
    tripStart: number;
    /**
     * Estimated frame rate of the whole source file, or null when the indexer
     * could not determine it. Carried on the segment so the encode budget and
     * the frame count can be derived from the files a range actually touches
     * (see rangeSourceFps) instead of assuming a fixed rate.
     */
    fps: number | null;
    /** Duration of the WHOLE source file, not of this slice. Together with
     *  file.size it gives the file's own average bitrate (rangeSourceBitrateBps). */
    fileDurationSec: number;
}

export interface AudioTrackFormat {
    codec: AudioCodec | null;
    sampleRate: number;
    numberOfChannels: number;
}

/** Canonical footage-axis anchor shared by decode and displayed-frame clocks. */
export function candidateContentStart(
    timeline: TripTimeline,
    candidate: Pick<VideoCandidate, "startUtc" | "driftLeadSec">,
): number {
    return wallToContentSec(timeline, candidate.startUtc) + (candidate.driftLeadSec ?? 0);
}

/**
 * Slices [startContentSec, endContentSec] (footage axis) into segments from the
 * given VideoCandidate list for one channel. Each segment is the portion of one
 * file that overlaps the range. Files are placed on the content axis via the
 * trip timeline (a file's footage start = wallToContentSec(v.startUtc)), so
 * recording pauses do not occupy range space. Exported for transcode/pipeline.ts
 * - the same selection logic is needed for stream-copy and decode/encode.
 */
export function sliceCandidatesForRange(
    candidates: VideoCandidate[],
    timeline: TripTimeline,
    startContentSec: number,
    endContentSec: number,
): FileSegment[] {
    return candidatesInRange(candidates, timeline, startContentSec, endContentSec).map(({ candidate, fileStart }) => ({
        file: candidate.file,
        startInFile: Math.max(0, startContentSec - fileStart),
        endInFile: Math.min(candidate.durationSec, endContentSec - fileStart),
        tripStart: fileStart,
        fps: candidate.fps,
        fileDurationSec: candidate.durationSec,
    }));
}

/** Matches the player's interval ownership when independently cut files overlap. */
export function sliceTripChannelForRange(
    trip: Trip,
    channel: Channel,
    startContentSec: number,
    endContentSec: number,
): FileSegment[] {
    if (!trip.frames.some((frame) => frame.mediaOffsetSec)) {
        return sliceCandidatesForRange(
            tripCandidatesByChannel(trip, channel),
            trip.timeline,
            startContentSec,
            endContentSec,
        );
    }
    const slices: FileSegment[] = [];
    for (const segment of trip.timeline.segments) {
        const from = Math.max(startContentSec, segment.contentStart);
        const to = Math.min(endContentSec, segment.contentEnd);
        if (from >= to) continue;
        const frame = trip.frames[segment.frameIndex]!;
        const candidate = frame.channels[channel];
        if (!candidate) continue;
        const fileOffset = frameMediaOffset(frame, channel);
        const startInFile = fileOffset + from - segment.contentStart;
        const endInFile = Math.min(candidate.durationSec, fileOffset + to - segment.contentStart);
        if (startInFile >= endInFile) continue;
        const tripStart = segment.contentStart - fileOffset;
        const previous = slices.at(-1);
        if (
            previous?.file === candidate.file &&
            Math.abs(previous.endInFile - startInFile) < 0.000001 &&
            Math.abs(previous.tripStart - tripStart) < 0.000001
        ) {
            previous.endInFile = endInFile;
        } else {
            slices.push({
                file: candidate.file,
                startInFile,
                endInFile,
                tripStart,
                fps: candidate.fps,
                fileDurationSec: candidate.durationSec,
            });
        }
    }
    return slices;
}

/**
 * The candidates whose footage overlaps [startContentSec, endContentSec] on the
 * content axis, each with its resolved footage start. The placement half of
 * sliceCandidatesForRange, exposed separately for consumers that need the
 * candidates themselves (e.g. the export decode preflight checking canPlay)
 * rather than file slices.
 */
export function candidatesInRange(
    candidates: VideoCandidate[],
    timeline: TripTimeline,
    startContentSec: number,
    endContentSec: number,
): Array<{ candidate: VideoCandidate; fileStart: number }> {
    const out: Array<{ candidate: VideoCandidate; fileStart: number }> = [];
    for (const v of candidates) {
        // A single file never spans a pause, so its footage span is contiguous:
        // [fileStart, fileStart + durationSec] on the content axis. driftLeadSec
        // shifts a drift-corrected channel's file later by its measured content
        // lead (see channel-drift.ts): the request for an early position then
        // lands in the PREVIOUS file's tail, which is where the matching content
        // actually is. Consecutive placements stay monotonic (the lead grows a
        // few ms per file), so the early-break below remains valid.
        const fileStart = candidateContentStart(timeline, v);
        if (endContentSec <= fileStart) break;
        if (startContentSec >= fileStart + v.durationSec) continue;
        out.push({ candidate: v, fileStart });
    }
    return out;
}

/**
 * Frame rate the export should run at for a set of segments: the highest rate
 * among the files the range touches, or null when no file reports one.
 *
 * The max, not the average: a range that mixes a 30 fps and a 60 fps file must
 * be budgeted (and counted) for the busiest file, otherwise the 60 fps stretch
 * gets half the bits per frame it needs. Implausible values are ignored - an
 * indexer estimate from a handful of packets can come out absurd on a variable
 * frame rate file, and a bad rate here would inflate the encode budget.
 */
export function rangeSourceFps(segments: readonly FileSegment[]): number | null {
    let best: number | null = null;
    for (const seg of segments) {
        const fps = seg.fps;
        if (fps === null || !Number.isFinite(fps) || fps <= 0 || fps > MAX_PLAUSIBLE_FPS) continue;
        if (best === null || fps > best) best = fps;
    }
    return best;
}

// Above this a reported frame rate is treated as a bad estimate rather than a
// real capture rate. High-speed footage exists but no dashcam writes it, and
// the value only ever feeds a bitrate budget and a frame count.
const MAX_PLAUSIBLE_FPS = 240;

/**
 * Average source video bitrate (bps) across the files a range touches, weighted
 * by how much of each file the range uses.
 *
 * Why not the whole trip: a camera writes variable bitrate, so a busy stretch
 * (city, rain, night) runs well above the trip mean - and that is exactly the
 * stretch a user trims out and exports. Sizing the re-encode from the trip mean
 * targets below the source's local rate precisely on the frames that matter.
 *
 * Per-file granularity is the honest limit here: file.size is all we have
 * without walking sample tables, so a slice inside one file is assumed to carry
 * that file's average rate. Dashcam files are 1-3 minutes, so this still tracks
 * the range far more closely than a trip-wide mean. The figure includes the
 * file's audio and telemetry bytes - an over-estimate of the video rate, which
 * is the safe direction for a quality target.
 *
 * Returns 0 for an empty range (no segments, or no usable durations).
 */
export function rangeSourceBitrateBps(segments: readonly FileSegment[]): number {
    let weightedBits = 0;
    let usedSec = 0;
    for (const seg of segments) {
        const sliceSec = seg.endInFile - seg.startInFile;
        if (sliceSec <= 0 || seg.fileDurationSec < 0.001) continue;
        const fileBitrate = (seg.file.size * 8) / seg.fileDurationSec;
        weightedBits += fileBitrate * sliceSec;
        usedSec += sliceSec;
    }
    return usedSec >= 0.001 ? weightedBits / usedSec : 0;
}

/**
 * GPS records covered by footage whose content-axis projection falls inside
 * [startContentSec, endContentSec]. Single source of truth
 * for "which points belong to this clip" - shared by buildClipGpx (the .gpx
 * itself) and the export panel's GPS-track summary, so the point count the user
 * sees matches the file they get.
 */
export function clipRecordsForRange(trip: Trip, startContentSec: number, endContentSec: number): GpsRecord[] {
    return trip.records.filter((r) => {
        if (!isValidGpsFix(r)) return false;
        const c = wallToContentSecIfCovered(trip.timeline, r.unixSeconds);
        return c !== null && c >= startContentSec && c <= endContentSec;
    });
}

/**
 * Builds a GPX from trip records within the selected range, expressed on the
 * FOOTAGE (content) axis so the track matches the gap-collapsed video clip.
 * Exported for the transcode path - the same sidecar formatter is needed for
 * both stream-copy and transcode (same checkbox).
 */
export function buildClipGpx(trip: Trip, startContentSec: number, endContentSec: number): string {
    const inRange = clipRecordsForRange(trip, startContentSec, endContentSec);
    const startUtc = contentToWallUtc(trip.timeline, startContentSec);
    const trackName = `everydashcam clip ${formatClockForGpxTrackName(startUtc, trip.cameraTzSec)}`;
    return serializeGpx({ records: inRange, trackName });
}

/**
 * Display-clock date+time string for the GPX <name> element (camera clock
 * when known - matches the trip header the user exported from). NOT used for
 * filenames - those use clipBasename from ui/format.ts with "start-end" range
 * and midnight-crossing handling.
 */
function formatClockForGpxTrackName(unixSeconds: number, cameraTzSec: number | null): string {
    const d = displayClockDate(unixSeconds, cameraTzSec);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// Wire payloads exchanged between ui/blur-track.ts and
// workers/tracker-worker.ts (blur-zone auto-tracking pass).
//
// The request carries plain data only: pre-sliced file segments (the main
// thread owns trip/timeline math via sliceCandidatesForRange) and the seed
// box. Results come back as decimated keyframes on the trip content axis,
// ready for replaceGeneratedKeyframes.

import type { OrtAssets } from "../tracking/ort-assets.js";
import type { DetectionQuality } from "../tracking/detection-sampling.js";
import type { TimeInterval } from "../tracking/interval-set.js";
import type { SourceFrameTiming } from "../tracking/propagated-track.js";
import type { CropRect } from "../transcode/compose.js";

/** One decode window within one source file, positioned on the content axis. */
export interface TrackSegment {
    file: File;
    /** In-file decode window, seconds. */
    startInFile: number;
    endInFile: number;
    /** The segment's file start on the trip content axis (seg.tripStart):
     *  contentSec = tripStart + inFileSec. */
    tripStart: number;
}

export interface TrackRequestData {
    /** Ordered segments covering [seedContentSec, endContentSec]. */
    segments: TrackSegment[];
    /** Where tracking starts: the seed keyframe's time and rect. */
    seedContentSec: number;
    seedRect: CropRect;
    /** Track until here (the zone's endSec). */
    endContentSec: number;
    /** Same-origin URL of the vittrack ONNX model. Resolved on the main
     *  thread so the worker stays free of app config. */
    modelUrl: string;
    /** Same-origin module and verified WASM parts for this runtime. */
    ortAssets: OrtAssets;
}

/** Push notification: pass progress, 0..1 of the requested time span. */
export interface TrackProgressData {
    fractionDone: number;
}

export interface TrackResultKeyframe {
    contentSec: number;
    rect: CropRect;
}

export interface TrackResult {
    /** Decimated keyframes (time- and movement-thresholded), sorted. May be
     *  empty when the first frame already failed to decode. */
    keyframes: TrackResultKeyframe[];
    /** Requested end on completion, the observed departure on a confirmed
     *  exit, or the last reliable target position on an uncertain end. */
    trackedUntilSec: number;
    /** Why tracking ended. `exited` is a confidently confirmed frame-edge
     *  departure; `lost` includes confidence collapse, an uncertain EOF tail
     *  and an unexpectedly short decode. Callers can safely trim only exited;
     *  a lost tail must hold the last cover to the requested end. */
    endReason: "completed" | "exited" | "lost";
}

export const TRACK_REQUEST = "track";
export const TRACK_NOTIFY_STARTED = "track-started";
export const TRACK_NOTIFY_PROGRESS = "track-progress";

// --- Detection pass (the "blur all plates / faces" checkboxes) --------------

export type DetectKind = "plate" | "face";

/** One channel's detection pass over a requested range. Kinds share detector
 *  discovery; ViTTrack follows detected objects backward and forward between scans.
 *  Segments cover [startContentSec, endContentSec] for ONE channel -
 *  the UI client requests each source ownership window separately for caching. */
export interface DetectRequestData {
    segments: TrackSegment[];
    startContentSec: number;
    endContentSec: number;
    kinds: DetectKind[];
    /** Discovery cadence; tracking fills the intervals between detector scans. */
    quality: DetectionQuality;
    /** Per kind: complete ranges requiring analysis. The client sends the full
     *  requested range on a cache miss, or [] when an enclosing pass is cached. */
    analyzeIntervalsByKind: Partial<Record<DetectKind, TimeInterval[]>>;
    /** Same-origin detector model URLs, resolved on the main thread. */
    plateModelUrl: string;
    faceModelUrl: string;
    /** Same-origin ViTTrack model for following detector seeds. */
    trackerModelUrl: string;
    /** Shared runtime for detector WebGPU sessions and ViTTrack's WASM session. */
    ortAssets: OrtAssets;
}

/** Push notification: pass progress, 0..1 of the requested time span. */
export interface DetectProgressData {
    fractionDone: number;
}

/** Detector and trusted tracker positions in normalized, coverage-padded source
 *  coordinates. Interpolated positions are expanded to actual source frames;
 *  keyframes use hold interpolation for the duration of each source frame.
 *  detHits/bestScore retain the detector evidence for diagnostics. */
export interface DetectResultTrack {
    detHits: number;
    bestScore: number;
    startSec: number;
    endSec: number;
    keyframes: Array<{ contentSec: number; rect: CropRect }>;
}

/** Pass effort counters, per kind. The client logs them once per pass - the
 *  arbiter for "the pass feels slow" field reports: which kind ate the time
 *  (detector inference versus object tracking and decoding). */
export interface DetectPassStats {
    /** Source frames this kind's detector ran on (full tile grid). */
    scans: number;
    /** Tile inferences across those scans. */
    tiles: number;
    /** Subset of scans/tiles used to verify an actual sparse tracker loss. */
    recoveryScans?: number;
    recoveryTiles?: number;
    /** Wall ms inside the detector. */
    inferMs: number;
    /** Tracker update calls across this kind's objects, in both directions. */
    trackUpdates: number;
    /** Subset of tracker update calls made backward from detector seeds. */
    backwardUpdates: number;
    /** Wall ms inside the tracker, in both directions. */
    trackMs: number;
}

export interface DetectResult {
    tracksByKind: Partial<Record<DetectKind, DetectResultTrack[]>>;
    statsByKind: Partial<Record<DetectKind, DetectPassStats>>;
    /** Sorted unique displayed source frames on the content axis, shared by
     * both detector kinds. Durations include a verified held final-video tail.
     * Geometry keyframes can be compressed, so cached trims need these exact
     * intervals to retain only the source frame displayed at the new start. */
    sourceFrames: SourceFrameTiming[];
    /** Decoded samples delivered to the pass, including repeated visits.
     * Internal decoder preroll/prefetch frames are not counted. */
    decodedFrames: number;
    /** Whole-pass wall ms, decode included. */
    passMs: number;
    /** Shared pipeline timings. Phase totals include detector/tracker time;
     * decode waits exclude work already completed by decoder prefetch. */
    timings?: {
        forwardMs: number;
        backwardMs: number;
        decodeWaitMs: number;
        /** Shared display-canvas draw calls, excluding later GPU readback.
         * Per-object crop preparation is included in each kind's trackMs. */
        drawMs: number;
    };
}

export const DETECT_REQUEST = "detect";
export const DETECT_NOTIFY_STARTED = "detect-started";
export const DETECT_NOTIFY_PROGRESS = "detect-progress";

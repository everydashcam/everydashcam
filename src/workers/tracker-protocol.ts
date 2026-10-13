// Wire payloads exchanged between ui/blur-track.ts and
// workers/tracker-worker.ts (blur-zone auto-tracking pass).
//
// The request carries plain data only: pre-sliced file segments (the main
// thread owns trip/timeline math via sliceCandidatesForRange) and the seed
// box. Results come back as decimated keyframes on the trip content axis,
// ready for replaceGeneratedKeyframes.

import type { OrtAssets } from "../tracking/ort-assets.js";
import type { TimeInterval } from "../tracking/interval-set.js";
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

/** One channel's detection pass over the export range. Kinds share the decode:
 *  one native-resolution sweep, each requested detector runs per analyzed
 *  frame. Segments cover [startContentSec, endContentSec] for ONE channel -
 *  the client fires a request per exported channel. */
export interface DetectRequestData {
    segments: TrackSegment[];
    startContentSec: number;
    endContentSec: number;
    kinds: DetectKind[];
    /** Per kind: the sub-ranges of [startContentSec, endContentSec] that need
     *  decode + inference; the caller's track cache covers the rest. A shrunk
     *  range sends empty lists - the pass returns nothing new and the client
     *  serves cached tracks. */
    analyzeIntervalsByKind: Partial<Record<DetectKind, TimeInterval[]>>;
    /** Same-origin model URLs, resolved on the main thread (blur-assets.ts owns
     *  them). Plate/face present for every requested kind; trackerModelUrl is the
     *  vittrack model the pass follows each detected object with between scans. */
    plateModelUrl: string;
    faceModelUrl: string;
    trackerModelUrl: string;
    /** Same-origin module and verified WASM parts for this runtime. */
    ortAssets: OrtAssets;
}

/** Push notification: pass progress, 0..1 of the requested time span. */
export interface DetectProgressData {
    fractionDone: number;
}

/** One confirmed object track (see tracking/detect-track.ts). Rects are
 *  normalized source coords, already padded for coverage - ready to become an
 *  auto blur region's keyframes. detHits/bestScore are confirmation evidence
 *  for the forensic track dump (threshold field reports). */
export interface DetectResultTrack {
    detHits: number;
    bestScore: number;
    startSec: number;
    endSec: number;
    keyframes: Array<{ contentSec: number; rect: CropRect }>;
}

/** Pass effort counters, per kind. The client logs them once per pass - the
 *  arbiter for "the pass feels slow" field reports: which kind ate the time
 *  (discovery scans vs the per-object tracker), versus the decode share. */
export interface DetectPassStats {
    /** Discovery-scan frames this kind's detector ran on (full tile grid). */
    scans: number;
    /** Tile inferences across those scans. */
    tiles: number;
    /** Wall ms inside the detector. */
    inferMs: number;
    /** Tracker update calls across this kind's tracked objects. */
    trackUpdates: number;
    /** Wall ms inside the tracker. */
    trackMs: number;
}

export interface DetectResult {
    tracksByKind: Partial<Record<DetectKind, DetectResultTrack[]>>;
    statsByKind: Partial<Record<DetectKind, DetectPassStats>>;
    /** Frames decoded over the pass (the kinds share the decode). */
    decodedFrames: number;
    /** Whole-pass wall ms, decode included. */
    passMs: number;
}

export const DETECT_REQUEST = "detect";
export const DETECT_NOTIFY_STARTED = "detect-started";
export const DETECT_NOTIFY_PROGRESS = "detect-progress";

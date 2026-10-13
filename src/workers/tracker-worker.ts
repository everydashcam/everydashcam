// Blur-zone auto-tracking pass: sequential reduced-resolution decode of the
// zone's span (mediabunny CanvasSink) + vittrack inference per frame, emitting
// observed keyframes on the trip content axis.
//
// Deliberately a DEDICATED worker, not frame-extract: that worker serializes
// its handlers, and a multi-second pass inside its gate would block chart
// thumbnails for the whole duration. Decoder budget: this pass holds exactly
// one Input at a time (segments open sequentially); combined with the
// frame-extract LRU this stays inside Chromium's global VideoDecoder limit.
//
// The tracker session is cached across requests (model fetch + session create
// is ~200 ms; re-tracks after a correction are the common case). The DECODE
// side opens fresh per request - files change between passes.

import { CanvasSink, Input } from "mediabunny";
import { getInputTimeOrigin } from "../media-time.js";

import { analysisIntervalTransition } from "../tracking/analysis-interval.js";
import { boxToRect, visibleBoxRect } from "../tracking/box-geometry.js";
import { finalizeFollowEndReason, followEdgeEndReason } from "../tracking/follow-end.js";
import { chooseAnalysisWidth } from "../tracking/analysis-resolution.js";
import { type TileRect, tileRects } from "../tracking/detect-common.js";
import { weakDetectionCanReanchor } from "../tracking/detection-anchor.js";
import {
    type ConfirmOptions,
    type DetectedTrack,
    finalizeTrack,
    type FinalizeOptions,
    matchDetectionsToTracks,
    type TrackKeyframe,
} from "../tracking/detect-track.js";
import { type TimeInterval, totalIntervalSec, unionIntervals } from "../tracking/interval-set.js";
import { createFaceDetector } from "../tracking/face-detector.js";
import type { OrtAssets } from "../tracking/ort-assets.js";
import { type OrtRuntime } from "../tracking/ort-runtime.js";
import { createPlateDetector } from "../tracking/plate-detector.js";
import { boxVisibleFraction, EXIT_CONFIRM_SEC, EXIT_VISIBLE_FRACTION } from "../tracking/track-guards.js";
import { appendTrackObservation, type PendingTrackHold, recordTrackHold } from "../tracking/track-observations.js";
import { type VitTrack, VitTrackerSession, VITTRACK_SCORE_THRESHOLD, type TrackBox } from "../tracking/vittrack.js";
import { createBlobSource } from "../blob-source.js";
import { VIDEO_INPUT_FORMATS } from "../video-formats.js";
import type { CropRect } from "../transcode/compose.js";

import {
    DETECT_NOTIFY_PROGRESS,
    DETECT_NOTIFY_STARTED,
    DETECT_REQUEST,
    type DetectKind,
    type DetectRequestData,
    type DetectResult,
    type DetectResultTrack,
    TRACK_NOTIFY_PROGRESS,
    TRACK_NOTIFY_STARTED,
    TRACK_REQUEST,
    type TrackRequestData,
    type TrackResult,
    type TrackResultKeyframe,
} from "./tracker-protocol.js";
import { createWorkerServer, type RequestContext, type WorkerScopeEndpoint } from "./_protocol/worker-server.js";

declare const self: WorkerScopeEndpoint;

/** Target analysis rate. Inference (the pass's dominant cost - single-thread
 *  WASM, ~95% of the work) runs only ~this many times per second, NOT on every
 *  decoded frame: a plate/face moves little between 15 fps steps, so this roughly
 *  halves-to-thirds the pass at little quality cost. Decode still advances at the
 *  clip's native rate (cheap, 7-36x realtime); we just skip most inferences. The
 *  guards + loss ride-out are time-based (dt), so they hold at any value here -
 *  lower to go faster, raise to hold fast motion better. */
const ANALYSIS_FPS = 15;
const ANALYSIS_MIN_INTERVAL_SEC = 1 / ANALYSIS_FPS;
/** How long the target may stay below-confidence before the pass declares it
 *  lost. Rides out a real occlusion (a pole, a sign, a passing truck, glare) and
 *  resumes covering the subject when it reappears. The box freezes until the
 *  last uncertain frame, then follows the recovered observation. An uncertain
 *  Follow ending keeps the last cover through the requested tail and asks for
 *  review. Time-based, so it holds independent of ANALYSIS_FPS. */
const LOSS_RIDE_OUT_SEC = 3;
/** Padding added to every emitted (auto-tracked) box, as a fraction of its own
 *  size. vittrack tends to under-size the target as it moves/zooms, so the raw
 *  box can clip a plate/face edge; a small margin keeps the redaction covering.
 *  Over-covering a hair is the safe failure for a privacy feature. The tracker's
 *  own internal box (its search window) is NOT padded - only what we paint. */
const TRACK_COVERAGE_MARGIN_PCT = 0.08;
/** Progress notification throttle (matches the transcode reporter cadence). */
const PROGRESS_THROTTLE_MS = 200;

const cachedSessions = new Map<string, VitTrackerSession>();

async function getTrackerSession(
    ortRuntime: OrtRuntime,
    modelUrl: string,
    assets: OrtAssets,
): Promise<VitTrackerSession> {
    const key = `${ortRuntime}|${assets.moduleUrl}|${modelUrl}`;
    const cached = cachedSessions.get(key);
    if (cached) return cached;
    const session = await VitTrackerSession.create(ortRuntime, modelUrl, assets);
    // Follow and detection use separate runtime builds. Retain both sessions:
    // replacing one on every mode switch leaks its native ORT allocation.
    cachedSessions.set(key, session);
    return session;
}

// Detector sessions cached like the tracker's: session create is a one-time
// cost, and a range/channel change re-running the pass is the common case.
// Detection (both kinds) is WebGPU-only by product decision - the UI disables
// the checkboxes without an adapter (blur-detect.ts), so a webgpu create
// failing HERE despite the main-thread probe (adapter missing/broken in this
// worker) fails the pass loudly instead of silently delivering an unusably
// slow wasm one (face ~600 ms/tile, plate ~140 ms/tile single-thread).
const detectorFactories = { plate: createPlateDetector, face: createFaceDetector };
const cachedDetectors = new Map<DetectKind, { key: string; detector: FrameDetector }>();

async function getDetector(kind: DetectKind, modelUrl: string, assets: OrtAssets): Promise<FrameDetector> {
    const key = `${assets.moduleUrl}|${modelUrl}`;
    const cached = cachedDetectors.get(kind);
    if (cached?.key === key) return cached.detector;
    const detector = await detectorFactories[kind]("webgpu", modelUrl, assets);
    cachedDetectors.set(kind, { key, detector });
    return detector;
}

function rectToBox(rect: CropRect, frameW: number, frameH: number): TrackBox {
    return {
        x: Math.round(rect.xPct * frameW),
        y: Math.round(rect.yPct * frameH),
        w: Math.max(2, Math.round(rect.wPct * frameW)),
        h: Math.max(2, Math.round(rect.hPct * frameH)),
    };
}

async function runTrackPass(
    req: TrackRequestData & { regionId?: string },
    signal: AbortSignal,
    notifyProgress: (fractionDone: number) => void,
): Promise<TrackResult> {
    // Follow runs the tracker on the plain wasm build (where it is validated).
    const vitTrack = await getTrackerSession("wasm", req.modelUrl, req.ortAssets).then((s) => s.newTrack());
    const span = Math.max(1e-6, req.endContentSec - req.seedContentSec);

    const keyframes: TrackResultKeyframe[] = [];
    const pendingHold: PendingTrackHold = { previousSec: null, latestSec: null };
    let initialized = false;
    let lastAnalyzedSec = req.seedContentSec;
    let lossStartedSec: number | null = null;
    let exitStartedSec: number | null = null;
    let endReason: TrackResult["endReason"] = "completed";
    let lastGoodSec = req.seedContentSec;
    let lastProgressAt = 0;

    outer: for (const seg of req.segments) {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        // First segment starts at the seed; later segments decode whole windows.
        const seedLocal = Math.max(seg.startInFile, req.seedContentSec - seg.tripStart);
        const endLocal = Math.min(seg.endInFile, req.endContentSec - seg.tripStart);
        if (endLocal - seedLocal <= 0) continue;

        const input = new Input({
            source: await createBlobSource(seg.file, signal),
            formats: VIDEO_INPUT_FORMATS,
        });
        try {
            const track = await input.getPrimaryVideoTrack();
            if (!track) continue;
            const displayW = await track.getDisplayWidth().catch(() => 0);
            const displayH = await track.getDisplayHeight().catch(() => 0);
            // Small seeds decode wider so the crops see real pixels, not smudge
            // (see analysis-resolution.ts).
            const width = chooseAnalysisWidth(req.seedRect, Math.round(displayW), Math.round(displayH));
            // CanvasSink folds display-matrix rotation into the decode, so the
            // canvas matches what the user marked on (same as frame-extract).
            // poolSize 1: every canvas is fully consumed (all pixel reads happen
            // inside its loop iteration, before the next frame is pulled), so one
            // reused canvas keeps VRAM constant at the wider decode widths.
            const sink = new CanvasSink(track, { width, poolSize: 1 });
            const timeOrigin = await getInputTimeOrigin(input);
            for await (const wrapped of sink.canvases(seedLocal + timeOrigin, endLocal + timeOrigin)) {
                if (signal.aborted) throw new DOMException("aborted", "AbortError");
                const contentSec = seg.tripStart + wrapped.timestamp - timeOrigin;
                // Progress tracks decode position, so the bar stays smooth over the
                // frames we skip for inference.
                const now = performance.now();
                if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
                    lastProgressAt = now;
                    notifyProgress(Math.min(1, (contentSec - req.seedContentSec) / span));
                }
                const frame = wrapped.canvas as OffscreenCanvas;
                if (!initialized) {
                    vitTrack.init(frame, frame.width, frame.height, rectToBox(req.seedRect, frame.width, frame.height));
                    initialized = true;
                    lastAnalyzedSec = contentSec;
                    lastGoodSec = Math.max(req.seedContentSec, contentSec);
                    appendTrackObservation(keyframes, pendingHold, lastGoodSec, req.seedRect);
                    continue;
                }
                // Temporal subsampling: analyze at ~ANALYSIS_FPS, not every decoded
                // frame. Decode still advances every frame (cheap); we skip the
                // expensive inference between analysis ticks.
                const dtSec = contentSec - lastAnalyzedSec;
                if (dtSec < ANALYSIS_MIN_INTERVAL_SEC) continue;
                lastAnalyzedSec = contentSec;

                const { box, score, rejected } = await vitTrack.update(frame, frame.width, frame.height, dtSec);
                // Frame-exit: an approaching target always leaves through a frame
                // edge. Once the box is mostly outside, end the pass right there -
                // BEFORE the loss ride-out, and on frozen boxes too: keeping a
                // mostly-out box alive leaves the confidence peak nothing but own
                // bodywork to lock onto, which is the balloon this prevents. The
                // ride-out is for mid-frame occlusions; an edge exit is not one.
                const visibleFraction = boxVisibleFraction(box, frame.width, frame.height);
                if (visibleFraction < EXIT_VISIBLE_FRACTION) {
                    exitStartedSec ??= contentSec;
                    if (contentSec - exitStartedSec >= EXIT_CONFIRM_SEC) {
                        endReason = followEdgeEndReason(
                            visibleFraction,
                            !rejected && score >= VITTRACK_SCORE_THRESHOLD,
                        );
                        break outer;
                    }
                } else {
                    exitStartedSec = null;
                }
                if (rejected || score < VITTRACK_SCORE_THRESHOLD) {
                    // Low confidence OR a rejected implausible step (identity
                    // switch / balloon): the box did not move. Ride out a brief
                    // occlusion; a long enough loss means the target is gone.
                    recordTrackHold(pendingHold, contentSec);
                    lossStartedSec ??= contentSec;
                    if (contentSec - lossStartedSec >= LOSS_RIDE_OUT_SEC) {
                        endReason = "lost";
                        break outer;
                    }
                } else {
                    const rect = visibleBoxRect(box, frame.width, frame.height, TRACK_COVERAGE_MARGIN_PCT);
                    if (!rect) {
                        recordTrackHold(pendingHold, contentSec);
                        continue;
                    }
                    lossStartedSec = null;
                    lastGoodSec = contentSec;
                    appendTrackObservation(keyframes, pendingHold, contentSec, rect);
                }
            }
        } finally {
            input.dispose();
        }
    }

    // A confidence/edge ride-out that reaches EOF before its confirmation
    // window is still an UNCERTAIN tail, not a successful pass. Likewise, a
    // decoder that stops materially before the requested end must fail closed.
    // Label both lost so the client holds the last known cover to the end.
    endReason = finalizeFollowEndReason(endReason, {
        initialized,
        lossPending: lossStartedSec !== null,
        exitPending: exitStartedSec !== null,
        requestedEndSec: req.endContentSec,
        lastAnalyzedSec,
        analysisIntervalSec: ANALYSIS_MIN_INTERVAL_SEC,
    });

    return {
        keyframes,
        // Keep subsampled source frames covered through the observed departure,
        // not merely through the preceding reliable (still visible) rectangle.
        trackedUntilSec:
            endReason === "completed" ? req.endContentSec : endReason === "exited" ? lastAnalyzedSec : lastGoodSec,
        endReason,
    };
}

// --- Detection pass ("blur all plates / faces") -----------------------------
//
// Detector-seeded, tracker-followed, re-anchored. The detector SCANS the full
// tile grid at a slow flat cadence (discovery); between scans a per-object
// vittrack follows every hit frame-by-frame; each new scan re-anchors matched
// tracks on compatible detector boxes and seeds fresh ones. Track observations
// retain motion between scans and hold the last known box through uncertainty.
// detect-track.ts owns association, confirmation, and final span decisions.

/** Discovery scan cadence, per kind - flat, no ROI/boost scheduler. One hit is
 *  enough to seed a bidirectional cover (backward hold + forward track), so
 *  discovery only has to catch an object once. 1 fps is the current product
 *  budget, not a labeled-corpus result: the exploratory footage suggested a
 *  plate often stays detectable for ~1-2 s, but brief oncoming plates can be
 *  missed. That is an accepted gap (closed with a manual zone), not established
 *  recall performance. */
const DETECT_SCAN_FPS: Record<DetectKind, number> = { plate: 1, face: 1 };

/** IoU gate for a detection continuing a live track. The tracker box is advanced
 *  BEFORE matching (current at the scan), so a real continuation overlaps
 *  strongly; lenient because re-anchoring an existing track always beats
 *  spawning a duplicate cover for the same object. */
const DETECT_MATCH_MIN_IOU = 0.2;

/** Product score floors - what a detection must clear to SEED a new track or
 *  count as confirmation evidence (detHits / bestScore). The static-FP source is
 *  billboards and road signs: no confirmation step can cut a
 *  static false positive (hit count and tracker-sustain both reward static
 *  objects, which track better than real plates), so this floor is the only
 *  gate. Plate 0.6 is deliberately conservative: all seven s608-only boxes
 *  above it in the small local comparison were plates, but the corpus has no
 *  exhaustive ground truth, so this is not a measured precision/recall optimum.
 *  Face 0.45 keeps the clear close-range band seen in the exploratory sample;
 *  it is likewise not derived from a labeled validation set.
 *
 *  Detections BELOW this floor (down to the detectors' raw junk floors) have
 *  exactly one power: RE-ANCHORING an IoU-matched live track. A live track is
 *  already-accepted evidence, and a weak detection overlapping its current box
 *  is far more likely the same object at a bad angle than fresh junk. Without
 *  them the seed floor would also break the re-anchor cadence the tracker
 *  needs: a tight tiny box searches only ~1.5 of its own sizes per step
 *  (vittrack's crop factor), unaided it loses any laterally-moving plate, and
 *  the next strong hit no longer IoU-matches the frozen box - the track
 *  fragments into per-scan snippets. Weak re-anchors do NOT touch
 *  detHits/bestScore: geometry maintenance, not confirmation evidence. */
const DETECT_SEED_SCORE_MIN: Record<DetectKind, number> = { plate: 0.6, face: 0.45 };

/** Backward/forward hold around the tracked span (detect-track.finalizeTrack).
 *  Backward bridges the discovery lag (object approaching, still too small to
 *  detect) and is sized to it: the worst case is one full scan interval
 *  (1 / DETECT_SCAN_FPS), so both kinds hold exactly that - shorter would leave
 *  a readable-but-not-yet-scanned window uncovered, longer re-creates the
 *  "cover parked on empty road" field bug (the renderer holds the first rect
 *  through the whole window). Forward covers the gap between the last confident
 *  position and where the object left. Both HOLD the edge rect - no velocity
 *  walk (that was the flying-cover bug); the tracker already observed the real
 *  between-scan path. */
const DETECT_EXTEND_BACK_SEC: Record<DetectKind, number> = { plate: 1.0, face: 1.0 };
const DETECT_EXTEND_FWD_SEC = 0.7;

/** Confirmation per kind (detect-track.isTrackConfirmed). confirmTrackSec is the
 *  tracker-sustain corroboration a single weak hit needs at sparse discovery - a
 *  real plate lets the tracker follow it, flicker does not. Faces DISABLE it
 *  (Infinity): the face FP source is static traffic-light lenses, which the
 *  tracker WOULD lock onto, so faces confirm only on hits (3 - the field-tuned
 *  bar) or one unmistakable hit (0.7, above the bake-off's 0.59 light ceiling).
 *  NOTE: NOTHING in this ladder can cut a static false positive (billboard,
 *  road sign) - hit count and sustain both reward static objects, which track
 *  better than real plates. That gate is DETECT_SEED_SCORE_MIN (see its note).
 *  The plate seed floor sits ABOVE confirmStrongScore, so every seedable plate
 *  hit confirms on its own - accepted: a hit clearing that floor is
 *  unmistakable by construction, and instant confirm preserves the fast
 *  oncoming plate that exits the frame with one hit and less than
 *  confirmTrackSec of sustain. Faces keep a working ladder (their seed floor
 *  stays below their strong bar): mid-band face hits still need the 3-hit
 *  corroboration. */
const DETECT_CONFIRM: Record<DetectKind, ConfirmOptions> = {
    plate: { confirmMinHits: 2, confirmStrongScore: 0.45, confirmTrackSec: 0.4 },
    face: { confirmMinHits: 3, confirmStrongScore: 0.7, confirmTrackSec: Number.POSITIVE_INFINITY },
};

/** Coverage padding of the emitted box (raw detector or tracker), per kind. A
 *  plate edge peeking out of the mosaic is the failure that matters, but the
 *  padding is capped (a bloated cover reads badly); faces get more - a tight
 *  "face" box excludes hair/profile that still identifies. */
const DETECT_MARGIN_PCT: Record<DetectKind, number> = { plate: 0.12, face: 0.35 };

interface FrameDetector {
    detect(
        frame: CanvasImageSource,
        frameW: number,
        frameH: number,
        tiles: readonly TileRect[],
    ): Promise<Array<{ x: number; y: number; w: number; h: number; score: number }>>;
}

/** One object being followed within one decode interval. */
interface LiveTrack {
    vit: VitTrack;
    keyframes: TrackKeyframe[];
    pendingHold: PendingTrackHold;
    /** A scale-budget split must not project its new box back over the old identity. */
    startClampSec: number;
    /** Content time of this track's last tracker update (for dt). */
    lastAnalyzedSec: number;
    detHits: number;
    bestScore: number;
    trackedGoodSec: number;
    lossStartedSec: number | null;
    exitStartedSec: number | null;
}

async function runDetectPass(
    req: DetectRequestData,
    signal: AbortSignal,
    notifyProgress: (fractionDone: number) => void,
): Promise<DetectResult> {
    const passStartMs = performance.now();
    const statsByKind: DetectResult["statsByKind"] = {};
    for (const kind of req.kinds) statsByKind[kind] = { scans: 0, tiles: 0, inferMs: 0, trackUpdates: 0, trackMs: 0 };

    // Decode covers only the union of the kinds' analyze intervals - the
    // incremental contract: the caller's track cache owns the rest of the range,
    // a shrunk range decodes nothing. Interval-outer iteration keeps content time
    // monotonic; the tracker cannot bridge the gap between two intervals, so
    // every live track is finalized at an interval boundary.
    const decodeIntervals = unionIntervals(Object.values(req.analyzeIntervalsByKind).flat());
    // Fully-cached request (e.g. a shrunk range): nothing to decode, so do not
    // touch the models - on a cold worker their load costs seconds for a
    // guaranteed-empty result.
    if (decodeIntervals.length === 0) {
        const emptyByKind: DetectResult["tracksByKind"] = {};
        for (const kind of req.kinds) emptyByKind[kind] = [];
        return {
            tracksByKind: emptyByKind,
            statsByKind,
            decodedFrames: 0,
            passMs: Math.round(performance.now() - passStartMs),
        };
    }
    const decodeTotalSec = Math.max(1e-6, totalIntervalSec(decodeIntervals));

    // The tracker rides the detectors' webgpu (asyncify) runtime on its wasm EP,
    // so the pass loads ONE ort build (see VitTrackerSession.create).
    const trackerSession = await getTrackerSession("webgpu", req.trackerModelUrl, req.ortAssets);
    const detectors = new Map<DetectKind, FrameDetector>();
    const live = new Map<DetectKind, LiveTrack[]>();
    const finished = new Map<DetectKind, DetectedTrack[]>();
    const lastScanSec = new Map<DetectKind, number>();
    const activeIntervals = new Map<DetectKind, TimeInterval | null>();
    for (const kind of req.kinds) {
        detectors.set(
            kind,
            await getDetector(kind, kind === "plate" ? req.plateModelUrl : req.faceModelUrl, req.ortAssets),
        );
        live.set(kind, []);
        finished.set(kind, []);
        lastScanSec.set(kind, Number.NEGATIVE_INFINITY);
        activeIntervals.set(kind, null);
    }

    let decodedFrames = 0;

    let lastProgressAt = 0;
    let decodeDoneSec = 0;

    // Confirmed -> a DetectedTrack, flicker -> dropped. clampEnd bounds the
    // forward hold to the decoded interval so a cover never leaks into
    // un-analyzed (or a cached interval's) frames.
    const finish = (kind: DetectKind, track: LiveTrack, clampStartSec: number, clampEndSec: number): void => {
        const done = finalizeTrack(
            {
                detHits: track.detHits,
                bestScore: track.bestScore,
                trackedGoodSec: track.trackedGoodSec,
                keyframes: track.keyframes,
            },
            {
                ...DETECT_CONFIRM[kind],
                extendBackSec: DETECT_EXTEND_BACK_SEC[kind],
                extendForwardSec: DETECT_EXTEND_FWD_SEC,
                clampStartSec: Math.max(clampStartSec, track.startClampSec),
                clampEndSec,
            } satisfies FinalizeOptions,
        );
        if (done) finished.get(kind)!.push(done);
    };
    const finishLive = (kind: DetectKind, bounds: TimeInterval, endSec = bounds.endSec): void => {
        for (const track of live.get(kind)!) finish(kind, track, bounds.startSec, Math.min(bounds.endSec, endSec));
        live.set(kind, []);
    };

    for (const interval of decodeIntervals) {
        // Live tracks carry PIXEL-space tracker state (template crop, last box)
        // across segment boundaries; a mid-trip resolution change would misplace
        // every one of them, so on a dims change they are finalized (their
        // emitted keyframes are normalized - still valid) and tracking restarts
        // from the next scan's detections.
        let intervalFrameW = 0;
        let intervalFrameH = 0;
        for (const seg of req.segments) {
            if (signal.aborted) throw new DOMException("aborted", "AbortError");
            const startLocal = Math.max(seg.startInFile, interval.startSec - seg.tripStart);
            const endLocal = Math.min(seg.endInFile, interval.endSec - seg.tripStart);
            if (endLocal - startLocal <= 0) continue;

            const input = new Input({
                source: await createBlobSource(seg.file, signal),
                formats: VIDEO_INPUT_FORMATS,
            });
            try {
                const vtrack = await input.getPrimaryVideoTrack();
                if (!vtrack) continue;
                // NATIVE resolution: the tile grid preserves small-object
                // detectability (detect-common.ts), and the tracker crops its
                // search window from the same native pixels. poolSize 1 keeps one
                // reused canvas (fully consumed per iteration).
                const sink = new CanvasSink(vtrack, { poolSize: 1 });
                // Frame dims are constant within a segment - the scan grid is
                // built once (lazily, only when a scan actually fires).
                let segTiles: TileRect[] | null = null;
                const timeOrigin = await getInputTimeOrigin(input);
                for await (const wrapped of sink.canvases(startLocal + timeOrigin, endLocal + timeOrigin)) {
                    if (signal.aborted) throw new DOMException("aborted", "AbortError");
                    const contentSec = seg.tripStart + wrapped.timestamp - timeOrigin;
                    const now = performance.now();
                    if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
                        lastProgressAt = now;
                        notifyProgress(
                            Math.min(1, (decodeDoneSec + Math.max(0, contentSec - interval.startSec)) / decodeTotalSec),
                        );
                    }
                    const frame = wrapped.canvas as OffscreenCanvas;
                    const frameW = frame.width;
                    const frameH = frame.height;
                    decodedFrames++;
                    if (intervalFrameW !== 0 && (frameW !== intervalFrameW || frameH !== intervalFrameH)) {
                        for (const kind of req.kinds) {
                            const active = activeIntervals.get(kind);
                            if (active) finishLive(kind, active, contentSec);
                            lastScanSec.set(kind, Number.NEGATIVE_INFINITY);
                        }
                    }
                    intervalFrameW = frameW;
                    intervalFrameH = frameH;

                    for (const kind of req.kinds) {
                        const {
                            active,
                            finished: ended,
                            started,
                        } = analysisIntervalTransition(
                            activeIntervals.get(kind) ?? null,
                            req.analyzeIntervalsByKind[kind] ?? [],
                            contentSec,
                        );
                        if (ended) finishLive(kind, ended);
                        activeIntervals.set(kind, active);
                        if (started) lastScanSec.set(kind, Number.NEGATIVE_INFINITY);
                        if (!active) continue;
                        const liveTracks = live.get(kind)!;
                        const stat = statsByKind[kind]!;

                        // 1) Advance live trackers to this frame (brings boxes
                        //    current for matching; drives loss / frame-exit). Walk
                        //    backward - a finished track is spliced out here.
                        for (let i = liveTracks.length - 1; i >= 0; i--) {
                            const track = liveTracks[i]!;
                            const dt = contentSec - track.lastAnalyzedSec;
                            if (dt < ANALYSIS_MIN_INTERVAL_SEC) continue;
                            track.lastAnalyzedSec = contentSec;
                            const t0 = performance.now();
                            const { box, score, rejected } = await track.vit.update(frame, frameW, frameH, dt);
                            stat.trackMs += performance.now() - t0;
                            stat.trackUpdates++;
                            // Frame-exit: an approaching target leaves through an
                            // edge - end the track there (before the loss ride-out
                            // and on frozen boxes), else the peak balloons onto
                            // bodywork (see track-guards.ts).
                            if (boxVisibleFraction(box, frameW, frameH) < EXIT_VISIBLE_FRACTION) {
                                track.exitStartedSec ??= contentSec;
                                if (contentSec - track.exitStartedSec >= EXIT_CONFIRM_SEC) {
                                    finish(kind, track, active.startSec, active.endSec);
                                    liveTracks.splice(i, 1);
                                    continue;
                                }
                            } else {
                                track.exitStartedSec = null;
                            }
                            if (rejected || score < VITTRACK_SCORE_THRESHOLD) {
                                // Occlusion / implausible step: ride out a brief
                                // loss, end a long one.
                                recordTrackHold(track.pendingHold, contentSec);
                                track.lossStartedSec ??= contentSec;
                                if (contentSec - track.lossStartedSec >= LOSS_RIDE_OUT_SEC) {
                                    finish(kind, track, active.startSec, active.endSec);
                                    liveTracks.splice(i, 1);
                                }
                            } else {
                                const rect = visibleBoxRect(box, frameW, frameH, DETECT_MARGIN_PCT[kind]);
                                if (!rect) {
                                    recordTrackHold(track.pendingHold, contentSec);
                                    continue;
                                }
                                track.lossStartedSec = null;
                                track.trackedGoodSec += dt;
                                appendTrackObservation(track.keyframes, track.pendingHold, contentSec, rect);
                            }
                        }

                        // 2) Discovery scan at the flat cadence: detect, then
                        //    re-anchor matched tracks / seed fresh ones.
                        if (contentSec - lastScanSec.get(kind)! < 1 / DETECT_SCAN_FPS[kind]) continue;
                        lastScanSec.set(kind, contentSec);
                        segTiles ??= tileRects(frameW, frameH);
                        stat.scans++;
                        stat.tiles += segTiles.length;
                        const t0 = performance.now();
                        const detections = await detectors.get(kind)!.detect(frame, frameW, frameH, segTiles);
                        stat.inferMs += performance.now() - t0;
                        if (detections.length === 0) continue;

                        const observations = detections.flatMap((box) => {
                            const padded = visibleBoxRect(box, frameW, frameH, DETECT_MARGIN_PCT[kind]);
                            return padded ? [{ box, rect: boxToRect(box, frameW, frameH), padded }] : [];
                        });
                        const trackBoxes = liveTracks.map((tr) => boxToRect(tr.vit.box, frameW, frameH));
                        const matchedTrack = matchDetectionsToTracks(
                            observations.map((observation) => observation.rect),
                            trackBoxes,
                            {
                                minIou: DETECT_MATCH_MIN_IOU,
                            },
                        );
                        for (let d = 0; d < observations.length; d++) {
                            const { box, padded } = observations[d]!;
                            const score = box.score;
                            const seedable = score >= DETECT_SEED_SCORE_MIN[kind];
                            const ti = matchedTrack[d]!;
                            // Sub-floor with no live track to maintain: junk (or
                            // an object not yet worth a track) - ignore.
                            if (ti < 0 && !seedable) continue;
                            const matched = ti >= 0 ? liveTracks[ti]! : null;
                            if (matched && !seedable && !weakDetectionCanReanchor(box, matched.vit.box)) continue;
                            if (matched?.vit.reanchor(frame, frameW, frameH, box)) {
                                const track = matched;
                                track.lastAnalyzedSec = contentSec;
                                track.lossStartedSec = null;
                                track.exitStartedSec = null;
                                if (seedable) {
                                    // Only full-floor hits are confirmation
                                    // evidence - a weak re-anchor is geometry
                                    // maintenance (see DETECT_SEED_SCORE_MIN).
                                    track.detHits++;
                                    track.bestScore = Math.max(track.bestScore, score);
                                }
                                appendTrackObservation(track.keyframes, track.pendingHold, contentSec, padded);
                            } else {
                                // Weak evidence cannot renew an exhausted size
                                // budget. A strong hit starts a new trajectory,
                                // preserving genuine growth without bridging an
                                // identity/scale change with interpolated boxes.
                                if (!seedable) continue;
                                if (matched) finish(kind, matched, active.startSec, contentSec);
                                const vit = trackerSession.newTrack();
                                vit.init(frame, frameW, frameH, box);
                                const track: LiveTrack = {
                                    vit,
                                    keyframes: [],
                                    pendingHold: { previousSec: null, latestSec: null },
                                    startClampSec: matched ? contentSec : active.startSec,
                                    lastAnalyzedSec: contentSec,
                                    detHits: 1,
                                    bestScore: score,
                                    trackedGoodSec: 0,
                                    lossStartedSec: null,
                                    exitStartedSec: null,
                                };
                                appendTrackObservation(track.keyframes, track.pendingHold, contentSec, padded);
                                if (ti >= 0) liveTracks[ti] = track;
                                else liveTracks.push(track);
                            }
                        }
                    }
                }
            } finally {
                input.dispose();
            }
        }
        // Interval boundary: content time jumps - finalize every live track,
        // clamped to this interval, and reset for the next one. An object
        // straddling the boundary splits into per-interval tracks that confirm
        // independently - the accepted trade-off of the incremental cache (see
        // TrackCacheEntry in blur-detect.ts).
        for (const kind of req.kinds) {
            const active = activeIntervals.get(kind);
            if (active) finishLive(kind, active);
            activeIntervals.set(kind, null);
        }
        decodeDoneSec += interval.endSec - interval.startSec;
    }

    const tracksByKind: DetectResult["tracksByKind"] = {};
    for (const kind of req.kinds) {
        tracksByKind[kind] = finished.get(kind)!.map(
            (t): DetectResultTrack => ({
                startSec: t.startSec,
                endSec: t.endSec,
                keyframes: t.keyframes,
                detHits: t.detHits,
                bestScore: t.bestScore,
            }),
        );
    }
    for (const stat of Object.values(statsByKind)) {
        stat.inferMs = Math.round(stat.inferMs);
        stat.trackMs = Math.round(stat.trackMs);
    }
    return { tracksByKind, statsByKind, decodedFrames, passMs: Math.round(performance.now() - passStartMs) };
}

// createWorkerServer does NOT serialize handlers (see its doc). Passes share
// non-reentrant state - the cached ort sessions (a session's run() is not
// reentrant), the detectors' scratch canvases, and the single-Input decoder
// budget - so two overlapping passes (Track on zone A then B; or a Follow and a
// detect pass at once) would corrupt each other's inference and burn
// wrong-position keyframes into the export. Gate every pass through a promise
// chain so exactly one runs at a time; a queued pass still carries its own
// AbortSignal, so a cancel while queued is honored at its first signal check.
// Mirrors frame-extract-worker.
let passQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = passQueue.then(fn, fn);
    passQueue = next.catch(() => undefined);
    return next;
}

const server = createWorkerServer(self, {
    onRequest: async (type, data, ctx: RequestContext): Promise<TrackResult | DetectResult> => {
        if (type === TRACK_REQUEST) {
            const req = data as TrackRequestData & { regionId?: string; passId?: string };
            return await serialize(() => {
                // A request can be cancelled while waiting behind another pass.
                // Do not let it wake/load the model when its queue turn arrives.
                if (ctx.signal.aborted) throw new DOMException("aborted", "AbortError");
                server.notify(TRACK_NOTIFY_STARTED, { regionId: req.regionId, passId: req.passId });
                return runTrackPass(req, ctx.signal, (fractionDone) => {
                    server.notify(TRACK_NOTIFY_PROGRESS, { fractionDone, regionId: req.regionId, passId: req.passId });
                });
            });
        }
        if (type === DETECT_REQUEST) {
            const req = data as DetectRequestData & { passId?: string };
            return await serialize(() => {
                if (ctx.signal.aborted) throw new DOMException("aborted", "AbortError");
                server.notify(DETECT_NOTIFY_STARTED, { passId: req.passId });
                return runDetectPass(req, ctx.signal, (fractionDone) => {
                    server.notify(DETECT_NOTIFY_PROGRESS, { fractionDone, passId: req.passId });
                });
            });
        }
        throw new Error(`unknown request type: ${type}`);
    },
});

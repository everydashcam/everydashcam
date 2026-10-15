// Local video privacy passes: detector seeds with bidirectional tracking for
// automatic masks, and ViTTrack for a user-selected Follow target.
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

import { CanvasSink, EncodedPacketSink, Input, type VideoSample, VideoSampleSink } from "mediabunny";
import { getInputTimeOrigin } from "../media-time.js";

import { boxToRect, visibleBoxRect } from "../tracking/box-geometry.js";
import { FollowEdgeLoss } from "../tracking/follow-edge-loss.js";
import { finalizeFollowEndReason, followEdgeEndReason } from "../tracking/follow-end.js";
import { createFollowSampler } from "../tracking/follow-sampling.js";
import { chooseAnalysisWidth } from "../tracking/analysis-resolution.js";
import { type RawDetection, type TileRect } from "../tracking/detect-common.js";
import { DetectionTileCache } from "../tracking/detection-tile-cache.js";
import { DetectionScanCache, type DetectionScanEntry } from "../tracking/detection-scan-cache.js";
import { createDetectionSampler } from "../tracking/detection-sampling.js";
import { type DetectionCheckpoint, planDetectionReuse } from "../tracking/detection-analysis.js";
import { detectionSampleTiming, withFinalSample } from "../tracking/detection-decode.js";
import { shouldVerifyPlateContext, resolvePlateContextDetections } from "../tracking/detection-context.js";
import { DetectionPropagation, type SeedDetection } from "../tracking/detection-propagation.js";
import type { SourceFrameTiming } from "../tracking/propagated-track.js";
import { createNativeTrackingFrame, NativeTrackingFrameWorkspace } from "../tracking/tracking-frame.js";
import { planReverseCohorts, planReverseFrameIndices } from "../tracking/reverse-decode-plan.js";
import { canSeedDetection, DETECTION_POLICIES, detectionPolicy } from "../tracking/detector-policy.js";
import { type TimeInterval, totalIntervalSec, unionIntervals } from "../tracking/interval-set.js";
import { createFaceDetector } from "../tracking/face-detector.js";
import type { OrtAssets } from "../tracking/ort-assets.js";
import { type OrtRuntime } from "../tracking/ort-runtime.js";
import { createPlateDetector, PLATE_SCORE_MIN } from "../tracking/plate-detector.js";
import { boxVisibleFraction, EXIT_CONFIRM_SEC, EXIT_VISIBLE_FRACTION } from "../tracking/track-guards.js";
import { appendTrackObservation, type PendingTrackHold, recordTrackHold } from "../tracking/track-observations.js";
import { VitTrackerSession, VITTRACK_SCORE_THRESHOLD, type TrackBox } from "../tracking/vittrack.js";
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
    TRACK_NOTIFY_PROGRESS,
    TRACK_NOTIFY_STARTED,
    TRACK_REQUEST,
    type TrackRequestData,
    type TrackResult,
    type TrackResultKeyframe,
} from "./tracker-protocol.js";
import { createWorkerServer, type RequestContext, type WorkerScopeEndpoint } from "./_protocol/worker-server.js";

declare const self: WorkerScopeEndpoint;

/** Manual Follow analysis rate. Inference (the pass's dominant cost - single-thread
 *  WASM, ~95% of the work) runs only ~this many times per second, NOT on every
 *  decoded frame: a plate/face moves little between 15 fps steps, so this roughly
 *  halves-to-thirds the pass at little quality cost. Decode still advances at the
 *  clip's native rate (cheap, 7-36x realtime); we just skip most inferences. The
 *  guards + loss ride-out are time-based (dt), so they hold at any value here -
 *  lower to go faster, raise to hold fast motion better. */
const ANALYSIS_FPS = 15;
const ANALYSIS_INTERVAL_SEC = 1 / ANALYSIS_FPS;
/** How long the target may stay below-confidence before the pass declares it
 *  lost. Rides out a real occlusion (a pole, a sign, a passing truck, glare) and
 *  resumes covering the subject when it reappears. The box freezes until the
 *  last uncertain frame, then follows the recovered observation. An uncertain
 *  Follow ending reports the last trusted position so automatic timing stops
 *  there and asks for review. Time-based, so it holds independent of ANALYSIS_FPS. */
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
    const edgeLoss = new FollowEdgeLoss();
    const pendingHold: PendingTrackHold = { previousSec: null, latestSec: null };
    let initialized = false;
    let sampleFollowFrame: ReturnType<typeof createFollowSampler> | null = null;
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
                    sampleFollowFrame = createFollowSampler(ANALYSIS_INTERVAL_SEC, contentSec);
                    vitTrack.init(frame, frame.width, frame.height, rectToBox(req.seedRect, frame.width, frame.height));
                    initialized = true;
                    lastAnalyzedSec = contentSec;
                    lastGoodSec = Math.max(req.seedContentSec, contentSec);
                    appendTrackObservation(keyframes, pendingHold, lastGoodSec, req.seedRect);
                    continue;
                }
                // Preserve the seed's grid across segments. Rounded timestamps
                // must not accumulate delay or replay an overlapping frame.
                if (!sampleFollowFrame!(contentSec)) continue;
                const dtSec = contentSec - lastAnalyzedSec;
                lastAnalyzedSec = contentSec;

                const { box, score, rejected, lost } = await vitTrack.update(frame, frame.width, frame.height, dtSec);
                if (lost) {
                    endReason = "lost";
                    break outer;
                }
                if (
                    edgeLoss.observe(
                        box,
                        frame.width,
                        frame.height,
                        contentSec,
                        !rejected && score >= VITTRACK_SCORE_THRESHOLD,
                    )
                ) {
                    endReason = "lost";
                    break outer;
                }
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
    // window is still an uncertain tail, not a successful pass. Likewise, a
    // decoder that stops materially before the requested end cannot establish
    // coverage. Label both lost so automatic timing ends at the last trusted
    // position and the client asks the user to review it.
    endReason = finalizeFollowEndReason(endReason, {
        initialized,
        lossPending: lossStartedSec !== null || edgeLoss.hasPendingLoss,
        exitPending: exitStartedSec !== null,
        requestedEndSec: req.endContentSec,
        lastAnalyzedSec,
        analysisIntervalSec: ANALYSIS_INTERVAL_SEC,
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

// Every checkpoint owns its displayed frame. Independent masks may fill only
// the unchecked frames on either side; empty scheduled scans are hard boundaries.

const DETECT_MARGIN_PCT: Record<DetectKind, number> = { plate: 0.12, face: 0.35 };

interface FrameDetector {
    merge(detections: readonly RawDetection[]): RawDetection[];
    detectTiles(
        frame: CanvasImageSource,
        frameW: number,
        frameH: number,
        tiles: readonly TileRect[],
        scoreMin?: number,
    ): Promise<Array<{ x: number; y: number; w: number; h: number; score: number }>>;
}

interface DetectIntervalState {
    bounds: TimeInterval;
}

interface DetectionObservation extends SourceFrameTiming {
    /** Raw geometry seeds the tracker; padding belongs only to emitted masks. */
    seeds: SeedDetection[];
}

// Reverse traversal retains native decoded samples, often compact YUV, rather
// than full RGBA copies. One oversized frame is the unavoidable floor; the
// single working display canvas is separate from this retained-sample budget.
const REVERSE_FRAME_BUDGET_BYTES = 64 * 1024 * 1024;
// Holding too many decoded samples can exhaust hardware decoder surfaces even
// below the byte budget, and increases cancellation latency at lower resolutions.
const MAX_REVERSE_BUFFER_FRAMES = 8;

function reverseSampleBytes(sample: VideoSample): number {
    let bytes: number;
    try {
        bytes = sample.allocationSize();
    } catch {
        // Opaque native formats have no copy allocation size. Use coded RGBA
        // as a conservative estimate instead of assuming every frame is YUV420.
        bytes = sample.codedWidth * sample.codedHeight * 4;
    }
    if (!Number.isFinite(bytes) || bytes <= 0) throw new Error("detect: backward sample size is invalid");
    return bytes;
}

/** Time only waiting for a delivered sample, not the caller's processing.
 * Decoder prefetch can overlap the caller, so this is exposed wait time. */
async function* measureDecode<T>(source: AsyncIterable<T>, timings: NonNullable<DetectResult["timings"]>) {
    let resumedAt = performance.now();
    for await (const sample of source) {
        timings.decodeWaitMs += performance.now() - resumedAt;
        yield sample;
        resumedAt = performance.now();
    }
    timings.decodeWaitMs += performance.now() - resumedAt;
}

async function runDetectPass(
    req: DetectRequestData,
    signal: AbortSignal,
    notifyProgress: (fractionDone: number) => void,
): Promise<DetectResult> {
    const policies = {
        plate: detectionPolicy(req.thresholds?.plate ?? DETECTION_POLICIES.plate.seedScoreMin),
        face: detectionPolicy(req.thresholds?.face ?? DETECTION_POLICIES.face.seedScoreMin),
    };
    // Same-frame tile/context corroboration can use weak plate proposals;
    // only the final resolved score may seed an independent trajectory.
    const candidateFloors = {
        plate: Math.min(PLATE_SCORE_MIN, policies.plate.seedScoreMin),
        face: policies.face.seedScoreMin,
    };
    const passStartMs = performance.now();
    const timings = {
        forwardMs: 0,
        backwardMs: 0,
        decodeWaitMs: 0,
        forwardSamples: 0,
        backwardSamples: 0,
        reverseBlocks: 0,
        sourceEndQueries: 0,
        drawMs: 0,
    };
    const trackingFrames = new NativeTrackingFrameWorkspace();
    const statsByKind: DetectResult["statsByKind"] = {};
    const tracksByKind: DetectResult["tracksByKind"] = {};
    const sourceFrames = new Map<number, DetectResult["sourceFrames"][number]>();
    const intervalsByKind = new Map<DetectKind, DetectIntervalState[]>();
    const checkpointsByKind = new Map<DetectKind, Map<number, DetectionCheckpoint>>();
    const retainedByKind = new Map<DetectKind, Set<number>>();
    const cachedScansByKind = new Map<DetectKind, Map<number, DetectionCheckpoint>>();
    for (const kind of req.kinds) {
        statsByKind[kind] = {
            scans: 0,
            tiles: 0,
            inferMs: 0,
            trackUpdates: 0,
            backwardUpdates: 0,
            trackMs: 0,
            seededTracks: 0,
            highMotionUpdates: 0,
            calibrationUpdates: 0,
            contextChecks: 0,
        };
        tracksByKind[kind] = [];
        const requested = req.analyzeIntervalsByKind[kind] ?? [];
        const candidate = req.cachedAnalysisByKind?.[kind];
        const cached =
            req.segments.length === 1 &&
            requested.length === 1 &&
            candidate?.quality === req.quality &&
            candidate.threshold === policies[kind].seedScoreMin
                ? candidate
                : undefined;
        const plan =
            requested.length === 1 ? planDetectionReuse(cached, requested[0]!) : { intervals: requested, retained: [] };
        intervalsByKind.set(
            kind,
            plan.intervals.map((bounds) => ({ bounds })),
        );
        checkpointsByKind.set(kind, new Map(plan.retained.map((checkpoint) => [checkpoint.contentSec, checkpoint])));
        retainedByKind.set(kind, new Set(plan.retained.map((checkpoint) => checkpoint.contentSec)));
        cachedScansByKind.set(
            kind,
            new Map(cached?.checkpoints.map((checkpoint) => [checkpoint.contentSec, checkpoint])),
        );
        // Only completed displayed timing is reusable. Failed/aborted passes
        // never return a snapshot, and the client keeps the previous one.
        for (const frame of cached?.sourceFrames ?? []) {
            if (
                frame.contentSec + frame.durationSec <= requested[0]!.endSec &&
                frame.contentSec + frame.durationSec > requested[0]!.startSec
            )
                sourceFrames.set(frame.contentSec, {
                    contentSec: frame.contentSec,
                    // A frame cut by the new end is decoded again. Keep its
                    // source-measured duration instead of clipping on the
                    // content axis, which can round differently after an offset.
                    durationSec: frame.durationSec,
                });
        }
    }
    const decodeIntervals = unionIntervals(
        req.kinds.flatMap((kind) => intervalsByKind.get(kind)!.map(({ bounds }) => bounds)),
    );
    const detectors = new Map<DetectKind, FrameDetector>();
    for (const kind of req.kinds) {
        if (!intervalsByKind.get(kind)!.length) continue;
        signal.throwIfAborted();
        detectors.set(
            kind,
            await getDetector(kind, kind === "plate" ? req.plateModelUrl : req.faceModelUrl, req.ortAssets),
        );
    }
    const decodeTotalSec = Math.max(1e-6, totalIntervalSec(decodeIntervals));
    let decodedFrames = 0;
    let decodeDoneSec = 0;
    let lastProgressAt = 0;

    for (const interval of decodeIntervals) {
        for (const seg of req.segments) {
            signal.throwIfAborted();
            const startLocal = Math.max(seg.startInFile, interval.startSec - seg.tripStart);
            const endLocal = Math.min(seg.endInFile, interval.endSec - seg.tripStart);
            if (endLocal <= startLocal) continue;
            const input = new Input({ source: await createBlobSource(seg.file, signal), formats: VIDEO_INPUT_FORMATS });
            try {
                const vtrack = await input.getPrimaryVideoTrack();
                if (!vtrack) throw new Error("detect: source has no video track");
                // Keep source pixels native until needed. A detector scan or
                // several tracked objects share one display canvas; a single
                // tracker can crop the borrowed sample directly.
                const sink = new VideoSampleSink(vtrack);
                let displayCanvas: OffscreenCanvas | null = null;
                let displayContext: OffscreenCanvasRenderingContext2D | null = null;
                const drawDisplaySample = (sample: VideoSample): OffscreenCanvas => {
                    const startedAt = performance.now();
                    if (!displayCanvas) {
                        displayCanvas = new OffscreenCanvas(sample.displayWidth, sample.displayHeight);
                        // Alpha avoids native VideoFrame drawing glitches in Firefox.
                        displayContext = displayCanvas.getContext("2d");
                        if (!displayContext) throw new Error("detect: canvas context is unavailable");
                    }
                    if (displayCanvas.width !== sample.displayWidth || displayCanvas.height !== sample.displayHeight) {
                        displayCanvas.width = sample.displayWidth;
                        displayCanvas.height = sample.displayHeight;
                    }
                    displayContext!.fillStyle = "#000";
                    displayContext!.fillRect(0, 0, displayCanvas.width, displayCanvas.height);
                    sample.draw(displayContext!, 0, 0, displayCanvas.width, displayCanvas.height);
                    timings.drawMs += performance.now() - startedAt;
                    return displayCanvas;
                };
                const timeOrigin = await getInputTimeOrigin(input);
                const firstTimestamp = await vtrack.getFirstTimestamp();
                // A retained checkpoint names an exact source frame. Reversing
                // its content-time conversion can round below its PTS, making
                // samples() yield a predecessor that becomes an extra checkpoint.
                const resumeTimestamp = req.kinds
                    .filter((kind) => retainedByKind.get(kind)!.has(interval.startSec))
                    .map((kind) => checkpointsByKind.get(kind)!.get(interval.startSec)!.sourceTimestamp)[0];
                const startTimestamp = resumeTimestamp ?? startLocal + timeOrigin;
                const expectedStartSec = seg.tripStart + Math.max(startLocal, firstTimestamp - timeOrigin);
                const expectedEndSec = seg.tripStart + endLocal;
                if (expectedEndSec <= expectedStartSec) continue;
                const tileCache = new DetectionTileCache();
                const frameTimings: Array<{ contentSec: number; durationSec: number }> = [];
                const observations = new Map<DetectKind, Map<number, DetectionObservation>>();
                // Forward states can overlap the same presentation frame at a
                // fractional boundary. Share their complete checkpoint scans.
                const scans = new Map<DetectKind, DetectionScanCache>();
                const checkpointIndices = new Map<DetectKind, number[]>();
                const samplers = new Map<DetectKind, ReturnType<typeof createDetectionSampler>>();
                for (const kind of req.kinds) {
                    observations.set(kind, new Map());
                    checkpointIndices.set(kind, []);
                    scans.set(kind, new DetectionScanCache());
                    samplers.set(
                        kind,
                        createDetectionSampler(req.quality, seg.tripStart + firstTimestamp - timeOrigin),
                    );
                }
                const propagationEntries: Array<{
                    kind: DetectKind;
                    state: DetectIntervalState;
                    propagation: DetectionPropagation;
                }> = [];
                const propagationByState = new Map<DetectIntervalState, DetectionPropagation>();
                const propagationKinds = new Map<DetectionPropagation, DetectKind>();
                let trackerSession: VitTrackerSession | null = null;
                let reverseSampleBytesHint = 0;
                let forwardWindowStartIndex = 0;
                let decodedStartSec = Number.POSITIVE_INFINITY;
                let decodedEndSec = Number.NEGATIVE_INFINITY;

                const isActive = (kind: DetectKind, timing: { contentSec: number; durationSec: number }) =>
                    intervalsByKind
                        .get(kind)!
                        .some(
                            ({ bounds }) =>
                                timing.contentSec < bounds.endSec &&
                                timing.contentSec + timing.durationSec > bounds.startSec,
                        );
                const scanTiles = async (
                    kind: DetectKind,
                    frame: OffscreenCanvas,
                    contentSec: number,
                    requested: readonly TileRect[],
                ) => {
                    const scan = scans.get(kind)!.entryFor(contentSec);
                    const missing = scan.missingTiles(requested);
                    if (missing.length === 0) return scan;
                    const stat = statsByKind[kind]!;
                    const startedAt = performance.now();
                    const boxes = await detectors
                        .get(kind)!
                        .detectTiles(frame, frame.width, frame.height, missing, candidateFloors[kind]);
                    stat.inferMs += performance.now() - startedAt;
                    signal.throwIfAborted();
                    if (scan.tileCount === 0) {
                        stat.scans++;
                    }
                    stat.tiles += missing.length;
                    scan.record(missing, boxes);
                    return scan;
                };
                const plateContextByScan = new WeakMap<DetectionScanEntry, readonly RawDetection[]>();
                const makeObservation = async (
                    kind: DetectKind,
                    frame: OffscreenCanvas,
                    timing: { contentSec: number; durationSec: number },
                    boxes: readonly RawDetection[],
                ): Promise<DetectionObservation> => {
                    // A tile can turn a cropped car panel into a confident
                    // plate. Large proposals retain enough pixels in a whole
                    // frame scan to verify their class with the scene intact.
                    // Small objects still need the tiled detection scale.
                    if (
                        kind === "plate" &&
                        tileCache.forFrame(frame.width, frame.height).length > 1 &&
                        boxes.some((box) => shouldVerifyPlateContext(box, frame.width, frame.height))
                    ) {
                        const scan = scans.get(kind)!.entryFor(timing.contentSec);
                        let context = plateContextByScan.get(scan);
                        if (!context) {
                            const startedAt = performance.now();
                            context = await detectors
                                .get(kind)!
                                .detectTiles(
                                    frame,
                                    frame.width,
                                    frame.height,
                                    [{ sx: 0, sy: 0, sw: frame.width, sh: frame.height }],
                                    candidateFloors[kind],
                                );
                            signal.throwIfAborted();
                            const stat = statsByKind[kind]!;
                            stat.inferMs += performance.now() - startedAt;
                            stat.tiles++;
                            stat.contextChecks!++;
                            plateContextByScan.set(scan, context);
                        }
                        // Use the corroborated whole-frame geometry: tiles can
                        // crop a large plate at their seams. A matched pair is
                        // still one observation, never two independent hits.
                        boxes = resolvePlateContextDetections(boxes, context, frame.width, frame.height);
                    }
                    return {
                        ...timing,
                        seeds: boxes.flatMap((box) =>
                            visibleBoxRect(box, frame.width, frame.height, DETECT_MARGIN_PCT[kind])
                                ? [{ rect: boxToRect(box, frame.width, frame.height), score: box.score }]
                                : [],
                        ),
                    };
                };
                const infer = async (
                    kind: DetectKind,
                    frame: OffscreenCanvas,
                    timing: { contentSec: number; durationSec: number },
                ) => {
                    const tiles = tileCache.forFrame(frame.width, frame.height);
                    const scan = await scanTiles(kind, frame, timing.contentSec, tiles);
                    const observation = await makeObservation(
                        kind,
                        frame,
                        timing,
                        detectors.get(kind)!.merge(scan.boxes),
                    );
                    observations.get(kind)!.set(timing.contentSec, observation);
                };
                const redetect = async (kind: DetectKind, index: number, draw: () => OffscreenCanvas) => {
                    const timing = frameTimings[index]!;
                    if (!observations.get(kind)!.has(timing.contentSec)) {
                        await infer(kind, draw(), timing);
                        statsByKind[kind]!.recoveryScans = (statsByKind[kind]!.recoveryScans ?? 0) + 1;
                    }
                    // Supplemental observations do not become fixed checkpoints:
                    // they only replace failed branches within their owner window.
                    return observations.get(kind)!.get(timing.contentSec)!.seeds;
                };
                let segmentProgress = 0;
                const progress = (endSec: number, phase: "forward" | "backward" | "complete", reverseFraction = 0) => {
                    const now = performance.now();
                    if (now - lastProgressAt < PROGRESS_THROTTLE_MS && phase !== "complete") return;
                    lastProgressAt = now;
                    const segmentStartSec = seg.tripStart + startLocal;
                    const duration = expectedEndSec - segmentStartSec;
                    const localDone = Math.max(0, Math.min(duration, endSec - segmentStartSec));
                    const done =
                        phase === "complete"
                            ? localDone
                            : phase === "forward"
                              ? localDone * 0.8
                              : duration * (0.8 + reverseFraction * 0.2);
                    segmentProgress = Math.max(segmentProgress, done);
                    notifyProgress(
                        Math.min(
                            1,
                            (decodeDoneSec + segmentStartSec - interval.startSec + segmentProgress) / decodeTotalSec,
                        ),
                    );
                };
                const forwardStartedAt = performance.now();
                // VideoSampleSink yields presentation order, including B-frame
                // inputs; decode-order packet timestamps never enter tracking.
                // Look ahead by one borrowed sample. Only an underfilled final
                // sample needs a last-packet query; ordinary trims avoid a full
                // container duration scan, and EOF decode has warmed the index.
                for await (const { sample, isLast } of withFinalSample(
                    measureDecode(sink.samples(startTimestamp, endLocal + timeOrigin), timings),
                )) {
                    signal.throwIfAborted();
                    decodedFrames++;
                    timings.forwardSamples++;
                    const sourceTiming = await detectionSampleTiming(sample, isLast, endLocal + timeOrigin, () => {
                        timings.sourceEndQueries++;
                        return new EncodedPacketSink(vtrack).getPacket(Infinity, { metadataOnly: true });
                    });
                    const timing = {
                        contentSec: seg.tripStart + sourceTiming.timestamp - timeOrigin,
                        durationSec: sourceTiming.duration,
                    };
                    if (!(timing.durationSec > 0)) continue;
                    // Retain only a size hint, not another native surface.
                    // Reverse can decode its seed with the first block.
                    reverseSampleBytesHint = Math.max(reverseSampleBytesHint, reverseSampleBytes(sample));
                    const frameEndSec = timing.contentSec + timing.durationSec;
                    const frame = createNativeTrackingFrame(sample, trackingFrames);
                    let displayFrame: OffscreenCanvas | null = null;
                    const frameIndex = frameTimings.length;
                    const previous = frameTimings[frameIndex - 1];
                    if (previous && timing.contentSec > previous.contentSec + previous.durationSec + 1e-6) {
                        forwardWindowStartIndex = frameIndex;
                    }
                    frameTimings.push(timing);
                    // Disjoint analysis windows can decode the same displayed
                    // predecessor. Keep its longest verified support once;
                    // never infer a duration from the next window's start.
                    const cachedTiming = sourceFrames.get(timing.contentSec);
                    if (!cachedTiming || timing.durationSec > cachedTiming.durationSec) {
                        sourceFrames.set(timing.contentSec, timing);
                    }
                    decodedStartSec = Math.min(decodedStartSec, timing.contentSec);
                    decodedEndSec = Math.max(decodedEndSec, frameEndSec);
                    for (const kind of req.kinds) {
                        if (!isActive(kind, timing)) continue;
                        const isEndpoint = intervalsByKind
                            .get(kind)!
                            .some(
                                ({ bounds }) =>
                                    timing.contentSec < bounds.endSec &&
                                    frameEndSec >= Math.min(bounds.endSec, expectedEndSec) - 1e-6,
                            );
                        if (!samplers.get(kind)!(timing.contentSec, isEndpoint)) continue;
                        const cached = cachedScansByKind.get(kind)!.get(timing.contentSec);
                        if (cached) {
                            observations.get(kind)!.set(timing.contentSec, { ...timing, seeds: cached.seeds });
                        } else {
                            displayFrame ??= drawDisplaySample(sample);
                            await infer(kind, displayFrame, timing);
                        }
                        if (!retainedByKind.get(kind)!.has(timing.contentSec))
                            checkpointsByKind.get(kind)!.set(timing.contentSec, {
                                ...observations.get(kind)!.get(timing.contentSec)!,
                                sourceTimestamp: sample.timestamp,
                                tracks: [],
                            });
                        checkpointIndices.get(kind)!.push(frameIndex);
                    }
                    const liveCount = propagationEntries.reduce(
                        (count, { state, propagation }) =>
                            timing.contentSec < state.bounds.endSec && frameEndSec > state.bounds.startSec
                                ? count + propagation.forwardTrackCount()
                                : count,
                        0,
                    );
                    // Multiple native crops repeat YUV conversion and
                    // resize the ROI workspace. Share display pixels
                    // once when several objects need this frame.
                    const trackingFrame = () => {
                        if (!displayFrame && liveCount > 1) displayFrame = drawDisplaySample(sample);
                        return displayFrame ?? frame;
                    };
                    // Discovery and forward tracking consume the same source
                    // frame. Keep seed timing for the later reverse pass,
                    // but never decode this whole window a second time.
                    // Retain every source frame's timing. Propagation uses
                    // 15 Hz with calibration and fast-motion safeguards.
                    for (const kind of req.kinds) {
                        // A retained checkpoint still stops adjacent new tracks,
                        // but its own complete trajectory needs no model state.
                        const seeds = retainedByKind.get(kind)!.has(timing.contentSec)
                            ? []
                            : observations.get(kind)!.get(timing.contentSec)?.seeds;
                        for (const state of intervalsByKind.get(kind)!) {
                            if (timing.contentSec >= state.bounds.endSec || frameEndSec <= state.bounds.startSec)
                                continue;
                            let propagation = propagationByState.get(state);
                            if (!propagation) {
                                if (!seeds?.some((seed) => canSeedDetection(seed.score, policies[kind]))) continue;
                                const firstIndex = frameTimings.findIndex(
                                    (frame) =>
                                        frame.contentSec < state.bounds.endSec &&
                                        frame.contentSec + frame.durationSec > state.bounds.startSec,
                                );
                                // No positive seed means no tracker session. Reuse
                                // the detector runtime; ViTTrack still uses its WASM EP.
                                if (req.quality !== "thorough")
                                    trackerSession ??= await getTrackerSession(
                                        "webgpu",
                                        req.trackerModelUrl,
                                        req.ortAssets,
                                    );
                                signal.throwIfAborted();
                                propagation = new DetectionPropagation(trackerSession, {
                                    margin: DETECT_MARGIN_PCT[kind],
                                    ...policies[kind],
                                    frames: frameTimings,
                                    bounds: {
                                        startSec: frameTimings[firstIndex]!.contentSec,
                                        endSec: Math.min(expectedEndSec, state.bounds.endSec),
                                    },
                                    stats: statsByKind[kind]!,
                                    signal,
                                });
                                const checkpoints = checkpointIndices.get(kind)!;
                                propagation.beginForwardWindow(
                                    Math.max(firstIndex, forwardWindowStartIndex),
                                    checkpoints[checkpoints.length - 2] ?? null,
                                );
                                propagationByState.set(state, propagation);
                                propagationKinds.set(propagation, kind);
                                propagationEntries.push({ kind, state, propagation });
                            }
                            // Detector scan frames already have display
                            // pixels; reuse them for crops and templates.
                            await propagation.forward(trackingFrame, frameIndex, seeds, () =>
                                redetect(kind, frameIndex, () => (displayFrame ??= drawDisplaySample(sample))),
                            );
                        }
                    }
                    progress(frameEndSec, "forward");
                }
                timings.forwardMs += performance.now() - forwardStartedAt;
                // An empty decode is not a successfully scanned interval; do
                // not let the client permanently cache a silent privacy failure.
                if (frameTimings.length === 0) throw new Error("detect: no video frames decoded");
                // Compare against packet timestamps, not approximate container
                // duration. A partial decode must not become a complete cache.
                if (decodedStartSec > expectedStartSec + 1e-4 || decodedEndSec < expectedEndSec - 1e-4) {
                    throw new Error("detect: video decode ended before the requested range was covered");
                }
                const backwardStartedAt = performance.now();
                for (const { propagation } of propagationEntries) propagation.endForwardWindow();
                // Independent seeds share decoded pixels but never evidence.
                // Nearby groups share decoded frames within a bounded cohort.
                const reverseGroups = new Map<
                    number,
                    {
                        startIndex: number;
                        branchCount: number;
                        hasHighMotion: boolean;
                        propagations: DetectionPropagation[];
                    }
                >();
                const requiredReverseIndices = new Set<number>();
                for (const { propagation } of propagationEntries) {
                    for (const job of propagation.backwardJobs()) {
                        requiredReverseIndices.add(job.startIndex);
                        const group = reverseGroups.get(job.seedIndex);
                        if (group) {
                            group.startIndex = Math.min(group.startIndex, job.startIndex);
                            group.branchCount++;
                            group.hasHighMotion ||= job.hasHighMotion;
                            if (!group.propagations.includes(propagation)) group.propagations.push(propagation);
                        } else {
                            reverseGroups.set(job.seedIndex, {
                                startIndex: job.startIndex,
                                branchCount: 1,
                                hasHighMotion: job.hasHighMotion,
                                propagations: [propagation],
                            });
                        }
                    }
                }
                const reverseWork = [...reverseGroups].reduce(
                    (sum, [seedIndex, group]) => sum + seedIndex - group.startIndex,
                    0,
                );
                const reverseSink = new VideoSampleSink(vtrack);
                let reverseDone = 0;
                const cohorts = planReverseCohorts(
                    [...reverseGroups].map(([seedIndex, group]) => ({ ...group, seedIndex, started: false })),
                );
                for (const cohort of cohorts) {
                    signal.throwIfAborted();
                    const startIndex = Math.min(...cohort.map((group) => group.startIndex));
                    const lastGroup = cohort[cohort.length - 1]!;
                    const hasWork = (group: (typeof cohort)[number]) =>
                        group.started &&
                        group.propagations.some((propagation) => propagation.hasBackwardWork(group.seedIndex));
                    const startGroup = (
                        group: (typeof cohort)[number],
                        frame: OffscreenCanvas | ReturnType<typeof createNativeTrackingFrame>,
                    ) => {
                        for (const propagation of group.propagations) propagation.startBackward(frame, group.seedIndex);
                        group.started = true;
                        if (!hasWork(group)) reverseDone += group.seedIndex - group.startIndex;
                    };
                    // Retain pixels on each branch's inference grid and safety
                    // exceptions. Consume every timing to preserve holds and gaps.
                    let sampleBytesHint = reverseSampleBytesHint;
                    // Include the seed in the first bounded block. A separate
                    // getSample would decode the same GOP prefix an extra time.
                    for (let endIndex = lastGroup.seedIndex + 1; endIndex > startIndex; ) {
                        signal.throwIfAborted();
                        // Reverse calibration can discover motion absent in the
                        // forward pass. Each iterator owns an immutable plan;
                        // only its unconsumed prefix is replanned after closing.
                        const decodeIndices = planReverseFrameIndices(frameTimings, cohort, [
                            ...requiredReverseIndices,
                        ]);
                        const capacity = Math.max(
                            1,
                            Math.min(
                                MAX_REVERSE_BUFFER_FRAMES,
                                Math.floor(REVERSE_FRAME_BUDGET_BYTES / sampleBytesHint),
                            ),
                        );
                        let iteratorEndPosition = decodeIndices.length;
                        while (iteratorEndPosition > 0 && decodeIndices[iteratorEndPosition - 1]! >= endIndex) {
                            iteratorEndPosition--;
                        }
                        let blockEndPosition = iteratorEndPosition;
                        // Each block decodes forwards and is consumed backwards.
                        // A single nonmonotonic iterator keeps its decoder alive;
                        // mediabunny flushes it at each backwards timestamp jump.
                        // Do not gate this generator on block consumption: the
                        // decoder needs the next timestamp to flush this block.
                        const timestamps = function* () {
                            for (let blockEnd = iteratorEndPosition; blockEnd > 0; ) {
                                const blockStart = Math.max(0, blockEnd - capacity);
                                for (let position = blockStart; position < blockEnd; position++) {
                                    yield frameTimings[decodeIndices[position]!]!.contentSec -
                                        seg.tripStart +
                                        timeOrigin +
                                        1e-6;
                                }
                                blockEnd = blockStart;
                            }
                        };
                        let blockStartPosition = Math.max(0, blockEndPosition - capacity);
                        let position = blockStartPosition;
                        const retained: Array<{ index: number; sample: VideoSample; bytes: number }> = [];
                        let retainedBytes = 0;
                        let stoppedEarly = false;
                        try {
                            // Keep the decoder's native samples until reverse
                            // consumption; no full-resolution RGBA copying.
                            for await (const sample of measureDecode(
                                reverseSink.samplesAtTimestamps(timestamps()),
                                timings,
                            )) {
                                if (!sample) throw new Error("detect: backward frame is unavailable");
                                const index = decodeIndices[position]!;
                                let isRetained = false;
                                try {
                                    signal.throwIfAborted();
                                    if (
                                        Math.abs(
                                            sample.timestamp -
                                                timeOrigin +
                                                seg.tripStart -
                                                frameTimings[index]!.contentSec,
                                        ) > 1e-6
                                    ) {
                                        throw new Error("detect: backward frame is unavailable");
                                    }
                                    const bytes = reverseSampleBytes(sample);
                                    sampleBytesHint = Math.max(sampleBytesHint, bytes);
                                    retained.push({ index, sample, bytes });
                                    isRetained = true;
                                    retainedBytes += bytes;
                                    // A format or resolution change can exceed
                                    // the seed's size hint. Retain the newest
                                    // suffix; a fresh, smaller-block iterator
                                    // revisits every discarded earlier index.
                                    while (retained.length > 1 && retainedBytes > REVERSE_FRAME_BUDGET_BYTES) {
                                        const discarded = retained.shift()!;
                                        retainedBytes -= discarded.bytes;
                                        discarded.sample.close();
                                    }
                                    decodedFrames++;
                                    timings.backwardSamples++;
                                    position++;
                                } finally {
                                    if (!isRetained) sample.close();
                                }
                                if (position < blockEndPosition) continue;
                                timings.reverseBlocks++;
                                let nextEndIndex = retained[0]!.index;
                                const samplesByIndex = new Map(retained.map(({ index, sample }) => [index, sample]));
                                for (let index = endIndex - 1; index >= nextEndIndex; index--) {
                                    signal.throwIfAborted();
                                    const needed = cohort.some((group) => group.seedIndex === index || hasWork(group));
                                    if (!needed) continue;
                                    if (
                                        !samplesByIndex.has(index) &&
                                        cohort.some((group) => group.hasHighMotion && hasWork(group))
                                    ) {
                                        // Stop before ANY group mutates this
                                        // frame. A monotonic motion upgrade can
                                        // require pixels omitted by this plan.
                                        // Revisit this index without replaying
                                        // the already settled newer suffix.
                                        nextEndIndex = index + 1;
                                        break;
                                    }
                                    const liveCount = cohort.reduce(
                                        (count, group) =>
                                            count +
                                            (group.seedIndex === index
                                                ? group.branchCount
                                                : group.propagations.reduce(
                                                      (sum, propagation) =>
                                                          sum + propagation.backwardTrackCount(group.seedIndex),
                                                      0,
                                                  )),
                                        0,
                                    );
                                    let frame: OffscreenCanvas | ReturnType<typeof createNativeTrackingFrame> | null =
                                        null;
                                    const trackingFrame = () => {
                                        if (frame) return frame;
                                        const sample = samplesByIndex.get(index);
                                        if (!sample) throw new Error("detect: unplanned backward frame requested");
                                        frame =
                                            liveCount > 1
                                                ? drawDisplaySample(sample)
                                                : createNativeTrackingFrame(sample, trackingFrames);
                                        return frame;
                                    };
                                    for (const group of cohort) {
                                        if (group.seedIndex === index) {
                                            startGroup(group, trackingFrame());
                                        } else if (hasWork(group)) {
                                            for (const propagation of group.propagations) {
                                                const kind = propagationKinds.get(propagation)!;
                                                await propagation.backward(trackingFrame, index, group.seedIndex, () =>
                                                    redetect(kind, index, () =>
                                                        drawDisplaySample(samplesByIndex.get(index)!),
                                                    ),
                                                );
                                                group.hasHighMotion ||= propagation.hasBackwardHighMotion(
                                                    group.seedIndex,
                                                );
                                            }
                                            reverseDone++;
                                            if (!hasWork(group)) reverseDone += index - group.startIndex;
                                        }
                                    }
                                    progress(expectedEndSec, "backward", reverseDone / Math.max(1, reverseWork));
                                }
                                for (const { sample } of retained) sample.close();
                                retained.length = 0;
                                retainedBytes = 0;
                                endIndex = nextEndIndex;
                                if (!cohort.some(hasWork)) {
                                    // No live branch needs the gap before the
                                    // next seed. Close the iterator before
                                    // seeking there instead of decoding it.
                                    const nextSeed = cohort.filter((group) => !group.started).at(-1);
                                    endIndex = nextSeed ? Math.min(endIndex, nextSeed.seedIndex + 1) : startIndex;
                                }
                                if (nextEndIndex > decodeIndices[blockStartPosition]! || endIndex !== nextEndIndex) {
                                    // Closing this iterator also releases its
                                    // lookahead queue before a size-change retry.
                                    stoppedEarly = true;
                                    break;
                                }
                                blockEndPosition = blockStartPosition;
                                blockStartPosition = Math.max(0, blockEndPosition - capacity);
                                position = blockStartPosition;
                            }
                            if (!stoppedEarly && endIndex > startIndex) {
                                throw new Error("detect: backward tracking decode ended early");
                            }
                        } finally {
                            for (const { sample } of retained) sample.close();
                        }
                    }
                }
                for (const { kind, propagation } of propagationEntries) {
                    for (const [sec, tracks] of propagation.finishByCheckpoint())
                        checkpointsByKind
                            .get(kind)!
                            .get(sec)!
                            .tracks.push(...tracks);
                    for (const [sec, frames] of propagation.uncertainFramesByCheckpoint()) {
                        const checkpoint = checkpointsByKind.get(kind)!.get(sec)!;
                        checkpoint.uncertainFrames ??= [];
                        checkpoint.uncertainFrames.push(...frames);
                    }
                }
                timings.backwardMs += performance.now() - backwardStartedAt;
                progress(expectedEndSec, "complete");
            } finally {
                input.dispose();
            }
        }
        decodeDoneSec += interval.endSec - interval.startSec;
    }
    const completedFrames = [...sourceFrames.values()].sort((a, b) => a.contentSec - b.contentSec);
    const analysisByKind: NonNullable<DetectResult["analysisByKind"]> = {};
    const uncertainFramesByKind: NonNullable<DetectResult["uncertainFramesByKind"]> = {};
    for (const kind of req.kinds) {
        const checkpoints = [...checkpointsByKind.get(kind)!.values()].sort((a, b) => a.contentSec - b.contentSec);
        tracksByKind[kind] = checkpoints.flatMap(({ tracks }) => tracks).sort((a, b) => a.startSec - b.startSec);
        uncertainFramesByKind[kind] = [
            ...new Map(
                checkpoints.flatMap((checkpoint) =>
                    (checkpoint.uncertainFrames ?? []).map((frame) => [frame.contentSec, frame] as const),
                ),
            ).values(),
        ].sort((a, b) => a.contentSec - b.contentSec);
        const requested = req.analyzeIntervalsByKind[kind] ?? [];
        if (req.segments.length === 1 && requested.length === 1) {
            analysisByKind[kind] = {
                bounds: requested[0]!,
                quality: req.quality,
                threshold: policies[kind].seedScoreMin,
                checkpoints,
                sourceFrames: completedFrames,
            };
        }
        statsByKind[kind]!.inferMs = Math.round(statsByKind[kind]!.inferMs);
        statsByKind[kind]!.trackMs = Math.round(statsByKind[kind]!.trackMs);
    }
    return {
        tracksByKind,
        statsByKind,
        analysisByKind,
        uncertainFramesByKind,
        sourceFrames: completedFrames,
        decodedFrames,
        passMs: Math.round(performance.now() - passStartMs),
        timings: {
            forwardMs: Math.round(timings.forwardMs),
            backwardMs: Math.round(timings.backwardMs),
            decodeWaitMs: Math.round(timings.decodeWaitMs),
            forwardSamples: timings.forwardSamples,
            backwardSamples: timings.backwardSamples,
            reverseBlocks: timings.reverseBlocks,
            sourceEndQueries: timings.sourceEndQueries,
            drawMs: Math.round(timings.drawMs),
        },
    };
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

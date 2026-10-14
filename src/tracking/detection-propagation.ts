import type { CropRect } from "../transcode/compose.js";
import type { DetectPassStats } from "../workers/tracker-protocol.js";
import { boxToRect, visibleBoxRect } from "./box-geometry.js";
import type { DetectedTrack } from "./detect-track.js";
import { canSeedDetection } from "./detector-policy.js";
import { isPropagationUpdateDue, PROPAGATION_INTERVAL_SEC } from "./frame-sampling.js";
import type { TimeInterval } from "./interval-set.js";
import type { NativeTrackingFrame } from "./tracking-frame.js";
import {
    buildPropagatedTrack,
    duplicatePropagationPrefixEndIndex,
    interpolateRect,
    matchPropagationDetections,
    propagationGapBridges,
    type PropagatedObservation,
    type PropagationPrefix,
    type SourceFrameTiming,
} from "./propagated-track.js";
import { boxVisibleFraction, EXIT_VISIBLE_FRACTION, type TrackBox } from "./track-guards.js";
import { type VitTrack, VITTRACK_SCORE_THRESHOLD } from "./vittrack.js";

/** The model boundary: propagation owns association and evidence, while the
 * tracker owns pixel inference, appearance verification, and its size cap. */
export type PropagationTracker = Pick<VitTrack, "init" | "update" | "reanchor">;

export interface PropagationTrackerSession {
    newTrack(): PropagationTracker;
}

export interface SeedDetection {
    /** Raw normalized detector geometry, before coverage padding. */
    rect: CropRect;
    score: number;
}

interface PropagationOptions {
    margin: number;
    strongScore: number;
    seedScoreMin?: number;
    frames: readonly SourceFrameTiming[];
    bounds: TimeInterval;
    stats: DetectPassStats;
    signal: AbortSignal;
}

export interface BackwardPropagationJob {
    seedIndex: number;
    startIndex: number;
    rect: CropRect;
    trajectoryId: number;
    recoveryWarmupFrames: number;
    hasHighMotion: boolean;
}

interface Trajectory {
    id: number;
    seedIndex: number;
    startIndex: number;
    windowStartIndex: number;
    seedRect: CropRect;
    observations: Map<number, CropRect>;
    detectorAnchors: Map<number, CropRect>;
    backwardKnownFromIndex: number;
    detHits: number;
    bestScore: number;
    canBridgeBefore: boolean;
    canBridgeAfter: boolean;
    isRecoverySeed: boolean;
    hasHighMotion: boolean;
}

interface Branch {
    trajectory: Trajectory;
    tracker: PropagationTracker;
    lastIndex: number;
    lastUpdateIndex: number;
    lastCadenceIndex: number;
    trustedRect: CropRect;
    trustedIndex: number;
    previousTrusted: { rect: CropRect; index: number } | null;
    motionReference: { rect: CropRect; index: number };
    pendingIndices: number[];
    warmupRemaining: number;
    isCalibrationPending: boolean;
    hasOlderAnchorOverlap: boolean;
}

type TrackingFrame = OffscreenCanvas | ImageBitmap | NativeTrackingFrame;
type TrackingFrameSource = TrackingFrame | (() => TrackingFrame);
const TIME_EPSILON_SEC = 1e-6;
const RECOVERY_WARMUP_FRAMES = 2;

function coverRects(before: CropRect, after: CropRect): CropRect {
    if (
        before.xPct === after.xPct &&
        before.yPct === after.yPct &&
        before.wPct === after.wPct &&
        before.hPct === after.hPct
    ) {
        return before;
    }
    const left = Math.min(before.xPct, after.xPct);
    const top = Math.min(before.yPct, after.yPct);
    return {
        xPct: left,
        yPct: top,
        wPct: Math.max(before.xPct + before.wPct, after.xPct + after.wPct) - left,
        hPct: Math.max(before.yPct + before.hPct, after.yPct + after.hPct) - top,
    };
}

function rectToBox(rect: CropRect, frame: TrackingFrame): TrackBox {
    // Native crops retain a small raster workspace only for integer pixels.
    // Match the manual tracker seed convention; detector evidence stays raw.
    return {
        x: Math.round(rect.xPct * frame.width),
        y: Math.round(rect.yPct * frame.height),
        w: Math.max(2, Math.round(rect.wPct * frame.width)),
        h: Math.max(2, Math.round(rect.hPct * frame.height)),
    };
}

function validDetection(detection: SeedDetection): boolean {
    const rect = detection.rect;
    return (
        [detection.score, rect.xPct, rect.yPct, rect.wPct, rect.hPct].every(Number.isFinite) &&
        rect.wPct > 0 &&
        rect.hPct > 0 &&
        visibleBoxRect({ x: rect.xPct, y: rect.yPct, w: rect.wPct, h: rect.hPct }, 1, 1, 0) !== null
    );
}

/** Propagate one kind's raw detector seeds inside a continuous source window.
 * Each object owns its template and original size cap. Detector evidence alone
 * confirms identity; a failed prediction stops immediately unless a detector
 * on that same frame can reanchor the existing object without resetting its cap. */
export class DetectionPropagation {
    private readonly trajectories: Trajectory[] = [];
    private live: Branch[] = [];
    private readonly reverse = new Map<number, Branch[]>();
    private readonly startedReverseSeeds = new Set<number>();
    private readonly completedReverse = new Set<number>();
    private readonly earliestSeedByAnchorFrame = new Map<number, number>();
    private hasReportedUnconfirmed = false;
    private previousForwardIndex: number | null = null;
    private windowStartIndex: number | null = null;
    private readonly firstBoundIndex: number;
    private minFrameWidth = Number.POSITIVE_INFINITY;
    private minFrameHeight = Number.POSITIVE_INFINITY;

    constructor(
        private readonly session: PropagationTrackerSession,
        private readonly options: PropagationOptions,
    ) {
        this.firstBoundIndex = options.frames.findIndex(
            (frame) =>
                frame.contentSec + frame.durationSec > options.bounds.startSec &&
                frame.contentSec < options.bounds.endSec,
        );
    }

    private timing(index: number): SourceFrameTiming {
        const timing = this.options.frames[index];
        if (!Number.isInteger(index) || !timing) throw new Error("propagation frame index is invalid");
        return timing;
    }

    private confirmed(trajectory: Trajectory): boolean {
        return trajectory.detHits >= 2 || trajectory.bestScore >= this.options.strongScore;
    }

    private frame(source: TrackingFrameSource): TrackingFrame {
        const frame = typeof source === "function" ? source() : source;
        this.minFrameWidth = Math.min(this.minFrameWidth, frame.width);
        this.minFrameHeight = Math.min(this.minFrameHeight, frame.height);
        return frame;
    }

    private reliableAnchors(branches: readonly Branch[], detections: readonly SeedDetection[]): Set<Branch> {
        const result = new Set<Branch>();
        if (!branches.some((branch) => branch.trajectory.hasHighMotion || branch.isCalibrationPending)) return result;
        const eligible = detections.filter(
            (seed) =>
                validDetection(seed) && canSeedDetection(seed.score, { seedScoreMin: this.options.seedScoreMin ?? 0 }),
        );
        for (const index of matchPropagationDetections(
            eligible.map((seed) => seed.rect),
            branches.map((branch) => branch.trustedRect),
        )) {
            if (index >= 0) result.add(branches[index]!);
        }
        return result;
    }

    private outputRect(raw: CropRect): CropRect {
        const rect = visibleBoxRect({ x: raw.xPct, y: raw.yPct, w: raw.wPct, h: raw.hPct }, 1, 1, this.options.margin)!;
        if (!(this.options.margin > 0)) return rect;
        // Integer tracker boxes and interpolated pixels need at least one
        // source pixel of coverage even when a small object's relative margin
        // is subpixel. Keep raw geometry unchanged for identity and size guards.
        // Smallest observed dimensions retain that floor across size changes.
        const left = Math.max(0, Math.min(rect.xPct, raw.xPct - 1 / this.minFrameWidth));
        const top = Math.max(0, Math.min(rect.yPct, raw.yPct - 1 / this.minFrameHeight));
        const right = Math.min(1, Math.max(rect.xPct + rect.wPct, raw.xPct + raw.wPct + 1 / this.minFrameWidth));
        const bottom = Math.min(1, Math.max(rect.yPct + rect.hPct, raw.yPct + raw.hPct + 1 / this.minFrameHeight));
        return { xPct: left, yPct: top, wPct: right - left, hPct: bottom - top };
    }

    private indexAnchor(trajectory: Trajectory, frameIndex: number): void {
        const earliest = this.earliestSeedByAnchorFrame.get(frameIndex);
        if (earliest === undefined || trajectory.seedIndex < earliest) {
            this.earliestSeedByAnchorFrame.set(frameIndex, trajectory.seedIndex);
        }
    }

    /** Register the already decoded contiguous prefix when the first detector
     * hit creates this tracker lazily. No template existed in that prefix, but
     * backward tracking must still be allowed to recover its weak frames. */
    beginForwardWindow(startIndex: number): void {
        this.timing(startIndex);
        if (this.previousForwardIndex !== null) throw new Error("propagation forward window is already active");
        this.windowStartIndex = Math.max(this.firstBoundIndex, startIndex);
    }

    private initialize(source: TrackingFrameSource, rect: CropRect): PropagationTracker {
        this.options.signal.throwIfAborted();
        const started = performance.now();
        try {
            const frame = this.frame(source);
            const tracker = this.session.newTrack();
            tracker.init(frame, frame.width, frame.height, rectToBox(rect, frame));
            return tracker;
        } finally {
            this.options.stats.trackMs += performance.now() - started;
        }
    }

    private async predict(
        branch: Branch,
        source: TrackingFrameSource,
        index: number,
        backward: boolean,
        force = false,
        hasReliableAnchor = false,
    ) {
        this.options.signal.throwIfAborted();
        const timing = this.timing(index);
        const sec = timing.contentSec;
        const previousSec = this.timing(branch.lastUpdateIndex).contentSec;
        const cadenceSec = this.timing(branch.lastCadenceIndex).contentSec;
        const dtSec = backward ? previousSec - sec : sec - previousSec;
        if (!(dtSec > 0)) throw new Error("propagation update time must advance");
        branch.lastIndex = index;
        const isScheduled = isPropagationUpdateDue(cadenceSec, sec);
        // A VFR sample can own seconds of displayed pixels even when its
        // timestamp is close to the seed. Never project over a long hold.
        const isLongHold = timing.durationSec > PROPAGATION_INTERVAL_SEC + TIME_EPSILON_SEC;
        const hasHighMotion = branch.trajectory.hasHighMotion && !hasReliableAnchor;
        // One fresh forward observation establishes motion before the first
        // sparse jump. An eligible detector anchor can provide it instead.
        const shouldCalibrate = branch.isCalibrationPending && !hasReliableAnchor;
        if (
            !force &&
            !isScheduled &&
            !isLongHold &&
            !hasHighMotion &&
            !shouldCalibrate &&
            branch.warmupRemaining === 0
        ) {
            return {
                rect: branch.trustedRect,
                accepted: true,
                canBridge: false,
                observed: false,
                isAnchorRequired: hasReliableAnchor && (branch.trajectory.hasHighMotion || branch.isCalibrationPending),
            };
        }
        const started = performance.now();
        this.options.stats.trackUpdates++;
        if (backward) this.options.stats.backwardUpdates++;
        if (!isScheduled && branch.warmupRemaining > 0) {
            this.options.stats.recoveryUpdates = (this.options.stats.recoveryUpdates ?? 0) + 1;
        } else if (!isScheduled && hasHighMotion) {
            this.options.stats.highMotionUpdates = (this.options.stats.highMotionUpdates ?? 0) + 1;
        } else if (!isScheduled && shouldCalibrate) {
            this.options.stats.calibrationUpdates = (this.options.stats.calibrationUpdates ?? 0) + 1;
        }
        try {
            const frame = this.frame(source);
            const update = await branch.tracker.update(frame, frame.width, frame.height, dtSec);
            this.options.signal.throwIfAborted();
            branch.lastUpdateIndex = index;
            if (isScheduled) branch.lastCadenceIndex = index;
            if (branch.warmupRemaining > 0) branch.warmupRemaining--;
            const rect = boxToRect(update.box, frame.width, frame.height);
            const accepted =
                !update.rejected &&
                !update.lost &&
                Number.isFinite(update.score) &&
                update.score >= VITTRACK_SCORE_THRESHOLD &&
                [rect.xPct, rect.yPct, rect.wPct, rect.hPct].every(Number.isFinite) &&
                rect.wPct > 0 &&
                rect.hPct > 0 &&
                boxVisibleFraction(update.box, frame.width, frame.height) >= EXIT_VISIBLE_FRACTION;
            // Only brief loss of image evidence can be bracketed later. An
            // identity/geometry rejection or an observed exit must remain a
            // hard boundary even when another object appears nearby.
            const canBridge =
                !accepted &&
                !update.lost &&
                boxVisibleFraction(update.box, frame.width, frame.height) >= EXIT_VISIBLE_FRACTION &&
                (update.diagnostics.reason === "low-score" || update.diagnostics.reason === "texture-collapse");
            return { rect, accepted, canBridge, observed: true, isAnchorRequired: false };
        } finally {
            this.options.stats.trackMs += performance.now() - started;
        }
    }

    private accept(branch: Branch, frameIndex: number, rect: CropRect, observed: boolean): void {
        if (observed) {
            // Interpolate raw geometry at each displayed source timestamp.
            // Coverage padding is applied later, after association and size
            // guards, so motion does not inflate every intermediate mask.
            const beforeSec = this.timing(branch.trustedIndex).contentSec;
            const elapsed = this.timing(frameIndex).contentSec - beforeSec;
            if (frameIndex > branch.trajectory.seedIndex) {
                // When half an object can move during one inference interval,
                // sparse searches become unreliable. Preserve source cadence
                // for this trajectory unless a detector supplies the anchor.
                // Reverse uses this forward-established flag, allowing its
                // decoder to plan the same required pixels in advance.
                const before = branch.motionReference.rect;
                const motionElapsed =
                    this.timing(frameIndex).contentSec - this.timing(branch.motionReference.index).contentSec;
                const hasFullInterval = motionElapsed + TIME_EPSILON_SEC >= PROPAGATION_INTERVAL_SEC;
                // The initial short calibration can expose fast motion early.
                // Thereafter measure whole inference intervals: adjacent
                // detector frames may repeat a position and then jump, which
                // must not double the apparent velocity of a slow object.
                if (branch.isCalibrationPending || hasFullInterval) {
                    const dx = Math.abs(rect.xPct + rect.wPct / 2 - before.xPct - before.wPct / 2);
                    const dy = Math.abs(rect.yPct + rect.hPct / 2 - before.yPct - before.hPct / 2);
                    branch.trajectory.hasHighMotion ||=
                        (dx * PROPAGATION_INTERVAL_SEC) / motionElapsed >= Math.min(before.wPct, rect.wPct) / 2 ||
                        (dy * PROPAGATION_INTERVAL_SEC) / motionElapsed >= Math.min(before.hPct, rect.hPct) / 2;
                    if (hasFullInterval) branch.motionReference = { rect, index: frameIndex };
                }
            }
            for (const index of branch.pendingIndices) {
                branch.trajectory.observations.set(
                    index,
                    interpolateRect(branch.trustedRect, rect, (this.timing(index).contentSec - beforeSec) / elapsed),
                );
            }
            branch.pendingIndices = [];
            branch.previousTrusted = { rect: branch.trustedRect, index: branch.trustedIndex };
            branch.trustedRect = rect;
            branch.trustedIndex = frameIndex;
            branch.isCalibrationPending = false;
        } else {
            branch.pendingIndices.push(frameIndex);
            // A terminal skipped frame may precede the next rejection. Cover
            // its short travel from the last two trusted positions rather
            // than freezing a moving object at the previous sampled pixels.
            // Only unsampled time inside this inference interval is filled;
            // the rejected frame itself never receives extrapolated geometry.
            if (branch.previousTrusted) {
                const previous = branch.previousTrusted;
                const elapsed = this.timing(frameIndex).contentSec - this.timing(branch.trustedIndex).contentSec;
                const measured = this.timing(branch.trustedIndex).contentSec - this.timing(previous.index).contentSec;
                const fraction = elapsed / measured;
                rect = coverRects(branch.trustedRect, {
                    ...branch.trustedRect,
                    xPct: branch.trustedRect.xPct + (branch.trustedRect.xPct - previous.rect.xPct) * fraction,
                    yPct: branch.trustedRect.yPct + (branch.trustedRect.yPct - previous.rect.yPct) * fraction,
                });
            }
        }
        branch.trajectory.observations.set(frameIndex, rect);
    }

    async forward(
        source: TrackingFrameSource,
        frameIndex: number,
        detections: readonly SeedDetection[] | undefined,
        recover?: (lost: readonly CropRect[]) => Promise<readonly SeedDetection[]>,
    ): Promise<void> {
        this.options.signal.throwIfAborted();
        const timing = this.timing(frameIndex);
        if (timing.contentSec + timing.durationSec <= this.options.bounds.startSec) return;
        if (timing.contentSec >= this.options.bounds.endSec) {
            this.endForwardWindow();
            return;
        }
        if (this.previousForwardIndex !== null) {
            const previous = this.timing(this.previousForwardIndex);
            if (frameIndex <= this.previousForwardIndex || timing.contentSec <= previous.contentSec) {
                throw new Error("propagation forward frames must be time ordered");
            }
            if (
                frameIndex !== this.previousForwardIndex + 1 ||
                timing.contentSec > previous.contentSec + previous.durationSec + TIME_EPSILON_SEC
            ) {
                this.endForwardWindow();
            }
        }
        this.windowStartIndex ??= frameIndex;
        this.previousForwardIndex = frameIndex;
        const candidates = [];
        let isRecoveryScan = false;
        const reliableAnchors = this.reliableAnchors(this.live, detections ?? []);
        for (const branch of this.live) {
            const trustedRect = branch.trustedRect;
            const prediction = await this.predict(
                branch,
                source,
                frameIndex,
                false,
                timing.contentSec + timing.durationSec >= this.options.bounds.endSec - TIME_EPSILON_SEC,
                reliableAnchors.has(branch),
            );
            branch.trajectory.canBridgeAfter = prediction.canBridge;
            candidates.push({
                branch,
                trustedRect,
                ...prediction,
            });
        }
        if (detections === undefined && recover) {
            const lost = candidates
                .filter((candidate) => !candidate.accepted)
                .map((candidate) => candidate.trustedRect);
            if (lost.length > 0) {
                // Verify losses on this frame before discarding their branches.
                // A local detector supplies fresh class evidence; a failed
                // tracker prediction is never promoted or held as a cover.
                detections = await recover(lost);
                this.options.signal.throwIfAborted();
                isRecoveryScan = true;
            }
        }
        if (detections === undefined) {
            this.live = [];
            for (const candidate of candidates) {
                if (!candidate.accepted) continue;
                this.accept(candidate.branch, frameIndex, candidate.rect, candidate.observed);
                this.live.push(candidate.branch);
            }
            return;
        }

        const seeds = detections.filter(validDetection);
        const matches = matchPropagationDetections(
            seeds.map((seed) => seed.rect),
            candidates.map((candidate) => candidate.rect),
        );
        const continuing = new Set<Branch>();
        const replaced = new Set<Branch>();
        const next: Branch[] = [];
        for (let index = 0; index < seeds.length; index++) {
            this.options.signal.throwIfAborted();
            const seed = seeds[index]!;
            const seedable = canSeedDetection(seed.score, { seedScoreMin: this.options.seedScoreMin ?? 0 });
            const candidate = candidates[matches[index]!];
            // A weak hit must not refresh an already accepted prediction's
            // template. It can repair a loss only with appearance confirmation.
            if (candidate?.accepted && !seedable) continue;
            let anchored = false;
            if (candidate) {
                const started = performance.now();
                try {
                    // Recovery may have rasterized the source for the detector.
                    // Resolve it only when pixels are needed, then reuse them.
                    const frame = this.frame(source);
                    anchored = candidate.branch.tracker.reanchor(
                        frame,
                        frame.width,
                        frame.height,
                        rectToBox(seed.rect, frame),
                        !seedable,
                    );
                    if (!anchored) candidate.branch.trajectory.canBridgeAfter = false;
                } finally {
                    this.options.stats.trackMs += performance.now() - started;
                }
            }
            if (candidate && anchored) {
                const { branch } = candidate;
                if (isRecoveryScan && !candidate.accepted) branch.warmupRemaining = RECOVERY_WARMUP_FRAMES;
                branch.trajectory.canBridgeAfter = false;
                if (seedable) {
                    const wasConfirmed = this.confirmed(branch.trajectory);
                    branch.trajectory.detHits++;
                    branch.trajectory.bestScore = Math.max(branch.trajectory.bestScore, seed.score);
                    branch.trajectory.detectorAnchors.set(frameIndex, { ...seed.rect });
                    if (wasConfirmed) this.indexAnchor(branch.trajectory, frameIndex);
                    else if (this.confirmed(branch.trajectory)) {
                        for (const index of branch.trajectory.detectorAnchors.keys()) {
                            this.indexAnchor(branch.trajectory, index);
                        }
                    }
                }
                this.accept(branch, frameIndex, { ...seed.rect }, true);
                continuing.add(branch);
                next.push(branch);
            } else {
                if (!seedable) continue;
                // A matched detector seed can start a new size budget after a
                // rejected anchor, but the old trajectory already owns the
                // preceding frames. Do not emit two covers on this frame or
                // propagate the replacement back over that known trajectory.
                if (candidate) {
                    replaced.add(candidate.branch);
                }
                const trajectory: Trajectory = {
                    id: this.trajectories.length,
                    seedIndex: frameIndex,
                    startIndex: candidate ? frameIndex : Math.max(this.firstBoundIndex, this.windowStartIndex),
                    windowStartIndex: this.windowStartIndex,
                    seedRect: { ...seed.rect },
                    observations: new Map([[frameIndex, { ...seed.rect }]]),
                    detectorAnchors: new Map([[frameIndex, { ...seed.rect }]]),
                    backwardKnownFromIndex: frameIndex,
                    detHits: 1,
                    bestScore: seed.score,
                    canBridgeBefore: false,
                    canBridgeAfter: false,
                    isRecoverySeed: isRecoveryScan,
                    hasHighMotion: false,
                };
                this.trajectories.push(trajectory);
                this.options.stats.seededTracks = (this.options.stats.seededTracks ?? 0) + 1;
                if (this.confirmed(trajectory)) this.indexAnchor(trajectory, frameIndex);
                next.push({
                    trajectory,
                    tracker: this.initialize(source, seed.rect),
                    lastIndex: frameIndex,
                    lastUpdateIndex: frameIndex,
                    lastCadenceIndex: frameIndex,
                    trustedRect: { ...seed.rect },
                    trustedIndex: frameIndex,
                    previousTrusted: null,
                    motionReference: { rect: { ...seed.rect }, index: frameIndex },
                    pendingIndices: [],
                    warmupRemaining: isRecoveryScan ? RECOVERY_WARMUP_FRAMES : 0,
                    isCalibrationPending: true,
                    hasOlderAnchorOverlap: false,
                });
            }
        }
        for (const candidate of candidates) {
            if (candidate.isAnchorRequired && !continuing.has(candidate.branch) && !replaced.has(candidate.branch)) {
                // Another prediction may win or contest the preliminary
                // detector match. A skipped fast/calibration update is safe
                // only after its promised anchor actually succeeds.
                Object.assign(candidate, await this.predict(candidate.branch, source, frameIndex, false, true));
                candidate.branch.trajectory.canBridgeAfter = candidate.canBridge;
            }
            // A sparse detector miss does not disprove an accepted tracker
            // prediction. Only actual tracker rejection or an explicit matched
            // replacement ends this branch.
            if (!continuing.has(candidate.branch) && !replaced.has(candidate.branch) && candidate.accepted) {
                this.accept(candidate.branch, frameIndex, candidate.rect, candidate.observed);
                next.push(candidate.branch);
            }
        }
        this.live = next;
    }

    /** A new source window must not inherit a template, timing, or backward
     * bound from the preceding one. Finished observations remain available. */
    endForwardWindow(): void {
        this.live = [];
        this.previousForwardIndex = null;
        this.windowStartIndex = null;
    }

    backwardJobs(): BackwardPropagationJob[] {
        return this.trajectories
            .filter((trajectory) => this.confirmed(trajectory) && trajectory.startIndex < trajectory.seedIndex)
            .map((trajectory) => ({
                trajectoryId: trajectory.id,
                seedIndex: trajectory.seedIndex,
                startIndex: trajectory.startIndex,
                rect: { ...trajectory.seedRect },
                recoveryWarmupFrames: trajectory.isRecoverySeed ? RECOVERY_WARMUP_FRAMES : 0,
                hasHighMotion: trajectory.hasHighMotion,
            }));
    }

    startBackward(source: TrackingFrameSource, seedIndex: number): void {
        this.options.signal.throwIfAborted();
        this.timing(seedIndex);
        if (this.startedReverseSeeds.has(seedIndex)) throw new Error("propagation backward seed is already started");
        const branches = this.backwardJobs()
            .filter((job) => job.seedIndex === seedIndex)
            .map((job) => ({
                trajectory: this.trajectories[job.trajectoryId]!,
                tracker: this.initialize(source, job.rect),
                lastIndex: seedIndex,
                lastUpdateIndex: seedIndex,
                lastCadenceIndex: seedIndex,
                trustedRect: { ...job.rect },
                trustedIndex: seedIndex,
                previousTrusted: null,
                motionReference: { rect: { ...job.rect }, index: seedIndex },
                pendingIndices: [],
                warmupRemaining: job.recoveryWarmupFrames,
                isCalibrationPending: false,
                hasOlderAnchorOverlap: false,
            }));
        this.startedReverseSeeds.add(seedIndex);
        if (branches.length > 0) this.reverse.set(seedIndex, branches);
    }

    hasBackwardWork(seedIndex?: number): boolean {
        return seedIndex === undefined ? this.reverse.size > 0 : this.reverse.has(seedIndex);
    }

    /** Pixel preparation can share a display canvas for multiple objects;
     * these counts do not change inference cadence or branch decisions. */
    forwardTrackCount(): number {
        return this.live.length;
    }

    backwardTrackCount(seedIndex: number): number {
        return this.reverse.get(seedIndex)?.length ?? 0;
    }

    /** Keep each discovery group's one-to-one anchor matching independent.
     * Shared-frame callers process older seed groups first, making their final
     * observation/absence at this frame available to younger duplicate checks. */
    async backward(
        source: TrackingFrameSource,
        frameIndex: number,
        detections?: readonly SeedDetection[],
        seedIndex?: number,
    ): Promise<void> {
        this.options.signal.throwIfAborted();
        const timing = this.timing(frameIndex);
        if (seedIndex === undefined && this.reverse.size > 1) {
            throw new Error("propagation backward update requires a seed group");
        }
        const groupSeedIndex = seedIndex ?? this.reverse.keys().next().value;
        if (groupSeedIndex === undefined) return;
        const candidates = [];
        const branches = this.reverse.get(groupSeedIndex) ?? [];
        const anchors = detections?.filter(validDetection) ?? [];
        const reliableAnchors = this.reliableAnchors(branches, anchors);
        for (const branch of branches) {
            if (frameIndex < branch.trajectory.startIndex) {
                this.completedReverse.add(branch.trajectory.id);
                continue;
            }
            const previous = this.timing(branch.lastIndex);
            if (frameIndex >= branch.lastIndex || timing.contentSec >= previous.contentSec) {
                throw new Error("propagation backward frames must be reverse time ordered");
            }
            if (
                frameIndex !== branch.lastIndex - 1 ||
                previous.contentSec > timing.contentSec + timing.durationSec + TIME_EPSILON_SEC
            ) {
                this.completedReverse.add(branch.trajectory.id);
                continue;
            }
            candidates.push({
                branch,
                hasRejectedAnchor: false,
                ...(await this.predict(
                    branch,
                    source,
                    frameIndex,
                    true,
                    frameIndex === branch.trajectory.startIndex,
                    reliableAnchors.has(branch),
                )),
            });
        }
        const matches = matchPropagationDetections(
            anchors.map((anchor) => anchor.rect),
            candidates.map((candidate) => candidate.rect),
        );
        for (let index = 0; index < anchors.length; index++) {
            this.options.signal.throwIfAborted();
            const candidate = candidates[matches[index]!];
            if (!candidate) continue;
            const anchor = anchors[index]!;
            const seedable = canSeedDetection(anchor.score, { seedScoreMin: this.options.seedScoreMin ?? 0 });
            if (candidate.accepted && !seedable) continue;
            const started = performance.now();
            try {
                const frame = this.frame(source);
                // Weak observations may repair a rejected prediction, but must
                // not overwrite an accepted reverse estimate. Strong anchors
                // may correct it while retaining the original size cap and
                // adding no independent seed evidence.
                if (
                    candidate.branch.tracker.reanchor(
                        frame,
                        frame.width,
                        frame.height,
                        rectToBox(anchor.rect, frame),
                        !seedable,
                    )
                ) {
                    candidate.rect = { ...anchor.rect };
                    candidate.accepted = true;
                    candidate.observed = true;
                } else {
                    candidate.canBridge = false;
                    candidate.hasRejectedAnchor = true;
                }
            } finally {
                this.options.stats.trackMs += performance.now() - started;
            }
        }
        const next: Branch[] = [];
        let older: PropagationPrefix[] | undefined;
        for (const candidate of candidates) {
            const { branch } = candidate;
            if (candidate.isAnchorRequired && !candidate.observed) {
                Object.assign(candidate, await this.predict(branch, source, frameIndex, true, true));
                // An appearance/geometry rejection stays a hard boundary even
                // if the fallback prediction only reports a bridgeable loss.
                if (candidate.hasRejectedAnchor) candidate.canBridge = false;
            }
            // Skipped holds can still widen when the next trusted sample
            // arrives; only a settled frontier is safe for duplicate checks.
            if (candidate.observed) branch.trajectory.backwardKnownFromIndex = frameIndex;
            if (!candidate.accepted) {
                branch.trajectory.canBridgeBefore = candidate.canBridge;
                this.completedReverse.add(branch.trajectory.id);
                continue;
            }
            this.accept(branch, frameIndex, candidate.rect, candidate.observed);
            const earliestSeed = this.earliestSeedByAnchorFrame.get(frameIndex);
            branch.hasOlderAnchorOverlap ||= earliestSeed !== undefined && earliestSeed < groupSeedIndex;
            let duplicateEndIndex: number | null = null;
            if (branch.hasOlderAnchorOverlap && candidate.observed) {
                // All branches here share a seed index. Older groups cannot
                // change during this call, so build their readiness once.
                older ??= this.trajectories
                    .filter((trajectory) => trajectory.seedIndex < groupSeedIndex && this.confirmed(trajectory))
                    .map((trajectory) => ({
                        seedIndex: trajectory.seedIndex,
                        observations: trajectory.observations,
                        detectorAnchors: trajectory.detectorAnchors,
                        backwardKnownFromIndex: trajectory.backwardKnownFromIndex,
                        backwardComplete:
                            trajectory.startIndex >= trajectory.seedIndex || this.completedReverse.has(trajectory.id),
                    }));
                duplicateEndIndex = duplicatePropagationPrefixEndIndex(branch.trajectory, older);
            }
            if (frameIndex > branch.trajectory.startIndex && duplicateEndIndex === null) {
                next.push(branch);
            } else {
                this.completedReverse.add(branch.trajectory.id);
            }
        }
        if (next.length > 0) this.reverse.set(groupSeedIndex, next);
        else this.reverse.delete(groupSeedIndex);
    }

    finish(): DetectedTrack[] {
        this.endForwardWindow();
        this.reverse.clear();
        const tracks: DetectedTrack[] = [];
        const confirmed = this.trajectories.filter((trajectory) => this.confirmed(trajectory));
        if (!this.hasReportedUnconfirmed) {
            this.options.stats.unconfirmedTracks =
                (this.options.stats.unconfirmedTracks ?? 0) + this.trajectories.length - confirmed.length;
            this.hasReportedUnconfirmed = true;
        }
        const spans = confirmed.map((trajectory) => {
            const duplicateEndIndex = duplicatePropagationPrefixEndIndex(trajectory, confirmed);
            return {
                ...trajectory,
                observations: new Map(
                    [...trajectory.observations].filter(
                        ([index]) => duplicateEndIndex === null || index > duplicateEndIndex,
                    ),
                ),
                strongScore: this.options.strongScore,
            };
        });
        for (const bridge of propagationGapBridges(spans, this.options.frames)) {
            const span = spans[bridge.before]!;
            for (const [index, rect] of bridge.observations) span.observations.set(index, rect);
        }
        for (const trajectory of spans) {
            const observations: PropagatedObservation[] = [...trajectory.observations]
                .sort(([a], [b]) => a - b)
                .map(([index, raw]) => ({
                    contentSec: this.timing(index).contentSec,
                    rect: this.outputRect(raw),
                }));
            const track = buildPropagatedTrack(observations, this.options.frames, this.options.bounds, {
                detHits: trajectory.detHits,
                bestScore: trajectory.bestScore,
                strongScore: this.options.strongScore,
            });
            if (track) tracks.push(track);
        }
        return tracks.sort((a, b) => a.startSec - b.startSec);
    }
}

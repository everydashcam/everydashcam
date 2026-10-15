import type { CropRect } from "../transcode/compose.js";
import type { DetectPassStats } from "../workers/tracker-protocol.js";
import { boxToRect, visibleBoxRect } from "./box-geometry.js";
import type { DetectedTrack } from "./detect-track.js";
import { canSeedDetection } from "./detector-policy.js";
import { iouOf } from "./detect-common.js";
import { isPropagationUpdateDue, PROPAGATION_INTERVAL_SEC } from "./frame-sampling.js";
import type { TimeInterval } from "./interval-set.js";
import type { NativeTrackingFrame } from "./tracking-frame.js";
import { buildPropagatedTrack, interpolateRect, type SourceFrameTiming } from "./propagated-track.js";
import {
    boxVisibleFraction,
    EXIT_VISIBLE_FRACTION,
    isPlausibleStep,
    MAX_CENTER_SPEED_PER_SEC,
    seedSizeCap,
    type TrackBox,
} from "./track-guards.js";
import { type VitTrack, VITTRACK_SCORE_THRESHOLD } from "./vittrack.js";

export type PropagationTracker = Pick<VitTrack, "init" | "update">;
export interface PropagationTrackerSession {
    newTrack(): PropagationTracker;
}

export interface SeedDetection {
    rect: CropRect;
    score: number;
}

interface PropagationOptions {
    margin: number;
    seedScoreMin: number;
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
    hasHighMotion: boolean;
}

interface Trajectory {
    id: number;
    checkpointIndex: number;
    rootRect: CropRect;
    isRecovery: boolean;
    seedIndex: number;
    startIndex: number;
    seedRect: CropRect;
    score: number;
    observations: Map<number, CropRect>;
    hasHighMotion: boolean;
    minFrameWidth: number;
    minFrameHeight: number;
}

interface Branch {
    trajectory: Trajectory;
    tracker: PropagationTracker | null;
    lastIndex: number;
    lastUpdateIndex: number;
    lastCadenceIndex: number;
    trustedRect: CropRect;
    trustedIndex: number;
    previousMotionReference: { rect: CropRect; index: number } | null;
    motionReference: { rect: CropRect; index: number };
    pendingIndices: number[];
    isCalibrationPending: boolean;
}

type TrackingFrame = OffscreenCanvas | ImageBitmap | NativeTrackingFrame;
type TrackingFrameSource = TrackingFrame | (() => TrackingFrame);
type Redetect = () => Promise<readonly SeedDetection[]>;
const TIME_EPSILON_SEC = 1e-6;

function rectOverlap(a: CropRect, b: CropRect): number {
    const raw = (rect: CropRect) => ({ x: rect.xPct, y: rect.yPct, w: rect.wPct, h: rect.hPct, score: 0 });
    return iouOf(raw(a), raw(b));
}

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

/** Each detector hit owns an independent trajectory. Tracking includes both
 * adjacent scheduled scans, including empty ones, but never crosses them.
 * A null session copies boxes between dense checkpoints without model tracking. */
export class DetectionPropagation {
    private readonly trajectories: Trajectory[] = [];
    private live: Branch[] = [];
    private readonly reverse = new Map<number, Branch[]>();
    private readonly startedReverseSeeds = new Set<number>();
    private readonly uncertain = new Map<number, Set<number>>();
    private previousForwardIndex: number | null = null;
    private windowStartIndex: number | null = null;
    private lastCheckpointIndex: number | null = null;
    private readonly firstBoundIndex: number;

    constructor(
        private readonly session: PropagationTrackerSession | null,
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

    private frame(source: TrackingFrameSource, trajectory: Trajectory): TrackingFrame {
        const frame = typeof source === "function" ? source() : source;
        trajectory.minFrameWidth = Math.min(trajectory.minFrameWidth, frame.width);
        trajectory.minFrameHeight = Math.min(trajectory.minFrameHeight, frame.height);
        return frame;
    }

    private outputRect(raw: CropRect, trajectory: Trajectory): CropRect {
        const rect = visibleBoxRect({ x: raw.xPct, y: raw.yPct, w: raw.wPct, h: raw.hPct }, 1, 1, this.options.margin)!;
        if (!(this.options.margin > 0)) return rect;
        // Integer tracker boxes and interpolated pixels need at least one
        // source pixel of coverage even when a small object's relative margin
        // is subpixel. Keep raw geometry unchanged for identity and size guards.
        // Dimensions belong to this bounded trajectory; unrelated checkpoints
        // must not change its padding when a cached range grows.
        const left = Math.max(0, Math.min(rect.xPct, raw.xPct - 1 / trajectory.minFrameWidth));
        const top = Math.max(0, Math.min(rect.yPct, raw.yPct - 1 / trajectory.minFrameHeight));
        const right = Math.min(1, Math.max(rect.xPct + rect.wPct, raw.xPct + raw.wPct + 1 / trajectory.minFrameWidth));
        const bottom = Math.min(
            1,
            Math.max(rect.yPct + rect.hPct, raw.yPct + raw.hPct + 1 / trajectory.minFrameHeight),
        );
        return { xPct: left, yPct: top, wPct: right - left, hPct: bottom - top };
    }

    /** Lazy creation still needs the preceding empty checkpoint as a boundary. */
    beginForwardWindow(startIndex: number, previousCheckpointIndex: number | null = null): void {
        this.timing(startIndex);
        if (this.previousForwardIndex !== null) throw new Error("propagation forward window is already active");
        this.windowStartIndex = Math.max(this.firstBoundIndex, startIndex);
        this.lastCheckpointIndex =
            previousCheckpointIndex !== null && previousCheckpointIndex >= this.windowStartIndex
                ? previousCheckpointIndex
                : null;
    }

    private branch(source: TrackingFrameSource, trajectory: Trajectory): Branch {
        this.options.signal.throwIfAborted();
        const frame = this.frame(source, trajectory);
        const started = performance.now();
        let tracker: PropagationTracker | null = null;
        try {
            if (this.session) {
                tracker = this.session.newTrack();
                tracker.init(frame, frame.width, frame.height, rectToBox(trajectory.seedRect, frame));
            }
        } finally {
            if (this.session) this.options.stats.trackMs += performance.now() - started;
        }
        return {
            trajectory,
            tracker,
            lastIndex: trajectory.seedIndex,
            lastUpdateIndex: trajectory.seedIndex,
            lastCadenceIndex: trajectory.seedIndex,
            trustedRect: trajectory.seedRect,
            trustedIndex: trajectory.seedIndex,
            previousMotionReference: null,
            motionReference: { rect: trajectory.seedRect, index: trajectory.seedIndex },
            pendingIndices: [],
            isCalibrationPending: true,
        };
    }

    private async predict(
        branch: Branch,
        source: TrackingFrameSource,
        index: number,
        backward: boolean,
        force = false,
    ) {
        this.options.signal.throwIfAborted();
        if (!branch.tracker) return { rect: branch.trustedRect, accepted: true, observed: true };
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
        const hasHighMotion = branch.trajectory.hasHighMotion;
        // Observe one full inference interval in each direction before the
        // first sparse jump.
        const shouldCalibrate = branch.isCalibrationPending;
        if (!force && !isScheduled && !isLongHold && !hasHighMotion && !shouldCalibrate) {
            return {
                rect: branch.trustedRect,
                accepted: true,
                observed: false,
            };
        }
        const started = performance.now();
        this.options.stats.trackUpdates++;
        if (backward) this.options.stats.backwardUpdates++;
        if (!isScheduled && hasHighMotion) {
            this.options.stats.highMotionUpdates = (this.options.stats.highMotionUpdates ?? 0) + 1;
        } else if (!isScheduled && shouldCalibrate) {
            this.options.stats.calibrationUpdates = (this.options.stats.calibrationUpdates ?? 0) + 1;
        }
        try {
            const frame = this.frame(source, branch.trajectory);
            const update = await branch.tracker.update(frame, frame.width, frame.height, dtSec);
            this.options.signal.throwIfAborted();
            branch.lastUpdateIndex = index;
            if (isScheduled) branch.lastCadenceIndex = index;
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
            return { rect, accepted, observed: true };
        } finally {
            if (this.session) this.options.stats.trackMs += performance.now() - started;
        }
    }

    private accept(branch: Branch, frameIndex: number, rect: CropRect, observed: boolean): void {
        if (observed) {
            // Interpolate raw geometry at each displayed source timestamp.
            // Coverage padding is applied later, after size
            // guards, so motion does not inflate every intermediate mask.
            const beforeSec = this.timing(branch.trustedIndex).contentSec;
            const elapsed = this.timing(frameIndex).contentSec - beforeSec;
            const before = branch.motionReference.rect;
            const motionElapsed = Math.abs(
                this.timing(frameIndex).contentSec - this.timing(branch.motionReference.index).contentSec,
            );
            const hasFullInterval = motionElapsed + TIME_EPSILON_SEC >= PROPAGATION_INTERVAL_SEC;
            if (hasFullInterval) {
                // When half an object can move during one inference interval,
                // sparse searches become unreliable. Preserve source cadence
                // for this trajectory.
                // Reverse can discover motion absent after the seed; its
                // decoder extends the remaining pixel plan on that transition.
                // Measure over a whole interval to avoid amplifying jitter.
                const dx = Math.abs(rect.xPct + rect.wPct / 2 - before.xPct - before.wPct / 2);
                const dy = Math.abs(rect.yPct + rect.hPct / 2 - before.yPct - before.hPct / 2);
                branch.trajectory.hasHighMotion ||=
                    (dx * PROPAGATION_INTERVAL_SEC) / motionElapsed >= Math.min(before.wPct, rect.wPct) / 2 ||
                    (dy * PROPAGATION_INTERVAL_SEC) / motionElapsed >= Math.min(before.hPct, rect.hPct) / 2;
                branch.previousMotionReference = branch.motionReference;
                branch.motionReference = { rect, index: frameIndex };
                branch.isCalibrationPending = false;
            }
            for (const index of branch.pendingIndices) {
                branch.trajectory.observations.set(
                    index,
                    interpolateRect(branch.trustedRect, rect, (this.timing(index).contentSec - beforeSec) / elapsed),
                );
            }
            branch.pendingIndices = [];
            branch.trustedRect = rect;
            branch.trustedIndex = frameIndex;
        } else {
            branch.pendingIndices.push(frameIndex);
            // A terminal skipped frame may precede the next rejection. Cover
            // its short travel from trusted motion over an inference interval.
            // Subpixel jitter must not become an unbounded velocity estimate.
            // Until a full interval exists, use its duration as the floor.
            // Only unsampled time inside this inference interval is filled;
            // the rejected frame itself never receives extrapolated geometry.
            const previous = branch.previousMotionReference ?? branch.motionReference;
            const trusted = branch.trustedRect;
            const elapsed = Math.min(
                Math.abs(this.timing(frameIndex).contentSec - this.timing(branch.trustedIndex).contentSec),
                PROPAGATION_INTERVAL_SEC,
            );
            const measured = Math.abs(
                this.timing(branch.trustedIndex).contentSec - this.timing(previous.index).contentSec,
            );
            const fraction = elapsed / Math.max(measured, PROPAGATION_INTERVAL_SEC);
            const dx = (trusted.xPct + trusted.wPct / 2 - previous.rect.xPct - previous.rect.wPct / 2) * fraction;
            const dy = (trusted.yPct + trusted.hPct / 2 - previous.rect.yPct - previous.rect.hPct / 2) * fraction;
            // Unobserved travel gets the same physical speed ceiling as a
            // tracker prediction.
            const distance = Math.hypot(dx, dy);
            const scale = distance > 0 ? Math.min(1, (MAX_CENTER_SPEED_PER_SEC * elapsed) / distance) : 1;
            rect = coverRects(trusted, {
                ...trusted,
                xPct: trusted.xPct + dx * scale,
                yPct: trusted.yPct + dy * scale,
            });
        }
        branch.trajectory.observations.set(frameIndex, rect);
    }

    /** Recovery belongs to its original checkpoint window. A new detector seed
     * never changes neighboring branches or bridges a rejected prediction. */
    private async recover(
        failed: readonly Branch[],
        live: Branch[],
        source: TrackingFrameSource,
        index: number,
        backward: boolean,
        redetect?: Redetect,
    ): Promise<void> {
        if (!failed.length || !redetect) return;
        const detections = await redetect();
        this.options.signal.throwIfAborted();
        const available = new Set(
            detections.filter((seed) => validDetection(seed) && canSeedDetection(seed.score, this.options)),
        );
        for (const branch of failed) {
            const frame = this.frame(source, branch.trajectory);
            const previous = rectToBox(branch.trustedRect, frame);
            const cap = seedSizeCap(rectToBox(branch.trajectory.rootRect, frame), frame.width, frame.height);
            const dtSec = Math.abs(this.timing(index).contentSec - this.timing(branch.trustedIndex).contentSec);
            let selected: SeedDetection | undefined;
            let nearest = Infinity;
            for (const seed of available) {
                // A surviving object already owns its observation on this frame.
                if (live.some((other) => rectOverlap(other.trustedRect, seed.rect) > 0.5)) continue;
                const box = rectToBox(seed.rect, frame);
                // Independent detections can correct scale; the original size
                // cap and physical travel bound still prevent unrelated jumps.
                if (!isPlausibleStep(previous, box, cap, frame.width, frame.height, 0, dtSec)) continue;
                const distance = Math.hypot(
                    (box.x + box.w / 2 - previous.x - previous.w / 2) / frame.width,
                    (box.y + box.h / 2 - previous.y - previous.h / 2) / frame.height,
                );
                if (distance < nearest) {
                    selected = seed;
                    nearest = distance;
                }
            }
            if (!selected) {
                const indices = this.uncertain.get(branch.trajectory.checkpointIndex) ?? new Set<number>();
                indices.add(index);
                this.uncertain.set(branch.trajectory.checkpointIndex, indices);
                continue;
            }
            available.delete(selected);
            const trajectory: Trajectory = {
                id: this.trajectories.length,
                checkpointIndex: branch.trajectory.checkpointIndex,
                rootRect: branch.trajectory.rootRect,
                isRecovery: true,
                seedIndex: index,
                startIndex: backward ? branch.trajectory.startIndex : index,
                seedRect: { ...selected.rect },
                score: selected.score,
                observations: new Map([[index, { ...selected.rect }]]),
                // A restarted branch has a new sampling phase. Use every frame
                // until the next fixed checkpoint, including reverse replanning.
                hasHighMotion: true,
                minFrameWidth: Infinity,
                minFrameHeight: Infinity,
            };
            this.trajectories.push(trajectory);
            this.options.stats.recoveredTracks = (this.options.stats.recoveredTracks ?? 0) + 1;
            live.push(this.branch(source, trajectory));
        }
    }

    async forward(
        source: TrackingFrameSource,
        frameIndex: number,
        detections: readonly SeedDetection[] | undefined,
        redetect?: Redetect,
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
            if (frameIndex <= this.previousForwardIndex || timing.contentSec <= previous.contentSec)
                throw new Error("propagation forward frames must be time ordered");
            if (
                frameIndex !== this.previousForwardIndex + 1 ||
                timing.contentSec > previous.contentSec + previous.durationSec + TIME_EPSILON_SEC
            )
                this.endForwardWindow();
        }
        this.windowStartIndex ??= frameIndex;
        this.previousForwardIndex = frameIndex;
        const next: Branch[] = [];
        const failed: Branch[] = [];
        // Verify the boundary frame before ending a model-backed branch. Dense
        // detection has no tracker evidence to override a checkpoint result.
        if (detections === undefined || this.session) {
            for (const branch of this.live) {
                const prediction = await this.predict(
                    branch,
                    source,
                    frameIndex,
                    false,
                    detections !== undefined ||
                        timing.contentSec + timing.durationSec >= this.options.bounds.endSec - TIME_EPSILON_SEC,
                );
                if (!prediction.accepted) {
                    failed.push(branch);
                    continue;
                }
                this.accept(branch, frameIndex, prediction.rect, prediction.observed);
                next.push(branch);
            }
            // Scheduled scans are already cached by the caller. Recovery can
            // resolve a rejected boundary update without another detector pass.
            await this.recover(failed, next, source, frameIndex, false, redetect);
        }
        if (detections !== undefined) {
            // No matching or reanchoring: even an identical hit starts afresh.
            this.live = [];
            for (const seed of detections) {
                if (!validDetection(seed) || !canSeedDetection(seed.score, this.options)) continue;
                const trajectory: Trajectory = {
                    id: this.trajectories.length,
                    checkpointIndex: frameIndex,
                    rootRect: { ...seed.rect },
                    isRecovery: false,
                    seedIndex: frameIndex,
                    startIndex: Math.max(
                        this.windowStartIndex,
                        (this.lastCheckpointIndex ?? -1) + (this.session ? 0 : 1),
                    ),
                    seedRect: { ...seed.rect },
                    score: seed.score,
                    observations: new Map([[frameIndex, { ...seed.rect }]]),
                    hasHighMotion: false,
                    minFrameWidth: Number.POSITIVE_INFINITY,
                    minFrameHeight: Number.POSITIVE_INFINITY,
                };
                this.trajectories.push(trajectory);
                this.options.stats.seededTracks = (this.options.stats.seededTracks ?? 0) + 1;
                this.live.push(this.branch(source, trajectory));
                // Dense detection copies the seed only onto unchecked source
                // frames. Checkpoints themselves always retain their own result.
                if (!this.session)
                    for (let index = trajectory.startIndex; index < frameIndex; index++)
                        trajectory.observations.set(index, { ...seed.rect });
            }
            this.lastCheckpointIndex = frameIndex;
            return;
        }
        this.live = next;
    }

    endForwardWindow(): void {
        this.live = [];
        this.previousForwardIndex = null;
        this.windowStartIndex = null;
        this.lastCheckpointIndex = null;
    }

    backwardJobs(): BackwardPropagationJob[] {
        if (!this.session) return [];
        return this.trajectories
            .filter((trajectory) => !trajectory.isRecovery && trajectory.startIndex < trajectory.seedIndex)
            .map((trajectory) => ({
                trajectoryId: trajectory.id,
                seedIndex: trajectory.seedIndex,
                startIndex: trajectory.startIndex,
                rect: { ...trajectory.seedRect },
                hasHighMotion: trajectory.hasHighMotion,
            }));
    }

    startBackward(source: TrackingFrameSource, seedIndex: number): void {
        this.options.signal.throwIfAborted();
        if (this.startedReverseSeeds.has(seedIndex)) throw new Error("propagation backward seed is already started");
        const branches = this.backwardJobs()
            .filter((job) => job.seedIndex === seedIndex)
            .map((job) => this.branch(source, this.trajectories[job.trajectoryId]!));
        this.startedReverseSeeds.add(seedIndex);
        if (branches.length) this.reverse.set(seedIndex, branches);
    }

    hasBackwardWork(seedIndex?: number): boolean {
        return seedIndex === undefined ? this.reverse.size > 0 : this.reverse.has(seedIndex);
    }

    hasBackwardHighMotion(seedIndex: number): boolean {
        return this.reverse.get(seedIndex)?.some((branch) => branch.trajectory.hasHighMotion) ?? false;
    }

    forwardTrackCount(): number {
        return this.live.length;
    }

    backwardTrackCount(seedIndex: number): number {
        return this.reverse.get(seedIndex)?.length ?? 0;
    }

    async backward(
        source: TrackingFrameSource,
        frameIndex: number,
        seedIndex?: number,
        redetect?: Redetect,
    ): Promise<void> {
        this.options.signal.throwIfAborted();
        const timing = this.timing(frameIndex);
        if (seedIndex === undefined && this.reverse.size > 1)
            throw new Error("propagation backward update requires a seed group");
        const groupSeedIndex = seedIndex ?? this.reverse.keys().next().value;
        if (groupSeedIndex === undefined) return;
        const next: Branch[] = [];
        const failed: Branch[] = [];
        const accepted: Branch[] = [];
        for (const branch of this.reverse.get(groupSeedIndex) ?? []) {
            if (frameIndex < branch.trajectory.startIndex) continue;
            const previous = this.timing(branch.lastIndex);
            if (frameIndex >= branch.lastIndex || timing.contentSec >= previous.contentSec)
                throw new Error("propagation backward frames must be reverse time ordered");
            if (
                frameIndex !== branch.lastIndex - 1 ||
                previous.contentSec > timing.contentSec + timing.durationSec + TIME_EPSILON_SEC
            )
                continue;
            const prediction = await this.predict(
                branch,
                source,
                frameIndex,
                true,
                frameIndex === branch.trajectory.startIndex,
            );
            if (!prediction.accepted) {
                failed.push(branch);
                continue;
            }
            this.accept(branch, frameIndex, prediction.rect, prediction.observed);
            accepted.push(branch);
        }
        await this.recover(failed, accepted, source, frameIndex, true, redetect);
        next.push(...accepted.filter((branch) => frameIndex > branch.trajectory.startIndex));
        if (next.length) this.reverse.set(groupSeedIndex, next);
        else this.reverse.delete(groupSeedIndex);
    }

    finish(): DetectedTrack[] {
        return [...this.finishByCheckpoint().values()].flat().sort((a, b) => a.startSec - b.startSec);
    }

    uncertainFramesByCheckpoint(): Map<number, SourceFrameTiming[]> {
        return new Map(
            [...this.uncertain].map(([checkpoint, indices]) => [
                this.timing(checkpoint).contentSec,
                [...indices].sort((a, b) => a - b).map((index) => ({ ...this.timing(index) })),
            ]),
        );
    }

    /** Preserve seed ownership so a completed trajectory can be reused only
     * while both of its checkpoint boundaries remain unchanged. */
    finishByCheckpoint(): Map<number, DetectedTrack[]> {
        this.endForwardWindow();
        this.reverse.clear();
        const tracks = new Map<number, DetectedTrack[]>();
        for (const trajectory of this.trajectories) {
            const entries = [...trajectory.observations].sort(([a], [b]) => a - b);
            const observations = entries.map(([index, raw]) => ({
                contentSec: this.timing(index).contentSec,
                rect: this.outputRect(raw, trajectory),
            }));
            const track = buildPropagatedTrack(
                observations,
                this.options.frames.slice(entries[0]![0], entries[entries.length - 1]![0] + 1),
                this.options.bounds,
                {
                    detHits: 1,
                    bestScore: trajectory.score,
                },
            );
            if (track) {
                const sec = this.timing(trajectory.checkpointIndex).contentSec;
                const group = tracks.get(sec) ?? [];
                group.push(track);
                tracks.set(sec, group);
            }
        }
        return tracks;
    }
}

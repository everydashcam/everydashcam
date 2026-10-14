import { describe, expect, it } from "vitest";
import { type BlurRegion, regionRectAt } from "../blur-regions.js";
import type { CropRect } from "../transcode/compose.js";
import type { DetectPassStats } from "../workers/tracker-protocol.js";
import type { DetectedTrack } from "./detect-track.js";
import {
    DetectionPropagation,
    type PropagationTracker,
    type PropagationTrackerSession,
    type SeedDetection,
} from "./detection-propagation.js";
import type { SourceFrameTiming } from "./propagated-track.js";
import { planReverseFrameIndices } from "./reverse-decode-plan.js";
import type { TrackBox } from "./track-guards.js";

const FRAME: ImageBitmap = { width: 1000, height: 500, close() {} };
// Association and rejection scripts run on inference frames. Separate cadence
// cases below exercise higher frame rates and their intervening source holds.
const FRAME_SEC = 1 / 15;
type Update = Awaited<ReturnType<PropagationTracker["update"]>>;

function rect(xPct = 0.2): CropRect {
    return { xPct, yPct: 0.4, wPct: 0.1, hPct: 0.05 };
}

function seed(xPct = 0.2, score = 0.8): SeedDetection {
    return { rect: rect(xPct), score };
}

function box(xPct = 0.2): TrackBox {
    return { x: xPct * FRAME.width, y: 200, w: 100, h: 25 };
}

function accepted(xPct = 0.2): Update {
    return { box: box(xPct), score: 0.8, rejected: false, lost: false, diagnostics: { reason: null } };
}

function rejected(reason: Update["diagnostics"]["reason"] = "low-score", xPct = 0.2): Update {
    return {
        box: box(xPct),
        score: reason === "low-score" ? 0.1 : 0.8,
        rejected: reason !== "low-score",
        lost: false,
        diagnostics: { reason },
    };
}

/** Script only the model boundary; association, evidence, reverse traversal,
 * cancellation, and emitted mask resolution all run their production code. */
class ScriptedTracker implements PropagationTracker {
    readonly initialized: TrackBox[] = [];
    readonly anchors: Array<{ box: TrackBox; requireConfirmation: boolean }> = [];
    readonly steps: number[] = [];
    readonly initializedFrames: Array<Parameters<PropagationTracker["init"]>[0]> = [];
    readonly anchorFrames: Array<Parameters<PropagationTracker["reanchor"]>[0]> = [];
    readonly updateFrames: Array<Parameters<PropagationTracker["update"]>[0]> = [];
    current = box();
    confirmsAppearance = false;
    acceptsAnchor = true;
    onUpdate: (() => void) | undefined;

    constructor(private readonly updates: Update[] = []) {}

    init(frame: Parameters<PropagationTracker["init"]>[0], _width: number, _height: number, initial: TrackBox): void {
        this.current = { ...initial };
        this.initialized.push({ ...initial });
        this.initializedFrames.push(frame);
    }

    async update(
        frame: Parameters<PropagationTracker["update"]>[0],
        _width: number,
        _height: number,
        dtSec: number,
    ): Promise<Update> {
        this.steps.push(dtSec);
        this.updateFrames.push(frame);
        this.onUpdate?.();
        const result = this.updates.shift() ?? { ...accepted(), box: { ...this.current } };
        if (!result.rejected && result.score >= 0.2 && !result.lost) this.current = { ...result.box };
        return result;
    }

    reanchor(
        frame: Parameters<PropagationTracker["reanchor"]>[0],
        _width: number,
        _height: number,
        proposed: TrackBox,
        requireConfirmation = false,
    ): boolean {
        this.anchors.push({ box: { ...proposed }, requireConfirmation });
        this.anchorFrames.push(frame);
        if (!this.acceptsAnchor || (requireConfirmation && !this.confirmsAppearance)) return false;
        this.current = { ...proposed };
        return true;
    }
}

class ScriptedSession implements PropagationTrackerSession {
    readonly started: ScriptedTracker[] = [];

    constructor(private readonly tracks: ScriptedTracker[]) {}

    newTrack(): ScriptedTracker {
        const track = this.tracks.shift();
        if (!track) throw new Error("unexpected tracker initialization");
        this.started.push(track);
        return track;
    }
}

function setup(tracks: ScriptedTracker[], count = 12, timings?: SourceFrameTiming[], margin = 0) {
    const session = new ScriptedSession(tracks);
    const controller = new AbortController();
    const stats: DetectPassStats = { scans: 0, tiles: 0, inferMs: 0, trackUpdates: 0, backwardUpdates: 0, trackMs: 0 };
    const frames =
        timings ??
        Array.from({ length: count }, (_, index) => ({ contentSec: index * FRAME_SEC, durationSec: FRAME_SEC }));
    const propagation = new DetectionPropagation(session, {
        margin,
        seedScoreMin: 0.25,
        strongScore: 0.45,
        frames,
        bounds: { startSec: 0, endSec: frames[frames.length - 1]!.contentSec + frames[frames.length - 1]!.durationSec },
        stats,
        signal: controller.signal,
    });
    return { propagation, session, controller, stats };
}

function masksAt(tracks: DetectedTrack[], sec: number): CropRect[] {
    return tracks.flatMap((track, index) => {
        const region: BlurRegion = {
            ...track,
            id: `plate-${index}`,
            channel: "front",
            style: "fill",
            autoEnd: false,
            lastTrackLost: false,
            interpolation: "hold",
            keyframes: track.keyframes.map((keyframe) => ({ ...keyframe, pinned: false })),
        };
        const mask = regionRectAt(region, sec);
        return mask ? [mask] : [];
    });
}

describe("DetectionPropagation", () => {
    it("calibrates a sparse forward seed and schedules source frames for measured fast motion in both directions", async () => {
        const frames = Array.from({ length: 7 }, (_, index) => ({ contentSec: index / 30, durationSec: 1 / 30 }));
        const forward = new ScriptedTracker([accepted(0.24), accepted(0.28), accepted(0.32), accepted(0.36)]);
        const reverse = new ScriptedTracker([accepted(0.16), accepted(0.12)]);
        const { propagation, stats } = setup([forward, reverse], frames.length, frames);
        propagation.beginForwardWindow(0);
        await propagation.forward(FRAME, 2, [seed()]);
        for (let index = 3; index < frames.length; index++) await propagation.forward(FRAME, index, undefined);
        expect(forward.steps).toHaveLength(4);
        const jobs = propagation.backwardJobs();
        expect(jobs[0]!.hasHighMotion).toBe(true);
        const planned = new Set(planReverseFrameIndices(frames, jobs));
        propagation.startBackward(FRAME, 2);
        for (let index = 1; index >= 0; index--) {
            await propagation.backward(
                () => {
                    if (!planned.has(index)) throw new Error("unplanned high-motion source frame");
                    return FRAME;
                },
                index,
                undefined,
                2,
            );
        }
        expect(reverse.steps).toHaveLength(2);
        expect(stats.calibrationUpdates).toBe(1);
        expect(stats.highMotionUpdates).toBe(2);
    });

    it("lets reliable detector anchors replace extra inference for fast motion", async () => {
        const frames = Array.from({ length: 7 }, (_, index) => ({ contentSec: index / 30, durationSec: 1 / 30 }));
        const tracker = new ScriptedTracker([accepted(0.28), accepted(0.36), accepted(0.44)]);
        const { propagation, stats } = setup([tracker], frames.length, frames);
        for (let index = 0; index < frames.length; index++) {
            await propagation.forward(FRAME, index, [seed(0.2 + index * 0.04)]);
        }
        expect(tracker.steps).toHaveLength(3);
        for (const dt of tracker.steps) expect(dt).toBeCloseTo(1 / 15);
        expect(stats.highMotionUpdates ?? 0).toBe(0);
        expect(stats.calibrationUpdates ?? 0).toBe(0);
        expect(propagation.finish()[0]!.detHits).toBe(frames.length);
    });

    it.each([false, true])(
        "runs the skipped reverse prediction when its promised anchor rejects (accepted=%s)",
        async (isAccepted) => {
            const frames = Array.from({ length: 5 }, (_, index) => ({ contentSec: index / 30, durationSec: 1 / 30 }));
            const reverse = new ScriptedTracker([isAccepted ? accepted(0.16) : rejected("appearance")]);
            reverse.acceptsAnchor = false;
            const { propagation, stats } = setup([new ScriptedTracker(), reverse], frames.length, frames);
            propagation.beginForwardWindow(0);
            await propagation.forward(FRAME, 2, [seed()]);
            await propagation.forward(FRAME, 3, [seed(0.24)]);
            expect(propagation.backwardJobs()[0]!.hasHighMotion).toBe(true);
            propagation.startBackward(FRAME, 2);
            await propagation.backward(FRAME, 1, [seed()], 2);
            expect(reverse.anchors).toHaveLength(1);
            expect(reverse.steps).toHaveLength(1);
            expect(reverse.steps[0]).toBeCloseTo(1 / 30);
            expect(stats.backwardUpdates).toBe(1);
            expect(propagation.hasBackwardWork(2)).toBe(isAccepted);
            const masks = masksAt(propagation.finish(), 1.5 / 30);
            expect(masks).toHaveLength(isAccepted ? 1 : 0);
            if (isAccepted) expect(masks[0]!.xPct).toBeCloseTo(0.16);
        },
    );

    it("verifies an unmatched forward branch when another prediction contests its preliminary anchor", async () => {
        const frames = Array.from({ length: 4 }, (_, index) => ({ contentSec: index / 30, durationSec: 1 / 30 }));
        const deferred = new ScriptedTracker([rejected("appearance")]);
        const competitor = new ScriptedTracker([accepted()]);
        const { propagation } = setup([deferred, competitor, new ScriptedTracker()], frames.length, frames);
        await propagation.forward(FRAME, 0, [seed(), seed(0.35)]);
        await propagation.forward(FRAME, 1, [seed()]);
        expect(deferred.anchors).toHaveLength(0);
        expect(deferred.steps).toHaveLength(1);
        expect(competitor.steps).toHaveLength(1);
        const deferredTrack = propagation.finish().find((track) => track.keyframes[0]!.rect.xPct === 0.2)!;
        expect(deferredTrack.endSec).toBeCloseTo(1 / 30);
    });

    it("verifies an unmatched reverse branch when another prediction contests its preliminary anchor", async () => {
        const frames = Array.from({ length: 5 }, (_, index) => ({ contentSec: index / 30, durationSec: 1 / 30 }));
        const deferred = new ScriptedTracker([rejected("appearance")]);
        const competitor = new ScriptedTracker([accepted()]);
        const { propagation, stats } = setup(
            [new ScriptedTracker(), new ScriptedTracker(), deferred, competitor],
            frames.length,
            frames,
        );
        propagation.beginForwardWindow(0);
        await propagation.forward(FRAME, 2, [seed(), seed(0.35)]);
        await propagation.forward(FRAME, 3, [seed(0.24), seed(0.39)]);
        propagation.startBackward(FRAME, 2);
        await propagation.backward(FRAME, 1, [seed()], 2);
        expect(deferred.anchors).toHaveLength(0);
        expect(deferred.steps).toHaveLength(1);
        expect(competitor.steps).toHaveLength(1);
        expect(stats.backwardUpdates).toBe(2);
        expect(masksAt(propagation.finish(), 1.5 / 30)).toHaveLength(1);
    });

    it("keeps a rejected reverse anchor as a hard boundary when deferred inference reports a bridgeable loss", async () => {
        const frames = Array.from({ length: 7 }, (_, index) => ({ contentSec: index / 30, durationSec: 1 / 30 }));
        const reverse = new ScriptedTracker([rejected("low-score")]);
        reverse.acceptsAnchor = false;
        const { propagation } = setup(
            [new ScriptedTracker([accepted(), rejected()]), new ScriptedTracker([accepted(0.28)]), reverse],
            frames.length,
            frames,
        );
        await propagation.forward(FRAME, 0, [seed()]);
        for (let index = 1; index <= 3; index++) await propagation.forward(FRAME, index, undefined);
        await propagation.forward(FRAME, 4, [seed()]);
        await propagation.forward(FRAME, 5, [seed(0.24)]);
        await propagation.forward(FRAME, 6, undefined);
        propagation.startBackward(FRAME, 4);
        await propagation.backward(FRAME, 3, [seed()], 4);
        expect(reverse.steps).toHaveLength(1);
        const tracks = propagation.finish();
        expect(masksAt(tracks, 2.5 / 30)).toHaveLength(0);
        expect(masksAt(tracks, 3.5 / 30)).toHaveLength(0);
    });

    it.each([false, true])(
        "keeps duplicated slow-motion source positions at 15 Hz (detector anchors=%s)",
        async (hasAnchors) => {
            const frames = Array.from({ length: 13 }, (_, index) => ({ contentSec: index / 30, durationSec: 1 / 30 }));
            const tracker = new ScriptedTracker([
                ...(hasAnchors ? [] : [accepted()]),
                ...Array.from({ length: 5 }, (_, index) => accepted(0.2 + (index + 1) * 0.03)),
            ]);
            const { propagation, stats } = setup([tracker], frames.length, frames);
            propagation.beginForwardWindow(0);
            await propagation.forward(FRAME, 2, [seed()]);
            for (let index = 3; index < frames.length; index++) {
                await propagation.forward(
                    FRAME,
                    index,
                    hasAnchors ? [seed(0.2 + Math.floor((index - 2) / 2) * 0.03)] : undefined,
                );
            }
            expect(tracker.steps).toHaveLength(hasAnchors ? 5 : 6);
            expect(stats.highMotionUpdates ?? 0).toBe(0);
            expect(propagation.backwardJobs()[0]!.hasHighMotion).toBe(false);
        },
    );

    it("retains a one-pixel output margin on tiny boxes without inflating raw tracker geometry", async () => {
        const tracker = new ScriptedTracker();
        const { propagation } = setup([tracker], 1, undefined, 0.12);
        const tiny = { score: 0.8, rect: { xPct: 0.2, yPct: 0.4, wPct: 0.01, hPct: 0.008 } };
        await propagation.forward(FRAME, 0, [tiny]);
        expect(tracker.initialized).toEqual([{ x: 200, y: 200, w: 10, h: 4 }]);
        const mask = masksAt(propagation.finish(), FRAME_SEC / 2)[0]!;
        expect(mask.xPct * FRAME.width).toBeCloseTo(199);
        expect(mask.yPct * FRAME.height).toBeCloseTo(199);
        expect(mask.wPct * FRAME.width).toBeCloseTo(12);
        expect(mask.hPct * FRAME.height).toBeCloseTo(6);
    });

    it.each([30, 60])(
        "limits forward inference to 15 Hz at %s fps while consuming every detector anchor",
        async (fps) => {
            const tracker = new ScriptedTracker();
            const count = fps + 1;
            const frames = Array.from({ length: count }, (_, index) => ({
                contentSec: index / fps,
                durationSec: 1 / fps,
            }));
            const { propagation, stats } = setup([tracker], count, frames);
            for (let index = 0; index < count; index++) await propagation.forward(FRAME, index, [seed(0.2, 0.3)]);
            const tracks = propagation.finish();
            expect(tracker.steps).toHaveLength(15);
            for (const dt of tracker.steps) expect(dt).toBeCloseTo(1 / 15);
            expect(tracker.anchors).toHaveLength(fps);
            expect(tracks[0]!.detHits).toBe(count);
            expect(stats.trackUpdates).toBe(15);
            expect(stats.unconfirmedTracks).toBe(0);
            for (let index = 0; index < count; index++) expect(masksAt(tracks, (index + 0.5) / fps)).toHaveLength(1);
        },
    );

    it.each([30, 60])(
        "limits backward inference to 15 Hz at %s fps without postponing it after anchors",
        async (fps) => {
            const reverse = new ScriptedTracker();
            const count = fps + 1;
            const frames = Array.from({ length: count }, (_, index) => ({
                contentSec: index / fps,
                durationSec: 1 / fps,
            }));
            const { propagation, stats } = setup([new ScriptedTracker(), reverse], count, frames);
            propagation.beginForwardWindow(0);
            await propagation.forward(FRAME, fps, [seed()]);
            propagation.startBackward(FRAME, fps);
            for (let index = fps - 1; index >= 0; index--) await propagation.backward(FRAME, index, [seed()], fps);
            const tracks = propagation.finish();
            expect(reverse.steps).toHaveLength(15);
            for (const dt of reverse.steps) expect(dt).toBeCloseTo(1 / 15);
            expect(reverse.anchors).toHaveLength(fps);
            expect(stats.backwardUpdates).toBe(15);
            expect(tracks[0]!.detHits).toBe(1);
            for (let index = 0; index < count; index++) expect(masksAt(tracks, (index + 0.5) / fps)).toHaveLength(1);
        },
    );

    it.each([30, 60])(
        "uses only planned reverse pixels across seed phases and branch endpoints at %s fps",
        async (fps) => {
            const count = 14;
            const frames = Array.from({ length: count }, (_, index) => ({
                contentSec: index / fps,
                durationSec: 1 / fps,
            }));
            const groups = [
                { seedIndex: 9, startIndex: 1, xPct: 0.2 },
                { seedIndex: 12, startIndex: 3, xPct: 0.7 },
            ].map((group) => ({
                ...group,
                ...setup([new ScriptedTracker(), new ScriptedTracker()], count, frames),
            }));
            for (const group of groups) {
                group.propagation.beginForwardWindow(group.startIndex);
                await group.propagation.forward(FRAME, group.seedIndex, [seed(group.xPct)]);
                group.propagation.endForwardWindow();
            }
            const planned = new Set(planReverseFrameIndices(frames, groups, [7]));
            for (let index = 12; index >= 1; index--) {
                const source = () => {
                    if (!planned.has(index)) throw new Error(`unplanned reverse frame ${index}`);
                    return FRAME;
                };
                for (const group of groups) {
                    if (index === group.seedIndex) group.propagation.startBackward(source, index);
                    else if (group.propagation.hasBackwardWork(group.seedIndex)) {
                        await group.propagation.backward(
                            source,
                            index,
                            index === 7 ? [seed(group.xPct)] : undefined,
                            group.seedIndex,
                        );
                    }
                }
            }
            for (const group of groups) {
                expect(group.propagation.hasBackwardWork()).toBe(false);
                const track = group.propagation.finish()[0]!;
                expect(track.startSec).toBeCloseTo(group.startIndex / fps);
                expect(track.endSec).toBeCloseTo((group.seedIndex + 1) / fps);
                expect(track.detHits).toBe(1);
            }
        },
    );

    it.each([false, true])(
        "interpolates skipped frames between trusted positions without reading pixels (backward=%s)",
        async (backward) => {
            const count = backward ? 3 : 5;
            const timings = Array.from({ length: count }, (_, index) => ({
                contentSec: index / 30,
                durationSec: 1 / 30,
            }));
            const tracker = new ScriptedTracker(backward ? [accepted(0.2)] : [accepted(0.22), accepted(0.24)]);
            const { propagation } = setup(backward ? [new ScriptedTracker(), tracker] : [tracker], count, timings);
            const noPixels = () => {
                throw new Error("skipped source frame must not request pixels");
            };
            if (backward) {
                propagation.beginForwardWindow(0);
                await propagation.forward(FRAME, 2, [seed(0.24)]);
                propagation.startBackward(FRAME, 2);
                await propagation.backward(noPixels, 1, undefined, 2);
                await propagation.backward(FRAME, 0, undefined, 2);
            } else {
                await propagation.forward(FRAME, 0, [seed()]);
                await propagation.forward(FRAME, 1, [seed()]);
                await propagation.forward(FRAME, 2, undefined);
                await propagation.forward(noPixels, 3, undefined);
                await propagation.forward(FRAME, 4, undefined);
            }
            const tracks = propagation.finish();
            expect(tracker.steps).toHaveLength(backward ? 1 : 2);
            expect(tracker.steps[0]).toBeCloseTo(1 / 15);
            expect(masksAt(tracks, 0.5 / 30)[0]!.xPct).toBeCloseTo(0.2);
            expect(masksAt(tracks, (backward ? 1.5 : 3.5) / 30)[0]!.xPct).toBeCloseTo(backward ? 0.22 : 0.23);
            expect(masksAt(tracks, (backward ? 1.5 : 3.5) / 30)[0]!.wPct).toBeCloseTo(0.1);
            expect(masksAt(tracks, (backward ? 2.5 : 4.5) / 30)[0]!.xPct).toBeCloseTo(0.24);
        },
    );

    it.each([false, true])("verifies an off-grid source endpoint (backward=%s)", async (backward) => {
        const timings = Array.from({ length: 2 }, (_, index) => ({ contentSec: index / 60, durationSec: 1 / 60 }));
        const tracker = new ScriptedTracker();
        const { propagation } = setup(backward ? [new ScriptedTracker(), tracker] : [tracker], 2, timings);
        if (backward) {
            propagation.beginForwardWindow(0);
            await propagation.forward(FRAME, 1, [seed()]);
            propagation.startBackward(FRAME, 1);
            await propagation.backward(FRAME, 0, undefined, 1);
        } else {
            await propagation.forward(FRAME, 0, [seed()]);
            await propagation.forward(FRAME, 1, undefined);
        }
        expect(tracker.steps).toHaveLength(1);
        expect(tracker.steps[0]).toBeCloseTo(1 / 60);
        expect(propagation.finish()[0]!.endSec).toBeCloseTo(2 / 60);
    });

    it("verifies an intermediate long-held VFR frame before projecting coverage through its duration", async () => {
        const tracker = new ScriptedTracker([rejected("appearance")]);
        const { propagation } = setup([tracker], 3, [
            { contentSec: 0, durationSec: 0.01 },
            { contentSec: 0.01, durationSec: 2 },
            { contentSec: 2.01, durationSec: 0.04 },
        ]);
        await propagation.forward(FRAME, 0, [seed()]);
        await propagation.forward(FRAME, 1, undefined);
        await propagation.forward(FRAME, 2, undefined);
        expect(tracker.steps).toHaveLength(1);
        expect(tracker.steps[0]).toBeCloseTo(0.01);
        const tracks = propagation.finish();
        expect(tracks[0]!.endSec).toBeCloseTo(0.01);
        expect(masksAt(tracks, 1)).toHaveLength(0);
    });

    it.each([false, true])(
        "ends sampled coverage at a rejected update without covering the loss frame (backward=%s)",
        async (backward) => {
            const timings = Array.from({ length: 4 }, (_, index) => ({ contentSec: index / 30, durationSec: 1 / 30 }));
            const tracker = new ScriptedTracker([rejected("appearance")]);
            const { propagation } = setup(backward ? [new ScriptedTracker(), tracker] : [tracker], 4, timings);
            if (backward) {
                propagation.beginForwardWindow(0);
                await propagation.forward(FRAME, 3, [seed()]);
                propagation.startBackward(FRAME, 3);
                for (let index = 2; index >= 0; index--) await propagation.backward(FRAME, index, undefined, 3);
            } else {
                await propagation.forward(FRAME, 0, [seed()]);
                for (let index = 1; index < 4; index++)
                    await propagation.forward(FRAME, index, index === 1 ? [seed()] : undefined);
            }
            const tracks = propagation.finish();
            expect(tracker.steps).toHaveLength(1);
            expect(masksAt(tracks, (backward ? 2.5 : 1.5) / 30)).toHaveLength(1);
            expect(masksAt(tracks, (backward ? 1.5 : 2.5) / 30)).toHaveLength(0);
        },
    );

    it.each([false, true])(
        "covers short terminal travel before rejection using measured motion (backward=%s)",
        async (backward) => {
            const timings = Array.from({ length: 6 }, (_, index) => ({ contentSec: index / 30, durationSec: 1 / 30 }));
            const tracker = new ScriptedTracker([accepted(backward ? 0.2 : 0.24), rejected("appearance")]);
            const { propagation } = setup(backward ? [new ScriptedTracker(), tracker] : [tracker], 6, timings);
            if (backward) {
                propagation.beginForwardWindow(0);
                await propagation.forward(FRAME, 5, [seed(0.24)]);
                propagation.startBackward(FRAME, 5);
                for (let index = 4; index >= 0; index--) await propagation.backward(FRAME, index, undefined, 5);
            } else {
                await propagation.forward(FRAME, 0, [seed()]);
                for (let index = 1; index < 6; index++)
                    await propagation.forward(FRAME, index, index === 1 ? [seed(0.22)] : undefined);
            }
            const tracks = propagation.finish();
            const pending = masksAt(tracks, (backward ? 2.5 : 3.5) / 30)[0]!;
            expect(pending.xPct).toBeCloseTo(backward ? 0.18 : 0.24);
            expect(pending.wPct).toBeCloseTo(0.12);
            expect(masksAt(tracks, (backward ? 1.5 : 4.5) / 30)).toHaveLength(0);
        },
    );

    it.each([false, true])(
        "does not amplify close-timestamp detector jitter into terminal coverage (backward=%s)",
        async (isBackward) => {
            const ordered = [0, 1 / 30, 2 / 30, 2 / 30 + 0.00001, 3 / 30, 4 / 30];
            const timestamps = isBackward ? ordered.map((sec) => 4 / 30 - sec).reverse() : ordered;
            const timings = timestamps.map((contentSec, index) => ({
                contentSec,
                durationSec: (timestamps[index + 1] ?? contentSec + 1 / 30) - contentSec,
            }));
            const tracker = new ScriptedTracker([accepted(), rejected("appearance")]);
            const { propagation } = setup(isBackward ? [new ScriptedTracker(), tracker] : [tracker], 6, timings);
            const jittered: SeedDetection = {
                rect: { ...rect(), xPct: 0.2001, yPct: 0.4001 },
                score: 0.8,
            };
            const noPixels = () => {
                throw new Error("terminal source frame must retain its sampled cadence");
            };
            if (isBackward) {
                propagation.beginForwardWindow(0);
                await propagation.forward(FRAME, 5, [seed()]);
                propagation.startBackward(FRAME, 5);
            } else {
                await propagation.forward(FRAME, 0, [seed()]);
            }
            for (let step = 1; step < 6; step++) {
                const index = isBackward ? 5 - step : step;
                const detections = step < 3 ? [seed()] : step === 3 ? [jittered] : undefined;
                const source = step === 4 ? noPixels : FRAME;
                if (isBackward) await propagation.backward(source, index, detections, 5);
                else await propagation.forward(source, index, detections);
            }
            const tracks = propagation.finish();
            const index = isBackward ? 1 : 4;
            const pending = masksAt(tracks, timings[index]!.contentSec + timings[index]!.durationSec / 2)[0]!;
            expect(tracker.steps).toHaveLength(2);
            expect(pending.wPct).toBeLessThan(0.101);
            expect(pending.hPct).toBeLessThan(0.051);
            expect(masksAt(tracks, isBackward ? timings[0]!.durationSec / 2 : 4.5 / 30)).toHaveLength(0);
        },
    );

    it("bounds reverse terminal motion before a full observation interval exists", async () => {
        const timestamps = [0, 1 / 30, 2 / 30 - 0.00001, 2 / 30];
        const timings = timestamps.map((contentSec, index) => ({
            contentSec,
            durationSec: (timestamps[index + 1] ?? contentSec + 1 / 30) - contentSec,
        }));
        const reverse = new ScriptedTracker([rejected("appearance")]);
        const { propagation } = setup([new ScriptedTracker(), reverse], 4, timings);
        propagation.beginForwardWindow(0);
        await propagation.forward(FRAME, 3, [seed()]);
        propagation.startBackward(FRAME, 3);
        await propagation.backward(FRAME, 2, [seed(0.2001)], 3);
        await propagation.backward(FRAME, 1, undefined, 3);
        await propagation.backward(FRAME, 0, undefined, 3);
        const pending = masksAt(propagation.finish(), 1.5 / 30)[0]!;
        expect(reverse.steps).toHaveLength(1);
        expect(pending.xPct).toBeCloseTo(0.2001);
        expect(pending.wPct).toBeLessThan(0.101);
    });

    it("applies the tracker speed ceiling to unobserved travel after detector anchors", async () => {
        const timings = Array.from({ length: 6 }, (_, index) => ({ contentSec: index / 30, durationSec: 1 / 30 }));
        const detection = (xPct: number): SeedDetection => ({
            rect: { xPct, yPct: 0.2, wPct: 0.4, hPct: 0.2 },
            score: 0.8,
        });
        const reverse = new ScriptedTracker([
            { ...accepted(), box: { x: 200, y: 100, w: 400, h: 100 } },
            rejected("appearance"),
        ]);
        const { propagation } = setup([new ScriptedTracker(), reverse], 6, timings);
        propagation.beginForwardWindow(0);
        await propagation.forward(FRAME, 5, [detection(0)]);
        propagation.startBackward(FRAME, 5);
        await propagation.backward(FRAME, 4, [detection(0.2)], 5);
        await propagation.backward(FRAME, 3, [detection(0.4)], 5);
        await propagation.backward(FRAME, 2, undefined, 5);
        await propagation.backward(FRAME, 1, undefined, 5);
        const pending = masksAt(propagation.finish(), 2.5 / 30)[0]!;
        expect(reverse.steps).toHaveLength(2);
        expect(pending.xPct).toBeCloseTo(0.4);
        expect(pending.wPct).toBeCloseTo(0.5);
        expect(pending.hPct).toBeCloseTo(0.2);
    });

    it("stabilizes a recovery seed on two source frames without shifting its inference grid or duplicating its predecessor", async () => {
        const timings = Array.from({ length: 9 }, (_, index) => ({ contentSec: index / 25, durationSec: 1 / 25 }));
        const original = new ScriptedTracker([accepted(), rejected()]);
        const recovered = new ScriptedTracker([accepted(0.3), accepted(0.32), rejected()]);
        const reverse = new ScriptedTracker([accepted(), accepted(), accepted()]);
        const { propagation } = setup([original, recovered, reverse], 9, timings);
        await propagation.forward(FRAME, 0, [seed()]);
        for (let index = 1; index < 9; index++) {
            await propagation.forward(FRAME, index, index === 1 ? [seed()] : undefined, async () =>
                index === 4 ? [seed(0.28)] : [],
            );
        }
        expect(recovered.steps).toHaveLength(3);
        expect(recovered.steps[0]).toBeCloseTo(1 / 25);
        expect(recovered.steps[1]).toBeCloseTo(1 / 25);
        expect(recovered.steps[2]).toBeCloseTo(2 / 25);
        const jobs = propagation.backwardJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.recoveryWarmupFrames).toBe(2);
        const planned = new Set(planReverseFrameIndices(timings, jobs));
        propagation.startBackward(FRAME, 4);
        for (let index = 3; index >= 0; index--) {
            await propagation.backward(
                () => {
                    if (!planned.has(index)) throw new Error("unplanned recovery warmup frame");
                    return FRAME;
                },
                index,
                undefined,
                4,
            );
        }
        expect(reverse.steps).toHaveLength(3);
        const tracks = propagation.finish();
        for (let index = 0; index <= 7; index++) expect(masksAt(tracks, (index + 0.5) / 25)).toHaveLength(1);
        expect(masksAt(tracks, 8.5 / 25)).toHaveLength(0);
    });

    it("pixel-aligns tracker seeds and anchors while retaining raw detector evidence", async () => {
        const forward = new ScriptedTracker();
        const reverse = new ScriptedTracker();
        const { propagation } = setup([forward, reverse]);
        const detection = {
            score: 0.8,
            rect: { xPct: 0.2006, yPct: 0.4008, wPct: 0.1008, hPct: 0.0506 },
        };
        const pixelBox = { x: 201, y: 200, w: 101, h: 25 };
        propagation.beginForwardWindow(0);
        await propagation.forward(FRAME, 1, [detection]);
        await propagation.forward(FRAME, 2, [detection]);
        propagation.startBackward(FRAME, 1);
        await propagation.backward(FRAME, 0, [detection], 1);
        expect(forward.initialized).toEqual([pixelBox]);
        expect(reverse.initialized).toEqual([pixelBox]);
        expect(forward.anchors).toEqual([{ box: pixelBox, requireConfirmation: false }]);
        expect(reverse.anchors).toEqual([{ box: pixelBox, requireConfirmation: false }]);
        const tracks = propagation.finish();
        expect(tracks).toHaveLength(1);
        for (let index = 0; index < 3; index++) {
            const mask = masksAt(tracks, (index + 0.5) * FRAME_SEC)[0]!;
            for (const coordinate of ["xPct", "yPct", "wPct", "hPct"] as const) {
                expect(mask[coordinate]).toBeCloseTo(detection.rect[coordinate]);
            }
        }
    });

    it("reuses the display frame created during recovery for reanchoring and new seeds", async () => {
        const tracker = new ScriptedTracker([rejected()]);
        const newcomer = new ScriptedTracker();
        const { propagation } = setup([tracker, newcomer]);
        let frame = FRAME;
        const display = { ...FRAME };
        await propagation.forward(() => frame, 0, [seed()]);
        await propagation.forward(
            () => frame,
            1,
            undefined,
            async () => {
                frame = display;
                return [seed(), seed(0.7)];
            },
        );
        expect(tracker.updateFrames[0]).toBe(FRAME);
        expect(tracker.anchorFrames[0]).toBe(display);
        expect(newcomer.initializedFrames[0]).toBe(display);
        expect(propagation.finish()).toHaveLength(2);
    });

    it("does not promote a weak seed through tracker sustain alone", async () => {
        const { propagation, stats } = setup([new ScriptedTracker()], 60);
        await propagation.forward(FRAME, 0, [seed(0.2, 0.3)]);
        for (let index = 1; index < 60; index++) await propagation.forward(FRAME, index, undefined);
        expect(propagation.backwardJobs()).toEqual([]);
        expect(propagation.finish()).toEqual([]);
        expect(stats.seededTracks).toBe(1);
        expect(stats.unconfirmedTracks).toBe(1);
        propagation.finish();
        expect(stats.unconfirmedTracks).toBe(1);
    });

    it("confirms with two independent eligible detections without counting weak maintenance", async () => {
        const tracker = new ScriptedTracker();
        const { propagation, stats } = setup([tracker]);
        await propagation.forward(FRAME, 0, [seed(0.2, 0.3)]);
        await propagation.forward(FRAME, 1, [seed(0.2, 0.2)]);
        await propagation.forward(FRAME, 2, [seed(0.2, 0.35)]);
        const tracks = propagation.finish();
        expect(tracks).toHaveLength(1);
        expect(tracks[0]!.detHits).toBe(2);
        expect(tracks[0]!.bestScore).toBe(0.35);
        expect(tracker.anchors).toHaveLength(1);
        expect(stats.seededTracks).toBe(1);
        expect(stats.unconfirmedTracks).toBe(0);
    });

    it("combines forward and backward observations without adding reverse confirmation hits", async () => {
        const forward = new ScriptedTracker([accepted(0.23), accepted(0.24)]);
        const reverse = new ScriptedTracker([accepted(0.21), accepted(0.2)]);
        const { propagation, stats } = setup([forward, reverse]);
        propagation.beginForwardWindow(0);
        await propagation.forward(FRAME, 2, [seed(0.22)]);
        await propagation.forward(FRAME, 3, undefined);
        await propagation.forward(FRAME, 4, undefined);
        expect(propagation.backwardJobs()).toMatchObject([{ seedIndex: 2, startIndex: 0 }]);
        propagation.startBackward(FRAME, 2);
        await propagation.backward(FRAME, 1, [seed(0.21)], 2);
        await propagation.backward(FRAME, 0, undefined, 2);
        expect(propagation.hasBackwardWork()).toBe(false);
        const tracks = propagation.finish();
        expect(tracks).toHaveLength(1);
        expect(tracks[0]!.detHits).toBe(1);
        for (let index = 0; index < 5; index++) {
            expect(masksAt(tracks, (index + 0.5) * FRAME_SEC)[0]!.xPct).toBeCloseTo(0.2 + index * 0.01);
        }
        expect(stats.trackUpdates).toBe(4);
        expect(stats.backwardUpdates).toBe(2);
        expect(stats.seededTracks).toBe(1);
        expect(stats.unconfirmedTracks).toBe(0);
        for (const dt of [...forward.steps, ...reverse.steps]) expect(dt).toBeCloseTo(FRAME_SEC);
    });

    it.each([false, true])("requires appearance confirmation for a weak same-frame repair (%s)", async (confirms) => {
        const tracker = new ScriptedTracker([accepted(0.21), rejected("low-score", 0.21)]);
        tracker.confirmsAppearance = confirms;
        const { propagation } = setup([tracker]);
        await propagation.forward(FRAME, 0, [seed()]);
        await propagation.forward(FRAME, 1, [seed(0.22, 0.2)]);
        expect(tracker.anchors).toEqual([]);
        await propagation.forward(FRAME, 2, [seed(0.22, 0.2)]);
        expect(tracker.anchors).toEqual([{ box: box(0.22), requireConfirmation: true }]);
        const tracks = propagation.finish();
        expect(tracks[0]!.detHits).toBe(1);
        expect(masksAt(tracks, 1.5 * FRAME_SEC)[0]!.xPct).toBeCloseTo(0.21);
        expect(masksAt(tracks, 2.5 * FRAME_SEC)).toHaveLength(confirms ? 1 : 0);
    });

    it("keeps reverse weak repairs subject to the same appearance gate", async () => {
        const reverse = new ScriptedTracker([rejected()]);
        const { propagation } = setup([new ScriptedTracker(), reverse]);
        propagation.beginForwardWindow(0);
        await propagation.forward(FRAME, 2, [seed()]);
        propagation.startBackward(FRAME, 2);
        await propagation.backward(FRAME, 1, [seed(0.21, 0.2)], 2);
        expect(reverse.anchors[0]!.requireConfirmation).toBe(true);
        expect(propagation.hasBackwardWork()).toBe(false);
        expect(masksAt(propagation.finish(), 1.5 * FRAME_SEC)).toEqual([]);
    });

    it.each([0.2, 0.3])("does not bridge a rejected reverse detector anchor with score %s", async (score) => {
        const reverse = new ScriptedTracker([rejected("low-score", 0.23)]);
        // An eligible weak face can fail the size cap. A sub-floor observation
        // instead needs appearance confirmation, which this tracker denies.
        reverse.acceptsAnchor = score < 0.25;
        const { propagation } = setup([
            new ScriptedTracker([accepted(0.21), rejected("low-score", 0.21)]),
            ...(score >= 0.25 ? [new ScriptedTracker([accepted(0.31)])] : []),
            new ScriptedTracker(),
            reverse,
        ]);
        await propagation.forward(FRAME, 0, [seed()]);
        await propagation.forward(FRAME, 1, undefined);
        await propagation.forward(FRAME, 2, []);
        await propagation.forward(FRAME, 3, [seed(0.22, score)]);
        await propagation.forward(FRAME, 4, [seed(0.23)]);
        propagation.startBackward(FRAME, 4);
        await propagation.backward(FRAME, 3, [seed(0.22, score)], 4);
        expect(reverse.anchors).toEqual([{ box: box(0.22), requireConfirmation: score < 0.25 }]);
        const tracks = propagation.finish();
        expect(tracks.map((track) => track.detHits)).toEqual([1, 1]);
        // The intermediate weak trajectory never confirmed, so an occupancy
        // veto cannot hide the reverse anchor's missing hard-boundary flag.
        expect(masksAt(tracks, 2.5 * FRAME_SEC)).toEqual([]);
        expect(masksAt(tracks, 3.5 * FRAME_SEC)).toEqual([]);
    });

    it("does not initialize a tracker from sub-floor observations", async () => {
        const { propagation, session } = setup([]);
        await propagation.forward(FRAME, 0, [seed(0.2, 0.2)]);
        await propagation.forward(FRAME, 1, [seed(0.2, 0.2)]);
        expect(session.started).toEqual([]);
        expect(propagation.finish()).toEqual([]);
    });

    it("replaces a rejected detector anchor without renewing the old track's size budget", async () => {
        const old = new ScriptedTracker([accepted(0.21)]);
        old.acceptsAnchor = false;
        const replacement = new ScriptedTracker();
        const { propagation } = setup([old, replacement]);
        await propagation.forward(FRAME, 0, [seed()]);
        await propagation.forward(FRAME, 1, [seed(0.21)]);
        expect(replacement.initialized).toEqual([box(0.21)]);
        expect(propagation.backwardJobs()).toEqual([]);
        const tracks = propagation.finish();
        expect(tracks).toHaveLength(2);
        expect(masksAt(tracks, 0.5 * FRAME_SEC)).toHaveLength(1);
        expect(masksAt(tracks, 1.5 * FRAME_SEC)).toHaveLength(1);
    });

    it("keeps a failed strong-anchor replacement as a hard boundary for later gap filling", async () => {
        const old = new ScriptedTracker([rejected()]);
        old.acceptsAnchor = false;
        const { propagation } = setup([
            old,
            new ScriptedTracker([rejected("appearance", 0.25)]),
            new ScriptedTracker(),
            new ScriptedTracker([rejected()]),
        ]);
        await propagation.forward(FRAME, 0, [seed()]);
        await propagation.forward(FRAME, 1, [seed(0.25)]);
        await propagation.forward(FRAME, 2, []);
        await propagation.forward(FRAME, 3, [seed()]);
        propagation.startBackward(FRAME, 3);
        await propagation.backward(FRAME, 2, undefined, 3);
        const tracks = propagation.finish();
        expect(masksAt(tracks, 1.5 * FRAME_SEC)[0]!.xPct).toBeCloseTo(0.25);
        expect(masksAt(tracks, 2.5 * FRAME_SEC)).toEqual([]);
    });

    it("keeps a failed weak forward anchor as a hard boundary for later gap filling", async () => {
        const first = new ScriptedTracker([accepted(0.21), rejected("low-score", 0.21)]);
        const { propagation } = setup([
            first,
            new ScriptedTracker(),
            new ScriptedTracker([rejected("low-score", 0.23)]),
        ]);
        await propagation.forward(FRAME, 0, [seed()]);
        await propagation.forward(FRAME, 1, undefined);
        await propagation.forward(FRAME, 2, [seed(0.22, 0.2)]);
        await propagation.forward(FRAME, 3, undefined);
        await propagation.forward(FRAME, 4, [seed(0.23)]);
        propagation.startBackward(FRAME, 4);
        await propagation.backward(FRAME, 3, undefined, 4);
        expect(first.anchors).toEqual([{ box: box(0.22), requireConfirmation: true }]);
        const tracks = propagation.finish();
        expect(masksAt(tracks, 2.5 * FRAME_SEC)).toEqual([]);
        expect(masksAt(tracks, 3.5 * FRAME_SEC)).toEqual([]);
    });

    it.each(["low-score", "texture-collapse"] as const)(
        "bridges a single %s frame only after both sides confirm",
        async (reason) => {
            const first = new ScriptedTracker([accepted(0.21), rejected(reason, 0.21)]);
            const second = new ScriptedTracker();
            const reverse = new ScriptedTracker([rejected(reason, 0.23)]);
            const { propagation } = setup([first, second, reverse]);
            await propagation.forward(FRAME, 0, [seed()]);
            await propagation.forward(FRAME, 1, undefined);
            await propagation.forward(FRAME, 2, undefined, async () => []);
            await propagation.forward(FRAME, 3, [seed(0.23)]);
            propagation.startBackward(FRAME, 3);
            await propagation.backward(FRAME, 2, undefined, 3);
            const tracks = propagation.finish();
            expect(tracks).toHaveLength(2);
            const gap = masksAt(tracks, 2.5 * FRAME_SEC);
            expect(gap).toHaveLength(1);
            expect(gap[0]!.xPct).toBeCloseTo(0.22);
            expect(tracks.map((track) => track.detHits)).toEqual([1, 1]);
            expect(masksAt(tracks, 4.5 * FRAME_SEC)).toEqual([]);
        },
    );

    it.each(["appearance", "geometry"] as const)("keeps a %s rejection as a hard boundary", async (reason) => {
        const { propagation } = setup([
            new ScriptedTracker([accepted(0.21), rejected(reason, 0.21)]),
            new ScriptedTracker(),
            new ScriptedTracker([rejected("low-score", 0.23)]),
        ]);
        await propagation.forward(FRAME, 0, [seed()]);
        await propagation.forward(FRAME, 1, undefined);
        await propagation.forward(FRAME, 2, []);
        await propagation.forward(FRAME, 3, [seed(0.23)]);
        propagation.startBackward(FRAME, 3);
        await propagation.backward(FRAME, 2, undefined, 3);
        expect(masksAt(propagation.finish(), 2.5 * FRAME_SEC)).toEqual([]);
    });

    it("never projects an unresolved final loss into later frames", async () => {
        const { propagation } = setup([new ScriptedTracker([accepted(), rejected()])]);
        await propagation.forward(FRAME, 0, [seed()]);
        await propagation.forward(FRAME, 1, undefined);
        await propagation.forward(FRAME, 2, undefined, async () => []);
        await propagation.forward(FRAME, 3, undefined);
        const tracks = propagation.finish();
        expect(tracks[0]!.endSec).toBeCloseTo(2 * FRAME_SEC);
        expect(masksAt(tracks, 2.5 * FRAME_SEC)).toEqual([]);
    });

    it("does not bridge a confirmed exit even when a later seed overlaps the old location", async () => {
        const { propagation } = setup([
            new ScriptedTracker([accepted(0.21), { ...rejected("low-score", 0.21), lost: true }]),
            new ScriptedTracker(),
            new ScriptedTracker([rejected("low-score", 0.23)]),
        ]);
        await propagation.forward(FRAME, 0, [seed()]);
        await propagation.forward(FRAME, 1, undefined);
        await propagation.forward(FRAME, 2, []);
        await propagation.forward(FRAME, 3, [seed(0.23)]);
        propagation.startBackward(FRAME, 3);
        await propagation.backward(FRAME, 2, undefined, 3);
        expect(masksAt(propagation.finish(), 2.5 * FRAME_SEC)).toEqual([]);
    });

    it("stops reverse work once a detector-backed duplicate prefix is fully covered", async () => {
        const at = (index: number) => accepted(0.2 + index * 0.002);
        const { propagation } = setup([
            new ScriptedTracker([at(3), at(4), rejected()]),
            new ScriptedTracker([at(8), at(9)]),
            new ScriptedTracker([at(6), at(5), at(4), at(3), at(2)]),
            new ScriptedTracker([at(1), at(0)]),
        ]);
        for (let index = 0; index <= 9; index++) {
            await propagation.forward(
                FRAME,
                index,
                index === 2 || index === 7 ? [seed(0.2 + index * 0.002)] : undefined,
            );
        }
        propagation.startBackward(FRAME, 7);
        for (let index = 6; index >= 2; index--) await propagation.backward(FRAME, index, undefined, 7);
        expect(propagation.hasBackwardWork(7)).toBe(false);
        propagation.startBackward(FRAME, 2);
        await propagation.backward(FRAME, 1, undefined, 2);
        await propagation.backward(FRAME, 0, undefined, 2);
        const tracks = propagation.finish();
        expect(tracks).toHaveLength(2);
        for (let index = 0; index <= 9; index++) expect(masksAt(tracks, (index + 0.5) * FRAME_SEC)).toHaveLength(1);
    });

    it("starts independent trajectories across an actual source-time gap", async () => {
        const { propagation } = setup([new ScriptedTracker(), new ScriptedTracker()], 2, [
            { contentSec: 0, durationSec: FRAME_SEC },
            { contentSec: 1, durationSec: FRAME_SEC },
        ]);
        await propagation.forward(FRAME, 0, [seed()]);
        await propagation.forward(FRAME, 1, [seed()]);
        expect(propagation.backwardJobs()).toEqual([]);
        const tracks = propagation.finish();
        expect(tracks).toHaveLength(2);
        expect(masksAt(tracks, 0.5)).toEqual([]);
    });

    it("propagates cancellation before initialization and after an in-flight prediction", async () => {
        const cold = setup([]);
        cold.controller.abort();
        await expect(cold.propagation.forward(FRAME, 0, [seed()])).rejects.toMatchObject({ name: "AbortError" });
        expect(cold.session.started).toEqual([]);

        const tracker = new ScriptedTracker([accepted(0.21)]);
        const active = setup([tracker]);
        await active.propagation.forward(FRAME, 0, [seed()]);
        tracker.onUpdate = () => active.controller.abort();
        await expect(active.propagation.forward(FRAME, 1, undefined)).rejects.toMatchObject({ name: "AbortError" });
        expect(active.propagation.finish()[0]!.endSec).toBeCloseTo(FRAME_SEC);
    });

    it("does not apply a recovery result after cancellation", async () => {
        const tracker = new ScriptedTracker([rejected()]);
        const { propagation, session, controller } = setup([tracker]);
        await propagation.forward(FRAME, 0, [seed()]);
        await expect(
            propagation.forward(FRAME, 1, undefined, async (lost) => {
                expect(lost).toEqual([rect()]);
                controller.abort();
                return [seed(0.21)];
            }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(session.started).toHaveLength(1);
        expect(tracker.anchors).toEqual([]);
        expect(propagation.finish()[0]!.endSec).toBeCloseTo(FRAME_SEC);
    });

    it("stops a duplicate reverse prefix when its settled predecessor has a different cadence phase", async () => {
        const frames = Array.from({ length: 21 }, (_, index) => ({ contentSec: index / 30, durationSec: 1 / 30 }));
        const youngerReverse = new ScriptedTracker();
        const { propagation } = setup(
            [new ScriptedTracker([rejected("geometry")]), new ScriptedTracker(), youngerReverse, new ScriptedTracker()],
            frames.length,
            frames,
        );
        propagation.beginForwardWindow(0);
        for (let index = 0; index < frames.length; index++) {
            await propagation.forward(FRAME, index, index === 10 || index === 13 ? [seed()] : undefined);
        }
        propagation.endForwardWindow();
        propagation.startBackward(FRAME, 13);
        await propagation.backward(FRAME, 12, undefined, 13);
        await propagation.backward(FRAME, 11, undefined, 13);
        propagation.startBackward(FRAME, 10);
        await propagation.backward(FRAME, 10, [seed()], 13);
        for (let index = 9; index >= 6; index--) {
            await propagation.backward(FRAME, index, undefined, 10);
            await propagation.backward(FRAME, index, undefined, 13);
            if (index > 6) expect(propagation.hasBackwardWork(13), `younger reverse at frame ${index}`).toBe(true);
        }
        // The older prefix settles frame 6 while the younger one's settled
        // suffix begins at 7. Requiring both to infer together misses the stop.
        expect(propagation.hasBackwardWork(13)).toBe(false);
        expect(propagation.hasBackwardWork(10)).toBe(true);
        for (let index = 5; index >= 0; index--) await propagation.backward(FRAME, index, undefined, 10);
        const tracks = propagation.finish();
        expect(tracks).toHaveLength(2);
        for (let index = 0; index < frames.length; index++) {
            expect(masksAt(tracks, (index + 0.5) / 30), `coverage at source frame ${index}`).toHaveLength(1);
        }
    });
});

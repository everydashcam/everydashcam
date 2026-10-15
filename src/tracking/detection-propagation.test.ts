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
import { createDetectionSampler } from "./detection-sampling.js";
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
    readonly steps: number[] = [];
    readonly initializedFrames: Array<Parameters<PropagationTracker["init"]>[0]> = [];
    readonly updateFrames: Array<Parameters<PropagationTracker["update"]>[0]> = [];
    current = box();
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

function setup(tracks: ScriptedTracker[], count = 12, timings?: SourceFrameTiming[], margin = 0, dense = false) {
    const session = new ScriptedSession(tracks);
    const controller = new AbortController();
    const stats: DetectPassStats = { scans: 0, tiles: 0, inferMs: 0, trackUpdates: 0, backwardUpdates: 0, trackMs: 0 };
    const frames =
        timings ??
        Array.from({ length: count }, (_, index) => ({ contentSec: index * FRAME_SEC, durationSec: FRAME_SEC }));
    const propagation = new DetectionPropagation(dense ? null : session, {
        margin,
        seedScoreMin: 0.45,
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
    it.each([30, 60])("keeps reverse calibration of repeated slow positions sparse at %s fps", async (fps) => {
        const framesPerInterval = fps / 15;
        const seedIndex = 6 * framesPerInterval;
        const frames = Array.from({ length: seedIndex + 1 }, (_, index) => ({
            contentSec: index / fps,
            durationSec: 1 / fps,
        }));
        const reverse = new ScriptedTracker([
            ...Array.from({ length: framesPerInterval }, () => accepted(0.47)),
            ...Array.from({ length: 5 }, (_, step) => accepted(0.44 - step * 0.03)),
        ]);
        const { propagation, stats } = setup([new ScriptedTracker(), reverse], frames.length, frames);
        propagation.beginForwardWindow(0);
        await propagation.forward(FRAME, seedIndex, [seed(0.5)]);
        propagation.startBackward(FRAME, seedIndex);
        for (let index = seedIndex - 1; index >= 0; index--) {
            await propagation.backward(FRAME, index, seedIndex);
            expect(propagation.hasBackwardHighMotion(seedIndex)).toBe(false);
        }
        expect(reverse.steps).toHaveLength(6 + framesPerInterval - 1);
        expect(stats.calibrationUpdates).toBe(framesPerInterval - 1);
        expect(stats.highMotionUpdates ?? 0).toBe(0);
        const tracks = propagation.finish();
        for (let index = 0; index <= seedIndex; index++) expect(masksAt(tracks, (index + 0.5) / fps)).toHaveLength(1);
    });

    it("calibrates reverse motion of a four-pixel object at 60 fps", async () => {
        const frames = Array.from({ length: 6 }, (_, index) => ({ contentSec: index / 60, durationSec: 1 / 60 }));
        const reverse = new ScriptedTracker(
            Array.from({ length: 4 }, (_, step) => ({ ...accepted(), box: { x: 199 - step, y: 200, w: 4, h: 4 } })),
        );
        const { propagation } = setup([new ScriptedTracker(), reverse], frames.length, frames);
        propagation.beginForwardWindow(0);
        await propagation.forward(FRAME, 5, [{ score: 0.8, rect: { xPct: 0.2, yPct: 0.4, wPct: 0.004, hPct: 0.008 } }]);
        propagation.startBackward(FRAME, 5);
        for (let index = 4; index >= 1; index--) await propagation.backward(FRAME, index, 5);
        expect(reverse.steps[0]).toBeCloseTo(1 / 60);
        expect(propagation.hasBackwardHighMotion(5)).toBe(true);
    });

    it.each([false, true])(
        "calibrates fast reverse motion independently of a slow forward history (%s)",
        async (hasForwardHistory) => {
            const frames = Array.from({ length: hasForwardHistory ? 11 : 9 }, (_, index) => ({
                contentSec: index / 30,
                durationSec: 1 / 30,
            }));
            const reverse = new ScriptedTracker(
                Array.from({ length: 8 }, (_, step) => accepted(0.5 - (step + 1) * 0.04)),
            );
            const { propagation, stats } = setup([new ScriptedTracker(), reverse], frames.length, frames);
            propagation.beginForwardWindow(0);
            await propagation.forward(FRAME, 8, [seed(0.5)]);
            for (let index = 9; index < frames.length; index++) await propagation.forward(FRAME, index, undefined);
            const [job] = propagation.backwardJobs();
            expect(job!.hasHighMotion).toBe(false);
            expect(planReverseFrameIndices(frames, [job!])).not.toContain(5);
            propagation.startBackward(FRAME, 8);
            for (let index = 7; index >= 0; index--) {
                const planned = new Set(
                    planReverseFrameIndices(frames, [{ ...job!, hasHighMotion: propagation.hasBackwardHighMotion(8) }]),
                );
                await propagation.backward(
                    () => {
                        expect(planned.has(index), `reverse pixels for frame ${index}`).toBe(true);
                        return FRAME;
                    },
                    index,
                    8,
                );
                if (index === 7) expect(propagation.hasBackwardHighMotion(8)).toBe(false);
                if (index === 6) expect(propagation.hasBackwardHighMotion(8)).toBe(true);
            }
            expect(reverse.steps).toHaveLength(8);
            expect(stats.calibrationUpdates).toBe(hasForwardHistory ? 2 : 1);
            const tracks = propagation.finish();
            for (let index = 0; index <= 8; index++) {
                expect(masksAt(tracks, (index + 0.5) / 30)[0]!.xPct).toBeCloseTo(0.5 - (8 - index) * 0.04);
            }
        },
    );

    it("recognizes reverse acceleration after an initially stationary calibration", async () => {
        const frames = Array.from({ length: 13 }, (_, index) => ({ contentSec: index / 60, durationSec: 1 / 60 }));
        const reverse = new ScriptedTracker([
            accepted(0.5),
            accepted(0.5),
            accepted(0.5),
            accepted(0.5),
            accepted(0.42),
            accepted(0.4),
            accepted(0.38),
            accepted(0.36),
            accepted(0.34),
        ]);
        const { propagation, stats } = setup([new ScriptedTracker(), reverse], frames.length, frames);
        propagation.beginForwardWindow(0);
        await propagation.forward(FRAME, 12, [seed(0.5)]);
        propagation.startBackward(FRAME, 12);
        for (let index = 11; index >= 0; index--) {
            await propagation.backward(FRAME, index, 12);
            if (index === 8) expect(propagation.hasBackwardHighMotion(12)).toBe(false);
            if (index === 4) expect(propagation.hasBackwardHighMotion(12)).toBe(true);
        }
        expect(reverse.steps).toHaveLength(9);
        expect(stats.calibrationUpdates).toBe(3);
        expect(stats.highMotionUpdates).toBe(3);
        expect(masksAt(propagation.finish(), 0.5 / 60)[0]!.xPct).toBeCloseTo(0.34);
    });

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
                2,
            );
        }
        expect(reverse.steps).toHaveLength(2);
        expect(stats.calibrationUpdates).toBe(1);
        expect(stats.highMotionUpdates).toBe(2);
    });

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

    it("keeps a checkpoint's pixel margin independent of later source dimensions", async () => {
        const tiny = { score: 0.8, rect: { xPct: 0.2, yPct: 0.4, wPct: 0.01, hPct: 0.008 } };
        const { propagation } = setup([new ScriptedTracker(), new ScriptedTracker()], 3, undefined, 0.12);
        await propagation.forward(FRAME, 0, [tiny]);
        await propagation.forward(FRAME, 1, []);
        await propagation.forward({ width: 100, height: 50, close() {} }, 2, [tiny]);
        const groups = propagation.finishByCheckpoint();
        expect(groups.size).toBe(2);
        expect(groups.get(0)![0]!.keyframes[0]!.rect.xPct * FRAME.width).toBeCloseTo(199);
        expect(groups.get(2 * FRAME_SEC)![0]!.keyframes[0]!.rect.xPct * 100).toBeCloseTo(19);
    });

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
                        await group.propagation.backward(source, index, group.seedIndex);
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

    it.each([false, true])("verifies an off-grid source endpoint (backward=%s)", async (backward) => {
        const timings = Array.from({ length: 2 }, (_, index) => ({ contentSec: index / 60, durationSec: 1 / 60 }));
        const tracker = new ScriptedTracker();
        const { propagation } = setup(backward ? [new ScriptedTracker(), tracker] : [tracker], 2, timings);
        if (backward) {
            propagation.beginForwardWindow(0);
            await propagation.forward(FRAME, 1, [seed()]);
            propagation.startBackward(FRAME, 1);
            await propagation.backward(FRAME, 0, 1);
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

    it.each([{ checkpoint: [] }, { checkpoint: [seed(0.2, 0.3)] }])(
        "includes an empty or sub-threshold checkpoint before ending an accepted track (%j)",
        async ({ checkpoint }) => {
            const tracker = new ScriptedTracker();
            const { propagation } = setup([tracker], 7);
            for (let index = 0; index < 7; index++)
                await propagation.forward(FRAME, index, index === 0 ? [seed()] : index === 3 ? checkpoint : undefined);
            expect(tracker.steps).toHaveLength(3);
            const tracks = propagation.finish();
            expect(tracks).toHaveLength(1);
            expect(tracks[0]!.endSec).toBeCloseTo(4 * FRAME_SEC);
            expect(masksAt(tracks, 3.5 * FRAME_SEC)).toHaveLength(1);
            for (let index = 4; index < 7; index++) expect(masksAt(tracks, (index + 0.5) * FRAME_SEC)).toEqual([]);
        },
    );

    it("starts a new template at every positive checkpoint without sharing evidence", async () => {
        const first = new ScriptedTracker();
        const second = new ScriptedTracker();
        const reverse = new ScriptedTracker();
        const { propagation } = setup([first, second, reverse], 7);
        for (let index = 0; index < 7; index++)
            await propagation.forward(FRAME, index, index === 0 || index === 3 ? [seed()] : undefined);
        expect(first.steps).toHaveLength(3);
        expect(second.steps).toHaveLength(3);
        expect(propagation.backwardJobs()).toMatchObject([{ seedIndex: 3, startIndex: 0 }]);
        propagation.startBackward(FRAME, 3);
        for (let index = 2; index >= 0; index--) await propagation.backward(FRAME, index, 3);
        expect(reverse.steps).toHaveLength(3);
        const tracks = propagation.finish();
        expect(tracks).toHaveLength(2);
        expect(tracks.map((track) => track.detHits)).toEqual([1, 1]);
        // Independent masks overlap through both endpoint frames without
        // sharing detector evidence or continuing beyond their checkpoints.
        expect(masksAt(tracks, FRAME_SEC / 2)).toHaveLength(2);
        expect(masksAt(tracks, 1.5 * FRAME_SEC)).toHaveLength(2);
        expect(masksAt(tracks, 3.5 * FRAME_SEC)).toHaveLength(2);
        expect(masksAt(tracks, 4.5 * FRAME_SEC)).toHaveLength(1);
    });

    it("bounds lazy reverse initialization at the preceding empty checkpoint", async () => {
        const reverse = new ScriptedTracker();
        const { propagation } = setup([new ScriptedTracker(), reverse], 9);
        propagation.beginForwardWindow(0, 3);
        await propagation.forward(FRAME, 7, [seed()]);
        expect(propagation.backwardJobs()).toMatchObject([{ seedIndex: 7, startIndex: 3 }]);
        propagation.startBackward(FRAME, 7);
        for (let index = 6; index >= 0; index--) await propagation.backward(FRAME, index, 7);
        expect(reverse.steps).toHaveLength(4);
        const tracks = propagation.finish();
        expect(tracks[0]!.startSec).toBeCloseTo(3 * FRAME_SEC);
        expect(masksAt(tracks, 3.5 * FRAME_SEC)).toHaveLength(1);
        expect(masksAt(tracks, 2.5 * FRAME_SEC)).toEqual([]);
    });

    it("covers an isolated missed checkpoint from both adjacent trajectories without crossing it", async () => {
        const first = new ScriptedTracker();
        const reverse = new ScriptedTracker();
        const { propagation } = setup([first, new ScriptedTracker(), reverse], 7);
        for (let index = 0; index < 7; index++) {
            await propagation.forward(
                FRAME,
                index,
                index === 0 || index === 6 ? [seed()] : index === 3 ? [] : undefined,
            );
            if (index >= 3 && index < 6) expect(propagation.forwardTrackCount()).toBe(0);
        }
        expect(first.steps).toHaveLength(3);
        expect(propagation.backwardJobs()).toMatchObject([{ seedIndex: 6, startIndex: 3 }]);
        propagation.startBackward(FRAME, 6);
        for (let index = 5; index >= 0; index--) await propagation.backward(FRAME, index, 6);
        expect(reverse.steps).toHaveLength(3);
        expect(propagation.hasBackwardWork()).toBe(false);
        const groups = propagation.finishByCheckpoint();
        expect([...groups.keys()]).toEqual([0, 6 * FRAME_SEC]);
        expect(groups.get(0)![0]!.endSec).toBeCloseTo(4 * FRAME_SEC);
        expect(groups.get(6 * FRAME_SEC)![0]!.startSec).toBeCloseTo(3 * FRAME_SEC);
        const tracks = [...groups.values()].flat();
        for (let index = 0; index < 7; index++)
            expect(masksAt(tracks, (index + 0.5) * FRAME_SEC)).toHaveLength(index === 3 ? 2 : 1);
        expect(propagation.uncertainFramesByCheckpoint().size).toBe(0);
    });

    it.each([
        { backward: false, rejects: false },
        { backward: false, rejects: true },
        { backward: true, rejects: false },
        { backward: true, rejects: true },
    ])("observes an off-cadence checkpoint after calibration ($backward, $rejects)", async ({ backward, rejects }) => {
        const frames = Array.from({ length: 7 }, (_, index) => ({ contentSec: index / 60, durationSec: 1 / 60 }));
        const tracker = new ScriptedTracker([
            ...Array.from({ length: 4 }, () => accepted()),
            rejects ? rejected("appearance") : accepted(0.25),
        ]);
        const { propagation } = setup(backward ? [new ScriptedTracker(), tracker] : [tracker], 7, frames);
        const boundary = backward ? 1 : 5;
        let scans = 0;
        const redetect = async () => {
            scans++;
            return [];
        };
        if (backward) {
            propagation.beginForwardWindow(0, boundary);
            await propagation.forward(FRAME, 6, [seed()]);
            propagation.startBackward(FRAME, 6);
            for (let index = 5; index >= 0; index--) await propagation.backward(FRAME, index, 6, redetect);
        } else {
            await propagation.forward(FRAME, 0, [seed()]);
            for (let index = 1; index < 7; index++)
                await propagation.forward(FRAME, index, index === boundary ? [] : undefined, redetect);
        }
        expect(tracker.steps).toHaveLength(5);
        expect(tracker.steps[4]).toBeCloseTo(1 / 60);
        expect(scans).toBe(rejects ? 1 : 0);
        const tracks = propagation.finish();
        const masks = masksAt(tracks, (boundary + 0.5) / 60);
        expect(masks).toHaveLength(rejects ? 0 : 1);
        if (!rejects) expect(masks[0]!.xPct).toBeCloseTo(0.25);
        expect(masksAt(tracks, (backward ? 0.5 : 6.5) / 60)).toEqual([]);
        const uncertain = [...propagation.uncertainFramesByCheckpoint().values()].flat();
        expect(uncertain).toEqual(rejects ? [frames[boundary]] : []);
    });

    it.each(["low-score", "appearance", "geometry", "texture-collapse"] as const)(
        "ends both directions immediately on %s without filling the loss",
        async (reason) => {
            const forward = new ScriptedTracker([rejected(reason)]);
            const reverse = new ScriptedTracker([rejected(reason)]);
            const { propagation } = setup([forward, reverse], 7);
            propagation.beginForwardWindow(0);
            await propagation.forward(FRAME, 3, [seed()]);
            for (let index = 4; index < 7; index++) await propagation.forward(FRAME, index, undefined);
            propagation.startBackward(FRAME, 3);
            for (let index = 2; index >= 0; index--) await propagation.backward(FRAME, index, 3);
            expect(forward.steps).toHaveLength(1);
            expect(reverse.steps).toHaveLength(1);
            const tracks = propagation.finish();
            expect(tracks[0]!.startSec).toBeCloseTo(3 * FRAME_SEC);
            expect(tracks[0]!.endSec).toBeCloseTo(4 * FRAME_SEC);
        },
    );

    it.each([15, 30, 60, 120])("copies dense detections only to unchecked neighbors at %i fps", async (fps) => {
        const frames = Array.from({ length: fps + 1 }, (_, index) => ({
            contentSec: index / fps,
            durationSec: 1 / fps,
        }));
        const { propagation, session, stats } = setup([], frames.length, frames, 0, true);
        const sample = createDetectionSampler("thorough", 0);
        const checkpoints: number[] = [];
        for (let index = 0; index < frames.length; index++) {
            const isCheckpoint = sample(index / fps, index === fps);
            if (isCheckpoint) checkpoints.push(index);
            await propagation.forward(
                FRAME,
                index,
                isCheckpoint ? (index === Math.floor(fps / 2) ? [seed()] : []) : undefined,
            );
        }
        expect(session.started).toEqual([]);
        expect(stats.trackUpdates).toBe(0);
        expect(propagation.backwardJobs()).toEqual([]);
        const tracks = propagation.finish();
        const seedIndex = checkpoints.find((index) => index === Math.floor(fps / 2));
        if (seedIndex === undefined) {
            expect(tracks).toEqual([]);
            return;
        }
        const at = checkpoints.indexOf(seedIndex);
        const previous = checkpoints[at - 1]!;
        const next = checkpoints[at + 1]!;
        expect(tracks).toHaveLength(1);
        for (let index = 0; index < frames.length; index++) {
            const masks = masksAt(tracks, (index + 0.5) / fps);
            expect(masks.length, `source frame ${index}`).toBe(index > previous && index < next ? 1 : 0);
            if (masks.length)
                for (const field of ["xPct", "yPct", "wPct", "hPct"] as const)
                    expect(masks[0]![field]).toBeCloseTo(rect()[field]);
        }
    });

    it.each([false, true])("interpolates skipped frames within an independent seed (backward=%s)", async (backward) => {
        const frames = Array.from({ length: 5 }, (_, index) => ({ contentSec: index / 30, durationSec: 1 / 30 }));
        const tracker = new ScriptedTracker(
            backward
                ? [accepted(0.23), accepted(0.22), accepted(0.2)]
                : [accepted(0.21), accepted(0.22), accepted(0.24)],
        );
        const { propagation } = setup(backward ? [new ScriptedTracker(), tracker] : [tracker], 5, frames);
        propagation.beginForwardWindow(0);
        await propagation.forward(FRAME, backward ? 4 : 0, [seed(backward ? 0.24 : 0.2)]);
        if (backward) propagation.startBackward(FRAME, 4);
        for (let step = 1; step < 5; step++) {
            const source =
                step === 3
                    ? () => {
                          throw new Error("skipped frame requests pixels");
                      }
                    : FRAME;
            if (backward) await propagation.backward(source, 4 - step, 4);
            else await propagation.forward(source, step, undefined);
        }
        const tracks = propagation.finish();
        expect(tracker.steps).toHaveLength(3);
        for (let index = 0; index < 5; index++)
            expect(masksAt(tracks, (index + 0.5) / 30)[0]!.xPct).toBeCloseTo(0.2 + index * 0.01);
    });
});

describe("same-frame detector recovery", () => {
    it("replaces only the rejected branch and ends survivors after the next checkpoint", async () => {
        const lost = new ScriptedTracker([rejected("appearance")]);
        const survivor = new ScriptedTracker();
        const replacement = new ScriptedTracker();
        const { propagation, stats, session } = setup([lost, survivor, replacement], 4);
        let scans = 0;
        const redetect = async () => {
            scans++;
            return [seed(0.65), seed(0.22)];
        };
        await propagation.forward(FRAME, 0, [seed(), seed(0.65)], redetect);
        await propagation.forward(FRAME, 1, undefined, redetect);
        expect(scans).toBe(1);
        expect(session.started).toHaveLength(3);
        expect(survivor.initialized).toHaveLength(1);
        expect(replacement.initialized[0]!.x).toBe(220);
        expect(stats.recoveredTracks).toBe(1);
        await propagation.forward(FRAME, 2, [], redetect);
        await propagation.forward(FRAME, 3, undefined, redetect);
        const tracks = propagation.finish();
        expect(masksAt(tracks, FRAME_SEC).map((mask) => mask.xPct)).toEqual([0.65, 0.22]);
        expect(masksAt(tracks, FRAME_SEC * 2).map((mask) => mask.xPct)).toEqual([0.65, 0.22]);
        expect(masksAt(tracks, FRAME_SEC * 3)).toEqual([]);
        expect(propagation.uncertainFramesByCheckpoint().size).toBe(0);
        expect(scans).toBe(1);
    });

    it.each([false, true])(
        "keeps cached detector recovery at a rejected checkpoint within its boundary (backward=%s)",
        async (backward) => {
            const tracker = new ScriptedTracker([rejected("appearance")]);
            const replacement = new ScriptedTracker();
            const { propagation, stats } = setup(
                backward ? [new ScriptedTracker(), tracker, replacement] : [tracker, replacement],
                3,
            );
            let scans = 0;
            const redetect = async () => {
                scans++;
                return [seed(0.22)];
            };
            if (backward) {
                propagation.beginForwardWindow(0, 1);
                await propagation.forward(FRAME, 2, [seed()]);
                propagation.startBackward(FRAME, 2);
                await propagation.backward(FRAME, 1, 2, redetect);
                await propagation.backward(FRAME, 0, 2, redetect);
                expect(propagation.hasBackwardWork()).toBe(false);
            } else {
                await propagation.forward(FRAME, 0, [seed()]);
                // A retained checkpoint supplies [] to prevent duplicate seeds;
                // its actual cached detector evidence remains available to recovery.
                await propagation.forward(FRAME, 1, [], redetect);
                await propagation.forward(FRAME, 2, undefined, redetect);
                expect(propagation.forwardTrackCount()).toBe(0);
            }
            expect(tracker.steps).toHaveLength(1);
            expect(replacement.steps).toEqual([]);
            expect(scans).toBe(1);
            expect(stats.recoveredTracks).toBe(1);
            expect(propagation.uncertainFramesByCheckpoint().size).toBe(0);
            const groups = propagation.finishByCheckpoint();
            expect([...groups.keys()]).toEqual([backward ? 2 * FRAME_SEC : 0]);
            const tracks = [...groups.values()].flat();
            expect(masksAt(tracks, 1.5 * FRAME_SEC).map((mask) => mask.xPct)).toEqual([0.22]);
            expect(masksAt(tracks, (backward ? 0.5 : 2.5) * FRAME_SEC)).toEqual([]);
        },
    );

    it("shares one recovery scan across failures without assigning one detection twice", async () => {
        const { propagation, stats } = setup(
            [new ScriptedTracker([rejected()]), new ScriptedTracker([rejected()]), new ScriptedTracker()],
            2,
        );
        let scans = 0;
        await propagation.forward(FRAME, 0, [seed(), seed(0.35)]);
        await propagation.forward(FRAME, 1, undefined, async () => {
            scans++;
            return [seed(0.22)];
        });
        expect(scans).toBe(1);
        expect(stats.recoveredTracks).toBe(1);
        expect(masksAt(propagation.finish(), FRAME_SEC).map((mask) => mask.xPct)).toEqual([0.22]);
        expect(propagation.uncertainFramesByCheckpoint().get(0)).toEqual([
            { contentSec: FRAME_SEC, durationSec: FRAME_SEC },
        ]);
    });

    it.each([
        { name: "empty", seeds: [] },
        { name: "below threshold", seeds: [seed(0.2, 0.44)] },
        { name: "unreachable", seeds: [seed(0.8)] },
        { name: "oversized", seeds: [{ ...seed(), rect: { ...rect(), wPct: 0.6 } }] },
    ])("marks $name recovery as uncertain without holding an old mask", async ({ seeds }) => {
        const { propagation, session } = setup([new ScriptedTracker([rejected()])], 3);
        await propagation.forward(FRAME, 0, [seed()]);
        await propagation.forward(FRAME, 1, undefined, async () => seeds);
        await propagation.forward(FRAME, 2, undefined);
        expect(session.started).toHaveLength(1);
        expect(masksAt(propagation.finish(), FRAME_SEC)).toEqual([]);
        expect(propagation.uncertainFramesByCheckpoint().get(0)).toHaveLength(1);
    });

    it("owns reverse recovery under the original checkpoint and stops at its preceding scan", async () => {
        const { propagation } = setup(
            [new ScriptedTracker(), new ScriptedTracker([rejected()]), new ScriptedTracker()],
            4,
        );
        await propagation.forward(FRAME, 0, []);
        await propagation.forward(FRAME, 1, undefined);
        await propagation.forward(FRAME, 2, undefined);
        await propagation.forward(FRAME, 3, [seed()]);
        propagation.endForwardWindow();
        propagation.startBackward(FRAME, 3);
        await propagation.backward(FRAME, 2, 3, async () => [seed(0.22)]);
        expect(propagation.hasBackwardHighMotion(3)).toBe(true);
        await propagation.backward(FRAME, 1, 3);
        expect(propagation.hasBackwardWork(3)).toBe(true);
        await propagation.backward(FRAME, 0, 3);
        expect(propagation.hasBackwardWork(3)).toBe(false);
        expect(propagation.backwardJobs()).toHaveLength(1);
        const groups = propagation.finishByCheckpoint();
        expect([...groups.keys()]).toEqual([3 * FRAME_SEC]);
        expect(masksAt(groups.get(3 * FRAME_SEC)!, 0).map((mask) => mask.xPct)).toEqual([0.22]);
        expect(masksAt(groups.get(3 * FRAME_SEC)!, FRAME_SEC).map((mask) => mask.xPct)).toEqual([0.22]);
    });

    it("propagates cancellation during recovery before initializing a replacement", async () => {
        const { propagation, controller, session } = setup([new ScriptedTracker([rejected()])], 2);
        await propagation.forward(FRAME, 0, [seed()]);
        await expect(
            propagation.forward(FRAME, 1, undefined, async () => {
                controller.abort();
                return [seed()];
            }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(session.started).toHaveLength(1);
    });
});

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
import type { TrackBox } from "./track-guards.js";

const FRAME: ImageBitmap = { width: 1000, height: 500, close() {} };
const FRAME_SEC = 1 / 30;
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
    current = box();
    confirmsAppearance = false;
    acceptsAnchor = true;
    onUpdate: (() => void) | undefined;

    constructor(private readonly updates: Update[] = []) {}

    init(_frame: Parameters<PropagationTracker["init"]>[0], _width: number, _height: number, initial: TrackBox): void {
        this.current = { ...initial };
        this.initialized.push({ ...initial });
    }

    async update(
        _frame: Parameters<PropagationTracker["update"]>[0],
        _width: number,
        _height: number,
        dtSec: number,
    ): Promise<Update> {
        this.steps.push(dtSec);
        this.onUpdate?.();
        const result = this.updates.shift() ?? { ...accepted(), box: { ...this.current } };
        if (!result.rejected && result.score >= 0.2 && !result.lost) this.current = { ...result.box };
        return result;
    }

    reanchor(
        _frame: Parameters<PropagationTracker["reanchor"]>[0],
        _width: number,
        _height: number,
        proposed: TrackBox,
        requireConfirmation = false,
    ): boolean {
        this.anchors.push({ box: { ...proposed }, requireConfirmation });
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

function setup(tracks: ScriptedTracker[], count = 12, timings?: SourceFrameTiming[]) {
    const session = new ScriptedSession(tracks);
    const controller = new AbortController();
    const stats: DetectPassStats = { scans: 0, tiles: 0, inferMs: 0, trackUpdates: 0, backwardUpdates: 0, trackMs: 0 };
    const frames =
        timings ??
        Array.from({ length: count }, (_, index) => ({ contentSec: index * FRAME_SEC, durationSec: FRAME_SEC }));
    const propagation = new DetectionPropagation(session, {
        margin: 0,
        seedScoreMin: 0.25,
        strongScore: 0.45,
        frames,
        bounds: { startSec: 0, endSec: 10 },
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
    it("does not promote a weak seed through tracker sustain alone", async () => {
        const { propagation } = setup([new ScriptedTracker()], 60);
        await propagation.forward(FRAME, 0, [seed(0.2, 0.3)]);
        for (let index = 1; index < 60; index++) await propagation.forward(FRAME, index, undefined);
        expect(propagation.backwardJobs()).toEqual([]);
        expect(propagation.finish()).toEqual([]);
    });

    it("confirms with two independent eligible detections without counting weak maintenance", async () => {
        const tracker = new ScriptedTracker();
        const { propagation } = setup([tracker]);
        await propagation.forward(FRAME, 0, [seed(0.2, 0.3)]);
        await propagation.forward(FRAME, 1, [seed(0.2, 0.2)]);
        await propagation.forward(FRAME, 2, [seed(0.2, 0.35)]);
        const tracks = propagation.finish();
        expect(tracks).toHaveLength(1);
        expect(tracks[0]!.detHits).toBe(2);
        expect(tracks[0]!.bestScore).toBe(0.35);
        expect(tracker.anchors).toHaveLength(1);
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
});

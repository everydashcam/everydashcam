import { describe, expect, it } from "vitest";

import { type BlurRegion, createBlurRegion, regionRectAt } from "../blur-regions.js";
import type { CropRect } from "../transcode/compose.js";
import type { DetectedTrack } from "./detect-track.js";
import {
    buildPropagatedTrack,
    duplicatePropagationPrefixEndIndex,
    matchPropagationDetections,
    propagationGapBridges,
    type PropagatedObservation,
    type PropagationEvidence,
    type PropagationGapSpan,
    type PropagationPrefix,
    type SourceFrameTiming,
} from "./propagated-track.js";

const STRONG: PropagationEvidence = { detHits: 1, bestScore: 0.7, strongScore: 0.6 };
const BOUNDS = { startSec: 0, endSec: 10 };

function rect(xPct = 0.2, wPct = 0.1, hPct = 0.05): CropRect {
    return { xPct, yPct: 0.4, wPct, hPct };
}

function observation(contentSec: number, xPct = 0.2, wPct = 0.1, hPct = 0.05): PropagatedObservation {
    return { contentSec, rect: rect(xPct, wPct, hPct) };
}

function frames(count: number, fps = 30, offset = 0): SourceFrameTiming[] {
    return Array.from({ length: count }, (_, index) => ({ contentSec: offset + index / fps, durationSec: 1 / fps }));
}

function asRegion(track: DetectedTrack): BlurRegion {
    const region = createBlurRegion(
        "front",
        "fill",
        track.startSec,
        track.endSec,
        track.startSec,
        track.keyframes[0]!.rect,
    );
    region.keyframes = track.keyframes.map((keyframe) => ({ ...keyframe, pinned: false }));
    region.interpolation = "hold";
    return region;
}

function expectRect(actual: CropRect | null, expected: CropRect): void {
    expect(actual).not.toBeNull();
    for (const field of ["xPct", "yPct", "wPct", "hPct"] as const)
        expect(actual![field], field).toBeCloseTo(expected[field], 10);
}

describe("buildPropagatedTrack", () => {
    it("fills each displayed source frame between trusted observations without projecting the ends", () => {
        const source = frames(9, 60);
        const track = buildPropagatedTrack(
            [observation(1 / 60, 0.2), observation(5 / 60, 0.6)],
            source,
            BOUNDS,
            STRONG,
        )!;
        expect(track.keyframes.map((keyframe) => keyframe.contentSec)).toEqual(
            source.slice(1, 6).map((frame) => frame.contentSec),
        );
        const region = asRegion(track);
        expect(regionRectAt(region, 1 / 60 - 1e-4)).toBeNull();
        for (let index = 1; index <= 5; index++) {
            expectRect(regionRectAt(region, (index + 0.99) / 60), rect(0.2 + (index - 1) * 0.1));
        }
        expect(track.endSec).toBeCloseTo(6 / 60);
        expect(regionRectAt(region, track.endSec)).toBeNull();
    });

    it("preserves native observations through reversals and scale changes", () => {
        const observations = [
            observation(0, 0.2),
            observation(1 / 30, 0.7, 0.2, 0.1),
            observation(2 / 30, 0.3, 0.08, 0.04),
        ];
        const track = buildPropagatedTrack(observations, frames(3), BOUNDS, STRONG)!;
        expect(track.keyframes).toEqual(observations);
        for (let index = 0; index < observations.length; index++) {
            expectRect(regionRectAt(asRegion(track), (index + 0.99) / 30), observations[index]!.rect);
        }
    });

    it("uses actual variable frame times to interpolate position and size", () => {
        const source = [
            { contentSec: 5, durationSec: 0.01 },
            { contentSec: 5.01, durationSec: 0.06 },
            { contentSec: 5.07, durationSec: 0.03 },
            { contentSec: 5.1, durationSec: 0.04 },
        ];
        const track = buildPropagatedTrack(
            [observation(5, 0.1, 0.1, 0.05), observation(5.1, 0.5, 0.2, 0.1)],
            source,
            BOUNDS,
            STRONG,
        )!;
        expectRect(track.keyframes[1]!.rect, rect(0.14, 0.11, 0.055));
        expectRect(track.keyframes[2]!.rect, rect(0.38, 0.17, 0.085));
        expect(track.endSec).toBeCloseTo(5.14);
    });

    it("retains a single strong seed for exactly its verified source duration including an audio tail", () => {
        const track = buildPropagatedTrack([observation(4)], [{ contentSec: 4, durationSec: 0.7 }], BOUNDS, STRONG)!;
        expect(track.keyframes).toEqual([observation(4)]);
        expect(track.startSec).toBe(4);
        expect(track.endSec).toBe(4.7);
        expectRect(regionRectAt(asRegion(track), 4.69), rect());
        expect(regionRectAt(asRegion(track), 4.7)).toBeNull();
    });

    it("compresses identical holds without moving a later change or shortening the source-frame tail", () => {
        const source = frames(90);
        source[89]!.durationSec = 0.2;
        const observations = source.map((frame, index) => observation(frame.contentSec, index < 60 ? 0.2 : 0.3));
        const track = buildPropagatedTrack(observations, source, BOUNDS, STRONG)!;
        expect(track.keyframes).toEqual([observations[0], observations[60]]);
        expect(track.endSec).toBeCloseTo(source[89]!.contentSec + 0.2);
        const region = asRegion(track);
        expectRect(regionRectAt(region, source[60]!.contentSec - 0.001), rect(0.2));
        expectRect(regionRectAt(region, source[60]!.contentSec), rect(0.3));
        expectRect(regionRectAt(region, track.endSec - 0.001), rect(0.3));
        expect(regionRectAt(region, track.endSec)).toBeNull();
    });

    it("keeps the displayed predecessor when the caller expands a fractional trim and clips the ending", () => {
        const track = buildPropagatedTrack(
            [observation(1 / 30, 0.2), observation(3 / 30, 0.4)],
            frames(5),
            { startSec: 1 / 30, endSec: 0.115 },
            STRONG,
        )!;
        expect(track.startSec).toBe(1 / 30);
        expectRect(regionRectAt(asRegion(track), 0.05), rect(0.2));
        expect(track.endSec).toBe(0.115);
        expect(regionRectAt(asRegion(track), 0.115)).toBeNull();
    });

    it("accepts sorted backward and forward observations without depending on traversal order", () => {
        const backward = [observation(2 / 30, 0.4), observation(1 / 30, 0.3), observation(0, 0.2)];
        const combined = [...backward.reverse(), observation(3 / 30, 0.5)];
        const original = structuredClone(combined);
        const track = buildPropagatedTrack(combined, frames(5), BOUNDS, STRONG)!;
        expect(track.keyframes).toEqual(original);
        expect(combined).toEqual(original);
        track.keyframes[0]!.rect.xPct = 0.8;
        expect(combined).toEqual(original);
    });

    it("requires independent detector evidence regardless of the number of propagated observations", () => {
        const observations = frames(60).map((frame) => observation(frame.contentSec));
        const weak = { detHits: 1, bestScore: 0.3, strongScore: 0.6 };
        expect(buildPropagatedTrack(observations, frames(60), BOUNDS, weak)).toBeNull();
        const confirmed = buildPropagatedTrack(observations, frames(60), BOUNDS, { ...weak, detHits: 2 })!;
        expect(confirmed.detHits).toBe(2);
        expect(confirmed.bestScore).toBe(0.3);
        expect(buildPropagatedTrack(observations, frames(60), BOUNDS, { ...STRONG, detHits: 0 })).toBeNull();
    });

    it("fails on an internal source gap rather than holding geometry across missing footage", () => {
        const source = [
            { contentSec: 0, durationSec: 0.03 },
            { contentSec: 1, durationSec: 0.03 },
        ];
        expect(() => buildPropagatedTrack([observation(0), observation(1)], source, BOUNDS, STRONG)).toThrow(
            "source frame gap",
        );
        expect(buildPropagatedTrack([observation(1)], source, BOUNDS, STRONG)!.startSec).toBe(1);
    });

    it("tolerates only timestamp-rounding gaps between source frames", () => {
        const source = [
            { contentSec: 0, durationSec: 0.033333 },
            { contentSec: 0.033334, durationSec: 0.033333 },
        ];
        expect(
            buildPropagatedTrack([observation(0), observation(0.033334)], source, BOUNDS, STRONG)!.keyframes,
        ).toHaveLength(1);
    });

    it("returns no geometry for empty evidence or a non-overlapping range", () => {
        expect(buildPropagatedTrack([], frames(2), BOUNDS, STRONG)).toBeNull();
        expect(buildPropagatedTrack([observation(0)], [], BOUNDS, STRONG)).toBeNull();
        expect(buildPropagatedTrack([observation(0)], frames(2), { startSec: 1, endSec: 2 }, STRONG)).toBeNull();
    });

    it("rejects malformed or unsorted observations and missing source timestamps", () => {
        for (const observations of [
            [observation(0.1), observation(0)],
            [observation(0), observation(0)],
            [observation(Number.NaN)],
            [observation(0, 0.2, 0)],
            [observation(0.01)],
        ]) {
            expect(() => buildPropagatedTrack(observations, frames(5), BOUNDS, STRONG)).toThrow();
        }
    });

    it("rejects invalid frame timing, bounds, and detector evidence", () => {
        for (const source of [
            [{ contentSec: 0, durationSec: 0 }],
            [{ contentSec: 0, durationSec: Number.POSITIVE_INFINITY }],
            [{ contentSec: Number.NaN, durationSec: 0.1 }],
            [frames(2)[1]!, frames(2)[0]!],
            [frames(1)[0]!, frames(1)[0]!],
        ]) {
            expect(() => buildPropagatedTrack([observation(0)], source, BOUNDS, STRONG)).toThrow();
        }
        expect(() => buildPropagatedTrack([], [], { startSec: 1, endSec: 1 }, STRONG)).toThrow("bounds");
        expect(() => buildPropagatedTrack([], [], BOUNDS, { ...STRONG, detHits: 1.5 })).toThrow("evidence");
        expect(() => buildPropagatedTrack([], [], BOUNDS, { ...STRONG, bestScore: Number.NaN })).toThrow("evidence");
    });
});

describe("propagationGapBridges", () => {
    function span(first: number, last: number, xPct = 0.2): PropagationGapSpan {
        return {
            ...STRONG,
            observations: new Map(Array.from({ length: last - first + 1 }, (_, i) => [first + i, rect(xPct)])),
            windowStartIndex: 0,
            canBridgeBefore: true,
            canBridgeAfter: true,
        };
    }

    it.each([1, 2])("fills %s bracketed frames using their actual source timestamps", (missing) => {
        const before = span(0, 1);
        const after = span(2 + missing, 6, 0.22);
        const source = frames(7);
        const bridges = propagationGapBridges([before, after], source);
        expect(bridges).toHaveLength(1);
        expect(bridges[0]!.before).toBe(0);
        expect([...bridges[0]!.observations.keys()]).toEqual(Array.from({ length: missing }, (_, i) => i + 2));
        for (const [index, observed] of bridges[0]!.observations) {
            expect(observed.xPct).toBeCloseTo(0.2 + (0.02 * (index - 1)) / (missing + 1));
        }
        expect(before.observations.size).toBe(2);
        expect(after.observations.size).toBe(5 - missing);
    });

    it("keeps weak evidence, terminal losses, exits, and distinct windows unbridged", () => {
        const before = span(0, 1);
        const after = span(3, 5);
        expect(propagationGapBridges([before], frames(6))).toEqual([]);
        for (const candidate of [
            { ...before, detHits: 1, bestScore: 0.3 },
            { ...before, canBridgeAfter: false },
            { ...before, windowStartIndex: 1 },
            span(0, 1, -0.01),
        ]) {
            expect(propagationGapBridges([candidate, after], frames(6))).toEqual([]);
        }
        expect(propagationGapBridges([before, { ...after, canBridgeBefore: false }], frames(6))).toEqual([]);
        expect(propagationGapBridges([before, { ...after, bestScore: 0.3 }], frames(6))).toEqual([]);
    });

    it("rejects unrelated, oversized, and ambiguous successors or predecessors", () => {
        const before = span(0, 1);
        const after = span(3, 5, 0.22);
        expect(propagationGapBridges([before, span(3, 5, 0.7)], frames(6))).toEqual([]);
        const large = { ...after, observations: new Map([[3, rect(0.2, 0.3, 0.2)]]) };
        expect(propagationGapBridges([before, large], frames(6))).toEqual([]);
        expect(propagationGapBridges([before, after, span(3, 5, 0.21)], frames(6))).toEqual([]);
        expect(propagationGapBridges([before, after, span(0, 1, 0.21)], frames(6))).toEqual([]);
        // A hard rejection forbids bridging but does not identify which of
        // the nearby predecessors the later object actually belongs to.
        const other = { ...span(0, 1, 0.21), canBridgeAfter: false };
        expect(propagationGapBridges([before, after, other], frames(6))).toEqual([]);
    });

    it("does not add a second cover over a third trajectory's existing gap observations", () => {
        const before = span(0, 0);
        const after = span(3, 4, 0.22);
        const third = { ...span(1, 2, 0.21), canBridgeBefore: false, canBridgeAfter: false };
        expect(propagationGapBridges([before, after, third], frames(5))).toEqual([]);
        const unrelated = { ...third, observations: span(1, 2, 0.8).observations };
        expect(propagationGapBridges([before, after, unrelated], frames(5))).toHaveLength(1);
    });

    it("enforces both frame and elapsed-time limits and never crosses missing source time", () => {
        expect(propagationGapBridges([span(0, 1), span(5, 6)], frames(7))).toEqual([]);
        expect(propagationGapBridges([span(0, 1), span(3, 4)], frames(5, 5))).toEqual([]);
        const source = frames(5);
        source[2] = { contentSec: 2 / 30, durationSec: 0.001 };
        expect(propagationGapBridges([span(0, 1), span(3, 4)], source)).toEqual([]);
    });

    it("uses elapsed source time for a variable-rate missing frame", () => {
        const source = [
            { contentSec: 0, durationSec: 0.03 },
            { contentSec: 0.03, durationSec: 0.02 },
            { contentSec: 0.05, durationSec: 0.05 },
            { contentSec: 0.1, durationSec: 0.03 },
        ];
        const bridge = propagationGapBridges([span(0, 1), span(3, 3, 0.22)], source)[0]!;
        expect(bridge.observations.get(2)!.xPct).toBeCloseTo(0.2 + (0.02 * 0.02) / 0.07);
    });
});

describe("matchPropagationDetections", () => {
    it("associates independent objects one-to-one regardless of array order", () => {
        expect(matchPropagationDetections([rect(0.51), rect(0.21)], [rect(0.2), rect(0.5)])).toEqual([1, 0]);
        expect(matchPropagationDetections([], [rect()])).toEqual([]);
        expect(matchPropagationDetections([rect()], [])).toEqual([-1]);
    });

    it("leaves equal-overlap crossings unmatched in both directions", () => {
        expect(matchPropagationDetections([rect(0.25)], [rect(0.2), rect(0.3)])).toEqual([-1]);
        expect(matchPropagationDetections([rect(0.2), rect(0.2)], [rect(0.2)])).toEqual([-1, -1]);
    });

    it("does not assign a contested detection to its second-choice neighboring track", () => {
        expect(matchPropagationDetections([rect(0.22), rect(0.21)], [rect(0.2), rect(0.26)])).toEqual([-1, 0]);
    });

    it("rejects non-overlapping, oversized, or malformed geometry", () => {
        expect(
            matchPropagationDetections(
                [rect(0.5), rect(0.2, 0.21), rect(0.2, 0.1, 0.11), rect(Number.NaN), rect(0.2, 0)],
                [rect()],
            ),
        ).toEqual([-1, -1, -1, -1, -1]);
        expect(matchPropagationDetections([rect()], [rect(0.2, -0.1)])).toEqual([-1]);
        expect(matchPropagationDetections([rect(0.2, 0.2, 0.1)], [rect()])).toEqual([0]);
    });
});

function prefix(
    first: number,
    last: number,
    seedIndex: number,
    offset = 0,
    anchorIndices: readonly number[] = [seedIndex],
): PropagationPrefix {
    const observations = new Map<number, CropRect>();
    for (let index = first; index <= last; index++) observations.set(index, rect(0.2 + index * 0.002 + offset));
    return {
        seedIndex,
        observations,
        detectorAnchors: new Map(anchorIndices.map((index) => [index, { ...observations.get(index)! }])),
    };
}

describe("duplicatePropagationPrefixEndIndex", () => {
    it("trims only a near-identical anchored reverse prefix and preserves coverage without merging geometry", () => {
        const older = prefix(0, 4, 2);
        const current = prefix(2, 9, 7, 0.005);
        const original = structuredClone({ older, current });
        const endIndex = duplicatePropagationPrefixEndIndex(current, [older]);
        expect(endIndex).toBe(4);
        const remaining = [...current.observations].filter(([index]) => index > endIndex!);
        expect(remaining.map(([index]) => index)).toEqual([5, 6, 7, 8, 9]);
        const outputIndices = [...older.observations.keys(), ...remaining.map(([index]) => index)];
        expect(outputIndices).toEqual(Array.from({ length: 10 }, (_, index) => index));
        expect({ older, current }).toEqual(original);
        expect(remaining[0]![1]).toEqual(current.observations.get(5));
    });

    it("rejects crossing trajectories even when three consecutive frames temporarily coincide", () => {
        const older = prefix(0, 6, 2);
        const current = prefix(2, 10, 8);
        const observations = new Map(current.observations);
        observations.set(5, rect(0.25));
        observations.set(6, rect(0.28));
        expect(duplicatePropagationPrefixEndIndex({ ...current, observations }, [older])).toBeNull();
    });

    it.each([3, 4])("rejects an overlap of fewer than three consecutive frames starting at %s", (first) => {
        const older = prefix(0, 4, 3);
        const current = prefix(first, 9, 7);
        expect(duplicatePropagationPrefixEndIndex(current, [older])).toBeNull();
    });

    it("keeps adjacent non-overlapping trajectories unchanged", () => {
        expect(duplicatePropagationPrefixEndIndex(prefix(5, 9, 7), [prefix(0, 4, 2)])).toBeNull();
    });

    it("requires a matching independent detector anchor inside the entire shared span", () => {
        const current = prefix(2, 9, 7);
        expect(duplicatePropagationPrefixEndIndex(current, [prefix(0, 4, 1)])).toBeNull();
        const older = prefix(0, 4, 2);
        expect(duplicatePropagationPrefixEndIndex(current, [{ ...older, detectorAnchors: new Map() }])).toBeNull();
        expect(
            duplicatePropagationPrefixEndIndex(current, [{ ...older, detectorAnchors: new Map([[2, rect(0.8)]]) }]),
        ).toBeNull();
        expect(duplicatePropagationPrefixEndIndex(current, [prefix(0, 4, 1, 0, [1, 3])])).toBe(4);
    });

    it("leaves the prefix intact when more than one older trajectory qualifies", () => {
        const current = prefix(2, 9, 7);
        const first = prefix(0, 4, 2, 0.001);
        const second = prefix(1, 5, 3, -0.001);
        expect(duplicatePropagationPrefixEndIndex(current, [first, second])).toBeNull();
        expect(duplicatePropagationPrefixEndIndex(current, [second, first])).toBeNull();
    });

    it("waits for unsettled older reverse prefixes before treating a predecessor as uniquely covered", () => {
        const current = prefix(2, 9, 7);
        const older = prefix(0, 4, 3);
        expect(duplicatePropagationPrefixEndIndex(current, [{ ...older, backwardComplete: false }])).toBeNull();
        expect(duplicatePropagationPrefixEndIndex(current, [{ ...older, backwardComplete: true }])).toBe(4);
        // Even a currently disjoint earlier branch can grow into this prefix.
        const pending = { ...prefix(5, 6, 5), backwardComplete: false };
        expect(duplicatePropagationPrefixEndIndex(current, [older, pending])).toBeNull();
        expect(duplicatePropagationPrefixEndIndex(current, [older, { ...pending, backwardComplete: true }])).toBe(4);
    });

    it("uses the known forward suffix before an older reverse group starts", () => {
        const current = prefix(4, 10, 9);
        const olderForward = { ...prefix(3, 6, 3, 0, [3, 4]), backwardComplete: false };
        expect(duplicatePropagationPrefixEndIndex(current, [olderForward])).toBe(6);
        expect(duplicatePropagationPrefixEndIndex(current, [prefix(0, 6, 3, 0, [3, 4])])).toBe(6);
        // Readiness does not supply a third overlap frame that was never seen.
        expect(duplicatePropagationPrefixEndIndex(prefix(5, 10, 9), [olderForward])).toBeNull();
    });

    it("uses a reverse prefix only once its final frontier reaches the current first frame", () => {
        const current = prefix(2, 10, 9);
        const pending = { ...prefix(3, 6, 5), backwardComplete: false, backwardKnownFromIndex: 3 };
        expect(duplicatePropagationPrefixEndIndex(current, [pending])).toBeNull();
        const reached = { ...prefix(2, 6, 5), backwardComplete: false, backwardKnownFromIndex: 2 };
        expect(duplicatePropagationPrefixEndIndex(current, [reached])).toBe(6);
        // Later reverse work changes only earlier indices outside the overlap.
        const completed = prefix(0, 6, 5);
        const observations = new Map(completed.observations);
        observations.set(0, rect(0.8));
        observations.set(1, rect(0.75));
        expect(duplicatePropagationPrefixEndIndex(current, [{ ...completed, observations }])).toBe(6);
    });

    it("uses the settled overlap when reverse cadence phases leave a provisional leading hold", () => {
        const current = { ...prefix(8, 20, 13), backwardKnownFromIndex: 9 };
        const older = { ...prefix(8, 11, 10), backwardComplete: false, backwardKnownFromIndex: 8 };
        expect(duplicatePropagationPrefixEndIndex(current, [older])).toBe(11);
        const kept = [...current.observations.keys()].filter((index) => index > 11);
        expect([...older.observations.keys(), ...kept]).toEqual(Array.from({ length: 13 }, (_, index) => index + 8));
    });

    it("never counts provisional holds or their anchors toward settled duplicate evidence", () => {
        const older = { ...prefix(2, 6, 3), backwardComplete: false, backwardKnownFromIndex: 2 };
        const current = { ...prefix(2, 10, 9), backwardKnownFromIndex: 5 };
        expect(duplicatePropagationPrefixEndIndex(current, [older]), "only two current frames are settled").toBeNull();
        expect(
            duplicatePropagationPrefixEndIndex({ ...current, backwardKnownFromIndex: 4 }, [older]),
            "the only detector anchor is outside the settled overlap",
        ).toBeNull();
        const anchored = { ...older, detectorAnchors: new Map([[4, older.observations.get(4)!]]) };
        expect(duplicatePropagationPrefixEndIndex({ ...current, backwardKnownFromIndex: 4 }, [anchored])).toBe(6);
    });

    it("keeps a provisional leading hold unless the older settled prefix covers its geometry", () => {
        const current = { ...prefix(8, 20, 13), backwardKnownFromIndex: 9 };
        const older = { ...prefix(8, 11, 10), backwardComplete: false, backwardKnownFromIndex: 8 };
        const shifted = new Map(current.observations);
        shifted.set(8, rect(0.8));
        expect(duplicatePropagationPrefixEndIndex({ ...current, observations: shifted }, [older])).toBeNull();
        expect(
            duplicatePropagationPrefixEndIndex(current, [{ ...older, backwardKnownFromIndex: 9 }]),
            "an unsettled older hold cannot cover the provisional current frame",
        ).toBeNull();
        expect(
            duplicatePropagationPrefixEndIndex(current, [{ ...older, observations: prefix(9, 11, 10).observations }]),
            "cropping identity evidence cannot discard an uncovered leading frame",
        ).toBeNull();
    });

    it("waits for a competing older group even when a ready predecessor already qualifies", () => {
        const current = prefix(2, 10, 9);
        const ready = { ...prefix(0, 4, 2), backwardComplete: false, backwardKnownFromIndex: 2 };
        const pending = { ...prefix(3, 6, 5), backwardComplete: false, backwardKnownFromIndex: 3 };
        expect(duplicatePropagationPrefixEndIndex(current, [ready])).toBe(4);
        expect(duplicatePropagationPrefixEndIndex(current, [ready, pending])).toBeNull();
        // Receiving a provisional rectangle is not final detector-repair readiness.
        const provisional = { ...prefix(2, 6, 5), backwardComplete: false, backwardKnownFromIndex: 3 };
        expect(duplicatePropagationPrefixEndIndex(current, [ready, provisional])).toBeNull();
        const competing = { ...provisional, backwardKnownFromIndex: 2 };
        expect(duplicatePropagationPrefixEndIndex(current, [ready, competing])).toBeNull();
        expect(duplicatePropagationPrefixEndIndex(current, [competing, ready])).toBeNull();
        expect(duplicatePropagationPrefixEndIndex(current, [ready, prefix(0, 6, 5)])).toBeNull();
        // Rejection instead finalizes known absence: this group cannot cover f=2.
        expect(duplicatePropagationPrefixEndIndex(current, [ready, { ...pending, backwardComplete: true }])).toBe(4);
    });

    it("preserves serial duplicate-chain decisions before intermediate reverse work completes", () => {
        const first = prefix(0, 4, 2);
        const middleForward = { ...prefix(7, 9, 7), backwardComplete: false };
        const last = prefix(7, 12, 10);
        const frontierDecision = duplicatePropagationPrefixEndIndex(last, [first, middleForward]);
        expect(frontierDecision).toBe(9);
        const middleReverse = prefix(2, 9, 7);
        expect(duplicatePropagationPrefixEndIndex(middleReverse, [first])).toBe(4);
        expect(duplicatePropagationPrefixEndIndex(last, [first, middleReverse])).toBe(frontierDecision);
        // The final holds keep the same complete coverage without double masks.
        const kept = [
            ...first.observations.keys(),
            ...[...middleReverse.observations.keys()].filter((index) => index > 4),
            ...[...last.observations.keys()].filter((index) => index > frontierDecision!),
        ];
        expect(kept).toEqual(Array.from({ length: 13 }, (_, index) => index));
    });

    it("never uses readiness metadata as geometry or detector identity evidence", () => {
        const current = prefix(2, 10, 9);
        const older = { ...prefix(2, 6, 5), backwardComplete: false, backwardKnownFromIndex: 2 };
        const gap = new Map(older.observations);
        gap.delete(3);
        const crossing = new Map(older.observations);
        crossing.set(4, rect(0.7));
        for (const candidate of [
            { ...older, observations: gap },
            { ...older, observations: crossing },
            { ...older, detectorAnchors: new Map() },
            { ...older, detectorAnchors: new Map([[5, rect(0.8)]]) },
            { ...older, observations: prefix(3, 6, 5).observations },
            { ...older, observations: prefix(2, 9, 5).observations },
        ]) {
            expect(duplicatePropagationPrefixEndIndex(current, [candidate])).toBeNull();
        }
    });

    it.each([-1, 2.5, 6, Number.NaN, Number.POSITIVE_INFINITY])(
        "keeps unresolved older work conservative when its frontier is invalid: %s",
        (backwardKnownFromIndex) => {
            const older = { ...prefix(2, 6, 5), backwardComplete: false, backwardKnownFromIndex };
            expect(duplicatePropagationPrefixEndIndex(prefix(2, 10, 9), [older])).toBeNull();
        },
    );

    it("allows an early stop only after three anchored overlap frames have actually been traversed", () => {
        const older = prefix(0, 6, 4);
        expect(duplicatePropagationPrefixEndIndex(prefix(6, 10, 9), [older])).toBeNull();
        expect(duplicatePropagationPrefixEndIndex(prefix(5, 10, 9), [older])).toBeNull();
        expect(duplicatePropagationPrefixEndIndex(prefix(4, 10, 9), [older])).toBe(6);
    });

    it("never removes an early part of the new trajectory that the older one does not cover", () => {
        expect(duplicatePropagationPrefixEndIndex(prefix(1, 9, 7), [prefix(2, 5, 3)])).toBeNull();
    });

    it("never trims the current seed or forward observations", () => {
        const current = prefix(2, 9, 7);
        expect(duplicatePropagationPrefixEndIndex(current, [prefix(0, 7, 2)])).toBeNull();
        expect(duplicatePropagationPrefixEndIndex(current, [prefix(0, 8, 2)])).toBeNull();
        expect(duplicatePropagationPrefixEndIndex(current, [prefix(0, 6, 7)])).toBeNull();
    });

    it("does not treat missing source indices as a consecutive overlap", () => {
        const older = prefix(0, 6, 2);
        const current = prefix(2, 9, 7);
        const missingOlder = new Map(older.observations);
        missingOlder.delete(4);
        expect(duplicatePropagationPrefixEndIndex(current, [{ ...older, observations: missingOlder }])).toBeNull();
        const missingCurrent = new Map(current.observations);
        missingCurrent.delete(4);
        expect(duplicatePropagationPrefixEndIndex({ ...current, observations: missingCurrent }, [older])).toBeNull();
    });
});

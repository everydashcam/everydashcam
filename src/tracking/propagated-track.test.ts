import { describe, expect, it } from "vitest";

import { type BlurRegion, createBlurRegion, regionRectAt } from "../blur-regions.js";
import type { CropRect } from "../transcode/compose.js";
import type { DetectedTrack } from "./detect-track.js";
import {
    buildPropagatedTrack,
    type PropagatedObservation,
    type PropagationEvidence,
    type SourceFrameTiming,
} from "./propagated-track.js";

const STRONG: PropagationEvidence = { detHits: 1, bestScore: 0.7 };
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

    it("retains the accepted seed evidence without counting tracker observations as detector hits", () => {
        const source = frames(60);
        const observations = source.map((frame) => observation(frame.contentSec));
        const track = buildPropagatedTrack(observations, source, BOUNDS, STRONG)!;
        expect(track.detHits).toBe(1);
        expect(track.bestScore).toBe(STRONG.bestScore);
        expect(buildPropagatedTrack(observations, source, BOUNDS, { ...STRONG, detHits: 0 })).toBeNull();
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

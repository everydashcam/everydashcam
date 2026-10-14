import { describe, expect, it } from "vitest";
import { DetectionScanCache } from "./detection-scan-cache.js";

import {
    iouOf,
    packRgbPlanarNormalized,
    type RawDetection,
    suppressOverlaps,
    suppressTileOverlaps,
    tileGridSize,
    tileRects,
} from "./detect-common.js";

function det(x: number, y: number, w: number, h: number, score: number): RawDetection {
    return { x, y, w, h, score };
}

describe("tileGridSize", () => {
    it("scales with the longest source edge in landscape and portrait", () => {
        for (const [width, height, size] of [
            [3840, 2160, 3],
            [2560, 1440, 2],
            [1920, 1080, 2],
            [1280, 720, 1],
            [848, 480, 1],
        ]) {
            expect(tileGridSize(width!, height!)).toBe(size);
            expect(tileGridSize(height!, width!)).toBe(size);
        }
    });

    it("degenerate dimensions fall back to a single tile", () => {
        expect(tileGridSize(0, 0)).toBe(1);
        expect(tileGridSize(Number.NaN, 100)).toBe(1);
        expect(tileGridSize(100, Number.POSITIVE_INFINITY)).toBe(1);
    });
});

describe("tileRects", () => {
    it("covers the full frame including edges", () => {
        const tiles = tileRects(3840, 2160);
        expect(tiles).toHaveLength(9);
        const maxRight = Math.max(...tiles.map((t) => t.sx + t.sw));
        const maxBottom = Math.max(...tiles.map((t) => t.sy + t.sh));
        expect(maxRight).toBe(3840);
        expect(maxBottom).toBe(2160);
        for (const t of tiles) {
            expect(t.sx).toBeGreaterThanOrEqual(0);
            expect(t.sy).toBeGreaterThanOrEqual(0);
        }
    });

    it("neighbor tiles overlap so seam objects are fully inside one tile", () => {
        const tiles = tileRects(3840, 2160);
        // First-row neighbors: tile 0 ends past where tile 1 begins.
        expect(tiles[0]!.sx + tiles[0]!.sw).toBeGreaterThan(tiles[1]!.sx);
    });

    it("keeps portrait tiles at the same detection scale as landscape tiles", () => {
        const landscape = tileRects(3840, 2160);
        const portrait = tileRects(2160, 3840);
        expect(portrait).toHaveLength(landscape.length);
        for (const tile of landscape) {
            expect(portrait).toContainEqual({ sx: tile.sy, sy: tile.sx, sw: tile.sh, sh: tile.sw });
        }
    });
});

describe("suppressTileOverlaps", () => {
    it("keeps the best localization without inflating it from lower-score proposals", () => {
        const best = det(100, 0, 100, 20, 0.9);
        const proposals = [det(1, 0, 199, 20, 0.3), best, det(100, 0, 199, 20, 0.26)];
        const original = proposals.map((proposal) => ({ ...proposal }));
        expect(suppressTileOverlaps(proposals, 0.5)).toEqual([best]);
        expect(proposals).toEqual(original);
    });

    it("keeps separate nearby objects after suppressing each object's duplicates", () => {
        const first = det(0, 0, 20, 20, 0.9);
        const second = det(15, 0, 20, 20, 0.8);
        expect(suppressTileOverlaps([det(1, 1, 20, 20, 0.7), second, first], 0.45)).toEqual([first, second]);
    });
});

describe("suppressOverlaps", () => {
    it("preserves all detected coverage and the highest score across duplicate boxes", () => {
        const kept = suppressOverlaps([det(100, 100, 50, 20, 0.4), det(102, 101, 50, 20, 0.7)], 0.5);
        expect(kept).toEqual([det(100, 100, 52, 21, 0.7)]);
    });

    it("preserves a full plate when a higher-scored tile detection is cropped at a seam", () => {
        const full = det(90, 98, 90, 25, 0.75);
        const partial = det(100, 100, 60, 20, 0.9);
        const kept = suppressOverlaps([partial, full], 0.5);
        expect(kept).toEqual([{ ...full, score: partial.score }]);
        expect(partial).toEqual(det(100, 100, 60, 20, 0.9));
    });

    it("preserves cross-tile coverage after suppressing oversized proposals within each tile", () => {
        const partial = det(100, 100, 60, 20, 0.9);
        const full = det(90, 98, 90, 25, 0.75);
        const firstTile = suppressTileOverlaps([partial, det(41, 100, 119, 20, 0.3)], 0.5);
        const secondTile = suppressTileOverlaps([det(1, 98, 179, 25, 0.26), full], 0.5);
        expect(suppressOverlaps([...firstTile, ...secondTile], 0.5)).toEqual([{ ...full, score: partial.score }]);
    });

    it("keeps neighboring detections separate when only a grown envelope overlaps them", () => {
        const kept = suppressOverlaps(
            [det(20, 0, 100, 20, 0.9), det(40, 0, 100, 20, 0.8), det(65, 0, 100, 20, 0.7)],
            0.5,
        );
        expect(kept).toEqual([det(20, 0, 120, 20, 0.9), det(65, 0, 100, 20, 0.7)]);
    });

    it("keeps cached tile batches equivalent to one complete scan by merging their original proposals", () => {
        const tiles = tileRects(1920, 1080).slice(0, 3);
        const proposals = [[det(20, 0, 100, 20, 0.9)], [det(40, 0, 100, 20, 0.8)], [det(65, 0, 100, 20, 0.7)]].map(
            (tile) => suppressTileOverlaps(tile, 0.5),
        );
        const entry = new DetectionScanCache().entryFor(1);
        entry.record(entry.missingTiles(tiles.slice(0, 2)), proposals.slice(0, 2).flat());
        expect(suppressOverlaps(entry.boxes, 0.5)).toEqual([det(20, 0, 120, 20, 0.9)]);
        entry.record(entry.missingTiles(tiles), proposals[2]!);
        const merged = suppressOverlaps(entry.boxes, 0.5);
        expect(merged).toEqual([det(20, 0, 120, 20, 0.9), det(65, 0, 100, 20, 0.7)]);
        expect(merged).toEqual(suppressOverlaps(proposals.flat(), 0.5));
    });

    it("keeps nearby faces separate below the duplicate overlap threshold", () => {
        const faces = [det(0, 0, 20, 20, 0.9), det(15, 0, 20, 20, 0.8)];
        expect(suppressOverlaps(faces, 0.45)).toEqual(faces);
    });

    it("keeps disjoint boxes", () => {
        const kept = suppressOverlaps([det(0, 0, 50, 20, 0.4), det(500, 500, 50, 20, 0.3)], 0.5);
        expect(kept).toHaveLength(2);
    });

    it("iouOf: identical boxes -> 1, disjoint -> 0", () => {
        const a = det(10, 10, 20, 20, 1);
        expect(iouOf(a, a)).toBe(1);
        expect(iouOf(a, det(100, 100, 20, 20, 1))).toBe(0);
    });
});

describe("overlap tie-breaking", () => {
    it("keeps both duplicate stages reproducible across equal-score input permutations", () => {
        const first = det(20, 0, 100, 20, 0.8);
        const middle = det(40, 0, 100, 20, 0.8);
        const last = det(65, 0, 100, 20, 0.8);
        for (const permutation of [
            [first, middle, last],
            [first, last, middle],
            [middle, first, last],
            [middle, last, first],
            [last, first, middle],
            [last, middle, first],
        ]) {
            expect(suppressTileOverlaps(permutation, 0.5)).toEqual([first, last]);
            expect(suppressOverlaps(permutation, 0.5)).toEqual([det(20, 0, 120, 20, 0.8), last]);
        }
    });

    it("does not quantize a score difference into a geometric tie", () => {
        const lower = det(20, 0, 100, 20, 0.8);
        const higher = det(40, 0, 100, 20, 0.800000000001);
        for (const proposals of [
            [lower, higher],
            [higher, lower],
        ]) {
            expect(suppressTileOverlaps(proposals, 0.5)).toEqual([higher]);
            expect(suppressOverlaps(proposals, 0.5)).toEqual([det(20, 0, 120, 20, higher.score)]);
        }
    });
});

describe("packRgbPlanarNormalized", () => {
    it("packs interleaved RGBA pixels into normalized RGB planes", () => {
        const target = new Float32Array(6);
        packRgbPlanarNormalized(new Uint8ClampedArray([255, 128, 0, 7, 64, 32, 16, 9]), target);
        expect(target).toEqual(new Float32Array([1, 64 / 255, 128 / 255, 32 / 255, 0, 16 / 255]));
    });
});

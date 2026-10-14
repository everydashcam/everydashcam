import { describe, expect, it } from "vitest";

import type { RawDetection, TileRect } from "./detect-common.js";
import { DetectionScanCache } from "./detection-scan-cache.js";

const tiles: TileRect[] = [
    { sx: 0, sy: 0, sw: 120, sh: 80 },
    { sx: 100, sy: 0, sw: 120, sh: 80 },
    { sx: 200, sy: 0, sw: 120, sh: 80 },
];
const firstBox: RawDetection = { x: 20, y: 20, w: 50, h: 20, score: 0.8 };
const secondBox: RawDetection = { x: 230, y: 20, w: 50, h: 20, score: 0.9 };

describe("DetectionScanCache", () => {
    it("reuses one frame's completed results across repeated requests", () => {
        const cache = new DetectionScanCache();
        const entry = cache.entryFor(10.8);
        entry.record(entry.missingTiles([tiles[0]!]), [firstBox]);
        expect(cache.entryFor(10.8)).toBe(entry);
        expect(cache.entryFor(10.8).missingTiles([tiles[0]!])).toEqual([]);
        expect(cache.entryFor(10.8).boxes).toEqual([firstBox]);
        expect(entry.boxes[0]).toBe(firstBox);
        expect(entry.tileCount).toBe(1);
    });

    it("deduplicates equal-coordinate tiles while preserving request order and references", () => {
        const entry = new DetectionScanCache().entryFor(1);
        const equivalent = { ...tiles[1]! };
        const missing = entry.missingTiles([tiles[1]!, equivalent, tiles[0]!, tiles[1]!]);
        expect(missing).toEqual([tiles[1], tiles[0]]);
        expect(missing[0]).toBe(tiles[1]);
        expect(missing[1]).toBe(tiles[0]);
        entry.record(missing, []);
        expect(entry.missingTiles([equivalent, { ...tiles[0]! }])).toEqual([]);
    });

    it("scans only the uncovered part of overlapping loss plans and accumulates results", () => {
        const entry = new DetectionScanCache().entryFor(1);
        entry.record(entry.missingTiles([tiles[0]!, tiles[1]!]), [firstBox]);
        const next = entry.missingTiles([{ ...tiles[1]! }, tiles[2]!]);
        expect(next).toEqual([tiles[2]]);
        entry.record(next, [secondBox]);
        expect(entry.missingTiles(tiles)).toEqual([]);
        expect(entry.boxes).toEqual([firstBox, secondBox]);
        expect(entry.tileCount).toBe(3);
    });

    it("remembers empty detection results instead of repeating a negative scan", () => {
        const entry = new DetectionScanCache().entryFor(1);
        entry.record(entry.missingTiles(tiles), []);
        expect(entry.boxes).toEqual([]);
        expect(entry.tileCount).toBe(3);
        expect(entry.missingTiles(tiles.map((tile) => ({ ...tile })))).toEqual([]);
    });

    it("invalidates coverage and results when the source timestamp changes", () => {
        const cache = new DetectionScanCache();
        const first = cache.entryFor(10.8);
        first.record(tiles, [firstBox]);
        const next = cache.entryFor(10.839);
        expect(next).not.toBe(first);
        expect(next.boxes).toEqual([]);
        expect(next.tileCount).toBe(0);
        expect(next.missingTiles(tiles)).toEqual(tiles);
        // The ledger is deliberately bounded; historical observations live
        // with the propagation caller rather than retaining every scan here.
        expect(cache.entryFor(10.8)).not.toBe(first);
        expect(cache.entryFor(10.8).missingTiles(tiles)).toEqual(tiles);
    });

    it("keeps different detector kinds independent at the same timestamp", () => {
        const plate = new DetectionScanCache().entryFor(1);
        const face = new DetectionScanCache().entryFor(1);
        plate.record(tiles, [firstBox]);
        expect(face.missingTiles(tiles)).toEqual(tiles);
        expect(face.boxes).toEqual([]);
        face.record(tiles, [secondBox]);
        expect(plate.boxes).toEqual([firstBox]);
        expect(face.boxes).toEqual([secondBox]);
    });

    it("rejects duplicate recording atomically", () => {
        const entry = new DetectionScanCache().entryFor(1);
        entry.record([tiles[0]!], [firstBox]);
        expect(() => entry.record([tiles[1]!, { ...tiles[0]! }], [secondBox])).toThrow("already recorded");
        expect(entry.missingTiles([tiles[1]!])).toEqual([tiles[1]]);
        expect(entry.boxes).toEqual([firstBox]);
        expect(entry.tileCount).toBe(1);
        expect(() => entry.record([tiles[1]!, { ...tiles[1]! }], [])).toThrow("already recorded");
    });

    it("rejects invalid timestamps and tile batches without changing coverage", () => {
        const cache = new DetectionScanCache();
        expect(() => cache.entryFor(Number.NaN)).toThrow("timestamp is invalid");
        expect(() => cache.entryFor(Number.POSITIVE_INFINITY)).toThrow("timestamp is invalid");
        const entry = cache.entryFor(0);
        expect(() => entry.missingTiles([{ ...tiles[0]!, sx: Number.NaN }])).toThrow("tile is invalid");
        expect(() => entry.record([tiles[0]!, { ...tiles[1]!, sw: 0 }], [])).toThrow("tile is invalid");
        expect(() => entry.record([], [firstBox])).toThrow("results have no tiles");
        expect(entry.tileCount).toBe(0);
        expect(entry.boxes).toEqual([]);
        expect(entry.missingTiles(tiles)).toEqual(tiles);
    });
});

import { describe, expect, it } from "vitest";
import { tileRects } from "./detect-common.js";
import { DetectionTileCache } from "./detection-tile-cache.js";

describe("DetectionTileCache", () => {
    it("shares exact tile references between discovery and recovery on the same dimensions", () => {
        const cache = new DetectionTileCache();
        const discovery = cache.forFrame(3840, 2160);
        const recovery = cache.forFrame(3840, 2160);
        expect(discovery).toEqual(tileRects(3840, 2160));
        expect(recovery).toBe(discovery);
        for (const [index, tile] of discovery.entries()) expect(recovery[index]).toBe(tile);
    });

    it("rebuilds the grid for either changed dimension without modifying earlier coverage", () => {
        const cache = new DetectionTileCache();
        const original = cache.forFrame(1920, 1080);
        for (const [width, height] of [
            [3840, 2160],
            [3840, 1920],
            [2160, 3840],
            [1920, 1080],
        ] as const) {
            const tiles = cache.forFrame(width, height);
            expect(tiles).toEqual(tileRects(width, height));
            expect(tiles).not.toBe(original);
            expect(cache.forFrame(width, height)).toBe(tiles);
            for (const tile of tiles) {
                expect(tile.sx).toBeGreaterThanOrEqual(0);
                expect(tile.sy).toBeGreaterThanOrEqual(0);
                expect(tile.sx + tile.sw).toBeLessThanOrEqual(width);
                expect(tile.sy + tile.sh).toBeLessThanOrEqual(height);
            }
        }
        expect(original).toEqual(tileRects(1920, 1080));
    });

    it.each([
        [0, 1080],
        [1920, -1],
        [Number.NaN, 1080],
        [1920, Number.POSITIVE_INFINITY],
        [1920.5, 1080],
    ])("rejects invalid frame dimensions %s × %s", (width, height) => {
        const cache = new DetectionTileCache();
        const valid = cache.forFrame(1920, 1080);
        expect(() => cache.forFrame(width, height)).toThrow("detection frame dimensions are invalid");
        expect(cache.forFrame(1920, 1080)).toBe(valid);
    });
});

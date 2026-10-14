import type { RawDetection, TileRect } from "./detect-common.js";

function tileKey(tile: TileRect): string {
    if (![tile.sx, tile.sy, tile.sw, tile.sh].every(Number.isFinite) || tile.sw <= 0 || tile.sh <= 0) {
        throw new Error("detection scan tile is invalid");
    }
    return `${tile.sx},${tile.sy},${tile.sw},${tile.sh}`;
}

/** Completed model batches for one source frame and detector kind. Empty
 * results still cover their tiles. The caller owns inference and suppression. */
export class DetectionScanEntry {
    private readonly covered = new Set<string>();
    private readonly storedBoxes: RawDetection[] = [];

    constructor(readonly contentSec: number) {}

    get tileCount(): number {
        return this.covered.size;
    }

    get boxes(): readonly RawDetection[] {
        return this.storedBoxes;
    }

    /** Coordinate equality also recognizes equivalent reconstructed grids.
     * Preserve the first requested tile's reference and original order. */
    missingTiles(requested: readonly TileRect[]): TileRect[] {
        const selected = new Set<string>();
        return requested.filter((tile) => {
            const key = tileKey(tile);
            if (this.covered.has(key) || selected.has(key)) return false;
            selected.add(key);
            return true;
        });
    }

    /** Record only a successfully completed missing-tile batch. Re-recording
     * any covered tile is a caller error, even if both results are empty. */
    record(tiles: readonly TileRect[], boxes: readonly RawDetection[]): void {
        const keys = tiles.map(tileKey);
        if (new Set(keys).size !== keys.length || keys.some((key) => this.covered.has(key))) {
            throw new Error("detection scan tile is already recorded");
        }
        if (keys.length === 0 && boxes.length > 0) throw new Error("detection scan results have no tiles");
        for (const key of keys) this.covered.add(key);
        this.storedBoxes.push(...boxes);
    }
}

/** Bounded to the current frame. Use an independent instance for each detector
 * kind; reverse passes reuse the caller's saved observations, not inference. */
export class DetectionScanCache {
    private current: DetectionScanEntry | null = null;

    entryFor(contentSec: number): DetectionScanEntry {
        if (!Number.isFinite(contentSec)) throw new Error("detection scan timestamp is invalid");
        if (this.current?.contentSec !== contentSec) this.current = new DetectionScanEntry(contentSec);
        return this.current;
    }
}

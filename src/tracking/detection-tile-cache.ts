import { type TileRect, tileRects } from "./detect-common.js";

/** Share detector tile geometry for the current decoded dimensions.
 * A single source track can change resolution or display orientation. Retain
 * only the latest grid; earlier scan results own their separate tile coverage. */
export class DetectionTileCache {
    private width = 0;
    private height = 0;
    private tiles: TileRect[] = [];

    forFrame(width: number, height: number): readonly TileRect[] {
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
            throw new Error("detection frame dimensions are invalid");
        }
        if (width !== this.width || height !== this.height) {
            this.tiles = tileRects(width, height);
            this.width = width;
            this.height = height;
        }
        return this.tiles;
    }
}

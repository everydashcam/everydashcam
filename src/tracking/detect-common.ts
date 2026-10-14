// Shared plumbing for the frame detectors (plate-detector.ts, face-detector.ts):
// tile geometry, letterboxing into a fixed square model input, and IoU-greedy
// suppression of overlapping boxes. Pure canvas/math, no ort - unit-testable.
//
// Why tiles: a dashcam frame letterboxed whole into a 512/640 input destroys
// small objects (a readable 86 px plate on 4K becomes 11 px - invisible to the
// model; measured in private/research/plate-detector-spike). Each tile
// is letterboxed separately, detections are remapped to frame pixels and then
// deduped across the overlap seams.

/** One detection in FRAME pixels (not model-input pixels). */
export interface RawDetection {
    x: number;
    y: number;
    w: number;
    h: number;
    /** Model confidence 0..1. */
    score: number;
}

/** Tile side that keeps small-object detectability: ~2.5x downscale into a 512
 *  input matched the measured detection floor (~31-62 px native on 4K, below
 *  the ~60-80 px readability threshold). 4K -> 3x3, 2.5K/1080p -> 2x2, SD -> 1. */
const TILE_NATIVE_SPAN_PX = 1280;

/** Neighbor tiles overlap by this fraction of their span so an object sitting
 *  on a seam is fully inside at least one tile. */
export const TILE_OVERLAP_FRAC = 0.1;

/** Tiles per axis, preserving native detail in either frame orientation. */
export function tileGridSize(frameW: number, frameH: number): number {
    const span = Math.max(frameW, frameH);
    if (!(span > 0) || !Number.isFinite(span)) return 1;
    return Math.max(1, Math.ceil(span / TILE_NATIVE_SPAN_PX));
}

export interface TileRect {
    sx: number;
    sy: number;
    sw: number;
    sh: number;
}

/** Overlapping n x n tile rects covering the frame (n = tileGridSize). */
export function tileRects(frameW: number, frameH: number): TileRect[] {
    const n = tileGridSize(frameW, frameH);
    const tw = frameW / n;
    const th = frameH / n;
    const ox = Math.round(tw * TILE_OVERLAP_FRAC);
    const oy = Math.round(th * TILE_OVERLAP_FRAC);
    const out: TileRect[] = [];
    for (let ty = 0; ty < n; ty++) {
        for (let tx = 0; tx < n; tx++) {
            const sx = Math.max(0, tx * tw - ox);
            const sy = Math.max(0, ty * th - oy);
            out.push({
                sx,
                sy,
                sw: Math.min(frameW - sx, tw + 2 * ox),
                sh: Math.min(frameH - sy, th + 2 * oy),
            });
        }
    }
    return out;
}

export interface LetterboxMap {
    /** source px -> input px scale. */
    scale: number;
    /** Content offset inside the input (0 when top-left anchored). */
    dx: number;
    dy: number;
}

/**
 * Draws source rect (sx,sy,sw,sh) into the square `size` canvas `scratch`,
 * aspect-preserving, padded with `fill`. `centered` matches each model's
 * training-time letterbox (YOLO centers on 114-gray; YuNet/OpenCV anchors
 * top-left on black). Returns the remap of input px back to source px.
 */
export function letterboxInto(
    scratch: OffscreenCanvas,
    source: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    size: number,
    fill: string,
    centered: boolean,
): LetterboxMap {
    // Assigning either dimension resets the backing store and the 2D context.
    // Detector inputs have a fixed shape, so avoid doing that for every tile.
    if (scratch.width !== size) scratch.width = size;
    if (scratch.height !== size) scratch.height = size;
    const ctx = scratch.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("detect: letterbox canvas ctx unavailable");
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, size, size);
    const scale = Math.min(size / sw, size / sh);
    const dw = Math.round(sw * scale);
    const dh = Math.round(sh * scale);
    const dx = centered ? Math.trunc((size - dw) / 2) : 0;
    const dy = centered ? Math.trunc((size - dh) / 2) : 0;
    ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
    return { scale, dx, dy };
}

/** Packs RGBA pixels into normalized RGB CHW planes. `target` must hold
 *  exactly three floats per source pixel. Kept here so both YOLO detectors use
 *  the same allocation-free hot-path implementation. */
export function packRgbPlanarNormalized(rgba: Uint8ClampedArray, target: Float32Array): void {
    const n = rgba.length / 4;
    for (let i = 0; i < n; i++) {
        target[i] = rgba[i * 4]! / 255;
        target[n + i] = rgba[i * 4 + 1]! / 255;
        target[2 * n + i] = rgba[i * 4 + 2]! / 255;
    }
}

/** Intersection-over-union of two frame-pixel boxes. */
export function iouOf(a: RawDetection, b: RawDetection): number {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
}

/** Preserve full score precision. Exact ties use geometry so processing tiles
 * in different batches cannot choose a different duplicate representative. */
function compareDetections(a: RawDetection, b: RawDetection): number {
    return b.score - a.score || a.x - b.x || a.y - b.y || a.w - b.w || a.h - b.h;
}

/** Conventional highest-score-first NMS within one tile. Raw model proposals
 * describe competing localizations of the same object, so lower-score
 * duplicates must not enlarge the box used to seed a tracker. */
export function suppressTileOverlaps(detections: readonly RawDetection[], iouThreshold: number): RawDetection[] {
    const sorted = [...detections].sort(compareDetections);
    const kept: RawDetection[] = [];
    for (const detection of sorted) {
        if (kept.some((other) => iouOf(other, detection) > iouThreshold)) continue;
        kept.push({ ...detection });
    }
    return kept;
}

/** Greedy cross-tile duplicate grouping. Preserve the full detected
 *  extent: a high-score box cropped at a tile seam must not hide the rest of a
 *  lower-score box. Match only against original representatives, so growing an
 *  envelope does not transitively absorb neighboring objects. */
export function suppressOverlaps(detections: readonly RawDetection[], iouThreshold: number): RawDetection[] {
    const sorted = [...detections].sort(compareDetections);
    const representatives: RawDetection[] = [];
    const kept: RawDetection[] = [];
    for (const d of sorted) {
        const duplicate = representatives.findIndex((k) => iouOf(k, d) > iouThreshold);
        if (duplicate < 0) {
            representatives.push(d);
            kept.push({ ...d });
            continue;
        }
        const envelope = kept[duplicate]!;
        const right = Math.max(envelope.x + envelope.w, d.x + d.w);
        const bottom = Math.max(envelope.y + envelope.h, d.y + d.h);
        envelope.x = Math.min(envelope.x, d.x);
        envelope.y = Math.min(envelope.y, d.y);
        envelope.w = right - envelope.x;
        envelope.h = bottom - envelope.y;
    }
    return kept;
}

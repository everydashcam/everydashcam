// Frame composition: draw one camera (drawMain, with optional crop) or several
// laid out by the camera layout engine (drawCameraComposition), plus the
// backdrop and privacy patches, on an OffscreenCanvas. Pure functions - no
// internal state, everything through arguments, so the editor preview can
// reuse them on a live canvas.
//
// Crops use normalized visible-image coordinates (after camera reflection).
// Privacy masks use normalized source coordinates. Layout tiles and drawing
// use output pixels (outputW × outputH).

import { type CameraFlip, applyCanvasFlip, flipCropRect, flipPixelRect } from "../camera-flip.js";
import type { VideoSample } from "mediabunny";

import type { ResolvedRegionBlur } from "../blur-regions.js";
import type { CameraTileLayout, LayoutRect } from "../camera-layout.js";
import type { Channel } from "../parsers/types.js";

import { roundRectPath } from "./canvas-draw.js";

/**
 * A decoded picture a composition draws. The export passes mediabunny's
 * VideoSample, which already has this shape; the still capture wraps a playing
 * <video>. Only what the drawing needs, so the composition does not depend on
 * where the picture was decoded.
 */
export interface CompositionFrame {
    readonly displayWidth: number;
    readonly displayHeight: number;
    /** Pixel format, or null when unknown. A format carrying alpha ("...A")
     *  or an unknown one keeps the backdrop under the picture. */
    readonly format: string | null;
    draw(
        context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
        sx: number,
        sy: number,
        sWidth: number,
        sHeight: number,
        dx: number,
        dy: number,
        dWidth: number,
        dHeight: number,
    ): void;
}

/**
 * Source for the blur backdrop - anything `drawImage` can handle, or a
 * CompositionFrame (uses its own draw API). The pipeline passes VideoSample;
 * the UI preview passes ImageBitmap.
 */
export type BlurSource = CompositionFrame | ImageBitmap | HTMLCanvasElement | HTMLVideoElement | OffscreenCanvas;

function isCompositionFrame(source: BlurSource): source is CompositionFrame {
    return "displayWidth" in source && typeof (source as CompositionFrame).draw === "function";
}

/**
 * Pre-allocated canvases for the downscale-blur-upscale pipeline. Created
 * once per pipeline and reused across frames - new OffscreenCanvas is
 * non-trivially expensive; allocating one per frame is unacceptable.
 */
export interface BlurHelper {
    smallCanvas: OffscreenCanvas;
    smallCtx: OffscreenCanvasRenderingContext2D;
    blurCanvas: OffscreenCanvas;
    blurCtx: OffscreenCanvasRenderingContext2D;
}

/** Max downscale canvas size (along the larger source dimension). */
const BLUR_DOWNSCALE_MAX = 480;
/** Blur radius on the downscaled canvas. Visually ~32px at 1080p (factor ×4). */
const BLUR_RADIUS_PX = 8;

export function createBlurHelper(): BlurHelper {
    const smallCanvas = new OffscreenCanvas(BLUR_DOWNSCALE_MAX, BLUR_DOWNSCALE_MAX);
    const smallCtx = smallCanvas.getContext("2d", { alpha: false });
    if (!smallCtx) throw new Error("createBlurHelper: small canvas ctx unavailable");
    const blurCanvas = new OffscreenCanvas(BLUR_DOWNSCALE_MAX, BLUR_DOWNSCALE_MAX);
    const blurCtx = blurCanvas.getContext("2d", { alpha: false });
    if (!blurCtx) throw new Error("createBlurHelper: blur canvas ctx unavailable");
    return { smallCanvas, smallCtx, blurCanvas, blurCtx };
}

function drawBlurSource(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    source: BlurSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
): void {
    // A VideoSample draws itself (it handles rotation/PAR).
    // ImageBitmap / Canvas go through the standard drawImage.
    if (isCompositionFrame(source)) {
        source.draw(ctx, sx, sy, sw, sh, dx, dy, dw, dh);
    } else {
        ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
    }
}

/**
 * Fills a dest rect with a blurred cover-fit version of the source.
 * Pipeline: downscale (max 480 on the larger dimension) → blur via ctx.filter
 * → upscale into dest. At 1080p+ this costs <1ms per frame (vs 10ms+ for
 * a full-resolution blur).
 */
export function fillBlurredCover(
    destCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    source: BlurSource,
    sourceW: number,
    sourceH: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    helper: BlurHelper,
    censorRegions?: readonly ResolvedRegionBlur[] | null,
): void {
    if (sourceW <= 0 || sourceH <= 0) return;
    // 1. Downscale source into smallCanvas.
    const ratio = sourceW / sourceH;
    let dsW: number;
    let dsH: number;
    if (sourceW >= sourceH) {
        dsW = BLUR_DOWNSCALE_MAX;
        dsH = Math.max(2, Math.round(BLUR_DOWNSCALE_MAX / ratio));
    } else {
        dsH = BLUR_DOWNSCALE_MAX;
        dsW = Math.max(2, Math.round(BLUR_DOWNSCALE_MAX * ratio));
    }
    if (helper.smallCanvas.width !== dsW) helper.smallCanvas.width = dsW;
    if (helper.smallCanvas.height !== dsH) helper.smallCanvas.height = dsH;
    drawBlurSource(helper.smallCtx, source, 0, 0, sourceW, sourceH, 0, 0, dsW, dsH);
    // 1b. Black out privacy regions BEFORE the blur: the backdrop is a copy of
    // the whole frame, so without this the region content ships in the bars -
    // and on engines where ctx.filter is a silent no-op (Safari
    // OffscreenCanvas) it would ship nearly sharp. smallCanvas holds the full
    // frame, so normalized rects scale straight to its dimensions.
    if (censorRegions?.length) {
        helper.smallCtx.fillStyle = "#000";
        for (const region of censorRegions) {
            const patch = mapRegionRectToDest(region.rect, sourceW, sourceH, 0, 0, sourceW, sourceH, 0, 0, dsW, dsH);
            if (patch) helper.smallCtx.fillRect(patch.x, patch.y, patch.w, patch.h);
        }
    }
    // 2. Blur via ctx.filter onto a separate canvas (filter applies to the
    //    draw operation - cannot be applied in-place).
    if (helper.blurCanvas.width !== dsW) helper.blurCanvas.width = dsW;
    if (helper.blurCanvas.height !== dsH) helper.blurCanvas.height = dsH;
    // Resizing used to clear this backing store every frame. Keep that pixel
    // invariant when dimensions are unchanged so filtered transparent edges
    // cannot retain data from the previous source frame.
    helper.blurCtx.clearRect(0, 0, dsW, dsH);
    helper.blurCtx.filter = `blur(${BLUR_RADIUS_PX}px)`;
    helper.blurCtx.drawImage(helper.smallCanvas, 0, 0);
    helper.blurCtx.filter = "none";
    // 3. Upscale cover-fit into dest. Clip is required - cover can extend
    //    beyond dest boundaries (negative dx/dy).
    const cover = fitKeepAspectCover(dsW, dsH, dw, dh);
    destCtx.save();
    destCtx.beginPath();
    destCtx.rect(dx, dy, dw, dh);
    destCtx.clip();
    destCtx.drawImage(helper.blurCanvas, 0, 0, dsW, dsH, dx + cover.dx, dy + cover.dy, cover.dw, cover.dh);
    destCtx.restore();
}

/** Rectangle in normalized image coordinates (0..1). */
export interface CropRect {
    xPct: number;
    yPct: number;
    wPct: number;
    hPct: number;
}

// AspectId source of truth is in src/transcode/types.ts; re-exported here
// for convenience at compose call sites.
import { aspectRatio, ensureEven, type AspectId, type LetterboxFill } from "./types.js";
export type { AspectId };

/**
 * Center-crops the source to a target aspect: the largest centered CropRect of
 * `targetAspect` that fits inside sourceW×sourceH (full frame when the aspects
 * already match). The default render path letterboxes instead (crop=null), so
 * this serves the explicit "snap crop to a preset aspect" control in the crop
 * editor - see applyAspectPreset in src/ui/player-crop.ts.
 */
export function computeAutoCrop(sourceW: number, sourceH: number, targetAspect: AspectId): CropRect {
    const outAspectRatio = aspectRatio(targetAspect);
    const sourceRatio = sourceW / sourceH;
    if (Math.abs(outAspectRatio - sourceRatio) < 0.001) {
        return { xPct: 0, yPct: 0, wPct: 1, hPct: 1 };
    }
    if (sourceRatio > outAspectRatio) {
        // source wider than output - crop horizontally, center.
        const cropW = sourceH * outAspectRatio;
        const cropX = (sourceW - cropW) / 2;
        return { xPct: cropX / sourceW, yPct: 0, wPct: cropW / sourceW, hPct: 1 };
    }
    // source narrower than output - crop vertically.
    const cropH = sourceW / outAspectRatio;
    const cropY = (sourceH - cropH) / 2;
    return { xPct: 0, yPct: cropY / sourceH, wPct: 1, hPct: cropH / sourceH };
}

/**
 * Computes output dimensions: height is given, width derived from aspect ratio.
 * Both are rounded to even values (H.264 requirement).
 */
export function computeOutputSize(targetHeight: number, aspect: AspectId): { width: number; height: number } {
    const ratio = aspectRatio(aspect);
    const height = ensureEven(targetHeight);
    const width = ensureEven(Math.round(height * ratio));
    return { width, height };
}

/**
 * Cover-fit: dest is filled completely, src proportions are preserved, excess
 * is cropped on the opposite axis. Used for the blur backdrop (fill a slot
 * completely with a blurred frame, no bars). dx/dy may be negative (extends
 * beyond dst boundaries).
 */
export function fitKeepAspectCover(
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
): { dx: number; dy: number; dw: number; dh: number } {
    if (srcW <= 0 || srcH <= 0) return { dx: 0, dy: 0, dw: dstW, dh: dstH };
    const srcRatio = srcW / srcH;
    const dstRatio = dstW / dstH;
    if (srcRatio > dstRatio) {
        // src wider than dst - fit to height, excess on the sides is cropped.
        const dh = dstH;
        const dw = Math.round(dh * srcRatio);
        return { dx: Math.round((dstW - dw) / 2), dy: 0, dw, dh };
    }
    const dw = dstW;
    const dh = Math.round(dw / srcRatio);
    return { dx: 0, dy: Math.round((dstH - dh) / 2), dw, dh };
}

/**
 * Fits a source rect inside a dst rect with keep-aspect (letterbox or
 * pillarbox as needed). Returns the dest sub-rect that has the same aspect
 * as src. The caller is responsible for filling the bars between this rect
 * and the dst boundary with black or a blur backdrop.
 */
export function fitKeepAspect(
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
): { dx: number; dy: number; dw: number; dh: number } {
    if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) {
        return { dx: 0, dy: 0, dw: dstW, dh: dstH };
    }
    const srcRatio = srcW / srcH;
    const dstRatio = dstW / dstH;
    if (srcRatio > dstRatio) {
        // src wider than dst - fit to width, letterbox top/bottom.
        const dw = dstW;
        const dh = Math.round(dstW / srcRatio);
        return { dx: 0, dy: Math.round((dstH - dh) / 2), dw, dh };
    }
    // src narrower than dst (or equal) - fit to height, pillarbox on the sides.
    const dh = dstH;
    const dw = Math.round(dstH * srcRatio);
    return { dx: Math.round((dstW - dw) / 2), dy: 0, dw, dh };
}

/**
 * Render options for drawMain/drawCameraComposition. fill controls what fills
 * the letterbox bars (or the space around the cameras): "black" (default) -
 * plain fillRect;
 * "blur" + blurHelper - blurred cover copy of the source as backdrop.
 * If fill="blur" but no helper is provided, falls back to "black".
 * regionBlurHelper is required for painting privacy region blurs (pixelate /
 * soft-blur styles need a scratch canvas); without it regions fall back to
 * solid fill so a missing helper can never leak unredacted pixels.
 */
export interface RenderFillOpts {
    fill?: LetterboxFill;
    blurHelper?: BlurHelper | null;
    regionBlurHelper?: RegionBlurHelper | null;
}

// === Privacy region blurs (see src/blur-regions.ts for the track model) ===

interface RegionBlurSurface {
    canvas: OffscreenCanvas;
    ctx: OffscreenCanvasRenderingContext2D;
}

/** Exact-size scratch canvases retain sampling boundaries while avoiding a
 *  backing-store resize whenever consecutive masks use different grids. */
export interface RegionBlurHelper {
    surfaces: Map<string, RegionBlurSurface>;
    activeKey: string | null;
}

export function createRegionBlurHelper(): RegionBlurHelper {
    return { surfaces: new Map(), activeKey: null };
}

const REGION_BLUR_SURFACE_LIMIT = 64;

function regionBlurSurface(helper: RegionBlurHelper, cols: number, rows: number): RegionBlurSurface {
    const key = `${cols}x${rows}`;
    let surface = helper.surfaces.get(key);
    if (surface) {
        // Switching grids clears the old single-canvas backing store. Preserve
        // that behavior for transparent input without reallocating its pixels.
        if (key !== helper.activeKey) surface.ctx.clearRect(0, 0, cols, rows);
        helper.surfaces.delete(key);
    } else {
        if (helper.surfaces.size >= REGION_BLUR_SURFACE_LIMIT) {
            const oldest = helper.surfaces.keys().next().value!;
            surface = helper.surfaces.get(oldest)!;
            helper.surfaces.delete(oldest);
            surface.canvas.width = cols;
            surface.canvas.height = rows;
        } else {
            const canvas = new OffscreenCanvas(cols, rows);
            const ctx = canvas.getContext("2d", { alpha: false });
            if (!ctx) throw new Error("createRegionBlurHelper: scratch canvas ctx unavailable");
            surface = { canvas, ctx };
        }
        surface.ctx.imageSmoothingEnabled = true;
        surface.ctx.imageSmoothingQuality = "high";
    }
    helper.surfaces.set(key, surface);
    helper.activeKey = key;
    return surface;
}

/** Axis-aligned rect in destination pixels. */
export interface PxRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * Maps a region rect (normalized source coords) into destination pixels, given
 * the visible source view (sx/sy/sw/sh, source px - the crop window drawMain /
 * drawCameraComposition computed) and the dest rect that view was fitted into.
 * Returns null when the region does not intersect the visible view (fully
 * cropped away). The returned rect is clipped to the dest rect and rounded
 * OUTWARD (floor origin, ceil far edge) - a privacy patch must never undercover
 * the region by a rounding pixel.
 */
export function mapRegionRectToDest(
    region: CropRect,
    sourceW: number,
    sourceH: number,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
): PxRect | null {
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return null;
    const rx = region.xPct * sourceW;
    const ry = region.yPct * sourceH;
    const rw = region.wPct * sourceW;
    const rh = region.hPct * sourceH;
    // Region -> dest via the same linear map the video content took.
    const px = dx + ((rx - sx) / sw) * dw;
    const py = dy + ((ry - sy) / sh) * dh;
    const pw = (rw / sw) * dw;
    const ph = (rh / sh) * dh;
    // Clip to the dest rect (the part of the region outside the crop window is
    // not painted as video, so there is nothing to cover there).
    const x1 = Math.max(px, dx);
    const y1 = Math.max(py, dy);
    const x2 = Math.min(px + pw, dx + dw);
    const y2 = Math.min(py + ph, dy + dh);
    // Null only for an EMPTY intersection. A sub-pixel sliver still falls
    // through to floor/ceil and gets a >=1px cover - dropping it would ship
    // one anti-aliased column of the marked content unredacted.
    if (x2 <= x1 || y2 <= y1) return null;
    const x = Math.floor(x1);
    const y = Math.floor(y1);
    return { x, y, w: Math.ceil(x2) - x, h: Math.ceil(y2) - y };
}

/** Pixelate target: ~this many mosaic blocks along the region's smaller side.
 *  Coarse blocks are the point: a plate should span 2-3 blocks, a face a
 *  handful. NOT a cryptographic guarantee - published attacks recover finely
 *  pixelated text - which is why "fill" exists as the maximum-privacy option. */
const PIXELATE_BLOCKS_MIN_DIM = 6;

/**
 * Snaps a region rect OUTWARD to a mosaic grid anchored at the source frame
 * origin, then clips it to the visible view window [vx..vx+vw]x[vy..vy+vh]
 * (source px) and returns the VISIBLE rect plus the block-grid dims of that
 * visible part. Anchoring to the scene (not the box) matters: a grid glued to
 * a lerping box re-samples sub-block phases every frame - the classic
 * multi-frame reconstruction lever. Deriving cols/rows from the VISIBLE part
 * matters just as much: a grid sized for the full rect but painted over a
 * crop-clipped sliver collapses the block size toward 1px (near-identity
 * "mosaic") exactly where a plate slides past the crop edge. Returns null
 * when nothing of the region is visible.
 */
export function snapRegionToMosaicGrid(
    rect: CropRect,
    sourceW: number,
    sourceH: number,
    vx: number,
    vy: number,
    vw: number,
    vh: number,
): { rect: CropRect; cols: number; rows: number } | null {
    const rw = rect.wPct * sourceW;
    const rh = rect.hPct * sourceH;
    if (rw <= 0 || rh <= 0 || vw <= 0 || vh <= 0) return null;
    const block = Math.max(4, Math.min(rw, rh) / PIXELATE_BLOCKS_MIN_DIM);
    const x0 = Math.max(Math.floor((rect.xPct * sourceW) / block) * block, vx);
    const y0 = Math.max(Math.floor((rect.yPct * sourceH) / block) * block, vy);
    const x1 = Math.min(Math.ceil((rect.xPct * sourceW + rw) / block) * block, vx + vw);
    const y1 = Math.min(Math.ceil((rect.yPct * sourceH + rh) / block) * block, vy + vh);
    if (x1 <= x0 || y1 <= y0) return null;
    return {
        rect: { xPct: x0 / sourceW, yPct: y0 / sourceH, wPct: (x1 - x0) / sourceW, hPct: (y1 - y0) / sourceH },
        cols: Math.max(1, Math.round((x1 - x0) / block)),
        rows: Math.max(1, Math.round((y1 - y0) / block)),
    };
}
/** Soft blur retains more samples than mosaic, then smooths their edges. */
const SOFT_BLUR_SAMPLES_MIN_DIM = 12;

/** Source-relative sampling keeps soft blur equally strong in preview and
 *  export. Crop clipping retains the original block size, so a narrow visible
 *  sliver cannot become a finely sampled strip. */
export function softBlurRegionGrid(
    rect: CropRect,
    sourceW: number,
    sourceH: number,
    vx: number,
    vy: number,
    vw: number,
    vh: number,
): { rect: CropRect; cols: number; rows: number } | null {
    const rw = rect.wPct * sourceW;
    const rh = rect.hPct * sourceH;
    if (rw <= 0 || rh <= 0 || vw <= 0 || vh <= 0) return null;
    const block = Math.max(2, Math.min(rw, rh) / SOFT_BLUR_SAMPLES_MIN_DIM);
    const x0 = Math.max(rect.xPct * sourceW, vx);
    const y0 = Math.max(rect.yPct * sourceH, vy);
    const x1 = Math.min(rect.xPct * sourceW + rw, vx + vw);
    const y1 = Math.min(rect.yPct * sourceH + rh, vy + vh);
    if (x1 <= x0 || y1 <= y0) return null;
    return {
        rect: { xPct: x0 / sourceW, yPct: y0 / sourceH, wPct: (x1 - x0) / sourceW, hPct: (y1 - y0) / sourceH },
        cols: Math.max(1, Math.round((x1 - x0) / block)),
        rows: Math.max(1, Math.round((y1 - y0) / block)),
    };
}

/**
 * Paints one region patch onto destCtx. `source` provides the pixels to
 * pixelate/soft-blur and `srcRect` locates the patch inside it - the export
 * pipeline passes the composed output canvas itself (srcRect === destRect),
 * the live preview passes the <video> element with a video-pixel rect.
 * "fill" ignores the source entirely. Restores ctx smoothing state.
 * grid (optional) - source-relative sampling dims from snapRegionToMosaicGrid
 * or softBlurRegionGrid; without it the grid derives from destRect.
 */
export function paintRegionBlur(
    destCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    source: CanvasImageSource,
    srcRect: PxRect,
    destRect: PxRect,
    style: ResolvedRegionBlur["style"],
    helper: RegionBlurHelper | null,
    grid?: { cols: number; rows: number },
): void {
    if (destRect.w < 1 || destRect.h < 1) return;
    if (style === "fill" || !helper) {
        destCtx.fillStyle = "#000";
        destCtx.fillRect(destRect.x, destRect.y, destRect.w, destRect.h);
        return;
    }
    let cols: number;
    let rows: number;
    if (grid) {
        cols = grid.cols;
        rows = grid.rows;
    } else if (style === "pixelate") {
        const blockPx = Math.max(4, Math.min(destRect.w, destRect.h) / PIXELATE_BLOCKS_MIN_DIM);
        cols = Math.max(1, Math.round(destRect.w / blockPx));
        rows = Math.max(1, Math.round(destRect.h / blockPx));
    } else {
        const blockPx = Math.min(destRect.w, destRect.h) / SOFT_BLUR_SAMPLES_MIN_DIM;
        cols = Math.max(1, Math.round(destRect.w / blockPx));
        rows = Math.max(1, Math.round(destRect.h / blockPx));
    }
    const { canvas: scratchCanvas, ctx: scratchCtx } = regionBlurSurface(helper, cols, rows);
    // Downscale with smoothing ON: each scratch pixel box-averages its block.
    scratchCtx.drawImage(source, srcRect.x, srcRect.y, srcRect.w, srcRect.h, 0, 0, cols, rows);
    const prevSmoothing = destCtx.imageSmoothingEnabled;
    // Upscale: pixelate keeps hard block edges (smoothing off); soft-blur
    // re-smooths for the blurred look.
    destCtx.imageSmoothingEnabled = style !== "pixelate";
    destCtx.drawImage(scratchCanvas, 0, 0, cols, rows, destRect.x, destRect.y, destRect.w, destRect.h);
    destCtx.imageSmoothingEnabled = prevSmoothing;
}

/**
 * Maps + paints resolved region blurs for one drawn view. Samples pixels from
 * the destination canvas itself (the video layer was just drawn there), so it
 * must run right after the sample draw and before overlays/watermark.
 * Exported for the frame-capture path (player-capture), which draws the raw
 * source frame onto its own canvas and paints the same patches with an
 * identity view (full frame -> full canvas).
 */
export function paintRegionBlursForView(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    regionBlurs: readonly ResolvedRegionBlur[],
    sourceW: number,
    sourceH: number,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    helper: RegionBlurHelper | null,
    flip?: Readonly<CameraFlip>,
): void {
    for (const rb of regionBlurs) {
        if (rb.style !== "fill") {
            const snapped =
                rb.style === "pixelate"
                    ? snapRegionToMosaicGrid(rb.rect, sourceW, sourceH, sx, sy, sw, sh)
                    : softBlurRegionGrid(rb.rect, sourceW, sourceH, sx, sy, sw, sh);
            if (!snapped) continue;
            let patch = mapRegionRectToDest(snapped.rect, sourceW, sourceH, sx, sy, sw, sh, dx, dy, dw, dh);
            if (!patch) continue;
            patch = flipPixelRect(patch, { x: dx, y: dy, w: dw, h: dh }, flip);
            paintRegionBlur(ctx, ctx.canvas, patch, patch, rb.style, helper, {
                cols: snapped.cols,
                rows: snapped.rows,
            });
            continue;
        }
        let patch = mapRegionRectToDest(rb.rect, sourceW, sourceH, sx, sy, sw, sh, dx, dy, dw, dh);
        if (!patch) continue;
        patch = flipPixelRect(patch, { x: dx, y: dy, w: dw, h: dh }, flip);
        paintRegionBlur(ctx, ctx.canvas, patch, patch, rb.style, helper);
    }
}

/**
 * Fills a dest rect per opts: blurs the source if fill="blur" and helper is
 * available, otherwise fills with black. Called by drawMain before the fit
 * draw.
 */
function fillBackdrop(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    source: BlurSource | null,
    sourceW: number,
    sourceH: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    opts: RenderFillOpts | undefined,
    censorRegions?: readonly ResolvedRegionBlur[] | null,
): void {
    if (opts?.fill === "blur" && opts.blurHelper && source) {
        fillBlurredCover(ctx, source, sourceW, sourceH, dx, dy, dw, dh, opts.blurHelper, censorRegions);
        return;
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(dx, dy, dw, dh);
}

/**
 * True when the fitted draw is guaranteed to overpaint every pixel of the
 * output, so the backdrop underneath it can never show through: the fit rect
 * covers the frame exactly AND the source pixels are opaque. `sampleFormat` is
 * the VideoSample pixel format - one carrying alpha ("...A") would blend with
 * whatever the previous frame left on the reused canvas, so it keeps the
 * backdrop; an unknown (null) format is treated as possibly-transparent for the
 * same reason.
 */
export function fitHidesBackdrop(
    fit: { dx: number; dy: number; dw: number; dh: number },
    outputW: number,
    outputH: number,
    sampleFormat: string | null,
): boolean {
    if (fit.dx !== 0 || fit.dy !== 0 || fit.dw !== outputW || fit.dh !== outputH) return false;
    return sampleFormat !== null && !sampleFormat.includes("A");
}

/**
 * Draws the main sample onto ctx. crop=null - fits the full source frame into
 * output; crop set - fits the selected zone. Both cases use keep-aspect-fit:
 * if the selected zone's aspect differs from the output aspect, letterbox bars
 * are filled via fillBackdrop according to opts.fill.
 *
 * regionBlurs (optional) - privacy patches painted over the video layer right
 * after the sample draw, before the caller's overlays/watermark.
 *
 * VideoSample.draw handles rotation/pixelAspectRatio metadata internally.
 */
export function drawMain(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    sample: VideoSample,
    crop: CropRect | null,
    outputW: number,
    outputH: number,
    opts?: RenderFillOpts,
    regionBlurs?: readonly ResolvedRegionBlur[] | null,
    flip?: Readonly<CameraFlip>,
): void {
    if (crop) crop = flipCropRect(crop, flip);
    const sourceW = sample.displayWidth;
    const sourceH = sample.displayHeight;
    let sx: number;
    let sy: number;
    let sw: number;
    let sh: number;
    if (crop) {
        sx = Math.max(0, Math.round(crop.xPct * sourceW));
        sy = Math.max(0, Math.round(crop.yPct * sourceH));
        sw = Math.min(sourceW - sx, Math.round(crop.wPct * sourceW));
        sh = Math.min(sourceH - sy, Math.round(crop.hPct * sourceH));
    } else {
        sx = 0;
        sy = 0;
        sw = sourceW;
        sh = sourceH;
    }
    const fit = fitKeepAspect(sw, sh, outputW, outputH);
    // The backdrop exists for the letterbox bars only. On a same-aspect export
    // (the common 16:9 source -> 16:9 output) the fit covers the frame, so both
    // the full-canvas black fill and the far pricier blurred cover would be
    // overpainted whole - on every frame of the run.
    ctx.save();
    applyCanvasFlip(ctx, { x: 0, y: 0, w: outputW, h: outputH }, flip);
    if (!fitHidesBackdrop(fit, outputW, outputH, sample.format)) {
        fillBackdrop(ctx, sample, sourceW, sourceH, 0, 0, outputW, outputH, opts, regionBlurs);
    }
    sample.draw(ctx, sx, sy, sw, sh, fit.dx, fit.dy, fit.dw, fit.dh);
    ctx.restore();
    if (regionBlurs?.length) {
        const dest = flipPixelRect(
            { x: fit.dx, y: fit.dy, w: fit.dw, h: fit.dh },
            { x: 0, y: 0, w: outputW, h: outputH },
            flip,
        );
        paintRegionBlursForView(
            ctx,
            regionBlurs,
            sourceW,
            sourceH,
            sx,
            sy,
            sw,
            sh,
            dest.x,
            dest.y,
            fit.dw,
            fit.dh,
            opts?.regionBlurHelper ?? null,
            flip,
        );
    }
}

/**
 * Effective aspect of a camera's picture after applying crop. Without crop -
 * source aspect. With crop - aspect of the selected zone in source pixels:
 * (cropW / cropH) = (cropPct.w * srcW) / (cropPct.h * srcH) =
 * (cropPct.w / cropPct.h) * srcAspect.
 */
export function computeEffectiveAspect(sourceAspect: number, crop: CropRect | null): number {
    if (!crop || crop.hPct <= 0) return sourceAspect;
    return (crop.wPct / crop.hPct) * sourceAspect;
}

/** Corner radius of a camera window over the main one, as a share of the
 *  window's smaller side. The editor preview rounds its windows the same. */
export const OVERLAY_CORNER_SHARE = 0.08;

/** What one camera contributes to a composed frame. */
export interface CompositionCamera {
    /** The picture to show, or null for a black tile (no footage now, or no
     *  frame decoded yet). */
    sample: CompositionFrame | null;
    crop: CropRect | null;
    flip?: Readonly<CameraFlip>;
    regionBlurs: readonly ResolvedRegionBlur[] | null;
}

/** Pixel rectangle of a layout tile, snapped so neighbours share edges. */
function tilePixels(tile: LayoutRect): PxRect {
    const x = Math.round(tile.x);
    const y = Math.round(tile.y);
    return { x, y, w: Math.max(2, Math.round(tile.x + tile.w) - x), h: Math.max(2, Math.round(tile.y + tile.h) - y) };
}

/**
 * Draws one multi-camera frame. The background is black, or with a blurred
 * letterbox the backdrop camera blurred over the whole frame, so the empty
 * space around the tiles carries the picture rather than bars. Every tile then
 * shows its camera's crop, fitted (the engine already gave each tile the
 * picture's shape); a camera without a picture is a black tile. Windows over
 * the main camera get rounded corners. Privacy patches go over every picture
 * and are censored out of the blurred background too.
 */
export function drawCameraComposition(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    tiles: readonly CameraTileLayout[],
    cameras: Partial<Record<Channel, CompositionCamera>>,
    backdrop: Channel | null,
    outputW: number,
    outputH: number,
    opts?: RenderFillOpts,
): void {
    const main = tiles[0] ? cameras[tiles[0].channel] : undefined;
    const mainRect = tiles[0] ? tilePixels(tiles[0]) : null;
    const mainCovers =
        !!main?.sample &&
        !!mainRect &&
        fitHidesBackdrop(
            { dx: mainRect.x, dy: mainRect.y, dw: mainRect.w, dh: mainRect.h },
            outputW,
            outputH,
            main.sample.format,
        );
    if (!mainCovers) {
        const back = backdrop ? cameras[backdrop] : undefined;
        if (opts?.fill === "blur" && opts.blurHelper && back?.sample) {
            ctx.save();
            applyCanvasFlip(ctx, { x: 0, y: 0, w: outputW, h: outputH }, back.flip);
            const s = back.sample;
            fillBlurredCover(
                ctx,
                s,
                s.displayWidth,
                s.displayHeight,
                0,
                0,
                outputW,
                outputH,
                opts.blurHelper,
                back.regionBlurs,
            );
            ctx.restore();
        } else {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, outputW, outputH);
        }
    }
    for (const tile of tiles) {
        const { x: dx, y: dy, w: dw, h: dh } = tilePixels(tile);
        const camera = cameras[tile.channel];
        ctx.save();
        if (tile.overlay) {
            roundRectPath(ctx, dx, dy, dw, dh, Math.round(Math.min(dw, dh) * OVERLAY_CORNER_SHARE));
            ctx.clip();
        }
        const sample = camera?.sample;
        if (!camera || !sample) {
            ctx.fillStyle = "#000";
            ctx.fillRect(dx, dy, dw, dh);
            ctx.restore();
            continue;
        }
        const sourceW = sample.displayWidth;
        const sourceH = sample.displayHeight;
        const crop = camera.crop ? flipCropRect(camera.crop, camera.flip) : null;
        const sx = crop ? Math.max(0, Math.round(crop.xPct * sourceW)) : 0;
        const sy = crop ? Math.max(0, Math.round(crop.yPct * sourceH)) : 0;
        const sw = crop ? Math.min(sourceW - sx, Math.round(crop.wPct * sourceW)) : sourceW;
        const sh = crop ? Math.min(sourceH - sy, Math.round(crop.hPct * sourceH)) : sourceH;
        const fit = fitKeepAspect(sw, sh, dw, dh);
        const drawX = dx + fit.dx;
        const drawY = dy + fit.dy;
        ctx.save();
        applyCanvasFlip(ctx, { x: dx, y: dy, w: dw, h: dh }, camera.flip);
        // Rounding can leave a hairline between the fitted picture and its
        // tile; black keeps it from showing the background through.
        if (!fitHidesBackdrop(fit, dw, dh, sample.format)) {
            ctx.fillStyle = "#000";
            ctx.fillRect(dx, dy, dw, dh);
        }
        sample.draw(ctx, sx, sy, sw, sh, drawX, drawY, fit.dw, fit.dh);
        ctx.restore();
        if (camera.regionBlurs?.length) {
            const dest = flipPixelRect(
                { x: drawX, y: drawY, w: fit.dw, h: fit.dh },
                { x: dx, y: dy, w: dw, h: dh },
                camera.flip,
            );
            paintRegionBlursForView(
                ctx,
                camera.regionBlurs,
                sourceW,
                sourceH,
                sx,
                sy,
                sw,
                sh,
                dest.x,
                dest.y,
                fit.dw,
                fit.dh,
                opts?.regionBlurHelper ?? null,
                camera.flip,
            );
        }
        ctx.restore();
    }
}

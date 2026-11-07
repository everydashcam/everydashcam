// Map overlay drawing for the transcode pipeline. Given a rendered map
// ImageBitmap (produced by the main-thread snapshotter) and the user-controlled
// placement / scale, this module paints it onto the composite canvas. The slot
// has NO hard border: its edges feather to transparent so the map dissolves
// into the video instead of reading as a bordered inset box. The live preview
// (player-composition.css, .player-map-overlay__canvas) mirrors this feather
// with a CSS mask - keep the two in sync (MAP_FEATHER_FRAC below).

import { clamp, drawNoFixIcon } from "./canvas-draw.js";
import type { MapShape } from "./types.js";

export interface MapOverlayDrawOpts {
    /** Top-left anchor, fraction of frame width. */
    xPct: number;
    /** Top-left anchor, fraction of frame height. */
    yPct: number;
    /** Percentage of the base width. 100 = default slot size (MAP_BASE_WIDTH_PCT). */
    scalePct: number;
    /** Clip shape. "rect" keeps the rounded rectangle; "circle" reshapes the
     *  slot. The map image itself is unchanged - only the clip and border differ. */
    shape: MapShape;
}

/** Default slot width at scalePct=100, fraction of output frame width. Matches
 *  the value used in export-modal-preview.ts so preview and export agree. */
export const MAP_BASE_WIDTH_PCT = 0.25;
/** Slot aspect (width/height), mirroring the mini-map proportions. */
export const MAP_SLOT_ASPECT = 4 / 3;

/** Shared output-pixel geometry for the preview, snapshot, and no-fix plate. */
export function mapOverlayRect(
    frameWidth: number,
    frameHeight: number,
    opts: MapOverlayDrawOpts,
): { x: number; y: number; width: number; height: number } {
    const scale = clamp(opts.scalePct, 50, 200) / 100;
    const width = Math.max(40, Math.round(frameWidth * MAP_BASE_WIDTH_PCT * scale));
    const height = opts.shape === "circle" ? width : Math.max(30, Math.round(width / MAP_SLOT_ASPECT));
    const x = clamp(clamp(opts.xPct, 0, 1) * frameWidth, 0, Math.max(0, frameWidth - width));
    const y = clamp(clamp(opts.yPct, 0, 1) * frameHeight, 0, Math.max(0, frameHeight - height));
    return { x, y, width, height };
}

/** Edge-feather band as a fraction of the slot dimension (rect) - the map fades
 *  to transparent over this band on each side. Small + smoothstep-shaped so the
 *  dissolve is gentle with no hard threshold. Kept in sync with the CSS preview
 *  mask in player-composition.css (--map-feather). */
const MAP_FEATHER_FRAC = 0.08;
/** Circle rim feather as a fraction of the radius (the outer band that fades). */
const MAP_FEATHER_CIRCLE_FRAC = 0.16;
/** Substops used to approximate the smoothstep ramp in a (piecewise-linear)
 *  canvas gradient. More stops = closer to a true ease, no visible banding. */
const FEATHER_SUBSTOPS = 6;

/** smoothstep(0..1): 0 and 1 with zero slope at both ends, so where the ramp
 *  meets the solid core there is no derivative jump (the "threshold" a linear
 *  ramp shows). */
function smoothstep(t: number): number {
    return t * t * (3 - 2 * t);
}

/** Adds smoothstep alpha stops to a feather gradient: a rising ramp over the
 *  first `band` of the [0,1] axis and a mirrored falling ramp over the last
 *  `band`; the middle stays solid (no stop, so the gradient holds 1). */
function addAxisFeatherStops(grad: CanvasGradient, band: number): void {
    for (let i = 0; i <= FEATHER_SUBSTOPS; i++) {
        const t = i / FEATHER_SUBSTOPS;
        const a = smoothstep(t);
        grad.addColorStop(t * band, `rgba(0,0,0,${a})`);
        grad.addColorStop(1 - band + t * band, `rgba(0,0,0,${smoothstep(1 - t)})`);
    }
}

// Reused scratch canvas for the feather pass. destination-in masks the WHOLE
// target context, so the slot must be composited in isolation before being
// drawn onto the shared frame - otherwise the mask would erase everything
// outside the slot. One allocation per slot-size, reused across frames.
let featherScratch: OffscreenCanvas | null = null;
let featherCtx: OffscreenCanvasRenderingContext2D | null = null;

function getScratch(w: number, h: number): OffscreenCanvasRenderingContext2D | null {
    if (!featherScratch || featherScratch.width !== w || featherScratch.height !== h) {
        featherScratch = new OffscreenCanvas(w, h);
        featherCtx = featherScratch.getContext("2d");
    } else if (featherCtx) {
        featherCtx.clearRect(0, 0, w, h);
    }
    return featherCtx;
}

/** Multiplies the scratch alpha by an edge-feather mask (destination-in), so the
 *  already-drawn map fades to transparent at the slot edges. */
function featherEdges(sctx: OffscreenCanvasRenderingContext2D, w: number, h: number, shape: MapShape): void {
    sctx.save();
    sctx.globalCompositeOperation = "destination-in";
    if (shape === "circle") {
        const r = Math.min(w, h) / 2;
        const band = MAP_FEATHER_CIRCLE_FRAC;
        const g = sctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, r);
        g.addColorStop(0, "rgba(0,0,0,1)"); // solid core
        for (let i = 0; i <= FEATHER_SUBSTOPS; i++) {
            const t = i / FEATHER_SUBSTOPS;
            g.addColorStop(1 - band + t * band, `rgba(0,0,0,${smoothstep(1 - t)})`);
        }
        sctx.fillStyle = g;
        sctx.fillRect(0, 0, w, h);
    } else {
        // Two passes (x then y); destination-in multiplies, so the result is the
        // product of both axes - opaque centre, smoothstep-feathered edges.
        const gx = sctx.createLinearGradient(0, 0, w, 0);
        addAxisFeatherStops(gx, MAP_FEATHER_FRAC);
        sctx.fillStyle = gx;
        sctx.fillRect(0, 0, w, h);
        const gy = sctx.createLinearGradient(0, 0, 0, h);
        addAxisFeatherStops(gy, MAP_FEATHER_FRAC);
        sctx.fillStyle = gy;
        sctx.fillRect(0, 0, w, h);
    }
    sctx.restore();
}

/**
 * Draws the map snapshot onto ctx at the configured slot position, feathered so
 * its edges dissolve into the video (no border, no hard clip). The map is
 * cover-fit (center-crop) into the slot on an isolated scratch canvas, masked
 * with featherEdges, then composited onto the frame.
 *
 * Heading-up ("game minimap") is delivered by the chase camera: the snapshotter
 * renders the map already rotated to heading, so the slot needs no rotation -
 * the feather + cover-fit stay mode-agnostic.
 *
 * Position is clamped so the slot stays inside the frame even when the user
 * dragged the preview close to the edge and bumped the scale slider up.
 *
 * The export passes a fresh snapshot; a still image of the export frame
 * passes the canvas the preview last painted.
 */
export function drawMapOverlay(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    bitmap: ImageBitmap | HTMLCanvasElement,
    frameWidth: number,
    frameHeight: number,
    opts: MapOverlayDrawOpts,
): void {
    const {
        x: xClamped,
        y: yClamped,
        width: widthPx,
        height: heightPx,
    } = mapOverlayRect(frameWidth, frameHeight, opts);

    // High-quality downscale: maplibre source is 640×480, slot is typically
    // 200-500 px wide. Default smoothing is bilinear - fine at this size.
    const src = coverFit(bitmap.width, bitmap.height, widthPx, heightPx);
    const sctx = getScratch(widthPx, heightPx);
    if (sctx) {
        sctx.imageSmoothingEnabled = true;
        sctx.imageSmoothingQuality = "high";
        sctx.drawImage(bitmap, src.sx, src.sy, src.sw, src.sh, 0, 0, widthPx, heightPx);
        featherEdges(sctx, widthPx, heightPx, opts.shape);
        ctx.drawImage(sctx.canvas, xClamped, yClamped);
        return;
    }
    // Degraded path (no scratch 2D context): draw hard-edged rather than nothing.
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, src.sx, src.sy, src.sw, src.sh, xClamped, yClamped, widthPx, heightPx);
    ctx.restore();
}

/**
 * No-fix placeholder for the map slot: the same geometry, feather, and shape as
 * drawMapOverlay, but a dark plate with the crossed-pin icon instead of a
 * snapshot - the receiver has no position to render, and freezing the last
 * snapshot would lie about where the car is. Same-slot geometry means the map
 * neither jumps nor pops when the fix returns.
 */
export function drawMapPlaceholder(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    frameWidth: number,
    frameHeight: number,
    opts: MapOverlayDrawOpts,
): void {
    const {
        x: xClamped,
        y: yClamped,
        width: widthPx,
        height: heightPx,
    } = mapOverlayRect(frameWidth, frameHeight, opts);

    const iconPx = Math.min(widthPx, heightPx) * 0.36;
    const sctx = getScratch(widthPx, heightPx);
    if (sctx) {
        sctx.fillStyle = "rgba(16, 20, 24, 0.85)";
        sctx.fillRect(0, 0, widthPx, heightPx);
        drawNoFixIcon(sctx, widthPx / 2, heightPx / 2, iconPx, "rgba(255,255,255,0.6)");
        featherEdges(sctx, widthPx, heightPx, opts.shape);
        ctx.drawImage(sctx.canvas, xClamped, yClamped);
        return;
    }
    // Degraded path (no scratch 2D context): hard-edged plate, like drawMapOverlay.
    ctx.save();
    ctx.fillStyle = "rgba(16, 20, 24, 0.85)";
    ctx.fillRect(xClamped, yClamped, widthPx, heightPx);
    drawNoFixIcon(ctx, xClamped + widthPx / 2, yClamped + heightPx / 2, iconPx, "rgba(255,255,255,0.6)");
    ctx.restore();
}

/** Center-crop source rect so a (srcW×srcH) image fills a (dstW×dstH) slot
 *  without distortion (the excess axis is cropped equally on both sides). */
function coverFit(
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
): { sx: number; sy: number; sw: number; sh: number } {
    if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return { sx: 0, sy: 0, sw: srcW, sh: srcH };
    const srcAspect = srcW / srcH;
    const dstAspect = dstW / dstH;
    if (srcAspect > dstAspect) {
        // source too wide: crop width
        const sw = srcH * dstAspect;
        return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
    }
    // source too tall: crop height
    const sh = srcW / dstAspect;
    return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}

// Test-only surface for the pure geometry that has no canvas dependency. The
// widgets themselves are pixel-tested only by the (local, non-CI) VRT suite, so
// the math that positions them is worth a headless unit lock.
export const _internal = { coverFit };

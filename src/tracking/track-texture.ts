import type { TrackBox } from "./track-guards.js";
import {
    buildAppearanceSample,
    type AppearanceSample,
    REFERENCE_EDGE_ENERGY_MIN,
    REFERENCE_VARIANCE_MIN,
} from "./track-appearance.js";
import { drawTrackingFrame, type TrackingFrame } from "./tracking-frame.js";

export const TRACK_TEXTURE_SIZE = 32;
const MAX_VARIANCE_RATIO = 0.25;
const MAX_RELATIVE_EDGE_DENSITY = 0.5;
const MIN_VISIBLE_FRACTION = 0.9;

export interface TextureMoments {
    variance: number;
    edgeEnergy: number;
}

export interface TextureSample extends TextureMoments {
    visibleFraction: number;
    appearance?: AppearanceSample;
}

/** Squared luminance differences and variance scale together under a uniform
 * contrast change, letting the guard distinguish darkening from lost detail. */
export function measureTexture(rgba: ArrayLike<number>, width: number, height: number): TextureMoments {
    const count = width * height;
    if (rgba.length !== count * 4 || count < 1) throw new Error("invalid texture pixels");
    const luminance = new Float64Array(count);
    let mean = 0;
    for (let i = 0; i < count; i++) {
        const value = 0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!;
        luminance[i] = value;
        mean += value / count;
    }
    let variance = 0;
    let edgeEnergy = 0;
    let edgeCount = 0;
    for (let i = 0; i < count; i++) {
        variance += (luminance[i]! - mean) ** 2 / count;
        if ((i % width) + 1 < width) {
            edgeEnergy += (luminance[i + 1]! - luminance[i]!) ** 2;
            edgeCount++;
        }
        if (i + width < count) {
            edgeEnergy += (luminance[i + width]! - luminance[i]!) ** 2;
            edgeCount++;
        }
    }
    return { variance, edgeEnergy: edgeEnergy / Math.max(1, edgeCount) };
}

/** Measure the proposed object crop using the frame's display-coordinate draw path. */
export function captureTexture(
    ctx: OffscreenCanvasRenderingContext2D,
    frame: TrackingFrame,
    frameW: number,
    frameH: number,
    box: TrackBox,
    includeAppearance = true,
): TextureSample | null {
    if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0) return null;
    const visibleW = Math.max(0, Math.min(frameW, box.x + box.w) - Math.max(0, box.x));
    const visibleH = Math.max(0, Math.min(frameH, box.y + box.h) - Math.max(0, box.y));
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, TRACK_TEXTURE_SIZE, TRACK_TEXTURE_SIZE);
    drawTrackingFrame(ctx, frame, box.x, box.y, box.w, box.h, 0, 0, TRACK_TEXTURE_SIZE, TRACK_TEXTURE_SIZE);
    const rgba = ctx.getImageData(0, 0, TRACK_TEXTURE_SIZE, TRACK_TEXTURE_SIZE).data;
    return {
        ...measureTexture(rgba, TRACK_TEXTURE_SIZE, TRACK_TEXTURE_SIZE),
        visibleFraction: (visibleW * visibleH) / (box.w * box.h),
        appearance: includeAppearance
            ? buildAppearanceSample(rgba, TRACK_TEXTURE_SIZE, TRACK_TEXTURE_SIZE, {
                  x: Math.max(0, -box.x) / box.w,
                  y: Math.max(0, -box.y) / box.h,
                  w: visibleW / box.w,
                  h: visibleH / box.h,
              })
            : undefined,
    };
}

/** A fixed appearance reference. Only initializing a new track sets
 * it; accepting a prediction must never teach the guard to trust its mistakes.
 * This catches severe texture collapse, not general identity switches. */
export class TrackTextureReference {
    private seed: TextureSample | null = null;

    setSeed(sample: TextureSample | null): void {
        this.seed = sample ? { ...sample } : null;
    }

    /** Avoid a pixel read when the existing seed or visibility rules already
     * disable this guard. The rejection thresholds remain unchanged. */
    needsCapture(box: TrackBox, frameW: number, frameH: number): boolean {
        const seed = this.seed;
        if (
            !seed ||
            seed.variance < REFERENCE_VARIANCE_MIN ||
            seed.edgeEnergy < REFERENCE_EDGE_ENERGY_MIN ||
            seed.visibleFraction < MIN_VISIBLE_FRACTION ||
            ![box.x, box.y, box.w, box.h].every(Number.isFinite) ||
            box.w <= 0 ||
            box.h <= 0
        )
            return false;
        const visibleW = Math.max(0, Math.min(frameW, box.x + box.w) - Math.max(0, box.x));
        const visibleH = Math.max(0, Math.min(frameH, box.y + box.h) - Math.max(0, box.y));
        return (visibleW * visibleH) / (box.w * box.h) >= MIN_VISIBLE_FRACTION;
    }

    rejects(candidate: TextureSample | null): boolean {
        const seed = this.seed;
        if (
            !seed ||
            !candidate ||
            seed.variance < REFERENCE_VARIANCE_MIN ||
            seed.edgeEnergy < REFERENCE_EDGE_ENERGY_MIN ||
            seed.visibleFraction < MIN_VISIBLE_FRACTION ||
            candidate.visibleFraction < MIN_VISIBLE_FRACTION
        )
            return false;
        const varianceRatio = candidate.variance / seed.variance;
        const edgeRatio = candidate.edgeEnergy / seed.edgeEnergy;
        if (!Number.isFinite(varianceRatio) || !Number.isFinite(edgeRatio) || varianceRatio < 0 || edgeRatio < 0)
            return false;
        const relativeEdgeDensity = varianceRatio > 0 ? edgeRatio / varianceRatio : edgeRatio === 0 ? 0 : null;
        return (
            relativeEdgeDensity !== null &&
            Number.isFinite(relativeEdgeDensity) &&
            varianceRatio < MAX_VARIANCE_RATIO &&
            relativeEdgeDensity < MAX_RELATIVE_EDGE_DENSITY
        );
    }
}

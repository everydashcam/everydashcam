// Chooses the decode width for a tracking pass. The tracker's crops carry a
// fixed pixel budget (128 template / 256 search - see vittrack.ts), so what
// matters is how many REAL pixels the seed box spans: at the 854 base width a
// plate zone is a ~25x9 px featureless smudge the model cannot hold onto, while
// the source video has 2-4x more pixels on it. Small seeds therefore analyze at
// a higher decode width. Decode itself is native-res regardless (the width only
// scales the analysis canvas) and inference cost is unchanged (fixed crop
// sizes) - the price is canvas bandwidth, bounded by the cap below and by the
// single reused analysis canvas in tracker-worker.

import type { CropRect } from "../transcode/compose.js";

/** Base analysis width - large seeds need no more; the tracking spike's decode
 *  throughput numbers were measured at this size. */
export const ANALYSIS_BASE_WIDTH = 854;
/** Upper decode width. Beyond typical dashcam native (1080p) the per-frame
 *  canvas cost (8+ MB at 1080p, 4x that at 4K) outgrows what the fixed-size
 *  crops can use. */
export const ANALYSIS_WIDTH_CAP = 1920;
/** Target for sqrt(seedW * seedH) in analysis pixels. The template crop is
 *  2*sqrt(area) resized to 128, so 64 makes that resize lossless; boxes below
 *  it are upscaled mush. */
export const TARGET_SEED_SQRT_AREA_PX = 64;

/** Decode width for a pass tracking `seedRect` on a `displayW` x `displayH`
 *  source: the smallest width that gives the seed box its full crop resolution,
 *  clamped to [base, min(cap, native)]. Unknown display dims fall back to the
 *  base width (the pre-adaptive behavior). Returns an even integer - some
 *  decoders dislike odd surface widths. */
export function chooseAnalysisWidth(seedRect: CropRect, displayW: number, displayH: number): number {
    if (!(displayW > 0)) return ANALYSIS_BASE_WIDTH;
    // Seed sqrt-area at decode width X is sqrt(wPct*hPct*aspect)*X; solve for
    // the target. Unknown height assumes 16:9.
    const aspect = displayH > 0 ? displayH / displayW : 9 / 16;
    const sqrtAreaPerPx = Math.sqrt(Math.max(0, seedRect.wPct * seedRect.hPct) * aspect);
    const needed = sqrtAreaPerPx > 0 ? TARGET_SEED_SQRT_AREA_PX / sqrtAreaPerPx : ANALYSIS_WIDTH_CAP;
    const clamped = Math.min(Math.max(ANALYSIS_BASE_WIDTH, needed), ANALYSIS_WIDTH_CAP, displayW);
    return Math.floor(clamped / 2) * 2;
}

/** Analysis frame height for `width`, by mediabunny CanvasSink's rule for a
 *  missing height: the square-pixel display aspect after the track rotation,
 *  rounded to whole pixels. Follow tracking stays on that pixel grid. */
export function analysisFrameHeight(
    width: number,
    squarePixelWidth: number,
    squarePixelHeight: number,
    rotation: number,
): number {
    const [rotatedWidth, rotatedHeight] =
        rotation % 180 === 0 ? [squarePixelWidth, squarePixelHeight] : [squarePixelHeight, squarePixelWidth];
    return Math.round(width / (rotatedWidth / rotatedHeight));
}

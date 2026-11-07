// Size and camera placement of a still image. A still is drawn like one
// export frame (transcode/compose.ts drawCameraComposition): tiles in still
// pixels, each showing its camera's picture or a part of it. This module only
// decides the geometry; the capture (player-capture.ts) owns the pixels.
//
// DOM-free so the arithmetic is unit-tested in node.

import {
    type CameraLayout,
    type CameraLayoutRequest,
    type CameraTileLayout,
    computeCameraLayout,
    outputMinThumbHeight,
    scaleCameraLayout,
} from "../camera-layout.js";
import type { Channel } from "../parsers/types.js";

/** Largest canvas area a still may take. iOS Safari refuses larger canvases
 *  (the same ceiling the encoder probe respects); every engine accepts it. */
export const STILL_MAX_PIXELS = 16_777_216;
/** Longest canvas side every engine accepts. */
export const STILL_MAX_SIDE = 16_384;

export interface StillLayout {
    width: number;
    height: number;
    /** Tiles in still pixels, in paint order (the main camera first). */
    tiles: CameraTileLayout[];
}

/**
 * Factor that brings a `width` x `height` image within the canvas limits:
 * 1 when it already fits, smaller otherwise. Aspect ratio is kept.
 */
export function stillBudgetFactor(width: number, height: number): number {
    if (width <= 0 || height <= 0) return 1;
    return Math.min(1, Math.sqrt(STILL_MAX_PIXELS / (width * height)), STILL_MAX_SIDE / width, STILL_MAX_SIDE / height);
}

/**
 * Still of one camera picture, or of the `share` of it (fractions 0..1, e.g.
 * the part a zoomed tile shows), at the camera's own resolution. Never
 * upscales: a zoomed part keeps the pixels the recording has.
 */
export function singleCameraStill(
    channel: Channel,
    nativeWidth: number,
    nativeHeight: number,
    share: { w: number; h: number } = { w: 1, h: 1 },
): StillLayout {
    const fullWidth = nativeWidth * share.w;
    const fullHeight = nativeHeight * share.h;
    const factor = stillBudgetFactor(fullWidth, fullHeight);
    const width = Math.max(1, Math.round(fullWidth * factor));
    const height = Math.max(1, Math.round(fullHeight * factor));
    return { width, height, tiles: [{ channel, role: "equal", overlay: false, x: 0, y: 0, w: width, h: height }] };
}

/**
 * Still of the cameras as the viewer shows them. The viewer's composition
 * (`viewRequest` laid out as `viewLayout`, in screen pixels) is scaled so the
 * `leadChannel` tile gets its camera's own width, then laid out again the way
 * an export lays out its frame: no gaps between tiles and a minimum smaller
 * camera height relative to the frame, not to the screen. The still is cropped
 * to the composition, so the empty part of the player box does not become
 * black bars. Returns null when the lead camera has no tile on screen.
 */
export function viewerStill(
    viewRequest: CameraLayoutRequest,
    viewLayout: CameraLayout,
    leadChannel: Channel,
    leadNativeWidth: number,
): StillLayout | null {
    const lead = viewLayout.tiles.find((tile) => tile.channel === leadChannel);
    if (!lead || lead.w <= 0 || leadNativeWidth <= 0) return null;
    const bounds = viewLayout.bounds;
    const scale = leadNativeWidth / lead.w;
    const factor = stillBudgetFactor(bounds.w * scale, bounds.h * scale);
    const boxWidth = Math.max(1, Math.round(bounds.w * scale * factor));
    const boxHeight = Math.max(1, Math.round(bounds.h * scale * factor));
    const layout = computeCameraLayout({
        ...viewRequest,
        width: boxWidth,
        height: boxHeight,
        gap: 0,
        minThumbHeight: outputMinThumbHeight(boxWidth, boxHeight),
    });
    const placed = scaleCameraLayout(layout, 1, -layout.bounds.x, -layout.bounds.y);
    return {
        width: Math.max(1, Math.round(placed.bounds.w)),
        height: Math.max(1, Math.round(placed.bounds.h)),
        tiles: placed.tiles,
    };
}

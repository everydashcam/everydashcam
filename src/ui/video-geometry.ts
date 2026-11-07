// Shared contain-fit geometry: the rect a video frame of a given aspect
// occupies inside a tile under object-fit:contain. The crop editor and the
// digital zoom both reason about this same rect - one implementation so a
// rounding / zero-height fix reaches every consumer instead of one copy.

export type Rect = { x: number; y: number; w: number; h: number };

/** Contain-fit rect of a given aspect (w/h) inside a tw x th box, in box px. */
export function containRect(aspect: number, tw: number, th: number): Rect {
    const tileAspect = tw / Math.max(1, th);
    if (aspect >= tileAspect) {
        const w = tw;
        const h = tw / aspect;
        return { x: 0, y: (th - h) / 2, w, h };
    }
    const h = th;
    const w = th * aspect;
    return { x: (tw - w) / 2, y: 0, w, h };
}

/**
 * Part of a zoomed picture still visible in its tile, as fractions of the
 * picture (0..1 on both axes). `displayed` is the picture's contain-fit rect at
 * scale 1; the zoom is `translate(offset) scale(scale)` with origin at the
 * tile's top-left corner, the transform the digital zoom applies. At low
 * scales the picture may not reach the tile edges yet, so the visible part is
 * the intersection of the scaled picture and the tile, not the tile itself.
 * Returns null when nothing of the picture is visible.
 */
export function zoomedVisibleShare(
    displayed: Rect,
    tileW: number,
    tileH: number,
    scale: number,
    offsetX: number,
    offsetY: number,
): Rect | null {
    const left = displayed.x * scale + offsetX;
    const top = displayed.y * scale + offsetY;
    const width = displayed.w * scale;
    const height = displayed.h * scale;
    if (width <= 0 || height <= 0) return null;
    const x0 = Math.max(0, left);
    const y0 = Math.max(0, top);
    const x1 = Math.min(tileW, left + width);
    const y1 = Math.min(tileH, top + height);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: (x0 - left) / width, y: (y0 - top) / height, w: (x1 - x0) / width, h: (y1 - y0) / height };
}

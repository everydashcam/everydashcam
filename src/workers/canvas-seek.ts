// Shared decode helper for workers that need ONE frame at a given time from a
// mediabunny CanvasSink (e.g. frame-extract thumbnails). No logging - callers
// own their diagnostics.

import type { CanvasSink, WrappedCanvas } from "../mediabunny.js";

/**
 * Three-route fallback to a canvas at `t`:
 *  1. sink.getCanvas(t) - random-access decode (O(1) on ISOBMFF, chunk
 *     binary search on TS).
 *  2. sink.canvases(t).next() - iterator forward decode from t; covers
 *     edit-list / pre-roll where the first real frame sits past 0.
 *  3. sink.canvases() from 0 - last resort if t is past end-of-file.
 */
export async function getCanvasNearestForward(sink: CanvasSink, t: number): Promise<WrappedCanvas | null> {
    try {
        const direct = await sink.getCanvas(t);
        if (direct) return direct;
    } catch {
        /* fall through */
    }
    try {
        const iter = sink.canvases(Math.max(0, t));
        const next = await iter.next();
        await iter.return?.(undefined);
        if (!next.done && next.value) return next.value;
    } catch {
        /* fall through */
    }
    try {
        const itAll = sink.canvases();
        const first = await itAll.next();
        await itAll.return?.(undefined);
        if (!first.done && first.value) return first.value;
    } catch {
        /* nothing to do */
    }
    return null;
}

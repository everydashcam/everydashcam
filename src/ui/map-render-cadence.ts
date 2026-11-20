import type { PresentedFrame } from "../video-frame-time.js";

// Shortest spacing between the video frames the follow camera applies. 28 ms
// keeps every frame of 25/30 fps footage (33-40 ms apart) and drops every other
// frame of 50/60 fps footage (16.7-20 ms apart), halving its map renders.
const FOLLOW_MIN_FRAME_INTERVAL_MS = 28;

/**
 * Whether the follow camera drops `frame` because it comes too soon after
 * `applied`, the frame it last used. The spacing is media time over the
 * playback rate, not the wall time between callbacks: 50/60 fps footage then
 * steps by exactly two frames, and 25/30 fps footage keeps every frame however
 * late a callback runs. A wall-clock cap applied late frames on a timer between
 * presentations, about 35 times a second for both 50 and 60 fps.
 *
 * Returns false when nothing was applied yet, for a frame of another source
 * and for a frame that is not ahead of `applied` (a seek back): those always
 * apply.
 */
export function isFollowFrameTooSoon(
    applied: PresentedFrame | null,
    frame: PresentedFrame,
    playbackRate: number,
): boolean {
    if (!applied || applied.file !== frame.file || applied.src !== frame.src) return false;
    const aheadMs = ((frame.mediaTime - applied.mediaTime) * 1000) / playbackRate;
    return aheadMs > 0 && aheadMs < FOLLOW_MIN_FRAME_INTERVAL_MS;
}

interface RenderTarget {
    readonly version: string;
    triggerRepaint(): void;
    on(type: "render" | "remove", listener: () => void): unknown;
    off(type: "render" | "remove", listener: () => void): unknown;
}

export interface MapRenderCadence {
    readonly enabled: boolean;
    refresh(): void;
}

/** Defer requested paints until the next applied video frame. Null releases
 *  the native scheduler for interactions, paused playback and unavailable clocks. */
export function installMapRenderCadence(map: RenderTarget, appliedFrame: () => object | null): MapRenderCadence {
    // MapLibre has no scheduler API. Its internal repaint requests currently use
    // this public method; an engine upgrade must pass the real-render e2e gate.
    if (map.version !== "6.19.0") return { enabled: false, refresh() {} };

    const nativeRepaint = map.triggerRepaint;
    let renderedFrame: object | null = null;
    let requestedFrame: object | null = null;
    let pending = false;
    let waiting: number | null = null;
    let removed = false;

    const cancelWait = (): void => {
        if (waiting !== null) cancelAnimationFrame(waiting);
        waiting = null;
    };
    const flush = (): void => {
        if (!pending || removed) return;
        const frame = appliedFrame();
        if (frame === null || (frame !== renderedFrame && frame !== requestedFrame)) {
            cancelWait();
            pending = false;
            // Style updates can request another paint from inside the current
            // render, before its render event acknowledges this frame.
            requestedFrame = frame;
            // Keep MapLibre's asynchronous scheduling and its native timestamp.
            // Render tasks may be enqueued AFTER triggerRepaint returns.
            nativeRepaint.call(map);
        } else if (waiting === null) {
            waiting = requestAnimationFrame(() => {
                waiting = null;
                flush();
            });
        }
    };
    const request = (): void => {
        if (removed) return;
        pending = true;
        flush();
    };
    const rendered = (): void => {
        // Consume the camera frame actually applied, even if the compositor has
        // already presented another video frame before the marker loop runs.
        renderedFrame = appliedFrame();
        requestedFrame = null;
    };
    const remove = (): void => {
        removed = true;
        pending = false;
        cancelWait();
        if (map.triggerRepaint === request) map.triggerRepaint = nativeRepaint;
        map.off("render", rendered);
        map.off("remove", remove);
    };
    map.triggerRepaint = request;
    map.on("render", rendered);
    map.on("remove", remove);
    return { enabled: true, refresh: flush };
}

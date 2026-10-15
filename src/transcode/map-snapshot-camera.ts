// Camera math shared by the main-thread map snapshotter (export-map-snapshot.ts)
// and the worker-side pipelines, plus the pose-based snapshot reuse the
// pipelines wrap around their snapshotter. Pure: no DOM, no MapLibre, so the
// worker can import it and the thresholds below stay in one place with the
// zoom math they are derived from.

import { haversineMeters } from "./frame-pos.js";
import type { MapSnapshotRequest, MapSnapshotter } from "./map-snapshotter-types.js";

/** Logical size (CSS px) of the off-screen snapshot canvas. Picked so a
 *  25%-of-1080p slot (~480 px) and a 200% slot (~960 px) both look crisp. The
 *  zoom math keys off this width, so it also fixes the ground scale of a
 *  snapshot: metres per logical pixel = diameter / MAP_SNAPSHOT_WIDTH. */
export const MAP_SNAPSHOT_WIDTH = 640;
export const MAP_SNAPSHOT_HEIGHT = 480; // 4:3 to match the on-screen preview overlay

// Speed-adaptive zoom (chase camera): zoom out by up to this many levels as
// speed rises so the road ahead stays in view. Unlike the live chase (fixed
// 16.8..15.4, always above maxzoom), the export base zoom comes from the user's
// km-scale slider, so at wider zoomKm (or the default 1 km at highway speed)
// the display zoom CAN sink below the source maxzoom 14. The 3D building layer
// (minzoom 14, opacity ramp already 0 at z14) then renders nothing, so
// buildings fade out on wide/highway shots by design.
const ADAPTIVE_MAX_ZOOM_OUT = 1.3;
const ADAPTIVE_FULL_SPEED_MS = 33; // ~120 km/h -> full zoom-out

/** Speed-adaptive zoom delta (<= 0): 0 at rest, -ADAPTIVE_MAX_ZOOM_OUT at the
 *  full-speed end. Added to the base display zoom. */
export function exportAdaptiveZoomDelta(speedMs: number | undefined): number {
    const f = Math.max(0, Math.min(1, (speedMs ?? 0) / ADAPTIVE_FULL_SPEED_MS));
    return -ADAPTIVE_MAX_ZOOM_OUT * f;
}

/** Computes a maplibre zoom level so the visible diameter (across viewportWidthPx)
 *  is ~diameterKm. Uses 78271.5, the meters-per-pixel-at-zoom-0 for MapLibre's
 *  512 px tiles - NOT the 256-tile 156543.03. With the 256 constant the zoom came
 *  out one level too high (2x too zoomed in), so a "100 m" slot actually showed
 *  ~50 m. */
export function zoomForDiameterKm(lat: number, diameterKm: number, viewportWidthPx: number): number {
    // Floor the DIAMETER at 1 metre (not 1 km). Clamping the kilometre value
    // collapsed the entire 100 m..1 km slider range to a single 1 km zoom.
    const diameterM = Math.max(1, diameterKm * 1000);
    const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
    const metersPerPx = diameterM / viewportWidthPx;
    return Math.log2((78271.5 * cosLat) / metersPerPx);
}

/** The chase-camera settings that decide how a pose change shows up in pixels.
 *  Carried to the worker as plain data (the render itself stays on the main
 *  thread) so the reuse test below can be as strict as the camera needs. */
export interface MapSnapshotCameraMode {
    /** Heading-up chase camera: the whole map rotates with the bearing. */
    headingUp: boolean;
    /** Chase only: the zoom follows speed (exportAdaptiveZoomDelta). */
    adaptiveZoom: boolean;
}

// Reuse thresholds. A snapshot is reused only while the new pose would move
// the rendered image by less than a fraction of one snapshot (logical) pixel,
// about 0.1% of the map width. The slot is cover-fit from the 640 px snapshot,
// so that is under an output pixel for slots up to ~640 px (1080p at the
// default scale) and up to ~2 px at the widest 4K slot, where the alternating
// render/reuse at highway speed shows as slightly coarser map motion.
//
// North-up: the map translates by the position delta; the marker sprite (half
// size ~25 px) rotates by the bearing, so 0.5 deg moves its tip by ~0.2 px.
// Heading-up: the map itself rotates about the car, so the far corner (~510 px
// away) moves by 0.05 deg * 510 px = ~0.45 px; and the tilted ground plane
// magnifies the near field (below the car) by up to ~2x relative to the centre
// scale, hence the halved shift budget.
const REUSE_MAX_SHIFT_PX = 0.75;
const REUSE_MAX_SHIFT_PX_HEADING_UP = REUSE_MAX_SHIFT_PX / 2;
const REUSE_MAX_BEARING_DEG_NORTH_UP = 0.5;
const REUSE_MAX_BEARING_DEG_HEADING_UP = 0.05;
// A zoom delta d scales the image by 2^d; at the far corner (~510 px) a
// 0.0014-level step is ~0.5 px.
const REUSE_MAX_ZOOM_DELTA = 0.0014;

function bearingDeltaDeg(a: number, b: number): number {
    const d = Math.abs(((a - b) % 360) + 360) % 360;
    return d > 180 ? 360 - d : d;
}

/**
 * True when rendering `next` would produce a frame indistinguishable from the
 * one rendered for `prev`, so the pipeline can paint the earlier bitmap again
 * instead of paying another main-thread MapLibre render. Conservative on
 * purpose: the shift is measured at the base zoom (the adaptive zoom-out only
 * widens the ground scale), so a pass here never under-estimates the pixel
 * motion. A changed zoomKm is never reusable - it reframes the whole map.
 */
export function isMapPoseReusable(
    prev: MapSnapshotRequest,
    next: MapSnapshotRequest,
    mode: MapSnapshotCameraMode,
): boolean {
    if (prev.zoomKm !== next.zoomKm) return false;
    const metersPerPx = Math.max(1, next.zoomKm * 1000) / MAP_SNAPSHOT_WIDTH;
    const shiftPx = haversineMeters(prev.lat, prev.lon, next.lat, next.lon) / metersPerPx;
    if (!(shiftPx <= (mode.headingUp ? REUSE_MAX_SHIFT_PX_HEADING_UP : REUSE_MAX_SHIFT_PX))) return false;
    const bearingLimit = mode.headingUp ? REUSE_MAX_BEARING_DEG_HEADING_UP : REUSE_MAX_BEARING_DEG_NORTH_UP;
    if (!(bearingDeltaDeg(prev.bearingDeg, next.bearingDeg) <= bearingLimit)) return false;
    if (mode.headingUp && mode.adaptiveZoom) {
        const zoomDelta = Math.abs(exportAdaptiveZoomDelta(prev.speedMs) - exportAdaptiveZoomDelta(next.speedMs));
        if (!(zoomDelta <= REUSE_MAX_ZOOM_DELTA)) return false;
    }
    return true;
}

/**
 * Snapshotter wrapper that owns its bitmaps and hands the same one out again
 * while the camera pose stays within isMapPoseReusable of the last render.
 * Consumers must NOT close the returned bitmaps: a bitmap may be shared by
 * several frames, and the pipeline holds one decoded frame ahead, so the
 * wrapper retains the last few renders and closes them as they age out; the
 * rest are released by dispose().
 */
export interface ReusingMapSnapshotter {
    snapshot(req: MapSnapshotRequest): Promise<ImageBitmap>;
    /** Closes every retained bitmap; later snapshot() calls reject. */
    dispose(): void;
    /** Render vs reuse counts for the run's done-line. */
    stats(): { rendered: number; reused: number };
}

// Renders kept alive. The single-channel pipeline decodes one frame ahead, so
// the frame being composited and the pending one can reference two different
// renders; a third slot is headroom, not a requirement.
const RETAINED_SNAPSHOTS = 3;

export function createReusingMapSnapshotter(inner: MapSnapshotter, mode: MapSnapshotCameraMode): ReusingMapSnapshotter {
    let lastRequest: MapSnapshotRequest | null = null;
    let lastPromise: Promise<ImageBitmap> | null = null;
    const retained: ImageBitmap[] = [];
    let isDisposed = false;
    let rendered = 0;
    let reused = 0;
    return {
        snapshot(req) {
            if (isDisposed) {
                return Promise.reject(new DOMException("map snapshotter disposed", "AbortError"));
            }
            if (lastRequest && lastPromise && isMapPoseReusable(lastRequest, req, mode)) {
                reused++;
                return lastPromise;
            }
            rendered++;
            const promise = inner.snapshot(req).then((bitmap) => {
                if (isDisposed) {
                    // Resolved after teardown: nobody will draw it, and the GPU
                    // surface would otherwise wait for GC.
                    bitmap.close();
                    throw new DOMException("map snapshotter disposed", "AbortError");
                }
                retained.push(bitmap);
                while (retained.length > RETAINED_SNAPSHOTS) retained.shift()?.close();
                return bitmap;
            });
            lastRequest = req;
            lastPromise = promise;
            // A failed render must not be handed out again as "the last good
            // pose"; the consumer latches the map off anyway, this just keeps the
            // wrapper honest. The consumer observes the rejection itself.
            promise.catch(() => {
                if (lastPromise === promise) {
                    lastRequest = null;
                    lastPromise = null;
                }
            });
            return promise;
        },
        dispose() {
            isDisposed = true;
            for (const bitmap of retained) bitmap.close();
            retained.length = 0;
            lastRequest = null;
            lastPromise = null;
        },
        stats() {
            return { rendered, reused };
        },
    };
}

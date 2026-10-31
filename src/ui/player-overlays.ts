// Export-mode preview overlays: watermark + speed + coordinates + mini-map.
//
// The player is the WYSIWYG preview of the exported clip, so any text or
// graphic that the export burns into the output frame must also be visible
// in playback while the user is configuring. This module owns the DOM
// elements and their text-content updates; positioning is read from
// exportPanelState and written back by the drag handlers.
//
// Visibility: hidden in casual mode (body.export-mode missing). Per-overlay
// enabled flags in exportPanelState gate individual overlays within
// export-mode. The watermark drags with corner-snap; speed/coords/map drag
// freely. The map overlay paints from a hidden MapLibre snapshotter (the same
// export-map-snapshot.ts the pipeline uses), refreshed on timeupdate.

import { createLogger } from "../log.js";
import { createSerialQueue } from "../serial-queue.js";
import { interpolatePosition } from "../parser.js";
import type { GpsRecord } from "../parsers/types.js";
import { MAP_BASE_WIDTH_PCT, mapOverlayRect } from "../transcode/map-overlay.js";
import { drawTelemetryOverlays } from "../transcode/telemetry-overlays.js";
import { isFinitePosition } from "../transcode/overlay-pipeline-helpers.js";
import { hasFixAt, interpScalar, resolveFramePos, resolveNoFixFramePos } from "../transcode/frame-pos.js";
import type { OverlayPipelineArgs, WatermarkAnchor } from "../transcode/types.js";
import { contentToWallUtc, frameMediaOffset } from "../trips.js";
import type { Trip } from "../trips.js";
import { getUnits } from "../units-pref.js";

import {
    ALL_CHANNELS,
    channelPlayers,
    channelTileFor,
    dom,
    effectiveMasterChannel,
    onActivePlayerEvent,
} from "./dom.js";
import { createExportMapSnapshotter, type ExportMapSnapshotter } from "./export-map-snapshot.js";
import {
    exportPanelState,
    notifyExportStateChanged,
    setExportMapPreviewProvider,
    subscribeExportState,
    type OverlayTextState,
} from "./export-state.js";
import { buildOverlayPipelineArgs, resolveOutputDims } from "./export-flow.js";
import { registerGpsSyncRefreshListener } from "./gps-sync-refresh.js";
import { isCoarsePointer } from "./media-queries.js";
import { attachPointerDrag } from "./pointer-drag.js";
import { activeFrame, activeTripHasGps, state } from "./state.js";
import type { MapStyleId } from "./theme.js";
import { mapMarkerAppearanceKey } from "./map-marker-pref.js";

// The element the overlays are positioned/sized within - the OUTPUT-FRAME
// reference, which is the full grid. All overlay geometry (drag clamping,
// font/map sizing, corner anchoring) reads this. It deliberately spans the
// whole output frame, NOT the cropped content: the export burns overlays
// relative to the output frame (drawWatermark/drawTelemetryOverlays/drawMapOverlay
// take the full widthPx/heightPx, independent of the crop - see pipeline.ts),
// so an overlay may sit over a letterbox bar, and the preview must match.
// #player-overlay-frame is 100%x100% of the grid via CSS; we never resize it.
// Falls back to the grid if the wrapper is absent.
function overlayFrameEl(): HTMLElement | null {
    return dom.playerOverlayFrame ?? dom.videoGrid ?? null;
}

const log = createLogger("ui:player-overlays");

// Watermark height as a fraction of the output frame - mirrors HEIGHT_RATIO in
// src/transcode/watermark.ts so the preview matches the burned-in size.
const WATERMARK_HEIGHT_RATIO = 0.033;
// Map overlay scale bounds, mirrored from the modal's resize handle.
const MAP_SCALE_MIN = 50;
const MAP_SCALE_MAX = 200;

// Touch: a minimum tap size (px) for the drag hit-boxes. Their natural size is
// a fraction of the frame, so a thin text widget (coords is ~0.05 of height)
// drops to ~10px tall on a phone-sized preview - impossible to grab with a
// finger. Floored only on a coarse pointer so mouse drags keep the tight box.
// The box is an invisible grab zone (the widget is painted on the canvas), so
// enlarging it does not change what the export draws.
// Frozen at boot (a hit-area floor re-synced on the next export-state/resize tick
// anyway); uses the shared predicate so the matchMedia string lives in one place.
const COARSE_POINTER = isCoarsePointer();
const HITBOX_TOUCH_MIN_PX = 40;

let watermarkResizeObserver: ResizeObserver | null = null;

export function initPlayerOverlays(): void {
    subscribeExportState(syncPlayerOverlays);
    registerGpsSyncRefreshListener(resyncPlayerOverlaysForGpsSync);
    // One PERMANENT subscription across all 8 video slots, self-filtered to
    // the active element (onActivePlayerEvent). A listener attached to the
    // physical dom.player element went stale after a preload slot-swap
    // (dom.player is a getter for the CURRENT slot): overlays froze for the
    // rest of the file and the detach removed the handler from the wrong
    // element. The export-mode gate keeps the casual-mode cost to one
    // boolean check per tick - no logging, no layout reads.
    onActivePlayerEvent("timeupdate", () => {
        if (!state.exportModeOpen) return;
        renderPreview();
        // Re-checks each tile's blur capture source so the backdrop survives
        // a preload slot-swap (cheap per tick: a WeakMap identity check per
        // channel; re-capture only fires when the element actually changed).
        syncBlurLetterbox();
    });
    attachWatermarkDrag();
    // Drag for every non-map widget via its transparent hit-box (speed/coords
    // reuse their DOM elements; the rest are created lazily). The visible
    // readout is painted on the telemetry canvas - the box only grabs.
    for (const w of PREVIEW_WIDGETS) attachWidgetDrag(w);
    if (dom.playerMapOverlay) {
        attachOverlayDrag(
            dom.playerMapOverlay,
            () => exportPanelState.overlayMap,
            (x, y) => {
                exportPanelState.overlayMap.xPct = x;
                exportPanelState.overlayMap.yPct = y;
            },
        );
        attachMapResizeHandle(dom.playerMapOverlay, dom.playerMapOverlayResize);
    }
    // The watermark + map + telemetry canvas track the output frame; it resizes
    // on window resize and output-preset (aspect) changes.
    if (typeof ResizeObserver !== "undefined" && dom.videoGrid) {
        watermarkResizeObserver = new ResizeObserver(() => {
            sizeWatermark();
            sizeMapOverlay();
            // The watermark corner margin is a fraction of the frame size (see
            // applyAnchor), so it must be recomputed on resize, not just sized.
            const wm = dom.playerWatermark;
            if (wm && !wm.hidden) applyAnchor(wm, exportPanelState.watermarkAnchor);
            syncOverlayHitboxes();
            renderTelemetryCanvas();
        });
        watermarkResizeObserver.observe(dom.videoGrid);
    }
    syncPlayerOverlays();
}

// === Telemetry preview (canvas) ===
// The export burns overlays with drawTelemetryOverlays; the preview calls the
// SAME function into a 2-D canvas over the player, so what the user arranges is
// exactly what lands in the file. The map overlay stays a DOM element (it owns
// the MapLibre snapshot + resize handle); the watermark stays a DOM element
// (corner-snap drag). Every other widget is canvas-drawn, with a transparent
// DOM hit-box on top for repositioning.

/** Hit-box sizing per widget category (fractions of frame, times the scale).
 *  Approximate - it only needs to cover the visible widget enough to grab. */
type HitSize = (scale: number, w: number, h: number) => { w: number; h: number };
const square =
    (frac: number): HitSize =>
    (s, w, h) => {
        const d = Math.min(w, h) * frac * s;
        return { w: d, h: d };
    };
const textBox =
    (fw: number, fh: number): HitSize =>
    (s, w, h) => ({ w: w * fw * s, h: h * fh * s });

interface PreviewWidget {
    id: string;
    state: () => OverlayTextState;
    size: HitSize;
    /** Existing DOM element used as the hit-box (speed/coords), else null = create. */
    fixedEl: () => HTMLElement | null;
}

const PREVIEW_WIDGETS: PreviewWidget[] = [
    {
        id: "speed",
        state: () => exportPanelState.overlaySpeed,
        size: textBox(0.16, 0.09),
        fixedEl: () => dom.playerSpeedOverlay,
    },
    {
        id: "coords",
        state: () => exportPanelState.overlayCoords,
        size: textBox(0.24, 0.05),
        fixedEl: () => dom.playerCoordsOverlay,
    },
    { id: "clock", state: () => exportPanelState.overlayClock, size: textBox(0.16, 0.07), fixedEl: () => null },
    { id: "compass", state: () => exportPanelState.overlayCompass, size: square(0.18), fixedEl: () => null },
    { id: "gforce", state: () => exportPanelState.overlayGforce, size: square(0.17), fixedEl: () => null },
    { id: "distance", state: () => exportPanelState.overlayDistance, size: textBox(0.13, 0.06), fixedEl: () => null },
    {
        id: "graph",
        state: () => exportPanelState.overlayGraph,
        size: (s, w, h) => ({ w: Math.min(w, h) * 0.54 * s, h: Math.min(w, h) * 0.12 * s }),
        fixedEl: () => null,
    },
];

// Hit-box elements created for the non-fixed widgets (lazy).
const hitboxEls = new Map<string, HTMLElement>();

/** The hit-box element for a widget - the fixed DOM element or a created div. */
function hitboxFor(w: PreviewWidget): HTMLElement | null {
    const fixed = w.fixedEl();
    if (fixed) return fixed;
    const existing = hitboxEls.get(w.id);
    if (existing) return existing;
    const host = dom.playerOverlayHitboxes;
    if (!host) return null;
    const el = document.createElement("div");
    el.className = "player-overlay-hitbox";
    el.dataset.widget = w.id;
    el.hidden = true;
    host.appendChild(el);
    hitboxEls.set(w.id, el);
    return el;
}

/** Wires drag for a widget's hit-box: writes xPct/yPct, patches the cached args
 *  in place, and redraws so the painted widget follows the box live. */
function attachWidgetDrag(w: PreviewWidget): void {
    const el = hitboxFor(w);
    if (!el) return;
    attachOverlayDrag(
        el,
        () => w.state(),
        (x, y) => {
            const st = w.state();
            st.xPct = x;
            st.yPct = y;
            // Patch the cached snapshot so the canvas widget tracks the pointer
            // (drawTelemetryOverlays reads from previewArgs, not from state). A
            // full rebuild here would be O(records) per pointermove.
            const opts = previewWidgetOpts(w.id);
            if (opts) {
                opts.xPct = x;
                opts.yPct = y;
            }
            renderTelemetryCanvas();
        },
    );
}

// Cached export args + range metadata. The heavy parts (cumulative distance,
// graph samples) are recomputed only when the "signature" inputs change
// (enabled set / range / trip); placement / style / accent edits patch the
// cached object in place so an inspector-slider or drag tick is O(1), not
// O(records).
let previewArgs: OverlayPipelineArgs | null = null;
let previewMeta: { startUtc: number; endUtc: number; distanceBaseM: number } | null = null;
let previewSig = "";

/** Placement opts of a canvas widget inside the cached args (or null when the
 *  widget is off). The args keys match the widget ids. */
function previewWidgetOpts(id: string): { xPct: number; yPct: number; scalePct: number } | null {
    if (!previewArgs) return null;
    return (
        (previewArgs as unknown as Record<string, { xPct: number; yPct: number; scalePct: number } | null>)[id] ?? null
    );
}

/** Cheap signature of the inputs that force a full args rebuild. */
function previewSignature(trip: Trip): string {
    const flags =
        PREVIEW_WIDGETS.map((w) => (w.state().enabled ? "1" : "0")).join("") +
        (exportPanelState.overlayMap.enabled ? "1" : "0");
    const r = exportPanelState.range
        ? `${exportPanelState.range.startTripSec}|${exportPanelState.range.endTripSec}`
        : "full";
    return `${trip.startUtc}|${trip.records.length}|${trip.gpsOffsetSec ?? 0}|${trip.gpsTrimToVideo ? 1 : 0}|${flags}|${r}`;
}

/** Rebuilds the cached args only when the signature changed; otherwise patches
 *  the light (placement / style / accent / scrim / units) fields in place. */
function refreshPreviewArgs(): void {
    const af = activeFrame();
    const trip = af?.trip;
    if (!trip) {
        previewArgs = null;
        previewMeta = null;
        previewSig = "";
        return;
    }
    const sig = previewSignature(trip);
    if (sig !== previewSig || !previewArgs) {
        previewSig = sig;
        rebuildPreviewArgs(trip);
    } else {
        patchPreviewArgsLight();
    }
}

function rebuildPreviewArgs(trip: Trip): void {
    previewArgs = buildOverlayPipelineArgs(trip);
    if (!previewArgs) {
        previewMeta = null;
        return;
    }
    const range = exportPanelState.range ?? { startTripSec: 0, endTripSec: trip.timeline.contentDurationSec };
    const startUtc = contentToWallUtc(trip.timeline, range.startTripSec);
    const endUtc = contentToWallUtc(trip.timeline, range.endTripSec);
    const distanceBaseM = previewArgs.cumulativeDistanceM
        ? interpScalar(trip.records, previewArgs.cumulativeDistanceM, startUtc)
        : 0;
    previewMeta = { startUtc, endUtc, distanceBaseM };
}

/** Copies the cheap, frequently-edited fields from state into the cached args
 *  without the O(records) recompute. */
function patchPreviewArgsLight(): void {
    const a = previewArgs;
    if (!a) return;
    a.style = exportPanelState.overlayStyle;
    a.accent = exportPanelState.overlayAccent;
    a.scrim = exportPanelState.overlayScrim;
    a.units = getUnits();
    for (const w of PREVIEW_WIDGETS) {
        const opts = previewWidgetOpts(w.id);
        const st = w.state();
        if (opts) {
            opts.xPct = st.xPct;
            opts.yPct = st.yPct;
            opts.scalePct = st.scalePct;
        }
    }
    if (a.map) {
        a.map.xPct = exportPanelState.overlayMap.xPct;
        a.map.yPct = exportPanelState.overlayMap.yPct;
        a.map.scalePct = exportPanelState.overlayMap.scalePct;
        a.map.shape = exportPanelState.overlayMap.shape;
        a.map.zoomKm = exportPanelState.overlayMap.zoomKm;
    }
}

/** Paints the telemetry canvas for the current playhead. Cheap enough to call
 *  per timeupdate and per drag move. */
function renderTelemetryCanvas(): void {
    const canvas = dom.playerTelemetryCanvas;
    const frame = overlayFrameEl();
    if (!canvas || !frame) return;
    const args = previewArgs;
    const af = activeFrame();
    if (!state.exportModeOpen || !args || !activeTripHasGps() || !af || af.trip.records.length === 0) {
        canvas.hidden = true;
        return;
    }
    const w = frame.clientWidth;
    const h = frame.clientHeight;
    if (w <= 0 || h <= 0) {
        canvas.hidden = true;
        return;
    }
    const ct = dom.player.currentTime || 0;
    const frameUtc = af.frame.startUtc + ct - frameMediaOffset(af.frame, effectiveMasterChannel());
    const base = interpolatePosition(af.trip.records, frameUtc);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.hidden = false;
    ctx.clearRect(0, 0, w, h);
    const span = previewMeta ? previewMeta.endUtc - previewMeta.startUtc : 0;
    const progress = previewMeta && span > 0 ? (frameUtc - previewMeta.startUtc) / span : 0;
    // No usable fix at the playhead (receiver warm-up, long dropout): the
    // preview shows the same no-fix placeholders the export burns, instead of
    // the whole overlay layer vanishing - which read as a broken preview.
    const framePos =
        base && isFinitePosition(base)
            ? resolveFramePos({
                  records: af.trip.records,
                  base,
                  cumulative: args.cumulativeDistanceM,
                  distanceBaseM: previewMeta?.distanceBaseM ?? 0,
                  frameUtc,
                  progress,
              })
            : resolveNoFixFramePos(frameUtc, progress);
    // drawTelemetryOverlays paints scrim + every non-map widget; the map is the
    // separate DOM overlay below.
    drawTelemetryOverlays(ctx, w, h, args, framePos);
}

/** Positions/sizes/visibility of the drag hit-boxes from state. */
function syncOverlayHitboxes(): void {
    const frame = overlayFrameEl();
    const open = state.exportModeOpen;
    const hasGps = activeTripHasGps();
    const w = frame?.clientWidth ?? 0;
    const h = frame?.clientHeight ?? 0;
    for (const widget of PREVIEW_WIDGETS) {
        const el = hitboxFor(widget);
        if (!el) continue;
        const st = widget.state();
        const show = open && hasGps && st.enabled && w > 0 && h > 0;
        el.hidden = !show;
        if (!show) continue;
        const size = widget.size(Math.max(0.5, Math.min(2, st.scalePct / 100)), w, h);
        const minPx = COARSE_POINTER ? HITBOX_TOUCH_MIN_PX : 0;
        el.style.left = `${st.xPct * 100}%`;
        el.style.top = `${st.yPct * 100}%`;
        el.style.width = `${Math.round(Math.max(minPx, size.w))}px`;
        el.style.height = `${Math.round(Math.max(minPx, size.h))}px`;
    }
}

/** Per-tick preview: canvas redraw + the map snapshot (if the map is on). */
function renderPreview(): void {
    renderTelemetryCanvas();
    const af = activeFrame();
    if (!af || af.trip.records.length === 0) return;
    if (!exportPanelState.overlayMap.enabled || !dom.playerMapOverlay || dom.playerMapOverlay.hidden) return;
    const ct = dom.player.currentTime || 0;
    const frameUtc = af.frame.startUtc + ct - frameMediaOffset(af.frame, effectiveMasterChannel());
    const pos = interpolatePosition(af.trip.records, frameUtc);
    // Same coverage rule as the burned overlay: no fix -> the CSS badge covers
    // the mini-map (a stale snapshot would lie about the position), and no new
    // snapshot is requested.
    const noFix = !pos || !hasFixAt(af.trip.records, frameUtc);
    dom.playerMapOverlay.classList.toggle("is-no-fix", noFix);
    if (pos && !noFix) void refreshMapSnapshot(af.trip.records, af.trip.startUtc, pos);
}

// Free-position drag for the text/map overlays. Writes normalized xPct/yPct
// (element top-left, clamped to stay inside the output frame) back through
// `write`; the frame of reference is the video grid. Mirrors the modal's
// attachOverlayDrag. No-op unless the overlay is enabled and export-mode is on.
function attachOverlayDrag(
    el: HTMLElement,
    read: () => { enabled: boolean } | null,
    write: (xPct: number, yPct: number) => void,
): void {
    let offsetX = 0;
    let offsetY = 0;
    let elW = 0;
    let elH = 0;
    attachPointerDrag(el, {
        onStart: (e) => {
            if (!state.exportModeOpen) return false;
            const cfg = read();
            if (!cfg?.enabled) return false;
            const grid = overlayFrameEl();
            if (!grid) return false;
            const gridRect = grid.getBoundingClientRect();
            const elRect = el.getBoundingClientRect();
            if (gridRect.width <= 0 || gridRect.height <= 0) return false;
            elW = elRect.width / gridRect.width;
            elH = elRect.height / gridRect.height;
            offsetX = e.clientX - elRect.left;
            offsetY = e.clientY - elRect.top;
            el.classList.add("is-dragging");
            e.preventDefault();
            return true;
        },
        onMove: (e) => {
            const grid = overlayFrameEl();
            if (!grid) return;
            const r = grid.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return;
            const maxX = Math.max(0, 1 - elW);
            const maxY = Math.max(0, 1 - elH);
            const xPct = Math.max(0, Math.min(maxX, (e.clientX - r.left - offsetX) / r.width));
            const yPct = Math.max(0, Math.min(maxY, (e.clientY - r.top - offsetY) / r.height));
            write(xPct, yPct);
            el.style.left = `${(xPct * 100).toFixed(3)}%`;
            el.style.top = `${(yPct * 100).toFixed(3)}%`;
        },
        onEnd: () => {
            el.classList.remove("is-dragging");
            notifyExportStateChanged();
        },
    });
}

function syncPlayerOverlays(): void {
    syncBlurLetterbox();
    const open = state.exportModeOpen;
    const wm = dom.playerWatermark;
    const mp = dom.playerMapOverlay;
    const canvas = dom.playerTelemetryCanvas;

    if (!open) {
        if (wm) wm.hidden = true;
        if (mp) mp.hidden = true;
        if (canvas) canvas.hidden = true;
        for (const el of hitboxEls.values()) el.hidden = true;
        if (dom.playerSpeedOverlay) dom.playerSpeedOverlay.hidden = true;
        if (dom.playerCoordsOverlay) dom.playerCoordsOverlay.hidden = true;
        previewArgs = null;
        previewMeta = null;
        previewSig = "";
        // Tear down the hidden MapLibre instance - it is heavy and only needed
        // while configuring the export.
        disposeMapSnapshotter();
        return;
    }

    if (wm) {
        // Opted out of the mark -> it must be gone from the preview too, or the
        // panel would promise a watermark the export does not burn in.
        wm.hidden = !exportPanelState.withWatermark;
        if (!wm.hidden) {
            // Anchor by exportPanelState.watermarkAnchor (tl/tr/bl/br).
            applyAnchor(wm, exportPanelState.watermarkAnchor);
            sizeWatermark();
        }
    }

    // The map overlay stays a DOM element (it owns the snapshot + resize). On a
    // trip with no fix, hide it regardless of the (possibly stale, cross-trip)
    // enabled flag - one predicate gates panel, preview, and export.
    const hasGps = activeTripHasGps();
    if (mp) {
        const showMap = hasGps && exportPanelState.overlayMap.enabled;
        mp.hidden = !showMap;
        if (showMap) sizeMapOverlay();
    }

    // Every other widget is canvas-drawn; refresh the args snapshot (heavy parts
    // only when the signature changed), lay out the drag hit-boxes, and repaint
    // (incl. the map snapshot so enabling the map while paused paints it
    // immediately, not only on the next timeupdate).
    refreshPreviewArgs();
    syncOverlayHitboxes();
    renderPreview();
}

/** Rebuilds GPS-derived preview caches after a live calibration edit. The
 *  player may be paused, so waiting for the next timeupdate would leave the
 *  visible overlay on the old track indefinitely. */
function resyncPlayerOverlaysForGpsSync(): void {
    previewSig = "";
    disposeMapSnapshotter();
    syncPlayerOverlays();
}

// Sizes the map overlay box from the output frame width × MAP_BASE_WIDTH_PCT ×
// scale - mirrors map-overlay.ts. Circle uses a square box (radius via CSS);
// rect keeps the 4:3 aspect. data-shape drives the CSS border-radius/clip.
function sizeMapOverlay(): void {
    const mp = dom.playerMapOverlay;
    if (!mp || mp.hidden) return;
    const overlayMap = exportPanelState.overlayMap;
    const output = resolveOutputDims();
    const rect = mapOverlayRect(output.width, output.height, overlayMap);
    mp.dataset.shape = overlayMap.shape;
    mp.style.width = `${(rect.width / output.width) * 100}%`;
    mp.style.height = `${(rect.height / output.height) * 100}%`;
    mp.style.left = `${(rect.x / output.width) * 100}%`;
    mp.style.top = `${(rect.y / output.height) * 100}%`;
}

function applyAnchor(el: HTMLElement, anchor: string): void {
    el.style.removeProperty("left");
    el.style.removeProperty("right");
    el.style.removeProperty("top");
    el.style.removeProperty("bottom");
    // Corner margin must mirror drawWatermark (watermark.ts): 4% of the smallest
    // frame axis, min 8px - NOT a fixed px, or the preview drifts from the burned
    // output (a fixed 12px is smaller than 4% of the frame height, so the mark
    // sat lower than in the export). Frame = the output-frame box (full grid).
    const frame = overlayFrameEl();
    const margin = Math.max(8, Math.round(Math.min(frame?.clientWidth ?? 0, frame?.clientHeight ?? 0) * 0.04));
    const m = `${margin}px`;
    switch (anchor) {
        case "tl":
            el.style.top = m;
            el.style.left = m;
            break;
        case "tr":
            el.style.top = m;
            el.style.right = m;
            break;
        case "bl":
            el.style.bottom = m;
            el.style.left = m;
            break;
        default:
            el.style.bottom = m;
            el.style.right = m;
            break;
    }
}

// Sets the watermark font-size from the output frame height (3.3%), matching
// the pipeline. Min 10px mirrors drawWatermark's Math.max(10, ...) clamp.
function sizeWatermark(): void {
    const wm = dom.playerWatermark;
    if (!wm || wm.hidden) return;
    const h = overlayFrameEl()?.clientHeight ?? 0;
    if (h <= 0) return;
    wm.style.fontSize = `${Math.max(10, Math.round(h * WATERMARK_HEIGHT_RATIO))}px`;
}

// Drag-to-reposition: the mark follows the pointer freely (via transform), then
// snaps to the nearest corner on release - the export only supports the 4
// corners (see WatermarkAnchor), so free placement collapses to a corner.
function attachWatermarkDrag(): void {
    const wm = dom.playerWatermark;
    if (!wm) return;
    let startX = 0;
    let startY = 0;

    // attachPointerDrag tracks the pointerId - the old bare `dragging` boolean
    // let a second touch mid-drag corrupt startX/startY.
    attachPointerDrag(wm, {
        onStart: (e) => {
            if (!state.exportModeOpen) return false;
            startX = e.clientX;
            startY = e.clientY;
            wm.classList.add("is-dragging");
            // Reveal the 4 snap corners and pre-light the current one so the user
            // sees where the mark can land before moving.
            showCornerTargets(true);
            highlightCorner(exportPanelState.watermarkAnchor);
            e.preventDefault();
            return true;
        },
        onMove: (e) => {
            wm.style.transform = `translate(${e.clientX - startX}px, ${e.clientY - startY}px)`;
            highlightCorner(nearestCorner(e.clientX, e.clientY));
        },
        onEnd: (e) => {
            wm.classList.remove("is-dragging");
            wm.style.removeProperty("transform");
            showCornerTargets(false);
            const anchor = nearestCorner(e.clientX, e.clientY);
            if (anchor && anchor !== exportPanelState.watermarkAnchor) {
                exportPanelState.watermarkAnchor = anchor;
                notifyExportStateChanged();
            } else {
                // Same corner - re-apply so the transform-less position is exact.
                applyAnchor(wm, exportPanelState.watermarkAnchor);
            }
        },
    });
}

// Picks the corner whose quadrant of the output frame the pointer lands in.
function nearestCorner(clientX: number, clientY: number): WatermarkAnchor | null {
    const grid = overlayFrameEl();
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const vert = clientY - rect.top < rect.height / 2 ? "t" : "b";
    const horiz = clientX - rect.left < rect.width / 2 ? "l" : "r";
    return `${vert}${horiz}` as WatermarkAnchor;
}

// Drop-target hints shown while dragging the watermark: 4 corner markers inside
// the output frame, the nearest one highlighted. Built lazily in the grid.
let cornerTargets: HTMLElement | null = null;

function ensureCornerTargets(): HTMLElement | null {
    if (cornerTargets) return cornerTargets;
    const grid = overlayFrameEl();
    if (!grid) return null;
    const root = document.createElement("div");
    root.className = "wm-corner-targets";
    for (const corner of ["tl", "tr", "bl", "br"] as const) {
        const cell = document.createElement("div");
        cell.className = "wm-corner-target";
        cell.dataset.corner = corner;
        root.appendChild(cell);
    }
    grid.appendChild(root);
    cornerTargets = root;
    return root;
}

function showCornerTargets(visible: boolean): void {
    const root = ensureCornerTargets();
    if (!root) return;
    root.classList.toggle("is-visible", visible);
    if (!visible) {
        for (const cell of Array.from(root.children)) cell.classList.remove("is-active");
    }
}

function highlightCorner(anchor: WatermarkAnchor | null): void {
    if (!cornerTargets) return;
    for (const cell of Array.from(cornerTargets.children)) {
        const c = (cell as HTMLElement).dataset.corner;
        cell.classList.toggle("is-active", anchor != null && c === anchor);
    }
}

// === Blurred letterbox preview ===
// When export-mode is on AND letterboxFill==="blur", each visible tile gets a
// live blurred cover-fit copy of its own video behind the contain video, so
// the letterbox bars show the same blur the pipeline burns into the output.
// We mirror the master's already-decoded frames via captureStream (shared
// decode, auto-synced to play/pause/seek) rather than spinning up a second
// decoder per tile. Where captureStream is unavailable (Safari) the blur
// backdrop is skipped - the export itself is unaffected. The body.letterbox-blur
// class makes the tiles/contain-bars transparent so the backdrop shows through
// (CSS in player-composition.css).
function syncBlurLetterbox(): void {
    const active = state.exportModeOpen && exportPanelState.letterboxFill === "blur";
    document.body.classList.toggle("letterbox-blur", active);
    for (const ch of ALL_CHANNELS) {
        const tile = channelTileFor(ch);
        const master = channelPlayers[ch];
        if (!tile || !master) continue;
        const blur = ensureBlurVideo(tile);
        if (active && !tile.hidden) {
            attachCaptureStream(master, blur);
            blur.hidden = false;
            if (blur.paused) void blur.play().catch(() => {});
        } else {
            blur.hidden = true;
            blur.pause();
            // Stop the capture tracks, then detach: nulling srcObject alone only
            // drops the consumer; per spec the source-side captured track stays
            // live (the master keeps playing) until GC. Stopping it ends the
            // pipeline deterministically so the master <video> isn't kept captured.
            const captured = blur.srcObject;
            if (captured instanceof MediaStream) {
                for (const tr of captured.getTracks()) tr.stop();
            }
            if (blur.srcObject) blur.srcObject = null;
        }
    }
}

function ensureBlurVideo(tile: HTMLElement): HTMLVideoElement {
    const existing = tile.querySelector<HTMLVideoElement>(":scope > video.tile-blur-bg");
    if (existing) return existing;
    const blur = document.createElement("video");
    blur.className = "tile-blur-bg";
    blur.muted = true;
    blur.playsInline = true;
    blur.setAttribute("aria-hidden", "true");
    blur.hidden = true;
    // First child so it sits behind the master/preload videos and the label;
    // exact stacking is enforced by z-index in CSS.
    tile.insertBefore(blur, tile.firstChild);
    return blur;
}

// Maps each blur element to the master it was captured from. A preload
// slot-swap makes the channel's active element a DIFFERENT physical <video>;
// the old "srcObject already set" early-return then kept mirroring the
// ex-active (cleared) element forever - a frozen/black backdrop with no
// recovery until blur was toggled off and on.
const blurCaptureSource = new WeakMap<HTMLVideoElement, HTMLVideoElement>();

function attachCaptureStream(master: HTMLVideoElement, blur: HTMLVideoElement): void {
    if (blur.srcObject && blurCaptureSource.get(blur) === master) return; // already mirroring this element
    // Stale stream from a previous element: stop its tracks before
    // re-capturing (same rationale as the teardown branch in syncBlurLetterbox).
    if (blur.srcObject instanceof MediaStream) {
        for (const tr of blur.srcObject.getTracks()) tr.stop();
        blur.srcObject = null;
    }
    const cap = master as HTMLVideoElement & {
        captureStream?: () => MediaStream;
        mozCaptureStream?: () => MediaStream;
    };
    const grab = cap.captureStream ?? cap.mozCaptureStream;
    if (!grab) return; // Safari etc.: no captureStream - skip blur preview
    try {
        blur.srcObject = grab.call(master);
        blurCaptureSource.set(blur, master);
    } catch (err) {
        log.warn("blur letterbox captureStream failed", { err: String(err) });
    }
}

// === Map overlay snapshot ===
// Lazy hidden-MapLibre snapshotter, reused across timeupdate frames and
// disposed on export-mode close. Ported from the modal's preview.
let mapSnapshotter: ExportMapSnapshotter | null = null;
let mapSnapshotterPromise: Promise<ExportMapSnapshotter | null> | null = null;
let mapSnapshotterTripUtc: number | null = null;
let mapSnapshotterRecords: GpsRecord[] | null = null;
let mapSnapshotterRecordCount = 0;
// Base-layer theme the cached snapshotter was built for. A theme switch must
// rebuild the hidden MapLibre instance (the style is fixed at construction), so
// it invalidates the cache the same way a trip change does.
let mapSnapshotterTheme: MapStyleId | null = null;
let mapSnapshotterProvider: typeof exportPanelState.overlayMap.provider | null = null;
// Label scale / street-name density the cached snapshotter was built for -
// fixed at construction like the theme, so a change invalidates the same way.
let mapSnapshotterLabelScalePct: number | null = null;
let mapSnapshotterLabelDensity: string | null = null;
let mapLastRequestKey = "";
// Monotonic gate: a burst of frames/drag launches several snapshot promises;
// only the latest result is allowed to paint (else a slow earlier frame
// overwrites a fresh later one).
let mapSnapshotSeq = 0;
// Serialize snapshot+draw on the shared MapLibre instance / reused composite
// canvas, and defer disposal behind any in-flight snapshot.
const enqueueMapSnapshot = createSerialQueue();

async function refreshMapSnapshot(
    records: GpsRecord[],
    tripStartUtc: number,
    pos: { lat: number; lon: number; bearingDeg: number; speedMs: number },
): Promise<void> {
    const canvasEl = dom.playerMapOverlayCanvas;
    if (!canvasEl || records.length === 0) return;
    const om = exportPanelState.overlayMap;
    const zoomKm = om.zoomKm;
    const theme = om.theme;
    const headingUp = om.mode === "chase";
    // Every render-affecting setting joins the dedup key so changing it (at the
    // same playhead position) is not skipped by the early-return below. Speed is
    // included only when adaptive zoom is on (it changes the zoom then).
    const speedBucket = headingUp && om.adaptiveZoom ? Math.round(pos.speedMs) : 0;
    const key = `${pos.lat.toFixed(4)}|${pos.lon.toFixed(4)}|${zoomKm}|${Math.round(pos.bearingDeg)}|${om.provider}|${theme}|${om.labelScalePct}|${om.labelDensity}|${om.mode}|${om.pitchDeg}|${om.adaptiveZoom ? 1 : 0}|${speedBucket}|${mapMarkerAppearanceKey(om.marker)}|${om.marker.size}`;
    const shouldRebuild =
        !mapSnapshotterPromise ||
        mapSnapshotterTripUtc !== tripStartUtc ||
        mapSnapshotterRecords !== records ||
        mapSnapshotterRecordCount !== records.length ||
        mapSnapshotterTheme !== theme ||
        mapSnapshotterProvider !== om.provider ||
        mapSnapshotterLabelScalePct !== om.labelScalePct ||
        mapSnapshotterLabelDensity !== om.labelDensity;
    if (!shouldRebuild && key === mapLastRequestKey) return;
    mapLastRequestKey = key;
    const seqAtStart = ++mapSnapshotSeq;

    if (shouldRebuild) {
        disposeMapSnapshotter();
        mapLastRequestKey = key;
        mapSnapshotterTripUtc = tripStartUtc;
        mapSnapshotterRecords = records;
        mapSnapshotterRecordCount = records.length;
        mapSnapshotterTheme = theme;
        mapSnapshotterProvider = om.provider;
        mapSnapshotterLabelScalePct = om.labelScalePct;
        mapSnapshotterLabelDensity = om.labelDensity;
        const providerPreference = om.provider;
        const myPromise: Promise<ExportMapSnapshotter | null> = createExportMapSnapshotter(
            records,
            "preview",
            theme,
            undefined,
            {
                provider: providerPreference,
                labelScalePct: om.labelScalePct,
                labelDensity: om.labelDensity,
                markerAppearance: om.marker,
                onProviderChange: (provider) => {
                    if (myPromise !== mapSnapshotterPromise) return;
                    setExportMapPreviewProvider(providerPreference, provider);
                },
                onInvalidate: () => {
                    if (myPromise !== mapSnapshotterPromise) return;
                    mapLastRequestKey = "";
                    if (state.exportModeOpen && !state.transcodeInProgress) renderPreview();
                },
            },
        ).then(
            (s) => {
                if (myPromise !== mapSnapshotterPromise) {
                    s.dispose();
                    return null;
                }
                mapSnapshotter = s;
                return s;
            },
            (err) => {
                if (myPromise === mapSnapshotterPromise) {
                    mapSnapshotterPromise = null;
                    mapLastRequestKey = "";
                }
                log.warn("preview map snapshotter init failed", { err: String(err) });
                return null;
            },
        );
        mapSnapshotterPromise = myPromise;
    }
    const snap = await mapSnapshotterPromise;
    if (!snap) return;
    snap.setMarkerAppearance(om.marker);
    if (!exportPanelState.overlayMap.enabled || seqAtStart !== mapSnapshotSeq) return;

    // Serialize the snapshot+draw: `snap` is ONE MapLibre instance
    // with ONE reused composite canvas, so two snapshot() calls running at once
    // interleave their jumpTo/redraw/drawImage and corrupt each other (the
    // export path serializes the same way in MapSnapshotSession).
    // disposeMapSnapshotter also joins this queue, so map.remove() never
    // fires while a snapshot is mid-await on the instance. The seq re-check
    // below drops a request a newer frame superseded while it waited in the
    // queue, so a burst renders only the latest.
    void enqueueMapSnapshot(async () => {
        if (seqAtStart !== mapSnapshotSeq || !exportPanelState.overlayMap.enabled) return;
        let bitmap: ImageBitmap | null = null;
        try {
            // waitForIdle: the preview does not prewarm tiles, so the first
            // snapshot after enabling the map must wait for tiles to load -
            // otherwise it captures a blank base layer until the user nudges the
            // playhead.
            bitmap = await snap.snapshot(
                {
                    lat: pos.lat,
                    lon: pos.lon,
                    bearingDeg: pos.bearingDeg,
                    zoomKm,
                    speedMs: pos.speedMs,
                    headingUp,
                    pitchDeg: om.pitchDeg,
                    adaptiveZoom: om.adaptiveZoom,
                },
                { waitForIdle: true },
            );
            if (seqAtStart !== mapSnapshotSeq || !exportPanelState.overlayMap.enabled) return;
            canvasEl.width = bitmap.width;
            canvasEl.height = bitmap.height;
            const ctx = canvasEl.getContext("2d");
            if (!ctx) return;
            ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
            ctx.drawImage(bitmap, 0, 0);
        } catch (err) {
            // Reset the dedup key so the SAME position can be retried on the
            // next tick - a failed snapshot otherwise left the canvas
            // stale/blank until the playhead moved (early-return at the key
            // check above). Guarded by seq so a newer in-flight request's key is
            // not clobbered.
            if (seqAtStart === mapSnapshotSeq) mapLastRequestKey = "";
            log.warn("preview map snapshot failed", { err: String(err) });
        } finally {
            if (bitmap) bitmap.close();
        }
    });
}

function disposeMapSnapshotter(): void {
    // Drop the cached refs now so a new request rebuilds a fresh instance. An
    // in-construction snapshotter self-disposes via the identity check in its
    // creation .then once the promise field below is nulled. We deliberately do
    // NOT bump mapSnapshotSeq here: this is also called from refreshMapSnapshot's
    // rebuild path (after it captured seqAtStart), and bumping would make that
    // very request bail; stale in-flight draws are already gated by the per-call
    // seq increment.
    const snap = mapSnapshotter;
    mapSnapshotter = null;
    mapSnapshotterPromise = null;
    mapSnapshotterTripUtc = null;
    mapSnapshotterRecords = null;
    mapSnapshotterRecordCount = 0;
    mapSnapshotterTheme = null;
    mapSnapshotterProvider = null;
    mapSnapshotterLabelScalePct = null;
    mapSnapshotterLabelDensity = null;
    mapLastRequestKey = "";
    if (snap) {
        // Defer map.remove() behind any snapshot still mid-await on this instance
        // (snapshot() takes no signal and runs to completion); removing the
        // MapLibre map under it would make its getCanvas/project/redraw throw.
        void enqueueMapSnapshot(() => snap.dispose()).catch((err: unknown) => {
            log.warn("preview map disposal failed", { err: String(err) });
        });
    }
}

// Drag the bottom-right corner to resize the map overlay. Width relative to the
// frame maps back to scalePct (base = MAP_BASE_WIDTH_PCT at 100%). Mirrors the
// modal's attachMapResizeHandle, including the arrow-key fallback.
function attachMapResizeHandle(slotEl: HTMLElement, handleEl: HTMLButtonElement | null): void {
    if (!handleEl) return;
    let anchorXPx = 0;
    attachPointerDrag(handleEl, {
        onStart: (e) => {
            if (!state.exportModeOpen) return false;
            anchorXPx = slotEl.getBoundingClientRect().left;
            slotEl.classList.add("is-resizing");
            e.preventDefault();
            e.stopPropagation();
            return true;
        },
        onMove: (e) => {
            const gridW = overlayFrameEl()?.clientWidth ?? 0;
            if (gridW <= 0) return;
            const widthPct = (e.clientX - anchorXPx) / gridW;
            const scalePct = (widthPct / MAP_BASE_WIDTH_PCT) * 100;
            exportPanelState.overlayMap.scalePct = Math.max(
                MAP_SCALE_MIN,
                Math.min(MAP_SCALE_MAX, Math.round(scalePct)),
            );
            sizeMapOverlay();
        },
        onEnd: () => {
            slotEl.classList.remove("is-resizing");
            notifyExportStateChanged();
        },
    });
    handleEl.addEventListener("keydown", (e) => {
        const step = e.shiftKey ? 20 : 5;
        let delta = 0;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") delta = step;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") delta = -step;
        else return;
        e.preventDefault();
        exportPanelState.overlayMap.scalePct = Math.max(
            MAP_SCALE_MIN,
            Math.min(MAP_SCALE_MAX, exportPanelState.overlayMap.scalePct + delta),
        );
        sizeMapOverlay();
        notifyExportStateChanged();
    });
}

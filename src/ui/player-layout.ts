// Places the camera tiles from the layout engine (src/camera-layout.ts).
//
// Casual viewing lays the cameras out in the video frame's own pixels. Export
// mode lays them out in the OUTPUT frame's units and scales the result into the
// preview box, so the preview is the file's layout by construction. A frame
// sized by its content (mobile portrait, see the --video-frame-sizing CSS
// contract) takes its height from a layout computed against the height
// ceiling, never against its current height, so it cannot stick at a size a
// smaller box once chose.
//
// Also owns the gestures that act on geometry: the divider between the main
// camera and the strip, and dragging/resizing overlay windows.

import {
    type CameraLayout,
    type CameraLayoutRequest,
    type CameraTileLayout,
    computeCameraLayout,
    type LayoutRect,
    OVERLAY_MARGIN_SHARE,
    outputMinThumbHeight,
    overlayPositionFor,
    snapLayoutRect,
    THUMB_SCALE_MAX,
    THUMB_SCALE_MIN,
    thumbScaleForMainExtent,
    thumbScaleForOverlayHeight,
    VIEWER_MIN_THUMB_HEIGHT_PX,
    VIEWER_TILE_GAP_PX,
} from "../camera-layout.js";
import { t } from "../i18n/index.js";
import type { Channel } from "../parsers/types.js";
import { OVERLAY_CORNER_SHARE } from "../transcode/compose.js";
import { setOverlayPosition, setThumbScale } from "./camera-arrangement.js";
import { cameraLayoutAspect } from "./camera-aspect.js";
import { ALL_CHANNELS, channelTileFor, dom, forEachVideoSlot } from "./dom.js";
import { resolveOutputDims } from "./export-flow.js";
import { isCropDragging } from "./player-crop.js";
import { attachPointerDrag } from "./pointer-drag.js";
import { state } from "./state.js";

/** A layout as placed on screen, with what is needed to map gestures back. */
interface PlacedLayout {
    request: CameraLayoutRequest;
    /** In request units (output units in export mode, grid px otherwise). */
    layout: CameraLayout;
    /** Grid px per request unit. */
    scale: number;
}

const DIVIDER_KEY_STEP = 0.05;
/** Overlay windows snap to the main picture's edge margin within this many px. */
const OVERLAY_SNAP_PX = 12;
const OVERLAY_MIN_GRAB_PX = 4;

let placed: PlacedLayout | null = null;
let placedOrder: Channel[] = [];
let divider: HTMLDivElement | null = null;
let relayoutFrame = 0;
// Swallows the click the browser dispatches after an overlay drag so it does
// not also make the dragged camera the main one.
let overlayDragJustEnded = false;

/* --------------------------------- layout ---------------------------------- */

function requestFor(order: readonly Channel[], width: number, height: number, output: boolean): CameraLayoutRequest {
    const c = state.composition;
    return {
        width,
        height,
        cameras: order.map((channel) => ({ channel, aspect: cameraLayoutAspect(channel) })),
        mode: c.mode,
        thumbScale: c.thumbScale,
        allowOverlay: c.allowOverlay,
        overlayPositions: c.overlayPositions,
        gap: output ? 0 : VIEWER_TILE_GAP_PX,
        minThumbHeight: output ? outputMinThumbHeight(width, height) : VIEWER_MIN_THUMB_HEIGHT_PX,
    };
}

/** Height ceiling of a frame sized by its content, or null for a frame whose
 *  size the page layout decides. CSS opts a frame in with
 *  `--video-frame-sizing: content` and caps it with max-height. */
function contentSizingCeiling(frame: HTMLElement): number | null {
    const style = getComputedStyle(frame);
    if (style.getPropertyValue("--video-frame-sizing").trim() !== "content") return null;
    const ceiling = Number.parseFloat(style.maxHeight);
    return Number.isFinite(ceiling) && ceiling > 0 ? ceiling : null;
}

function computePlacement(order: readonly Channel[]): PlacedLayout {
    const grid = dom.videoGrid;
    const frame = grid.parentElement;
    if (state.exportModeOpen && frame) {
        frame.style.removeProperty("--video-content-height");
        const dims = resolveOutputDims();
        const request = requestFor(order, dims.width, dims.height, true);
        // The preview box: the output aspect contain-fit into the frame.
        const frameW = frame.clientWidth;
        const frameH = frame.clientHeight;
        const scale = Math.max(0, Math.min(frameW / dims.width, frameH / dims.height));
        grid.style.width = `${Math.floor(dims.width * scale)}px`;
        grid.style.height = `${Math.floor(dims.height * scale)}px`;
        return { request, layout: computeCameraLayout(request), scale };
    }
    grid.style.removeProperty("width");
    grid.style.removeProperty("height");
    if (frame) {
        const ceiling = contentSizingCeiling(frame);
        if (ceiling !== null) {
            const probe = computeCameraLayout(requestFor(order, frame.clientWidth, ceiling, false));
            frame.style.setProperty("--video-content-height", `${Math.ceil(probe.bounds.h)}px`);
        } else {
            frame.style.removeProperty("--video-content-height");
        }
    }
    const request = requestFor(order, grid.clientWidth, grid.clientHeight, false);
    return { request, layout: computeCameraLayout(request), scale: 1 };
}

function tileRect(tile: CameraTileLayout, scale: number): LayoutRect {
    return snapLayoutRect({ x: tile.x * scale, y: tile.y * scale, w: tile.w * scale, h: tile.h * scale });
}

/**
 * Lays out the tiles of `order` (visible cameras in layout order, placeholders
 * included) and clears the geometry of every other tile.
 */
export function applyCameraLayout(order: readonly Channel[]): void {
    placedOrder = [...order];
    // A crop drag reshapes the dragged tile's picture on every move; keep the
    // tiles still until the drag ends instead of reflowing under the pointer.
    if (isCropDragging() && placed) return;
    placed = computePlacement(order);
    const grid = dom.videoGrid;
    grid.dataset.mode = state.composition.mode;
    if (placed.layout.strip) grid.dataset.strip = placed.layout.strip;
    else delete grid.dataset.strip;
    const laidOut = new Set<Channel>();
    for (const tileLayout of placed.layout.tiles) {
        const tile = channelTileFor(tileLayout.channel);
        const rect = tileRect(tileLayout, placed.scale);
        tile.style.left = `${rect.x}px`;
        tile.style.top = `${rect.y}px`;
        tile.style.width = `${rect.w}px`;
        tile.style.height = `${rect.h}px`;
        tile.dataset.role = tileLayout.role;
        tile.classList.toggle("tile-overlay", tileLayout.overlay);
        // The export rounds its windows by their size; the editor shows the
        // same corners. Viewing keeps the stylesheet's radius.
        if (tileLayout.overlay && state.exportModeOpen) {
            tile.style.borderRadius = `${Math.round(Math.min(rect.w, rect.h) * OVERLAY_CORNER_SHARE)}px`;
        } else {
            tile.style.removeProperty("border-radius");
        }
        laidOut.add(tileLayout.channel);
    }
    for (const channel of ALL_CHANNELS) {
        if (laidOut.has(channel)) continue;
        const tile = channelTileFor(channel);
        for (const prop of ["left", "top", "width", "height", "border-radius"]) tile.style.removeProperty(prop);
        delete tile.dataset.role;
        tile.classList.remove("tile-overlay");
    }
    syncDivider();
}

/**
 * The viewer's current arrangement in screen pixels: the request it was laid
 * out with and the result. null before the first layout and in export mode,
 * where the preview shows the output frame instead (see computePlacement).
 */
export function viewerCameraLayout(): { request: CameraLayoutRequest; layout: CameraLayout } | null {
    if (!placed || state.exportModeOpen) return null;
    return { request: placed.request, layout: placed.layout };
}

/** Camera the export preview blurs behind the cameras: the main place's,
 *  or the first one with a picture (the file's rule, camera-composition.ts). */
export function backdropChannel(): Channel | null {
    return (
        placedOrder.find((channel) => {
            const tile = channelTileFor(channel);
            return (
                !tile.hidden && !tile.classList.contains("tile-absent") && !tile.classList.contains("tile-unplayable")
            );
        }) ?? null
    );
}

/**
 * Frame width at which the cameras fill a frame of the current height with no
 * space beside them, capped at `maxWidth`; null before the first layout. In
 * export mode that is the output frame's width at this height.
 */
export function fittedFrameWidth(maxWidth: number): number | null {
    const height = dom.videoGrid.parentElement?.clientHeight ?? 0;
    if (!placedOrder.length || height <= 0 || maxWidth <= 0) return null;
    if (state.exportModeOpen) {
        const dims = resolveOutputDims();
        return Math.min(maxWidth, Math.ceil((height * dims.width) / dims.height));
    }
    // Laid out at the widest frame allowed, the composition is as tall as the
    // frame or as wide as the cap; its width is what the frame needs.
    const layout = computeCameraLayout(requestFor(placedOrder, maxWidth, height, false));
    return Math.min(maxWidth, Math.ceil(layout.bounds.w));
}

/** Re-lays out the last applied order (resize, metadata, export settings). */
export function relayoutCameras(): void {
    if (!placedOrder.length) return;
    applyCameraLayout(placedOrder);
}

function scheduleRelayout(): void {
    if (relayoutFrame) return;
    relayoutFrame = requestAnimationFrame(() => {
        relayoutFrame = 0;
        relayoutCameras();
    });
}

/* --------------------------------- divider --------------------------------- */

function mainTile(layout: CameraLayout): CameraTileLayout | undefined {
    return layout.tiles.find((tile) => tile.role === "main");
}

/** Current smaller-camera size as the divider reports it. */
function currentThumbScale(layout: CameraLayout): number {
    const main = mainTile(layout);
    const thumb = layout.tiles.find((tile) => tile.role === "thumb");
    if (!main || !thumb) return 0;
    return layout.strip === "right" ? thumb.w / main.w : thumb.h / main.h;
}

function ensureDivider(): HTMLDivElement {
    if (divider) return divider;
    const el = document.createElement("div");
    el.className = "camera-divider";
    el.tabIndex = 0;
    el.setAttribute("role", "separator");
    el.setAttribute("aria-valuemin", String(Math.round(THUMB_SCALE_MIN * 100)));
    el.setAttribute("aria-valuemax", String(Math.round(THUMB_SCALE_MAX * 100)));
    dom.videoGrid.appendChild(el);
    divider = el;
    attachDividerGestures(el);
    return el;
}

function syncDivider(): void {
    const strip = placed?.layout.strip;
    const main = placed ? mainTile(placed.layout) : undefined;
    if (!placed || !main || (strip !== "bottom" && strip !== "right")) {
        if (divider) divider.hidden = true;
        return;
    }
    const el = ensureDivider();
    el.hidden = false;
    el.dataset.orientation = strip === "bottom" ? "horizontal" : "vertical";
    el.setAttribute("aria-orientation", strip === "bottom" ? "horizontal" : "vertical");
    el.setAttribute("aria-label", t("player.cameras.dividerAria"));
    el.setAttribute("aria-valuenow", String(Math.round(currentThumbScale(placed.layout) * 100)));
    const s = placed.scale;
    const gap = placed.request.gap * s;
    const bounds = placed.layout.bounds;
    if (strip === "bottom") {
        el.style.left = `${bounds.x * s}px`;
        el.style.width = `${bounds.w * s}px`;
        el.style.top = `${(main.y + main.h) * s + gap / 2}px`;
        el.style.removeProperty("height");
    } else {
        el.style.top = `${bounds.y * s}px`;
        el.style.height = `${bounds.h * s}px`;
        el.style.left = `${(main.x + main.w) * s + gap / 2}px`;
        el.style.removeProperty("width");
    }
}

function attachDividerGestures(el: HTMLDivElement): void {
    let startExtent = 0;
    let startPointer = 0;
    let strip: "bottom" | "right" = "bottom";
    attachPointerDrag(el, {
        onStart: (e) => {
            const main = placed ? mainTile(placed.layout) : undefined;
            const s = placed?.layout.strip;
            if (!placed || !main || (s !== "bottom" && s !== "right")) return false;
            strip = s;
            startExtent = strip === "bottom" ? main.h : main.w;
            startPointer = strip === "bottom" ? e.clientY : e.clientX;
            el.classList.add("dragging");
            e.preventDefault();
            e.stopPropagation();
            return true;
        },
        onMove: (e) => {
            if (!placed) return;
            const pointer = strip === "bottom" ? e.clientY : e.clientX;
            const extent = startExtent + (pointer - startPointer) / placed.scale;
            const r = placed.request;
            setThumbScale(thumbScaleForMainExtent(strip, r.width, r.height, r.gap, extent), { persist: false });
        },
        onEnd: () => {
            el.classList.remove("dragging");
            setThumbScale(state.composition.thumbScale, { persist: true });
        },
    });
    el.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setThumbScale(null);
    });
    // The divider is not a tile: a click on it never reaches the tile handlers.
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("keydown", (e) => {
        if (!placed) return;
        const grow = placed.layout.strip === "right" ? ["ArrowLeft"] : ["ArrowUp"];
        const shrink = placed.layout.strip === "right" ? ["ArrowRight"] : ["ArrowDown"];
        let next: number | null = null;
        const current = currentThumbScale(placed.layout);
        if (grow.includes(e.key)) next = current + DIVIDER_KEY_STEP;
        else if (shrink.includes(e.key)) next = current - DIVIDER_KEY_STEP;
        else if (e.key === "Home" || e.key === "Escape") {
            if (state.composition.thumbScale === null) return;
            setThumbScale(null);
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (next === null) return;
        e.preventDefault();
        e.stopPropagation();
        setThumbScale(Math.min(THUMB_SCALE_MAX, Math.max(THUMB_SCALE_MIN, next)));
    });
}

/* ----------------------------- overlay windows ----------------------------- */

function overlayTile(channel: Channel): CameraTileLayout | undefined {
    return placed?.layout.tiles.find((tile) => tile.channel === channel && tile.overlay);
}

function snapToMargin(value: number, low: number, high: number, snapUnits: number): number {
    if (Math.abs(value - low) <= snapUnits) return low;
    if (Math.abs(value - high) <= snapUnits) return high;
    return Math.min(high, Math.max(low, value));
}

function attachOverlayGestures(tile: HTMLElement, channel: Channel): void {
    let start: { x: number; y: number; px: number; py: number } | null = null;
    let moved = false;
    attachPointerDrag(tile, {
        onStart: (e) => {
            const target = e.target;
            if (target instanceof Element && target.closest(".pip-resize, .tile-drag-handle")) return false;
            const overlay = overlayTile(channel);
            if (!overlay || tile.classList.contains("crop-editing")) return false;
            start = { x: overlay.x, y: overlay.y, px: e.clientX, py: e.clientY };
            moved = false;
            return true;
        },
        onMove: (e) => {
            const main = placed ? mainTile(placed.layout) : undefined;
            const overlay = overlayTile(channel);
            if (!start || !placed || !main || !overlay) return;
            const dxPx = e.clientX - start.px;
            const dyPx = e.clientY - start.py;
            if (!moved && Math.hypot(dxPx, dyPx) < OVERLAY_MIN_GRAB_PX) return;
            moved = true;
            tile.classList.add("pip-dragging");
            const s = placed.scale;
            const margin = OVERLAY_MARGIN_SHARE * main.h;
            const snap = OVERLAY_SNAP_PX / s;
            const x = snapToMargin(start.x + dxPx / s, main.x + margin, main.x + main.w - overlay.w - margin, snap);
            const y = snapToMargin(start.y + dyPx / s, main.y + margin, main.y + main.h - overlay.h - margin, snap);
            setOverlayPosition(channel, overlayPositionFor(main, x, y), { persist: false });
        },
        onEnd: () => {
            tile.classList.remove("pip-dragging");
            if (!moved) return;
            overlayDragJustEnded = true;
            const position = state.composition.overlayPositions[channel];
            if (position) setOverlayPosition(channel, position, { persist: true });
        },
    });
    const handle = tile.querySelector<HTMLElement>(".pip-resize");
    if (!handle) return;
    let anchorTop = 0;
    attachPointerDrag(handle, {
        onStart: (e) => {
            if (!overlayTile(channel)) return false;
            anchorTop = tile.getBoundingClientRect().top;
            tile.classList.add("pip-dragging");
            e.preventDefault();
            e.stopPropagation();
            return true;
        },
        onMove: (e) => {
            const main = placed ? mainTile(placed.layout) : undefined;
            if (!placed || !main) return;
            const heightUnits = (e.clientY - anchorTop) / placed.scale;
            setThumbScale(thumbScaleForOverlayHeight(main.h, heightUnits), { persist: false });
        },
        onEnd: () => {
            tile.classList.remove("pip-dragging");
            overlayDragJustEnded = true;
            setThumbScale(state.composition.thumbScale, { persist: true });
        },
    });
}

/* ---------------------------------- init ----------------------------------- */

/** Wires resize/metadata relayout and the geometry gestures. Call once. */
export function initPlayerLayout(): void {
    const frame = dom.videoGrid.parentElement;
    if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(scheduleRelayout);
        if (frame) ro.observe(frame);
        ro.observe(dom.videoGrid);
    }
    // A video's first metadata (or a resolution change mid-trip) gives the
    // camera its real shape.
    forEachVideoSlot((video) => {
        video.addEventListener("loadedmetadata", scheduleRelayout);
        video.addEventListener("resize", scheduleRelayout);
    });
    for (const channel of ALL_CHANNELS) attachOverlayGestures(channelTileFor(channel), channel);
    // Capture phase: runs before the tile click handlers on the grid.
    dom.videoGrid.addEventListener(
        "click",
        (e) => {
            if (!overlayDragJustEnded) return;
            overlayDragJustEnded = false;
            e.stopImmediatePropagation();
            e.preventDefault();
        },
        true,
    );
    dom.videoGrid.addEventListener("pointerdown", () => {
        overlayDragJustEnded = false;
    });
}

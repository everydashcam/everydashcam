// Blur-region editing + live preview in export-mode.
//
// The export panel's "Add blur zone" button arms draw mode: the user drags a
// rectangle on a video tile (tap on touch plants a default-sized box) and a
// region is created at the playhead with a default forward span. Regions active
// at the current playhead render as draggable boxes (corner handles) over their
// channel's tile; moving/resizing a box writes a PINNED keyframe at the playhead
// (src/blur-regions.ts) - the FCP/CapCut pattern where an adjustment silently
// becomes a keyframe. The redaction itself is previewed on a per-tile canvas,
// painted with the SAME compose helpers the export burn-in uses (paintRegionBlur
// + mapRegionRectToDest), so preview == output by construction.
//
// Geometry: regions store rects in normalized source coords. In export-mode a
// tile shows either the full source frame (contain-fit) or, with a crop set,
// the crop result (player-crop owns the view transform and clip-path) - both
// reduce to "source view rect fitted into a dest rect", which is exactly the
// mapping mapRegionRectToDest implements. While a tile is in crop-editing the
// blur UI on it is hidden (the crop editor's drag view breaks the mapping and
// owning the same surface would fight over pointer events).
//
// Redraw: rAF while visible videos play; media events and geometry edits wake
// a paused preview. Listeners cover both preload slots so promotion preserves
// redraws. No logging here - hot path.

import { type CameraFlip, applyCanvasFlip, flipCropRect, flipPixelRect } from "../camera-flip.js";
import { cameraFlipForChannel } from "./camera-flip-pref.js";
import { t } from "../i18n/index.js";
import type { Channel } from "../parsers/types.js";
import {
    createBlurRegion,
    DEFAULT_ZONE_SPAN_SEC,
    MIN_ZONE_SPAN_SEC,
    regionRectAt,
    resolveRegionBlursAt,
    sortBlurRegionsForPaint,
    upsertKeyframe,
    ZONE_START_PLAYHEAD_BACKOFF_SEC,
    type BlurRegion,
} from "../blur-regions.js";
import type { CropRect } from "../transcode/compose.js";
import {
    createBlurHelper,
    createRegionBlurHelper,
    fillBlurredCover,
    mapRegionRectToDest,
    paintRegionBlur,
    snapRegionToMosaicGrid,
    softBlurRegionGrid,
    type BlurHelper,
    type RegionBlurHelper,
} from "../transcode/compose.js";

import {
    activeBlurRegions,
    addBlurRegion,
    notifyBlurRegionsChanged,
    subscribeBlurRegions,
} from "./blur-regions-state.js";
import { activeEffectiveBlurRegions, previewExportStartSec } from "./blur-effective.js";
import { detectRegions, subscribeBlurDetect } from "./blur-detect.js";
import { ALL_CHANNELS, channelPlayers, channelTileFor, dom, forEachVideoSlot } from "./dom.js";
import { exportPanelState, notifyExportStateChanged, subscribeExportState } from "./export-state.js";
import { channelDisplayLabel } from "./format.js";
import { exitCropEditIfOpen } from "./player-crop.js";
import { attachPointerDrag } from "./pointer-drag.js";
import {
    channelPresentedFrame,
    samePresentedFrame,
    subscribePlayerFrames,
    type ChannelPresentedFrame,
} from "./player-frame-time.js";
import { activeTrip, state } from "./state.js";
import { cancelTrackPass, cancelTrackPassesExceptTrip } from "./blur-track.js";
import { containRect, type Rect } from "./video-geometry.js";

/** Smallest region dimension as a fraction of the source frame. */
const MIN_REGION = 0.01;
/** Default box size (fraction of the source min dimension) for a tap-plant. */
const TAP_BOX_FRAC = 0.15;
/** Drag shorter than this (px) counts as a tap -> default-sized box. */
const TAP_DRAG_PX = 12;

interface TileUi {
    /** Preview canvas painting the redaction patches. */
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    /** Region boxes layer (outlines + handles). */
    boxLayer: HTMLDivElement;
    /** region id -> box element, rebuilt on region list changes. */
    boxes: Map<string, HTMLDivElement>;
    /** Last painted state, to skip idle repaints. */
    lastFrame: ChannelPresentedFrame | null;
    lastEpoch: number;
    lastWidth: number;
    lastHeight: number;
    lastDpr: number;
    lastExportStartSec: number;
}

const tileUis = new Map<Channel, TileUi>();
let previewHelper: RegionBlurHelper | null = null;
let previewBackdropHelper: BlurHelper | null = null;
let rafId = 0;
let armed = false;
let drawOpener: HTMLElement | null = null;
let drawLayerEls: HTMLDivElement[] = [];
let drawChannels: Channel[] = [];
// Bumped by anything that changes geometry (resize, crop, layout) so the rAF
// loop repaints even at an unchanged playhead.
let geometryEpoch = 0;
let previewRegions: readonly BlurRegion[] = [];
let detectedPreviewRegions: readonly BlurRegion[] = [];
let detectedPreviewStyles: BlurRegion["style"][] = [];

let lastSeenTrip: ReturnType<typeof activeTrip> = null;

export function initPlayerBlur(): void {
    subscribePlayerFrames(schedulePaint);
    subscribeExportState(() => {
        if (
            !blurEditorActive() ||
            ALL_CHANNELS.some((ch) => channelTileFor(ch).classList.contains("crop-editing")) ||
            drawChannels.length !== state.composition.channelOrder.length ||
            drawChannels.some((ch, i) => ch !== state.composition.channelOrder[i])
        )
            disarmDraw();
        // Trip switch invalidates the armed draw layers (their channel
        // closures and tile bindings belong to the previous trip).
        const trip = activeTrip();
        if (trip !== lastSeenTrip) {
            lastSeenTrip = trip;
            disarmDraw();
            if (!__PORTABLE__) cancelTrackPassesExceptTrip(state.exportModeOpen ? trip : null);
        } else if (!state.exportModeOpen) {
            if (!__PORTABLE__) cancelTrackPassesExceptTrip(null);
        }
        geometryEpoch++;
        syncLifecycle();
    });
    subscribeBlurRegions(() => {
        geometryEpoch++;
        syncLifecycle();
    });
    // Auto-detected regions arrive/expire without touching the manual list -
    // repaint (and start/stop the loop) on their changes too.
    if (!__PORTABLE__)
        subscribeBlurDetect(() => {
            if (!state.exportModeOpen) return;
            const regions = detectRegions();
            // Progress does not change privacy geometry. Keep paused previews and
            // editor boxes asleep until results arrive, expire, or change style.
            if (
                regions.length === detectedPreviewRegions.length &&
                regions.every(
                    (region, i) => region === detectedPreviewRegions[i] && region.style === detectedPreviewStyles[i],
                )
            )
                return;
            detectedPreviewRegions = regions.slice();
            detectedPreviewStyles = regions.map((region) => region.style);
            geometryEpoch++;
            syncLifecycle();
        });
    forEachVideoSlot((video, ch) => {
        const schedule = (): void => {
            if (video === channelPlayers[ch]) schedulePaint();
        };
        const invalidate = (): void => {
            if (video !== channelPlayers[ch]) return;
            geometryEpoch++;
            schedulePaint();
        };
        for (const event of ["play", "pause", "timeupdate", "seeking"]) video.addEventListener(event, schedule);
        // seeked may supply decoded pixels after a seeking tick already saw
        // the target currentTime. Repaint even when its timestamp is unchanged.
        for (const event of ["seeked", "loadeddata", "emptied", "resize"]) {
            video.addEventListener(event, invalidate);
        }
    });
    // Escape cancels draw-arming before anything else (capture phase, same
    // pattern as the crop editor's Escape).
    document.addEventListener(
        "keydown",
        (e) => {
            if (e.key === "Escape" && armed) {
                e.preventDefault();
                e.stopPropagation();
                disarmDraw();
            }
        },
        { capture: true },
    );
    if (typeof ResizeObserver !== "undefined" && dom.videoGrid) {
        const ro = new ResizeObserver(() => {
            geometryEpoch++;
            schedulePaint();
        });
        ro.observe(dom.videoGrid);
        for (const ch of ALL_CHANNELS) ro.observe(channelTileFor(ch));
    }
}

// --- lifecycle -------------------------------------------------------------

function blurUiActive(): boolean {
    // Auto-detected regions paint too (no editor boxes for them - see tick),
    // so a trip with only checkbox-found blur still gets a live preview.
    return state.exportModeOpen && (activeBlurRegions().length > 0 || detectRegions().length > 0);
}

/** Editing is allowed only while configuring. The preview remains visible in
 *  progress so the frame still matches the immutable export snapshot, but its
 *  boxes must not imply that late edits can affect that run. */
function blurEditorActive(): boolean {
    return state.exportModeOpen && exportPanelState.phase === "options" && !exportPanelState.configurationLocked;
}

/** Creates/destroys per-tile UI and starts/stops the rAF loop to match state. */
function syncLifecycle(): void {
    const active = blurUiActive();
    if (active) {
        previewRegions = sortBlurRegionsForPaint(activeEffectiveBlurRegions());
        for (const ch of ALL_CHANNELS) {
            if (state.composition.channelOrder.indexOf(ch) >= 0) ensureTileUi(ch);
        }
        // Drop UI for channels that left the layout.
        for (const [ch, ui] of tileUis) {
            if (state.composition.channelOrder.indexOf(ch) < 0) {
                destroyTileUi(ui);
                tileUis.delete(ch);
            }
        }
        rebuildBoxes();
        schedulePaint();
    } else {
        previewRegions = [];
        detectedPreviewRegions = [];
        detectedPreviewStyles = [];
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
        }
        for (const ui of tileUis.values()) destroyTileUi(ui);
        tileUis.clear();
    }
}

function ensureTileUi(ch: Channel): TileUi {
    let ui = tileUis.get(ch);
    if (ui) return ui;
    const tile = channelTileFor(ch);
    const canvas = document.createElement("canvas");
    canvas.className = "blur-preview-canvas";
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("blur preview canvas ctx unavailable");
    const boxLayer = document.createElement("div");
    boxLayer.className = "blur-box-layer";
    tile.appendChild(canvas);
    tile.appendChild(boxLayer);
    ui = {
        canvas,
        ctx,
        boxLayer,
        boxes: new Map(),
        lastFrame: null,
        lastEpoch: -1,
        lastWidth: 0,
        lastHeight: 0,
        lastDpr: 0,
        lastExportStartSec: -Infinity,
    };
    tileUis.set(ch, ui);
    return ui;
}

function destroyTileUi(ui: TileUi): void {
    ui.canvas.remove();
    ui.boxLayer.remove();
}

// --- geometry ---------------------------------------------------------------

/** Source view (crop or full frame) in video px + the tile rect it maps onto.
 *  Mirrors the export mapping: view = crop window, dest = keep-aspect fit of
 *  the view in the tile (see player-crop's resultContentRect). Null when the
 *  video has no dimensions yet. */
interface TileMapping {
    flip: Readonly<CameraFlip>;
    vw: number;
    vh: number;
    view: CropRect;
    dest: Rect;
}

function tileMapping(ch: Channel, width?: number, height?: number): TileMapping | null {
    const v = channelPlayers[ch];
    const tile = channelTileFor(ch);
    const tileWidth = width ?? tile.clientWidth;
    const tileHeight = height ?? tile.clientHeight;
    if (!v || v.videoWidth <= 0 || v.videoHeight <= 0 || tileWidth <= 0) return null;
    const slotIdx = state.composition.channelOrder.indexOf(ch);
    const crop = (slotIdx >= 0 ? state.composition.perSlotCrops[slotIdx] : null) ?? {
        xPct: 0,
        yPct: 0,
        wPct: 1,
        hPct: 1,
    };
    const viewAspect = (v.videoWidth / v.videoHeight) * (crop.wPct / Math.max(1e-6, crop.hPct));
    const dest = containRect(viewAspect, tileWidth, tileHeight);
    const flip = cameraFlipForChannel(ch);
    return { vw: v.videoWidth, vh: v.videoHeight, view: flipCropRect(crop, flip), dest, flip };
}

/** Region rect (normalized source) -> tile px, honoring the crop view. */
function regionRectToTile(m: TileMapping, rect: CropRect): { x: number; y: number; w: number; h: number } | null {
    const patch = mapRegionRectToDest(
        rect,
        m.vw,
        m.vh,
        m.view.xPct * m.vw,
        m.view.yPct * m.vh,
        m.view.wPct * m.vw,
        m.view.hPct * m.vh,
        m.dest.x,
        m.dest.y,
        m.dest.w,
        m.dest.h,
    );
    return patch ? flipPixelRect(patch, m.dest, m.flip) : null;
}

/** Tile px point -> normalized source coords (clamped to the visible view). */
function tilePointToSource(ch: Channel, px: number, py: number): { x: number; y: number } | null {
    const m = tileMapping(ch);
    if (!m) return null;
    const fx = Math.max(0, Math.min(1, (px - m.dest.x) / m.dest.w));
    const fy = Math.max(0, Math.min(1, (py - m.dest.y) / m.dest.h));
    return {
        x: m.view.xPct + (m.flip.horizontal ? 1 - fx : fx) * m.view.wPct,
        y: m.view.yPct + (m.flip.vertical ? 1 - fy : fy) * m.view.hPct,
    };
}

// --- preview loop ------------------------------------------------------------

function schedulePaint(): void {
    if (!rafId && tileUis.size > 0) rafId = requestAnimationFrame(tick);
}

function tick(): void {
    rafId = 0;
    if (!state.exportModeOpen || previewRegions.length === 0) return;
    // Manual zones + auto-detected regions paint identically; only manual ones
    // get editor boxes (rebuildBoxes reads activeBlurRegions alone - dozens of
    // non-editable auto boxes would bury the drag handles).
    let isPlaying = false;
    for (const [ch, ui] of tileUis) {
        paintTile(ch, ui, previewRegions);
        if (!channelTileFor(ch).hidden && !channelPlayers[ch].paused) isPlaying = true;
    }
    if (isPlaying) schedulePaint();
}

function paintTile(ch: Channel, ui: TileUi, regions: readonly BlurRegion[]): void {
    const tile = channelTileFor(ch);
    // The crop editor owns this tile's surface and transform right now.
    const cropEditing = tile.classList.contains("crop-editing");
    const v = channelPlayers[ch];
    const shownFrame = channelPresentedFrame(ch);
    ui.boxLayer.hidden = cropEditing || !blurEditorActive() || channelPresentedFrame(ch, true) === null;
    // Keep the old patch while a seek/source change still displays old pixels.
    // The frame callback wakes us when new pixels have a matching timestamp.
    if (!shownFrame) {
        if (cropEditing || tile.hidden) ui.ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
        return;
    }
    const contentSec = shownFrame.contentSec;
    const exportStartSec = previewExportStartSec(ch, contentSec);
    // The media clock advances between decoded frames. Repaint for the frame
    // actually shown, or an edit/resize; repeated pixels need no new patch.
    const tileWidth = tile.clientWidth;
    const tileHeight = tile.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (
        samePresentedFrame(shownFrame, ui.lastFrame) &&
        geometryEpoch === ui.lastEpoch &&
        exportStartSec === ui.lastExportStartSec &&
        tileWidth === ui.lastWidth &&
        tileHeight === ui.lastHeight &&
        dpr === ui.lastDpr
    )
        return;
    ui.lastFrame = shownFrame;
    ui.lastEpoch = geometryEpoch;
    ui.lastExportStartSec = exportStartSec;
    ui.lastWidth = tileWidth;
    ui.lastHeight = tileHeight;
    ui.lastDpr = dpr;

    const w = Math.max(1, Math.round(tileWidth * dpr));
    const h = Math.max(1, Math.round(tileHeight * dpr));
    if (ui.canvas.width !== w || ui.canvas.height !== h) {
        ui.canvas.width = w;
        ui.canvas.height = h;
    }
    const ctx = ui.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, tileWidth, tileHeight);
    if (cropEditing || !v || tile.hidden) return;

    const mapping = tileMapping(ch, tileWidth, tileHeight);
    if (mapping && exportPanelState.letterboxFill === "blur") {
        // The CSS backdrop mirrors raw video. Repaint its visible bars with
        // the export's censored backdrop, including regions outside the crop.
        previewBackdropHelper ??= createBlurHelper();
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, tileWidth, tileHeight);
        ctx.rect(mapping.dest.x, mapping.dest.y, mapping.dest.w, mapping.dest.h);
        ctx.clip("evenodd");
        applyCanvasFlip(ctx, { x: 0, y: 0, w: tileWidth, h: tileHeight }, mapping.flip);
        fillBlurredCover(
            ctx,
            v,
            v.videoWidth,
            v.videoHeight,
            0,
            0,
            tileWidth,
            tileHeight,
            previewBackdropHelper,
            resolveRegionBlursAt(regions, ch, contentSec, exportStartSec),
        );
        ctx.restore();
    }
    previewHelper ??= createRegionBlurHelper();
    for (const region of regions) {
        if (region.channel !== ch) continue;
        const rect = regionRectAt(region, contentSec, exportStartSec);
        const box = ui.boxes.get(region.id);
        if (!rect) {
            if (box) box.hidden = true;
            continue;
        }
        const tileRect = mapping && regionRectToTile(mapping, rect);
        if (!tileRect) {
            if (box) box.hidden = true;
            continue;
        }
        // Patch pixels straight from the <video> (blob:/MSE sources are
        // same-origin, no taint). Source rect in video px. Pixelate snaps to
        // the scene-anchored grid - the same snap the burn-in applies - so the
        // preview shows the exact block layout of the output.
        let patchRect = rect;
        let grid: { cols: number; rows: number } | undefined;
        if (region.style !== "fill") {
            const regionGrid = region.style === "pixelate" ? snapRegionToMosaicGrid : softBlurRegionGrid;
            const snapped = mapping
                ? regionGrid(
                      rect,
                      v.videoWidth,
                      v.videoHeight,
                      mapping.view.xPct * v.videoWidth,
                      mapping.view.yPct * v.videoHeight,
                      mapping.view.wPct * v.videoWidth,
                      mapping.view.hPct * v.videoHeight,
                  )
                : null;
            if (!snapped) {
                if (box) box.hidden = true;
                continue;
            }
            patchRect = snapped.rect;
            grid = { cols: snapped.cols, rows: snapped.rows };
        }
        const patchTileRect = patchRect === rect ? tileRect : mapping && regionRectToTile(mapping, patchRect);
        if (patchTileRect) {
            ctx.save();
            applyCanvasFlip(ctx, patchTileRect, cameraFlipForChannel(ch));
            paintRegionBlur(
                ctx,
                v,
                {
                    x: patchRect.xPct * v.videoWidth,
                    y: patchRect.yPct * v.videoHeight,
                    w: patchRect.wPct * v.videoWidth,
                    h: patchRect.hPct * v.videoHeight,
                },
                patchTileRect,
                region.style,
                previewHelper,
                grid,
            );
            ctx.restore();
        }
        if (box) {
            box.hidden = false;
            box.style.left = `${tileRect.x}px`;
            box.style.top = `${tileRect.y}px`;
            box.style.width = `${tileRect.w}px`;
            box.style.height = `${tileRect.h}px`;
        }
    }
}

// --- region boxes (drag = pinned keyframe) -----------------------------------

function rebuildBoxes(): void {
    if (!blurUiActive()) return;
    const byChannel = new Map<Channel, { entries: Array<{ region: BlurRegion; index: number }>; ids: Set<string> }>();
    for (const [index, region] of activeBlurRegions().entries()) {
        let group = byChannel.get(region.channel);
        if (!group) {
            group = { entries: [], ids: new Set() };
            byChannel.set(region.channel, group);
        }
        group.entries.push({ region, index });
        group.ids.add(region.id);
    }
    for (const [ch, ui] of tileUis) {
        const group = byChannel.get(ch);
        for (const [id, el] of ui.boxes) {
            if (!group?.ids.has(id)) {
                el.remove();
                ui.boxes.delete(id);
            }
        }
        if (!group) continue;
        for (const { region, index } of group.entries) {
            const existing = ui.boxes.get(region.id);
            if (existing) {
                existing.setAttribute("aria-label", regionBoxAriaLabel(region, index));
                continue;
            }
            const el = buildRegionBox(region, index);
            ui.boxLayer.appendChild(el);
            ui.boxes.set(region.id, el);
        }
    }
}

function regionBoxAriaLabel(region: BlurRegion, index: number): string {
    const zoneName = t("export.blur.zone", { n: index + 1 });
    const trip = activeTrip();
    const channelName = trip ? ` · ${channelDisplayLabel(region.channel, trip)}` : "";
    return `${zoneName}${channelName}. ${t("export.blur.editBox")}`;
}

function buildRegionBox(region: BlurRegion, index: number): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "blur-box";
    el.hidden = true;
    el.tabIndex = 0;
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", regionBoxAriaLabel(region, index));
    // A double-click also emits its own event after the suppressed clicks.
    // Keep the tile's crop shortcut from taking over a blur edit.
    el.addEventListener("dblclick", (event) => event.stopPropagation());
    el.addEventListener("keydown", (event) => editBoxWithKeyboard(region, event));
    for (const corner of ["tl", "tr", "bl", "br"] as const) {
        const hnd = document.createElement("div");
        hnd.className = `blur-box-handle blur-box-handle--${corner}`;
        el.appendChild(hnd);
        attachBoxHandleDrag(region, hnd, corner);
    }
    attachBoxMoveDrag(region, el);
    return el;
}

/** Keyboard equivalent of dragging the visual box. Arrows move it; Shift+arrows
 *  resize its right/bottom edges. */
function editBoxWithKeyboard(region: BlurRegion, event: KeyboardEvent): void {
    if (!blurEditorActive() || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    pauseBlurVideos();
    const frame = channelPresentedFrame(region.channel, true);
    if (!frame) return;
    const current = regionRectAt(region, frame.contentSec, previewExportStartSec(region.channel, frame.contentSec));
    if (!current) return;
    const step = 0.005;
    const flip = cameraFlipForChannel(region.channel);
    const next = flipCropRect(current, flip);
    if (event.shiftKey) {
        if (event.key === "ArrowLeft") next.wPct = Math.max(MIN_REGION, next.wPct - step);
        if (event.key === "ArrowRight") next.wPct = Math.min(1 - next.xPct, next.wPct + step);
        if (event.key === "ArrowUp") next.hPct = Math.max(MIN_REGION, next.hPct - step);
        if (event.key === "ArrowDown") next.hPct = Math.min(1 - next.yPct, next.hPct + step);
    } else {
        if (event.key === "ArrowLeft") next.xPct = Math.max(0, next.xPct - step);
        if (event.key === "ArrowRight") next.xPct = Math.min(1 - next.wPct, next.xPct + step);
        if (event.key === "ArrowUp") next.yPct = Math.max(0, next.yPct - step);
        if (event.key === "ArrowDown") next.yPct = Math.min(1 - next.hPct, next.yPct + step);
    }
    commitRect(region, flipCropRect(next, flip), frame);
}

function pauseBlurVideos(): void {
    for (const ch of ALL_CHANNELS) {
        const video = channelPlayers[ch];
        if (!video.paused) video.pause();
    }
}

/** Commits geometry only to the displayed frame where editing began. */
function commitRect(region: BlurRegion, rect: CropRect, frame: ChannelPresentedFrame): void {
    // Save can lock the form while a keyboard/pointer gesture is already in
    // flight. The export has its own snapshot; stop the editor too so a late
    // pointerup does not create a zone that appears to belong to that run.
    if (!blurEditorActive() || !samePresentedFrame(frame, channelPresentedFrame(region.channel, true))) return;
    if (!__PORTABLE__) cancelTrackPass(region.id);
    upsertKeyframe(region, frame.contentSec, rect, true);
    geometryEpoch++;
    notifyBlurRegionsChanged();
}

function attachBoxMoveDrag(region: BlurRegion, el: HTMLDivElement): void {
    let startX = 0;
    let startY = 0;
    let base: CropRect | null = null;
    let frame: ChannelPresentedFrame | null = null;
    // The synthetic click after a drag would bubble to the tile and trigger
    // its click behavior (audio-channel swap on non-master tiles).
    el.addEventListener("click", (e) => e.stopPropagation());
    attachPointerDrag(el, {
        onStart: (e) => {
            if (!blurEditorActive()) return false;
            if ((e.target as HTMLElement)?.classList.contains("blur-box-handle")) return false;
            // Editing a box on moving video is chaos - hold the frame.
            pauseBlurVideos();
            frame = channelPresentedFrame(region.channel, true);
            if (!frame) return false;
            base = regionRectAt(region, frame.contentSec, previewExportStartSec(region.channel, frame.contentSec));
            if (!base) return false;
            base = flipCropRect(base, cameraFlipForChannel(region.channel));
            startX = e.clientX;
            startY = e.clientY;
            e.preventDefault();
            e.stopPropagation();
            return true;
        },
        onMove: (e) => {
            if (!base || !frame) return;
            // Space/K can resume playback mid-drag; a moving playhead would
            // smear a keyframe trail. Hold the frame for the whole gesture.
            pauseBlurVideos();
            const m = tileMapping(region.channel);
            if (!m || m.dest.w <= 0) return;
            // Pointer delta in tile px -> normalized source delta through the view.
            const dx = ((e.clientX - startX) / m.dest.w) * m.view.wPct;
            const dy = ((e.clientY - startY) / m.dest.h) * m.view.hPct;
            const xPct = Math.max(0, Math.min(1 - base.wPct, base.xPct + dx));
            const yPct = Math.max(0, Math.min(1 - base.hPct, base.yPct + dy));
            commitRect(region, flipCropRect({ ...base, xPct, yPct }, m.flip), frame);
        },
    });
}

function attachBoxHandleDrag(region: BlurRegion, handle: HTMLElement, corner: "tl" | "tr" | "bl" | "br"): void {
    let startX = 0;
    let startY = 0;
    let base: CropRect | null = null;
    let frame: ChannelPresentedFrame | null = null;
    attachPointerDrag(handle, {
        onStart: (e) => {
            if (!blurEditorActive()) return false;
            pauseBlurVideos();
            frame = channelPresentedFrame(region.channel, true);
            if (!frame) return false;
            base = regionRectAt(region, frame.contentSec, previewExportStartSec(region.channel, frame.contentSec));
            if (!base) return false;
            base = flipCropRect(base, cameraFlipForChannel(region.channel));
            startX = e.clientX;
            startY = e.clientY;
            e.preventDefault();
            e.stopPropagation();
            return true;
        },
        onMove: (e) => {
            if (!base || !frame) return;
            pauseBlurVideos();
            const m = tileMapping(region.channel);
            if (!m || m.dest.w <= 0 || m.dest.h <= 0) return;
            // The handle may mark a crop-clipped edge or be grabbed off-centre.
            // Apply the pointer delta to the stored edge, preserving that offset.
            const dx = ((e.clientX - startX) / m.dest.w) * m.view.wPct;
            const dy = ((e.clientY - startY) / m.dest.h) * m.view.hPct;
            let { xPct, yPct, wPct, hPct } = base;
            const right = xPct + wPct;
            const bottom = yPct + hPct;
            if (corner === "tl" || corner === "bl") {
                xPct = Math.max(0, Math.min(xPct + dx, right - MIN_REGION));
                wPct = right - xPct;
            } else {
                wPct = Math.min(1 - xPct, Math.max(MIN_REGION, wPct + dx));
            }
            if (corner === "tl" || corner === "tr") {
                yPct = Math.max(0, Math.min(yPct + dy, bottom - MIN_REGION));
                hPct = bottom - yPct;
            } else {
                hPct = Math.min(1 - yPct, Math.max(MIN_REGION, hPct + dy));
            }
            commitRect(region, flipCropRect({ xPct, yPct, wPct, hPct }, m.flip), frame);
        },
    });
}

// --- draw-arming (Add blur zone) ----------------------------------------------

/** True while the "draw a zone" mode is armed (the panel button toggles it). */
export function isBlurDrawArmed(): boolean {
    return armed;
}

/** Arms draw mode: a capture layer appears over every visible tile; the next
 *  drag (or tap) creates a region on that tile's channel. Escape or a second
 *  call disarms. No-op outside export-mode. */
export function toggleBlurDraw(): void {
    if (armed) {
        disarmDraw();
        return;
    }
    if (!blurEditorActive()) return;
    // The crop editor owns tile surfaces and the video transform - the two
    // editors must not share a tile. Close it before arming.
    exitCropEditIfOpen();
    drawOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    armed = true;
    drawChannels = [...state.composition.channelOrder];
    pauseBlurVideos();
    for (const ch of state.composition.channelOrder) {
        const tile = channelTileFor(ch);
        if (tile.hidden) continue;
        const layer = document.createElement("div");
        layer.className = "blur-draw-layer";
        layer.tabIndex = 0;
        layer.setAttribute("role", "button");
        const trip = activeTrip();
        const channelName = trip ? ` · ${channelDisplayLabel(ch, trip)}` : "";
        layer.setAttribute("aria-label", `${t("export.blur.add")}${channelName}`);
        layer.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            pauseBlurVideos();
            const frame = channelPresentedFrame(ch, true);
            if (!frame) return;
            const bounds = layer.getBoundingClientRect();
            const x = bounds.left + bounds.width / 2;
            const y = bounds.top + bounds.height / 2;
            finishDraw(ch, layer, x, y, x, y, frame);
        });
        const hint = document.createElement("div");
        hint.className = "blur-draw-hint";
        hint.textContent = t("export.blur.drawHint");
        layer.appendChild(hint);
        attachDrawDrag(ch, layer);
        tile.appendChild(layer);
        drawLayerEls.push(layer);
    }
    notifyExportStateChanged();
    const firstLayer = drawLayerEls[0];
    firstLayer?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    firstLayer?.focus({ preventScroll: true });
}

function disarmDraw(): void {
    if (!armed) return;
    armed = false;
    const hadDrawFocus = drawLayerEls.some((el) => el.contains(document.activeElement));
    for (const el of drawLayerEls) el.remove();
    drawLayerEls = [];
    drawChannels = [];
    if (hadDrawFocus && drawOpener?.isConnected) drawOpener.focus({ preventScroll: true });
    drawOpener = null;
    notifyExportStateChanged();
}

function attachDrawDrag(ch: Channel, layer: HTMLDivElement): void {
    let sx = 0;
    let sy = 0;
    let marquee: HTMLDivElement | null = null;
    let frame: ChannelPresentedFrame | null = null;
    // Post-drag synthetic click must not reach the tile (audio swap / pip).
    layer.addEventListener("click", (e) => e.stopPropagation());
    attachPointerDrag(layer, {
        onStart: (e) => {
            if (!blurEditorActive()) return false;
            pauseBlurVideos();
            frame = channelPresentedFrame(ch, true);
            if (!frame) return false;
            sx = e.clientX;
            sy = e.clientY;
            marquee = document.createElement("div");
            marquee.className = "blur-box blur-box--marquee";
            layer.appendChild(marquee);
            e.preventDefault();
            // Without this the pointerdown bubbles to the tile, whose PiP
            // drag accepts it and steals the pointer capture - the inset
            // moves under the marquee and this layer's drag never finishes.
            e.stopPropagation();
            return true;
        },
        onMove: (e) => {
            if (!marquee) return;
            pauseBlurVideos();
            const r = layer.getBoundingClientRect();
            const x = Math.min(sx, e.clientX) - r.left;
            const y = Math.min(sy, e.clientY) - r.top;
            marquee.style.left = `${x}px`;
            marquee.style.top = `${y}px`;
            marquee.style.width = `${Math.abs(e.clientX - sx)}px`;
            marquee.style.height = `${Math.abs(e.clientY - sy)}px`;
            marquee.hidden = false;
        },
        onEnd: (e) => {
            marquee?.remove();
            marquee = null;
            if (frame && e.type === "pointerup") finishDraw(ch, layer, sx, sy, e.clientX, e.clientY, frame);
            frame = null;
        },
    });
}

function finishDraw(
    ch: Channel,
    layer: HTMLDivElement,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    frame: ChannelPresentedFrame,
): void {
    if (!armed || !layer.isConnected) return;
    if (!blurEditorActive() || !samePresentedFrame(frame, channelPresentedFrame(ch, true))) {
        disarmDraw();
        return;
    }
    const trip = activeTrip();
    if (!trip) {
        disarmDraw();
        return;
    }
    const layerRect = layer.getBoundingClientRect();
    const a = tilePointToSource(ch, Math.min(x0, x1) - layerRect.left, Math.min(y0, y1) - layerRect.top);
    const b = tilePointToSource(ch, Math.max(x0, x1) - layerRect.left, Math.max(y0, y1) - layerRect.top);
    if (!a || !b) {
        disarmDraw();
        return;
    }
    let rect: CropRect;
    if (Math.hypot(x1 - x0, y1 - y0) < TAP_DRAG_PX) {
        // Tap: plant a default-sized box centered on the point (the touch
        // affordance - precision drag-drawing with a finger is miserable).
        const m = tileMapping(ch);
        if (!m) {
            disarmDraw();
            return;
        }
        // Square in source PIXELS, sized off the frame height: hPct stays
        // TAP_BOX_FRAC, wPct compensates the aspect (clamped for extremes).
        const hPct = TAP_BOX_FRAC;
        const wPct = Math.min(1, TAP_BOX_FRAC * (m.vh / m.vw));
        rect = {
            xPct: Math.max(0, Math.min(1 - wPct, a.x - wPct / 2)),
            yPct: Math.max(0, Math.min(1 - hPct, a.y - hPct / 2)),
            wPct,
            hPct,
        };
    } else {
        rect = {
            xPct: Math.min(a.x, b.x),
            yPct: Math.min(a.y, b.y),
            wPct: Math.max(MIN_REGION, Math.abs(b.x - a.x)),
            hPct: Math.max(MIN_REGION, Math.abs(b.y - a.y)),
        };
    }
    const now = frame.contentSec;
    const dur = trip.timeline.contentDurationSec;
    // Retain the conservative back-off for engines without presentation PTS,
    // and keep the minimum span when drawing near the trip end.
    let startSec = Math.max(0, Math.min(now, dur) - ZONE_START_PLAYHEAD_BACKOFF_SEC);
    const endSec = Math.min(dur, Math.max(now + DEFAULT_ZONE_SPAN_SEC, startSec + MIN_ZONE_SPAN_SEC));
    if (endSec - startSec < MIN_ZONE_SPAN_SEC) startSec = Math.max(0, endSec - MIN_ZONE_SPAN_SEC);
    const region = createBlurRegion(ch, exportPanelState.blurStyle, startSec, endSec, now, rect);
    // Order matters: the region must be in the store BEFORE disarmDraw's
    // export-state notify, or the quality-tier estimate recomputes without it
    // and keeps the stale "Original (stream copy)" label until the next edit.
    addBlurRegion(region);
    disarmDraw();
    requestAnimationFrame(() => {
        if (blurEditorActive()) tileUis.get(ch)?.boxes.get(region.id)?.focus({ preventScroll: true });
    });
}

// Per-slot crop / zoom / aspect editing in export-mode.
//
// Double-click a tile (export-mode) to enter crop edit: a draggable crop rect
// with corner handles plus an aspect toolbar. The rect is stored in source
// coords as composition.perSlotCrops[slotIdx] ({xPct,yPct,wPct,hPct}).
//
// Two display states inside the editor, toggled by whether a rect/handle is
// being DRAGGED (cropDragging):
//  - WHILE DRAGGING the video shows the FULL source frame, the rect sits at the
//    crop region's source coords with the outside dimmed (.crop-rect box-shadow).
//    The rect then reads as "select this region of the original" - which is also
//    exactly what the handles compute (pointer math is in full-frame coords; a
//    zoomed frame would make them lie).
//  - WHEN NOT DRAGGING (idle: on enter, right after release, after an aspect
//    preset) the stored crop is shown as an honest WYSIWYG preview: the video
//    is clipped to the crop region (clip-path) and scaled/translated (transform)
//    so the crop lands exactly where the export pipeline's drawMain places it -
//    keep-aspect-fit into the output frame, with letterbox bars (the grid's
//    black background) where the crop aspect differs from the output. The rect
//    frames that result. Grabbing a handle switches back to the source view
//    (rect snaps to the crop's source coords).
//
// So the result preview updates the moment a drag is released - no separate
// "exit editor" step needed.
//
// We deliberately do NOT use CSS object-view-box: it is effectively unsupported
// on <video> (spec/impl target <img>; Chromium leaves the video uncropped), so
// it set the property but never rendered the crop. transform + clip-path work
// on video (same mechanism as the digital-zoom feature). The crop preview owns
// --video-crop-transform and digital zoom owns --video-zoom-transform, so a
// crop sync never clears a zoom. Zoom is reset and suspended in export mode,
// so the two transforms never stack.

import { flipCropRect } from "../camera-flip.js";
import { cameraFlipForChannel } from "./camera-flip-pref.js";
import { t } from "../i18n/index.js";
import type { Channel } from "../parsers/types.js";
import { computeAutoCrop, type CropRect } from "../transcode/compose.js";
import { aspectRatio, type AspectId } from "../transcode/types.js";

import { ALL_CHANNELS, channelPlayers, channelTileFor, dom } from "./dom.js";
import { prefersReducedMotion } from "./media-queries.js";
import { attachPointerDrag } from "./pointer-drag.js";
import { containRect, type Rect } from "./video-geometry.js";
import { notifyExportStateChanged, subscribeExportState } from "./export-state.js";
import { pausePlayback } from "./playback-pause.js";
import { mainChannel, state } from "./state.js";

const MIN_CROP = 0.05; // smallest crop dimension as a fraction of source
const ASPECT_PRESETS: string[] = ["free", "original", "16:9", "9:16", "1:1"];

// Preset value doubles as the button label; only the two word presets need
// localization (ratios like "16:9" are universal).
function aspectLabel(preset: string): string {
    if (preset === "free") return t("export.crop.aspect.free");
    if (preset === "original") return t("export.crop.aspect.original");
    return preset;
}

let editingChannel: Channel | null = null;
let editorEl: HTMLDivElement | null = null;
// True while a rect/handle is actively dragged: the edited video then shows the
// full source frame (see the header). false = idle, showing the zoomed result.
let cropDragging = false;
// Locked output aspect for handle-resize. null = free (unconstrained). Set by
// the aspect-preset buttons; transient per editor session (reset on enter/exit,
// like the other module state above). When set, attachHandleDrag keeps the crop
// at this display ratio so a 1:1 pick stays 1:1 while dragging.
let editingAspect: AspectId | null = null;

export function initPlayerCrop(): void {
    // Double-click a tile in export-mode enters crop edit for that slot.
    dom.videoGrid.addEventListener("dblclick", (e) => {
        if (!state.exportModeOpen) return;
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;
        const tile = target.closest<HTMLElement>(".video-tile");
        if (!tile || tile.hidden) return;
        const ch = tile.dataset.channel as Channel | undefined;
        if (!ch || state.composition.channelOrder.indexOf(ch) < 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (editingChannel === ch) exitCropEdit();
        else enterCropEdit(ch);
    });

    // Capture phase + preventDefault so Escape dismisses ONLY the crop editor,
    // not the whole export panel: the export-mode Escape handler (export-mode.ts)
    // bails on defaultPrevented, and capture guarantees we run before its
    // bubble-phase listener regardless of init order. A second Escape (no editor
    // open) then closes export mode as before.
    document.addEventListener(
        "keydown",
        (e) => {
            if (e.key === "Escape" && editingChannel) {
                e.preventDefault();
                e.stopPropagation();
                exitCropEdit();
            }
        },
        { capture: true },
    );

    // Leaving export-mode (or any state change) ends edit and re-syncs the
    // crop previews from state.
    subscribeExportState(() => {
        if (!state.exportModeOpen && editingChannel) exitCropEdit();
        syncCropPreviews();
    });

    // The crop preview transform + the editor rect are computed in tile px, so
    // they must be recomputed when the tile resizes (sidebar drag, chart toggle,
    // fullscreen, window resize). No-op outside export-mode (syncCropPreviews
    // clears, layoutEditor bails without an open editor).
    if (typeof ResizeObserver !== "undefined" && dom.videoGrid) {
        const ro = new ResizeObserver(() => {
            syncCropPreviews();
            layoutEditor();
        });
        ro.observe(dom.videoGrid);
    }
}

/**
 * Enters crop-edit for the active channel's tile. The export-panel "Crop frame"
 * button calls this; the double-click-a-tile gesture stays as an alternative
 * (and is the only way to reach a non-main slot in split layouts). Picks the
 * main channel when it is part of the current composition, else the first slot.
 * No-op outside export-mode or when already editing that channel.
 */
export function enterCropEditMain(): void {
    if (!state.exportModeOpen) return;
    const order = state.composition.channelOrder;
    if (order.length === 0) return;
    const main = mainChannel();
    const ch = order.indexOf(main) >= 0 ? main : order[0]!;
    if (editingChannel === ch) return;
    enterCropEdit(ch);
}

/** Closes the crop editor if one is open. The blur-zone draw mode calls this
 *  before arming - the two editors must not fight over a tile's surface and
 *  pointer events. No-op when no editor is open. */
export function exitCropEditIfOpen(): void {
    if (editingChannel) exitCropEdit();
}

/** Applies/clears the crop preview (transform + clip-path) on every channel video. */
export function syncCropPreviews(): void {
    for (const ch of ALL_CHANNELS) {
        const slotIdx = state.composition.channelOrder.indexOf(ch);
        const crop = slotIdx >= 0 ? state.composition.perSlotCrops[slotIdx] : null;
        // Full source frame only for the channel whose rect is being DRAGGED
        // right now (so the selection reads against the original) and outside
        // export-mode. Every other case shows the stored crop as the result.
        const showFull = !state.exportModeOpen || (ch === editingChannel && cropDragging);
        applyCropPreviewToChannel(ch, showFull ? null : (crop ?? null));
    }
}

/**
 * Honest WYSIWYG crop preview on a channel's <video>: clips it to the crop
 * region and scales/translates so the crop lands exactly where drawMain places
 * it - keep-aspect-fit into the tile (= the slot/output frame), with the
 * surrounding letterbox showing the grid's black background. crop=null clears
 * the preview (full frame). See the file header for why transform+clip-path
 * instead of object-view-box.
 */
function applyCropPreviewToChannel(ch: Channel, crop: CropRect | null): void {
    const v = channelPlayers[ch];
    if (!v) return;
    if (!crop) {
        v.style.removeProperty("--video-crop-transform");
        v.style.removeProperty("transform-origin");
        v.style.removeProperty("clip-path");
        return;
    }
    const tile = channelTileFor(ch);
    const tileW = tile.clientWidth;
    const tileH = tile.clientHeight;
    // Full source frame as displayed (object-fit:contain) inside the tile.
    const disp = videoDisplayRect(ch, tile);
    // Crop sub-rect within that displayed frame, in tile px (pre-transform).
    const subX = disp.x + crop.xPct * disp.w;
    const subY = disp.y + crop.yPct * disp.h;
    const subW = crop.wPct * disp.w;
    const subH = crop.hPct * disp.h;
    if (tileW <= 0 || tileH <= 0 || subW <= 0 || subH <= 0) {
        v.style.removeProperty("--video-crop-transform");
        v.style.removeProperty("clip-path");
        return;
    }
    // Where the crop lands in the output frame: the same keep-aspect fit the
    // export uses (resultContentRect == containRect of the crop aspect in the
    // tile). Map the crop sub-rect onto it with scale + translate.
    const target = resultContentRect(ch, tile);
    const scale = target.w / subW;
    const tx = target.x - scale * subX;
    const ty = target.y - scale * subY;
    // Clip the video to the crop sub-rect (local, pre-transform coords) so the
    // excluded source does not bleed into the bars; the bars then show the
    // grid's black background - matching the export's black letterbox.
    const sourceCrop = flipCropRect(crop, cameraFlipForChannel(ch));
    const top = disp.y + sourceCrop.yPct * disp.h;
    const left = disp.x + sourceCrop.xPct * disp.w;
    const right = tileW - left - subW;
    const bottom = tileH - top - subH;
    v.style.transformOrigin = "0 0";
    v.style.setProperty(
        "--video-crop-transform",
        `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`,
    );
    v.style.clipPath = `inset(${top.toFixed(2)}px ${right.toFixed(2)}px ${bottom.toFixed(2)}px ${left.toFixed(2)}px)`;
}

function slotIdxOf(ch: Channel): number {
    return state.composition.channelOrder.indexOf(ch);
}

function getCrop(ch: Channel): CropRect {
    const idx = slotIdxOf(ch);
    return state.composition.perSlotCrops[idx] ?? { xPct: 0, yPct: 0, wPct: 1, hPct: 1 };
}

function setCrop(ch: Channel, crop: CropRect | null): void {
    const idx = slotIdxOf(ch);
    if (idx < 0) return;
    state.composition.perSlotCrops[idx] = crop;
    // Intentionally NOT applying the preview transform here. The video view is
    // driven by beginCropDrag/endCropDrag (full source while dragging, result on
    // release); setCrop only writes the crop value, leaving the live view to those.
}

/** Source frame aspect (w/h) for a channel, falling back to the tile aspect. */
function sourceAspect(ch: Channel, tile: HTMLElement): number {
    const v = channelPlayers[ch];
    if (v && v.videoWidth > 0 && v.videoHeight > 0) return v.videoWidth / v.videoHeight;
    return tile.clientWidth / Math.max(1, tile.clientHeight);
}

/** The full source frame's contain-fit rect inside the tile (drag-view geometry). */
function videoDisplayRect(ch: Channel, tile: HTMLElement): Rect {
    return containRect(sourceAspect(ch, tile), tile.clientWidth, tile.clientHeight);
}

/**
 * Contain-fit rect of the crop result inside the tile (idle-view geometry).
 * This is where the crop lands in the output frame - the same keep-aspect fit
 * the export's drawMain uses. The crop region's aspect is sourceAspect *
 * (wPct/hPct); the rect frames exactly that, so it doubles as the editor rect
 * AND the target the crop-preview transform maps the video onto.
 */
function resultContentRect(ch: Channel, tile: HTMLElement): Rect {
    const crop = getCrop(ch);
    const cropAspect = sourceAspect(ch, tile) * (crop.wPct / Math.max(1e-6, crop.hPct));
    return containRect(cropAspect, tile.clientWidth, tile.clientHeight);
}

function enterCropEdit(ch: Channel): void {
    exitCropEdit();
    editingChannel = ch;
    cropDragging = false;
    // Start unlocked: a fresh editor session does not infer a lock from the
    // stored rect (a square crop is indistinguishable from a 1:1-locked one).
    editingAspect = null;
    pausePlayback();
    const tile = channelTileFor(ch);
    editorEl = buildEditor(ch);
    tile.appendChild(editorEl);
    tile.classList.add("crop-editing");
    // Start idle: show the current crop zoomed, rect framing the result.
    applyCropView(ch);
    markActiveAspect("free");
    playAttentionPulse(editorEl);
}

/**
 * Draws the eye to the crop rect/handles right after mount: a default crop is
 * full-frame, so entering the editor otherwise changes nothing on screen and
 * reads as broken. Skipped under prefers-reduced-motion - the hint text plus
 * the rect/handles are enough without motion.
 */
function playAttentionPulse(editor: HTMLDivElement): void {
    if (prefersReducedMotion()) return;
    const rect = editor.querySelector<HTMLElement>(".crop-rect");
    if (!rect) return;
    editor.classList.add("crop-attention");
    rect.addEventListener(
        "animationend",
        () => {
            editor.classList.remove("crop-attention");
        },
        { once: true },
    );
}

function exitCropEdit(): void {
    const ch = editingChannel;
    if (ch) {
        channelTileFor(ch).classList.remove("crop-editing");
    }
    editorEl?.remove();
    editorEl = null;
    editingChannel = null;
    cropDragging = false;
    editingAspect = null;
    // Refresh previews from state - the edited channel keeps its zoomed crop.
    // No-op outside export-mode.
    if (ch) {
        syncCropPreviews();
        notifyExportStateChanged();
    }
}

/**
 * Applies the current view for the edited channel: while dragging, the full
 * source frame with the rect at the crop's source coords; idle, the zoomed crop
 * result with the rect framing it. layoutEditor reads cropDragging for geometry.
 */
function applyCropView(ch: Channel): void {
    // is-dragging gates the .crop-rect dim (box-shadow) - it should darken the
    // excluded source only while selecting, not the letterbox bars of the idle
    // zoomed result (where overlays/watermark sit).
    editorEl?.classList.toggle("is-dragging", cropDragging);
    applyCropPreviewToChannel(ch, cropDragging ? null : (state.composition.perSlotCrops[slotIdxOf(ch)] ?? null));
    layoutEditor();
    // The video's effective content rect just changed (full source <-> zoomed
    // crop), so the export overlays must re-anchor to it. notify wakes
    // player-overlays' syncPlayerOverlays (and is a no-op-ish for the rest).
    notifyExportStateChanged();
}

/** Pointer pressed a rect/handle: switch to the full-source drag view. */
function beginCropDrag(ch: Channel): void {
    cropDragging = true;
    applyCropView(ch);
}

/** Drag released: switch to the zoomed result view (the user's "on release"). */
function endCropDrag(ch: Channel): void {
    cropDragging = false;
    applyCropView(ch);
}

function buildEditor(ch: Channel): HTMLDivElement {
    const root = document.createElement("div");
    root.className = "crop-editor";

    // Same copy as the export-panel note (export-panel.ts renderCropGroup), but
    // anchored on the tile itself: that panel can be scrolled out of view (or,
    // on mobile, sits below the video) while the user is looking at the editor.
    const hint = document.createElement("div");
    hint.className = "crop-editor-hint";
    hint.textContent = t("export.crop.hint");
    root.appendChild(hint);

    const rect = document.createElement("div");
    rect.className = "crop-rect";
    root.appendChild(rect);

    for (const corner of ["tl", "tr", "bl", "br"] as const) {
        const h = document.createElement("div");
        h.className = `crop-handle crop-handle--${corner}`;
        h.dataset.corner = corner;
        rect.appendChild(h);
        attachHandleDrag(ch, h, corner);
    }
    attachRectDrag(ch, rect);

    const bar = document.createElement("div");
    bar.className = "crop-aspect-bar";
    for (const a of ASPECT_PRESETS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "crop-aspect-btn";
        btn.dataset.preset = a;
        btn.textContent = aspectLabel(a);
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            applyAspectPreset(ch, a);
        });
        bar.appendChild(btn);
    }
    // Primary "Done" action: confirm the crop and dismiss the selector. Same as
    // Escape / re-double-click, but a discoverable button at the selection - the
    // crop value persists (zoomed result stays applied via syncCropPreviews).
    const done = document.createElement("button");
    done.type = "button";
    done.className = "crop-done-btn";
    done.textContent = t("export.crop.done");
    done.addEventListener("click", (e) => {
        e.stopPropagation();
        exitCropEdit();
    });
    bar.appendChild(done);
    root.appendChild(bar);
    return root;
}

/** Positions the crop rect overlay. Geometry depends on cropDragging (see the
 *  header): drag = crop region within the full source frame; idle = the whole
 *  zoomed crop result. */
function layoutEditor(): void {
    if (!editingChannel || !editorEl) return;
    const tile = channelTileFor(editingChannel);
    const rect = editorEl.querySelector<HTMLElement>(".crop-rect");
    if (!rect) return;
    if (cropDragging) {
        const disp = videoDisplayRect(editingChannel, tile);
        const crop = getCrop(editingChannel);
        rect.style.left = `${disp.x + crop.xPct * disp.w}px`;
        rect.style.top = `${disp.y + crop.yPct * disp.h}px`;
        rect.style.width = `${crop.wPct * disp.w}px`;
        rect.style.height = `${crop.hPct * disp.h}px`;
    } else {
        const c = resultContentRect(editingChannel, tile);
        rect.style.left = `${c.x}px`;
        rect.style.top = `${c.y}px`;
        rect.style.width = `${c.w}px`;
        rect.style.height = `${c.h}px`;
    }
}

function attachRectDrag(ch: Channel, rect: HTMLElement): void {
    let startX = 0;
    let startY = 0;
    let base: CropRect = { xPct: 0, yPct: 0, wPct: 1, hPct: 1 };
    attachPointerDrag(rect, {
        onStart: (e) => {
            if ((e.target as HTMLElement)?.classList.contains("crop-handle")) return false;
            startX = e.clientX;
            startY = e.clientY;
            base = { ...getCrop(ch) };
            e.preventDefault();
            e.stopPropagation();
            beginCropDrag(ch);
            return true;
        },
        onMove: (e) => {
            const disp = videoDisplayRect(ch, channelTileFor(ch));
            if (disp.w <= 0 || disp.h <= 0) return;
            const dx = (e.clientX - startX) / disp.w;
            const dy = (e.clientY - startY) / disp.h;
            const xPct = Math.max(0, Math.min(1 - base.wPct, base.xPct + dx));
            const yPct = Math.max(0, Math.min(1 - base.hPct, base.yPct + dy));
            setCrop(ch, { ...base, xPct, yPct });
            layoutEditor();
        },
        onEnd: () => endCropDrag(ch),
    });
}

function attachHandleDrag(ch: Channel, handle: HTMLElement, corner: "tl" | "tr" | "bl" | "br"): void {
    attachPointerDrag(handle, {
        onStart: (e) => {
            e.preventDefault();
            e.stopPropagation();
            beginCropDrag(ch);
            return true;
        },
        onMove: (e) => {
            const tile = channelTileFor(ch);
            const tileRect = tile.getBoundingClientRect();
            const disp = videoDisplayRect(ch, tile);
            if (disp.w <= 0 || disp.h <= 0) return;
            // Pointer in source-normalized coords (clamped to the displayed video).
            const px = Math.max(0, Math.min(1, (e.clientX - tileRect.left - disp.x) / disp.w));
            const py = Math.max(0, Math.min(1, (e.clientY - tileRect.top - disp.y) / disp.h));
            const c = getCrop(ch);
            // Locked aspect: keep the crop at the preset display ratio, anchored at
            // the corner opposite the dragged one. "free"/"original" leave
            // editingAspect null and fall through to the unconstrained resize below.
            if (editingAspect) {
                const r = aspectRatio(editingAspect) / sourceAspect(ch, tile); // target wPct/hPct
                const anchorX = corner === "tl" || corner === "bl" ? c.xPct + c.wPct : c.xPct;
                const anchorY = corner === "tl" || corner === "tr" ? c.yPct + c.hPct : c.yPct;
                let w = Math.abs(px - anchorX);
                let h = Math.abs(py - anchorY);
                // Bind to the ratio along whichever axis the pointer moved more.
                if (w >= h * r) h = w / r;
                else w = h * r;
                // Clamp to the room available from the anchor, preserving the ratio
                // and keeping both dimensions >= MIN_CROP.
                const availW = corner === "tl" || corner === "bl" ? anchorX : 1 - anchorX;
                const availH = corner === "tl" || corner === "tr" ? anchorY : 1 - anchorY;
                w = Math.min(w, availW, availH * r);
                w = Math.max(w, MIN_CROP, MIN_CROP * r);
                h = w / r;
                if (h > availH) {
                    h = availH;
                    w = h * r;
                }
                const nx = corner === "tl" || corner === "bl" ? anchorX - w : anchorX;
                const ny = corner === "tl" || corner === "tr" ? anchorY - h : anchorY;
                setCrop(ch, { xPct: nx, yPct: ny, wPct: w, hPct: h });
                layoutEditor();
                return;
            }
            let { xPct, yPct, wPct, hPct } = c;
            const right = xPct + wPct;
            const bottom = yPct + hPct;
            if (corner === "tl" || corner === "bl") {
                xPct = Math.min(px, right - MIN_CROP);
                wPct = right - xPct;
            } else {
                wPct = Math.max(MIN_CROP, px - xPct);
            }
            if (corner === "tl" || corner === "tr") {
                yPct = Math.min(py, bottom - MIN_CROP);
                hPct = bottom - yPct;
            } else {
                hPct = Math.max(MIN_CROP, py - yPct);
            }
            setCrop(ch, { xPct, yPct, wPct, hPct });
            layoutEditor();
        },
        onEnd: () => endCropDrag(ch),
    });
}

/**
 * Snaps the crop to a centered rect of the chosen aspect. "free" keeps the
 * current rect; "original" clears the crop (full frame). Concrete ratios
 * (16:9 etc) center the largest matching rect inside the source.
 */
function applyAspectPreset(ch: Channel, aspect: string): void {
    // Aspect buttons are clicked while idle (no active drag), so show the result
    // view after changing the crop (applyCropView reads cropDragging === false).
    markActiveAspect(aspect);
    if (aspect === "free") {
        // Unlock: keep the current rect, let handles resize freely.
        editingAspect = null;
        applyCropView(ch);
        return;
    }
    if (aspect === "original") {
        // Reset to full frame, unlocked.
        editingAspect = null;
        setCrop(ch, null);
        applyCropView(ch);
        return;
    }
    // Lock to this ratio: snap to a centered rect AND remember the aspect so
    // attachHandleDrag keeps it while resizing. Fall back to 16:9 source dims
    // when the video has not reported its size yet.
    editingAspect = aspect as AspectId;
    const v = channelPlayers[ch];
    let srcW = 16;
    let srcH = 9;
    if (v && v.videoWidth > 0 && v.videoHeight > 0) {
        srcW = v.videoWidth;
        srcH = v.videoHeight;
    }
    setCrop(ch, computeAutoCrop(srcW, srcH, aspect as AspectId));
    applyCropView(ch);
}

/** Highlights the active aspect-preset button (the locked ratio, or "free").
 *  Matches by the data-preset set in buildEditor. No-op without an open editor. */
function markActiveAspect(aspect: string): void {
    if (!editorEl) return;
    for (const btn of editorEl.querySelectorAll<HTMLElement>(".crop-aspect-btn")) {
        btn.classList.toggle("is-active", btn.dataset.preset === aspect);
    }
}

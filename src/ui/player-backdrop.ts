// Blurred background of the export preview. With a blurred letterbox the file
// fills the space around the cameras with the main camera blurred over the
// whole frame (drawCameraComposition in transcode/compose.ts). This canvas
// under the tiles paints the same picture with the same helper, privacy
// patches censored out of the blur included, so the editor shows what the
// file gets.

import { resolveRegionBlursAt } from "../blur-regions.js";
import { applyCanvasFlip } from "../camera-flip.js";
import { type BlurHelper, createBlurHelper, fillBlurredCover } from "../transcode/compose.js";
import { activeEffectiveBlurRegions, previewExportStartSec } from "./blur-effective.js";
import { cameraFlipForChannel } from "./camera-flip-pref.js";
import { channelPlayers, dom } from "./dom.js";
import { exportPanelState } from "./export-state.js";
import { channelPresentedFrame } from "./player-frame-time.js";
import { backdropChannel } from "./player-layout.js";
import { state } from "./state.js";

let canvas: HTMLCanvasElement | null = null;
let context: CanvasRenderingContext2D | null = null;
let helper: BlurHelper | null = null;
let frameRequest = 0;
// What the canvas shows now; a frame with the same key needs no repaint.
let paintedKey = "";

function isActive(): boolean {
    return state.exportModeOpen && exportPanelState.letterboxFill === "blur";
}

function ensureCanvas(): HTMLCanvasElement {
    if (canvas) return canvas;
    canvas = document.createElement("canvas");
    canvas.className = "grid-backdrop";
    canvas.setAttribute("aria-hidden", "true");
    canvas.hidden = true;
    // First in the grid, so every tile paints over it.
    dom.videoGrid.prepend(canvas);
    context = canvas.getContext("2d");
    return canvas;
}

/** Shows or hides the background to match export mode and the letterbox
 *  fill, and repaints after a settings change. Cheap; call on any change. */
export function syncPlayerBackdrop(): void {
    paintedKey = "";
    if (!isActive()) {
        if (frameRequest) cancelAnimationFrame(frameRequest);
        frameRequest = 0;
        if (canvas) canvas.hidden = true;
        return;
    }
    ensureCanvas().hidden = false;
    if (!frameRequest) frameRequest = requestAnimationFrame(tick);
}

// One check per display frame while the background is on: the camera, its
// frame, the box and the privacy zones can each change it.
function tick(): void {
    frameRequest = 0;
    if (!isActive()) return;
    paint();
    frameRequest = requestAnimationFrame(tick);
}

function paint(): void {
    const el = canvas;
    const ctx = context;
    if (!el || !ctx) return;
    const width = dom.videoGrid.clientWidth;
    const height = dom.videoGrid.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const channel = backdropChannel();
    const video = channel ? channelPlayers[channel] : null;
    if (!channel || !video || video.videoWidth === 0 || width === 0 || height === 0) {
        if (paintedKey !== "empty") ctx.clearRect(0, 0, el.width, el.height);
        paintedKey = "empty";
        return;
    }
    const frame = channelPresentedFrame(channel);
    const regions = activeEffectiveBlurRegions();
    const key = `${channel}|${frame?.contentSec ?? video.currentTime}|${width}x${height}@${dpr}`;
    // Zones move under an unchanged frame while being edited: with any zone
    // on the trip, repaint every frame.
    if (key === paintedKey && regions.length === 0) return;
    paintedKey = key;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    helper ??= createBlurHelper();
    const censor =
        frame && regions.length
            ? resolveRegionBlursAt(regions, channel, frame.contentSec, previewExportStartSec(channel, frame.contentSec))
            : null;
    ctx.save();
    applyCanvasFlip(ctx, { x: 0, y: 0, w: width, h: height }, cameraFlipForChannel(channel));
    fillBlurredCover(ctx, video, video.videoWidth, video.videoHeight, 0, 0, width, height, helper, censor);
    ctx.restore();
}

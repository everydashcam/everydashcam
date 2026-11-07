// Still images of the player (not an OS screenshot - player UI is excluded).
// The button, its menu and the S / Shift+S hotkeys all call captureStill.
//
// A still is drawn like one export frame (drawCameraComposition): each tile
// shows a camera's picture, or a part of it, at the camera's own resolution.
// What the still shows:
//  - "view": what the player shows. In export mode, the frame the export would
//    write (output size, crops, privacy blur, overlays, watermark). Otherwise
//    the zoomed part of a zoomed camera, or all cameras as arranged.
//  - "camera": one camera's whole picture; privacy blur applies in export mode.
// Files are JPG named everydashcam_YYYYMMDD_HHMMSS_<content>.jpg on the
// display clock (camera clock when known - matches the trip headers in the
// sidebar). The clipboard gets PNG, the only image type browsers copy.

import { resolveRegionBlursAt } from "../blur-regions.js";
import { downloadBlob } from "../download.js";
import { t } from "../i18n/index.js";
import type { I18nKey } from "../i18n/keys.js";
import { createLogger } from "../log.js";
import type { Channel } from "../parsers/types.js";
import { type CameraArrangement, planCompositionSpans } from "../transcode/camera-composition.js";
import {
    type CompositionCamera,
    type CompositionFrame,
    createBlurHelper,
    createRegionBlurHelper,
    type CropRect,
    drawCameraComposition,
} from "../transcode/compose.js";
import { drawMapOverlay, drawMapPlaceholder } from "../transcode/map-overlay.js";
import { createOverlayFrameResolver, hasAnyOverlay } from "../transcode/overlay-pipeline-helpers.js";
import { ensureOverlayFontsReady } from "../transcode/overlay-styles.js";
import { drawTelemetryOverlays } from "../transcode/telemetry-overlays.js";
import type { OverlayPipelineArgs, WatermarkAnchor } from "../transcode/types.js";
import { drawWatermark, ensureWatermarkFontReady } from "../transcode/watermark.js";
import { displayClockDate, type Trip } from "../trips.js";
import { activeEffectiveBlurRegions, previewExportStartSec } from "./blur-effective.js";
import { cameraExportAspect } from "./camera-aspect.js";
import { cameraFlipForChannel } from "./camera-flip-pref.js";
import { channelPlayers, dom, effectiveMasterChannel } from "./dom.js";
import { buildOverlayPipelineArgs, resolveOutputDims, watermarkAnchorForExport } from "./export-flow.js";
import { exportPanelState } from "./export-state.js";
import { notify } from "./notifications.js";
import { previewMapCanvas } from "./player-overlays.js";
import { viewerCameraLayout } from "./player-layout.js";
import { videoAttachedFile } from "./player-video-src.js";
import { isCameraOnGrid, zoomedCameraView } from "./player-zoom.js";
import { activeCandidate, activeTrip, state, visibleChannels } from "./state.js";
import { singleCameraStill, type StillLayout, viewerStill } from "./still-layout.js";

const log = createLogger("player");

/** What a still image shows. */
export type StillContent = { kind: "view" } | { kind: "camera"; channel: Channel };

/** Where a still image goes. */
export type StillDelivery = "download" | "clipboard";

/**
 * Clock of the active trip, read through callbacks so this module stays out
 * of the playback core's import graph. Every callback runs AFTER the frame
 * waits, so the filename and privacy geometry match the frame actually drawn,
 * not the moment of the click (the waits leave time to switch trips).
 */
export interface CaptureClock {
    getTripStartUtcSec: () => number | null;
    getTripCurrentSec: () => number;
    /** Content second of the frame a camera presents; `mediaTime` is the
     *  presentation time the compositor reported for it, when known. Called
     *  when the camera's pixels are copied, so it describes those pixels. */
    getFrameContentSec: (channel: Channel, mediaTime?: number) => number | null;
}

const JPEG_QUALITY = 0.92;
const READY_WAIT_MS = 1500;
const FRAME_CALLBACK_WAIT_MS = 250;
const SEEK_SETTLE_WAIT_MS = 1500;

/** A camera's current frame, confirmed drawable. */
interface SettledFrame {
    video: HTMLVideoElement;
    file: File | undefined;
    src: string;
    /** Presentation time the compositor reported, when it did. */
    mediaTime: number | undefined;
    /** Media position when the frame was confirmed. */
    position: number;
}

/** One camera's pixels, copied together with the time of the frame they show. */
interface FrameSnapshot {
    pixels: HTMLCanvasElement;
    /** Content second of the copied frame, or null when it is unknown. */
    contentSec: number | null;
}

/** A rendered still and where it would be saved. */
interface RenderedStill {
    blob: Blob;
    filename: string;
}

/**
 * Saves or copies a still image. Resolves when the file was handed to the
 * browser or the clipboard write settled; a still that cannot be drawn now is
 * logged and resolves too (callers fire and forget). The clipboard write
 * starts synchronously so it keeps the click's user activation: Safari rejects
 * a clipboard write that starts after an await, while every engine accepts a
 * write whose image is still being drawn.
 */
export function captureStill(content: StillContent, delivery: StillDelivery, clock: CaptureClock): Promise<void> {
    if (delivery === "clipboard") return copyStill(content, clock);
    return renderStill(content, clock, "image/jpeg").then((still) => {
        if (!still) return;
        downloadBlob(still.blob, still.filename);
        log.info("capture saved", { filename: still.filename, bytes: still.blob.size, content: content.kind });
    });
}

/** True when this browser can put an image on the clipboard. Plain-http
 *  self-hosted copies have no Clipboard API at all (no secure context). */
export function canCopyStill(): boolean {
    return typeof ClipboardItem === "function" && typeof navigator.clipboard?.write === "function";
}

function copyStill(content: StillContent, clock: CaptureClock): Promise<void> {
    if (!canCopyStill()) {
        log.warn("capture copy skipped: clipboard images unavailable");
        notify({ severity: "warn", messageKey: "player.captureCopy.failed" });
        return Promise.resolve();
    }
    const png = renderStill(content, clock, "image/png").then((still) => {
        if (!still) throw new Error("still image unavailable");
        return still.blob;
    });
    // The write consumes the rejection; this only keeps it from also being
    // reported as unhandled.
    png.catch(() => {});
    return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(
        () => {
            log.info("capture copied", { content: content.kind });
            notify({ severity: "info", messageKey: "player.captureCopy.done" });
        },
        (err: unknown) => {
            log.warn("capture copy failed", { err: err instanceof Error ? err.message : String(err) });
            notify({ severity: "warn", messageKey: "player.captureCopy.failed" });
        },
    );
}

/**
 * Draws the still image of `content` and encodes it as `mime`. Resolves null
 * when nothing can be drawn now (no ready frame, the trip or a camera's video
 * changed during the waits, privacy geometry unavailable); each cause is
 * logged so a "pressed S, nothing happened" report shows why.
 */
async function renderStill(
    content: StillContent,
    clock: CaptureClock,
    mime: "image/jpeg" | "image/png",
): Promise<RenderedStill | null> {
    const trip = activeTrip();
    const isExportMode = state.exportModeOpen;
    if (!trip) {
        log.warn("capture skipped: no active trip");
        return null;
    }
    const candidates = stillCameras(content, isExportMode).filter(isCameraOnGrid);
    const ctxLog = {
        content: content.kind,
        channels: candidates,
        exportMode: isExportMode,
        paused: channelPlayers[effectiveMasterChannel()].paused,
    };
    if (candidates.length === 0) {
        log.warn("capture skipped: no camera on screen", ctxLog);
        return null;
    }
    // The export settings as of the click, like an export run captures its
    // settings when it starts.
    const exportOverlays =
        isExportMode && content.kind === "view"
            ? { args: buildOverlayPipelineArgs(trip), watermark: watermarkAnchorForExport() }
            : null;
    // Burned-in text must not fall back to a system font for this one frame.
    const fontsReady = exportOverlays ? loadOverlayFonts(exportOverlays) : Promise.resolve();
    const isFrameSettled = (channel: Channel): boolean => clock.getFrameContentSec(channel) !== null;
    const settled = await Promise.all(candidates.map((channel) => settleCurrentFrame(channel, isFrameSettled)));
    await fontsReady;
    // Every camera of the still must be ready: a black tile in place of a
    // camera that is still loading would be a quietly wrong picture, and in
    // export mode its privacy zones could not be placed. The user can retry.
    const frames = new Map<Channel, SettledFrame>();
    for (const [index, channel] of candidates.entries()) {
        const frame = settled[index];
        if (!frame) {
            log.warn("capture skipped: camera frame not ready", { ...ctxLog, channel });
            return null;
        }
        frames.set(channel, frame);
    }
    // The waits above last as long as the slowest camera and the fonts, and a
    // playing camera moves on meanwhile. The still is drawn from copies taken
    // after them, each paired with the time of the frame it holds, so privacy
    // zones and overlays describe the very pixels saved.
    const copies = await Promise.all(candidates.map((channel) => snapshotFrame(channel, frames.get(channel)!, clock)));
    const snapshots = new Map<Channel, FrameSnapshot>();
    for (const [index, channel] of candidates.entries()) {
        const snapshot = copies[index];
        if (snapshot) snapshots.set(channel, snapshot);
    }
    let canvas: HTMLCanvasElement | null = null;
    try {
        if (snapshots.size < candidates.length) {
            // A camera switched source or started seeking before its copy
            // (trip or channel switch, preload slot promotion, a user seek).
            // Capture is a manual action, the user can retry on the live elements.
            log.warn("capture skipped: camera frame changed before it was copied", ctxLog);
        } else if (activeTrip() !== trip || state.exportModeOpen !== isExportMode) {
            log.warn("capture skipped: active video changed during readiness wait", ctxLog);
        } else {
            canvas = drawStill(content, trip, isExportMode, exportOverlays, snapshots, ctxLog);
        }
    } finally {
        releaseSnapshots(snapshots.values());
    }
    if (!canvas) return null;

    const filename = makeStillFilename(
        clock.getTripStartUtcSec(),
        clock.getTripCurrentSec(),
        trip.cameraTzSec ?? null,
        content.kind === "camera" ? content.channel : "frame",
    );
    const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, mime, mime === "image/jpeg" ? JPEG_QUALITY : undefined),
    );
    if (!blob) {
        log.warn("capture skipped: toBlob returned null", { ...ctxLog, canvasW: canvas.width, canvasH: canvas.height });
        return null;
    }
    return { blob, filename };
}

/**
 * Composes the still from the camera copies on a new canvas. Returns null when
 * nothing can be drawn (frame time unknown in export mode, nothing to lay out,
 * no 2d context, drawing threw); each cause is logged.
 */
function drawStill(
    content: StillContent,
    trip: Trip,
    isExportMode: boolean,
    exportOverlays: ExportOverlays | null,
    snapshots: ReadonlyMap<Channel, FrameSnapshot>,
    ctxLog: Record<string, unknown>,
): HTMLCanvasElement | null {
    const contentSecs = new Map<Channel, number>();
    for (const [channel, snapshot] of snapshots) {
        if (snapshot.contentSec !== null) contentSecs.set(channel, snapshot.contentSec);
    }
    // Privacy zones are placed by the content time of the frame each camera
    // shows. Without it the zones of export mode could miss the frame.
    if (isExportMode && contentSecs.size < snapshots.size) {
        log.warn("capture skipped: displayed frame time unavailable", ctxLog);
        return null;
    }

    const plan =
        content.kind === "camera"
            ? cameraPlan(content.channel, snapshots)
            : isExportMode
              ? exportFramePlan(trip, snapshots, contentSecs)
              : viewerPlan(snapshots);
    if (!plan) {
        log.warn("capture skipped: nothing to lay out", ctxLog);
        return null;
    }

    const canvas = document.createElement("canvas");
    canvas.width = plan.layout.width;
    canvas.height = plan.layout.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
        log.warn("capture skipped: 2d context unavailable", ctxLog);
        return null;
    }
    const cameras: Partial<Record<Channel, CompositionCamera>> = {};
    for (const tile of plan.layout.tiles) {
        const snapshot = snapshots.get(tile.channel);
        const sec = contentSecs.get(tile.channel);
        cameras[tile.channel] = {
            sample: snapshot && plan.presentChannels.has(tile.channel) ? copiedFrame(snapshot.pixels) : null,
            crop: plan.crops[tile.channel] ?? null,
            flip: cameraFlipForChannel(tile.channel, trip),
            // In export mode the tiles preview the redaction, so the still must
            // match - otherwise S quietly saves the very plate the user covered.
            regionBlurs:
                isExportMode && sec !== undefined
                    ? resolveRegionBlursAt(
                          activeEffectiveBlurRegions(),
                          tile.channel,
                          sec,
                          previewExportStartSec(tile.channel, sec),
                      )
                    : null,
        };
    }
    try {
        drawCameraComposition(ctx, plan.layout.tiles, cameras, plan.backdrop, canvas.width, canvas.height, {
            fill: plan.fill,
            blurHelper: plan.fill === "blur" ? createBlurHelper() : null,
            regionBlurHelper: createRegionBlurHelper(),
        });
        if (exportOverlays && plan.overlaySec !== null) {
            drawExportOverlays(ctx, trip, exportOverlays, plan.overlaySec, canvas.width, canvas.height);
        }
    } catch (e) {
        // SecurityError if a video is tainted (cross-origin without CORS) - our
        // blob: sources should never trigger this, but log defensively.
        log.error("capture failed: drawing threw", e);
        return null;
    }
    return canvas;
}

/**
 * Cameras whose frames a still of `content` may draw, decided at the click.
 * A zoomed view needs only the zoomed camera; the arranged view and the
 * export frame need every visible one.
 */
function stillCameras(content: StillContent, isExportMode: boolean): Channel[] {
    if (content.kind === "camera") return [content.channel];
    const zoomed = isExportMode ? null : zoomedCameraView();
    return zoomed ? [zoomed.channel] : visibleChannels();
}

/** Geometry and per-camera settings of one still. */
interface StillPlan {
    layout: StillLayout;
    /** Cameras that have a picture in this frame; others draw black. */
    presentChannels: ReadonlySet<Channel>;
    crops: Partial<Record<Channel, CropRect>>;
    backdrop: Channel | null;
    fill: "black" | "blur";
    /** Content second the export overlays describe, or null for no overlays. */
    overlaySec: number | null;
}

function cameraPlan(channel: Channel, snapshots: ReadonlyMap<Channel, FrameSnapshot>): StillPlan | null {
    const snapshot = snapshots.get(channel);
    if (!snapshot) return null;
    return {
        layout: singleCameraStill(channel, snapshot.pixels.width, snapshot.pixels.height),
        presentChannels: new Set([channel]),
        crops: {},
        backdrop: null,
        fill: "black",
        overlaySec: null,
    };
}

/**
 * The player's view outside export mode. A zoomed camera means "this part is
 * what I am looking at": the still is only that part, in the recording's own
 * pixels. Otherwise the cameras as arranged, the first one with a picture at
 * its own resolution.
 */
function viewerPlan(snapshots: ReadonlyMap<Channel, FrameSnapshot>): StillPlan | null {
    const zoomed = zoomedCameraView();
    if (zoomed) {
        const snapshot = snapshots.get(zoomed.channel);
        if (!snapshot) return null;
        const { share } = zoomed;
        return {
            layout: singleCameraStill(zoomed.channel, snapshot.pixels.width, snapshot.pixels.height, share),
            presentChannels: new Set([zoomed.channel]),
            crops: { [zoomed.channel]: { xPct: share.x, yPct: share.y, wPct: share.w, hPct: share.h } },
            backdrop: null,
            fill: "black",
            overlaySec: null,
        };
    }
    const view = viewerCameraLayout();
    if (!view) return null;
    // The frames were settled for a zoomed view that has been reset since:
    // the other cameras would come out black.
    if (view.layout.tiles.some((tile) => isCameraOnGrid(tile.channel) && !snapshots.has(tile.channel))) return null;
    const lead = view.layout.tiles.find((tile) => snapshots.has(tile.channel));
    if (!lead) return null;
    const layout = viewerStill(view.request, view.layout, lead.channel, snapshots.get(lead.channel)!.pixels.width);
    if (!layout) return null;
    return {
        layout,
        presentChannels: new Set(snapshots.keys()),
        crops: {},
        backdrop: null,
        fill: "black",
        overlaySec: null,
    };
}

/**
 * The frame the export would write at the moment the main camera shows:
 * output size, the export's camera plan for that moment (a camera without
 * footage is a black tile, a main camera without footage hands its place
 * over), crops, letterbox fill and overlays.
 */
function exportFramePlan(
    trip: Trip,
    snapshots: ReadonlyMap<Channel, FrameSnapshot>,
    contentSecs: ReadonlyMap<Channel, number>,
): StillPlan | null {
    const master = effectiveMasterChannel();
    const sec = contentSecs.get(master) ?? contentSecs.values().next().value;
    if (sec === undefined) return null;
    const channels = visibleChannels();
    const composition = state.composition;
    const arrangement: CameraArrangement = {
        mode: composition.mode,
        thumbScale: composition.thumbScale,
        allowOverlay: composition.allowOverlay,
        overlayPositions: composition.overlayPositions,
    };
    const aspects: Partial<Record<Channel, number>> = {};
    for (const channel of channels) aspects[channel] = cameraExportAspect(channel);
    const dims = resolveOutputDims();
    const [span] = planCompositionSpans({
        trip,
        channels,
        arrangement,
        aspects,
        width: dims.width,
        height: dims.height,
        startSec: sec,
        // planCompositionSpans needs a range; one millisecond holds one layout.
        endSec: sec + 0.001,
    });
    if (!span) return null;
    const present = new Set<Channel>();
    for (const channel of snapshots.keys()) {
        if (span.presence[channel] !== "absent") present.add(channel);
    }
    return {
        layout: { width: dims.width, height: dims.height, tiles: span.tiles },
        presentChannels: present,
        crops: { ...composition.crops },
        backdrop: span.backdrop,
        fill: exportPanelState.letterboxFill,
        overlaySec: sec,
    };
}

/** Overlays and watermark the export burns into its frames. */
interface ExportOverlays {
    args: OverlayPipelineArgs | null;
    watermark: WatermarkAnchor | null;
}

/** Loads the fonts the export overlays and watermark draw with. */
async function loadOverlayFonts(overlays: ExportOverlays): Promise<void> {
    const { args, watermark } = overlays;
    await Promise.all([
        args && hasAnyOverlay(args) ? ensureOverlayFontsReady(args.localeScript) : undefined,
        watermark ? ensureWatermarkFontReady() : undefined,
    ]);
}

/**
 * Overlays and watermark of the export frame, drawn with the export's own
 * functions over the composed picture. The map is the one the preview shows:
 * waiting for a fresh snapshot would delay the still for a picture the user
 * already sees. Without a GPS fix the map slot gets the export's placeholder.
 */
function drawExportOverlays(
    ctx: CanvasRenderingContext2D,
    trip: Trip,
    overlays: ExportOverlays,
    contentSec: number,
    width: number,
    height: number,
): void {
    const { args, watermark } = overlays;
    if (args && hasAnyOverlay(args)) {
        const range = exportPanelState.range ?? { startTripSec: 0, endTripSec: trip.timeline.contentDurationSec };
        const framePos = createOverlayFrameResolver(
            args,
            trip.timeline,
            range.startTripSec,
            range.endTripSec,
        )(contentSec);
        drawTelemetryOverlays(ctx, width, height, args, framePos);
        if (args.map) {
            const map = previewMapCanvas();
            if (!framePos.hasFix) drawMapPlaceholder(ctx, width, height, args.map);
            else if (map) drawMapOverlay(ctx, map, width, height, args.map);
            else log.info("capture: map overlay not painted yet, still saved without it");
        }
    }
    if (watermark) drawWatermark(ctx, width, height, watermark);
}

/** A camera's copied frame as a composition picture. Its pixels are opaque,
 *  but the format is unknown, so the backdrop is still painted under it
 *  (cheap for a single frame). */
function copiedFrame(pixels: HTMLCanvasElement): CompositionFrame {
    return {
        displayWidth: pixels.width,
        displayHeight: pixels.height,
        format: null,
        draw: (context, sx, sy, sw, sh, dx, dy, dw, dh) => context.drawImage(pixels, sx, sy, sw, sh, dx, dy, dw, dh),
    };
}

/**
 * Copies the pixels a settled camera shows, together with the content second
 * of that frame. A playing camera is copied inside a frame callback, from the
 * frame the callback reports. The rVFC draft pairs a callback's drawing with
 * its frame only as a best effort; drawing in the callback is the API's own
 * per-frame use case, and no engine offers a stricter pairing for a <video>.
 * A camera that presents no new frame within the wait (paused, stalled) keeps
 * its pixels and is copied at once. Engines without frame callbacks report
 * only the media clock, so there a playing camera's time is approximate.
 * Resolves null when the camera no longer shows the settled source, is
 * seeking, or has no decoded frame.
 */
function snapshotFrame(channel: Channel, frame: SettledFrame, clock: CaptureClock): Promise<FrameSnapshot | null> {
    const { video } = frame;
    const copy = (mediaTime: number | undefined): FrameSnapshot | null => {
        // A seek in flight displays older pixels than its target.
        if (video.seeking || video.readyState < 2 || !isStillCurrent([channel, frame])) return null;
        const pixels = copyVideoPixels(video);
        return pixels ? { pixels, contentSec: clock.getFrameContentSec(channel, mediaTime) } : null;
    };
    // The PTS confirmed while settling describes the pixels only while the
    // camera stays where it was; after a move the compositor's latest frame does.
    const heldFrameTime = (): number | undefined =>
        video.currentTime === frame.position ? frame.mediaTime : undefined;
    if (video.paused || typeof video.requestVideoFrameCallback !== "function") {
        return Promise.resolve(copy(heldFrameTime()));
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            video.cancelVideoFrameCallback(callbackId);
            resolve(copy(heldFrameTime()));
        }, FRAME_CALLBACK_WAIT_MS);
        const callbackId = video.requestVideoFrameCallback((_, metadata) => {
            clearTimeout(timer);
            resolve(copy(metadata.mediaTime));
        });
    });
}

/** Copies a video's current frame at its own resolution. */
function copyVideoPixels(video: HTMLVideoElement): HTMLCanvasElement | null {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
}

/** Frees the copies' pixel memory without waiting for garbage collection:
 *  WebKit caps the total canvas memory of a page, and a still holds a
 *  full-resolution copy of every camera. */
function releaseSnapshots(snapshots: Iterable<FrameSnapshot>): void {
    for (const { pixels } of snapshots) {
        pixels.width = 0;
        pixels.height = 0;
    }
}

/** True when the camera still shows the element and file its frame was settled on. */
function isStillCurrent([channel, frame]: [Channel, SettledFrame]): boolean {
    const video = channelPlayers[channel];
    return video === frame.video && videoAttachedFile.get(video) === frame.file && video.src === frame.src;
}

/**
 * Waits until `channel`'s <video> has a drawable current frame. Waits up to
 * 1500ms for HAVE_CURRENT_DATA after a recent src change (zoom landing on a
 * new frame, just-switched trip) - without that wait the button appeared dead.
 * Then forces a decode of the current frame and confirms it with
 * requestVideoFrameCallback: a camera that was a muted background tile may be
 * in throttled decoding, and drawImage would give a black or stale frame.
 * `isFrameSettled` tells whether the compositor already confirmed the frame a
 * camera displays. Resolves null when the frame does not settle.
 */
async function settleCurrentFrame(
    channel: Channel,
    isFrameSettled: (channel: Channel) => boolean,
): Promise<SettledFrame | null> {
    const video = channelPlayers[channel];
    const file = videoAttachedFile.get(video);
    const src = video.src;
    const ctxLog = {
        channel,
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        currentTime: video.currentTime,
        hasMse: !!state.channelBackends[channel],
    };
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        const ready = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
                cleanup();
                resolve(false);
            }, READY_WAIT_MS);
            const onReady = (): void => {
                if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
                    cleanup();
                    resolve(true);
                }
            };
            const cleanup = (): void => {
                clearTimeout(timer);
                video.removeEventListener("loadeddata", onReady);
                video.removeEventListener("canplay", onReady);
                video.removeEventListener("loadedmetadata", onReady);
            };
            video.addEventListener("loadeddata", onReady);
            video.addEventListener("canplay", onReady);
            video.addEventListener("loadedmetadata", onReady);
        });
        if (!ready) {
            log.warn("capture: camera not ready after wait", ctxLog);
            return null;
        }
    }

    // A paused camera whose displayed frame is already confirmed needs no
    // decode nudge. The nudge is a seek to the same time, which may present no
    // new frame: the frame would then stay unconfirmed (player-frame-time
    // keeps it pending), and an export-mode still would have no frame time.
    if (video.paused && !video.seeking && isFrameSettled(channel)) {
        return { video, file, src, mediaTime: undefined, position: video.currentTime };
    }

    let mediaTime: number | undefined;
    if (typeof video.requestVideoFrameCallback === "function") {
        // Intentionally self-assign currentTime to force the throttled
        // decoder to drop the stale frame and decode the current one.
        // biome-ignore lint/correctness/noSelfAssign: see comment above.
        video.currentTime = video.currentTime;
        const frameAck = await new Promise<"callback" | "timeout">((resolve) => {
            // Timeout in case the callback doesn't fire (paused +
            // currentTime= sometimes doesn't trigger a new frame).
            const timer = setTimeout(() => {
                video.cancelVideoFrameCallback(callbackId);
                resolve("timeout");
            }, FRAME_CALLBACK_WAIT_MS);
            const callbackId = video.requestVideoFrameCallback((_, metadata) => {
                clearTimeout(timer);
                mediaTime = metadata.mediaTime;
                resolve("callback");
            });
        });
        if (frameAck === "timeout") {
            log.debug("capture: rVFC timeout, drawing last decoded frame", ctxLog);
        }
        // The compositor may acknowledge the self-seek before the media
        // element clears seeking. Keep its PTS, but wait before drawing pixels.
        if (video.seeking) {
            const settled = await new Promise<boolean>((resolve) => {
                const finish = (ready: boolean): void => {
                    clearTimeout(timer);
                    video.removeEventListener("seeked", onSeeked);
                    video.removeEventListener("emptied", onUnavailable);
                    video.removeEventListener("loadstart", onUnavailable);
                    video.removeEventListener("error", onUnavailable);
                    resolve(ready);
                };
                const onSeeked = (): void => {
                    if (!video.seeking) finish(true);
                };
                const onUnavailable = (): void => finish(false);
                const timer = setTimeout(() => finish(false), SEEK_SETTLE_WAIT_MS);
                video.addEventListener("seeked", onSeeked);
                video.addEventListener("emptied", onUnavailable);
                video.addEventListener("loadstart", onUnavailable);
                video.addEventListener("error", onUnavailable);
            });
            if (!settled) {
                log.warn("capture: camera seek did not settle", ctxLog);
                return null;
            }
            // Another frame may have arrived during the wait. Resolve the live
            // presentation clock instead of painting with the earlier callback's PTS.
            mediaTime = undefined;
        }
    }
    // A seek still in flight displays older pixels than its target.
    if (video.seeking) {
        log.warn("capture: camera still seeking", ctxLog);
        return null;
    }
    return { video, file, src, mediaTime, position: video.currentTime };
}

/**
 * Filename for a still. Timestamp = tripStartUtcSec + tripCurrentSec on the
 * display clock (camera clock when known - same as the trip headers in the
 * sidebar). Falls back to system time when there is no active trip.
 */
function makeStillFilename(
    tripStartUtcSec: number | null,
    tripCurrentSec: number,
    cameraTzSec: number | null,
    label: string,
): string {
    const unixSec = tripStartUtcSec !== null ? tripStartUtcSec + tripCurrentSec : Date.now() / 1000;
    const d = displayClockDate(unixSec, cameraTzSec);
    const yy = d.getUTCFullYear().toString().padStart(4, "0");
    const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
    const dd = d.getUTCDate().toString().padStart(2, "0");
    const hh = d.getUTCHours().toString().padStart(2, "0");
    const mi = d.getUTCMinutes().toString().padStart(2, "0");
    const ss = d.getUTCSeconds().toString().padStart(2, "0");
    return `everydashcam_${yy}${mo}${dd}_${hh}${mi}${ss}_${label}.jpg`;
}

/**
 * Syncs the capture button state: disabled when there is no active video or
 * when the selected VideoCandidate has canPlay=false. readyState is not
 * checked - captureStill waits for loadeddata itself; without that the
 * button would flicker disabled on every src change.
 */
export function syncCaptureButton(): void {
    const btn = dom.playerBar.capture;
    const video = activeCandidate();
    const disabledReason: I18nKey | null = !state.active
        ? "player.captureDisabled.noTrip"
        : video && !video.canPlay
          ? "player.captureDisabled.codec"
          : null;
    btn.disabled = disabledReason !== null;
    btn.title = t(disabledReason ?? "player.capture");
}

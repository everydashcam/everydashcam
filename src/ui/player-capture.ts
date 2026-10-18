// Capture current video frame as a JPG via canvas (not an OS screenshot -
// player UI is excluded). The button + the S hotkey both call captureCurrentFrame.
// Filename: everydashcam_YYYYMMDD_HHMMSS_frame.jpg on the display clock (camera
// clock when known - matches the trip headers in the sidebar).

import { applyCanvasFlip, hasCameraFlip } from "../camera-flip.js";
import { cameraFlipForChannel } from "./camera-flip-pref.js";
import { resolveRegionBlursAt } from "../blur-regions.js";
import { downloadBlob } from "../download.js";
import { t } from "../i18n/index.js";
import { createLogger } from "../log.js";
import type { Channel } from "../parsers/types.js";
import { createRegionBlurHelper, paintRegionBlursForView } from "../transcode/compose.js";
import { activeEffectiveBlurRegions, previewExportStartSec } from "./blur-effective.js";
import { displayClockDate } from "../trips.js";
import { activePlayer, effectiveMasterChannel, dom } from "./dom.js";
import { activeCandidate, activeTrip, state } from "./state.js";
import { videoAttachedFile } from "./player-video-src.js";

const log = createLogger("player");

/**
 * Saves the current <video> frame as a JPG. Waits up to 1500ms for
 * readyState >= HAVE_CURRENT_DATA if src changed recently (drag-zoom selection
 * landing on a new frame, just-switched trip) - without that wait the button
 * appeared dead.
 *
 * `getTripStartUtcSec` resolves the active trip's start; like
 * `getTripCurrentSec` it is invoked AFTER readiness, rVFC and seek completion so
 * the filename matches the frame actually drawn, not the moment of click
 * (the waits leave time for the user to switch trips, and a click-time startUtc
 * paired with the new trip's seconds would produce a mismatched timestamp).
 *
 * The displayed-frame clock resolves privacy geometry independently of the
 * playhead. Callbacks keep this module out of the playback core's import graph.
 */
export async function captureCurrentFrame(
    getTripStartUtcSec: () => number | null,
    getTripCurrentSec: () => number,
    getFrameContentSec: (channel: Channel, mediaTime?: number) => number | null,
): Promise<void> {
    const video = activePlayer();
    const sourceFile = videoAttachedFile.get(video);
    const sourceSrc = video.src;
    const sourceTrip = activeTrip();
    // One snapshot log per attempt so users can share "pressed S, nothing
    // downloaded" reports and the cause is immediately visible. Without it
    // early returns are silent and unreproducible.
    //
    // effectiveMasterChannel(), NOT mainChannel(): the drawn frame comes from
    // activePlayer() = channelPlayers[effectiveMasterChannel()], which falls
    // back to another present camera when the main channel has a gap at the
    // playhead. Resolving blur regions against mainChannel() there would redact
    // the WRONG camera - the drawn (fallback) camera's marked plate ships
    // unredacted, and the main camera's regions paint at the wrong spots. The
    // region channel must equal the drawn element's channel.
    const ch = effectiveMasterChannel();
    const ctxLog = {
        channel: ch,
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        currentTime: video.currentTime,
        paused: video.paused,
        hasMse: !!state.channelBackends[ch],
        chartZoomed: state.chartZoomed,
    };
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        const ready = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
                cleanup();
                resolve(false);
            }, 1500);
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
            log.warn("capture skipped: video not ready after wait", ctxLog);
            return;
        }
    }

    // After a channel swap the former slave may be in throttled decoding
    // (muted background tile - the browser defers decoding). Nudge currentTime
    // to force a decode of the current frame and confirm via
    // requestVideoFrameCallback. Without this drawImage gives a black or
    // stale frame.
    let mediaTime: number | undefined;
    if (typeof video.requestVideoFrameCallback === "function") {
        // Intentionally self-assign currentTime to force the throttled
        // decoder to drop the stale frame and decode the current one.
        // biome-ignore lint/correctness/noSelfAssign: see comment above.
        video.currentTime = video.currentTime;
        const frameAck = await new Promise<"callback" | "timeout">((resolve) => {
            // 250ms timeout in case the callback doesn't fire (paused +
            // currentTime= sometimes doesn't trigger a new frame).
            const timer = setTimeout(() => {
                video.cancelVideoFrameCallback(callbackId);
                resolve("timeout");
            }, 250);
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
                const timer = setTimeout(() => finish(false), 1500);
                video.addEventListener("seeked", onSeeked);
                video.addEventListener("emptied", onUnavailable);
                video.addEventListener("loadstart", onUnavailable);
                video.addEventListener("error", onUnavailable);
            });
            if (!settled) {
                log.warn("capture skipped: seek did not settle", ctxLog);
                return;
            }
            // Another frame may have arrived during the wait. Resolve the live
            // presentation clock instead of painting with the earlier callback's PTS.
            mediaTime = undefined;
        }
    }

    // The active element may have been swapped during the readiness/frame awaits
    // (user switched trip or channel, or a preload slot promotion). Drawing from
    // the stale `video` would capture a black/wrong-trip frame under a filename
    // resolved post-await for the NEW trip. Bail; capture is a manual action, the
    // user can retry on the live element.
    if (
        activePlayer() !== video ||
        videoAttachedFile.get(video) !== sourceFile ||
        video.src !== sourceSrc ||
        activeTrip() !== sourceTrip
    ) {
        log.warn("capture skipped: active video changed during readiness wait", ctxLog);
        return;
    }

    const frameContentSec = getFrameContentSec(ch, mediaTime);
    if (video.seeking || (state.exportModeOpen && frameContentSec === null)) {
        log.warn("capture skipped: displayed frame time unavailable", ctxLog);
        return;
    }
    const filename = makeFrameFilename(getTripStartUtcSec(), getTripCurrentSec(), sourceTrip?.cameraTzSec ?? null);

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        log.warn("capture skipped: 2d context unavailable", ctxLog);
        return;
    }
    const flip = cameraFlipForChannel(ch, sourceTrip);
    try {
        if (hasCameraFlip(flip)) {
            ctx.save();
            applyCanvasFlip(ctx, { x: 0, y: 0, w: canvas.width, h: canvas.height }, flip);
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (hasCameraFlip(flip)) ctx.restore();
    } catch (e) {
        // SecurityError if video is tainted (cross-origin without CORS) - our
        // blob: src should never trigger this, but log defensively.
        log.error("capture failed: drawImage threw", e);
        return;
    }

    // Blur zones: in export-mode the tiles preview the redaction, so the
    // captured JPG must match - otherwise S quietly saves the very plate the
    // user just covered. Identity view: raw source frame -> same-size canvas.
    if (state.exportModeOpen && frameContentSec !== null) {
        const regionBlurs = resolveRegionBlursAt(
            activeEffectiveBlurRegions(),
            ch,
            frameContentSec,
            previewExportStartSec(ch, frameContentSec),
        );
        if (regionBlurs.length > 0) {
            paintRegionBlursForView(
                ctx,
                regionBlurs,
                canvas.width,
                canvas.height,
                0,
                0,
                canvas.width,
                canvas.height,
                0,
                0,
                canvas.width,
                canvas.height,
                createRegionBlurHelper(),
                flip,
            );
        }
    }

    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) {
        log.warn("capture skipped: toBlob returned null", { ...ctxLog, canvasW: canvas.width, canvasH: canvas.height });
        return;
    }

    downloadBlob(blob, filename);
    log.info("capture saved", { filename, bytes: blob.size, ...ctxLog });
}

/**
 * Filename for a captured frame. Timestamp = tripStartUtcSec + tripCurrentSec
 * on the display clock (camera clock when known - same as the trip headers in
 * the sidebar). Falls back to system time when there is no active trip.
 */
function makeFrameFilename(tripStartUtcSec: number | null, tripCurrentSec: number, cameraTzSec: number | null): string {
    const unixSec = tripStartUtcSec !== null ? tripStartUtcSec + tripCurrentSec : Date.now() / 1000;
    const d = displayClockDate(unixSec, cameraTzSec);
    const yy = d.getUTCFullYear().toString().padStart(4, "0");
    const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
    const dd = d.getUTCDate().toString().padStart(2, "0");
    const hh = d.getUTCHours().toString().padStart(2, "0");
    const mi = d.getUTCMinutes().toString().padStart(2, "0");
    const ss = d.getUTCSeconds().toString().padStart(2, "0");
    return `everydashcam_${yy}${mo}${dd}_${hh}${mi}${ss}_frame.jpg`;
}

/**
 * Syncs the capture button state: disabled when there is no active video or
 * when the selected VideoCandidate has canPlay=false. readyState is not
 * checked - captureCurrentFrame waits for loadeddata itself; without that the
 * button would flicker disabled on every src change.
 */
export function syncCaptureButton(): void {
    const btn = dom.playerBar.capture;
    if (!state.active) {
        btn.disabled = true;
        btn.title = t("player.captureDisabled.noTrip");
        return;
    }
    const video = activeCandidate();
    if (video && !video.canPlay) {
        btn.disabled = true;
        btn.title = t("player.captureDisabled.codec");
        return;
    }
    btn.disabled = false;
    btn.title = t("player.capture");
}

import { syncCameraFlips } from "./player-camera-flip.js";
// Player core: playback pipeline + multichannel grid + initPlayer composition
// over the player-* subsystem modules. The subsystems (volume, speed, loop,
// fullscreen, capture, metrics, zoom, scrubber, hotkeys, tile-input,
// loading-overlay, export-button) own their own DOM listeners and state;
// they receive any playback-core callables they need through initPlayerX
// dependency objects. None of them imports back from here - the dependency
// graph stays tree-shaped.
//
// Trip playback simulates "one long video". At any moment one HTMLMediaElement
// plays one MP4, but the timeline UI (chart strip, current/total) lives in
// trip coordinates.
//
// Trip position = (currentFile.startUtc - trip.startUtc) + video.currentTime
// Seeking across a file boundary = change src + set currentTime inside the
// new file.
//
// Public "controller surface" - functions other modules in src/ui/* may call:
//   - playFrame(tripIdx, frameIdx, startOffsetSec?, autoPlay?)
//   - playTripEvent(tripIdx, eventIndex)
//   - seekTripTime(sec)               // trip-relative
//   - getTripCurrentTime()            // trip-relative
//   - driftSyncSlaves()               // called by the marker rAF loop
//   - sync*Button() / updatePlayerProgressUi()   // one-shot DOM syncs
//     (Play, Mute, Speed, Loop, Fullscreen, Capture, Export, plus the
//     progress UI used by chart/sidebar lifecycle)

import { t } from "../i18n/index.js";
import { createLogger } from "../log.js";
import { captureSentryMessage } from "../sentry.js";
import { emitLifecycle } from "../perf.js";
import type { Channel } from "../parsers/types.js";
import { getSplitSlots, PIP_OVERLAY_CHAR_SIZE, type SplitSlotsContext } from "../transcode/compose.js";
import { PerFileMseBackend } from "../per-file-mse.js";
import {
    pickFrameChannel,
    frameChannels,
    frameMediaOffset,
    tripAllCandidates,
    tripCandidatesByChannel,
    contentToFrame,
} from "../trips.js";
import type { Trip, TripFrame, VideoCandidate } from "../trips.js";
import { playbackTimeForContent } from "../video-frame-time.js";
import { resolveRegroupPlaybackTarget } from "./player-regroup-target.js";

const log = createLogger("player");

import {
    disposeChartHoverThumbs,
    followPlayheadInZoom,
    getSelectedRange,
    panTimelineToInclude,
    rebuildChartFromTrip,
    zoomTimelineStep,
} from "./chart.js";
import { disposeAllFrameDecoders } from "./frame-extract.js";
import {
    ALL_CHANNELS,
    activePlayer,
    channelPlayers,
    channelTileFor,
    dom,
    effectiveMasterChannel,
    forEachVideoSlot,
    isActiveSlot,
    onActivePlayerEvent,
    preloadPlayer,
    SLAVE_DRIFT_MAX_SEC,
    swapActiveSlot,
} from "./dom.js";
import {
    hideCodecUnsupportedOverlay,
    showCodecUnsupportedOverlay,
    showPlaybackFailureOverlay,
    syncEmptyState,
} from "./empty-state.js";
import { channelDisplayLabel, formatDuration, formatTime } from "./format.js";
import { registerGpsSyncRefreshListener } from "./gps-sync-refresh.js";
import { notify } from "./notifications.js";
import { ensureMarkerLoop, refreshMap, resetFollowInteractionPause, smoothCameraToCurrentPosition } from "./map.js";
import { setDrawerOpen, syncBrowseState } from "./mobile-drawer.js";
import { captureCurrentFrame, syncCaptureButton } from "./player-capture.js";
import { hideLoadingOverlay, showLoadingOverlay } from "./player-loading-overlay.js";
import { initFrameStep } from "./player-frame-step.js";
import { initSeekButtons } from "./player-seek-buttons.js";
import { channelPresentedFrame, initPlayerFrameTimes, subscribePlayerFrames } from "./player-frame-time.js";
import { initPlayerHotkeys } from "./player-hotkeys.js";
import { initPlayerScrubber, updatePlayerProgressUi } from "./player-scrubber.js";
import { syncCropPreviews } from "./player-crop.js";
import { initPlayerTileInput } from "./player-tile-input.js";
import { initTileReorder } from "./player-tile-reorder.js";
import {
    clearVideoSrc,
    requiresMseBackend,
    setVideoSrcFromFile,
    videoAttachedFile,
    videoOwnedBlobUrl,
} from "./player-video-src.js";
import { resolveSlaveTarget, type SlaveTarget } from "./player-slave-target.js";
import {
    applyVideoZoom,
    consumeDragClickSuppress,
    initPlayerZoom,
    reclampAndApplyZoom,
    resetVideoZoom,
} from "./player-zoom.js";
import { initPlayerMetrics, refreshMetricsFromActiveFrame, resyncMetricsForTrip } from "./player-metrics.js";
import { isPreloadReadyForPromotion } from "./player-preload.js";
import { isClipTailFailure } from "./playback-tail.js";
import { isCoarsePointer } from "./media-queries.js";
import { syncExportButton } from "./player-export-button.js";
import { initPlayerFullscreen, syncFullscreenButton, toggleFullscreen } from "./player-fullscreen.js";
import { persistCurrentLayout, restoreLayoutForTrip } from "./player-layout-pref.js";
import { initPlayerLoop, syncLoopButton, toggleLoop } from "./player-loop.js";
import {
    closeSpeedMenu,
    cyclePlaybackRate,
    focusSpeedButton,
    initPlayerSpeed,
    isSpeedMenuOpen,
    syncSpeedButton,
} from "./player-speed.js";
import { initPlayerVolume, syncMuteButton, toggleMuted } from "./player-volume.js";
import { setPreviewPlaybackActive } from "./trip-preview.js";
import { attachPointerDrag } from "./pointer-drag.js";
import { clearOpeningTrip, renderTrips, syncActiveTripHighlight, updateActiveFrameHighlight } from "./sidebar.js";
import { exportPanelState, resetExportRangeForTrip, subscribeExportState } from "./export-state.js";
import {
    activeFrame,
    activeTrip,
    defaultCompositionForChannels,
    isFocusLayout,
    isPipLayout,
    type Layout,
    mainChannel,
    resetPerSlotComposition,
    setLayoutAndChannels,
    state,
} from "./state.js";
import { syncTopPanel } from "./top-panel.js";

export {
    syncCaptureButton,
    syncExportButton,
    syncFullscreenButton,
    syncLoopButton,
    syncMuteButton,
    syncSpeedButton,
    updatePlayerProgressUi,
};

/**
 * Reconciles trip-scoped viewer surfaces after groupTrips replaced every Trip
 * object and remapped state.active onto the selected file's new location.
 *
 * The attached source clock identifies the new interval even when its old
 * frame was split. Unchanged file ownership keeps the current media source;
 * changed ownership goes through the usual seek/attach path.
 */
export function reconcileActiveTripAfterRegroup(): void {
    if (!state.active) return;
    // Grid roles still describe the previous playback state. The remapped
    // frame may already choose a different fallback master.
    const displayedChannel = ALL_CHANNELS.find((channel) => channelTileFor(channel).classList.contains("active"));
    const previousChannel = displayedChannel ?? effectiveMasterChannel();
    const previousVideo = channelPlayers[previousChannel];
    const previousFile = videoAttachedFile.get(previousVideo);
    const target = previousFile
        ? resolveRegroupPlaybackTarget(
              state.trips,
              previousChannel,
              previousFile,
              pendingFileOffset > 0 ? pendingFileOffset : previousVideo.currentTime,
          )
        : null;
    if (target) {
        const frame = state.trips[target.trip]!.frames[target.frame]!;
        const hasChangedMedia = ALL_CHANNELS.some(
            (channel) => videoAttachedFile.get(channelPlayers[channel]) !== frame.channels[channel]?.file,
        );
        if (target.trip !== state.active.trip || target.frame !== state.active.frame || hasChangedMedia) {
            playFrame(target.trip, target.frame, target.offsetInFrame, pendingPlay || !previousVideo.paused);
        }
    }
    const trip = state.trips[state.active.trip];
    if (!trip) return;

    dom.playerBar.total.textContent = formatTime(trip.timeline.contentDurationSec);
    rebuildChartFromTrip(trip);
    refreshMap(trip);
    syncTopPanel();
    resyncMetricsForTrip();
    updatePlayerProgressUi();

    // No blanket clear first: the scheduler replaces or drops every channel's
    // warm source itself, and progressive ingest regroups often enough that a
    // clear would respawn the prewarmed workers each time.
    schedulePreloadNext();
}

/**
 * Adapter: capture wants (tripStartUtcSec, tripCurrentSec); the playback core
 * exports getTripCurrentTime() and holds the trip list. Encapsulated here so
 * call sites in player.ts (hotkey, button click, etc.) read as one line.
 */
function captureFrameNow(): void {
    // BOTH the trip anchor and the trip-relative seconds resolve AFTER the
    // readiness awaits inside captureCurrentFrame - at the instant the frame
    // is actually drawn. A click-time startUtc snapshot combined with the
    // post-await seconds produced a nonsense timestamp when the user switched
    // trips during the ≤1.75 s readiness wait.
    void captureCurrentFrame(
        () => activeTrip()?.startUtc ?? null,
        getTripCurrentTime,
        (channel, mediaTime) => channelPresentedFrame(channel, true, mediaTime)?.contentSec ?? null,
    );
}

/** Whether playback was active before a src change - auto-resumes after load. */
let pendingPlay = false;

// Whether the user wants playback to run. The media element cannot answer
// that on its own: a clip end, a source swap, the MSE backend holding the
// element for its own reseek and a fatal decode error all leave `paused` true
// without the user stopping anything. The flag follows the user-visible
// play/pause transitions (see isInternalPause) and playFrame's autoPlay, and
// is what decode-failure retries and the preview throttle consult.
let isPlaybackIntended = false;
/** The active clip was closed by a decode failure in its tail (see
 *  handleRuntimeDecodeFailure) rather than by 'ended'. The element then sits
 *  in an error state short of its duration, so isAtTripEnd cannot read the
 *  end off the element. Reset whenever a clip is (re)started. */
let activeClipEndedByFailure = false;
/** Target position inside the next file (applied to currentTime on loadedmetadata). */
let pendingFileOffset = 0;

/** Trip-second target of an in-flight cross-file / re-attach seek. While such a
 *  seek loads (slow on SD-card reads), the active <video>.currentTime reads 0 /
 *  the new file's start, so getTripCurrentTime would report the file start and
 *  the playhead visibly bounces there before snapping to the click. We pin the
 *  reported position to the target until the seek lands (cleared on
 *  loadedmetadata/seeked near the target, on error, or by a safety timeout) so
 *  the playhead jumps straight to the click and holds under the loading overlay. */
let pendingSeekTripSec: number | null = null;
let pendingSeekClearTimer: ReturnType<typeof setTimeout> | null = null;

// One-shot latch for seekThenPlay: once the next seek lands near this target,
// resume playback. A bare play() right after seekTripTime races the async
// cross-file / MSE re-attach load (it would start at the reloading file's 0, or
// be aborted by the source swap), so the resume is deferred to the landing
// 'seeked'. null = idle. The timer is a safety net against a seek that never
// lands leaving a stale latch that later auto-plays an unrelated seek.
let resumeAfterSeekTarget: number | null = null;
let resumeAfterSeekTimer: ReturnType<typeof setTimeout> | null = null;

// === Preload slot for seamless MP4 transitions within a trip ===
//
// At file boundaries the native <video src=blob> path causes a 100-300 ms micro-
// pause: setVideoSrcFromFile triggers a decoder re-load (moov parse + first
// keyframe decode). To eliminate it, each tile keeps a second "warm" <video>
// (preload slot, see dom.ts) into which we load the next file in advance
// (triggered from active loadedmetadata). On the 'ended' event we do a cheap
// slot swap: ex-preload becomes active and plays immediately (decoder already
// warm), ex-active becomes the preload for the file after next.
//
// Slave channels warm their next file the same way when the device can afford
// the extra decoders (canPreloadSlaveChannels); promoteSlavePreload swaps them
// over wherever their next file gets attached.
//
// MSE-backed files (hev1 remux, MPEG-TS, Matroska, ADPCM audio) cannot share
// the slot - there is no second MediaSource per channel - but their worker
// phase runs ahead instead: the next clip's backend is created and prewarmed
// (worker spawn + metadata read) while the current clip plays, and the attach
// at the boundary only opens a MediaSource (prewarmMseBackend). The fragment
// feed itself still starts at the boundary, so a smaller pause remains.
//
// Not covered (micro-pause remains):
// - Manual seek across a file boundary: explicit user jump - clears preload;
//   new active loadedmetadata kicks it again.

/**
 * Loads the next file into the channel's preload slot (URL.createObjectURL +
 * v.src + load). Idempotent: if the slot already holds this file it's a no-op
 * (called repeatedly from loadedmetadata chains). Preload is always muted -
 * two sources playing would echo. playbackRate is set in promotePreloadAsActive
 * before play(); until then preload does not play.
 */
function setPreloadSrc(ch: Channel, cand: VideoCandidate): boolean {
    const v = preloadPlayer(ch);
    const isNewSource = videoAttachedFile.get(v) !== cand.file;
    // Always muted: the preload slot is non-active, and two sources playing
    // would echo. Re-asserting muted on a same-file (no-op) call is harmless.
    // The blob-URL lifecycle (WeakMap bookkeeping + revoke-after-set ordering)
    // lives in one place - the shared setVideoSrcFromFile primitive.
    v.muted = true;
    setVideoSrcFromFile(v, cand.file);
    return isNewSource;
}

/**
 * Clears the channel's warm sources: the preload slot (removeAttribute("src")
 * + load() + blob URL revoke) and the prewarmed MSE backend. Idempotent.
 * Called on invalidation (channel swap, last trip frame without loop, export
 * mode), and after promote to free ex-active for the next preload.
 */
function clearPreloadSlot(ch: Channel): void {
    clearVideoSrc(preloadPlayer(ch));
    clearPrewarmedBackend(ch);
}

/** Every channel's warm sources: a trip change or an explicit seek invalidates
 *  the master's and the slaves' warm files alike. */
function clearAllPreloadSlots(): void {
    for (const ch of ALL_CHANNELS) clearPreloadSlot(ch);
}

/**
 * playFrame invalidation. Native slots are always dropped: a natural advance
 * has already promoted its slot, anything else was warmed for another frame.
 * A prewarmed MSE backend survives only when it holds the file its channel is
 * about to attach - the natural-advance case, where attachCandidateToVideo
 * takes it a few lines later.
 */
function invalidateWarmSourcesFor(frame: TripFrame): void {
    for (const ch of ALL_CHANNELS) {
        clearVideoSrc(preloadPlayer(ch));
        if (prewarmedBackends.get(ch)?.file !== frame.channels[ch]?.file) clearPrewarmedBackend(ch);
    }
}

/** Native, decodable and not failed at runtime - the only files a warm slot
 *  can take. MSE-backed files are prewarmed instead (isPrewarmableCandidate). */
function isPreloadableCandidate(cand: VideoCandidate): boolean {
    return !requiresMseBackend(cand) && cand.canPlay && !runtimePlaybackFailures.has(cand);
}

/** Prewarming snapshots duration and audio options, so wait for indexing to
 *  replace their provisional values even when the File identity stays the same. */
function isPrewarmableCandidate(cand: VideoCandidate): boolean {
    return (
        cand.metadataReady !== false && requiresMseBackend(cand) && cand.canPlay && !runtimePlaybackFailures.has(cand)
    );
}

// Prewarmed MSE backends, one per channel: the next clip's worker is spawned
// and has read its metadata before the clip boundary. attachCandidateToVideo
// takes the entry whose file it is about to attach; everything else is
// disposed on invalidation like a preload slot. Holding one costs an idle
// worker with an open mediabunny Input, not a decoder, so the slave decoder
// gate (canPreloadSlaveChannels) does not apply.
const prewarmedBackends = new Map<Channel, PerFileMseBackend>();

function prewarmMseBackend(ch: Channel, cand: VideoCandidate): void {
    const existing = prewarmedBackends.get(ch);
    if (existing) {
        if (existing.file === cand.file && !existing.isFailed) return;
        clearPrewarmedBackend(ch);
    }
    const backend = new PerFileMseBackend({
        file: cand.file,
        durationSec: cand.durationSec,
        transcodeAdpcmAudio: cand.audioNeedsTranscode,
        // Until the backend is taken, a failure only means the boundary attach
        // starts cold and reports the problem itself.
        onError: (reason) => {
            if (prewarmedBackends.get(ch) !== backend) return;
            log.debug("prewarm: backend failed before use, dropping it", { channel: ch, file: cand.file.name, reason });
            clearPrewarmedBackend(ch);
        },
    });
    prewarmedBackends.set(ch, backend);
    void backend.prewarm();
}

/** Hands over the channel's prewarmed backend when it holds `file`; the caller
 *  owns it from here. */
function takePrewarmedBackend(ch: Channel, file: File): PerFileMseBackend | null {
    const backend = prewarmedBackends.get(ch);
    if (!backend || backend.file !== file || backend.isFailed) return null;
    prewarmedBackends.delete(ch);
    return backend;
}

function clearPrewarmedBackend(ch: Channel): void {
    const backend = prewarmedBackends.get(ch);
    if (!backend) return;
    prewarmedBackends.delete(ch);
    void backend.dispose();
}

/**
 * Whether slave channels warm their own preload slot for the next clip. That
 * doubles the live decoders of a multi-channel trip for the span of a clip,
 * and there is no API for how many hardware decoder sessions a device offers:
 * Chromium silently falls back to software decoding, which on a phone can
 * starve the decoders that are actually on screen. The gate is therefore a
 * memory heuristic. navigator.deviceMemory is Chromium-only and capped at 8,
 * so 8 reads as desktop-class; where it is absent a fine pointer is the best
 * available proxy for a desktop-class decoder budget. Two channels need only
 * four warm decoders and get a lower bar.
 */
function canPreloadSlaveChannels(channelCount: number): boolean {
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (typeof deviceMemory !== "number") return !isCoarsePointer();
    return deviceMemory >= (channelCount <= 2 ? 4 : 8);
}

/**
 * Finds the next VideoCandidate that can be preloaded into the current master
 * channel's preload slot and loads it. Clears the slot if no candidate qualifies.
 *
 * Qualifies when:
 *  - state.active exists;
 *  - there is a next frame (or loop is on, wrapping to frame[0]);
 *  - the next frame's master channel matches the current master (otherwise the
 *    preload would end up in the wrong slot);
 *  - the candidate does not need MSE remux (native path only);
 *  - the candidate is decodable (canPlay).
 *
 * Called from:
 *  - onActivePlayerEvent("loadedmetadata") - after the new active has loaded
 *    initial bytes, start warming the next decoder.
 *  - promotePreloadAsActive() - immediately after swap, so ex-active (now
 *    preload) advances to frame+2.
 */
function schedulePreloadNext(): void {
    if (!state.active || state.exportModeOpen) return;
    const trip = state.trips[state.active.trip];
    if (!trip) return;
    const masterCh = effectiveMasterChannel();

    let nextFrameIdx = state.active.frame + 1;
    if (nextFrameIdx >= trip.frames.length) {
        // Last frame: no preload needed on stop (player halts on ended);
        // on loop wrap to frame[0].
        if (state.tripEndBehavior !== "loop") {
            clearAllPreloadSlots();
            return;
        }
        nextFrameIdx = 0;
    }
    const nextFrame = trip.frames[nextFrameIdx];
    if (!nextFrame) {
        clearAllPreloadSlots();
        return;
    }
    const picked = pickFrameChannel(nextFrame, mainChannel());
    let isMasterSlotLoading = false;
    if (!picked || picked.channel !== masterCh) {
        // Master channel absent in next-frame, or fallback resolves to a different
        // channel - preloading into the current masterCh slot makes no sense.
        clearPreloadSlot(masterCh);
    } else {
        const cand = picked.candidate;
        if (videoAttachedFile.get(activePlayer()) === cand.file) {
            // A next interval inside the file the master already plays is
            // served by a seek; nothing to warm.
            clearPreloadSlot(masterCh);
        } else if (isPrewarmableCandidate(cand)) {
            clearVideoSrc(preloadPlayer(masterCh));
            prewarmMseBackend(masterCh, cand);
        } else if (frameMediaOffset(nextFrame, masterCh) > 0 || !isPreloadableCandidate(cand)) {
            // The native slot must start at 0.
            clearPreloadSlot(masterCh);
        } else {
            clearPrewarmedBackend(masterCh);
            isMasterSlotLoading = setPreloadSrc(masterCh, cand);
        }
    }
    if (!isMasterSlotLoading) {
        scheduleSlavePreloads(nextFrame, masterCh);
        return;
    }
    // Stagger the slaves behind the master's slot: every warm slot reads the
    // head of a file while the live streams are still filling their own
    // buffers, and on removable storage that contention lands right at clip
    // start. The master slot reporting canplaythrough means its read is done.
    const masterPreload = preloadPlayer(masterCh);
    const activeTripIdx = state.active.trip;
    const activeFrameIdx = state.active.frame;
    const masterPreloadFile = videoAttachedFile.get(masterPreload);
    masterPreload.addEventListener(
        "canplaythrough",
        () => {
            // Still the same clip and the same warm file - otherwise a newer
            // schedule (or a trip change) already owns the slots.
            if (
                state.active?.trip !== activeTripIdx ||
                state.active.frame !== activeFrameIdx ||
                videoAttachedFile.get(masterPreload) !== masterPreloadFile
            )
                return;
            scheduleSlavePreloads(nextFrame, masterCh);
        },
        { once: true },
    );
}

/**
 * Warms the next clip of every slave channel into its preload slot, or clears
 * the slot where no warm file qualifies. The slot is positioned on promotion
 * (promoteSlavePreload), so a per-channel media offset is fine here; a slave
 * that keeps its file across the boundary needs no slot.
 */
function scheduleSlavePreloads(nextFrame: TripFrame, masterCh: Channel): void {
    const trip = activeTrip();
    if (!trip) return;
    const preloadSlaves = canPreloadSlaveChannels(frameChannels(nextFrame).length);
    for (const ch of ALL_CHANNELS) {
        if (ch === masterCh) continue;
        const cand = nextSlaveCandidate(trip, ch, nextFrame);
        if (cand && isPrewarmableCandidate(cand)) {
            clearVideoSrc(preloadPlayer(ch));
            prewarmMseBackend(ch, cand);
            continue;
        }
        if (!preloadSlaves || !cand || !isPreloadableCandidate(cand)) {
            clearPreloadSlot(ch);
            continue;
        }
        clearPrewarmedBackend(ch);
        setPreloadSrc(ch, cand);
    }
}

/**
 * The file a slave channel will need next. Relative to the file the slave
 * currently plays, not to the master's next frame: a drifting camera can still
 * be finishing the previous clip when the master crosses its boundary, and a
 * slot warmed with the file after next would miss the swap that is actually
 * coming. Falls back to the next frame's file when the slave holds nothing.
 * Undefined when the slave keeps its file (nothing to warm) or has no next.
 */
function nextSlaveCandidate(trip: Trip, ch: Channel, nextFrame: TripFrame): VideoCandidate | undefined {
    const current = videoAttachedFile.get(channelPlayers[ch]);
    const sequence = tripCandidatesByChannel(trip, ch);
    const currentIdx = current ? sequence.findIndex((candidate) => candidate.file === current) : -1;
    if (currentIdx < 0) {
        const cand = nextFrame.channels[ch];
        return cand && cand.file !== current ? cand : undefined;
    }
    if (currentIdx + 1 < sequence.length) return sequence[currentIdx + 1];
    return state.tripEndBehavior === "loop" && sequence.length > 1 ? sequence[0] : undefined;
}

/**
 * Swaps a slave channel onto its warm preload slot when that slot already holds
 * `cand` and can play, mirroring tryPromotePreloadAsActive for the master: the
 * ex-active element is cleared and becomes the channel's preload slot. A
 * promoted slot emits no loadedmetadata, so what the slave listener normally
 * does happens here: position at `positionSec` (clamped into the file), copy
 * the playback rate and start when playback is intended. Returns false when
 * nothing was promoted; the caller then attaches the file normally.
 */
/** Detaches `v` when it sits in a fatal error state while still holding `file`:
 *  the idempotent attach primitives would otherwise leave it dead. */
function detachIfErrored(v: HTMLVideoElement, file: File): void {
    if (v.error && videoAttachedFile.get(v) === file) clearVideoSrc(v);
}

function promoteSlavePreload(ch: Channel, cand: VideoCandidate, positionSec: number): boolean {
    const preload = preloadPlayer(ch);
    if (videoAttachedFile.get(preload) !== cand.file) return false;
    if (!isPreloadReadyForPromotion(preload.readyState) || preload.error) return false;
    const previous = channelPlayers[ch];
    routeChannelAudio(preload, ch);
    preload.playbackRate = state.preferredPlaybackRate;
    const duration = Number.isFinite(preload.duration) ? preload.duration : Number.POSITIVE_INFINITY;
    const target = Math.min(Math.max(positionSec, 0), duration);
    if (Math.abs(preload.currentTime - target) > 0.01) preload.currentTime = target;
    swapActiveSlot(ch);
    clearVideoSrc(previous);
    // Follow the master's live state, not the intent: a master held paused by
    // the MSE backend's reseek must not have a slave running ahead of it. A
    // master that starts right after this swap brings the slave along through
    // the play proxy.
    if (!activePlayer().paused) preload.play().catch(() => {});
    // The export crop preview is written onto the physical element.
    syncCropPreviews();
    log.info("slave preload promoted", { channel: ch, file: cand.file.name, positionSec: target });
    return true;
}

/**
 * Attempts to switch to the preload slot instead of doing a full src reload via
 * playFrame. Returns true on success (state.active.frame updated + slot swapped +
 * play()), false if the swap cannot happen - caller must then call playFrame.
 *
 * Success conditions:
 *  - next-frame master channel matches the current master;
 *  - preload slot holds exactly that file (videoAttachedFile match);
 *  - preload slot has reached HAVE_FUTURE_DATA so play() can advance rather
 *    than stalling on a metadata-only or single-frame buffer.
 */
function tryPromotePreloadAsActive(nextFrameIdx: number): boolean {
    if (!state.active) return false;
    const trip = state.trips[state.active.trip];
    if (!trip) return false;
    const nextFrame = trip.frames[nextFrameIdx];
    if (!nextFrame) return false;
    const masterCh = effectiveMasterChannel();
    const picked = pickFrameChannel(nextFrame, mainChannel());
    if (!picked || picked.channel !== masterCh) return false;
    const cand = picked.candidate;
    if (frameMediaOffset(nextFrame, masterCh) > 0 || videoAttachedFile.get(activePlayer()) === cand.file) return false;
    if (requiresMseBackend(cand) || !cand.canPlay || runtimePlaybackFailures.has(cand)) return false;

    const newActive = preloadPlayer(masterCh);
    if (videoAttachedFile.get(newActive) !== cand.file) return false;
    if (!isPreloadReadyForPromotion(newActive.readyState)) return false;
    // Decoder error - don't promote (fall back to playFrame, which handles the codec-overlay).
    if (newActive.error) return false;

    // No need to pause ex-active (it is on 'ended', playback has already stopped).
    // If paused explicitly, its timeupdate could fire one last time after the swap.

    // Apply audio/rate state to the new active BEFORE the swap so the very first
    // frame plays at the correct volume/rate. Otherwise there would be one render
    // with muted=true (preload state). Routed per composition.audioChannel -
    // unmuting the master unconditionally produced a frame of double audio when
    // the audio source is a different channel.
    routeChannelAudio(newActive, masterCh);
    newActive.playbackRate = state.preferredPlaybackRate;
    // Browser may have pre-fetched a frame to reach HAVE_METADATA, advancing
    // currentTime. Reset to 0 - user expects the file to start from the beginning.
    if (newActive.currentTime !== 0) newActive.currentTime = 0;

    swapActiveSlot(masterCh);
    state.active = { trip: state.active.trip, frame: nextFrameIdx };
    activeClipEndedByFailure = false;

    // Slave channels (if any) are moved to their next-frame files via
    // attachCandidateToVideo - micro-pause for slaves, but master plays without
    // delay. syncFrameToGrid handles this: master sees newActive with an already-
    // attached file (setVideoSrcFromFile no-ops); slaves get re-attached.
    syncFrameToGrid(nextFrame, masterCh);

    // Zoom survives the promote (same trip): re-apply the transform to newActive
    // because the swap moved it to ex-active = preload slot. Without this the
    // first frame after promote renders untransformed (zoom lost). Files within
    // one trip usually share the same aspect; if they differ the ResizeObserver
    // on video-grid will clamp offsets on the next tick.
    if (state.videoZoom.scale > 1) applyVideoZoom();

    updateActiveFrameHighlight(state.active.trip, nextFrameIdx - 1, nextFrameIdx);
    smoothCameraToCurrentPosition();
    updatePlayerProgressUi();
    syncCaptureButton();

    // Start playback when it is wanted. Ignore play() reject - autoplay policy
    // could theoretically fire, but master was already playing before the swap
    // so a user gesture is on record. A clip closed while the user had paused
    // (a tail decode failure on a paused element) stays paused on the next clip.
    if (isPlaybackIntended) newActive.play().catch(() => {});

    log.info("preload promoted to active", {
        channel: masterCh,
        file: cand.file.name,
        frameIndex: nextFrameIdx,
        readyState: newActive.readyState,
    });

    // Ex-active is now the preload slot. Clear its src and immediately kick
    // preload for the file after next to keep the chain smooth.
    clearPreloadSlot(masterCh);
    schedulePreloadNext();
    return true;
}

// Monotonic counter incremented on each playFrame entry. Async continuations
// capture it (`const seqAtStart = playFrameSeq`) and re-check after an await;
// if it changed the user has already switched trips, so they silently bail
// out (no src writes, no state mutations).
let playFrameSeq = 0;

// AbortController for the in-flight player-first-frame waiter. A new trip
// activation cancels the previous one so a stale rVFC/loadeddata from trip A
// cannot fire after the user switched to trip B (perf-harness resets the
// lifecycle bucket between activations, so a late event would land in the
// wrong scenario).
let firstFrameController: AbortController | null = null;

/**
 * Starts playback of a trip frame on the current preferredChannel (with fallback
 * to an available channel via pickFrameChannel).
 *
 * Sync: heavy work (MSE attach, remux) is launched as void async inside
 * attachCandidateToVideo. Callers get control immediately after the grid is set
 * up and do not wait for video readiness.
 */
export function playFrame(
    tripIdx: number,
    frameIdx: number,
    startOffsetSec: number = 0,
    autoPlay: boolean = true,
): void {
    // playFrame's own body is synchronous; the counter exists for the async
    // continuations (attach waiters, ended-handler chains) that capture
    // playFrameSeq at their start and bail if a newer playFrame ran since.
    ++playFrameSeq;
    const trip = state.trips[tripIdx];
    if (!trip) return;
    const frame = trip.frames[frameIdx];
    if (!frame) return;
    const picked = pickFrameChannel(frame, mainChannel());
    if (!picked) return;
    activeClipEndedByFailure = false;
    const video = picked.candidate;
    const fileOffsetSec = startOffsetSec + frameMediaOffset(frame, picked.channel);
    // Do NOT update composition.channelOrder[0] to picked.channel. If the current
    // frame lacks the requested channel we play the fallback, but the user's
    // choice is preserved - the next frame that has the channel restores it
    // automatically.

    // Close the drawer in mobile mode - user picked a trip and wants to watch.
    if (dom.sidebar.dataset.drawerOpen === "true") setDrawerOpen(false);

    const tripChanged = !state.active || state.active.trip !== tripIdx;
    const prevFrameIdx = state.active ? state.active.frame : -1;
    const prevActive = state.active ? { trip: state.active.trip, frame: state.active.frame } : null;

    // Playback is taking over: clear the click "opening" spinner unconditionally.
    // Must run for BOTH a trip change AND a re-activation of the already-open trip
    // (clicking another clip row in it) - the latter takes the no-tripChanged
    // path below and would otherwise leave the spinner stuck on the active card.
    // clearOpeningTrip is global + idempotent; the trip-change highlight below
    // then touches an already-spinner-free card.
    clearOpeningTrip();

    // Any explicit playFrame invalidates the preload slot: a trip change certainly,
    // and a manual seek to another frame too - the preload may have been for the
    // frame after the previous active. New active loadedmetadata will re-kick
    // schedulePreloadNext. A prewarmed MSE backend for this very frame stays.
    if (state.active) invalidateWarmSourcesFor(frame);
    state.active = { trip: tripIdx, frame: frameIdx };

    // Marker rAF loop stops when state is empty. Restart here - first playFrame
    // after ingest/clear triggers the loop.
    ensureMarkerLoop();

    // Export button must be enabled as soon as an active trip exists.
    syncExportButton();

    // Zoom survives frame changes within one trip (useful for tracking an object
    // across a clip boundary) but resets on trip change.
    if (tripChanged) resetVideoZoom();

    if (tripChanged) {
        // Reset player composition for the new trip. Per-slot crops/scales are
        // always reset (a crop expressed in fractions of the previous source
        // would land wrong on a different channel set). For multi-channel trips
        // we restore the user's last layout + camera order for this physical
        // camera set (player-layout-pref), so stepping through several trips off
        // one card keeps the chosen split/order; single-channel trips have no
        // arrangement to restore and fall back to the default.
        const tripChannels = new Set<Channel>();
        for (const f of trip.frames) {
            for (const [ch, cand] of Object.entries(f.channels)) {
                if (cand?.canPlay) tripChannels.add(ch as Channel);
            }
        }
        const playableChannels = [...tripChannels];
        const restored = restoreLayoutForTrip(trip, playableChannels);
        if (restored) {
            setLayoutAndChannels({
                layout: restored.layout,
                channelOrder: restored.channelOrder,
                // Audio source is not persisted; default to the (restored) main slot.
                audioChannel: restored.channelOrder[0],
            });
        } else {
            const def = defaultCompositionForChannels(playableChannels);
            setLayoutAndChannels({
                layout: def.layout,
                channelOrder: def.channelOrder,
                audioChannel: def.audioChannel,
            });
        }
        // Always clear per-slot crops/scales/PiP positions: setLayoutAndChannels
        // only resizes them on a layout CHANGE, so a trip whose layout matches the
        // previous one would otherwise inherit a crop expressed in the old source's
        // fractions.
        resetPerSlotComposition();
        // Reset the export range to the new trip's full span - a range carried
        // over from a longer previous trip would slice no files on a shorter one.
        resetExportRangeForTrip(trip);
        syncTopPanel();
        // Hover-thumb cache (chart tooltip) + shared decoder cache - frames from the
        // previous trip are no longer needed; they hold GPU memory and WebCodecs decoders.
        // We have a cap of 6 decoders; without a reset they would survive until the first
        // LRU eviction by the new trip.
        disposeChartHoverThumbs();
        disposeAllFrameDecoders();
        // Clear any pending follow-interaction pause from the previous trip so its
        // resume re-aim doesn't carry into this one.
        resetFollowInteractionPause();
        refreshMap(trip);
        // On trip change, update the total duration and rebuild the chart for the new track.
        dom.playerBar.total.textContent = formatTime(trip.timeline.contentDurationSec);
        rebuildChartFromTrip(trip);
        // The sidebar is not rebuilt on a trip switch; the three things the
        // old full renderTrips did for an activation happen directly: the
        // viewer leaves its empty state, the card highlight moves (the
        // "opening" spinner was already cleared at the top of playFrame), and
        // the mobile browse surface collapses into the watch layout.
        syncEmptyState();
        syncActiveTripHighlight(prevActive, { trip: tripIdx, frame: frameIdx });
        syncBrowseState();

        // Trip activation log - useful for bug reports like "picked a trip, black player /
        // grey map / no audio". Logged once per trip change (intra-trip frame navigation is not logged).
        // Trip structure is aggregated; no per-frame detail.
        const codecsSet = new Set<string>();
        const channelsSet = new Set<string>();
        const fingerprintsSet = new Set<string>();
        const startSourcesSet = new Set<string>();
        let canPlayFalseCount = 0;
        let totalBytes = 0;
        for (const c of tripAllCandidates(trip)) {
            if (c.codec) codecsSet.add(c.codec);
            // channel is nullable - single-channel recorders (70mai x800) and the generic
            // fallback may not set it. "unknown" keeps the entry visible in the log breakdown.
            channelsSet.add(c.channel ?? "unknown");
            fingerprintsSet.add(c.fingerprint);
            startSourcesSet.add(c.startSource);
            if (!c.canPlay) canPlayFalseCount++;
            totalBytes += c.file.size;
        }
        // Lifecycle: trip selected, async loading begins. Subscribers (perf
        // harness) can pair this with "player-first-frame" below to time
        // load latency for the active channel. rVFC registration is deferred
        // until after syncFrameToGrid() at the bottom of this function - by
        // then the active <video> slot is finalized (syncFrameToGrid can
        // swapActiveSlot internally), and a rVFC handle registered on the
        // pre-swap element would silently never fire.
        emitLifecycle("trip-activated", { tripIndex: tripIdx, frameIndex: frameIdx });

        log.info("trip activated", {
            tripIndex: tripIdx,
            frameIndex: frameIdx,
            framesCount: trip.frames.length,
            durationSec: Math.round(trip.durationSec),
            totalBytes,
            channels: [...channelsSet],
            codecs: [...codecsSet],
            fingerprints: [...fingerprintsSet],
            startSources: [...startSourcesSet],
            canPlayFalseCount,
            gpsRecordsCount: trip.records.length,
            eventsCount: trip.events.length,
        });
    } else {
        updateActiveFrameHighlight(tripIdx, prevFrameIdx, frameIdx);
        // Intra-trip file change: nudge the camera to the new currentTime
        // position. With chained per-tick easeTo running, this is mostly a
        // belt-and-suspenders call (the next rAF would re-aim anyway), but
        // its suspendFollowEase blocks that re-aim mid-flight - the 250 ms
        // ease lands cleanly instead of being overwritten 16 ms in.
        smoothCameraToCurrentPosition();
    }

    // Codec check for the active channel: if canPlay=false (mediabunny.canDecodeVideo returned
    // false during ingest, typically HEVC in Firefox without HW acceleration), show the overlay
    // instead of a black <video>. Slave channels can also have canPlay=false - in split-view
    // their tile shows a black background with a channel label; others keep playing.
    if (!video.canPlay) {
        // (No seq re-check here: everything from the playFrameSeq capture to
        // this point is synchronous, so the sequence cannot have changed.)
        showCodecUnsupportedOverlay(video.codec);
        pendingPlay = false;
        isPlaybackIntended = false;
        pendingFileOffset = 0;
        // Zoom is pointless on an unplayable video - the decoder returns nothing.
        resetVideoZoom();
        if (tripChanged) resyncMetricsForTrip();
        updatePlayerProgressUi();
        syncCaptureButton();
        // Clear all video.src and backends so the decoder doesn't stall on a problematic
        // mime-type. Tiles are covered by the overlay (overlay is on top of the grid).
        // Preload slots included: they may have been warmed by the previous (working) frame,
        // and keeping them with src set is pointless - recovery goes through playFrame anyway.
        for (const ch of ALL_CHANNELS) disposeChannelBackend(ch);
        forEachVideoSlot((v) => clearVideoSrc(v));
        for (const ch of ALL_CHANNELS) clearPrewarmedBackend(ch);
        // Lifecycle: trip activation finished without a playable frame
        // (codec rejected by canDecodeVideo at ingest). Distinct from
        // player-first-frame to keep semantics honest - subscribers waiting
        // on first-frame should not see it here. Perf harness treats
        // either as terminal for trip-activation.
        if (tripChanged) {
            emitLifecycle("player-failed", { tripIndex: tripIdx, reason: "codec-unsupported" });
        }
        return;
    }
    if (runtimePlaybackFailures.has(video)) {
        syncFrameToGrid(frame, picked.channel, fileOffsetSec);
        showRuntimePlaybackFailure(video, picked.channel);
        if (tripChanged) resyncMetricsForTrip();
        updatePlayerProgressUi();
        if (tripChanged) emitLifecycle("player-failed", { tripIndex: tripIdx, reason: "playback-failed" });
        return;
    }
    hideCodecUnsupportedOverlay();

    // Re-activating an already buffered file changes no src, so there will
    // be no loadedmetadata event to consume pendingPlay/pendingFileOffset below.
    // Handle that path directly. This is what trip loop and Play-at-EOF hit for
    // a one-frame trip; without the explicit seek the ended element stays parked
    // at duration forever. A source still loading keeps the ordinary pending
    // path so its first loadedmetadata applies the request.
    const master = channelPlayers[picked.channel];
    // A fatally errored element plays nothing until it is reloaded, and
    // setVideoSrcFromFile is idempotent per File: detach it so the attach
    // below reloads the same file instead of reusing the dead element
    // (replay after a tail decode failure, loop on a one-clip trip).
    detachIfErrored(master, video.file);
    const masterBackend = state.channelBackends[picked.channel];
    const canReuseMasterSource =
        !requiresMseBackend(video) ||
        (masterBackend?.file === video.file &&
            !masterBackend.isDone &&
            !masterBackend.isFailed &&
            isInVideoBuffer(master, fileOffsetSec));
    const isReusableMaster =
        canReuseMasterSource &&
        videoAttachedFile.get(master) === video.file &&
        master.readyState >= master.HAVE_METADATA;

    if (frame.mediaOffsetSec) {
        setPendingSeek((trip.timeline.segments[frameIdx]?.contentStart ?? 0) + startOffsetSec);
    }
    pendingPlay = autoPlay;
    isPlaybackIntended = autoPlay;
    pendingFileOffset = fileOffsetSec;
    syncFrameToGrid(frame, picked.channel, fileOffsetSec);
    if (isReusableMaster) {
        pendingPlay = false;
        pendingFileOffset = 0;
        if (!autoPlay) master.pause();
        if (autoPlay) {
            const segment = trip.timeline.segments[frameIdx];
            armResumeAfterSeek((segment?.contentStart ?? 0) + startOffsetSec);
        }
        if (master.currentTime !== fileOffsetSec || master.ended) master.currentTime = fileOffsetSec;
        // Setting currentTime on an ended element starts a real media seek.
        // Resume only after it lands; an immediate play() can be interrupted by
        // the decoder's seek under load. A no-op seek has no event, so settle it
        // synchronously through the same latch.
        if (autoPlay && !master.seeking) resumePlaybackIfSeekLanded();
        if (!master.seeking) clearPendingSeekIfLanded();
        // playFrame invalidated the old preload above. No metadata event will
        // arrive to rebuild it on this same-src path, so warm the next frame now.
        schedulePreloadNext();
    }
    syncCaptureButton();

    // Readouts are NOT resynced on a file change - they keep flowing from
    // timeupdate. Only a trip change needs it: the values belong to a
    // different track, and the first timeupdate may never come on a player
    // the user does not start.
    if (tripChanged) resyncMetricsForTrip();

    updatePlayerProgressUi();

    // Register first-frame signal NOW - after syncFrameToGrid finalized the
    // active slot. Use the picked candidate's actual element via activePlayer()
    // (post-swap value), not a snapshot from earlier in the function.
    // rVFC where supported (Chromium = our perf-test target); fall back to
    // loadeddata. AbortController cancels a previous in-flight waiter when a
    // new trip is activated before the previous fired - see firstFrameController.
    if (tripChanged) {
        firstFrameController?.abort();
        firstFrameController = new AbortController();
        const { signal } = firstFrameController;
        const v = activePlayer();
        const detail = { tripIndex: tripIdx };
        if (typeof v.requestVideoFrameCallback === "function") {
            const handle = v.requestVideoFrameCallback(() => {
                if (!signal.aborted) emitLifecycle("player-first-frame", detail);
            });
            signal.addEventListener("abort", () => v.cancelVideoFrameCallback?.(handle), { once: true });
        } else {
            v.addEventListener(
                "loadeddata",
                () => {
                    if (!signal.aborted) emitLifecycle("player-first-frame", detail);
                },
                { once: true, signal },
            );
        }
    }
}

/**
 * Releases the MSE backend for a channel if one exists. Idempotent. Call before switching
 * files on this channel or when closing a trip.
 *
 * Async because backend.dispose is async (output.cancel + abort / removeSourceBuffer /
 * endOfStream / revokeObjectURL). Callers that need dispose to complete before attaching a
 * new backend must await this. Without the await Chrome may not release SourceBuffer quota
 * from the old MediaSource, causing the new one to throw QuotaExceededError on the first
 * appendBuffer. Mirrors the contract of the removed seamless.ts disposeAllStreams.
 */
async function disposeChannelBackend(ch: Channel): Promise<void> {
    const b = state.channelBackends[ch];
    if (!b) return;
    delete state.channelBackends[ch];
    await b.dispose();
}

/**
 * Marks a candidate unplayable at runtime and re-renders so the codec-unsupported
 * overlay replaces a black/frozen frame: syncFrameToGrid hides its tiles, playFrame
 * shows the overlay on the active channel and keeps other channels playing. Shared
 * by the MSE backend-error path and the native <video> decode-error path.
 * Caller logs the reason - this only effects the state change + re-render.
 */
function markCandidateUnplayable(cand: VideoCandidate, ch: Channel): void {
    if (!cand.canPlay) return; // already marked - no re-render needed
    cand.canPlay = false;
    disposeChannelBackend(ch);
    if (!state.active) return;
    playFrame(state.active.trip, state.active.frame, 0, isPlaybackIntended);
}

interface PlaybackRetryPosition {
    offsetSec: number;
    autoPlay: boolean;
}

// Runtime failure says nothing about the file's playback/export capabilities.
// Keep it separate until the user retries; UI syncs must not reopen it in a loop.
const runtimePlaybackFailures = new WeakMap<VideoCandidate, PlaybackRetryPosition>();
const decodeRetryCount = new WeakMap<VideoCandidate, number>();
const recoveringCandidates = new WeakSet<VideoCandidate>();
const MAX_DECODE_RETRIES = 1;

function attachedCandidate(v: HTMLVideoElement, ch: Channel): VideoCandidate | null {
    const trip = activeTrip();
    const file = videoAttachedFile.get(v);
    if (!trip || !file) return null;
    return tripCandidatesByChannel(trip, ch).find((candidate) => candidate.file === file) ?? null;
}

function playbackRetryPosition(v: HTMLVideoElement): PlaybackRetryPosition {
    const isMaster = v === activePlayer();
    const trip = activeTrip();
    const seek =
        isMaster && trip && pendingSeekTripSec !== null ? contentToFrame(trip.timeline, pendingSeekTripSec) : null;
    const offsetSec =
        seek && seek.index === state.active?.frame
            ? seek.offsetInFrame + frameMediaOffset(trip!.frames[seek.index]!, effectiveMasterChannel())
            : isMaster && pendingFileOffset > 0
              ? pendingFileOffset
              : v.currentTime;
    return {
        offsetSec: Math.max(0, offsetSec),
        // Not the element's paused flag: a fatal decode error and a reload both
        // leave it paused while the user never stopped playback, and a slave
        // must follow the user's intent, not a master that is itself reloading.
        autoPlay: isPlaybackIntended,
    };
}

function showRuntimePlaybackFailure(cand: VideoCandidate, ch: Channel): void {
    clearPendingSeek();
    disarmResumeAfterSeek();
    pendingPlay = false;
    pendingFileOffset = 0;
    // Nothing plays until the user retries; let background previews decode.
    isPlaybackIntended = false;
    syncPreviewThrottle();
    hideLoadingOverlay();
    showPlaybackFailureOverlay(() => retryPlaybackCandidate(cand, ch));
    syncCaptureButton();
    syncPlayButton();
}

/** Reopen only the failed camera; healthy cameras keep their sources and time. */
async function restartCandidate(cand: VideoCandidate, ch: Channel, position: PlaybackRetryPosition): Promise<void> {
    const v = channelPlayers[ch];
    const attachedFile = videoAttachedFile.get(v);
    const seqAtStart = playFrameSeq;
    recoveringCandidates.add(cand);
    try {
        await disposeChannelBackend(ch);
        if (playFrameSeq !== seqAtStart || channelPlayers[ch] !== v || videoAttachedFile.get(v) !== attachedFile)
            return;
        clearVideoSrc(v);
        runtimePlaybackFailures.delete(cand);
        const isMaster = v === activePlayer();
        if (isMaster) {
            hideCodecUnsupportedOverlay();
            pendingPlay = position.autoPlay;
            pendingFileOffset = position.offsetSec;
        }
        attachCandidateToVideo(ch, v, cand, isMaster, position.offsetSec);
        const af = activeFrame();
        if (af) applyTileLayoutRoles(af.frame, effectiveMasterChannel());
    } finally {
        recoveringCandidates.delete(cand);
    }
}

function retryPlaybackCandidate(cand: VideoCandidate, ch: Channel): void {
    const af = activeFrame();
    const position = runtimePlaybackFailures.get(cand);
    if (!af || !position || recoveringCandidates.has(cand)) return;
    if (!tripCandidatesByChannel(af.trip, ch).includes(cand)) return;
    const isMaster = ch === effectiveMasterChannel();
    if (isMaster && af.frame.channels[ch] !== cand) return;
    // A failed slave may have held a neighbour file at its drift boundary.
    // Rejoin the camera at the master's current time, even after that boundary.
    const target = isMaster ? null : activeSlaveTarget(ch, activePlayer().currentTime);
    const retryCand = target?.cand ?? af.frame.channels[ch];
    if (!retryCand) return;
    runtimePlaybackFailures.delete(cand);
    decodeRetryCount.delete(cand);
    const retryPosition = isMaster
        ? position
        : {
              offsetSec: Math.max(0, target?.positionSec ?? activePlayer().currentTime),
              autoPlay: !activePlayer().paused,
          };
    void restartCandidate(retryCand, ch, retryPosition);
}

/** Retry a transient failure once, then offer an explicit retry without
 * changing source capabilities. Returns true only for a newly surfaced failure
 * worth reporting; recovery, damaged tails and stale events stay as breadcrumbs. */
function handleRuntimeDecodeFailure(
    cand: VideoCandidate,
    ch: Channel,
    recoverable: boolean,
    reason: string,
    position = playbackRetryPosition(channelPlayers[ch]),
): boolean {
    const v = channelPlayers[ch];
    if (!cand.canPlay || runtimePlaybackFailures.has(cand) || recoveringCandidates.has(cand)) return false;
    if (videoAttachedFile.get(v) !== cand.file) return false;
    if (!recoverable) {
        markCandidateUnplayable(cand, ch);
        return true;
    }
    const isMaster = v === activePlayer();
    if (isClipTailFailure(position.offsetSec, cand.durationSec)) {
        // A truncated final GOP (power-cut clip end) fails here on every
        // retry. Treat it as the clip end: the master moves on exactly like on
        // 'ended'; a slave holds its last frame until the boundary re-attaches it.
        log.warn("decode failure in the clip tail, treating it as the clip end", {
            file: cand.file.name,
            channel: ch,
            reason,
            offsetSec: position.offsetSec,
            durationSec: cand.durationSec,
        });
        if (isMaster) {
            // The same clean-up the native error listener does for the master;
            // the MSE backend's error path arrives here without it, and a seek
            // pin or resume latch left armed would freeze the playhead.
            hideLoadingOverlay();
            clearPendingSeek();
            disarmResumeAfterSeek();
            pendingPlay = false;
            pendingFileOffset = 0;
            // The element will not reach 'ended' on its own; park it paused so
            // the play button reads the real state, and remember why the clip
            // closed in case nothing follows (isAtTripEnd).
            v.pause();
            activeClipEndedByFailure = true;
            const af = activeFrame();
            const isLastFrame = !!af && !!state.active && state.active.frame >= af.trip.frames.length - 1;
            // A paused user scrubbed into the broken tail of the last clip: hold
            // the frame rather than looping or jumping to another trip under
            // them. Play then restarts the trip through isAtTripEnd.
            if (isPlaybackIntended || !isLastFrame) finishActiveClip();
            else {
                syncPlayButton();
                updatePlayerProgressUi();
            }
        }
        return false;
    }
    const used = decodeRetryCount.get(cand) ?? 0;
    if (used < MAX_DECODE_RETRIES) {
        decodeRetryCount.set(cand, used + 1);
        log.warn("transient decode failure, re-attaching camera", { file: cand.file.name, channel: ch, reason });
        void restartCandidate(cand, ch, position);
        return false;
    }
    log.warn("transient decode failure exhausted retries", { file: cand.file.name, channel: ch, reason });
    runtimePlaybackFailures.set(cand, position);
    void disposeChannelBackend(ch);
    clearVideoSrc(v);
    const af = activeFrame();
    if (af) applyTileLayoutRoles(af.frame, effectiveMasterChannel());
    if (isMaster) showRuntimePlaybackFailure(cand, ch);
    return true;
}

/**
 * A per-file MSE backend failed at init or at runtime. Classifies the reason and
 * routes through handleRuntimeDecodeFailure: only mime-not-supported is a genuine
 * codec rejection (permanent); every other backend fault (worker-ready timeout on
 * a cold read, worker crash, sourceopen/quota) is transient and worth one retry.
 */
function onBackendError(cand: VideoCandidate, ch: Channel, reason: string): void {
    if (!cand.canPlay) return; // already marked - no re-render needed
    const recoverable = !reason.startsWith("mime-not-supported");
    log.warn("per-file mse backend failed", { file: cand.file.name, channel: ch, reason, recoverable });
    if (handleRuntimeDecodeFailure(cand, ch, recoverable, reason)) {
        captureSentryMessage("video backend failed", {
            level: "warning",
            fingerprint: ["mse_backend_fail", reason],
            tags: { feature: "playback", backend: "mse", reason, codec: cand.codec ?? "unknown" },
        });
    }
}

/**
 * Attaches a candidate to a <video> element. The MSE backend is used when:
 *  - cand.needsHevcRemux: hev1 sample entry or broken hvcC (BlackVue ELITE 9 / Vantrue N2X).
 *  - cand.isTransportStream: MPEG-TS container - not natively decodable in
 *    Chromium/Firefox; mediabunny remuxes TS→fMP4 on the fly via the same backend.
 *  - cand.isMatroska: Matroska (.mkv) - not natively decodable via <video>.src;
 *    remuxed to fMP4 through the same backend.
 *
 * On the active (master) channel a loading overlay is shown - mediabunny on
 * 4K HEVC takes ~300-1000ms for moov + first keyframe. Native path: regular
 * v.src = URL.createObjectURL(File); blob URL is pre-created in ingest.ts.
 *
 * The backend is kept alive between calls in state.channelBackends[ch] to avoid recreation when
 * the frame has not changed. Comparison is by file reference: same candidate → backend.file === cand.file → skip.
 */
/**
 * Which path attachCandidateToVideo took:
 *  - "skip": same file+startSec, did nothing.
 *  - "seek-in-place": same file, new startSec - reused the live backend via
 *    seekTo (mediabunny does not recreate the Input). currentTime is set
 *    inside the IIFE, pendingFileOffset will not fire (loadedmetadata does not
 *    fire - same MediaSource).
 *  - "full-attach": new MediaSource - currentTime is applied through
 *    pendingFileOffset in the loadedmetadata handler.
 */
type AttachOutcome = "skip" | "seek-in-place" | "full-attach";

function attachCandidateToVideo(
    ch: Channel,
    v: HTMLVideoElement,
    cand: VideoCandidate,
    isMaster: boolean,
    /** Start position of the feed in the file for the MSE backend. Default 0 (beginning of file).
     * Used for out-of-buffer seeks via reattachBackendsAtOffset. */
    startSec: number = 0,
    forceReseek = false,
): AttachOutcome {
    if (runtimePlaybackFailures.has(cand)) return "skip";
    // Every trigger forces the same code path - PerFileMseBackend handles hev1
    // remux, MPEG-TS and Matroska demux uniformly (mediabunny picks the input format).
    const useMseBackend = requiresMseBackend(cand);
    const mseReason = cand.needsHevcRemux
        ? "hev1-remux"
        : cand.isTransportStream
          ? "mpeg-ts"
          : cand.isMatroska
            ? "matroska"
            : cand.audioNeedsTranscode
              ? "adpcm-transcode"
              : null;
    // Summary info log for "what is actually playing" - gives a picture of the trip load without
    // having to dig through debug output. Useful on ingest and after seeks: channel, file, pipeline
    // (mse vs native), and start position all in one place.
    const logMeta = {
        channel: ch,
        isMaster,
        pipeline: useMseBackend ? "mse" : "native",
        mseReason,
        file: cand.file.name,
        relativePath: cand.relativePath,
        fingerprint: cand.fingerprint,
        codec: cand.codec,
        // Full codec string - hev1.* triggers the MSE pipeline, hvc1.* and everything else
        // goes through native. Helps diagnose "why is this file via MSE" - the prefix is immediately visible.
        codecParam: cand.codecParam,
        canPlay: cand.canPlay,
        needsHevcRemux: cand.needsHevcRemux,
        isTransportStream: cand.isTransportStream,
        isMatroska: cand.isMatroska,
        audioNeedsTranscode: cand.audioNeedsTranscode,
        rotation: cand.rotation,
        durationSec: cand.durationSec,
        fileSizeBytes: cand.file.size,
        startSec,
    };
    if (useMseBackend) {
        const existing = state.channelBackends[ch];
        if (existing) {
            // EOF and failure still require a fresh attachment for replay.
            if (
                videoAttachedFile.get(v) === cand.file &&
                existing.file === cand.file &&
                !existing.isDone &&
                !existing.isFailed &&
                !forceReseek
            ) {
                // Grid synchronization has no seek intent. Its default offset
                // must not overwrite a user seek that changed the feed origin.
                log.info("attach: mse skip (same file)", logMeta);
                return "skip";
            }
            // Reuse retains parsed metadata and cached reads. Only the muxer
            // and feed restart for an explicit seek within the same file.
            if (
                videoAttachedFile.get(v) === cand.file &&
                existing.file === cand.file &&
                !existing.isDone &&
                !existing.isFailed
            ) {
                log.info("attach: mse seekTo (same file, new startSec)", logMeta);
                if (isMaster) showLoadingOverlay();
                const seqAtStart = playFrameSeq;
                void (async () => {
                    try {
                        await existing.seekTo(startSec);
                    } catch (e) {
                        log.warn("mse seekTo threw", { file: cand.file.name, e });
                    }
                    // Recovery can replace this backend for the same file and
                    // playFrame sequence while its failed seek unwinds.
                    if (state.channelBackends[ch] !== existing || existing.isFailed) return;
                    if (playFrameSeq !== seqAtStart) return;
                    if (videoAttachedFile.get(v) !== cand.file) return;
                    // SourceBuffer now holds the fragment starting from the
                    // keyframe near startSec. We can set currentTime - before
                    // this point the browser would snap it to 0.
                    try {
                        v.currentTime = startSec;
                    } catch (e) {
                        log.warn("mse seekTo currentTime set threw", { file: cand.file.name, e });
                    }
                    // pendingPlay is applied here for the master, because
                    // loadedmetadata will not fire (same MediaSource).
                    if (isMaster) pendingFileOffset = 0;
                    if (isMaster && pendingPlay) {
                        pendingPlay = false;
                        v.play().catch(() => {});
                    }
                    if (isMaster) hideLoadingOverlay();
                })();
                return "seek-in-place";
            }
        }
        // A backend prewarmed for this file skips the worker spawn and the
        // metadata read. Taken synchronously, together with the marker below:
        // a schedule run before the dispose await resolves (playFrame on a
        // reusable master, a regroup) reads the new marker, warms this
        // channel's file after next and would dispose this backend first.
        const warm = takePrewarmedBackend(ch, cand.file);
        log.info("attach: mse start", { ...logMeta, prewarmed: warm !== null });
        // Write the marker BEFORE the IIFE so a concurrent attach can immediately see our claim
        // and abort. If the marker were set inside the IIFE (after the await), there would be a
        // TOCTOU window: another attach between our dispose-await and the check could see an
        // undefined marker, pass its own check, and create two competing backends on the same <video>.
        videoAttachedFile.set(v, cand.file);
        // Async IIFE to await the old backend's dispose BEFORE creating a new MediaSource on the
        // same <video>. Without the await Chrome may not release SourceBuffer quota from the old MS -
        // the new MS's first appendBuffer throws QuotaExceededError on BlackVue ELITE 9 (~7 MB chunks
        // due to long GOP). attachCandidateToVideo itself stays synchronous for callers - fire and forget.
        const seqAtStart = playFrameSeq;
        void (async () => {
            if (existing) {
                await disposeChannelBackend(ch);
            }
            // Between the await and now the user may have called attachCandidateToVideo again
            // with a different candidate that already overwrote the marker. If so, bail out -
            // the new IIFE will take ownership.
            if (videoAttachedFile.get(v) !== cand.file) {
                void warm?.dispose();
                return;
            }
            // Defense-in-depth seq-guard: even if the marker still matches (another playFrame
            // didn't touch this channel - e.g. it's absent from the new frame and syncFrameToGrid
            // went through the else branch), the seq catches that the user is on a different trip
            // and we shouldn't burn resources attaching a stale backend.
            if (playFrameSeq !== seqAtStart) {
                void warm?.dispose();
                return;
            }
            // Show overlay AFTER dispose has run. dispose() now does
            // video.removeAttribute("src") + load() so the browser releases
            // the prior MediaSource (without this MSes pile up in DevTools
            // Media); that fires an emptied event which our listener turns
            // into hideLoadingOverlay. So we (re)show only after that
            // settles, right before the new backend attaches.
            if (isMaster) showLoadingOverlay();
            // The MSE backend owns its own blob URL (URL.createObjectURL from MediaSource).
            // If a native blob URL from a previous attach remains on this video, revoke it so it
            // doesn't leak into the browser's registry. backend.attach(v) will overwrite v.src.
            const prevOwn = videoOwnedBlobUrl.get(v);
            if (prevOwn !== undefined) {
                videoOwnedBlobUrl.delete(v);
                URL.revokeObjectURL(prevOwn);
            }
            // The prewarmed worker was initialized for position 0; retarget it.
            if (warm) warm.setFeedStart(startSec);
            const backend =
                warm ??
                new PerFileMseBackend({
                    file: cand.file,
                    startSec,
                    // Provided so the backend can set MediaSource.duration before
                    // the first media segment lands. Otherwise an out-of-buffer
                    // seek silently snaps currentTime to 0 (see PerFileMseBackend
                    // options doc on durationSec).
                    durationSec: cand.durationSec,
                    // IMA-ADPCM files: the worker decodes the audio and re-encodes
                    // it (AAC, else Opus, else drops it) instead of stream-copying
                    // (mediabunny cannot read ADPCM). Video is still a stream-copy.
                    transcodeAdpcmAudio: cand.audioNeedsTranscode,
                });
            backend.setErrorHandler((reason) => {
                if (state.channelBackends[ch] !== backend || videoAttachedFile.get(v) !== cand.file) return;
                onBackendError(cand, ch, reason);
            });
            state.channelBackends[ch] = backend;
            await backend.attach(v);
        })();
        return "full-attach";
    }
    // Native: if there was a backend (previous file for this channel was hev1), dispose it.
    // Fire-and-forget - the native path doesn't depend on quota release unlike the MSE path above.
    if (state.channelBackends[ch]) void disposeChannelBackend(ch);
    // setVideoSrcFromFile is idempotent: same file → no-op, otherwise creates a new blob URL and revokes the previous own.
    setVideoSrcFromFile(v, cand.file);
    log.info("attach: native", logMeta);
    // The native path changes video.src if the file differs - loadedmetadata
    // arrives as usual. If the file is the same, setVideoSrcFromFile is a no-op,
    // but currentTime via pendingFileOffset will not apply (loadedmetadata does
    // not fire). For now a native-channel reattach with the same file is not
    // called through reattachBackendsAtOffset (isInVideoBuffer for native is
    // always true - there is a moov sample-table); this return is a safe-default.
    return "full-attach";
}

/**
 * True if the target position is within any buffered range of the video.
 * Small tolerance on the boundaries prevents minor float rounding errors from causing unnecessary re-attaches.
 */
function isInVideoBuffer(v: HTMLVideoElement, targetSec: number): boolean {
    let buffered: TimeRanges;
    try {
        buffered = v.buffered;
    } catch {
        return false;
    }
    for (let i = 0; i < buffered.length; i++) {
        if (targetSec >= buffered.start(i) - 0.1 && targetSec <= buffered.end(i) + 0.1) {
            return true;
        }
    }
    return false;
}

/**
 * Out-of-buffer seek within the current frame for channels with an active MSE backend.
 * The MSE backend keeps the SourceBuffer filled only BUFFER_AHEAD_SEC ahead of video.currentTime;
 * seeking far forward in the same file leaves no data in the SB and the browser stalls with
 * DEMUXER_UNDERFLOW. Restart those feeds at offsetInFrame and return the channels
 * whose asynchronous seek owns positioning; buffered channels still need a direct seek.
 *
 * Native channels are not touched - their seek is instant via the native demuxer (random access via mp4 atom table).
 */
function reattachBackendsAtOffset(frame: TripFrame, offsetInFrame: number, wasPlaying: boolean): ReadonlySet<Channel> {
    const reattachedChannels = new Set<Channel>();
    const master = activePlayer();
    let masterOutcome: AttachOutcome | null = null;
    for (const ch of ALL_CHANNELS) {
        const backend = state.channelBackends[ch];
        if (!backend) continue;
        const cand = frame.channels[ch];
        if (!cand) continue;
        const v = channelPlayers[ch];
        const isMaster = v === master;
        const fileOffsetSec = offsetInFrame + frameMediaOffset(frame, ch);
        // Target already in this channel's buffer - leave it; native currentTime seek handles it.
        if (isInVideoBuffer(v, fileOffsetSec)) continue;
        log.debug("reattaching backend at offset", {
            channel: ch,
            file: cand.file.name,
            offsetInFrame,
        });
        // attachCandidateToVideo picks the path itself:
        // "seek-in-place" - reuses the live backend (mediabunny Input is not
        // recreated, the sample-table stays), currentTime/play are applied in
        // the IIFE right after the SourceBuffer is ready;
        // "full-attach" - dispose+new, pendingFileOffset is picked up in the
        // loadedmetadata handler.
        const outcome = attachCandidateToVideo(ch, v, cand, isMaster, fileOffsetSec, true);
        if (outcome === "skip") continue;
        reattachedChannels.add(ch);
        if (isMaster) masterOutcome = outcome;
    }
    if (reattachedChannels.size > 0) {
        // Only the master's handlers consume these latches. A slave reload
        // must not leave an offset or resume intent for a later master load.
        pendingFileOffset =
            masterOutcome === "full-attach" ? offsetInFrame + frameMediaOffset(frame, effectiveMasterChannel()) : 0;
        pendingPlay = masterOutcome !== null && wasPlaying;
    }
    return reattachedChannels;
}

/**
 * Writes the layout-derived attributes for a frame: grid dataset
 * (channelCount / viewMode / layout) plus each tile's slot, tileRole and
 * .active class. Shared by syncFrameToGrid (full attach) and syncGridLayoutOnly
 * (cosmetic focus<->split toggle) so the two never drift on how a tile's
 * role/slot is set or cleared.
 *
 * Slot index per channel comes from composition.channelOrder, so user
 * reordering via top-panel reflects in the player. Legacy data-tile-role
 * (primary / thumb-N) follows the same order: primary = slot 0; thumbs go
 * 0..N-1 by slot rank, not by canonical ALL_CHANNELS iteration. In split-mode
 * role is cleared - CSS auto-flow places tiles via data-channel-count.
 *
 * Owns tile VISIBILITY (tile.hidden) and the grid's data-channel-count: a tile
 * shows iff the frame has the channel AND the composition includes it, so a
 * camera toggled off in the top-panel disappears from the grid and the
 * data-channel-count shrinks (CSS templates key off it). Does NOT touch
 * <video>.src / backends - only syncFrameToGrid attaches/disposes media.
 */
function applyTileLayoutRoles(frame: TripFrame, activeCh: Channel, masterOffsetSec = activePlayer().currentTime): void {
    syncCameraFlips();
    const isFocus = isFocusLayout(state.composition.layout);
    const channelOrder = state.composition.channelOrder;
    // Grid sizing follows the COMPOSITION (visible slots), not the frame's raw
    // channel count - excluding a camera must shrink the grid, in the player and
    // (since composition is shared) the export.
    dom.videoGrid.dataset.channelCount = String(channelOrder.length);
    // data-view-mode (focus|split) is the legacy coarse marker that drives
    // existing CSS; data-layout exposes the precise layout (single/h2/.../pip4)
    // so CSS/JS can distinguish e.g. h2 from grid2x2 (both "split" in legacy
    // terms). They stay in sync via setLayoutAndChannels().
    dom.videoGrid.dataset.viewMode = isFocus ? "focus" : "split";
    dom.videoGrid.dataset.layout = state.composition.layout;
    for (const ch of ALL_CHANNELS) {
        const tile = channelTileFor(ch);
        const cand = frame.channels[ch];
        const slotIdx = channelOrder.indexOf(ch);
        const inComposition = slotIdx >= 0;
        const playbackCand = ch === activeCh ? cand : (activeSlaveTarget(ch, masterOffsetSec)?.cand ?? cand);
        const failed = !!playbackCand && runtimePlaybackFailures.has(playbackCand);
        const playable = !!playbackCand?.canPlay && !failed;
        // Three tile states (not a binary visible/hidden):
        //   - absent (no candidate this frame) or excluded (slotIdx < 0): hidden.
        //   - present but failed to play, yet still in the composition: KEEP the
        //     tile (black + label + a "can't play" note) so a camera that exists
        //     but won't decode does not silently vanish - in a forensic tool a
        //     disappearing angle reads as "never recorded". It owns its slot/cell
        //     but is never marked active and gets no media (syncFrameToGrid skips).
        //   - playable + included: the normal case.
        const unplayable = !!cand && !playable && inComposition;
        const visible = (playable && inComposition) || unplayable;
        tile.hidden = !visible;
        tile.classList.toggle("tile-unplayable", unplayable);
        let retry = tile.querySelector<HTMLButtonElement>(".tile-playback-retry");
        if (failed && playbackCand) {
            if (!retry) {
                retry = document.createElement("button");
                retry.type = "button";
                retry.className = "dc-btn dc-btn--primary tile-playback-retry";
                tile.querySelector(".tile-unplayable-msg")?.append(retry);
            }
            retry.textContent = t("playbackFailed.retry");
            retry.onclick = (event) => {
                event.stopPropagation();
                retryPlaybackCandidate(playbackCand, ch);
            };
        } else {
            retry?.remove();
        }
        if (visible) {
            // Only a playable tile can be the active (audio/large) one.
            tile.classList.toggle("active", playable && ch === activeCh);
            tile.dataset.slot = String(slotIdx);
            if (isFocus && slotIdx === 0) tile.dataset.tileRole = "primary";
            else if (isFocus && slotIdx > 0) tile.dataset.tileRole = `thumb-${slotIdx - 1}`;
            else delete tile.dataset.tileRole;
        } else {
            tile.classList.remove("active");
            delete tile.dataset.tileRole;
            delete tile.dataset.slot;
        }
    }
}

/**
 * Applies the current frame to the video-grid: layout roles (via
 * applyTileLayoutRoles) plus media work - mute/volume routing, MSE/native
 * backend attach, and hiding tiles for channels absent from the frame.
 * Does not touch pendingPlay/pendingFileOffset - that is playFrame's job.
 *
 * Idempotent: attachCandidateToVideo skips a re-attach when src is already
 * correct, so a channel swap within one frame does not interrupt playback.
 */
function syncFrameToGrid(frame: TripFrame, activeCh: Channel, masterOffsetSec = 0): void {
    // applyTileLayoutRoles owns visibility (tile.hidden) + slot roles; this pass
    // is media only. Media is attached for every playable frame channel, even
    // ones excluded from the composition, so toggling a camera back on is
    // instant (no re-attach / MSE re-seek) - it only un-hides the tile.
    applyTileLayoutRoles(frame, activeCh, masterOffsetSec);
    for (const ch of ALL_CHANNELS) {
        let v = channelPlayers[ch];
        const cand = frame.channels[ch];
        const attachCand = ch === activeCh ? cand : (activeSlaveTarget(ch, masterOffsetSec)?.cand ?? cand);
        if (attachCand?.canPlay && !runtimePlaybackFailures.has(attachCand)) {
            detachIfErrored(v, attachCand.file);
            // Mute/volume: audio source = composition.audioChannel (decoupled
            // from the visual main slot). preferredMuted still wins globally;
            // non-audio channels are muted with volume=0 as a dirty fallback.
            routeChannelAudio(v, ch);
            // playbackRate: copy from active so slaves run at the same speed.
            v.playbackRate = state.preferredPlaybackRate;
            // A drift-corrected slave may need the NEIGHBOUR frame's file at
            // this master position (resolveSlaveTarget) - on a natural frame
            // advance that keeps the previous file playing out its matching
            // tail instead of freezing on the new file's first frame.
            // Backend: per-file MSE (mediabunny remux) for needsHevcRemux /
            // MPEG-TS candidates, native <video>.src otherwise. The helper
            // decides whether a re-attach is needed.
            const startSec =
                ch === activeCh
                    ? masterOffsetSec
                    : (activeSlaveTarget(ch, masterOffsetSec)?.positionSec ?? masterOffsetSec);
            // A slave whose next file is already warm in its preload slot swaps
            // onto it; the attach below then sees the file in place and no-ops.
            if (ch !== activeCh && promoteSlavePreload(ch, attachCand, Math.max(0, startSec))) v = channelPlayers[ch];
            const shouldReseek =
                !!frame.mediaOffsetSec &&
                state.channelBackends[ch]?.file === attachCand.file &&
                videoAttachedFile.get(v) === attachCand.file &&
                !isInVideoBuffer(v, startSec);
            const reusedFile = videoAttachedFile.get(v) === attachCand.file;
            const outcome = attachCandidateToVideo(
                ch,
                v,
                attachCand,
                ch === activeCh,
                Math.max(0, startSec),
                shouldReseek,
            );
            // A reused slave emits no metadata event. Position it even when
            // the new master starts at zero and therefore emits no seeked event.
            if (
                frame.mediaOffsetSec &&
                ch !== activeCh &&
                reusedFile &&
                !shouldReseek &&
                outcome !== "seek-in-place" &&
                v.readyState >= 1
            ) {
                const duration = Number.isFinite(v.duration) ? v.duration : Number.POSITIVE_INFINITY;
                const positionSec = Math.min(Math.max(startSec, 0), duration);
                if (Math.abs(v.currentTime - positionSec) > 0.01) v.currentTime = positionSec;
            }
        } else {
            // Release decoder and backend - canPlay=false or channel absent.
            disposeChannelBackend(ch);
            clearVideoSrc(v);
            clearPreloadSlot(ch);
        }
    }
    // Hide the view-mode button on single-channel trips - layout choice is moot.
    dom.viewModeBtn.hidden = frameChannels(frame).length <= 1;
    syncViewModeButton();
    relabelChannelTiles();
    syncOutputAspect();
}

/**
 * Sets each visible tile's .channel-label to the trip-aware display label:
 * the semantic name ("Rear camera") when the trip trusts the mount, otherwise
 * a positional "Channel N". Source of truth is channelDisplayLabel - the same
 * helper the top-panel chips / audio dropdown use - so the overlay matches the
 * menu and never asserts a mount the parser only guessed. The HTML labels carry
 * no data-i18n (they are JS-driven, not static), so a re-run on langchange keeps
 * them in sync; tiles are relabeled per active trip, not once at startup.
 */
function relabelChannelTiles(): void {
    const trip = activeTrip();
    if (!trip) return;
    for (const ch of ALL_CHANNELS) {
        const tile = channelTileFor(ch);
        if (tile.hidden) continue;
        const labelEl = tile.querySelector<HTMLElement>(".channel-label");
        if (labelEl) labelEl.textContent = channelDisplayLabel(ch, trip);
    }
}

/**
 * Writes the CSS variable `--dc-output-aspect` on .video-grid so the export-
 * mode letterbox box knows what aspect to maintain. In casual mode the var is
 * cleared (no aspect constraint, grid fills .video-frame naturally).
 *
 * Source aspect (preset "source") reads from the active video element's
 * videoWidth/videoHeight if available; if metadata hasn't loaded yet the var
 * is cleared (re-run after loadedmetadata fires).
 */
function syncOutputAspect(): void {
    if (!dom.videoGrid) return;
    const aspect = computeOutputAspect();
    if (aspect) dom.videoGrid.style.setProperty("--dc-output-aspect", aspect);
    else dom.videoGrid.style.removeProperty("--dc-output-aspect");
    // syncOutputAspect runs on every export-state change (subscribeExportState)
    // and at the end of layout syncs - the single hook point for pip insets +
    // crop previews.
    syncPipOverlays();
    syncCropPreviews();
}

// === True PiP overlay rendering (export-mode) ===
// In pip layouts the main slot fills the output frame and the other channels
// become small overlays on top of it. Casual viewing keeps the legacy
// focus-mode side-column (still useful for watching). We reuse getSplitSlots
// (the exact geometry the export pipeline uses) so the preview matches the
// burned output, and absolute-position each tile from the returned rects.

/** Numeric output aspect (w/h) for getSplitSlots; defaults to 16/9. */
function computeOutputAspectNumber(): number {
    const css = computeOutputAspect();
    if (!css) return 16 / 9;
    const parts = css.split("/");
    const w = Number.parseFloat(parts[0] ?? "");
    const h = Number.parseFloat(parts[1] ?? "");
    return w > 0 && h > 0 ? w / h : 16 / 9;
}

/** Source aspect (w/h) of a channel's video; 1 if metadata not yet loaded. */
function channelSourceAspect(ch: Channel): number {
    const v = channelPlayers[ch];
    if (v && v.videoWidth > 0 && v.videoHeight > 0) return v.videoWidth / v.videoHeight;
    return 1;
}

/** Inline style props written on a pip-inset tile for absolute positioning.
 *  Cleared together when a tile leaves pip-inset or the layout is not pip. */
const PIP_INSET_INLINE_PROPS = ["position", "left", "top", "width", "height", "z-index"];

function clearPipInsetInlineProps(tile: HTMLElement): void {
    for (const prop of PIP_INSET_INLINE_PROPS) tile.style.removeProperty(prop);
}

/** Clears any inline pip positioning so non-pip / casual layouts use CSS. */
function clearPipInlineStyles(): void {
    if (dom.videoGrid) {
        dom.videoGrid.classList.remove("pip-overlay-mode");
        dom.videoGrid.style.removeProperty("grid-template-columns");
        dom.videoGrid.style.removeProperty("grid-template-rows");
    }
    for (const ch of ALL_CHANNELS) {
        const tile = channelTileFor(ch);
        tile.classList.remove("pip-inset", "pip-main");
        clearPipInsetInlineProps(tile);
    }
}

function syncPipOverlays(): void {
    const layout = state.composition.layout;
    if (!state.exportModeOpen || !isPipLayout(layout)) {
        clearPipInlineStyles();
        return;
    }
    const af = activeFrame();
    if (!af) {
        clearPipInlineStyles();
        return;
    }
    const channelOrder = state.composition.channelOrder;
    const slotCount = channelOrder.length;
    const slotEffectiveAspects: number[] = [];
    for (let i = 0; i < slotCount; i++) {
        const ch = channelOrder[i];
        slotEffectiveAspects[i] = ch ? channelSourceAspect(ch) : 1;
    }
    const ctx: SplitSlotsContext = {
        outputAspect: computeOutputAspectNumber(),
        slotEffectiveAspects,
        slotPipScales: state.composition.perSlotScales,
        overlayPositions: state.composition.perSlotPipPositions,
    };
    const slots = getSplitSlots(layout, ctx);

    dom.videoGrid.classList.add("pip-overlay-mode");
    // The export-mode grid takes its size from in-flow content (the video), so
    // the main slot stays IN FLOW filling a single-cell grid - without it the
    // grid would collapse to zero height. Insets overlay absolutely on top.
    dom.videoGrid.style.gridTemplateColumns = "1fr";
    dom.videoGrid.style.gridTemplateRows = "1fr";
    for (const ch of ALL_CHANNELS) {
        const tile = channelTileFor(ch);
        const slotIdx = channelOrder.indexOf(ch);
        const slot = slotIdx >= 0 ? slots[slotIdx] : undefined;
        if (slot && !tile.hidden && slotIdx === 0) {
            // Main slot: in-flow, fills the single grid cell, gives the grid size.
            tile.classList.add("pip-main");
            tile.classList.remove("pip-inset");
            clearPipInsetInlineProps(tile);
        } else if (slot && !tile.hidden) {
            // Inset slot: absolute overlay positioned from getSplitSlots.
            tile.classList.add("pip-inset");
            tile.classList.remove("pip-main");
            tile.style.position = "absolute";
            tile.style.left = `${(slot.x * 100).toFixed(3)}%`;
            tile.style.top = `${(slot.y * 100).toFixed(3)}%`;
            tile.style.width = `${(slot.w * 100).toFixed(3)}%`;
            tile.style.height = `${(slot.h * 100).toFixed(3)}%`;
            tile.style.zIndex = "2";
        } else {
            tile.classList.remove("pip-inset", "pip-main");
            clearPipInsetInlineProps(tile);
        }
    }
}

// Drag-to-move and corner-resize for pip insets. Active only in export-mode
// pip layouts on non-main tiles. A movement threshold separates a drag from a
// click so the audio-swap click handler still works on a tap; after a real
// drag the next click is swallowed so it does not also swap audio.
const PIP_DRAG_THRESHOLD_PX = 4;
const PIP_SCALE_MIN = 0.3;
const PIP_SCALE_MAX = 2.0;
let pipDragJustHappened = false;

function pipInsetSlotIdx(tile: HTMLElement): number {
    if (!state.exportModeOpen || !isPipLayout(state.composition.layout)) return -1;
    const ch = tile.dataset.channel as Channel | undefined;
    if (!ch) return -1;
    const idx = state.composition.channelOrder.indexOf(ch);
    // slot 0 is the full-frame main - not a draggable inset.
    return idx >= 1 ? idx : -1;
}

function initPipInteractions(): void {
    // Suppress the audio-swap click that follows a drag (capture phase, before
    // the bubble-phase swap delegate in player-tile-input.ts).
    dom.videoGrid.addEventListener(
        "click",
        (e) => {
            if (pipDragJustHappened) {
                pipDragJustHappened = false;
                e.stopImmediatePropagation();
                e.preventDefault();
            }
        },
        true,
    );

    for (const ch of ALL_CHANNELS) {
        const tile = channelTileFor(ch);
        attachPipDrag(tile);
        const handle = tile.querySelector<HTMLButtonElement>(".pip-resize");
        if (handle) attachPipResize(tile, handle);
    }
}

function attachPipDrag(tile: HTMLElement): void {
    let slotIdx = -1;
    let startX = 0;
    let startY = 0;
    let baseXPct = 0;
    let baseYPct = 0;
    let wPct = 0;
    let hPct = 0;
    let dragging = false;
    attachPointerDrag(tile, {
        onStart: (e) => {
            if ((e.target as HTMLElement)?.classList.contains("pip-resize")) return false;
            slotIdx = pipInsetSlotIdx(tile);
            if (slotIdx < 0) return false;
            const grid = dom.videoGrid.getBoundingClientRect();
            const r = tile.getBoundingClientRect();
            if (grid.width <= 0 || grid.height <= 0) return false;
            startX = e.clientX;
            startY = e.clientY;
            baseXPct = (r.left - grid.left) / grid.width;
            baseYPct = (r.top - grid.top) / grid.height;
            wPct = r.width / grid.width;
            hPct = r.height / grid.height;
            dragging = false;
            return true;
        },
        onMove: (e) => {
            if (slotIdx < 0) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!dragging && Math.hypot(dx, dy) < PIP_DRAG_THRESHOLD_PX) return;
            dragging = true;
            tile.classList.add("pip-dragging");
            const grid = dom.videoGrid.getBoundingClientRect();
            const maxX = Math.max(0, 1 - wPct);
            const maxY = Math.max(0, 1 - hPct);
            const xPct = Math.max(0, Math.min(maxX, baseXPct + dx / grid.width));
            const yPct = Math.max(0, Math.min(maxY, baseYPct + dy / grid.height));
            state.composition.perSlotPipPositions[slotIdx] = { xPct, yPct };
            syncPipOverlays();
        },
        onEnd: () => {
            tile.classList.remove("pip-dragging");
            if (dragging) {
                dragging = false;
                // Swallow the click that the browser dispatches after pointerup so
                // it does not also trigger an audio-source swap.
                pipDragJustHappened = true;
            }
        },
    });
}

function attachPipResize(tile: HTMLElement, handle: HTMLButtonElement): void {
    let slotIdx = -1;
    let anchorLeftPx = 0;
    attachPointerDrag(handle, {
        onStart: (e) => {
            slotIdx = pipInsetSlotIdx(tile);
            if (slotIdx < 0) return false;
            anchorLeftPx = tile.getBoundingClientRect().left;
            tile.classList.add("pip-dragging");
            e.preventDefault();
            e.stopPropagation();
            return true;
        },
        onMove: (e) => {
            if (slotIdx < 0) return;
            const grid = dom.videoGrid.getBoundingClientRect();
            if (grid.width <= 0) return;
            const widthPct = (e.clientX - anchorLeftPx) / grid.width;
            const ch = state.composition.channelOrder[slotIdx];
            const effAspect = ch ? channelSourceAspect(ch) : 1;
            // Invert computeOverlayDims: wPct = CHAR_SIZE × scale × effAspect / outputAspect.
            const scale =
                (widthPct * computeOutputAspectNumber()) / (PIP_OVERLAY_CHAR_SIZE * Math.max(1e-6, effAspect));
            state.composition.perSlotScales[slotIdx] = Math.max(PIP_SCALE_MIN, Math.min(PIP_SCALE_MAX, scale));
            syncPipOverlays();
        },
        onEnd: () => {
            tile.classList.remove("pip-dragging");
        },
    });
}

function computeOutputAspect(): string | null {
    if (!state.exportModeOpen) return null;
    const s = exportPanelState;
    switch (s.outputPresetId) {
        case "source": {
            const v = activePlayer();
            if (v.videoWidth > 0 && v.videoHeight > 0) {
                return `${v.videoWidth} / ${v.videoHeight}`;
            }
            return null;
        }
        case "1080_16x9":
        case "720_16x9":
            return "16 / 9";
        case "1080_9x16":
        case "720_9x16":
            return "9 / 16";
        case "1080_1x1":
            return "1 / 1";
        case "1080_4x5":
            return "4 / 5";
        case "custom":
            if (s.outputCustomW > 0 && s.outputCustomH > 0) {
                return `${s.outputCustomW} / ${s.outputCustomH}`;
            }
            return null;
    }
}

/** Updates the view-mode button visuals: orange active indicator + SVG icon (focus = picture-in-picture, split = grid-2x2). */
function syncViewModeButton(): void {
    const isFocus = isFocusLayout(state.composition.layout);
    dom.viewModeBtn.dataset.mode = isFocus ? "focus" : "split";
    const focusIcon = dom.viewModeBtn.querySelector<HTMLElement>(".i-vm-focus");
    const splitIcon = dom.viewModeBtn.querySelector<HTMLElement>(".i-vm-split");
    if (focusIcon) focusIcon.hidden = !isFocus;
    if (splitIcon) splitIcon.hidden = isFocus;
    const label = isFocus ? t("player.view.focus") : t("player.view.split");
    dom.viewModeBtn.setAttribute("aria-label", label);
    dom.viewModeBtn.setAttribute("title", label);
}

/** Tiled (split) layout for a given visible-slot count: 2 -> h2, 3 ->
 *  left1right2, 4 -> grid2x2 (1 slot never reaches split). */
function splitLayoutForSlots(slots: number): Layout {
    return slots === 2 ? "h2" : slots === 3 ? "left1right2" : "grid2x2";
}

/** Focus (pip) layout for a given visible-slot count: 1 -> single,
 *  2/3/4 -> pip2/pip3/pip4. */
function focusLayoutForSlots(slots: number): Layout {
    return slots === 2 ? "pip2" : slots === 3 ? "pip3" : slots === 4 ? "pip4" : "single";
}

/**
 * Toggles between focus and split modes. CSS reacts to data-view-mode for the
 * layout change.
 *
 * Only layout attributes and tile roles change here (via syncGridLayoutOnly) -
 * the <video> backends are left untouched. The earlier version called
 * syncFrameToGrid, whose per-channel attachCandidateToVideo pass hit the "same
 * file, new startSec" branch for MSE backends (TS / hev1-remux) with the
 * default startSec=0, did seekTo(0) + currentTime=0 and reset playback to the
 * start. Native MP4 was unaffected (setVideoSrcFromFile is idempotent per File).
 */
function toggleViewMode(): void {
    // Layout changes radically (focus<->split) - zoom is meaningless here;
    // in split mode tiles are small and zoom is intentionally disabled.
    resetVideoZoom();
    // Pick a layout that matches the requested coarse view mode. Slot count
    // follows the current trip's channel count; setLayoutAndChannels resizes
    // per-slot arrays to match. Existing CSS keys off data-view-mode for the
    // visual placement (focus = primary+thumbs, split = equal grid), so the
    // pipN / h2 / grid2x2 / left1right2 choice is mostly state bookkeeping
    // until layout-specific CSS lands.
    const goingToSplit = isFocusLayout(state.composition.layout);
    const slots = state.composition.channelOrder.length;
    const nextLayout = goingToSplit ? splitLayoutForSlots(slots) : focusLayoutForSlots(slots);
    setLayoutAndChannels({ layout: nextLayout });
    const af = activeFrame();
    if (af) syncGridLayoutOnly(af.frame, mainChannel());
    syncViewModeButton();
    syncTopPanel();
    // User changed focus<->split: remember it for this camera set.
    persistCurrentLayout();
}

// Brief center play/pause icon flash on the active tile, confirming a toggle the
// user just made by clicking the video or pressing Space/K. A click that gives no
// visual feedback "might as well not exist" (NN/g). Decorative + aria-hidden; the
// glyph reflects the state just entered (paused -> pause, playing -> play), the
// YouTube/Plyr convention.
const TILE_FLASH_PLAY_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
const TILE_FLASH_PAUSE_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>';

function flashPlaybackToggle(forcePlaying?: boolean): void {
    const tile = dom.videoGrid.querySelector<HTMLElement>(".video-tile.active");
    if (!tile) return;
    // Drop a still-animating prior flash so rapid Space/K (key auto-repeat) or
    // clicks don't stack overlapping glyphs.
    tile.querySelector(".tile-toggle-flash")?.remove();
    const flash = document.createElement("div");
    flash.className = "tile-toggle-flash";
    flash.setAttribute("aria-hidden", "true");
    // Normally play()/pause() flip .paused synchronously so we read the new state.
    // forcePlaying overrides it for the deferred trip-end restart, where
    // playFrameFromStart hasn't started playback yet at this synchronous instant.
    const showPlay = forcePlaying ?? !dom.player.paused;
    flash.innerHTML = showPlay ? TILE_FLASH_PLAY_SVG : TILE_FLASH_PAUSE_SVG;
    tile.appendChild(flash);
    // Remove on animation end; a timeout safety net covers the (theoretical) case
    // where no animation runs so the node can't leak.
    flash.addEventListener("animationend", () => flash.remove(), { once: true });
    setTimeout(() => flash.remove(), 700);
}

/**
 * Cosmetic layout-only update for the current frame: grid dataset + per-tile
 * slot/tileRole/active, via applyTileLayoutRoles. Does NOT touch src/backends -
 * used by the focus<->split toggle and composition changes (see toggleViewMode /
 * applyComposition) where media must keep playing uninterrupted.
 */
function syncGridLayoutOnly(frame: TripFrame, activeCh: Channel): void {
    applyTileLayoutRoles(frame, activeCh);
    const picked = pickFrameChannel(frame, activeCh);
    if (picked && runtimePlaybackFailures.has(picked.candidate)) {
        showRuntimePlaybackFailure(picked.candidate, picked.channel);
    } else if (dom.viewer.classList.contains("playback-failed")) {
        hideCodecUnsupportedOverlay();
    }
    syncOutputAspect();
}

/**
 * Re-applies state.composition to the live DOM video grid - tile positions,
 * view-mode button, audio routing. Idempotent and cheap; called by top-panel
 * after layout / channelOrder / audioChannel mutations.
 *
 * Does NOT change <video>.src - composition mutations don't change which file
 * plays in which slot, only which slot is "primary" and which slot owns audio.
 * Without an active frame this is a no-op (nothing on screen to update).
 */
export function applyComposition(): void {
    const af = activeFrame();
    if (af) {
        syncGridLayoutOnly(af.frame, mainChannel());
        syncAudioRouting();
    }
    syncViewModeButton();
    syncTopPanel();
}

/**
 * Applies state.composition.audioChannel to per-channel <video>.muted/volume.
 * The visual main slot (channelOrder[0]) is decoupled from the audio source -
 * user can show front in the big tile but listen to rear via the audio
 * dropdown.
 *
 * preferredMuted still wins: if the user is globally muted, the audio source
 * is muted too. Non-audio channels are always muted regardless.
 */
function syncAudioRouting(): void {
    for (const ch of ALL_CHANNELS) {
        const v = channelPlayers[ch];
        if (v) routeChannelAudio(v, ch);
    }
}

/**
 * Applies the per-channel audio routing rule to one <video>: the channel that
 * matches composition.audioChannel carries sound (at preferredVolume unless
 * globally muted); every other channel is muted with volume 0. Single source of
 * the rule - promote/grid-sync/audio-sync all route through here so the paths
 * cannot drift.
 */
function routeChannelAudio(v: HTMLVideoElement, ch: Channel): void {
    const isAudioSource = ch === state.composition.audioChannel;
    v.muted = !isAudioSource || state.preferredMuted;
    v.volume = isAudioSource ? state.preferredVolume : 0;
}

// Proxy master commands to slaves. Listener is on the active <video>; we duplicate the action
// on all slave videos that have a src.
//
// videoAttachedFile is used for a fast attached-state check: WeakMap lookup is cheaper than
// v.getAttribute/v.src (the latter returns an absolutized URL and has a side effect when src was set as relative).
function forEachSlave(fn: (v: HTMLVideoElement, ch: Channel) => void): void {
    const master = activePlayer();
    for (const ch of ALL_CHANNELS) {
        const v = channelPlayers[ch];
        if (v === master) continue;
        if (!videoAttachedFile.has(v)) continue;
        fn(v, ch);
    }
}

/**
 * Binds resolveSlaveTarget (player-slave-target.ts) to the active trip/frame:
 * the file + position the slave needs to show the master's wall moment at
 * `masterPosSec`. May point into a neighbour frame's file - callers re-attach
 * when the file differs. null when nothing is active or the channel is absent.
 */
function activeSlaveTarget(slaveCh: Channel, masterPosSec: number): SlaveTarget | null {
    const af = activeFrame();
    if (!af || !state.active) return null;
    return resolveSlaveTarget(af.trip.frames, state.active.frame, effectiveMasterChannel(), slaveCh, masterPosSec);
}

/**
 * Applies a resolved target to a native slave outside the rAF loop (seeks,
 * metadata catch-up): re-attaches when the matching content lives in a
 * different file (the drift-aware loadedmetadata handler positions it), else
 * writes the clamped position directly.
 */
function applySlaveTarget(slaveCh: Channel, s: HTMLVideoElement, target: SlaveTarget): void {
    // A slave left errored by a tail decode failure is reloaded by the seek.
    detachIfErrored(s, target.cand.file);
    if (videoAttachedFile.get(s) !== target.cand.file) {
        if (!promoteSlavePreload(slaveCh, target.cand, target.positionSec)) {
            attachCandidateToVideo(slaveCh, s, target.cand, false);
        }
        return;
    }
    const duration = Number.isFinite(s.duration) ? s.duration : Number.POSITIVE_INFINITY;
    s.currentTime = Math.min(Math.max(target.positionSec, 0), duration);
}

/** A camera can keep the same file while another camera starts its next clip. */
function advancePlaybackInterval(): boolean {
    const af = activeFrame();
    const master = activePlayer();
    if (!af?.frame.mediaOffsetSec || !state.active || master.paused || master.seeking || pendingSeekTripSec !== null)
        return false;
    if (state.active.frame >= af.trip.frames.length - 1) return false;
    const offset = master.currentTime - frameMediaOffset(af.frame, effectiveMasterChannel());
    if (offset < af.frame.durationSec) return false;
    const range = state.isPreviewZoom ? getSelectedRange() : null;
    const contentSec = naturalTripCurrentTime();
    if (range && contentSec >= range.endTripSec - 0.05) return false;
    const next = contentToFrame(af.trip.timeline, contentSec);
    if (next.index <= state.active.frame) return false;
    playFrame(state.active.trip, next.index, next.offsetInFrame, true);
    return true;
}

export function driftSyncSlaves(): void {
    const master = activePlayer();
    if (master.paused || master.readyState < 2) return;
    if (advancePlaybackInterval()) return;
    forEachSlave((s, ch) => {
        // MSE feeds change at interval boundaries; this loop only corrects
        // their position within the attached file.
        if (state.channelBackends[ch]) {
            const positionSec = activeSlaveTarget(ch, master.currentTime)?.positionSec ?? master.currentTime;
            if (s.readyState >= 2 && Math.abs(s.currentTime - positionSec) > SLAVE_DRIFT_MAX_SEC) {
                s.currentTime = positionSec;
            }
            return;
        }
        const target = activeSlaveTarget(ch, master.currentTime);
        if (!target) return;
        // The matching content lives in a neighbour file: swap src and let the
        // slave loadedmetadata handler position it. At most one swap per file
        // boundary - the attached file then matches until the next window.
        if (videoAttachedFile.get(s) !== target.cand.file) {
            if (!promoteSlavePreload(ch, target.cand, target.positionSec)) {
                attachCandidateToVideo(ch, s, target.cand, false);
            }
            return;
        }
        if (s.readyState < 2) return;
        const duration = Number.isFinite(s.duration) ? s.duration : Number.POSITIVE_INFINITY;
        // No neighbour file can serve this moment (trip edge, missing or
        // MSE-only neighbour) - hold the boundary frame instead of
        // stutter-looping between the boundary and the resync threshold.
        if (target.positionSec < 0 || target.positionSec > duration) {
            const boundary = target.positionSec < 0 ? 0 : duration;
            if (!s.paused) s.pause();
            if (Math.abs(s.currentTime - boundary) > SLAVE_DRIFT_MAX_SEC) s.currentTime = boundary;
            return;
        }
        // Leaving a hold window: the play/pause proxy only mirrors master
        // EVENTS, so a slave paused by the hold above must be resumed here.
        if (s.paused) s.play().catch(() => {});
        if (Math.abs(s.currentTime - target.positionSec) > SLAVE_DRIFT_MAX_SEC) {
            s.currentTime = target.positionSec;
        }
    });
}

/**
 * Returns true if the player is at the very end of the last frame of the current trip
 * (video has reached ended on the last clip and is not looping).
 * Used by the play button to restart the whole trip rather than the last clip.
 */
function isAtTripEnd(): boolean {
    const af = activeFrame();
    if (!af) return false;
    if (state.active!.frame !== af.trip.frames.length - 1) return false;
    // A clip closed by a tail decode failure never reports ended or its duration.
    if (activeClipEndedByFailure) return true;
    // ended event is the most reliable signal; currentTime vs durationSec is a fallback
    // (in HLS/MSE ended may not fire correctly; our <video src=blob> works fine).
    if (dom.player.ended) return true;
    const dur = dom.player.duration;
    if (!Number.isFinite(dur) || dur <= 0) return false;
    return dom.player.currentTime >= dur - 0.05;
}

/**
 * Index of the chronologically next trip (smallest startUtc strictly greater than
 * the current trip's), or -1 if the current trip is the last by time. Independent
 * of the sidebar sort order so "play all trips" follows the drive's real timeline,
 * not whatever column the list is sorted by.
 */
function chronologicalNextTripIndex(curTripIdx: number): number {
    const cur = state.trips[curTripIdx];
    if (!cur) return -1;
    let bestIdx = -1;
    let bestStart = Number.POSITIVE_INFINITY;
    // Order by (startUtc, index): a trip with the SAME startUtc but a higher index
    // still counts as "after", so two cameras sharing an identical startUtc
    // (fingerprint-partitioned trips or provisional filename dates) are reachable
    // instead of being skipped by a strict > comparison.
    state.trips.forEach((other, i) => {
        if (i === curTripIdx) return;
        const isAfter = other.startUtc > cur.startUtc || (other.startUtc === cur.startUtc && i > curTripIdx);
        if (!isAfter) return;
        if (bestIdx === -1 || other.startUtc < bestStart || (other.startUtc === bestStart && i < bestIdx)) {
            bestStart = other.startUtc;
            bestIdx = i;
        }
    });
    return bestIdx;
}

/**
 * Current playback position in trip coordinates.
 * Returns seconds from the start of the trip, or 0 when nothing is active.
 */
export function getTripCurrentTime(): number {
    // While a slow cross-file / re-attach seek loads, report the requested
    // target so the playhead lands on the click immediately instead of bouncing
    // through the loading file's start (currentTime=0). Cleared once the seek
    // actually lands (see seekTripTime / the loadedmetadata+seeked handlers).
    if (pendingSeekTripSec != null) return pendingSeekTripSec;
    return naturalTripCurrentTime();
}

/** Seeks a mask/detector timestamp through the actual master-channel file. */
export function seekPresentedContentTime(contentSec: number): void {
    const trip = activeTrip();
    if (!trip) return;
    const destination = trip.frames[contentToFrame(trip.timeline, contentSec).index];
    const channel = destination
        ? (pickFrameChannel(destination, mainChannel())?.channel ?? mainChannel())
        : mainChannel();
    seekTripTime(playbackTimeForContent(trip.timeline, tripCandidatesByChannel(trip, channel), contentSec));
}

/** Real trip position read straight from the active <video>, ignoring any
 *  in-flight seek pin. Used to detect when a pinned seek has actually landed. */
function naturalTripCurrentTime(): number {
    const af = activeFrame();
    if (!af || !state.active) return 0;
    // active.frame can go out of bounds during a race with progressive sidebar re-render
    // (state.trips was rebuilt, the index is stale) - activeFrame guards against UI crashes on an innocent timeupdate.
    // Footage-time position: the active frame's content start (pauses already
    // removed) plus the in-file playback offset.
    const seg = af.trip.timeline.segments[state.active.frame];
    if (!seg) return 0;
    return seg.contentStart + (dom.player.currentTime || 0) - frameMediaOffset(af.frame, effectiveMasterChannel());
}

/** Pins the reported trip position to `target` while a slow seek loads. */
function setPendingSeek(target: number): void {
    pendingSeekTripSec = target;
    if (pendingSeekClearTimer !== null) clearTimeout(pendingSeekClearTimer);
    // Safety net: a failed / pathological load must never freeze the playhead
    // pinned at the target. 6s is well past any realistic SD-card file open.
    pendingSeekClearTimer = setTimeout(clearPendingSeek, 6000);
}

/** Releases the in-flight seek pin so the playhead tracks the real position. */
function clearPendingSeek(): void {
    pendingSeekTripSec = null;
    if (pendingSeekClearTimer !== null) {
        clearTimeout(pendingSeekClearTimer);
        pendingSeekClearTimer = null;
    }
}

/** Clears the pin once the real position has reached the pinned target (the
 *  offset-seek landed). A stray early signal while the file is still at its
 *  start (natural far below target) must NOT clear it. */
function clearPendingSeekIfLanded(): void {
    if (pendingSeekTripSec == null) return;
    if (Math.abs(naturalTripCurrentTime() - pendingSeekTripSec) < 0.4) clearPendingSeek();
}

/** Arms the seekThenPlay latch: resume playback once a seek lands near `target`. */
function armResumeAfterSeek(target: number): void {
    resumeAfterSeekTarget = target;
    isPlaybackIntended = true;
    if (resumeAfterSeekTimer !== null) clearTimeout(resumeAfterSeekTimer);
    // Same 6s bound as the pending-seek pin: past any realistic SD-card file open.
    resumeAfterSeekTimer = setTimeout(disarmResumeAfterSeek, 6000);
}

/** Drops the seekThenPlay latch (landed, load error, or safety timeout). */
function disarmResumeAfterSeek(): void {
    resumeAfterSeekTarget = null;
    if (resumeAfterSeekTimer !== null) {
        clearTimeout(resumeAfterSeekTimer);
        resumeAfterSeekTimer = null;
    }
}

/** Resumes playback once a seekThenPlay's seek has landed near its target. Wired
 *  to BOTH 'seeked' and loadedmetadata, mirroring clearPendingSeekIfLanded: a
 *  cross-file seek to a frame-start target (offset 0) writes no currentTime and so
 *  fires no 'seeked', landing only via loadedmetadata. The near-target guard
 *  ignores a stray early signal from a reloading file still sitting at its start;
 *  double-firing across both events is harmless (disarm makes it idempotent). */
function resumePlaybackIfSeekLanded(): void {
    if (resumeAfterSeekTarget == null) return;
    if (Math.abs(naturalTripCurrentTime() - resumeAfterSeekTarget) < 0.4) {
        disarmResumeAfterSeek();
        dom.player.play().catch(() => {});
    }
}

/**
 * UX-08/UX-15/UX-19: starts a trip at the N-th event (or seeks to it if already active).
 * Seeks to `event.relSec - 5` (clamped to [0, durationSec]) and pauses so the user can orient
 * (same pattern as drag-zoom).
 */
export function playTripEvent(tripIdx: number, eventIndex: number): void {
    const trip = state.trips[tripIdx];
    if (!trip) return;
    const ev = trip.events[eventIndex];
    if (!ev) return;
    // ev.relSec is on the footage axis; contentToFrame maps it to (frame, offset).
    const target = Math.max(0, ev.relSec - 5);
    if (state.active && state.active.trip === tripIdx) {
        // Trip already active: playFrame would silently NOT seek on a
        // same-file target - its offset is consumed by loadedmetadata, which
        // never fires without a src change (and the MSE same-file branch
        // would even reset playback to the file start). seekTripTime handles
        // both backends; pause first to honor the "pauses so the user can
        // orient" contract above.
        if (!dom.player.paused) dom.player.pause();
        seekTripTime(target);
        return;
    }
    const at = contentToFrame(trip.timeline, target);
    // autoPlay=false: pause so the user can decide whether to play.
    playFrame(tripIdx, at.index, at.offsetInFrame, /*autoPlay=*/ false);
}

/**
 * Seeks to a position in the trip timeline. Switches src when landing in a different file
 * and applies the offset via pendingFileOffset. In MSE mode each channel seeks in its own
 * SourceBuffer within the unified trip timeline - frame transitions are transparent.
 * @param targetSec seconds from the start of the trip.
 */
export function seekTripTime(targetSec: number): void {
    if (!state.active) return;
    const trip = state.trips[state.active.trip];
    if (!trip || trip.frames.length === 0) return;

    let target = Math.max(0, Math.min(trip.timeline.contentDurationSec, targetSec));
    // A Preview-clip window acts as a "virtual trip": all seeks (arrows, J/L, jump-digits, chart click)
    // are clamped to its boundaries. Without this the user can seek past the selection with arrow keys,
    // the player plays in the grey chart area, and in MSE mode that triggers an out-of-buffer re-attach loop with a CPU spike.
    // Only a preview window clamps; an inspection zoom lets seeks roam the whole
    // trip (the window follows the playhead instead of trapping it).
    const sel = getSelectedRange();
    if (sel && sel.trip === trip && state.isPreviewZoom) {
        target = Math.max(sel.startTripSec, Math.min(sel.endTripSec, target));
    }

    // No-op short-circuit: if the requested position matches the current one, do nothing.
    // Without this, "right arrow at the end of a selection" clamps target=endTripSec, then
    // timeupdate's auto-end-of-selection calls seekTripTime(endTripSec) again, and in MSE
    // mode that becomes an infinite re-attach loop (each seek = new MediaSource + setInterval + feed).
    // 0.01s threshold is below any reasonable MSE seek precision.
    const cur = getTripCurrentTime();
    if (Math.abs(target - cur) < 0.01) return;

    // Resolve the frame containing target + the offset inside it (footage axis).
    const at = contentToFrame(trip.timeline, target);
    const { index: frameIdx, offsetInFrame } = at;
    const frame = trip.frames[frameIdx]!;
    const masterOffsetSec = offsetInFrame + frameMediaOffset(frame, effectiveMasterChannel());

    if (state.active.frame !== frameIdx) {
        // Save current play state - if playing, continue after the frame switch.
        const wasPlaying = !dom.player.paused;
        // Cross-file seek = a new <video> src that must load (slow on SD cards).
        // Pin the playhead to the target so it lands on the click immediately
        // instead of bouncing to the new file's start (currentTime=0) first.
        setPendingSeek(target);
        playFrame(state.active.trip, frameIdx, offsetInFrame, wasPlaying);
        return;
    }
    // Same frame. If an active MSE backend exists and the target is outside its buffered range,
    // a feed restart is required (see reattachBackendsAtOffset). For pure native channels,
    // writing currentTime is sufficient - the browser handles the seek natively.
    const wasPlaying = !dom.player.paused;
    const reattachedChannels = reattachBackendsAtOffset(frame, offsetInFrame, wasPlaying);
    if (reattachedChannels.size > 0) {
        // MSE re-attach reloads the backend (slow) - pin the playhead to target
        // like the cross-file path so it does not bounce to the frame start.
        setPendingSeek(target);
        // Each backend buffers independently. Channels whose target is already
        // buffered need a direct seek even when another channel restarts its feed.
        for (const ch of ALL_CHANNELS) {
            if (reattachedChannels.has(ch)) continue;
            const v = channelPlayers[ch];
            if (!v.getAttribute("src")) continue;
            if (v === activePlayer() || state.channelBackends[ch]) {
                v.currentTime = offsetInFrame + frameMediaOffset(frame, ch);
                continue;
            }
            // Slaves land drift-adjusted, possibly in a neighbour file.
            const slaveTarget = activeSlaveTarget(ch, masterOffsetSec);
            if (slaveTarget) applySlaveTarget(ch, v, slaveTarget);
            else v.currentTime = offsetInFrame;
        }
        updatePlayerProgressUi();
        return;
    }
    dom.player.currentTime = masterOffsetSec;
    updatePlayerProgressUi();
}

/**
 * Seeks to `targetSec` and starts playback once the seek lands. Unlike a bare
 * seekTripTime + play(), this survives a slow cross-file / MSE re-attach seek:
 * an immediate play() would race the async src load. When already at the target
 * (seekTripTime short-circuits and emits no 'seeked'), plays right away.
 * Used by the double-click "Preview clip" = play the clip from its start.
 */
export function seekThenPlay(targetSec: number): void {
    if (!state.active) return;
    const trip = state.trips[state.active.trip];
    if (!trip || trip.frames.length === 0) return;
    // At rest on the target already: seekTripTime would no-op and fire no
    // 'seeked', so the latch would never resolve - play directly. Read the REAL
    // position (not getTripCurrentTime): while a cross-file seek is in flight the
    // reported position is pinned to the target though the <video> is still
    // loading, and a bare play() would race that load. So a pending seek falls
    // through to the latch, which the in-flight seek's own landing 'seeked'
    // resolves. 0.05s is within a frame.
    if (pendingSeekTripSec == null && Math.abs(naturalTripCurrentTime() - targetSec) < 0.05) {
        dom.player.play().catch(() => {});
        return;
    }
    armResumeAfterSeek(targetSec);
    seekTripTime(targetSec);
}

export function syncPlayButton(): void {
    const paused = dom.player.paused;
    // SVG icons (.i-play / .i-pause) are already in the DOM; flip [hidden].
    // data-paused is also used in CSS for the orange background on pause.
    const playIcon = dom.playerBar.play.querySelector<SVGElement>(".i-play");
    const pauseIcon = dom.playerBar.play.querySelector<SVGElement>(".i-pause");
    if (playIcon) playIcon.toggleAttribute("hidden", !paused);
    if (pauseIcon) pauseIcon.toggleAttribute("hidden", paused);
    dom.playerBar.play.dataset.paused = paused ? "true" : "false";
    const label = paused ? t("player.play") : t("player.pause");
    dom.playerBar.play.setAttribute("aria-label", label);
    dom.playerBar.play.title = paused ? t("player.playTooltip") : t("player.pauseTooltip");
}

/**
 * Composes all player subsystems over the playback core. Call once at startup,
 * after initChart - the chart cursorPlugin depends on getTripCurrentTime
 * exported below. Public-API list lives in the file header comment.
 */
export function initPlayer(): void {
    initPlayerFrameTimes();
    registerGpsSyncRefreshListener(() => {
        renderTrips();
        const trip = activeTrip();
        if (trip) {
            rebuildChartFromTrip(trip);
            refreshMap(trip);
        }
        resyncMetricsForTrip();
    });

    // Initialize data-view-mode immediately - without it CSS selectors
    // `.video-grid[data-view-mode="focus"]` won't match and tiles end up in the default (split-like) display.
    // On single-channel this isn't visible (one tile fills the area in either mode), but the first ingest
    // of a multichannel trip needs the correct focus-layout from the start.
    dom.videoGrid.dataset.viewMode = isFocusLayout(state.composition.layout) ? "focus" : "split";
    dom.videoGrid.dataset.layout = state.composition.layout;
    syncViewModeButton();

    // Export-mode toggles -> recompute --dc-output-aspect so the letterbox
    // snaps to the right shape on open/close. Same subscriber catches
    // outputPresetId changes (top-panel writes them and notifies).
    let wasExportModeOpen = state.exportModeOpen;
    subscribeExportState(() => {
        syncOutputAspect();
        // Keep the digital-zoom badge in sync with export mode: it must hide while
        // the crop editor owns the transform. applyVideoZoom updates the badge then
        // bails early in export mode (cheap), and re-applies zoom on close.
        applyVideoZoom();
        // Warm slots hold decoder sessions the export pipeline needs for
        // itself; release them while export mode is open and warm up again
        // when playback is back in charge.
        if (state.exportModeOpen !== wasExportModeOpen) {
            wasExportModeOpen = state.exportModeOpen;
            if (state.exportModeOpen) clearAllPreloadSlots();
            else schedulePreloadNext();
        }
    });

    initPlayerVolume({ applyAudioRouting: syncAudioRouting });

    dom.viewModeBtn.addEventListener("click", toggleViewMode);

    initPlayerZoom();

    initPlayerTileInput({
        toggleFullscreen,
        toggleViewMode,
        applyComposition,
        consumeDragClickSuppress,
        flashPlaybackToggle,
    });

    initTileReorder({ applyComposition, resetZoom: resetVideoZoom });

    initPipInteractions();

    // Slave loadedmetadata: sync currentTime to active. Active loadedmetadata
    // is handled via onActivePlayerEvent above (with pendingFileOffset).
    // Listeners are attached to BOTH slots per channel: after swapActiveSlot the physically
    // active element becomes slot[1], and without installing on both the listener misses the new active.
    // isActiveSlot filter excludes preload slots: a preload should sit at 0 (fresh start),
    // not chase the master - otherwise a promoted preload would play from the middle of the file.
    forEachVideoSlot((v, ch) => {
        v.addEventListener("loadedmetadata", () => {
            if (v === activePlayer()) return; // master is handled by a separate listener
            if (!isActiveSlot(v)) return; // preload slot - don't sync
            const master = activePlayer();
            if (!master.src) return;
            // Slave catches up to master: same wall moment (drift-adjusted,
            // clamped into the file - driftSyncSlaves holds boundaries while
            // playing) + playbackRate. When the attached file is not the one
            // the resolver wants, position plainly and let the rAF loop swap.
            // MSE-backed channels take this path too, harmlessly: leads are
            // only measured for native-playable families, so for them the
            // resolver position degenerates to the plain mirror.
            const target = activeSlaveTarget(ch, master.currentTime);
            const pos =
                target && videoAttachedFile.get(v) === target.cand.file ? target.positionSec : master.currentTime;
            v.currentTime = Math.min(Math.max(pos, 0), Number.isFinite(v.duration) ? v.duration : pos);
            v.playbackRate = state.preferredPlaybackRate;
            // If master is playing, slave plays too (but muted).
            if (!master.paused) v.play().catch(() => {});
        });
    });

    onActivePlayerEvent("play", () => {
        isPlaybackIntended = true;
        syncPreviewThrottle();
        forEachSlave((s) => {
            s.play().catch(() => {});
        });
    });
    onActivePlayerEvent("pause", () => {
        if (!isInternalPause()) isPlaybackIntended = false;
        syncPreviewThrottle();
        forEachSlave((s) => {
            s.pause();
        });
    });
    // Clip ends and reloads re-sync the throttle too; it reads the intent, so a
    // mid-trip 'ended' keeps previews throttled through the swap and only a
    // terminal end (stopAtTripEnd) or a user pause releases them.
    onActivePlayerEvent("ended", syncPreviewThrottle);
    onActivePlayerEvent("emptied", syncPreviewThrottle);
    onActivePlayerEvent("seeked", () => {
        const master = activePlayer();
        forEachSlave((s, ch) => {
            if (state.channelBackends[ch]) {
                s.currentTime = activeSlaveTarget(ch, master.currentTime)?.positionSec ?? master.currentTime;
                return;
            }
            const target = activeSlaveTarget(ch, master.currentTime);
            if (!target) {
                s.currentTime = master.currentTime;
                return;
            }
            applySlaveTarget(ch, s, target);
        });
    });
    onActivePlayerEvent("ratechange", () => {
        const master = activePlayer();
        forEachSlave((s) => {
            s.playbackRate = master.playbackRate;
        });
    });

    // Loading overlay (spinner on black). Show is triggered in attachCandidateToVideo when creating
    // a per-file MSE backend for hev1 files (mediabunny on 4K HEVC takes ~300-1000ms for moov + first keyframe),
    // plus from "waiting" (buffering during play). Hide is tied to all events meaning "decoder has data":
    // playing fires on play, canplay/loadeddata on pause. If none fires, the safety timer in showLoadingOverlay
    // hides it after MAX_OVERLAY_MS. "seeking" does NOT show the overlay - a cheap in-buffer seek should not flicker.
    onActivePlayerEvent("waiting", showLoadingOverlay);
    onActivePlayerEvent("playing", hideLoadingOverlay);
    onActivePlayerEvent("canplay", hideLoadingOverlay);
    onActivePlayerEvent("loadeddata", hideLoadingOverlay);
    forEachVideoSlot((v, ch) => {
        v.addEventListener("loadeddata", () => {
            if (!isActiveSlot(v) || v.readyState < v.HAVE_CURRENT_DATA) return;
            const cand = attachedCandidate(v, ch);
            if (cand) decodeRetryCount.delete(cand);
        });
    });
    onActivePlayerEvent("emptied", hideLoadingOverlay);
    // Release the in-flight seek pin once the offset-seek lands (native + MSE
    // paths both end in a 'seeked'); the near-target guard ignores a stray
    // early 'seeked' while the file is still at its start.
    onActivePlayerEvent("seeked", clearPendingSeekIfLanded);
    onActivePlayerEvent("seeked", resumePlaybackIfSeekLanded);
    forEachVideoSlot((v, ch) =>
        v.addEventListener("error", () => {
            if (!isActiveSlot(v)) return;
            const cand = attachedCandidate(v, ch);
            const err = v.error;
            if (!cand || !err) return;
            const position = playbackRetryPosition(v);
            if (v === activePlayer()) {
                hideLoadingOverlay();
                // A failed load will never fire the landing 'seeked' - drop the pin now
                // so the playhead is not frozen at the target until the safety timeout.
                clearPendingSeek();
                // Same for the seekThenPlay latch: the target will never land.
                disarmResumeAfterSeek();
            }
            // Log MediaError for diagnosing runtime-decode failures. This does not overlap with MSE backend errors
            // (those go through onError callbacks, a separate path). This catches: native-decode failures,
            // network errors on blob URLs (theoretically impossible for File-based blobs, but defensive),
            // codec failures on a specific file even if the canPlay check passed. MediaError.code:
            //   1 MEDIA_ERR_ABORTED        (user cancelled via play() promise)
            //   2 MEDIA_ERR_NETWORK        (for blob:File - should not happen)
            //   3 MEDIA_ERR_DECODE         (decoder crashed on a packet)
            //   4 MEDIA_ERR_SRC_NOT_SUPPORTED (browser does not support the codec)
            log.warn("video element error", {
                code: err.code,
                message: err.message,
                file: videoAttachedFile.get(v)?.name ?? null,
                currentTime: v.currentTime,
            });
            // Surface a real decode/source failure to the user, mirroring the MSE
            // path (onBackendError). Only DECODE(3) and SRC_NOT_SUPPORTED(4) are
            // genuine - ABORTED(1) is the benign play()/source-swap interruption and
            // NETWORK(2) cannot happen for a blob:File source; both stay silent.
            // DECODE(3) is transient (a crashed decoder, an exhausted decoder pool
            // under preview contention) -> retry; SRC_NOT_SUPPORTED(4) is a genuine
            // codec rejection -> permanent overlay.
            if (err.code === MediaError.MEDIA_ERR_DECODE || err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
                const backend = state.channelBackends[ch] ? "mse" : "native";
                const failed = handleRuntimeDecodeFailure(
                    cand,
                    ch,
                    err.code === MediaError.MEDIA_ERR_DECODE,
                    `native-mediaerror-${err.code}`,
                    position,
                );
                if (failed) {
                    captureSentryMessage("video decode failed", {
                        level: "warning",
                        fingerprint: ["video_decode_error", String(err.code), cand.codec ?? "unknown"],
                        tags: { feature: "playback", backend, code: String(err.code), codec: cand.codec ?? "unknown" },
                        extra: { mediaErrorMessage: err.message },
                    });
                }
            }
        }),
    );

    onActivePlayerEvent("loadedmetadata", () => {
        // Restore the saved playback rate - the browser resets it to 1 on every src change.
        // Without this a trip with 10 files would require re-selecting the speed 9 times.
        if (state.preferredPlaybackRate !== 1) {
            dom.player.playbackRate = state.preferredPlaybackRate;
        }
        // Volume/mute likewise: some browsers reset them on src change. Restore
        // via the ROUTING, not by writing preferred* onto dom.player directly:
        // the audio source is composition.audioChannel, which may not be the
        // active element - the direct write unmuted the master at preferred
        // volume on every file boundary, producing two audible channels (echo)
        // until the next syncFrameToGrid.
        syncAudioRouting();
        if (pendingFileOffset > 0) {
            // If the requested offset exceeds the real file duration, clamp it.
            const safe = Math.min(pendingFileOffset, dom.player.duration || pendingFileOffset);
            dom.player.currentTime = safe;
            pendingFileOffset = 0;
        }
        if (pendingPlay) {
            pendingPlay = false;
            // play() returns a Promise. Ignore rejections (e.g. autoplay policy blocks until a user gesture).
            dom.player.play().catch(() => {});
        }
        syncPlayButton();
        // Zoom survives src changes within a trip, but the aspect/frame size
        // may change on src swap (rare but possible) - clamp offsets to the
        // new geometry and recompute the minimap frame.
        reclampAndApplyZoom();
        // Active finished loading metadata - kick preload of the next file so we can swap without a micro-pause on 'ended'.
        // If there is no next frame or master doesn't match, schedulePreloadNext will clean the slot itself.
        schedulePreloadNext();
        // The pinned seek (if any) has now applied its offset (currentTime set
        // above, or 0 for a frame-start target) - release the pin so the
        // playhead resumes tracking the real position.
        clearPendingSeekIfLanded();
        // Same landing point for the seekThenPlay latch: a cross-file seek to a
        // frame-start target (offset 0) writes no currentTime above, so it fires
        // no 'seeked' - without this the latch would hang until its safety timeout
        // and the clip would never start.
        resumePlaybackIfSeekLanded();
    });

    onActivePlayerEvent("ended", finishActiveClip);
    initPlayerControls();
}

/**
 * What happens when the active clip is over: the next clip of the trip (via
 * the warm preload slot when it is ready, else a full reload), a loop wrap,
 * the chronologically next trip, or a stop. Wired to 'ended' and reused when a
 * decode failure in the clip tail stands in for an end the decoder cannot reach.
 */
function finishActiveClip(): void {
    if (!state.active) return;
    const trip = state.trips[state.active.trip];
    if (!trip) return;
    const isLastFrame = state.active.frame >= trip.frames.length - 1;
    let nextFrameIdx: number | null;
    if (!isLastFrame) {
        nextFrameIdx = state.active.frame + 1;
        // Crossing a recording pause: the footage axis collapses it, so
        // playback jumps forward in wall-clock. Tell the user why the clock
        // skipped. Loop-wraps (the branch below) are not a pause - no toast.
        const seg = trip.timeline.segments[nextFrameIdx];
        const gap = seg ? trip.timeline.gaps.find((g) => g.contentPos === seg.contentStart) : undefined;
        if (gap) {
            notify({
                severity: "info",
                messageKey: "player.pauseSkipped",
                messageParams: { duration: formatDuration(gap.durationSec) },
            });
        }
    } else if (state.tripEndBehavior === "loop") {
        nextFrameIdx = 0;
    } else if (
        state.tripEndBehavior === "advance" &&
        !(getSelectedRange() && state.isPreviewZoom) &&
        !state.exportModeOpen
    ) {
        // Advance to the chronologically next trip (by startUtc, independent of
        // the sidebar sort order). A Preview-clip window falls through to the
        // stop path below - a bounded clip ending must not jump trips. An
        // inspection zoom does NOT block advance: it follows the playhead
        // through the whole trip, so trip end behaves like the unzoomed case.
        // No next trip -> also stop (parked on the last-by-time trip). Open
        // export mode also stops so a resumed clip cannot auto-advance and let
        // the trip switch silently wipe the export range being assembled
        // (resetExportRangeForTrip).
        const nextTripIdx = chronologicalNextTripIndex(state.active.trip);
        if (nextTripIdx >= 0) {
            playFrame(nextTripIdx, 0, 0, isPlaybackIntended);
            return;
        }
        stopAtTripEnd();
        return;
    } else {
        // Last file, not looping - leave the player at the end, progress at maximum.
        stopAtTripEnd();
        return;
    }
    // Try swapping the preload slot first (no micro-pause). If the preload hasn't warmed up yet,
    // the file doesn't match, or the master channel for the next frame is different,
    // tryPromotePreloadAsActive returns false and we fall back to a normal playFrame (100-300ms decoder reload).
    if (tryPromotePreloadAsActive(nextFrameIdx)) return;
    playFrame(state.active.trip, nextFrameIdx, 0, isPlaybackIntended);
}

/** The trip is over and nothing follows: playback is no longer intended, so
 *  background previews may use the decoders again. */
function stopAtTripEnd(): void {
    isPlaybackIntended = false;
    syncPreviewThrottle();
    syncPlayButton();
    updatePlayerProgressUi();
}

/**
 * A 'pause' that playback itself caused rather than the user: the clip reached
 * its end (finishActiveClip decides what follows), a source swap or seek with a
 * resume already armed, or the MSE backend holding the element for its own
 * reseek. Only the other pauses express the user's intent to stop.
 */
function isInternalPause(): boolean {
    const v = dom.player;
    if (v.ended) return true;
    if (pendingPlay || resumeAfterSeekTarget !== null) return true;
    return state.channelBackends[effectiveMasterChannel()]?.isPausedBySeek === true;
}

/** Toolbar/keyboard/scrubber subsystems and the timeupdate pipeline; the
 *  second half of initPlayer, split out so the media-event plumbing above
 *  stays readable. */
function initPlayerControls(): void {
    onActivePlayerEvent("play", syncPlayButton);
    onActivePlayerEvent("pause", syncPlayButton);
    onActivePlayerEvent("volumechange", syncMuteButton);

    // Before initPlayerHotkeys: the , / . hotkeys call stepFrame, which is a
    // no-op until initFrameStep arms it with these deps.
    initFrameStep({ getTripCurrentTime, seekTripTime });
    initSeekButtons({ getTripCurrentTime, seekTripTime });

    initPlayerHotkeys({
        getTripCurrentTime,
        seekTripTime,
        playFrameFromStart: () => {
            if (!state.active) return;
            playFrame(state.active.trip, 0, 0, true);
        },
        isAtTripEnd,
        toggleMuted,
        toggleFullscreen,
        toggleLoop,
        flashPlaybackToggle,
        zoomTimeline: zoomTimelineStep,
        cyclePlaybackRate,
        captureFrame: captureFrameNow,
        resetVideoZoom,
        panTimelineToInclude,
        isSpeedMenuOpen,
        closeSpeedMenu,
        focusSpeedButton,
    });

    initPlayerScrubber({ getTripCurrentTime, seekTripTime });
    initPlayerSpeed();

    onActivePlayerEvent("ratechange", syncSpeedButton);

    initPlayerFullscreen();
    dom.playerBar.capture.addEventListener("click", captureFrameNow);

    // Sync capture button on frame readiness / src change. loadeddata fires when readyState >= HAVE_CURRENT_DATA, which is what drawImage requires.
    onActivePlayerEvent("loadeddata", syncCaptureButton);
    onActivePlayerEvent("emptied", syncCaptureButton);

    initPlayerLoop();

    // Chromium fires timeupdate every 250 ms, so a playhead driven only by it
    // steps visibly while the map marker already follows presented frames.
    // Presented frames repaint the playhead, clock and progress thumb once per
    // display frame (all slots coalesce into one rAF); timeupdate below keeps
    // the range, loop and metrics logic.
    let progressFrameRequest = 0;
    subscribePlayerFrames(() => {
        if (progressFrameRequest !== 0) return;
        progressFrameRequest = requestAnimationFrame(() => {
            progressFrameRequest = 0;
            updatePlayerProgressUi();
        });
    });

    // timeupdate: update progress UI and metrics.
    onActivePlayerEvent("timeupdate", () => {
        updatePlayerProgressUi();
        // Chart-zoom playback has two behaviors, split by isPreviewZoom:
        //  - Preview window (bounded): at the right boundary, mirror trip-end -
        //    seek to range start (loop) or pause (stop). Without this, playback
        //    escapes the clip and continues along the track.
        //  - Inspection zoom (follow): auto-pan the window to keep the playhead in
        //    view; playback runs the whole trip (see followPlayheadInZoom).
        if (state.isPreviewZoom) {
            const range = getSelectedRange();
            if (range && getTripCurrentTime() >= range.endTripSec - 0.05) {
                if (state.tripEndBehavior === "loop") {
                    seekTripTime(range.startTripSec);
                } else if (!dom.player.paused) {
                    // Stop mode: single pause + snap to the exact endTripSec.
                    // !paused guard prevents re-entry: after the first pause the browser may
                    // still emit timeupdate (async pause), and without the guard
                    // seekTripTime(endTripSec) would fire again, triggering an MSE backend re-attach loop.
                    dom.player.pause();
                    seekTripTime(range.endTripSec);
                }
            }
        } else {
            followPlayheadInZoom(getTripCurrentTime());
        }
        advancePlaybackInterval();
        refreshMetricsHere();
    });

    initPlayerMetrics(getTripCurrentTime);
}

/** Adapter: closes over getTripCurrentTime so call sites read as one line. */
function refreshMetricsHere(): void {
    refreshMetricsFromActiveFrame(getTripCurrentTime());
}

/** Mirrors the real playing state onto the preview-generation throttle: while a
 *  trip plays, background preview decoding yields the hardware decoder pool. */
function syncPreviewThrottle(): void {
    setPreviewPlaybackActive(isPlaybackIntended);
}

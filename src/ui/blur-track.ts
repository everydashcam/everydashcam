// Main-thread client of the blur-zone auto-tracking pass. Owns the tracker
// worker singleton and the per-region pass state the panel renders (progress,
// cancel). The heavy work - decode + vittrack inference - runs in
// src/workers/tracker-worker.ts; this module slices the trip range into plain
// segments, fires the request, and folds the resulting keyframes back into the
// region (unpinned - user pins stay authoritative, replaceGeneratedKeyframes).

import type { BlurRegion } from "../blur-regions.js";
import { applyTrackResult, followSeed } from "../blur-follow.js";
import { sliceTripChannelForRange } from "../export-range.js";
import { createLogger } from "../log.js";
import { captureSentryException, captureSentryMessage } from "../sentry.js";
import type { Trip } from "../trips.js";
import {
    TRACK_NOTIFY_PROGRESS,
    TRACK_NOTIFY_STARTED,
    TRACK_REQUEST,
    type TrackProgressData,
    type TrackRequestData,
    type TrackResult,
} from "../workers/tracker-protocol.js";

import { notifyBlurRegionsChanged, subscribeBlurTripRegroup } from "./blur-regions-state.js";
import { captureBlurTripSource, matchesBlurTripSource, type BlurTripSource } from "./blur-trip-source.js";
import { notify } from "./notifications.js";
import { TRACKER_MODEL_URL, TRACKER_ORT_ASSETS } from "./blur-assets.js";
import { subscribeTrackerWorkerNotifications, trackerWorkerClient } from "./tracker-worker-client.js";

const log = createLogger("blur-track");

// Route this pass's progress off the shared worker's notification stream
// (tracker-worker-client.ts - the worker is shared with blur-detect).
subscribeTrackerWorkerNotifications((msg) => {
    if (msg.type !== TRACK_NOTIFY_PROGRESS && msg.type !== TRACK_NOTIFY_STARTED) return;
    const data = msg.data as Partial<TrackProgressData> & { regionId?: string; passId?: string };
    const pass = data.regionId ? runningPasses.get(data.regionId) : null;
    if (pass && pass.passId === data.passId && !pass.controller.signal.aborted) {
        if (msg.type === TRACK_NOTIFY_PROGRESS && data.fractionDone !== undefined) {
            pass.fractionDone = data.fractionDone;
        }
        // Started is emitted INSIDE the worker's serialization gate: queue wait
        // is excluded, but model creation/decode before the first progress tick
        // is covered. Later progress ticks reset the inactivity cap.
        pass.armTimeout?.();
        notifyPassChanged();
    }
});

/** A full pass decodes the zone span once (7-36x realtime) + ~10ms/frame of
 *  WASM inference; 60s of footage lands around a minute on slow hardware.
 *  Used as an INACTIVITY cap (reset on every progress tick), so it only catches
 *  a wedged worker - a slow-but-progressing pass never trips it, however long. */
const TRACK_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

interface RunningPass {
    trip: Trip;
    source: BlurTripSource;
    passId: string;
    controller: AbortController;
    /** 0..1, updated from worker progress notifications. */
    fractionDone: number;
    /** (Re)arms the inactivity timeout. Called on every progress notification so
     *  the cap is measured from the pass's own decode activity, not from when it
     *  was requested - a pass queued behind another (the worker runs one at a
     *  time) must not count that queue wait toward its timeout. Set by
     *  toggleTrackPass; absent until the pass is wired. */
    armTimeout?: () => void;
}

// Passes keyed by region id; the panel polls via trackPassOf on its sync.
const runningPasses = new Map<string, RunningPass>();

subscribeBlurTripRegroup((oldTrips, newTrips) => {
    for (const pass of runningPasses.values()) {
        if (pass.controller.signal.aborted || !oldTrips.includes(pass.trip)) continue;
        const replacement = newTrips.find((trip) => matchesBlurTripSource(pass.source, trip));
        if (replacement) pass.trip = replacement;
        else pass.controller.abort();
    }
});

let passCounter = 0;
type Listener = () => void;
const passListeners = new Set<Listener>();

/** Subscribes to pass lifecycle/progress changes (panel re-render hook). */
export function subscribeTrackPasses(listener: Listener): () => void {
    passListeners.add(listener);
    return () => passListeners.delete(listener);
}

function notifyPassChanged(): void {
    for (const l of passListeners) l();
}

/** Running pass state for a region, or null. */
export function trackPassOf(regionId: string): { fractionDone: number } | null {
    const pass = runningPasses.get(regionId);
    return pass ? { fractionDone: pass.fractionDone } : null;
}

/** Aborts a region's in-flight pass, if any. Call before removing a zone: an
 *  orphaned pass keeps decoding and holds the worker's single-pass gate, blocking
 *  the next Follow until it finishes or times out. No-op when nothing is running. */
export function cancelTrackPass(regionId: string): void {
    runningPasses.get(regionId)?.controller.abort();
}

/** Cancels background Follow work that no longer belongs to the visible trip.
 *  Passing null cancels all passes (export mode closed). */
export function cancelTrackPassesExceptTrip(trip: Trip | null): void {
    for (const pass of runningPasses.values()) {
        if (!trip || pass.trip !== trip) pass.controller.abort();
    }
}

export type TrackPassOutcome = "completed" | "cancel-requested" | "cancelled" | "failed" | "not-started";

/**
 * Starts (or cancels, when already running) the tracking pass for a region.
 * Seeds from the last pinned keyframe within the zone, including an automatic
 * end, and tracks forward from that correction. Resulting keyframes replace the
 * unpinned ones in the tracked span.
 *
 * Two end-of-span behaviors, keyed on region.autoEnd:
 *   - autoEnd (the "Follow a moving object" path): tracking OWNS the end. The
 *     pass runs to the end of the footage. A confirmed frame exit or uncertain
 *     target/decode loss shortens the span to the observed departure or last
 *     trusted position. Both ask for review before export.
 *   - manual end (drawn default / "whole clip" / a hand-set end): tracking fills
 *     keyframes only within the fixed span and, on early loss, freeze-holds the
 *     last confident rect to endSec (regionRectAt) rather than trimming - a span
 *     the user set by hand is never silently shortened; over-covering is the safe
 *     direction for a privacy feature. An info notice asks them to verify.
 *
 * Mutates the region + notifies; resolves when the pass settles.
 */
export async function toggleTrackPass(trip: Trip, region: BlurRegion): Promise<TrackPassOutcome> {
    const running = runningPasses.get(region.id);
    if (running) {
        running.controller.abort();
        return "cancel-requested";
    }

    const contentDur = trip.timeline.contentDurationSec;
    const seed = followSeed(region);
    if (!seed) return "not-started";
    const fromSec = Math.max(0, seed.contentSec);
    // autoEnd follows to the end of footage (the pass halts itself on loss);
    // a manual end tracks only within the user's span.
    const toSec = region.autoEnd ? contentDur : region.endSec;
    if (toSec - fromSec < 0.05) return "not-started";

    const segments = sliceTripChannelForRange(trip, region.channel, fromSec, toSec).map((seg) => ({
        file: seg.file,
        startInFile: seg.startInFile,
        endInFile: seg.endInFile,
        tripStart: seg.tripStart,
    }));
    if (segments.length === 0) return "not-started";

    const controller = new AbortController();
    // Inactivity timeout via signal (the client has no built-in timeout): only a
    // wedged worker should ever hit it, a slow-but-progressing pass keeps
    // resetting it. Armed from the FIRST progress tick, not here at request-send:
    // the worker runs passes one at a time (serialize gate), so a pass queued
    // behind another must not count that queue wait - counting it aborted a
    // perfectly healthy pass and silently discarded its result (no keyframes, a
    // misleading "timed out" toast). The worker's STARTED notification arms it
    // from inside that gate, before model creation/decode begins.
    const timeoutCtrl = new AbortController();
    let timedOut = false;
    let timeoutTimer: number | undefined;
    const armTimeout = (): void => {
        if (timeoutTimer !== undefined) window.clearTimeout(timeoutTimer);
        timeoutTimer = window.setTimeout(() => {
            timedOut = true;
            timeoutCtrl.abort();
        }, TRACK_REQUEST_TIMEOUT_MS);
    };
    const passId = `track-${++passCounter}`;
    runningPasses.set(region.id, {
        trip,
        source: captureBlurTripSource(trip),
        passId,
        controller,
        fractionDone: 0,
        armTimeout,
    });
    // Clear any prior "verify the tail" flag while this pass runs - it will be
    // re-set from this pass's own outcome below.
    const previousTrackWarning = region.lastTrackLost;
    region.lastTrackLost = false;
    notifyPassChanged();
    try {
        const request: TrackRequestData & { regionId: string; passId: string } = {
            regionId: region.id,
            passId,
            segments,
            seedContentSec: fromSec,
            seedRect: { ...seed.rect },
            endContentSec: toSec,
            modelUrl: TRACKER_MODEL_URL,
            ortAssets: TRACKER_ORT_ASSETS.wasm,
        };
        let result: TrackResult;
        try {
            result = await trackerWorkerClient().request<TrackResult>(TRACK_REQUEST, request, {
                signal: AbortSignal.any([controller.signal, timeoutCtrl.signal]),
            });
            // A response and a user cancel can cross on the message queue. The
            // explicit cancellation wins even if the worker response was
            // already in flight; never apply late keyframes behind Set time,
            // a trip switch or zone deletion.
            controller.signal.throwIfAborted();
            timeoutCtrl.signal.throwIfAborted();
        } finally {
            if (timeoutTimer !== undefined) window.clearTimeout(timeoutTimer);
        }

        // Automatic timing follows measured motion only. On loss, end at the
        // last trusted observation instead of extending a stationary cover
        // through untracked footage. Manual timing keeps the user's full span.
        applyTrackResult(region, fromSec, toSec, contentDur, result);
        // Persistently flag any non-routine ending for review: the subject may
        // remain visible after tracking stops or reappear later.
        if (result.endReason === "exited") {
            notify({ severity: "warn", messageKey: "export.blur.track.followedEnd" });
        } else if (result.endReason === "lost") {
            notify({ severity: "warn", messageKey: "export.blur.track.lost" });
        }
        notifyBlurRegionsChanged();
        return "completed";
    } catch (err) {
        region.lastTrackLost = previousTrackWarning;
        notifyBlurRegionsChanged();
        if ((err as DOMException)?.name === "AbortError") {
            if (timedOut) {
                // Not a user cancel: the pass ran past the cap (e.g. a near-static
                // subject followed across the whole trip). Say so rather than
                // vanish silently.
                log.warn("track pass timed out", { region: region.id });
                captureSentryMessage("blur tracking timed out", {
                    level: "error",
                    fingerprint: ["blur_tracking_timeout"],
                    tags: { feature: "blur", stage: "tracking" },
                });
                notify({ severity: "warn", messageKey: "export.blur.track.timeout" });
                return "failed";
            } else {
                log.info("track pass cancelled", { region: region.id });
                return "cancelled";
            }
        } else {
            log.warn("track pass failed", { region: region.id, err: String(err) });
            captureSentryException(err, { tags: { feature: "blur", stage: "tracking" } });
            notify({ severity: "warn", messageKey: "export.blur.track.failed" });
            return "failed";
        }
    } finally {
        runningPasses.delete(region.id);
        notifyPassChanged();
    }
}

export function _resetForTests(): void {
    cancelTrackPassesExceptTrip(null);
    runningPasses.clear();
    passListeners.clear();
    passCounter = 0;
}

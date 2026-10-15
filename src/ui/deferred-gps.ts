// Full-scan embedded GPS for a selected trip. Trip opening awaits this work so
// video, map, chart and events appear as one ready payload. Updated clocks and
// boundaries are committed through the shared regroup boundary. Cancelled or
// failed files remain pending for retry.

import type { ClassifiedFile } from "../parsers/registry.js";
import { createLogger } from "../log.js";
import { captureSentryException } from "../sentry.js";
import { tripAllCandidates, type VideoCandidate } from "../trips.js";

import { restampProvisionalMarkers } from "./annotations.js";
import { dispatchParseVideoEmbeddedGpsViaWorker as dispatchParseVideoEmbeddedGps } from "./gps-extract-shim.js";
import {
    cacheRetentionKeysForGpsWork,
    registerEmbeddedGpsCacheArtifacts,
    scheduleIndexCacheWrite,
} from "./ingest-cache.js";
import { embeddedResultHasEffect, mergeAccelIntoCandidates } from "./ingest-core.js";
import { reportParseErrors } from "./ingest-diagnostics.js";
import { commitRecordingTripsWhilePreservingIngest, reanchorRecordingCandidates } from "./ingest-regroup.js";
import { applyEmbeddedGpsFailures, applyEmbeddedGpsResult } from "./embedded-gps-state.js";
import { vendorFileKey } from "./ingest-candidate.js";
import { hideTripPreparation, showTripPreparation, updateTripPreparationProgress } from "./trip-preparation.js";
import { renderTrips } from "./sidebar.js";
import { state } from "./state.js";

const log = createLogger("deferred-gps");

export type DeferredGpsLoadResult = "ready" | "cancelled" | "failed";

// A token spans the complete trip-open chain. Every newer click supersedes older
// async work so it cannot take control of the player after navigation moved on.
let tripOpenSequence = 0;

/**
 * Mints a fresh trip-open token and returns it. Call once at the top of a
 * trip-open chain, before awaiting recording data. A click on a different set
 * of files immediately aborts an obsolete full-file scan so the selected
 * recording gets storage priority; a same-trip re-click keeps the joinable scan.
 */
export function takeTripOpenToken(targetKeys: readonly string[] = []): number {
    if (
        currentDeferredGpsSession &&
        targetKeys.length > 0 &&
        !targetKeys.some((key) => currentDeferredGpsSession?.targetKeys.has(key))
    ) {
        currentDeferredGpsSession.controller.abort();
    }
    return ++tripOpenSequence;
}

/** Whether `token` is still the most recent trip-open click (not superseded). */
export function isCurrentTripOpen(token: number): boolean {
    return token === tripOpenSequence;
}

/** Stops a failed open's scan without superseding its failure notification. */
export function abortDeferredGpsForTripOpen(token: number): void {
    if (isCurrentTripOpen(token)) currentDeferredGpsSession?.controller.abort();
}

/** Supersedes and aborts on-click GPS work before an ingest can regroup trips. */
export function cancelDeferredGpsLoad(): void {
    tripOpenSequence++;
    currentDeferredGpsSession?.controller.abort();
}

/**
 * Starts or joins a heavy embedded-GPS load for all pending trip files in
 * state.pendingHeavyEmbeddedGps. Resolves:
 *  - immediately if the trip has no pending files;
 *  - after parsing completes and the Trip is updated;
 *  - after user Cancel in the viewer (all files return to pending for a clean retry).
 *
 * Returns ready only when every target settled. Cancellation and unresolved
 * files remain distinct so the caller can keep user cancellation quiet while
 * surfacing a real preparation failure.
 *
 * Re-click semantics: a click on the SAME trip while its load runs JOINS the
 * in-flight session (one progress surface, one load); a click on a DIFFERENT trip aborts
 * the old session (its files return to pending for a retry) and starts fresh.
 */
export async function loadDeferredGpsForTrip(
    tripIdx: number,
    options: { showProgress?: boolean; concurrency?: number } = {},
): Promise<DeferredGpsLoadResult> {
    // Read (do NOT mint) the current trip-open token: the caller minted it at the
    // top of the chain via takeTripOpenToken, so a click that superseded this
    // chain during the awaited recording read has already bumped tripOpenSequence and the
    // checks below return cancelled.
    const mySeq = tripOpenSequence;
    const trip = state.trips[tripIdx];
    if (!trip) return "failed";
    const tripCandidates = tripAllCandidates(trip);

    // Source-qualified recording identity, not a positional trip index, decides
    // whether this click can join. A regroup may renumber or merge trips while
    // extraction is running.
    const sameTripSession =
        currentDeferredGpsSession &&
        tripCandidates.some((candidate) => currentDeferredGpsSession?.targetKeys.has(vendorFileKey(candidate)));
    if (currentDeferredGpsSession && !sameTripSession) {
        const superseded = currentDeferredGpsSession;
        superseded.controller.abort();
        // The clicked trip owns storage priority. Do not enqueue its full-file
        // reads behind a superseded scan that has not observed cancellation yet.
        await superseded.completion;
        if (tripOpenSequence !== mySeq) return "cancelled";
    }
    // Same-trip re-click: join the in-flight session (one surface, one load).
    // Resolving immediately when targets is empty would start playback while
    // the first click is still applying the shared GPS result.
    if (currentDeferredGpsSession && sameTripSession) {
        const joined = currentDeferredGpsSession;
        if (options.showProgress ?? true) showDeferredGpsProgress(joined);
        const result = await joined.completion;
        if (tripOpenSequence !== mySeq) return "cancelled";
        if (result !== "ready") return result;
        if (hasUnresolvedTargets(joined.targetKeys)) return "failed";

        // A parallel light scan may have discovered more heavy files in this
        // trip while the joined batch was running. Drain that newly discovered
        // tail now; files from a failed joined batch remain pending for an
        // explicit retry and do not create an automatic loop.
        const currentTripIdx = findTripContainingKeys(joined.targetKeys);
        const currentTrip = currentTripIdx === null ? null : state.trips[currentTripIdx];
        const hasNewPending = currentTrip
            ? tripAllCandidates(currentTrip).some(
                  (candidate) =>
                      !joined.targetKeys.has(vendorFileKey(candidate)) &&
                      state.pendingHeavyEmbeddedGps.has(vendorFileKey(candidate)),
              )
            : false;
        return hasNewPending && currentTripIdx !== null
            ? loadDeferredGpsForTrip(currentTripIdx, options)
            : tripOpenSequence === mySeq
              ? "ready"
              : "cancelled";
    }

    if (state.pendingHeavyEmbeddedGps.size === 0) {
        return tripOpenSequence === mySeq ? "ready" : "cancelled";
    }

    const targets: ClassifiedFile[] = [];
    const targetCandidates: VideoCandidate[] = [];
    for (const cand of tripCandidates) {
        // vendorFileKey (source/path/metadata-qualified), not basename: a candidate is a VendorFile
        // structurally, and the deferred map was set under the same key at ingest.
        const key = vendorFileKey(cand);
        const cf = state.pendingHeavyEmbeddedGps.get(key);
        if (!cf) continue;
        targets.push(cf);
        targetCandidates.push(cand);
        state.pendingHeavyEmbeddedGps.delete(key);
        state.inflightEmbeddedGps.set(key, (state.inflightEmbeddedGps.get(key) ?? 0) + 1);
    }
    if (targets.length === 0) return tripOpenSequence === mySeq ? "ready" : "cancelled";

    const controller = new AbortController();
    const session: DeferredGpsSession = {
        controller,
        startedTripIdx: tripIdx,
        targetCandidates,
        targetKeys: new Set(targetCandidates.map((candidate) => vendorFileKey(candidate))),
        completion: Promise.resolve("ready"),
        done: 0,
        total: targets.length,
        preparationToken: null,
    };
    currentDeferredGpsSession = session;
    if (options.showProgress ?? true) showDeferredGpsProgress(session);
    session.completion = runDeferredGpsLoad(session, targets, options.concurrency ?? 1);
    const result = await session.completion;
    if (tripOpenSequence !== mySeq) return "cancelled";
    if (result !== "ready") return result;
    return hasUnresolvedTargets(session.targetKeys) ? "failed" : "ready";
}

function hasUnresolvedTargets(keys: ReadonlySet<string>): boolean {
    for (const key of keys) {
        if (state.pendingHeavyEmbeddedGps.has(key)) return true;
    }
    return false;
}

function findTripContainingKeys(keys: ReadonlySet<string>): number | null {
    for (let i = 0; i < state.trips.length; i++) {
        if (tripAllCandidates(state.trips[i]!).some((candidate) => keys.has(vendorFileKey(candidate)))) return i;
    }
    return null;
}

/** Promotes a background GPS read to blocking trip-preparation progress. */
function showDeferredGpsProgress(session: DeferredGpsSession): void {
    if (session.preparationToken !== null) return;
    session.preparationToken = showTripPreparation(session.total, () => session.controller.abort());
    updateTripPreparationProgress(session.done, session.total, session.preparationToken);
}

/** The actual load body - tracked as session.completion so same-trip
 *  re-clicks can join instead of racing a second load. */
async function runDeferredGpsLoad(
    session: DeferredGpsSession,
    targets: ClassifiedFile[],
    concurrency: number,
): Promise<DeferredGpsLoadResult> {
    try {
        return await runDeferredGpsLoadBody(session, targets, concurrency);
    } finally {
        // Keep the session joinable and its progress visible through result
        // application/regrouping, not merely until the worker replies. A repeat
        // click in that post-processing window must not start a pre-GPS player.
        if (session.preparationToken !== null) hideTripPreparation(session.preparationToken);
        if (currentDeferredGpsSession === session) currentDeferredGpsSession = null;
    }
}

async function runDeferredGpsLoadBody(
    session: DeferredGpsSession,
    targets: ClassifiedFile[],
    concurrency: number,
): Promise<DeferredGpsLoadResult> {
    const controller = session.controller;

    renderTrips(); // pending → inflight (skeleton → spinner)

    const t0 = performance.now();
    let result: Awaited<ReturnType<typeof dispatchParseVideoEmbeddedGps>> | null = null;
    let aborted = false;
    let failed = false;
    try {
        result = await dispatchParseVideoEmbeddedGps(
            targets,
            (done, total) => {
                session.done = done;
                if (session.preparationToken !== null) {
                    updateTripPreparationProgress(done, total, session.preparationToken);
                }
            },
            Math.max(1, concurrency),
            controller.signal,
            "all",
        );
    } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
            aborted = true;
            log.info("deferred gps cancelled", { tripIdx: session.startedTripIdx, files: targets.length });
        } else {
            // Non-abort failure: result stays null, so the return-to-pending
            // branch below puts every target back (winning is empty). Without
            // this the files are gone from BOTH pending and inflight - lost
            // until a full re-ingest, with nothing shown to the user.
            failed = true;
            log.error("deferred gps failed", err);
            captureSentryException(err, {
                tags: { feature: "ingest", stage: "deferred-gps" },
                extra: { fileCount: targets.length },
            });
        }
    } finally {
        // Reference counts keep an older aborted session from clearing the
        // spinner of a newer session that already claimed the same file.
        for (const cf of targets) {
            const key = vendorFileKey(cf.file);
            const remaining = (state.inflightEmbeddedGps.get(key) ?? 1) - 1;
            if (remaining > 0) state.inflightEmbeddedGps.set(key, remaining);
            else state.inflightEmbeddedGps.delete(key);
        }
        aborted ||= controller.signal.aborted;
        if (aborted || failed) {
            // Nothing from a cancelled/failed dispatch is applied below, so all
            // targets must return to pending. This also keeps a new ingest from
            // losing files when it aborts a session that just finished parsing.
            for (const cf of targets) {
                state.pendingHeavyEmbeddedGps.set(vendorFileKey(cf.file), cf);
            }
        }
    }

    // An ingest may already have regrouped state.trips. Never apply a result or
    // refresh the old tripIdx after its session was explicitly superseded.
    if (aborted || failed) {
        renderTrips();
        return aborted ? "cancelled" : "failed";
    }

    const errorNames = new Set(result?.errors.map((err) => err.file) ?? []);
    if (result) {
        applyEmbeddedGpsFailures(result, targets);
        for (const target of targets) {
            const key = vendorFileKey(target.file);
            if (errorNames.has(target.file.file.name) && !result.winningExtractorByFileKey.has(key)) {
                state.pendingHeavyEmbeddedGps.set(key, target);
            }
        }
        registerEmbeddedGpsCacheArtifacts(targets, result);
    }

    if (result && embeddedResultHasEffect(result)) {
        log.info("deferred gps done", {
            tripIdx: session.startedTripIdx,
            files: targets.length,
            recordsAdded: result.records.length,
            durationMs: Math.round(performance.now() - t0),
        });
        applyDeferredGpsResult(result, session.targetCandidates);
    }

    // Resolve affected recordings after extraction. A final ingest sweep or a
    // setting change may have regrouped the candidate objects while the worker
    // ran, so membership is recovered from stable recording keys.
    const allCandidates = state.trips.flatMap(tripAllCandidates);
    const refreshedCandidates: VideoCandidate[] = [];
    for (let i = 0; i < state.trips.length; i++) {
        const candidates = tripAllCandidates(state.trips[i]!);
        if (!candidates.some((candidate) => session.targetKeys.has(vendorFileKey(candidate)))) continue;
        refreshedCandidates.push(...candidates);
    }

    const tripFactsChanged =
        result !== null &&
        (result.records.length > 0 ||
            result.videoStartUtcHintByFileKey.size > 0 ||
            result.localClockOffsetHintByFileKey.size > 0 ||
            result.accelByFileKey.size > 0);
    if (tripFactsChanged && result) {
        // Clock-zone and precise-offset estimates are fingerprint-wide. New
        // evidence from this trip can refine sibling trips too, so the commit
        // must re-anchor the complete pool before regrouping it.
        reanchorRecordingCandidates(allCandidates);
        if (state.gpsLog) {
            mergeAccelIntoCandidates(state.gpsLog.records, result.accelByFileKey, refreshedCandidates);
        }
        // GPS can correct the absolute clock enough to merge, split, or reorder
        // trips. Use the same atomic commit as the closing metadata sweep; its
        // coordinator pauses index-keyed work and resumes it from live objects.
        commitRecordingTripsWhilePreservingIngest(allCandidates);
    }
    restampProvisionalMarkers({ final: true, finalCandidates: allCandidates });

    // Cache metadata plus whichever raw embedded artifacts were verified above.
    // Errored targets have no GPS artifact and remain retryable.
    if (result) {
        scheduleIndexCacheWrite(
            session.targetCandidates,
            cacheRetentionKeysForGpsWork(state.pendingHeavyEmbeddedGps.keys(), state.inflightEmbeddedGps),
        );
    }

    if (result && result.errors.length > 0) {
        log.warn("deferred embedded gps errors", { tripIdx: session.startedTripIdx, errors: result.errors });
        reportParseErrors("deferred-embedded", result.errors);
    }

    renderTrips();
    return "ready";
}

interface DeferredGpsSession {
    controller: AbortController;
    /** Diagnostic only; all mutations use stable recording identity. */
    startedTripIdx: number;
    targetCandidates: VideoCandidate[];
    targetKeys: Set<string>;
    /** Settles when the load body (runDeferredGpsLoad) finishes - join point for
     *  same-trip re-clicks. */
    completion: Promise<DeferredGpsLoadResult>;
    done: number;
    total: number;
    preparationToken: number | null;
}

/** Active deferred GPS session (one per app). */
let currentDeferredGpsSession: DeferredGpsSession | null = null;

/**
 * Merges a deferred embedded-GPS result into state:
 *  - unions appliedExtractors into state.gpsLog so the diagnostics list
 *    reflects every contributing extractor;
 *  - pushes winning extractor ids onto each affected candidate's
 *    appliedExtractors so per-file attribution stays in sync.
 *
 * Candidate-scoped by stable recording identity, so a regroup during the
 * worker read cannot redirect results to whichever trip inherited its index.
 */
export function applyDeferredGpsResult(
    result: Awaited<ReturnType<typeof dispatchParseVideoEmbeddedGps>>,
    candidates: VideoCandidate[],
): void {
    const loaded = state.trips.flatMap(tripAllCandidates);
    applyEmbeddedGpsResult(result, candidates, loaded);
}

// Progressive recording ingest. File names provide the first useful trip list;
// byte-derived metadata then replaces estimates in prioritized background work.
// Every storage backend follows this process. The scheduling policy controls IO
// cadence and concurrency without changing parsing or commit semantics.

import { indexAllMp4Files } from "../indexer.js";
import {
    attachRecordsToCandidates,
    buildVideoAssociationIndex,
    recordsForVideo,
    type VideoAssociationIndex,
} from "../gps-association.js";
import { bindRecordingLogs } from "../gps-time-association.js";
import { applyStoredCameraTimezones } from "../camera-timezone.js";
import { createLogger } from "../log.js";
import { createSubscribers } from "../subscribers.js";
import { captureSentryException, captureSentryMessage } from "../sentry.js";
import { SLICE_COST_STREAM_ABOVE } from "../parsers/internal/mp4-walker.js";
import { cameraFingerprint } from "../parsers/camera-fingerprint.js";
import { classifyFilenameClockTimelapse, classifyFilenameTime } from "../parsers/filename/index.js";
import type { ClassifiedFile } from "../parsers/registry-light.js";
import type { AccelSample, VendorFile, VideoWithRecordingCopies } from "../parsers/types.js";
import { emitLifecycle } from "../perf.js";
import { looksLikeRecordings } from "../report-structure.js";
import { pendingRecordingAnalysisProgress } from "../recording-analysis-progress.js";
import type { CachedRecordingMetadata } from "../persist/types.js";
import type { IndexedMp4, IndexerRepair } from "../workers/indexer-protocol.js";
import {
    applyTimelapseCadenceWallSpans,
    deriveStartUtc,
    estimatePreciseClockOffsetByFingerprint,
    estimateProvisionalDurationByFingerprint,
    estimateTzByFingerprint,
    finalizeFrameTiming,
    groupTrips,
    needsRecordingMetadata,
    rederiveStartUtcForCandidates,
    resolvePreciseClockOffsetForFile,
    tripAllCandidates,
} from "../trips.js";
import type { Trip, VideoCandidate } from "../trips.js";
import { applyRecordingCopies } from "../recording-copies.js";

import { restampProvisionalMarkers } from "./annotations.js";
import {
    bindIndexCacheWriteBlock,
    cacheRetentionKeysForGpsWork,
    registerCandidateMetadata,
    registerEmbeddedGpsCacheArtifacts,
    releaseIndexCacheSnapshots,
    releaseIndexCacheWriteBlocks,
    scheduleIndexCacheWrite,
} from "./ingest-cache.js";
import { fileIdentityOf } from "../persist/identity.js";
import {
    commitRecordingTrips,
    refreshRecordingTrip,
    reanchorRecordingCandidates,
    registerRecordingWorkCoordinator,
} from "./ingest-regroup.js";
import { embeddedResultHasEffect } from "./ingest-core.js";
import { createRecordingAccelStore } from "./recording-accel.js";
import { reportParseErrors, reportSkippedGpsRecords } from "./ingest-diagnostics.js";
import { planEmbeddedGpsQueue } from "./embedded-gps-queue.js";
import { applyEmbeddedGpsFailures, applyEmbeddedGpsResult } from "./embedded-gps-state.js";
import { videoCloneAffinityKeyOf } from "./gps-extract-artifacts.js";
import {
    dispatchParseVideoEmbeddedGpsViaWorker as dispatchParseVideoEmbeddedGps,
    mergeEmbeddedResults,
} from "./gps-extract-shim.js";
import {
    buildProvisionalCandidate,
    checkCanPlay,
    filenameClassifierFields,
    applyIndexedMetadata,
    vendorFileKey,
} from "./ingest-candidate.js";
import { loadDeferredGpsForTrip } from "./deferred-gps.js";
import { hideTripPreparation, showTripPreparation, updateTripPreparationProgress } from "./trip-preparation.js";
import { showNoRecordingsModal } from "./no-recordings-modal.js";
import { notify } from "./notifications.js";
import { maybeRunIngestTour, maybeRunSourcesTour } from "./onboarding.js";
import { maybeShowSupportPrompt, recordSuccessfulLoadForSupportPrompt } from "./support-prompt.js";
import { refreshTripAnalysisStatus, refreshTripCard, renderTrips, updateTripPreview } from "./sidebar.js";
import { state } from "./state.js";
import { ensureTripPreview, schedulePopulateTripPreviews } from "./trip-preview.js";

const log = createLogger("ingest");

// === Backend probe + scheduling policy ===

// Bytes per probe read - one SAF round-trip; small enough that transfer time is
// negligible next to the per-call latency we are measuring.
const PROBE_BYTES = 4096;
// A short batch finishes before conservative scheduling makes a useful
// difference, so it stays on the high-throughput policy without a probe.
const RESPONSIVE_POLICY_MIN_FILES = 30;
const POLICY_OVERRIDE_KEY = "everydashcam:ingest-policy";

export interface IngestSchedulingPolicy {
    /** Immediate keeps local storage busy; idle yields between jobs on
     *  high-latency removable storage. */
    cadence: "immediate" | "idle";
    /** Serial reads avoid seek amplification on high-latency storage. */
    fileConcurrency: number;
    /** Upper bound for one background worker request. A value of one still
     *  keeps every camera in a synchronized trip together. */
    backgroundBatchFiles: number;
}

const RESPONSIVE_SCHEDULING: IngestSchedulingPolicy = {
    cadence: "idle",
    fileConcurrency: 1,
    backgroundBatchFiles: 1,
};
const THROUGHPUT_SCHEDULING: IngestSchedulingPolicy = {
    cadence: "immediate",
    fileConcurrency: 4,
    backgroundBatchFiles: 256,
};

function schedulingOverride(): "throughput" | "responsive" | null {
    try {
        const value = localStorage.getItem(POLICY_OVERRIDE_KEY);
        return value === "throughput" || value === "responsive" ? value : null;
    } catch {
        return null;
    }
}

/**
 * Chooses IO cadence for the progressive pipeline. A cheap median slice probe
 * distinguishes high-latency removable storage from a local disk. Tests and
 * diagnostics can force either policy through localStorage.
 */
export async function pickIngestSchedulingPolicy(
    videoFiles: VendorFile[],
    signal?: AbortSignal,
): Promise<IngestSchedulingPolicy> {
    const override = schedulingOverride();
    if (override) {
        const policy = override === "responsive" ? RESPONSIVE_SCHEDULING : THROUGHPUT_SCHEDULING;
        log.info("ingest scheduling override", { policy });
        return policy;
    }
    if (videoFiles.length < RESPONSIVE_POLICY_MIN_FILES) {
        return THROUGHPUT_SCHEDULING;
    }

    const probe = videoFiles[0]!.file;
    const size = probe.size;
    // Three offsets (head / mid / tail). One cold slice carries the FS-open
    // warm-up SAF pays on every call anyway, but the median guards a fast
    // desktop backend from a single warm-up outlier reading as "slow".
    const offsets = [0, Math.floor(size / 2), Math.max(0, size - PROBE_BYTES)];
    const samples: number[] = [];
    for (const off of offsets) {
        // A trip click can stop the remaining probe reads. Until the backend is
        // measured, serial IO is the safe policy for the user-awaited request.
        if (signal?.aborted) return RESPONSIVE_SCHEDULING;
        try {
            const t0 = performance.now();
            await probe.slice(off, Math.min(off + PROBE_BYTES, size)).arrayBuffer();
            samples.push(performance.now() - t0);
        } catch {
            // A probe failure must not block ingest - just skip this sample.
        }
    }
    if (signal?.aborted) return RESPONSIVE_SCHEDULING;
    if (samples.length === 0) return THROUGHPUT_SCHEDULING;
    samples.sort((a, b) => a - b);
    const medianSliceMs = samples[Math.floor(samples.length / 2)]!;
    const slowBackend = medianSliceMs > SLICE_COST_STREAM_ABOVE;
    const policy = slowBackend ? RESPONSIVE_SCHEDULING : THROUGHPUT_SCHEDULING;
    log.info("ingest backend probe", {
        medianSliceMs: Math.round(medianSliceMs * 100) / 100,
        thresholdMs: SLICE_COST_STREAM_ABOVE,
        videoCount: videoFiles.length,
        slowBackend,
        policy,
    });
    return policy;
}

// === Provisional list build ===

/** Inputs startProgressiveIngest needs from the shared front half of ingestFilesInternal. */
export interface ProgressiveIngestContext {
    /** New (not-yet-added) video files classified by role. */
    newVideos: ClassifiedFile[];
    /** Carried-over candidates from existing trips. Provisional candidates are
     *  appended before grouping. */
    allCandidates: VideoCandidate[];
    /** logsResult attribution keyed by vendorFileKey. */
    logExtractorByFileKey: Map<string, string>;
    /** sidecarResult attribution keyed by vendorFileKey. */
    sidecarExtractorByFileKey: Map<string, string>;
    /** BlackVue-style accel-only sidecar (.3gf) samples per video identity. */
    accelByFileKey: Map<string, AccelSample[]>;
    /** Raw embedded accel restored from the artifact cache. */
    cachedEmbeddedAccelByFileKey: Map<string, AccelSample[]>;
    /** Metadata hits whose embedded GPS alone must be recomputed. */
    cachedRecordingMetadataByFileKey: Map<string, CachedRecordingMetadata>;
    /** Ambiguous/invalid-input cache-write leases for this ingest's misses. */
    cacheWriteBlockLeaseByFileKey: Map<string, symbol>;
    /** All loaded + current videos, indexed once for O(1) basename lookup. */
    videoAssociation: VideoAssociationIndex;
    /** Confirmed copy evidence staged until the candidate list commits. */
    recordingFiles: readonly VideoWithRecordingCopies[];
    duplicateFileCount: number;
    combinedCopyCount: number;
    errorCounts: {
        classify: number;
        logs: number;
        sidecars: number;
        accelSidecars: number;
    };
    stageMs: Record<string, number>;
    skippedLinesBaseline: number;
    tzByFingerprint: ReturnType<typeof estimateTzByFingerprint>;
    preciseOffsetRuns: ReturnType<typeof estimatePreciseClockOffsetByFingerprint>;
    ingestStart: number;
    sourceFiles: VendorFile[];
    videosNewCount: number;
    hasUnsupportedFormats: boolean;
    signal: AbortSignal;
    schedulingFiles: VendorFile[];
    /** Optional UI-owned resolver for XML GPX files left unknown after every
     *  authoritative classifier. It runs only after provisional candidates
     *  can be grouped into real trip destinations. */
    resolveLooseGpx?: (trips: readonly Trip[]) => Promise<void>;
}

// Default duration fed to deriveStartUtc in the first (filename-only) pass: it
// only matters for files that already have log/sidecar GPS (window-fit checks),
// and the real value replaces it on metadata read / the final sweep. 60 is the
// codebase's implicit clip-length unit (see GAP_DIVIDER_MIN_SEC).
const NOMINAL_DERIVE_DURATION_SEC = 60;

// Candidate pool for the closing accuracy sweep.
let candidatePool: VideoCandidate[] | null = null;
let candidateAssociation: VideoAssociationIndex | null = null;
const recordingAccel = createRecordingAccelStore();
let schedulingPolicy: IngestSchedulingPolicy = RESPONSIVE_SCHEDULING;

/** Concurrency suitable for a user-awaited deferred GPS scan on this storage. */
export function getDeferredGpsConcurrency(): number {
    return schedulingPolicy.fileConcurrency;
}

interface ProgressiveIngestRun {
    context: ProgressiveIngestContext;
    /** Candidates that were unresolved when this pass began. Kept as stable
     *  object references so regrouping cannot distort the user-facing count. */
    analysisCandidates: Set<VideoCandidate>;
    /** Incrementally maintained subset of analysisCandidates. Re-scanning the
     *  whole card after every trip would turn large folders into O(n²) UI work. */
    completedAnalysisCandidates: Set<VideoCandidate>;
    listReadyAt: number;
    metadataFailed: number;
    repairedHvcc: number;
    repairedPhantom: number;
    embeddedErrors: Array<{ file: string; extractor?: string; message: string }>;
    scheduling: IngestSchedulingPolicy | null;
    controller: AbortController;
    isComplete: boolean;
}

let activeRun: ProgressiveIngestRun | null = null;

// A click owns storage across the complete open chain, including the deferred
// full-file GPS pass orchestrated by app.ts after prepareTripForPlayback returns.
// Background pumps park here instead of competing with that foreground read.
let foregroundPreparationOwners = 0;
const foregroundReleaseWaiters = new Set<() => void>();

/** Claims foreground storage priority until the returned release is called. */
export function claimForegroundTripPreparation(): () => void {
    foregroundPreparationOwners++;
    let isReleased = false;
    return () => {
        if (isReleased) return;
        isReleased = true;
        foregroundPreparationOwners = Math.max(0, foregroundPreparationOwners - 1);
        if (foregroundPreparationOwners > 0) return;
        const waiters = [...foregroundReleaseWaiters];
        foregroundReleaseWaiters.clear();
        for (const resume of waiters) scheduleBackground(resume);
    };
}

function publishRecordingAnalysisProgress(
    run: ProgressiveIngestRun | null,
    changedCandidates: Iterable<VideoCandidate> = [],
): void {
    if (!run || activeRun !== run) return;
    for (const candidate of changedCandidates) {
        if (!run.analysisCandidates.has(candidate)) continue;
        if (needsRecordingMetadata(candidate)) run.completedAnalysisCandidates.delete(candidate);
        else run.completedAnalysisCandidates.add(candidate);
    }
    const total = run.analysisCandidates.size;
    state.recordingAnalysisProgress = pendingRecordingAnalysisProgress(run.completedAnalysisCandidates.size, total);
    refreshTripAnalysisStatus();
}

function clearRecordingAnalysisProgress(): void {
    state.recordingAnalysisProgress = null;
    refreshTripAnalysisStatus();
}

/**
 * Renders a useful trip sidebar without file-byte reads, then starts prioritized
 * metadata work. Returns once the list is visible; accuracy converges in the
 * background according to the selected scheduling policy.
 */
export async function startProgressiveIngest(ctx: ProgressiveIngestContext): Promise<void> {
    // Background fill from a previous drop was already superseded by
    // cancelProgressiveIngest in ingestFilesInternal; here we adopt this drop's state.
    schedulingPolicy = RESPONSIVE_SCHEDULING;
    const run: ProgressiveIngestRun = {
        context: ctx,
        analysisCandidates: new Set(),
        completedAnalysisCandidates: new Set(),
        listReadyAt: 0,
        metadataFailed: 0,
        repairedHvcc: 0,
        repairedPhantom: 0,
        embeddedErrors: [],
        scheduling: null,
        controller: new AbortController(),
        isComplete: false,
    };
    activeRun = run;

    // Derive a filename-only startUtc per new file (createdUtc/records may exist
    // from logs/sidecars; mvhd does not - that needs a moov read). Pass a nominal
    // duration: deriveStartUtc only uses it in the GPS/mvhd branches.
    const derived: Array<{
        cf: ClassifiedFile;
        fingerprint: string;
        startUtc: number;
        source: VideoCandidate["startSource"];
        records: VideoCandidate["records"];
        classifierFields: ReturnType<typeof filenameClassifierFields>;
    }> = [];
    for (const cf of ctx.newVideos) {
        const fingerprint = cameraFingerprint(cf.file);
        const classifierFields = filenameClassifierFields(cf.file);
        const records = state.gpsLog ? recordsForVideo(state.gpsLog, cf.file, ctx.videoAssociation) : [];
        const { startUtc, source } = deriveStartUtc({
            file: cf.file,
            fingerprint,
            createdUtc: null,
            durationSec: NOMINAL_DERIVE_DURATION_SEC,
            records,
            fingerprintTz: ctx.tzByFingerprint.get(fingerprint) ?? null,
            parseFilenameLocalTime: classifyFilenameTime,
            preciseFilenameOffsetSec: resolvePreciseClockOffsetForFile(
                ctx.preciseOffsetRuns,
                fingerprint,
                cf.file,
                classifyFilenameTime,
            ),
            embeddedStartUtcHint: null,
            // No moov yet (createdUtc null), so the mvhd-corroborated branches
            // the flag gates cannot fire here; the real wall span is derived in
            // the post-metadata read rederive sweep.
            isTimelapse: classifierFields.isTimelapse,
            wallDurationSec: null,
        });
        derived.push({ cf, fingerprint, startUtc, source, records, classifierFields });
    }

    // Provisional per-fingerprint duration from the inter-clip spacing of BOTH
    // new and already-present candidates (more samples per camera). groupTrips
    // then splits on real pauses; contiguous clips stay merged.
    const spacingSamples = [
        ...ctx.allCandidates.map((c) => ({
            fingerprint: c.fingerprint,
            startUtc: c.startUtc,
            channel: c.channel,
            sequence: c.sequence,
        })),
        ...derived.map((d) => ({
            fingerprint: d.fingerprint,
            startUtc: d.startUtc,
            channel: d.classifierFields.channel,
            sequence: d.classifierFields.sequence,
        })),
    ];
    const provisionalDuration = estimateProvisionalDurationByFingerprint(spacingSamples);

    const newlyBuiltCandidates: VideoCandidate[] = [];
    for (const d of derived) {
        const fileKey = vendorFileKey(d.cf.file);
        const candidate = buildProvisionalCandidate({
            file: d.cf.file,
            fingerprint: d.fingerprint,
            startUtc: d.startUtc,
            startSource: d.source,
            cameraTzSec: ctx.tzByFingerprint.get(d.fingerprint)?.filenameTzSec ?? null,
            durationSec: provisionalDuration.get(d.fingerprint) ?? NOMINAL_DERIVE_DURATION_SEC,
            records: d.records,
            appliedExtractors: [],
            classifierFields: d.classifierFields,
        });
        const writeBlockLease = ctx.cacheWriteBlockLeaseByFileKey.get(fileKey);
        if (writeBlockLease) bindIndexCacheWriteBlock(candidate, writeBlockLease);
        newlyBuiltCandidates.push(candidate);
        ctx.allCandidates.push(candidate);
    }

    // addedKeys and state.trips are one commit boundary. An abort before the trip
    // swap must leave both untouched so a re-drop can discover every file.
    if (ctx.signal.aborted) {
        releaseIndexCacheWriteBlocks(newlyBuiltCandidates);
        if (activeRun === run) activeRun = null;
        return;
    }

    // A newly added GPS log can belong to carried-over recordings, so records
    // and extractor attribution both cover the complete candidate pool.
    for (const candidate of ctx.allCandidates) {
        const key = vendorFileKey(candidate);
        for (const extractors of [ctx.logExtractorByFileKey, ctx.sidecarExtractorByFileKey]) {
            const extractor = extractors.get(key);
            if (extractor && !candidate.appliedExtractors.includes(extractor))
                candidate.appliedExtractors.push(extractor);
        }
    }
    if (state.gpsLog) {
        attachRecordsToCandidates(state.gpsLog, ctx.allCandidates, ctx.videoAssociation);
    }

    // A full artifact hit already has mvhd/GPS facts, but its lightweight
    // hydration intentionally does not guess fleet TZ or precise filename
    // offsets in isolation. Re-anchor the mixed pool before its first grouping
    // (and before loose-GPX matching), otherwise a warm GPS-less sibling can sit
    // hours away from the same cold-ingest recording until the closing sweep.
    applyStoredCameraTimezones(ctx.allCandidates, state.gpsLog);
    if (
        ctx.allCandidates.some(
            (candidate) => candidate.metadataReady === true || candidate.cameraTimezoneOverrideSec != null,
        )
    ) {
        rederiveStartUtcForCandidates(ctx.allCandidates, classifyFilenameTime, classifyFilenameClockTimelapse);
        bindReadyRecordingLogs(ctx.allCandidates);
        if (state.gpsLog) attachRecordsToCandidates(state.gpsLog, ctx.allCandidates, ctx.videoAssociation);
    }

    // Wall spans for time-lapse runs, from filename cadence alone - the
    // provisional durations are per-fingerprint estimates, but the cadence
    // factor is a ratio over the same estimate, so a parked lapse night
    // bundles into one trip already in the instant list instead of jumping
    // from N trips to one at the final sweep.
    applyTimelapseCadenceWallSpans(ctx.allCandidates, classifyFilenameTime);

    if (ctx.resolveLooseGpx) {
        // Show the destinations that will commit without changing live modes
        // while the user can still cancel. Grouping also writes driftLeadSec,
        // so every preview candidate needs its own object.
        const previewCandidates = ctx.allCandidates.map((candidate) => ({ ...candidate }));
        applyRecordingCopies(previewCandidates, ctx.recordingFiles);
        try {
            await ctx.resolveLooseGpx(groupTrips(previewCandidates));
        } catch (err) {
            releaseIndexCacheWriteBlocks(newlyBuiltCandidates);
            if (activeRun === run) activeRun = null;
            throw err;
        }
        if (ctx.signal.aborted || activeRun !== run) {
            releaseIndexCacheWriteBlocks(newlyBuiltCandidates);
            if (activeRun === run) activeRun = null;
            return;
        }
        // The resolver may have appended confirmed external records to GpsLog.
        // Re-attachment is idempotent and covers both the new track and any
        // carried-over candidate chosen as its trip anchor.
        if (state.gpsLog) attachRecordsToCandidates(state.gpsLog, ctx.allCandidates, ctx.videoAssociation);
    }

    applyRecordingCopies(ctx.allCandidates, ctx.recordingFiles);
    candidatePool = ctx.allCandidates;
    candidateAssociation = ctx.videoAssociation;
    recordingAccel.register(ctx.allCandidates, "sidecar", ctx.accelByFileKey);
    recordingAccel.register(ctx.allCandidates, "embedded", ctx.cachedEmbeddedAccelByFileKey);
    run.analysisCandidates = new Set(ctx.allCandidates.filter(needsRecordingMetadata));
    publishRecordingAnalysisProgress(run);
    // Every regroup remaps active/expanded state, carries previews and clears the
    // positional event cursor as one atomic UI operation.
    commitRecordingTrips(ctx.allCandidates);

    // Commit identities only after their provisional trips exist. "Added" means
    // discovered in this session; metadata readiness is tracked independently.
    for (const c of ctx.allCandidates) {
        state.addedKeys.add(vendorFileKey(c));
    }

    if (ctx.combinedCopyCount > 0) {
        notify({
            severity: "info",
            messageKey: "status.recordingCopiesCombined",
            messageParams: { n: ctx.combinedCopyCount },
        });
    }
    const skippedDuplicateCount = ctx.duplicateFileCount - ctx.combinedCopyCount;
    if (skippedDuplicateCount > 0) {
        notify({
            severity: "info",
            messageKey: "status.duplicatesSkipped",
            messageParams: { n: skippedDuplicateCount },
        });
    }

    renderTrips();

    log.info("ingest list rendered", {
        trips: state.trips.length,
        newVideos: ctx.newVideos.length,
        candidates: ctx.allCandidates.length,
    });

    announceListReady(run);
    void activateScheduling(run);
}

async function activateScheduling(run: ProgressiveIngestRun): Promise<void> {
    let policy = RESPONSIVE_SCHEDULING;
    try {
        policy = await pickIngestSchedulingPolicy(run.context.schedulingFiles, run.controller.signal);
    } catch (err) {
        log.warn("ingest storage probe failed", { err: err instanceof Error ? err.message : String(err) });
    }
    if (activeRun !== run || run.isComplete) return;
    run.scheduling = policy;
    schedulingPolicy = policy;
    startBackgroundFill();
}

// === Per-trip metadata read ===

interface RecordingReadSession {
    controller: AbortController;
    candidatesByTrip: Map<number, VideoCandidate[]>;
    sourceFilesByTrip: Map<number, Set<File>>;
    processedSourceFiles: Set<File>;
    progressListeners: ReturnType<typeof createSubscribers<[File]>>;
    completion: Promise<void>;
    /** Trip-open callers awaiting selected-trip analysis, counted per trip so a
     *  newer click on another trip can preempt a shared background batch. */
    foregroundWaitersByTrip: Map<number, number>;
    /** The worker failed independently of an explicit/superseding abort. */
    metadataReadFailed: boolean;
    tripIndices: number[];
    run: ProgressiveIngestRun | null;
}

// One session per trip index: background fill wants several trips in flight, and
// an explicit open joins the in-flight session for the same trip.
const sessions = new Map<number, RecordingReadSession>();

function abortRecordingSessions(): void {
    for (const session of new Set(sessions.values())) session.controller.abort();
    sessions.clear();
    state.readingTrips.clear();
}

/**
 * Stops any in-flight metadata read: aborts every session and supersedes the
 * background fill. Called at the start of each ingest so a previous drop's
 * background work cannot write onto the new drop's trips.
 */
export function cancelProgressiveIngest(): void {
    fillGeneration++;
    cancelBackgroundPreviews();
    abortRecordingSessions();
    activeRun?.controller.abort();
    // Release per-run references; the generation bump neutralizes scheduled work.
    candidatePool = null;
    candidateAssociation = null;
    activeRun = null;
    clearRecordingAnalysisProgress();
}

/**
 * Pauses positional recording work so settings can regroup the live trip list,
 * while preserving the current ingest's diagnostics and completion lifecycle.
 * resumeProgressiveIngest rebuilds the candidate pool from the regrouped trips.
 */
export function pauseProgressiveIngestForRegroup(): boolean {
    if (!hasActiveProgressiveIngest()) return false;
    fillGeneration++;
    cancelBackgroundPreviews();
    abortRecordingSessions();
    candidatePool = null;
    candidateAssociation = null;
    return true;
}

/**
 * Restarts metadata work after an ingest that only changed auxiliary data or
 * contained duplicates. Rebuilds from live trips because positional state may
 * have changed while the previous generation was cancelled.
 */
export function resumeProgressiveIngest(): void {
    const pool = state.trips.flatMap(tripAllCandidates);
    if (!pool.some(needsRecordingMetadata) && !activeRun) {
        candidatePool = null;
        candidateAssociation = null;
        void schedulePopulateTripPreviews(state.trips, updateTripPreview, backgroundPreviewController.signal);
        return;
    }
    candidatePool = pool;
    candidateAssociation = buildVideoAssociationIndex(pool);
    if (activeRun && activeRun.scheduling === null) return;
    startBackgroundFill();
}

/**
 * Whether progressive ingest still owns positional trip indices. Callers that
 * regroup must cancel and resume while this is true.
 */
export function hasActiveProgressiveIngest(): boolean {
    return sessions.size > 0 || candidatePool?.some(needsRecordingMetadata) === true;
}

registerRecordingWorkCoordinator({
    pauseForRegroup: pauseProgressiveIngestForRegroup,
    resumeAfterRegroup: resumeProgressiveIngest,
});

/**
 * Returns the in-flight metadata read session for a trip, creating one if the trip
 * has pending candidates (un-read moov, not terminally failed). Returns null
 * when there is nothing to do - every candidate is ready or terminally failed.
 * Tracks the trip index in
 * state.readingTrips so the sidebar can show a per-card spinner. A foreground
 * open and the background fill share one session per trip.
 */
function ensureRecordingReadSession(tripIndices: number[]): RecordingReadSession | null {
    if (tripIndices.length === 0) return null;
    const existing = sessions.get(tripIndices[0]!);
    if (existing) return existing;
    const pending: VideoCandidate[] = [];
    const candidatesByTrip = new Map<number, VideoCandidate[]>();
    const sourceFilesByTrip = new Map<number, Set<File>>();
    const seen = new Set<VideoCandidate>();
    for (const tripIdx of tripIndices) {
        const trip = state.trips[tripIdx];
        if (!trip || sessions.has(tripIdx)) continue;
        const tripCandidates: VideoCandidate[] = [];
        for (const candidate of tripAllCandidates(trip)) {
            if (!needsRecordingMetadata(candidate) || seen.has(candidate)) continue;
            seen.add(candidate);
            pending.push(candidate);
            tripCandidates.push(candidate);
        }
        if (tripCandidates.length === 0) continue;
        candidatesByTrip.set(tripIdx, tripCandidates);
        sourceFilesByTrip.set(tripIdx, new Set(tripCandidates.map((candidate) => candidate.file)));
    }
    if (pending.length === 0) return null;

    const activeTripIndices = [...candidatesByTrip.keys()];
    const session: RecordingReadSession = {
        controller: new AbortController(),
        candidatesByTrip,
        sourceFilesByTrip,
        processedSourceFiles: new Set(),
        progressListeners: createSubscribers<[File]>("recording-read-progress"),
        completion: Promise.resolve(),
        foregroundWaitersByTrip: new Map(),
        metadataReadFailed: false,
        tripIndices: activeTripIndices,
        run: activeRun,
    };
    for (const tripIdx of activeTripIndices) {
        sessions.set(tripIdx, session);
        state.readingTrips.add(tripIdx);
    }
    session.completion = readRecordingData(activeTripIndices, pending, session).finally(() => {
        for (const tripIdx of activeTripIndices) {
            if (sessions.get(tripIdx) !== session) continue;
            sessions.delete(tripIdx);
            state.readingTrips.delete(tripIdx);
            refreshTripCard(tripIdx);
        }
    });
    return session;
}

/**
 * Joins or starts background recording analysis. Mandatory metadata and codec
 * support settle per trip; embedded telemetry completes on the shared batch.
 */
async function readTripsInBackground(tripIndices: number[]): Promise<void> {
    const session = ensureRecordingReadSession(tripIndices);
    if (!session) return;
    await session.completion;
}

// Escalate to in-player progress once the selected-trip read outlasts a blink. The
// synchronous "opening" spinner on the card (markOpening in sidebar.ts) is the
// instant feedback for every click regardless of backend; the viewer adds a
// progress count + Cancel for genuinely slow loads (real SAF/OTG). Kept low so a
// moderately slow load surfaces progress, but above a fast in-memory read so it
// does not flash there.
const READ_PROGRESS_THRESHOLD_MS = 250;

export type TripPreparationResult =
    | { status: "ready"; frameIdx: number; recordingKeys: string[] }
    | { status: "cancelled" }
    | { status: "unreadable" };

/**
 * Waits for all selected-trip recording analysis, including the light embedded
 * GPS pass. A slow read gets in-player progress with Cancel; cancellation never
 * starts playback from estimates or without its final GPS data. When no frame
 * is requested (trip-header/event navigation), the first playable frame is
 * returned so one damaged leading clip cannot make the whole trip appear dead.
 */
export async function prepareTripForPlayback(tripIdx: number, frameIdx?: number): Promise<TripPreparationResult> {
    // The list is intentionally visible before the storage probe completes. A
    // click outranks its remaining 4 KB samples; keep the conservative serial
    // policy and let the foreground metadata read own the device.
    if (activeRun?.scheduling === null) activeRun.controller.abort();

    // A throughput batch can claim hundreds of trips before it reads them. If
    // this trip is still waiting inside such a background batch, abort the
    // batch and restart only the clicked trip; otherwise an older card could
    // sit behind minutes of unrelated removable-storage reads.
    const claimed = sessions.get(tripIdx);
    const shouldRestartClaimed =
        claimed !== undefined &&
        claimed.tripIndices.length > 1 &&
        (claimed.foregroundWaitersByTrip.get(tripIdx) ?? 0) === 0;

    // A direct click is the highest-priority read. Stop every unrelated batch,
    // including a throughput batch that already finished metadata but is still
    // checking GPS. Wait for cancellation to settle before the selected trip
    // starts so removable storage is never shared with obsolete background IO.
    const superseded = [...new Set(sessions.values())].filter((session) => session !== claimed || shouldRestartClaimed);
    for (const session of superseded) session.controller.abort();
    if (superseded.length > 0) {
        await Promise.allSettled(superseded.map((session) => session.completion));
    }
    const session = ensureRecordingReadSession([tripIdx]);
    if (!session) return preparationResult(tripIdx, frameIdx);
    const sourceFiles = session.sourceFilesByTrip.get(tripIdx);
    if (!sourceFiles) return preparationResult(tripIdx, frameIdx);

    session.foregroundWaitersByTrip.set(tripIdx, (session.foregroundWaitersByTrip.get(tripIdx) ?? 0) + 1);

    let progressShown = false;
    // Owner token of the viewer state this call shows. Two foreground reads (rapid
    // clicks on different trips, slow backend) share the singleton surface; the
    // token keeps a finishing call from hiding / repainting the other's progress.
    let preparationToken = 0;
    const updateProgress = (): void => {
        let done = 0;
        for (const sourceFile of sourceFiles) {
            if (session.processedSourceFiles.has(sourceFile)) done++;
        }
        updateTripPreparationProgress(done, sourceFiles.size, preparationToken);
    };
    const progressListener = (file: File): void => {
        if (sourceFiles.has(file)) updateProgress();
    };
    const progressDelay = schedulingPolicy.cadence === "idle" ? 0 : READ_PROGRESS_THRESHOLD_MS;
    let analysisSettled = false;
    let unsubscribeProgress: (() => void) | undefined;
    const timer = setTimeout(() => {
        if (analysisSettled) return;
        progressShown = true;
        preparationToken = showTripPreparation(sourceFiles.size, () => session.controller.abort());
        unsubscribeProgress = session.progressListeners.subscribe(progressListener);
        updateProgress();
    }, progressDelay);
    try {
        await session.completion;
        analysisSettled = true;
    } finally {
        const remainingWaiters = (session.foregroundWaitersByTrip.get(tripIdx) ?? 1) - 1;
        if (remainingWaiters > 0) session.foregroundWaitersByTrip.set(tripIdx, remainingWaiters);
        else session.foregroundWaitersByTrip.delete(tripIdx);
        clearTimeout(timer);
        unsubscribeProgress?.();
        if (progressShown) {
            hideTripPreparation(preparationToken);
        }
    }

    // Local storage can decode the thumbnail once all selected-trip recording
    // data is ready. On high-latency removable media the responsive policy stays
    // serialized so the foreground read keeps exclusive access to the device.
    const trip = state.trips[tripIdx];
    if (trip && schedulingPolicy.cadence === "immediate") {
        void ensureTripPreview(trip, updateTripPreview);
    }
    if (session.metadataReadFailed) return preparationResult(tripIdx, frameIdx);
    if (session.controller.signal.aborted) return { status: "cancelled" };
    return preparationResult(tripIdx, frameIdx);
}

function preparationResult(tripIdx: number, requestedFrameIdx?: number): TripPreparationResult {
    const frames = state.trips[tripIdx]?.frames ?? [];
    const start = requestedFrameIdx ?? 0;
    const end = requestedFrameIdx === undefined ? frames.length : start + 1;
    for (let frameIdx = start; frameIdx < end; frameIdx++) {
        const frame = frames[frameIdx];
        if (!frame) continue;
        const recordingKeys = Object.values(frame.channels)
            .filter((candidate) => candidate.metadataFailed !== true && candidate.metadataReady !== false)
            .map((candidate) => vendorFileKey(candidate));
        if (recordingKeys.length > 0) return { status: "ready", frameIdx, recordingKeys };
    }
    return { status: "unreadable" };
}

async function readRecordingData(
    tripIndices: number[],
    pending: VideoCandidate[],
    session: RecordingReadSession,
): Promise<void> {
    const signal = session.controller.signal;
    const t0 = performance.now();
    const byFile = new Map<File, VideoCandidate>(pending.map((candidate) => [candidate.file, candidate]));
    const tripByCandidate = new Map<VideoCandidate, number>();
    const remainingByTrip = new Map<number, number>();
    for (const [tripIdx, candidates] of session.candidatesByTrip) {
        remainingByTrip.set(tripIdx, candidates.length);
        for (const candidate of candidates) tripByCandidate.set(candidate, tripIdx);
    }
    const metadataChecks: Promise<void>[] = [];
    const gpsTargets: ClassifiedFile[] = [];
    const gpsBatchPromises: Array<Promise<Awaited<ReturnType<typeof dispatchParseVideoEmbeddedGps>>>> = [];
    const gpsBatchKeys: string[][] = [];
    const inflightGpsKeys = new Set<string>();
    const ownedCacheMetadata = new Map<string, { identityKey: string; metadata: CachedRecordingMetadata }>();
    let cacheSnapshotsHandedOff = false;
    let gpsBatch: ClassifiedFile[] = [];
    let gpsBatchMoov = new Map<string, Uint8Array>();
    // Clone groups (Juscar F/R share one GPS stream) must reach the worker in
    // one request, or every member pays its own full parse. A member is held
    // until each pending sibling has been indexed; failed and cached siblings
    // count down too, so a broken file never strands its group.
    const heldByCloneGroup = new Map<string, { files: ClassifiedFile[]; moov: Map<string, Uint8Array> }>();
    const remainingByCloneGroup = new Map<string, number>();
    const cloneGroupByCandidate = new Map<VideoCandidate, string>();
    for (const candidate of pending) {
        const group = videoCloneAffinityKeyOf({
            file: candidate.file,
            relativePath: candidate.relativePath,
            sourceKey: candidate.sourceKey,
        });
        if (group === null) continue;
        cloneGroupByCandidate.set(candidate, group);
        remainingByCloneGroup.set(group, (remainingByCloneGroup.get(group) ?? 0) + 1);
    }

    const finishTripMetadata = (tripIdx: number): void => {
        const candidates = session.candidatesByTrip.get(tripIdx);
        if (!candidates) return;
        const check = checkCanPlay(candidates)
            .catch((err) => {
                log.warn("codec support check failed", {
                    tripIdx,
                    err: err instanceof Error ? err.message : String(err),
                });
            })
            .then(() => {
                if (signal.aborted) return;
                refreshTripsAfterRecordingRead([tripIdx]);
                restampProvisionalMarkers();
                if (sessions.get(tripIdx) === session) state.readingTrips.delete(tripIdx);
                publishRecordingAnalysisProgress(session.run, candidates);
                refreshTripCard(tripIdx);
                const trip = state.trips[tripIdx];
                if (trip && schedulingPolicy.cadence === "immediate") {
                    void ensureTripPreview(trip, updateTripPreview, backgroundPreviewController.signal);
                }
            });
        metadataChecks.push(check);
    };

    const markSourceFileProcessed = (candidate: VideoCandidate, file: File): void => {
        if (session.processedSourceFiles.has(file)) return;
        session.processedSourceFiles.add(file);
        session.progressListeners.emit(file);
        releaseCloneGroupMember(candidate);
        const tripIdx = tripByCandidate.get(candidate);
        if (tripIdx === undefined) return;
        const remaining = (remainingByTrip.get(tripIdx) ?? 1) - 1;
        remainingByTrip.set(tripIdx, remaining);
        if (remaining === 0) finishTripMetadata(tripIdx);
    };

    const releaseCloneGroupMember = (candidate: VideoCandidate): void => {
        const group = cloneGroupByCandidate.get(candidate);
        if (group === undefined) return;
        const remaining = (remainingByCloneGroup.get(group) ?? 1) - 1;
        remainingByCloneGroup.set(group, remaining);
        if (remaining > 0) return;
        const held = heldByCloneGroup.get(group);
        if (!held) return;
        heldByCloneGroup.delete(group);
        gpsBatch.push(...held.files);
        for (const [key, bytes] of held.moov) gpsBatchMoov.set(key, bytes);
        if (schedulingPolicy.cadence === "immediate") dispatchGpsBatch();
    };

    // Every group has been released once indexing settles; this only guards
    // the final flush against a member that never reached the progress path.
    const flushHeldCloneGroups = (): void => {
        for (const held of heldByCloneGroup.values()) {
            gpsBatch.push(...held.files);
            for (const [key, bytes] of held.moov) gpsBatchMoov.set(key, bytes);
        }
        heldByCloneGroup.clear();
    };

    const dispatchGpsBatch = (): void => {
        if (gpsBatch.length === 0) return;
        const batch = gpsBatch;
        const moov = gpsBatchMoov;
        gpsBatch = [];
        gpsBatchMoov = new Map();
        const promise = dispatchParseVideoEmbeddedGps(
            batch,
            () => {},
            schedulingPolicy.fileConcurrency,
            signal,
            "light-only",
            moov,
        );
        promise.catch(() => {});
        gpsBatchPromises.push(promise);
        gpsBatchKeys.push(batch.map((candidate) => vendorFileKey(candidate.file)));
    };

    const applyIndexedResult = (
        candidate: VideoCandidate,
        indexed: IndexedMp4,
        moovBytes: Uint8Array | undefined,
        repair: IndexerRepair | undefined,
    ): void => {
        const sourceFile = candidate.file;
        const plan = planEmbeddedGpsQueue(candidate, candidate.records.length > 0, moovBytes != null);
        // Apply the complete cached/indexed result before publishing either
        // cache state or GPS work. If a corrupt repair throws, the caller can
        // fall back to indexing real bytes without leaving a duplicate queued
        // parse or a bad metadata snapshot behind.
        const appliedRepair = applyIndexedMetadata(candidate, indexed, repair);
        const registered = registerCandidateMetadata(
            fileIdentityOf(sourceFile, candidate.relativePath),
            indexed,
            repair,
        );
        ownedCacheMetadata.set(registered.identityKey, registered);
        if (plan.queue) {
            const file: VendorFile = {
                file: sourceFile,
                relativePath: candidate.relativePath,
                sourceKey: candidate.sourceKey,
            };
            const classified: ClassifiedFile = {
                file,
                role: "video",
                sidecarId: null,
                sidecarMp4: null,
                logExtractorId: null,
            };
            const gpsKey = vendorFileKey(file);
            gpsTargets.push(classified);
            if (!inflightGpsKeys.has(gpsKey)) {
                inflightGpsKeys.add(gpsKey);
                state.inflightEmbeddedGps.set(gpsKey, (state.inflightEmbeddedGps.get(gpsKey) ?? 0) + 1);
            }
            const cachedMoov = plan.cacheMoov && moovBytes ? moovBytes : null;
            const group = cloneGroupByCandidate.get(candidate);
            if (group !== undefined) {
                let held = heldByCloneGroup.get(group);
                if (!held) {
                    held = { files: [], moov: new Map() };
                    heldByCloneGroup.set(group, held);
                }
                held.files.push(classified);
                if (cachedMoov) held.moov.set(gpsKey, cachedMoov);
            } else {
                gpsBatch.push(classified);
                if (cachedMoov) gpsBatchMoov.set(gpsKey, cachedMoov);
                // Fast local storage overlaps GPS extraction with indexing: each
                // indexed file goes out at once, and the pool's least-loaded
                // routing plus the per-worker parse gate spread the load. A
                // metadata-only cache hit has no retained moov and simply lets
                // the GPS worker read it once itself.
                if (schedulingPolicy.cadence === "immediate") dispatchGpsBatch();
            }
        }
        if (session.run) {
            if (appliedRepair.hvccRepaired) session.run.repairedHvcc++;
            if (appliedRepair.phantomRepaired) session.run.repairedPhantom++;
        }
    };

    try {
        try {
            const filesToIndex: VideoCandidate[] = [];
            for (const candidate of pending) {
                const metadata = session.run?.context.cachedRecordingMetadataByFileKey.get(vendorFileKey(candidate));
                if (!metadata) {
                    filesToIndex.push(candidate);
                    continue;
                }
                const sourceFile = candidate.file;
                try {
                    applyIndexedResult(candidate, metadata.indexed, undefined, metadata.repair);
                    markSourceFileProcessed(candidate, sourceFile);
                } catch (err) {
                    // The partition validates the stored shape, but applying a
                    // corrupt repair can still throw. Fall back to real bytes
                    // for this file instead of failing its whole batch.
                    log.warn("cached recording metadata failed, re-indexing", {
                        file: sourceFile.name,
                        err: err instanceof Error ? err.message : String(err),
                    });
                    filesToIndex.push(candidate);
                }
            }
            await indexAllMp4Files(
                filesToIndex.map((candidate) => candidate.file),
                (_done, _total, file, indexed, moovBytes, repair) => {
                    const candidate = byFile.get(file);
                    if (!candidate) return;
                    try {
                        if (!indexed) {
                            candidate.metadataFailed = true;
                            releaseIndexCacheWriteBlocks([candidate]);
                            state.unindexed.add(file);
                            if (session.run) session.run.metadataFailed++;
                            log.warn("recording metadata read failed", { file: candidate.file.name });
                            return;
                        }
                        applyIndexedResult(candidate, indexed, moovBytes, repair);
                    } finally {
                        markSourceFileProcessed(candidate, file);
                    }
                },
                schedulingPolicy.fileConcurrency,
                signal,
                { withMoovBytes: true },
            );
            if (schedulingPolicy.cadence === "idle") {
                // Commit the indexed metadata before GPS begins reading the same
                // slow device. The trip-open gate still awaits both stages.
                await Promise.allSettled(metadataChecks);
                if (signal.aborted) return;
            }
            flushHeldCloneGroups();
            dispatchGpsBatch();
        } catch (err) {
            if (signal.aborted || (err instanceof Error && err.name === "AbortError")) return;
            session.metadataReadFailed = true;
            session.controller.abort();
            log.warn("recording metadata stage failed", { err: err instanceof Error ? err.message : String(err) });
            captureSentryException(err, { tags: { feature: "ingest", stage: "recording-metadata" } });
            return;
        }
        if (signal.aborted) return;

        if (schedulingPolicy.cadence === "immediate") {
            await Promise.allSettled(metadataChecks);
        }
        if (signal.aborted) return;

        const crashedGpsKeys = new Set<string>();
        if (gpsBatchPromises.length > 0) {
            const settled = await Promise.allSettled(gpsBatchPromises);
            if (signal.aborted) return;
            const fulfilled: Array<Awaited<ReturnType<typeof dispatchParseVideoEmbeddedGps>>> = [];
            for (let i = 0; i < settled.length; i++) {
                const result = settled[i]!;
                if (result.status === "fulfilled") {
                    fulfilled.push(result.value);
                    continue;
                }
                if (result.reason instanceof Error && result.reason.name === "AbortError") return;
                for (const key of gpsBatchKeys[i] ?? []) crashedGpsKeys.add(key);
                session.run?.embeddedErrors.push({
                    file: "<batch>",
                    extractor: "gps-extract-worker",
                    message: result.reason instanceof Error ? result.reason.message : String(result.reason),
                });
                log.warn("embedded gps batch failed", {
                    err: result.reason instanceof Error ? result.reason.message : String(result.reason),
                });
            }

            const embeddedResult = mergeEmbeddedResults(fulfilled);
            applyEmbeddedGpsFailures(
                embeddedResult,
                gpsTargets.filter((target) => !crashedGpsKeys.has(vendorFileKey(target.file))),
            );
            registerEmbeddedGpsCacheArtifacts(gpsTargets, embeddedResult, crashedGpsKeys);
            if (embeddedResultHasEffect(embeddedResult)) {
                applyEmbeddedGpsResult(embeddedResult, pending, recordingAssociation());
            }
            recordingAccel.register(pending, "embedded", embeddedResult.accelByFileKey);
            session.run?.embeddedErrors.push(...embeddedResult.errors);
            for (const heavy of embeddedResult.heavyFiles) {
                state.pendingHeavyEmbeddedGps.set(vendorFileKey(heavy.file), heavy);
            }
            if (embeddedResult.errors.length > 0) {
                log.warn("embedded gps parse errors", {
                    count: embeddedResult.errors.length,
                    errors: embeddedResult.errors,
                });
            }
        }
        if (signal.aborted) return;
        // Embedded telemetry can refine the absolute clock after core recording
        // metadata. Apply that refinement in place; trip-boundary reconciliation
        // remains deferred to the closing sweep.
        refreshTripsAfterRecordingRead(tripIndices);

        // Marker anchors remain live until the closing sweep, so this second pass
        // preserves their clip-relative position when telemetry refines startUtc.
        restampProvisionalMarkers();

        // An already-active trip can receive newly added recordings during a
        // later ingest. Finish any newly discovered GPS for that live trip; the
        // identity-based deferred loader stays safe across the closing regroup.
        if (foregroundPreparationOwners === 0 && state.active && state.pendingHeavyEmbeddedGps.size > 0) {
            void loadDeferredGpsForTrip(state.active.trip, { showProgress: false, concurrency: 1 }).catch((err) => {
                log.warn("active trip GPS load failed", err);
            });
        }

        // Persist metadata even when GPS is deferred or failed. The embedded
        // artifact registry contains only completed parses/verified negatives;
        // missing GPS stays a retryable miss on the next open.
        const metadataReadyNow = pending.filter((cand) => cand.metadataReady === true);
        // This batch keeps one inflight reference until its finally block. The
        // helper discounts that completed light owner, but retains metadata for
        // a pending or concurrently auto-deferred scan.
        const retainMetadataForVideoKeys = cacheRetentionKeysForGpsWork(
            state.pendingHeavyEmbeddedGps.keys(),
            state.inflightEmbeddedGps,
            inflightGpsKeys,
        );
        scheduleIndexCacheWrite(metadataReadyNow, retainMetadataForVideoKeys);
        cacheSnapshotsHandedOff = true;

        log.info("recording batch read", {
            trips: tripIndices.length,
            files: pending.length,
            durationMs: Math.round(performance.now() - t0),
        });
    } finally {
        if (!cacheSnapshotsHandedOff) releaseIndexCacheSnapshots(ownedCacheMetadata.values());
        // An aborted or crashed batch may already have applied metadata to a
        // subset of its files, but it has not necessarily run codec checks or
        // embedded-GPS analysis for them. Put every otherwise-readable member
        // back into the one scheduler instead of leaving a misleading partial
        // terminal state that can never be selected again.
        if (signal.aborted || session.metadataReadFailed) {
            for (const candidate of pending) {
                if (candidate.metadataFailed !== true) candidate.metadataReady = false;
            }
            publishRecordingAnalysisProgress(session.run, pending);
        }
        for (const key of inflightGpsKeys) {
            const remaining = (state.inflightEmbeddedGps.get(key) ?? 1) - 1;
            if (remaining > 0) state.inflightEmbeddedGps.set(key, remaining);
            else state.inflightEmbeddedGps.delete(key);
        }
    }
}

/** Rebuilds affected trips from their current metadata without changing list indices. */
function refreshTripsAfterRecordingRead(tripIndices: readonly number[]): void {
    const allCandidates = candidatePool ?? state.trips.flatMap(tripAllCandidates);
    if (state.gpsLog && state.gpsLog.pendingByFilename.size > 0) {
        bindReadyRecordingLogs(allCandidates);
    } else {
        applyStoredCameraTimezones(allCandidates, state.gpsLog);
    }
    const association = recordingAssociation();
    for (const tripIdx of tripIndices) {
        const trip = state.trips[tripIdx];
        if (!trip) continue;
        const candidates = tripAllCandidates(trip);
        if (state.gpsLog) attachRecordsToCandidates(state.gpsLog, candidates, association);
        rederiveStartUtcForCandidates(candidates, classifyFilenameTime, classifyFilenameClockTimelapse);
        recordingAccel.merge(candidates);
        for (const frame of trip.frames) finalizeFrameTiming(frame);
        refreshRecordingTrip(tripIdx);
    }
}

function recordingAssociation(): VideoAssociationIndex {
    candidateAssociation ??= buildVideoAssociationIndex(candidatePool ?? state.trips.flatMap(tripAllCandidates));
    return candidateAssociation;
}

function bindReadyRecordingLogs(candidates: readonly VideoCandidate[]): void {
    if (!state.gpsLog) return;
    // Directory rows inherit a video's window, so derive it from metadata and
    // independent GPS before associating them. Reusing the old provisional
    // duration would give adjacent recordings each other's samples.
    applyStoredCameraTimezones(candidates, state.gpsLog);
    rederiveStartUtcForCandidates(candidates, classifyFilenameTime, classifyFilenameClockTimelapse);
    const bound = bindRecordingLogs(state.gpsLog, candidates);
    state.gpsLog = bound.log;
    if (bound.boundRecords > 0) {
        log.info("bound recording-scoped gps log", {
            records: bound.boundRecords,
            videos: bound.boundVideos,
        });
    }
}

// === Low-priority background fill ===

// Bumped on each ingest / cancel; a pump from an older generation stops.
let fillGeneration = 0;
let backgroundPreviewController = new AbortController();

function cancelBackgroundPreviews(): void {
    backgroundPreviewController.abort();
    backgroundPreviewController = new AbortController();
}

function scheduleBackground(fn: () => void): void {
    if (schedulingPolicy.cadence === "immediate") {
        setTimeout(fn, 0);
        return;
    }
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn(), { timeout: 2000 });
    else setTimeout(fn, 200);
}

/**
 * Reads pending trips in visible order, batching according to the storage
 * policy. The closing sweep reconciles boundaries and absolute clocks once all
 * mandatory metadata is known.
 */
function startBackgroundFill(): void {
    const generation = ++fillGeneration;
    let ticks = 0;
    // Safety cap: each trip gets several attempts (a foreground Skip can return a
    // trip to pending for a retry) before we give up and regroup anyway. The
    // metadataFailed terminal flag already guarantees convergence; this only catches
    // an unexpected stuck state so the sweep cannot be starved forever.
    const maxTicks = Math.max(8, state.trips.length * 4);

    // Newest recordings always win background priority. They are the first cards
    // in the default view and the footage users most often want immediately;
    // direct clicks can still preempt this order.
    const pickFillIndices = (): number[] => {
        const available: Array<{ index: number; startUtc: number; files: number }> = [];
        for (let i = 0; i < state.trips.length; i++) {
            if (sessions.has(i)) continue;
            const trip = state.trips[i]!;
            const files = tripAllCandidates(trip).filter(needsRecordingMetadata).length;
            if (files > 0) available.push({ index: i, startUtc: trip.startUtc, files });
        }
        available.sort((a, b) => b.startUtc - a.startUtc);

        const selected: number[] = [];
        let files = 0;
        for (const entry of available) {
            if (selected.length > 0 && files + entry.files > schedulingPolicy.backgroundBatchFiles) break;
            selected.push(entry.index);
            files += entry.files;
        }
        return selected;
    };

    const finish = (): void => {
        if (generation !== fillGeneration || !candidatePool) return;
        if (sessions.size > 0) {
            abortRecordingSessions();
        }
        const run = activeRun;
        const terminalFailures: VideoCandidate[] = [];
        for (const candidate of candidatePool) {
            if (!needsRecordingMetadata(candidate)) continue;
            candidate.metadataFailed = true;
            terminalFailures.push(candidate);
            state.unindexed.add(candidate.file);
            if (run) run.metadataFailed++;
        }
        releaseIndexCacheWriteBlocks(terminalFailures);
        if (run) publishRecordingAnalysisProgress(run, run.analysisCandidates);
        const readable = candidatePool.filter((candidate) => candidate.metadataFailed !== true);
        for (const candidate of candidatePool) {
            if (candidate.metadataFailed === true) state.addedKeys.delete(vendorFileKey(candidate));
        }
        candidatePool = readable;
        candidateAssociation = buildVideoAssociationIndex(readable);
        bindReadyRecordingLogs(readable);
        if (state.gpsLog) attachRecordsToCandidates(state.gpsLog, readable, candidateAssociation);
        reanchorRecordingCandidates(readable);
        recordingAccel.merge(readable);
        recordingAccel.release(readable);
        commitRecordingTrips(readable);
        // The shared status describes mandatory time/duration work. Preview
        // extraction continues as a visual enhancement and must not leave a
        // misleading 100% bar on screen while a slow decoder catches up.
        clearRecordingAnalysisProgress();
        renderTrips();
        restampProvisionalMarkers({ final: true });
        log.info("recording metadata complete", { trips: state.trips.length });
        if (run && !run.isComplete) {
            run.isComplete = true;
            void completeProgressiveRun(run, generation);
        } else {
            candidatePool = null;
            candidateAssociation = null;
            void schedulePopulateTripPreviews(state.trips, updateTripPreview, backgroundPreviewController.signal);
        }
    };

    const pump = (): void => {
        if (generation !== fillGeneration) return; // superseded
        if (foregroundPreparationOwners > 0) {
            foregroundReleaseWaiters.add(pump);
            return;
        }
        // A foreground read can start between background ticks. Wait on the
        // actual session promise instead of polling or imposing an arbitrary
        // timeout: slow removable storage remains cancellable through its viewer
        // and is never mislabeled unreadable merely for taking a long time.
        const liveSessions = [...new Set(sessions.values())];
        if (liveSessions.length > 0) {
            void Promise.allSettled(liveSessions.map((session) => session.completion)).then(() => {
                if (generation === fillGeneration) scheduleBackground(pump);
            });
            return;
        }
        const indices = pickFillIndices();
        if (indices.length === 0) {
            finish();
            return;
        }
        if (ticks++ > maxTicks) {
            log.warn("recording analysis hit tick cap, forcing regroup", { ticks, trips: state.trips.length });
            finish();
            return;
        }
        void readTripsInBackground(indices)
            .then(() => {
                if (generation !== fillGeneration) return;
                for (const tripIdx of indices) {
                    const trip = state.trips[tripIdx];
                    if (trip) void ensureTripPreview(trip, updateTripPreview, backgroundPreviewController.signal);
                }
            })
            .catch((err) => {
                log.debug("background recording read failed", {
                    trips: indices.length,
                    err: err instanceof Error ? err.message : String(err),
                });
            })
            .finally(() => {
                if (generation === fillGeneration) scheduleBackground(pump);
            });
    };
    scheduleBackground(pump);
}

function announceListReady(run: ProgressiveIngestRun): void {
    const ctx = run.context;
    run.listReadyAt = performance.now();
    log.info("ingest list ready", {
        durationMs: Math.round(run.listReadyAt - ctx.ingestStart),
        tripsCount: state.trips.length,
        videosTotal: ctx.allCandidates.length,
        videosNew: ctx.videosNewCount,
        scheduling: run.scheduling ?? "probing",
    });

    emitLifecycle("ingest-list-ready", {
        tripsCount: state.trips.length,
        videosTotal: ctx.allCandidates.length,
        durationMs: Math.round(run.listReadyAt - ctx.ingestStart),
    });
}

async function completeProgressiveRun(run: ProgressiveIngestRun, generation: number): Promise<void> {
    await schedulePopulateTripPreviews(state.trips, updateTripPreview, backgroundPreviewController.signal);
    if (generation !== fillGeneration || activeRun !== run) return;

    if (run.metadataFailed > 0) {
        notify({ severity: "warn", messageKey: "recognition.files.body", messageParams: { n: run.metadataFailed } });
    }
    if (run.repairedHvcc > 0) {
        notify({ severity: "info", messageKey: "status.hvccRepaired", messageParams: { n: run.repairedHvcc } });
    }
    if (run.repairedPhantom > 0) {
        notify({ severity: "info", messageKey: "status.audioDamaged", messageParams: { n: run.repairedPhantom } });
    }

    const ctx = run.context;
    if (state.trips.length === 0 && !ctx.hasUnsupportedFormats) {
        if (looksLikeRecordings(ctx.sourceFiles)) {
            captureSentryMessage("ingest produced no playable trips", {
                level: "warning",
                fingerprint: ["ingest_nothing_loaded"],
                // Unknown filename suffixes are user text, so the detailed
                // extension histogram stays in the local ingest log.
                extra: { fileCount: ctx.sourceFiles.length, candidateCount: ctx.allCandidates.length },
            });
            showNoRecordingsModal();
        } else notify({ severity: "warn", messageKey: "status.nothingLoaded" });
    }

    reportSkippedGpsRecords(ctx.skippedLinesBaseline);
    if (run.embeddedErrors.length > 0) reportParseErrors("embedded", run.embeddedErrors);

    const durationMs = Math.round(performance.now() - ctx.ingestStart);
    const stageMs = {
        ...ctx.stageMs,
        recordings: Math.round(performance.now() - run.listReadyAt),
    };
    log.info("ingest done", {
        durationMs,
        stageMs,
        tripsCount: state.trips.length,
        videosTotal: candidatePool?.length ?? 0,
        videosNew: ctx.videosNewCount,
        gpsRecordsTotal: state.gpsLog?.records.length ?? 0,
        metadataFailedCount: run.metadataFailed,
        repairedHvccCount: run.repairedHvcc,
        repairedPhantomCount: run.repairedPhantom,
        errorCounts: { ...ctx.errorCounts, embedded: run.embeddedErrors.length },
        scheduling: run.scheduling ?? schedulingPolicy,
    });

    if (state.trips.length > 0) {
        maybeRunIngestTour();
        maybeRunSourcesTour();
        const addedPlayableRecording = ctx.videosNewCount - run.metadataFailed > 0;
        if (!__PORTABLE__ && addedPlayableRecording && recordSuccessfulLoadForSupportPrompt()) {
            maybeShowSupportPrompt();
        }
    }

    emitLifecycle("ingest-done", {
        tripsCount: state.trips.length,
        videosTotal: candidatePool?.length ?? 0,
        gpsRecordsTotal: state.gpsLog?.records.length ?? 0,
        durationMs,
    });
    activeRun = null;
    candidatePool = null;
    candidateAssociation = null;
}

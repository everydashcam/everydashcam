// Main-thread client of the detection pass (the "blur all plates / faces"
// checkboxes on the export panel). Owns the per-trip checkbox flags, the pass
// result cache and the single running pass; the heavy work - native-res decode
// + tiled detection and bidirectional object tracking - runs in src/workers/tracker-worker.ts (shared
// with the Follow pass, serialized to bound decoder/inference resource use).
//
// Result model: the pass converts confirmed detector tracks into ordinary
// BlurRegion objects (auto-* ids, unpinned keyframes) kept OUTSIDE the manual
// zone list - the preview painter and the export concatenate them, the zone
// editor never sees them (dozens of non-editable rows would drown the panel;
// a false positive is cheap, a miss is fixed with a manual zone).
//
// Freshness: results are keyed by range, channels, kinds, quality and thresholds. The key mismatching
// the current params means STALE - stale results are not painted and not
// exported (they cover a different span); ensureDetectPass() re-runs. Range
// edits re-trigger through a debounce so a trim-bar drag does not thrash
// multi-minute passes.

import { combineAbortSignals } from "../abort-signals.js";
import { cloneBlurRegions, type BlurRegion, type BlurStyle } from "../blur-regions.js";
import { sliceTripChannelForRange } from "../export-range.js";
import { groupDetectionFindings, type DetectionFinding } from "../tracking/detection-review.js";
import { unionIntervals } from "../tracking/interval-set.js";
import type { DetectionAnalysis } from "../tracking/detection-analysis.js";
import { DETECTION_QUALITY_DEFAULT, type DetectionQuality } from "../tracking/detection-sampling.js";
import { DETECTION_POLICIES, detectionPolicy, type DetectionThresholds } from "../tracking/detector-policy.js";
import { createLogger } from "../log.js";
import { captureSentryException, captureSentryMessage } from "../sentry.js";
import { tripAllCandidates } from "../trips.js";
import type { Trip } from "../trips.js";
import type { Channel } from "../parsers/types.js";
import {
    DETECT_NOTIFY_PROGRESS,
    DETECT_NOTIFY_STARTED,
    DETECT_REQUEST,
    type DetectKind,
    type DetectRequestData,
    type DetectResult,
    type DetectResultTrack,
    type TrackSegment,
} from "../workers/tracker-protocol.js";

import {
    type BlurAssetGroupId,
    blurAssetsReady,
    downloadBlurAssets,
    FACE_MODEL_URL,
    PLATE_MODEL_URL,
    TRACKER_MODEL_URL,
    TRACKER_ORT_ASSETS,
} from "./blur-assets.js";
import { exportPanelState, notifyExportStateChanged, subscribeExportState } from "./export-state.js";
import { subscribeBlurTripRegroup } from "./blur-regions-state.js";
import { captureBlurTripSource, matchesBlurTripSource, type BlurTripSource } from "./blur-trip-source.js";
import { notify } from "./notifications.js";
import { activeTrip, state } from "./state.js";
import { subscribeTrackerWorkerNotifications, requestTrackerWorker } from "./tracker-worker-client.js";

export type { DetectKind } from "../workers/tracker-protocol.js";

const log = createLogger("blur-detect");

/** Inactivity cap, reset on every progress tick - catches only a wedged worker
 *  (same rationale and value as the Follow pass's). */
const DETECT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/** Debounce for re-running after range/layout edits: a trim-bar drag emits
 *  state changes at pointer rate, and each re-run cancels a multi-minute pass. */
const ENSURE_DEBOUNCE_MS = 1200;

export interface DetectCounts {
    plate: number;
    face: number;
}

interface TrackCacheEntry {
    /** Full ownership window, independent of the current export trim. */
    source: TrackSegment;
    /** Complete analyzed portion of that window. */
    segment: TrackSegment;
    quality: DetectionQuality;
    threshold: number;
    tracks: DetectResultTrack[];
    sourceFrames: DetectResult["sourceFrames"];
    uncertainFrames: DetectResult["sourceFrames"];
    analysis?: DetectionAnalysis;
}

interface TripDetectState {
    source: BlurTripSource;
    enabled: { plate: boolean; face: boolean };
    quality: DetectionQuality;
    thresholds: DetectionThresholds;
    /** One style per trip, including while a pass is still running. Keeping it
     *  here prevents a long multi-camera pass from producing mixed styles when
     *  the active trip or the style selector changes between channels. */
    style: BlurStyle;
    /** Last completed pass; `key` names the params it covered. */
    result: {
        key: string;
        regions: BlurRegion[];
        counts: DetectCounts;
        findings: DetectionFinding[];
        uncertain: DetectionFinding[];
    } | null;
    /** One analysis per source window, kind and quality at its last threshold. Only changed boundary
     *  windows need inference when a multi-file export grows or moves. */
    trackCache: Map<Channel, Partial<Record<DetectKind, TrackCacheEntry[]>>>;
}

let stateByTrip = new WeakMap<Trip, TripDetectState>();

function tripState(trip: Trip): TripDetectState {
    let st = stateByTrip.get(trip);
    if (!st) {
        st = {
            source: captureBlurTripSource(trip),
            enabled: { plate: false, face: false },
            quality: DETECTION_QUALITY_DEFAULT,
            thresholds: { plate: DETECTION_POLICIES.plate.seedScoreMin, face: DETECTION_POLICIES.face.seedScoreMin },
            style: exportPanelState.blurStyle,
            result: null,
            trackCache: new Map(),
        };
        stateByTrip.set(trip, st);
    }
    return st;
}

interface RunningDetect {
    trip: Trip;
    key: string;
    runId: string;
    segmentCount: number;
    /** Aggregate 0..1 across the source windows of all channels. */
    fraction: number;
    controller: AbortController;
    /** Settles when the pass stores a result (true) or fails/cancels (false). */
    promise: Promise<boolean>;
    /** Retains the original failure for an awaiting export's capture boundary. */
    failure?: unknown;
    armTimeout: () => void;
    /** An export has adopted this exact pass. UI reconciliation must not abort
     *  it when playback auto-advances or the active trip changes: the export is
     *  intentionally operating on its immutable Save-time trip/params. Its own
     *  AbortSignal remains authoritative for Cancel. */
    exportProtected: boolean;
}

// One running pass app-wide: the worker serializes anyway, and a background
// pass for a switched-away trip would burn minutes of CPU while blocking the
// visible trip's pass.
let running: RunningDetect | null = null;
let runCounter = 0;
let autoRegionCounter = 0;
// Trip + params key of the last FAILED (not cancelled) run. The auto re-ensure path
// (debounced export-state subscription) skips it - a deterministic failure
// would otherwise retry in a loop, toasting forever. Any explicit user action
// (checkbox toggle, download button, Save) clears it and retries.
let lastFailedRun: { trip: Trip; key: string } | null = null;

// Regrouping can replace Trip objects while their source pixels and content
// times stay identical. Preserve detection consent and analyzed work there,
// including trips that have never had a hand-drawn zone.
subscribeBlurTripRegroup((oldTrips, newTrips) => {
    const bySourceFile = new Map<File, { trip: Trip; st: TripDetectState }>();
    for (const trip of oldTrips) {
        const st = stateByTrip.get(trip);
        if (!st) continue;
        for (const source of st.source.files) bySourceFile.set(source.file, { trip, st });
    }
    let changed = false;
    for (const trip of newTrips) {
        const existing = stateByTrip.get(trip);
        if (existing && matchesBlurTripSource(existing.source, trip)) continue;
        const candidates = tripAllCandidates(trip);
        const first = candidates[0];
        const previous = existing ? { trip, st: existing } : first && bySourceFile.get(first.file);
        if (!previous) continue;
        const files = new Set(candidates.map((candidate) => candidate.file));
        if (
            !existing &&
            (previous.st.source.files.length !== candidates.length ||
                !previous.st.source.files.every((source) => files.has(source.file)))
        )
            continue;
        if (matchesBlurTripSource(previous.st.source, trip)) {
            stateByTrip.set(trip, previous.st);
            if (running?.trip === previous.trip && !running.exportProtected) running.trip = trip;
            if (lastFailedRun?.trip === previous.trip) lastFailedRun.trip = trip;
        } else {
            // Reassigned channels/times invalidate rectangles, but the user's
            // choice to find faces/plates still applies to the same footage.
            if (running?.trip === previous.trip && !running.exportProtected) running.controller.abort();
            stateByTrip.set(trip, {
                source: captureBlurTripSource(trip),
                enabled: { ...previous.st.enabled },
                quality: previous.st.quality,
                thresholds: { ...previous.st.thresholds },
                style: previous.st.style,
                result: null,
                trackCache: new Map(),
            });
        }
        changed = true;
    }
    if (running && oldTrips.includes(running.trip) && !newTrips.includes(running.trip) && !running.exportProtected) {
        running.controller.abort();
    }
    if (changed) {
        notifyDetectChanged();
        if (state.exportModeOpen && anyDetectEnabled()) scheduleEnsureDetectPass();
    }
});

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribes to checkbox/pass/result changes (panel + preview re-render hook). */
export function subscribeBlurDetect(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function notifyDetectChanged(): void {
    for (const l of listeners) l();
}

// Route this pass's progress off the shared worker's notification stream.
subscribeTrackerWorkerNotifications((msg) => {
    if (msg.type !== DETECT_NOTIFY_PROGRESS && msg.type !== DETECT_NOTIFY_STARTED) return;
    const data = msg.data;
    const run = running;
    if (!run || !data.passId?.startsWith(`${run.runId}:`)) return;
    const segmentIndex = Number(data.passId.slice(run.runId.length + 1));
    if (!Number.isFinite(segmentIndex)) return;
    if (msg.type === DETECT_NOTIFY_PROGRESS && msg.data.fractionDone !== undefined) {
        run.fraction = Math.min(1, (segmentIndex + msg.data.fractionDone) / run.segmentCount);
    }
    run.armTimeout();
    notifyDetectChanged();
});

// Range / layout / panel edits re-key the pass; the debounce keeps a trim-bar
// drag from thrashing it. ensureDetectPass no-ops when the key is unchanged.
subscribeExportState(() => {
    // A result/pass belongs to one Trip object. Reconcile on every export-state
    // change, including switching to a trip with both boxes off; the old code
    // only ran this branch when the NEW trip had detection enabled, leaving the
    // old CPU-heavy pass alive and ahead of future work in the worker queue.
    const trip = activeTrip();
    if (running && running.trip !== trip && !running.exportProtected) running.controller.abort();
    if (!state.exportModeOpen || !trip || !anyDetectEnabled()) {
        if (ensureTimer !== undefined) {
            window.clearTimeout(ensureTimer);
            ensureTimer = undefined;
        }
        if (running && (!trip || running.trip === trip) && !running.exportProtected) running.controller.abort();
        return;
    }
    scheduleEnsureDetectPass();
});

// Probe for a WebGPU adapter once at startup: detection (both kinds) is
// WebGPU-only - an adapter here means the worker almost certainly has one too
// (a create failing there anyway fails the pass loudly - see tracker-worker).
// The probe resolves in milliseconds - long before any consent interaction -
// but re-render just in case one raced. Until it settles, detectAvailable()
// stays optimistic: rendering the checkboxes disabled for the probe's few ms
// would flash the "needs GPU" note on every machine (and flake the VRT
// baselines).
let probeConcludedNoGpu = false;
void (async () => {
    let adapter: object | null = null;
    try {
        adapter = typeof navigator !== "undefined" && navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    } catch {
        // No WebGPU - treated the same as a null adapter below.
    }
    if (!adapter) probeConcludedNoGpu = true;
    notifyDetectChanged();
})();

interface PassParams {
    key: string;
    startSec: number;
    endSec: number;
    channels: Channel[];
    kinds: DetectKind[];
    quality: DetectionQuality;
    thresholds: DetectionThresholds;
}

/** Current pass parameters for the trip, or null when no kind is enabled.
 *  No range picked yet = the full trip (matches what an export would cover). */
function passParams(trip: Trip): PassParams | null {
    const st = tripState(trip);
    const kinds: DetectKind[] = [];
    if (st.enabled.plate) kinds.push("plate");
    if (st.enabled.face) kinds.push("face");
    if (kinds.length === 0) return null;
    const range = exportPanelState.range;
    const startSec = range ? range.startTripSec : 0;
    const endSec = range ? range.endTripSec : trip.timeline.contentDurationSec;
    const channels = [...state.composition.channelOrder];
    return {
        // Tile order changes composition, not the source frames to analyze.
        key: `${startSec}|${endSec}|${[...channels].sort().join("+")}|${kinds.map((kind) => `${kind}:${st.thresholds[kind]}`).join("+")}|${st.quality}`,
        startSec,
        endSec,
        channels,
        kinds,
        quality: st.quality,
        thresholds: { ...st.thresholds },
    };
}

/** Asset groups the given kinds need (consent / readiness gating). */
export function detectAssetGroups(kinds: readonly DetectKind[]): BlurAssetGroupId[] {
    return kinds.map((k) => (k === "plate" ? "detect-plate" : "detect-face"));
}

/** Detector scans require WebGPU; ViTTrack uses its separate WASM runtime.
 *  Once the probe concludes there is no adapter, the panel disables both
 *  checkboxes with an explanation. */
export function detectAvailable(): boolean {
    return !probeConcludedNoGpu;
}

/** Checkbox state of the active trip. */
export function detectEnabled(kind: DetectKind): boolean {
    const trip = activeTrip();
    return trip ? tripState(trip).enabled[kind] : false;
}

/** The active trip's chosen speed and detail, including before either kind is enabled. */
export function detectQuality(): DetectionQuality {
    const trip = activeTrip();
    return trip ? tripState(trip).quality : DETECTION_QUALITY_DEFAULT;
}

export function setDetectQuality(quality: DetectionQuality): void {
    const trip = activeTrip();
    if (!trip) return;
    const st = tripState(trip);
    if (st.quality === quality) return;
    st.quality = quality;
    lastFailedRun = null;
    // Reconcile after the debounce so a slider drag returning to the running
    // quality keeps its work. Save still reconciles synchronously.
    notifyDetectChanged();
    if (state.exportModeOpen && anyDetectEnabled()) scheduleEnsureDetectPass();
}

export function detectThreshold(kind: DetectKind): number {
    const trip = activeTrip();
    return trip ? tripState(trip).thresholds[kind] : DETECTION_POLICIES[kind].seedScoreMin;
}

export function setDetectThreshold(kind: DetectKind, threshold: number): void {
    detectionPolicy(threshold);
    const trip = activeTrip();
    if (!trip) return;
    const st = tripState(trip);
    if (st.thresholds[kind] === threshold) return;
    st.thresholds[kind] = threshold;
    lastFailedRun = null;
    notifyDetectChanged();
    if (state.exportModeOpen && st.enabled[kind]) scheduleEnsureDetectPass();
}

export function anyDetectEnabled(): boolean {
    const trip = activeTrip();
    if (!trip) return false;
    const en = tripState(trip).enabled;
    return en.plate || en.face;
}

/** Flips a checkbox flag. Does NOT start the pass - the panel routes through
 *  the asset consent first and then calls ensureDetectPass(). */
export function setDetectEnabled(kind: DetectKind, on: boolean): void {
    const trip = activeTrip();
    if (!trip) return;
    if (on && !detectAvailable()) return; // UI-disabled, belt and braces
    const st = tripState(trip);
    if (on && !st.enabled.plate && !st.enabled.face && !st.result && st.trackCache.size === 0) {
        st.source = captureBlurTripSource(trip);
    }
    st.enabled[kind] = on;
    if (!on && !anyDetectEnabled() && running?.trip === trip && !running.exportProtected) {
        running.controller.abort();
    }
    notifyDetectChanged();
}

/** Running-pass snapshot for the active trip (progress display), or null. */
export function detectPassState(): { fraction: number } | null {
    const trip = activeTrip();
    return running && trip && running.trip === trip ? { fraction: running.fraction } : null;
}

/** Fresh per-kind review group counts for the current params, or null (stale / off). */
export function detectCounts(): DetectCounts | null {
    const trip = activeTrip();
    if (!trip) return null;
    const params = passParams(trip);
    const result = tripState(trip).result;
    return params && result && result.key === params.key ? result.counts : null;
}

/** Auto blur regions to PAINT and EXPORT: only when fresh for the current
 *  params - a stale result covers a different range/layout and painting it
 *  would promise protection the export will not deliver. */
export function detectRegions(): BlurRegion[] {
    const trip = activeTrip();
    if (!trip) return [];
    const params = passParams(trip);
    const result = tripState(trip).result;
    return params && result && result.key === params.key ? result.regions : [];
}

/** Navigation groups have no role in preview or exported mask geometry. */
export function detectFindings(): readonly DetectionFinding[] {
    const trip = activeTrip();
    if (!trip) return [];
    const params = passParams(trip);
    const result = tripState(trip).result;
    return params && result && result.key === params.key ? result.findings : [];
}

/** Failed recovery frames are review targets, never fabricated blur geometry. */
export function detectUncertainFindings(): readonly DetectionFinding[] {
    const trip = activeTrip();
    if (!trip) return [];
    const params = passParams(trip);
    const result = tripState(trip).result;
    return params && result && result.key === params.key ? result.uncertain : [];
}

/** Style represented by auto regions of the active trip, even before a pass
 *  finishes. Used to keep the shared style selector honest on trip switches. */
export function detectStyle(): BlurStyle | null {
    const trip = activeTrip();
    return trip ? tripState(trip).style : null;
}

/** True when a checkbox is on but the current params have no fresh result and
 *  no pass is running for them - i.e. ensureDetectPass would start one. */
export function detectStale(): boolean {
    const trip = activeTrip();
    if (!trip) return false;
    const params = passParams(trip);
    if (!params) return false;
    const result = tripState(trip).result;
    if (result && result.key === params.key) return false;
    return !(running && running.trip === trip && running.key === params.key);
}

/** The manual style select restyles auto regions too - one style for all blur. */
export function setDetectStyle(style: BlurStyle): void {
    const trip = activeTrip();
    if (!trip) return;
    const st = tripState(trip);
    const resultAlreadyStyled = st.result?.regions.every((region) => region.style === style) ?? true;
    if (st.style === style && resultAlreadyStyled) return;
    st.style = style;
    for (const region of st.result?.regions ?? []) region.style = style;
    notifyDetectChanged();
}

/** Immutable detection contract captured synchronously when Save is clicked.
 *  It deliberately retains the Trip object (source Files are not cloneable),
 *  but copies every mutable choice that defines the pass. */
export interface BlurDetectExportRequest {
    trip: Trip;
    source: BlurTripSource;
    params: PassParams;
    style: BlurStyle;
}

export function captureDetectExportRequest(): BlurDetectExportRequest | null {
    const trip = activeTrip();
    if (!trip) return null;
    const params = passParams(trip);
    if (!params) return null;
    return {
        trip,
        source: captureBlurTripSource(trip),
        params: { ...params, channels: [...params.channels], kinds: [...params.kinds] },
        style: tripState(trip).style,
    };
}

let ensureTimer: number | undefined;

/** Debounced ensureDetectPass (range-drag friendly). */
function scheduleEnsureDetectPass(): void {
    if (ensureTimer !== undefined) window.clearTimeout(ensureTimer);
    ensureTimer = window.setTimeout(() => {
        ensureTimer = undefined;
        ensureDetectPass({ auto: true });
    }, ENSURE_DEBOUNCE_MS);
}

/**
 * Reconciles the running pass with the current params: cancels a pass whose
 * key (or trip) no longer matches, starts one when enabled kinds have no fresh
 * result. The panel owns asset warming and its cancellation; starting a worker
 * before warming finishes would bypass the progress strip and its Cancel button.
 */
export function ensureDetectPass(opts?: { auto?: boolean }): void {
    const trip = activeTrip();
    if (!trip) {
        if (running && !running.exportProtected) running.controller.abort();
        return;
    }
    const params = passParams(trip);
    if (!params) {
        if (running && !running.exportProtected) running.controller.abort();
        return;
    }
    ensureDetectPassFor(trip, params, opts);
}

function ensureDetectPassFor(
    trip: Trip,
    params: PassParams,
    opts?: { auto?: boolean; protectForExport?: boolean },
): void {
    if (opts?.auto && lastFailedRun?.trip === trip && lastFailedRun.key === params.key) return; // no auto retry loops
    if (!opts?.auto) lastFailedRun = null;
    if (!blurAssetsReady(detectAssetGroups(params.kinds))) return;
    if (running) {
        if (running.trip === trip && running.key === params.key) {
            if (opts?.protectForExport) running.exportProtected = true;
            return; // already on it
        }
        // A Save-time pass owns the worker until it settles. A later live-UI
        // reconciliation is allowed to wait; cancelling it would make an
        // unrelated playback/trip change fail the immutable export.
        if (running.exportProtected && !opts?.protectForExport) return;
        running.controller.abort(); // stale pass (old range/kinds/trip) - stop burning CPU
    }
    const result = tripState(trip).result;
    if (result && result.key === params.key) return; // fresh
    startRun(trip, params, opts?.protectForExport === true);
}

/**
 * Export-time guarantee: resolves with the auto regions for the captured
 * Save-time params, running (or awaiting) that pass as needed. `onFraction` reports pass progress
 * 0..1 for the export progress bar. Aborting `signal` cancels the pass and
 * rejects with AbortError; a failed/unavailable pass rejects rather than ever
 * treating an enabled privacy promise as an empty result.
 */
export async function ensureDetectRegionsForExport(
    request: BlurDetectExportRequest,
    signal: AbortSignal,
    onFraction: (fraction: number) => void,
): Promise<BlurRegion[]> {
    const { trip, params, style } = request;
    signal.throwIfAborted();
    if (!matchesBlurTripSource(request.source, trip)) throw new Error("detect source changed after export started");
    // Consent leftover: the box is checked but the download strip was ignored
    // (never answered) and Save got clicked. Silently exporting WITHOUT the
    // promised blur is the one failure this feature must never have, so Save
    // with the checkbox on counts as the go-ahead - the strip already told the
    // user the size, and the pass right after makes the download visible.
    const assetGroups = detectAssetGroups(params.kinds);
    if (!blurAssetsReady(assetGroups)) {
        const ok = await downloadBlurAssets(assetGroups, signal);
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        if (!ok) throw new Error("detect model download failed");
    }
    if (!matchesBlurTripSource(request.source, trip)) throw new Error("detect source changed after export started");
    const st = tripState(trip);
    for (;;) {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        if (st.result && st.result.key === params.key) {
            // Return a detached export snapshot and force the style captured at
            // Save. A style edit after Save may legitimately update the cached
            // preview, but must not mutate this already-confirmed output.
            const snapshot = cloneBlurRegions(st.result.regions);
            for (const region of snapshot) region.style = style;
            return snapshot;
        }
        // Adopt a matching running pass or start one, then await it.
        ensureDetectPassFor(trip, params, { protectForExport: true });
        const run = running;
        if (!run || run.trip !== trip || run.key !== params.key) {
            // Never turn an enabled privacy promise into an unredacted export.
            // A conflicting protected pass should be impossible because export
            // flows are serialized, but failing loudly is still safer than [].
            throw new Error("detect pass unavailable");
        }
        const onAbort = (): void => run.controller.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        const unsubscribe = subscribeBlurDetect(() => {
            if (running === run) onFraction(run.fraction);
        });
        try {
            const ok = await run.promise;
            if (signal.aborted) throw new DOMException("aborted", "AbortError");
            if (!ok) throw run.failure ?? new Error("detect pass failed");
        } finally {
            signal.removeEventListener("abort", onAbort);
            unsubscribe();
        }
        // Loop: re-check freshness (a range edit could have re-keyed mid-await).
    }
}

/** Clips a cached track to the export range, retaining only the actual source
 * frame displayed at a fractional start. Compressed geometry keyframes cannot
 * identify frame boundaries, so timing comes from the source-frame index. */
function trackRegionSpan(
    track: DetectResultTrack,
    startSec: number,
    endSec: number,
    sourceFrames: DetectResult["sourceFrames"],
): DetectionFinding | null {
    let s = Math.max(startSec, track.startSec);
    let seekSec = s;
    const e = Math.min(endSec, track.endSec);
    if (e <= s) return null;
    let lo = 0;
    let hi = sourceFrames.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (sourceFrames[mid]!.contentSec <= s) lo = mid + 1;
        else hi = mid - 1;
    }
    const frame = sourceFrames[hi];
    const frameEnd = frame
        ? Math.min(e, frame.contentSec + frame.durationSec, sourceFrames[hi + 1]?.contentSec ?? e)
        : s;
    if (frame && s < frameEnd) {
        // Seek inside the first displayed frame, including a fractional trim.
        // Exact frame boundaries can round back to the preceding browser frame.
        // Missing timing keeps the requested start; compressed geometry cannot
        // supply a trustworthy frame duration.
        seekSec = s + (frameEnd - s) / 2;
        s = Math.max(track.startSec, frame.contentSec);
    }
    return { startSec: s, endSec: e, seekSec };
}

function buildRegion(
    kind: DetectKind,
    channel: Channel,
    style: BlurStyle,
    track: {
        startSec: number;
        endSec: number;
        keyframes: Array<{ contentSec: number; rect: BlurRegion["keyframes"][number]["rect"] }>;
    },
): BlurRegion {
    autoRegionCounter += 1;
    // HOLD needs only the predecessor of the first displayed frame and changes
    // before the exclusive end. A short trim must not clone a whole long track.
    const lowerBound = (sec: number): number => {
        let lo = 0;
        let hi = track.keyframes.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (track.keyframes[mid]!.contentSec < sec) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const first = lowerBound(track.startSec);
    const from = track.keyframes[first]?.contentSec === track.startSec ? first : Math.max(0, first - 1);
    const to = Math.max(from + 1, lowerBound(track.endSec));
    return {
        id: `auto-${kind}-${autoRegionCounter}`,
        channel,
        style,
        startSec: track.startSec,
        endSec: track.endSec,
        autoEnd: false,
        lastTrackLost: false,
        interpolation: "hold",
        keyframes: track.keyframes
            .slice(from, to)
            .map((k) => ({ contentSec: k.contentSec, rect: { ...k.rect }, pinned: false })),
    };
}

function sameSourceWindow(a: TrackSegment, b: TrackSegment): boolean {
    return (
        a.file === b.file &&
        a.tripStart === b.tripStart &&
        a.startInFile === b.startInFile &&
        a.endInFile === b.endInFile
    );
}

function startRun(trip: Trip, params: PassParams, exportProtected = false): void {
    // A source correction can replace this trip's live cache while an export
    // still owns the previous pass. Commit only to the state that started it.
    const st = tripState(trip);
    // Ingest can mutate candidates while a prior channel awaits the worker.
    // Freeze every file window against this timeline before yielding control.
    const windows = params.channels.flatMap((channel) =>
        sliceTripChannelForRange(trip, channel, 0, trip.timeline.contentDurationSec).flatMap((full) => {
            const source: TrackSegment = {
                file: full.file,
                startInFile: full.startInFile,
                endInFile: full.endInFile,
                tripStart: full.tripStart,
            };
            const startInFile = Math.max(source.startInFile, params.startSec - source.tripStart);
            const endInFile = Math.min(source.endInFile, params.endSec - source.tripStart);
            return endInFile > startInFile ? [{ channel, source, segment: { ...source, startInFile, endInFile } }] : [];
        }),
    );
    const controller = new AbortController();
    runCounter += 1;
    const runId = `detect-${runCounter}`;
    // Inactivity timeout via signal (the worker client has no built-in one):
    // armed from the worker's STARTED notification and reset from progress, so
    // queue wait is not counted while model creation/decode before progress is.
    const timeoutCtrl = new AbortController();
    const combined = combineAbortSignals([controller.signal, timeoutCtrl.signal]);
    let timedOut = false;
    let timeoutTimer: number | undefined;
    const armTimeout = (): void => {
        if (timeoutTimer !== undefined) window.clearTimeout(timeoutTimer);
        timeoutTimer = window.setTimeout(() => {
            timedOut = true;
            timeoutCtrl.abort(new DOMException("tracker worker stalled", "TimeoutError"));
        }, DETECT_REQUEST_TIMEOUT_MS);
    };
    const run: RunningDetect = {
        trip,
        key: params.key,
        runId,
        segmentCount: Math.max(1, windows.length),
        fraction: 0,
        controller,
        armTimeout,
        exportProtected,
        promise: Promise.resolve(false), // replaced synchronously below
    };
    running = run;
    run.promise = Promise.resolve().then(async (): Promise<boolean> => {
        try {
            controller.signal.throwIfAborted();
            const regions: BlurRegion[] = [];
            const reviewIntervalsByKind: Record<DetectKind, DetectionFinding[]> = { plate: [], face: [] };
            const uncertainIntervals: DetectionFinding[] = [];
            for (let i = 0; i < windows.length; i++) {
                controller.signal.throwIfAborted();
                const { channel, source, segment } = windows[i]!;
                const startSec = segment.tripStart + segment.startInFile;
                const endSec = segment.tripStart + segment.endInFile;
                // The worker reuses only trajectories whose two checkpoint
                // boundaries survive the new range. Trims need no worker work.
                const chCache = st.trackCache.get(channel) ?? {};
                const analyzeIntervalsByKind: DetectRequestData["analyzeIntervalsByKind"] = {};
                const cachedAnalysisByKind: DetectRequestData["cachedAnalysisByKind"] = {};
                for (const kind of params.kinds) {
                    const cached = chCache[kind]?.find(
                        (entry) =>
                            entry.quality === params.quality &&
                            entry.threshold === params.thresholds[kind] &&
                            sameSourceWindow(entry.source, source),
                    );
                    const isCovered =
                        cached &&
                        cached.segment.startInFile <= segment.startInFile &&
                        cached.segment.endInFile >= segment.endInFile;
                    analyzeIntervalsByKind[kind] = isCovered ? [] : [{ startSec, endSec }];
                    if (!isCovered && cached?.analysis) cachedAnalysisByKind[kind] = cached.analysis;
                }
                // Cached geometry must not disappear behind a queued Follow just
                // because the user narrowed an already analyzed export range.
                if (Object.values(analyzeIntervalsByKind).some((intervals) => intervals.length > 0)) {
                    const request: DetectRequestData & { passId: string } = {
                        passId: `${runId}:${i}`,
                        segments: [segment],
                        startContentSec: startSec,
                        endContentSec: endSec,
                        kinds: params.kinds,
                        quality: params.quality,
                        thresholds: params.thresholds,
                        analyzeIntervalsByKind,
                        cachedAnalysisByKind,
                        plateModelUrl: PLATE_MODEL_URL,
                        faceModelUrl: FACE_MODEL_URL,
                        trackerModelUrl: TRACKER_MODEL_URL,
                        ortAssets: TRACKER_ORT_ASSETS.webgpu,
                    };
                    const result = await requestTrackerWorker(DETECT_REQUEST, request, {
                        signal: combined.signal,
                    });
                    // Cancel remains authoritative if it crosses a delivered worker
                    // response before this continuation resumes.
                    controller.signal.throwIfAborted();
                    timeoutCtrl.signal.throwIfAborted();
                    // The next window may sit behind a Follow request in the
                    // worker's serialization queue. Stop counting inactivity now;
                    // its own STARTED notification re-arms after that queue.
                    if (timeoutTimer !== undefined) {
                        window.clearTimeout(timeoutTimer);
                        timeoutTimer = undefined;
                    }
                    // Replace only the matching quality after completion, so an
                    // abort/failure preserves prior work. Keep only the latest
                    // threshold per quality to bound geometry retained by sliders.
                    // More discovery scans can change tracking identities, so
                    // reuse the exact quality rather than assuming a superset.
                    const updatedCache = st.trackCache.get(channel) ?? {};
                    for (const kind of params.kinds) {
                        if (!analyzeIntervalsByKind[kind]?.length) continue;
                        updatedCache[kind] = [
                            ...(updatedCache[kind] ?? []).filter(
                                (entry) => entry.quality !== params.quality || !sameSourceWindow(entry.source, source),
                            ),
                            {
                                source,
                                segment,
                                quality: params.quality,
                                threshold: params.thresholds[kind],
                                tracks: result.tracksByKind[kind] ?? [],
                                sourceFrames: result.sourceFrames,
                                uncertainFrames: result.uncertainFramesByKind?.[kind] ?? [],
                                analysis: result.analysisByKind?.[kind],
                            },
                        ];
                    }
                    st.trackCache.set(channel, updatedCache);
                    // The effort breakdown is the arbiter for "the pass feels slow"
                    // field reports - detector scans, tracking, and the decode share.
                    log.info("detect pass stats", {
                        channel,
                        quality: params.quality,
                        thresholds: params.thresholds,
                        spanSec: Math.round((endSec - startSec) * 10) / 10,
                        passMs: result.passMs,
                        decodedFrames: result.decodedFrames,
                        timings: result.timings,
                        ...result.statsByKind,
                    });
                    // Frame-level masks can contain thousands of keyframes.
                    // Keep diagnostics bounded per track with endpoint samples.
                    for (const kind of params.kinds) {
                        const tracks = result.tracksByKind[kind] ?? [];
                        if (tracks.length === 0) continue;
                        log.info("detect tracks", {
                            channel,
                            kind,
                            tracks: tracks.map((track) => {
                                const samples =
                                    track.keyframes.length <= 6
                                        ? track.keyframes
                                        : [...track.keyframes.slice(0, 3), ...track.keyframes.slice(-3)];
                                return (
                                    `${track.startSec.toFixed(2)}..${track.endSec.toFixed(2)} ` +
                                    `hits=${track.detHits} best=${track.bestScore.toFixed(2)} ` +
                                    `frames=${track.keyframes.length} samples=` +
                                    samples
                                        .map(
                                            (k) =>
                                                `${k.contentSec.toFixed(2)}@${k.rect.xPct.toFixed(3)},${k.rect.yPct.toFixed(3)},${k.rect.wPct.toFixed(3)},${k.rect.hPct.toFixed(3)}`,
                                        )
                                        .join(" ")
                                );
                            }),
                        });
                    }
                }
                // Resolve only this source window, including cached trims whose
                // first displayed frame precedes the fractional trim boundary.
                const cache = st.trackCache.get(channel)!;
                for (const kind of params.kinds) {
                    const entry = cache[kind]?.find(
                        (entry) =>
                            entry.quality === params.quality &&
                            entry.threshold === params.thresholds[kind] &&
                            sameSourceWindow(entry.source, source),
                    );
                    if (!entry) continue;
                    for (const frame of entry.uncertainFrames) {
                        const start = Math.max(startSec, frame.contentSec);
                        const end = Math.min(endSec, frame.contentSec + frame.durationSec);
                        if (end > start)
                            uncertainIntervals.push({ startSec: start, endSec: end, seekSec: (start + end) / 2 });
                    }
                    for (const track of entry.tracks) {
                        const span = trackRegionSpan(track, startSec, endSec, entry.sourceFrames);
                        if (!span) continue;
                        reviewIntervalsByKind[kind].push({
                            startSec: Math.max(startSec, span.startSec),
                            endSec: span.endSec,
                            seekSec: span.seekSec,
                        });
                        regions.push(
                            buildRegion(kind, channel, st.style, {
                                startSec: span.startSec,
                                endSec: span.endSec,
                                keyframes: track.keyframes,
                            }),
                        );
                    }
                }
                run.fraction = (i + 1) / run.segmentCount;
                notifyDetectChanged();
            }
            controller.signal.throwIfAborted();
            // The style may have changed while a long multi-channel pass ran.
            // Normalize once at commit so the completed result is never mixed.
            for (const region of regions) region.style = st.style;
            // Counts describe each kind across all selected cameras/files;
            // navigation visits their combined active time only once.
            const counts: DetectCounts = {
                plate: unionIntervals(reviewIntervalsByKind.plate).length,
                face: unionIntervals(reviewIntervalsByKind.face).length,
            };
            const findings = groupDetectionFindings([...reviewIntervalsByKind.plate, ...reviewIntervalsByKind.face]);
            st.result = {
                key: params.key,
                regions,
                counts,
                findings,
                uncertain: groupDetectionFindings(uncertainIntervals),
            };
            return true;
        } catch (err) {
            if ((err as DOMException)?.name === "AbortError") {
                if (timedOut) {
                    lastFailedRun = { trip: run.trip, key: params.key };
                    run.failure = new Error("blur detection timed out");
                    log.warn("detect pass timed out", { key: params.key });
                    if (!run.exportProtected) {
                        captureSentryMessage("blur detection timed out", {
                            level: "error",
                            fingerprint: ["blur_detection_timeout"],
                            tags: { feature: "blur", stage: "detection" },
                        });
                    }
                    notify({
                        severity: "warn",
                        messageKey: "export.blur.detect.failed",
                    });
                } else {
                    log.info("detect pass cancelled", { key: params.key });
                }
            } else {
                lastFailedRun = { trip: run.trip, key: params.key };
                run.failure = err;
                log.warn("detect pass failed", { key: params.key, err: String(err) });
                // Save-time detection is already awaited and captured by the
                // export flow. A live preview pass has no other error boundary.
                if (!run.exportProtected) {
                    captureSentryException(err, { tags: { feature: "blur", stage: "detection" } });
                }
                notify({
                    severity: "warn",
                    messageKey:
                        err instanceof Error && err.name === "AssetUnavailableError"
                            ? "export.blur.tracker.update"
                            : "export.blur.detect.failed",
                });
            }
            return false;
        } finally {
            if (timeoutTimer !== undefined) window.clearTimeout(timeoutTimer);
            combined.dispose();
            if (running === run) running = null;
            notifyDetectChanged();
            // A settled pass can flip the copy-vs-encode gate (fresh empty
            // result re-enables stream-copy; found regions pin re-encode) -
            // the panel's estimate listens on export-state, not on this module.
            notifyExportStateChanged();
        }
    });
    notifyDetectChanged();
}

export function _resetForTests(): void {
    running?.controller.abort();
    running = null;
    if (ensureTimer !== undefined) window.clearTimeout(ensureTimer);
    ensureTimer = undefined;
    stateByTrip = new WeakMap();
    lastFailedRun = null;
    listeners.clear();
}

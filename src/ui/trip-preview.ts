// First-frame preview for the trip sidebar - the only visual on the card.
// Extracts one keyframe via mediabunny CanvasSink, draws with fit:"cover", and
// stores a JPEG dataURL on trip.previewDataUrl. A native <video> fallback covers
// ordinary HEVC MP4s that Chromium plays through the OS decoder while its
// WebCodecs implementation rejects the same stream.
//
// Architecture: the primary decode/encode path runs in Web Workers
// (src/workers/preview-worker.ts). The main thread only runs a pool of previewPoolSize
// workers and round-robins File objects across them, except for the rare native fallback.
// Each File is passed via postMessage without copying (File is structured-cloneable; File.arrayBuffer()
// in the worker reads content directly through the Blob backend).
//
// Why a pool: one extraction is a chain of short waits - Blob reads for moov and
// the first keyframe, decoder session setup, a single decode, JPEG encode - and
// the decoder sits idle between them. Several files in flight overlap those
// waits; on long lists (50+ trips) that is a real wall-clock win.
//
// Storage: in-memory only (on the Trip object). Previews regenerate on reload since Files don't survive it.

import type { PreviewWorkerContract } from "../workers/preview-protocol.js";

import { createLogger } from "../log.js";
import { PREVIEW_HEIGHT_PX, PREVIEW_JPEG_QUALITY, PREVIEW_WIDTH_PX } from "../preview-config.js";
import type { Trip, VideoCandidate } from "../trips.js";
import { tripAllCandidates } from "../trips.js";
import { PREVIEW_REQUEST_EXTRACT, type PreviewExtractRequestData } from "../workers/preview-protocol.js";
import { createTypedWorkerClient } from "../workers/_protocol/worker-client.js";
import { createTypedWorkerPool } from "../workers/_protocol/worker-pool.js";
import { requiresMseBackend } from "./player-video-src.js";
import { createPreviewQueue } from "./trip-preview-queue.js";

const log = createLogger("preview");

/**
 * Files decoded at once. Chrome traces on an Apple Silicon corpus showed the
 * GPU process under half busy with two slots while the preview tail was still
 * most of the ingest wall time. Three slots trim that tail by a few percent
 * of total wall on the same corpus, so the pool overlaps waits rather than
 * racing the decoder: each slot decodes a single keyframe, and more slots
 * would only add decoder session churn. Over-subscribing hardware decoders
 * degrades rather than fails: H.264 falls back to software decode, ordinary
 * HEVC to the serialized native <video> path below. Low-core devices keep
 * fewer slots, mirroring the indexer pool. Not measured on Intel integrated
 * graphics.
 */
function previewPoolCapacity(): number {
    const hardwareConcurrency = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4;
    return Math.max(1, Math.min(hardwareConcurrency - 1, 3));
}
const previewPoolSize = previewPoolCapacity();
const previewQueue = createPreviewQueue(previewPoolSize);

/** Player play/pause bridge: true while a trip actively plays. Idempotent. */
export function setPreviewPlaybackActive(active: boolean): void {
    previewQueue.setPlaybackActive(active);
}

const pool = createTypedWorkerPool<PreviewWorkerContract>({
    name: "preview",
    capacity: previewPoolSize,
    factory: (idx, opts) => {
        // name is intentionally the same for all slots: Vite's worker plugin requires static options.
        // Slot index lives in the pool, not the DevTools label.
        const worker = new Worker(new URL("../workers/preview-worker.ts", import.meta.url), {
            type: "module",
            name: "preview-worker",
        });
        return createTypedWorkerClient<PreviewWorkerContract>(worker, {
            name: `preview-${idx}`,
            onCrash: opts.onCrash,
        });
    },
});

/**
 * Spawns one preview worker ahead of time so its chunk is warm by the time the
 * trip list renders and previews start generating. Called at idle from app.ts;
 * the real preview run reuses the warm slot.
 */
export function prewarmPreview(): void {
    pool.prewarm();
}

/**
 * Sends a File to the least-loaded pool slot and awaits the result.
 * Returns a dataURL or null if the file cannot be decoded. Throws on worker-level errors
 * (unhandled exception in the worker) - the caller logs and skips the preview for that trip.
 */
function extractFirstFrameInWorker(file: File): Promise<string | null> {
    const req: PreviewExtractRequestData = { file };
    return pool.request(PREVIEW_REQUEST_EXTRACT, req).then((res) => res.dataUrl);
}

let nativeFallbackTail: Promise<void> = Promise.resolve();

/** Serializes native fallbacks so thumbnail work never opens several extra
 * hardware decoders beside the live player. */
function withNativeFallbackSlot<T>(task: () => Promise<T>): Promise<T> {
    const result = nativeFallbackTail.then(task, task);
    nativeFallbackTail = result.then(
        () => {},
        () => {},
    );
    return result;
}

function waitForNativeFrame(video: HTMLVideoElement): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error("native preview decode timed out")), 10_000);
        const finish = (error?: Error): void => {
            clearTimeout(timeout);
            video.removeEventListener("loadeddata", onReady);
            video.removeEventListener("error", onError);
            if (error) reject(error);
            else resolve();
        };
        const onReady = (): void => finish();
        const onError = (): void => finish(new Error(video.error?.message || "native preview decode failed"));
        video.addEventListener("loadeddata", onReady, { once: true });
        video.addEventListener("error", onError, { once: true });
    });
}

/** Uses the same native decoder path as playback for hvc1 HEVC files. */
async function extractFirstFrameNatively(file: File): Promise<string | null> {
    if (typeof document === "undefined") return null;
    return withNativeFallbackSlot(async () => {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        const url = URL.createObjectURL(file);
        try {
            const frameReady = waitForNativeFrame(video);
            video.src = url;
            video.load();
            await frameReady;
            if (!video.videoWidth || !video.videoHeight) return null;

            const canvas = document.createElement("canvas");
            canvas.width = PREVIEW_WIDTH_PX;
            canvas.height = PREVIEW_HEIGHT_PX;
            const ctx = canvas.getContext("2d");
            if (!ctx) return null;
            const scale = Math.max(PREVIEW_WIDTH_PX / video.videoWidth, PREVIEW_HEIGHT_PX / video.videoHeight);
            const sourceWidth = PREVIEW_WIDTH_PX / scale;
            const sourceHeight = PREVIEW_HEIGHT_PX / scale;
            ctx.drawImage(
                video,
                (video.videoWidth - sourceWidth) / 2,
                (video.videoHeight - sourceHeight) / 2,
                sourceWidth,
                sourceHeight,
                0,
                0,
                PREVIEW_WIDTH_PX,
                PREVIEW_HEIGHT_PX,
            );
            return canvas.toDataURL("image/jpeg", PREVIEW_JPEG_QUALITY);
        } finally {
            video.pause();
            video.removeAttribute("src");
            video.load();
            URL.revokeObjectURL(url);
        }
    });
}

async function extractFirstFrameDataUrl(candidate: VideoCandidate): Promise<string | null> {
    const canUseNativeFallback = candidate.codec === "hevc" && !requiresMseBackend(candidate);
    try {
        const workerResult = await extractFirstFrameInWorker(candidate.file);
        if (workerResult || !canUseNativeFallback) return workerResult;
    } catch (err) {
        if (!canUseNativeFallback) throw err;
        log.debug("worker preview decode failed, trying native HEVC", {
            file: candidate.file.name,
            err: err instanceof Error ? err.message : String(err),
        });
    }
    return extractFirstFrameNatively(candidate.file);
}

/**
 * Single-flight token for the active background run. A new schedulePopulateTripPreviews call
 * cancels the previous one so fresh trips get previews without waiting for the old queue.
 * Already-generated previews survive cancellation (cached on the Trip object).
 *
 * Worker-side: in-flight requests run to completion (workers are stateless between requests).
 * Their results are silently discarded via the signal.aborted check after await.
 */
let activeRun: AbortController | null = null;

// Files whose first-frame extraction returned nothing or threw - TERMINAL (the
// file cannot produce a thumbnail; a different codec the player handles via MSE,
// a truncated clip, etc.). Keyed by the FIRST candidate's File OBJECT: groupTrips
// reuses the same candidate Files across a regroup, so the flag survives the Trip
// rebuild, and a re-drop makes fresh File objects so it naturally resets. The
// retrying it during every regroup would waste decoder time. The sidebar uses
// the same static placeholder before and after a failed attempt, so this stays
// an internal scheduling detail.
const previewFailedFiles = new WeakSet<File>();

function extractFirstFrameShared(candidate: VideoCandidate, signal?: AbortSignal): Promise<string | null> {
    return previewQueue.run(candidate.file, () => extractFirstFrameDataUrl(candidate), signal);
}

/**
 * Ensures ONE trip has a first-frame preview, extracting it if missing. Unlike
 * schedulePopulateTripPreviews this does NOT abort any in-flight run - it just
 * queues one extraction on the shared worker pool. So opening a trip mid-fill
 * (or progressive recording analysis) can request previews without
 * cancelling each other, which is what left a preview "never loaded" when the
 * trip was opened early. No-op if the trip already has a preview or already
 * failed. onUpdate fires with (trip, dataUrl) on success.
 */
export async function ensureTripPreview(
    trip: Trip,
    onUpdate: (trip: Trip, dataUrl: string) => void,
    signal?: AbortSignal,
): Promise<void> {
    if (trip.previewDataUrl) return;
    const first = tripAllCandidates(trip)[0];
    if (!first || previewFailedFiles.has(first.file)) return;
    try {
        const url = await extractFirstFrameShared(first, signal);
        if (signal?.aborted) return;
        if (url) {
            trip.previewDataUrl = url;
            onUpdate(trip, url);
        } else {
            previewFailedFiles.add(first.file);
        }
    } catch (err) {
        if (signal?.aborted) return;
        previewFailedFiles.add(first.file);
        log.debug("preview extract failed", {
            file: first.file.name,
            err: err instanceof Error ? err.message : String(err),
        });
    }
}

async function populateTripPreviewsImpl(
    trips: Trip[],
    onUpdate: (trip: Trip, dataUrl: string) => void,
    signal: AbortSignal,
): Promise<void> {
    // Keep a small pending window; the shared queue owns decoder admission.
    let cursor = 0;
    const runOne = async (): Promise<void> => {
        while (!signal.aborted) {
            const tripIdx = cursor++;
            if (tripIdx >= trips.length) return;
            const trip = trips[tripIdx];
            if (!trip || trip.previewDataUrl) continue;
            const candidates = tripAllCandidates(trip);
            if (candidates.length === 0) continue;
            const first = candidates[0];
            // Terminal failure already recorded (e.g. by ensureTripPreview on an
            // earlier open) - re-decoding the same broken file on every reschedule
            // wastes a worker slot for a result we already know.
            if (!first || previewFailedFiles.has(first.file)) continue;
            try {
                const url = await extractFirstFrameShared(first, signal);
                if (signal.aborted) return;
                if (url) {
                    trip.previewDataUrl = url;
                    // Hand the TRIP OBJECT to onUpdate, not the index into the
                    // array captured at schedule time: a cancelled run keeps
                    // filling cards in the background by design, and a regroup
                    // (next ingest) reorders state.trips - a stale index then
                    // painted the preview onto the wrong card.
                    onUpdate(trip, url);
                } else {
                    // No decodable first frame - terminal, so the card stops
                    // shimmering and shows the "no thumbnail" placeholder.
                    previewFailedFiles.add(first.file);
                }
            } catch (err) {
                if (signal.aborted) return;
                // Worker-level error for this file - continue to the next trip; the card stays as a placeholder.
                previewFailedFiles.add(first.file);
                log.debug("preview extract failed", {
                    tripIdx,
                    file: first.file.name,
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        }
    };
    const tasks = Array.from({ length: previewPoolSize }, () => runOne());
    await Promise.all(tasks);
}

/**
 * Starts background preview generation for all trips without previewDataUrl.
 * Cancels any previous run and starts fresh over the current state.trips.
 * Already-generated previews survive cancellation (cached on the Trip object).
 *
 * Parallelizes via previewPoolSize workers; decoding and JPEG encode happen off the main thread.
 *
 * onUpdate is called per ready preview with (trip, dataUrl) - the trip OBJECT,
 * resolved to its current index/card at paint time (stale schedule-time indices
 * painted wrong cards after a regroup). The caller must do a targeted DOM
 * update (see sidebar.updateTripPreview), NOT a full renderTrips - otherwise
 * the DOM is rebuilt N times on a long list, stealing clicks from the user.
 */
export function schedulePopulateTripPreviews(
    trips: Trip[],
    onUpdate: (trip: Trip, dataUrl: string) => void,
    signal?: AbortSignal,
): Promise<void> {
    if (activeRun) {
        activeRun.abort();
    }
    const ctrl = new AbortController();
    activeRun = ctrl;
    const onAbort = (): void => ctrl.abort();
    if (signal?.aborted) ctrl.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    return populateTripPreviewsImpl(trips, onUpdate, ctrl.signal).finally(() => {
        signal?.removeEventListener("abort", onAbort);
        if (activeRun === ctrl) activeRun = null;
    });
}

/**
 * Carries previewDataUrl from old Trip objects to new ones across a regroup.
 * groupTrips() builds fresh Trip objects from the same candidates - without
 * this transfer, every regroup wipes all previews and schedulePopulateTrip-
 * Previews re-extracts them, aborting in-flight worker decodes and producing
 * visible card flicker.
 *
 * Match key is the first candidate's File OBJECT identity, not file.name:
 * groupTrips reuses the same candidate File objects across a regroup (the
 * same invariant previewFailedFiles relies on), but basenames collide across
 * trips in first-class layouts like TeslaCam (every event folder has its own
 * front.mp4) - keying by name smeared one trip's thumbnail onto all of them.
 * For split trips, only the half that kept the original first file inherits
 * the preview; the other half re-extracts on the next schedule.
 */
export function carryOverTripPreviews(oldTrips: Trip[], newTrips: Trip[]): void {
    const previewByFirstFile = new Map<File, string>();
    for (const t of oldTrips) {
        if (!t.previewDataUrl) continue;
        const first = tripAllCandidates(t)[0];
        if (first) previewByFirstFile.set(first.file, t.previewDataUrl);
    }
    for (const t of newTrips) {
        if (t.previewDataUrl) continue;
        const first = tripAllCandidates(t)[0];
        if (!first) continue;
        const url = previewByFirstFile.get(first.file);
        if (url) t.previewDataUrl = url;
    }
}

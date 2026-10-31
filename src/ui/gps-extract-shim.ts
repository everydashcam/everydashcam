// Main-thread facade over a pool of GPS extraction workers, shared by
// progressive ingest and deferred full-file scans.
//
// Pool size: min(navigator.hardwareConcurrency - 1, 4), minimum 1. Reserves
// one core for the main thread and other workers (per-file MSE, transcode,
// frame-extract). On a 4-core Pixel 6a this gives 3 GPS workers. Higher
// counts trash mobile SD IO without further CPU speedup.
//
// Sharding strategy: input classified[] is grouped by cloneAcrossGroup
// affinity (Juscar pairs F/R/I share GPS, the dispatcher parses one and
// clones), then each chunk becomes one pool request routed to the least
// loaded slot. A chunk already holds its whole clone group, so no slot
// pinning is needed; least-inflight routing also lets the many small batches
// progressive ingest dispatches while indexing fill every slot instead of
// stacking chunk N of every batch onto the same worker.

import type { GpsExtractWorkerContract } from "../workers/gps-extract-protocol.js";

import { createLogger } from "../log.js";
import type { ClassifiedFile, DispatchedEmbeddedGpsResult } from "../parsers/registry.js";
import type { VendorFile } from "../parsers/types.js";

import {
    GPS_NOTIFY_PROGRESS,
    GPS_REQUEST_EXTRACT,
    type EmbeddedGpsExtractionMode,
    type ProgressNotificationData,
} from "../workers/gps-extract-protocol.js";
import { createTypedWorkerClient } from "../workers/_protocol/worker-client.js";
import { createTypedWorkerPool } from "../workers/_protocol/worker-pool.js";
import {
    buildGpsExtractShardRequest,
    mergeSettledGpsExtractShards,
    shardByCloneAffinity,
} from "./gps-extract-artifacts.js";

export { mergeEmbeddedResults } from "./gps-extract-artifacts.js";

const log = createLogger("gps-extract-shim");

type EmbeddedGpsProgressCallback = (done: number, total: number, file: VendorFile) => void;

function poolCapacity(): number {
    // Reserve one core for the main thread and other workers (mse, transcode,
    // frame-extract). hardwareConcurrency reports logical cores, including
    // SMT/HT - on a phone Safari reports 4-8 on quad/octa-core, on desktop
    // 8-16. Capping at 4 prevents IO trashing on shared SD/UFS.
    const hc = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4;
    return Math.max(1, Math.min(hc - 1, 4));
}

/** Converts the caller's storage policy into this batch's worker count. */
export function gpsExtractShardCount(videoCount: number, requestedConcurrency: number, capacity: number): number {
    const videos = Math.max(0, Math.floor(videoCount));
    const requested = Math.max(1, Math.floor(requestedConcurrency));
    const available = Math.max(1, Math.floor(capacity));
    return Math.min(videos, requested, available);
}

// Per-batch callback registered before sending request; cleared right after.
// Only one batch in flight per slot, but multiple slots in parallel - so we
// keyed by an opaque token, not by slot idx.
const progressByToken: Map<string, (data: ProgressNotificationData) => void> = new Map();
let activeToken = 0;

const pool = createTypedWorkerPool<GpsExtractWorkerContract>({
    name: "gps-extract",
    capacity: poolCapacity(),
    factory: (idx, opts) => {
        // The worker `name` option must be a static literal so vite's
        // worker-import-meta-url plugin can resolve it at build time. The
        // per-slot idx lives in our log context.
        const worker = new Worker(new URL("../workers/gps-extract-worker.ts", import.meta.url), {
            type: "module",
            name: "gps-extract-worker",
        });
        log.info("gps-extract worker slot spawned", { idx });
        return createTypedWorkerClient<GpsExtractWorkerContract>(worker, {
            name: `gps-extract-${idx}`,
            onCrash: opts.onCrash,
            onNotification: (msg) => {
                if (msg.type !== GPS_NOTIFY_PROGRESS) return;
                // Route to the originating dispatch by its token. Without this,
                // a notification from one of several concurrently-registered
                // batches would increment every batch's counter (overcounting
                // the "Embedded GPS done/total" label past total).
                const data = msg.data;
                const cb = progressByToken.get(data.token);
                if (cb) cb(data);
            },
        });
    },
});

/**
 * Spawns one gps-extract worker ahead of ingest so its chunk is warm (and the
 * worker ready) by the time the user drops a folder. Called at idle from
 * app.ts; the real extraction reuses the warm slot.
 */
export function prewarmGpsExtract(): void {
    pool.prewarm();
}

/** Same signature as dispatchParseVideoEmbeddedGps in parsers/registry.js,
 *  plus optional prebuiltMoovByPath to skip the 2× moov read on cold SD. */
export function dispatchParseVideoEmbeddedGpsViaWorker(
    classified: ClassifiedFile[],
    onProgress?: EmbeddedGpsProgressCallback,
    // Global file-read concurrency for this batch. Each worker stays serial;
    // sharding across this many workers supplies the requested parallelism.
    concurrency = 4,
    signal?: AbortSignal,
    mode: EmbeddedGpsExtractionMode = "all",
    // Keyed by the full vendorFileKey identity - see protocol note.
    prebuiltMoovByPath?: Map<string, Uint8Array>,
): Promise<DispatchedEmbeddedGpsResult> {
    const cap = poolCapacity();
    const videoCount = classified.filter((c) => c.role === "video").length;
    const effectiveShards = gpsExtractShardCount(videoCount, concurrency, cap);
    const chunks = shardByCloneAffinity(classified, effectiveShards);
    if (chunks.length === 0) {
        return Promise.resolve({
            appliedExtractors: [],
            records: [],
            skipped: [],
            errors: [],
            failedFileKeys: new Set(),
            winningExtractorByFileKey: new Map(),
            sourceFileKeyByFileKey: new Map(),
            videoStartUtcHintByFileKey: new Map(),
            localClockOffsetHintByFileKey: new Map(),
            accelByFileKey: new Map(),
            heavyFiles: [],
        });
    }

    const total = chunks.reduce((s, c) => s + c.length, 0);
    let doneFiles = 0;
    // Keyed by basename (unlike prebuiltMoovByPath): the worker's
    // ProgressNotificationData.fileName is file.file.name, so the lookup must match
    // that. Only feeds the progress label's "current file" - a same-basename
    // collision here is cosmetic (which name to show), never GPS mis-attribution.
    const fileByName = new Map<string, VendorFile>();
    for (const c of classified) fileByName.set(c.file.file.name, c.file);

    // One token per dispatch call - lets multiple parallel ingests (rare but
    // possible: progressive ingest + a deferred trip scan) keep their
    // progress streams separate.
    const token = String(activeToken++);
    if (onProgress) {
        progressByToken.set(token, (data) => {
            doneFiles++;
            const vf = fileByName.get(data.fileName);
            if (vf) onProgress(doneFiles, total, vf);
        });
    }

    const subResults = chunks.map((chunk) => {
        // All shards carry one token so their progress routes to this dispatch.
        const { request, transfer } = buildGpsExtractShardRequest(token, chunk, mode, prebuiltMoovByPath);
        // The pool counts a request against its slot synchronously, so the N
        // chunks of one dispatch still land on N distinct slots.
        return pool.request(GPS_REQUEST_EXTRACT, request, { signal, transfer });
    });

    return Promise.allSettled(subResults)
        .then((settled) => mergeSettledGpsExtractShards(settled, chunks))
        .finally(() => {
            if (onProgress) progressByToken.delete(token);
        });
}

// Main-thread facade for recording indexing. The MP4/TS work lives in
// workers/indexer-worker.ts; this module owns a small pool of those workers
// and routes progress for concurrent background and foreground batches.
//
// ISOBMFF files travel as one batch to one worker: a moov walk is a handful of
// small reads and little CPU, which the worker's internal async pool already
// overlaps. MPEG-TS and Matroska have no moov, so mediabunny scans the
// container for hundreds of milliseconds of CPU per file, and an async pool on
// one thread only serializes that. Those files go one per request across the
// pool, turning the storage policy's file concurrency into parallel threads.
//
// Keeping the bounded moov walk off the main thread avoids accumulated CPU
// stalls on large cards. The worker also hands moov bytes straight through to
// GPS extraction, avoiding a second cold-storage read.

import { throwIfCancelled } from "./abort-signals.js";
import type { IndexerWorkerContract } from "./workers/indexer-protocol.js";

import { createLogger } from "./log.js";
import { isNonIsobmffContainerName } from "./video-format-names.js";
import {
    INDEXER_NOTIFY_PROGRESS,
    INDEXER_REQUEST_INDEX_ALL,
    type IndexRequestData,
    type IndexedMp4,
    type IndexerRepair,
} from "./workers/indexer-protocol.js";
import { createTypedWorkerClient } from "./workers/_protocol/worker-client.js";
import { createTypedWorkerPool } from "./workers/_protocol/worker-pool.js";

const log = createLogger("indexer");

// Public worker result types used by candidate construction and repair.
export type { IndexerRepair } from "./workers/indexer-protocol.js";
export type { Mp4Rotation } from "./parsers/internal/mp4-walker.js";

/**
 * Callback fired once per indexed file. `indexed === null` means the file
 * is unreadable / not an MP4. `moovBytes` is provided when
 * indexAllMp4Files was called with `options.withMoovBytes=true` AND the
 * file is MP4/MOV with a valid moov; undefined otherwise. `repair` is
 * provided when the worker detected a container defect (phantom track /
 * broken hvcC) in the file's moov - the caller splices it back; undefined
 * when the moov is clean.
 */
type IndexProgressCallback = (
    done: number,
    total: number,
    file: File,
    indexed: IndexedMp4 | null,
    moovBytes?: Uint8Array,
    repair?: IndexerRepair,
) => void;

// Per-batch progress dispatch table. The worker emits notifications carrying a
// fileIndex; we route to the caller's File reference by that stable position
// in the batch's `files` array. (Basename is NOT a usable key - it is not
// unique across folders.) New batches register before sending the request and
// unregister in finally. Shared by every pool slot, so a notification routes
// correctly whichever worker produced it.
interface BatchContext {
    files: File[];
    onProgress: (file: File, indexed: IndexedMp4 | null, moovBytes?: Uint8Array, repair?: IndexerRepair) => void;
}
const activeBatches: Map<string, BatchContext> = new Map();
let nextBatchId = 1;

function poolCapacity(): number {
    // Same reservation as the GPS and ingest pools: one core for the main
    // thread and the other workers, capped where more slots only add IO
    // contention on shared mobile storage. Slots spawn lazily, so an MP4-only
    // card still pays for a single worker.
    const hc = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4;
    return Math.max(1, Math.min(hc - 1, 4));
}

const pool = createTypedWorkerPool<IndexerWorkerContract>({
    name: "indexer",
    capacity: poolCapacity(),
    factory: (idx, opts) => {
        // The worker `name` option must be a static literal so vite's
        // worker-import-meta-url plugin can resolve it at build time.
        const worker = new Worker(new URL("./workers/indexer-worker.ts", import.meta.url), {
            type: "module",
            name: "indexer-worker",
        });
        log.info("indexer worker slot spawned", { idx });
        return createTypedWorkerClient<IndexerWorkerContract>(worker, {
            name: `indexer-${idx}`,
            onCrash: opts.onCrash,
            onNotification: (msg) => {
                if (msg.type !== INDEXER_NOTIFY_PROGRESS) return;
                const data = msg.data;
                // Route by batchId so concurrent background and foreground reads do
                // not cross-fire onProgress with foreign files.
                const ctx = activeBatches.get(data.batchId);
                if (!ctx) return;
                const file = ctx.files[data.fileIndex];
                if (file) ctx.onProgress(file, data.result, data.moovBytes, data.repair);
            },
        });
    },
});

/**
 * Spawns one indexer worker ahead of ingest so its chunk is fetched (and the
 * worker ready) before the user drops a folder. Called at idle from app.ts.
 * The real index() call reuses this same slot.
 */
export function prewarmIndexer(): void {
    pool.prewarm();
}

async function requestIndexBatch(
    files: File[],
    concurrency: number,
    withMoovBytes: boolean,
    onProgress: BatchContext["onProgress"],
    signal?: AbortSignal,
): Promise<void> {
    const batchId = String(nextBatchId++);
    activeBatches.set(batchId, { files, onProgress });
    try {
        const req: IndexRequestData = { batchId, files, withMoovBytes, concurrency };
        await pool.request(INDEXER_REQUEST_INDEX_ALL, req, { signal });
    } finally {
        activeBatches.delete(batchId);
    }
}

/**
 * Parallel indexing of a file array. Runs in Web Workers; onProgress fires
 * on the main thread once per file, with done/total counted across the whole
 * call. signal aborts the workers (next iteration boundary granularity).
 *
 * If options.withMoovBytes is true, the worker also returns the raw moov
 * bytes per MP4 file in the corresponding progress callback. ingest.ts uses
 * this to cache moov bytes for files with embedded GPS source-hint and ship
 * them into the gps-extract request - eliminates the duplicate moov read
 * that the gps-extract worker would otherwise do.
 *
 * `concurrency` bounds concurrent file reads per container family: the
 * ISOBMFF batch runs that many moov walks inside one worker, and that many
 * non-ISOBMFF scans run as separate requests across the pool. A drop mixing
 * both families can briefly read up to twice that; such drops are rare and
 * the ISOBMFF side finishes in milliseconds per file.
 *
 * Results are delivered exclusively through onProgress (once per file); there
 * is no aggregate return value.
 */
export async function indexAllMp4Files(
    files: File[],
    onProgress: IndexProgressCallback,
    concurrency = 4,
    signal?: AbortSignal,
    options?: { withMoovBytes?: boolean },
): Promise<void> {
    if (files.length === 0) return;
    const total = files.length;
    let done = 0;
    // Isolate a throwing onProgress so one bad callback does not abort the
    // whole batch (the worker keeps streaming notifications regardless).
    const progress: BatchContext["onProgress"] = (file, indexed, moovBytes, repair) => {
        done++;
        try {
            onProgress(done, total, file, indexed, moovBytes, repair);
        } catch (err) {
            log.warn("onProgress callback threw", err);
        }
    };
    const withMoovBytes = options?.withMoovBytes ?? false;
    const moovWalks: File[] = [];
    const containerScans: File[] = [];
    for (const file of files) {
        (isNonIsobmffContainerName(file.name) ? containerScans : moovWalks).push(file);
    }

    const requests: Promise<void>[] = [];
    if (moovWalks.length > 0) {
        requests.push(requestIndexBatch(moovWalks, concurrency, withMoovBytes, progress, signal));
    }
    if (containerScans.length > 0) {
        // Lanes race on a shared cursor, the same shape as the worker's own
        // pool; least-inflight routing then gives each in-flight scan its own
        // slot while the storage policy still caps how many files are open.
        let cursor = 0;
        const lanes = Math.min(Math.max(1, concurrency), containerScans.length);
        for (let lane = 0; lane < lanes; lane++) {
            requests.push(
                (async () => {
                    while (cursor < containerScans.length) {
                        throwIfCancelled(signal, "ingest aborted");
                        const file = containerScans[cursor++]!;
                        await requestIndexBatch([file], 1, withMoovBytes, progress, signal);
                    }
                })(),
            );
        }
    }
    await Promise.all(requests);
}

// Main-thread shim over a pool of ingest workers. Wraps the registry's
// classifyFiles / dispatchParseLogs / dispatchParseSidecars /
// dispatchParseAccelSidecars with the same return shapes, so ingest.ts swaps
// imports without touching its pipeline.
//
// Topology:
//  - WorkerPool (size = min(hardwareConcurrency - 1, 4)).
//  - Classify ships a batch per shard (knownVideoNames is shared state).
//  - Parse ops ship one file per request, pool least-inflight balances.
//
// GPX is handled on main:
//  - classifyFilesViaPool: workers see SIDECARS minus gpx. Files the workers
//    return as "unknown" get one more pass with gpxSidecar.matches on main,
//    so gpx-by-basename classification still works.
//  - dispatchParseSidecarsViaPool: gpx-classified entries are parsed
//    sequentially on main; everything else goes through the pool.

import { extendArray } from "../array-extend.js";
import {
    associateRecordsWithVideos,
    buildVideoAssociationIndex,
    resolveVideoKey,
    type VideoAssociationIndex,
} from "../gps-association.js";
import { createLogger } from "../log.js";
import { vendorFileKey } from "../vendor-file-key.js";
import { splitVideosByExtension, type ClassifiedFile } from "../parsers/registry-light.js";
import type { AccelSample, GpsRecord, SkippedLine, VendorFile } from "../parsers/types.js";
import { gpxSidecar } from "../parsers/sidecars/gpx.js";

import {
    INGEST_REQUEST_CLASSIFY_BATCH,
    INGEST_REQUEST_PARSE_ACCEL_SIDECAR,
    INGEST_REQUEST_PARSE_LOG,
    INGEST_REQUEST_PARSE_SIDECAR,
    type ClassifyBatchRequestData,
    type ClassifyBatchResult,
    type ParseAccelSidecarRequestData,
    type ParseAccelSidecarResult,
    type ParseLogRequestData,
    type ParseLogResult,
    type ParseSidecarRequestData,
    type ParseSidecarResult,
} from "../workers/ingest-protocol.js";
import { createWorkerClient } from "../workers/_protocol/worker-client.js";
import { isWorkerUnavailableError } from "../workers/_protocol/worker-error.js";
import { createWorkerPool } from "../workers/_protocol/worker-pool.js";

const log = createLogger("ingest-shim");

function poolCapacity(): number {
    // Same heuristic as gps-extract-shim: reserve one core for main thread
    // and concurrent workers (transcode, frame-extract, mse). Cap at 4 -
    // higher numbers trash mobile SD IO without speedup.
    const hc = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4;
    return Math.max(1, Math.min(hc - 1, 4));
}

const pool = createWorkerPool({
    name: "ingest",
    capacity: poolCapacity(),
    factory: (idx, opts) => {
        const worker = new Worker(new URL("../workers/ingest-worker.ts", import.meta.url), {
            type: "module",
            name: "ingest-worker",
        });
        log.info("ingest worker slot spawned", { idx });
        return createWorkerClient(worker, {
            name: `ingest-${idx}`,
            onCrash: opts.onCrash,
        });
    },
});

/**
 * Spawns one ingest (classify/parse) worker ahead of time so its chunk is warm
 * by the time the user drops a folder. Called at idle from app.ts; the real
 * classify reuses the warm slot.
 */
export function prewarmIngest(): void {
    pool.prewarm();
}

// ===== classify =====

interface ClassifiedFilesResult {
    classified: ClassifiedFile[];
    errors: Array<{ file: string; extractor: string; message: string }>;
}

/**
 * Classifies files via the worker pool. Video files (by extension) are
 * classified on main - no need for a round-trip for an extension check.
 * Non-video files are sharded across the pool; each shard runs the
 * worker-side classifier (which uses SIDECARS minus gpx). Files that come
 * back as "unknown" are then probed with gpxSidecar.matches on main.
 */
export async function classifyFilesViaPool(
    files: VendorFile[],
    existingVideoNames: Iterable<string> = [],
    signal?: AbortSignal,
): Promise<ClassifiedFilesResult> {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const { videoEntries, knownVideos, nonVideo } = splitVideosByExtension(files, existingVideoNames);
    const result: ClassifiedFile[] = [...videoEntries];
    const errors: ClassifiedFilesResult["errors"] = [];

    if (nonVideo.length === 0) return { classified: result, errors };

    // Shard non-video files evenly across pool slots. Each shard ships
    // knownVideoNames once instead of per-file.
    const cap = poolCapacity();
    const shards = Math.min(cap, nonVideo.length);
    const chunks: VendorFile[][] = Array.from({ length: shards }, () => []);
    for (let i = 0; i < nonVideo.length; i++) {
        chunks[i % shards]!.push(nonVideo[i]!);
    }
    const knownVideoNames = [...knownVideos];

    const subResults = await Promise.allSettled(
        chunks.map((chunk, shardIdx) => {
            const req: ClassifyBatchRequestData = {
                files: chunk,
                knownVideoNames,
            };
            return pool.request<ClassifyBatchResult>(INGEST_REQUEST_CLASSIFY_BATCH, req, {
                signal,
                shardKey: `classify-${shardIdx}`,
            });
        }),
    );
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");

    // Stitch sub-results back into the original order is not required - the
    // caller (ingest.ts) does not depend on file order in classified[]. We
    // append in shard order, which is fine.
    for (let i = 0; i < subResults.length; i++) {
        const sub = subResults[i]!;
        if (sub.status === "fulfilled") {
            for (const cf of sub.value) result.push(cf);
            continue;
        }
        // Auxiliary telemetry must not prevent known videos from loading, but
        // parser invariants and cancellation still belong to the caller.
        if (!isWorkerUnavailableError(sub.reason)) throw sub.reason;
        const message = sub.reason instanceof Error ? sub.reason.message : String(sub.reason);
        const chunk = chunks[i]!;
        log.warn("auxiliary file classification unavailable", { files: chunk.length, err: message });
        for (const file of chunk) {
            errors.push({ file: file.file.name, extractor: "ingest-worker", message });
            result.push({ file, role: "unknown", sidecarId: null, sidecarMp4: null, logExtractorId: null });
        }
    }

    // Second pass on main: gpxSidecar.matches for files the worker returned
    // as "unknown". ddpaiGpxSidecar already ran in the worker, so we will not
    // misclassify a DDPai .gpx as XML-GPX.
    for (let i = 0; i < result.length; i++) {
        const cf = result[i]!;
        if (cf.role !== "unknown") continue;
        const mp4 = gpxSidecar.matches(cf.file, knownVideos);
        if (mp4 === null) continue;
        result[i] = {
            file: cf.file,
            role: "sidecar",
            sidecarId: gpxSidecar.id,
            sidecarMp4: mp4,
            logExtractorId: null,
        };
    }

    return { classified: result, errors };
}

export function _resetForTests(): void {
    pool.disposeAll();
}

// ===== pool dispatch helper =====

interface PoolDispatchOutcome<Target, Result> {
    successes: Array<{ target: Target; result: Result }>;
    failures: Array<{ target: Target; message: string }>;
}

/**
 * Runs one pool request per target concurrently and settles each into a
 * success or a failure. AbortError is NOT collected - it re-throws so the
 * whole dispatch rejects and ingest.ts handles cancel. Any other rejection
 * becomes a failure entry with its message; the caller maps it into its own
 * error shape and processes successes however it needs.
 *
 * Successes and failures keep target order, so callers can split per-item
 * handling into two loops.
 */
async function dispatchViaPool<Target, Result>(
    targets: Target[],
    makeRequest: (target: Target) => Promise<Result>,
): Promise<PoolDispatchOutcome<Target, Result>> {
    const settled = await Promise.all(
        targets.map((target) =>
            makeRequest(target)
                .then((result) => ({ ok: true as const, target, result }))
                .catch((err: unknown) => ({ ok: false as const, target, err })),
        ),
    );

    const successes: PoolDispatchOutcome<Target, Result>["successes"] = [];
    const failures: PoolDispatchOutcome<Target, Result>["failures"] = [];
    for (const item of settled) {
        if (item.ok) {
            successes.push({ target: item.target, result: item.result });
            continue;
        }
        // AbortError bubbles up - propagate so ingest.ts handles cancel.
        if (item.err instanceof Error && item.err.name === "AbortError") throw item.err;
        failures.push({
            target: item.target,
            message: item.err instanceof Error ? item.err.message : String(item.err),
        });
    }
    return { successes, failures };
}

// ===== parse logs =====

interface DispatchedLogsResult {
    appliedExtractors: string[];
    extractorByFileKey: Map<string, string>;
    records: GpsRecord[];
    skipped: SkippedLine[];
    errors: Array<{ file: string; extractor: string; message: string }>;
}

/** One request per gps-log file, pool least-inflight distributes. */
export async function dispatchParseLogsViaPool(
    classified: ClassifiedFile[],
    knownVideos: readonly VendorFile[] | VideoAssociationIndex,
    signal?: AbortSignal,
): Promise<DispatchedLogsResult> {
    const targets = classified.filter((c) => c.role === "gps-log" && c.logExtractorId);
    const videoIndex = "videosByFilename" in knownVideos ? knownVideos : buildVideoAssociationIndex(knownVideos);

    const allRecords: GpsRecord[] = [];
    const allSkipped: SkippedLine[] = [];
    const errors: DispatchedLogsResult["errors"] = [];
    const used = new Set<string>();
    const extractorByFileKey = new Map<string, string>();

    if (targets.length === 0) {
        return { appliedExtractors: [], extractorByFileKey, records: [], skipped: [], errors };
    }

    const knownVideoRefs = [...videoIndex.videosByFilename.values()].flatMap((sameName) =>
        sameName.map((video) => ({
            name: video.file.name,
            relativePath: video.relativePath,
            videoKey: vendorFileKey(videoIndex.canonicalByFileKey.get(vendorFileKey(video)) ?? video),
            ...(video.sourceKey === undefined ? {} : { sourceKey: video.sourceKey }),
        })),
    );
    const { successes, failures } = await dispatchViaPool(targets, (c) => {
        const req: ParseLogRequestData = { file: c.file, extractorId: c.logExtractorId!, knownVideos: knownVideoRefs };
        return pool.request<ParseLogResult>(INGEST_REQUEST_PARSE_LOG, req, { signal });
    });

    for (const { target: c, message } of failures) {
        errors.push({ file: c.file.file.name, extractor: c.logExtractorId ?? "", message });
    }
    for (const { target: c, result: r } of successes) {
        const extractorId = c.logExtractorId!;
        // extendArray, not push(...): a single whole-card 70mai log parses to
        // 130k+ records and the spread overflows the call-argument limit.
        extendArray(allSkipped, r.skipped);
        if (r.records.length > 0) {
            associateRecordsWithVideos(r.records, c.file, videoIndex);
            extendArray(allRecords, r.records);
            used.add(extractorId);
            for (const rec of r.records) {
                if (rec.videoKey !== undefined && !extractorByFileKey.has(rec.videoKey)) {
                    extractorByFileKey.set(rec.videoKey, extractorId);
                }
            }
        }
    }

    return { appliedExtractors: [...used], extractorByFileKey, records: allRecords, skipped: allSkipped, errors };
}

// ===== parse sidecars =====

interface DispatchedSidecarsResult {
    records: GpsRecord[];
    extractorByFileKey: Map<string, string>;
    errors: Array<{ file: string; sidecarId: string; message: string }>;
}

/** GPX classified entries are parsed on main (DOMParser); the rest go to
 *  the pool. Errors are aggregated, AbortError propagates. */
export async function dispatchParseSidecarsViaPool(
    classified: ClassifiedFile[],
    knownVideos: readonly VendorFile[] | VideoAssociationIndex,
    signal?: AbortSignal,
): Promise<DispatchedSidecarsResult> {
    const records: GpsRecord[] = [];
    const videoIndex = "videosByFilename" in knownVideos ? knownVideos : buildVideoAssociationIndex(knownVideos);
    const errors: DispatchedSidecarsResult["errors"] = [];
    const extractorByFileKey = new Map<string, string>();

    const collect = (target: ClassifiedFile, recs: GpsRecord[], extractorId: string): void => {
        associateRecordsWithVideos(recs, target.file, videoIndex);
        extendArray(records, recs);
        const key = resolveVideoKey(target.file, target.sidecarMp4!, videoIndex);
        if (recs.length > 0 && key !== null && !extractorByFileKey.has(key)) {
            extractorByFileKey.set(key, extractorId);
        }
    };

    const parseGpx = async (target: ClassifiedFile): Promise<void> => {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        try {
            const recs = await gpxSidecar.parse(target.file, target.sidecarMp4!, signal);
            collect(target, recs, gpxSidecar.id);
        } catch (err) {
            // Cancellation must not appear as a corrupt sidecar.
            if (err instanceof Error && err.name === "AbortError") throw err;
            errors.push({
                file: target.file.file.name,
                sidecarId: gpxSidecar.id,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    };

    const gpxTargets: ClassifiedFile[] = [];
    const workerTargets: ClassifiedFile[] = [];
    for (const c of classified) {
        if (c.role !== "sidecar" || !c.sidecarId || !c.sidecarMp4) continue;
        if (c.sidecarId === "gpx") {
            gpxTargets.push(c);
        } else {
            workerTargets.push(c);
        }
    }

    // Parse GPX on main, sequentially - real-world drops carry at most a
    // handful, sequential is simpler than parallel and the user already
    // sees parallelism on the worker side.
    for (const c of gpxTargets) {
        await parseGpx(c);
    }

    if (workerTargets.length > 0) {
        const { successes, failures } = await dispatchViaPool(workerTargets, (c) => {
            const req: ParseSidecarRequestData = {
                file: c.file,
                sidecarId: c.sidecarId!,
                mp4Filename: c.sidecarMp4!,
            };
            return pool.request<ParseSidecarResult>(INGEST_REQUEST_PARSE_SIDECAR, req, { signal });
        });

        for (const { target: c, message } of failures) {
            errors.push({ file: c.file.file.name, sidecarId: c.sidecarId ?? "", message });
        }
        for (const { target: c, result: r } of successes) {
            if (r.wrongFormat) {
                // The worker matched ddpai-gpx by basename+dir but the content
                // is real XML GPX, which it cannot parse (no DOMParser). Fall
                // through to the main-thread gpxSidecar - a real .gpx inside a
                // DDPai gps dir must still load (nmea-sidecar.ts:106). This is
                // control flow, not an error, so it is never recorded as one.
                if (c.sidecarId === "ddpai-gpx") {
                    await parseGpx(c);
                }
                continue;
            }
            collect(c, r.records, c.sidecarId!);
        }
    }

    return { records, extractorByFileKey, errors };
}

// ===== parse accel sidecars =====

interface DispatchedAccelSidecarsResult {
    accelByFileKey: Map<string, AccelSample[]>;
    errors: Array<{ file: string; sidecarId: string; message: string }>;
}

export async function dispatchParseAccelSidecarsViaPool(
    classified: ClassifiedFile[],
    knownVideos: readonly VendorFile[] | VideoAssociationIndex,
    signal?: AbortSignal,
): Promise<DispatchedAccelSidecarsResult> {
    const targets = classified.filter((c) => c.role === "accel-sidecar" && c.sidecarId && c.sidecarMp4);
    const videoIndex = "videosByFilename" in knownVideos ? knownVideos : buildVideoAssociationIndex(knownVideos);

    const accelByFileKey = new Map<string, AccelSample[]>();
    const errors: DispatchedAccelSidecarsResult["errors"] = [];

    if (targets.length === 0) return { accelByFileKey, errors };

    const { successes, failures } = await dispatchViaPool(targets, (c) => {
        const req: ParseAccelSidecarRequestData = { file: c.file, sidecarId: c.sidecarId! };
        return pool.request<ParseAccelSidecarResult>(INGEST_REQUEST_PARSE_ACCEL_SIDECAR, req, { signal });
    });

    for (const { target: c, message } of failures) {
        errors.push({ file: c.file.file.name, sidecarId: c.sidecarId ?? "", message });
    }
    for (const { target: c, result: r } of successes) {
        const key = resolveVideoKey(c.file, c.sidecarMp4!, videoIndex);
        if (r.samples.length > 0 && key !== null) accelByFileKey.set(key, r.samples);
    }

    return { accelByFileKey, errors };
}

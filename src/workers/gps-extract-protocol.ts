// Wire payloads exchanged between ui/gps-extract-shim.ts and
// workers/gps-extract-worker.ts. Wrapped in the standard envelope by
// worker-client / worker-server.

import type { WorkerContract, WorkerRequest } from "./_protocol/worker-contract.js";

import type { ClassifiedFile, DispatchedEmbeddedGpsResult } from "../parsers/registry.js";

export type EmbeddedGpsExtractionMode = "all" | "light-only";

/** Request payload for "extract". One batch per request. */
export interface ExtractRequestData {
    /**
     * Dispatch correlation token - echoed in every progress notification so the
     * shim routes it to exactly one dispatch when several are in flight (bulk
     * ingest fans into multiple concurrent batches and a deferred scan can overlap).
     */
    token: string;
    classified: ClassifiedFile[];
    concurrency: number;
    mode: EmbeddedGpsExtractionMode;
    /**
     * Pre-loaded moov bytes keyed by vendorFileKey, NOT basename: two files
     * with the same basename, path, or metadata in different sources would
     * otherwise share one buffer, and since the buffer is transferred the
     * second postMessage would hit a detached ArrayBuffer. Forwarded by the
     * ingest pipeline from indexer-worker so buildMp4Index inside the worker
     * does not re-read the moov box on cold SD (closes the 2x IO that
     * indexer.ts:17-20 used to flag). Optional - missing entries fall back
     * to a normal file.slice read inside buildMp4Index.
     *
     * Bytes are transferred (zero-copy) - main side must NOT touch them
     * after sending.
     */
    prebuiltMoovByPath?: Map<string, Uint8Array>;
}

/** Push notification from worker after each file is processed. */
export interface ProgressNotificationData {
    /** Echo of ExtractRequestData.token - routes the notification to one dispatch. */
    token: string;
    done: number;
    total: number;
    fileName: string;
}

/** Request type constants - shared so both ends agree on routing keys. */
export const GPS_REQUEST_EXTRACT = "extract";

/** Notification type constants. */
export const GPS_NOTIFY_PROGRESS = "progress";

export type ExtractResult = DispatchedEmbeddedGpsResult;

export type GpsExtractWorkerContract = WorkerContract<
    {
        [GPS_REQUEST_EXTRACT]: WorkerRequest<ExtractRequestData, ExtractResult>;
    },
    Record<never, never>,
    {
        [GPS_NOTIFY_PROGRESS]: ProgressNotificationData;
    },
    Record<never, never>
>;

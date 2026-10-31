// Wire payloads exchanged between ui/ingest-shim.ts and
// workers/ingest-worker.ts. Wrapped in the standard envelope by
// worker-client / worker-server.
//
// Atomic per-file protocol for parse-* operations: one request = one file.
// The worker pool's least-inflight balancing distributes N parallel requests
// across slots without the shim needing to shard manually. Classify is the
// exception - it ships a batch because knownVideoNames is shared state that
// would otherwise be copied with every request (240 files * 240 names = 1.7 MB
// of redundant string-copy traffic per ingest).

import type { WorkerContract, WorkerRequest } from "./_protocol/worker-contract.js";

import type { ClassifiedFile } from "../parsers/registry.js";
import type { PrimitiveVideoRef } from "../parsers/primitives/types.js";
import type { AccelSample, GpsRecord, SkippedLine, VendorFile } from "../parsers/types.js";

// === Classify (batch per shard) ===
export const INGEST_REQUEST_CLASSIFY_BATCH = "classify-batch";

export interface ClassifyBatchRequestData {
    /** Non-video files to classify. Caller filters by extension on main. */
    files: VendorFile[];
    /** Snapshot of known video basenames (state.trips + this drop's videos). */
    knownVideoNames: string[];
}

export type ClassifyBatchResult = ClassifiedFile[];

// === Parse log-sidecar (atomic per file) ===
export const INGEST_REQUEST_PARSE_LOG = "parse-log";

export interface ParseLogRequestData {
    file: VendorFile;
    extractorId: string;
    knownVideos: PrimitiveVideoRef[];
}

export interface ParseLogResult {
    records: GpsRecord[];
    skipped: SkippedLine[];
}

// === Parse gps-sidecar (atomic per file) ===
export const INGEST_REQUEST_PARSE_SIDECAR = "parse-sidecar";

export interface ParseSidecarRequestData {
    file: VendorFile;
    sidecarId: string;
    mp4Filename: string;
}

export interface ParseSidecarResult {
    records: GpsRecord[];
    /**
     * Set when the handler threw WrongFormatError (marker matched but content
     * did not) instead of parsing. The shim reads it to fall through to the
     * main-thread gpxSidecar for a real XML .gpx sitting in a DDPai gps dir,
     * rather than recording a parse error. See ingest-worker parse-sidecar.
     */
    wrongFormat?: true;
}

// === Parse accel-only sidecar (atomic per file) ===
export const INGEST_REQUEST_PARSE_ACCEL_SIDECAR = "parse-accel-sidecar";

export interface ParseAccelSidecarRequestData {
    file: VendorFile;
    sidecarId: string;
}

export interface ParseAccelSidecarResult {
    samples: AccelSample[];
}

export type IngestWorkerContract = WorkerContract<
    {
        [INGEST_REQUEST_CLASSIFY_BATCH]: WorkerRequest<ClassifyBatchRequestData, ClassifyBatchResult>;
        [INGEST_REQUEST_PARSE_LOG]: WorkerRequest<ParseLogRequestData, ParseLogResult>;
        [INGEST_REQUEST_PARSE_SIDECAR]: WorkerRequest<ParseSidecarRequestData, ParseSidecarResult>;
        [INGEST_REQUEST_PARSE_ACCEL_SIDECAR]: WorkerRequest<ParseAccelSidecarRequestData, ParseAccelSidecarResult>;
    },
    Record<never, never>,
    Record<never, never>,
    Record<never, never>
>;

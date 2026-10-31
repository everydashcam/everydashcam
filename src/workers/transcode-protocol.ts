// Wire payloads exchanged between ui/transcode-shim.ts and
// workers/transcode-worker.ts.
//
// Writer transfer: the main side keeps the real FSA writable and hands the
// worker one end of a MessageChannel (createWorkerWritableProxy). The worker
// wraps that port in an FSA-shaped writable (wrapPortAsFsaWritable) and pipes
// write/close/abort over it; the main side applies each to the real writable.
// FSA objects themselves cannot be transferred (FileSystemWritableFileStream
// serializes as DataCloneError, and a fresh handle from showSaveFilePicker
// fails createWritable() in worker scope), and a transferable WritableStream -
// what we used before - is a DataCloneError on stable Safari (WebKit #215485).
// A MessagePort is transferable on every target browser. See port-writable.ts.

import type { WorkerContract, WorkerRequest } from "./_protocol/worker-contract.js";
import type { MapSnapshotRequest } from "../transcode/map-snapshotter-types.js";

import type { TranscodeArgs, TranscodeProgress, TranscodeResult } from "../transcode/types.js";
import type { TranscodeSplitArgs } from "../transcode/pipeline-split.js";

/** Transferable subset of TranscodeArgs - runtime-only fields are passed separately. */
export type TranscodeArgsForTransfer = Omit<TranscodeArgs, "signal" | "writable" | "onProgress">;
export type TranscodeSplitArgsForTransfer = Omit<TranscodeSplitArgs, "signal" | "writable" | "onProgress">;

/** Request payload for the single-channel transcode path. */
export interface TranscodeSingleRequestData {
    args: TranscodeArgsForTransfer;
    writablePort: MessagePort;
}

/** Request payload for the split-screen transcode path. */
export interface TranscodeSplitRequestData {
    args: TranscodeSplitArgsForTransfer;
    writablePort: MessagePort;
}

/** Push notification: progress update from the encode loop. */
export interface TranscodeProgressNotificationData {
    progress: TranscodeProgress;
}

export const TRANSCODE_REQUEST_SINGLE = "transcode-single";
export const TRANSCODE_REQUEST_SPLIT = "transcode-split";
export const TRANSCODE_NOTIFY_PROGRESS = "progress";

/** Reverse RPC: MapLibre renders each requested map frame on the page. */
export const TRANSCODE_REQUEST_MAP_SNAPSHOT = "map-snapshot";

export type TranscodeWorkerContract = WorkerContract<
    {
        [TRANSCODE_REQUEST_SINGLE]: WorkerRequest<TranscodeSingleRequestData, TranscodeResult>;
        [TRANSCODE_REQUEST_SPLIT]: WorkerRequest<TranscodeSplitRequestData, TranscodeResult>;
    },
    Record<never, never>,
    { [TRANSCODE_NOTIFY_PROGRESS]: TranscodeProgressNotificationData },
    { [TRANSCODE_REQUEST_MAP_SNAPSHOT]: WorkerRequest<MapSnapshotRequest, ImageBitmap> }
>;

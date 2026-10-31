// Wire payloads exchanged between ui/frame-extract.ts and
// workers/frame-extract-worker.ts.
//
// Transfer note: extracted bitmaps are returned via createWorkerServer's
// ctx.transfer(); the framework attaches them to the postMessage transfer
// list. ImageBitmap is Transferable - after the postMessage the worker's
// reference is detached and main is the sole owner. Main MUST call
// bitmap.close() when done, otherwise the GPU surface lingers until GC.

import type { WorkerContract, WorkerRequest } from "./_protocol/worker-contract.js";

/** Request payload for "extract". One batch per request. */
export interface ExtractRequestData {
    file: File;
    timestamps: number[];
}

/** Response from a successful extract. Length equals timestamps.length; nulls
 *  mark failed slots (corrupt GOP, decode error). On abort the array is empty
 *  or partial - caller closes any received bitmaps before discarding. */
export interface ExtractResult {
    bitmaps: (ImageBitmap | null)[];
}

export const FRAME_REQUEST_EXTRACT = "extract";
/** Notification: closes all cached decoders inside the worker. Called on
 *  active trip change and modal close - lets the worker drop GPU surfaces
 *  it no longer needs. */
export const FRAME_NOTIFY_DISPOSE_ALL = "dispose-all";

export type FrameExtractWorkerContract = WorkerContract<
    {
        [FRAME_REQUEST_EXTRACT]: WorkerRequest<ExtractRequestData, ExtractResult>;
    },
    {
        [FRAME_NOTIFY_DISPOSE_ALL]: undefined;
    },
    Record<never, never>,
    Record<never, never>
>;

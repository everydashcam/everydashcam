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

/** Page-side runtime fields: functions and streams that cannot be cloned. */
type TranscodeRuntimeOnlyArgs = "signal" | "writable" | "onProgress" | "resolveHardwareAcceleration";

/** Transferable subset of TranscodeArgs - runtime-only fields are passed separately. */
export type TranscodeArgsForTransfer = Omit<TranscodeArgs, TranscodeRuntimeOnlyArgs>;
export type TranscodeSplitArgsForTransfer = Omit<TranscodeSplitArgs, TranscodeRuntimeOnlyArgs>;

/** Fields shared by both transcode request payloads. */
interface TranscodeRequestDataBase {
    writablePort: MessagePort;
    /**
     * True when the page is still deciding the encoder acceleration (the
     * automatic encoder trial runs alongside worker startup). The worker then
     * ignores args.output.hardwareAcceleration and asks the page via
     * TRANSCODE_REQUEST_HARDWARE_ACCELERATION right before it creates its
     * video encoder.
     */
    hardwareAccelerationDeferred: boolean;
}

/** Request payload for the single-channel transcode path. */
export interface TranscodeSingleRequestData extends TranscodeRequestDataBase {
    args: TranscodeArgsForTransfer;
}

/** Request payload for the split-screen transcode path. */
export interface TranscodeSplitRequestData extends TranscodeRequestDataBase {
    args: TranscodeSplitArgsForTransfer;
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

/** Reverse RPC: the page answers with the encoder acceleration once its
 *  decision settles. Issued at most once per run, and only when the request
 *  set hardwareAccelerationDeferred. Rejects with AbortError on cancel. */
export const TRANSCODE_REQUEST_HARDWARE_ACCELERATION = "hardware-acceleration";

export type TranscodeWorkerContract = WorkerContract<
    {
        [TRANSCODE_REQUEST_SINGLE]: WorkerRequest<TranscodeSingleRequestData, TranscodeResult>;
        [TRANSCODE_REQUEST_SPLIT]: WorkerRequest<TranscodeSplitRequestData, TranscodeResult>;
    },
    Record<never, never>,
    { [TRANSCODE_NOTIFY_PROGRESS]: TranscodeProgressNotificationData },
    {
        [TRANSCODE_REQUEST_MAP_SNAPSHOT]: WorkerRequest<MapSnapshotRequest, ImageBitmap>;
        [TRANSCODE_REQUEST_HARDWARE_ACCELERATION]: WorkerRequest<undefined, HardwareAcceleration>;
    }
>;

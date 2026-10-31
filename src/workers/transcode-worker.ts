// Worker for the transcode pipeline (single-channel and split-screen). Offloads
// from the main thread:
//  - the decode → drawImage into OffscreenCanvas → drawWatermark → encode loop
//    (on 1080p HEVC this is the hottest path, visible in Performance traces as
//    Function call / drawImage / VideoFrame summing to seconds);
//  - sample-by-sample backpressure awaits through mediabunny;
//  - WebCodecs decoder/encoder run in browser threads anyway, but the loop
//    around them moves out of the main thread.
//
// UX effect: page interactivity (player, map, sidebar) stays responsive during
// export. The worker does not speed up absolute export throughput - the
// encoder/decoder are already on the GPU; the JS loop is not the bottleneck.

import { createLogger } from "../log.js";
import { transcode } from "../transcode/pipeline.js";
import { transcodeSplit } from "../transcode/pipeline-split.js";
import type { TranscodeResult } from "../transcode/types.js";

import { MapSnapshotWorkerClient } from "./map-snapshot-worker-client.js";
import { wrapPortAsFsaWritable } from "./port-writable.js";
import {
    TRANSCODE_NOTIFY_PROGRESS,
    TRANSCODE_REQUEST_SINGLE,
    TRANSCODE_REQUEST_SPLIT,
    type TranscodeProgressNotificationData,
    type TranscodeSingleRequestData,
    type TranscodeSplitRequestData,
} from "./transcode-protocol.js";
import { createWorkerServer, type WorkerScopeEndpoint } from "./_protocol/worker-server.js";

const log = createLogger("worker:transcode");

declare const self: WorkerScopeEndpoint;

// Runtime-only args both pipelines receive on top of their transferred request
// args (writable + abort signal + progress relay + snapshotter). Built once per
// request in runPipeline and spread into the pipeline call.
interface TranscodeRuntimeExtras {
    writable: FileSystemWritableFileStream;
    signal: AbortSignal;
    onProgress: (p: TranscodeProgressNotificationData["progress"]) => void;
    mapSnapshotter: MapSnapshotWorkerClient | undefined;
}

const server = createWorkerServer(self, {
    onRequest: async (type, data, ctx): Promise<TranscodeResult> => {
        // moov bytes captured during finalize ride back in the result for the
        // GPMF post-process; transfer (not clone) the multi-MB buffer.
        const transferMoov = (result: TranscodeResult): TranscodeResult => {
            if (result.capturedMoov) ctx.transfer([result.capturedMoov.bytes.buffer as ArrayBuffer]);
            return result;
        };
        // Both request branches differ only in the pipeline fn and the log label;
        // the writable wrap, snapshotter gating, progress relay, transferMoov,
        // AbortError-filtered catch and pending-snapshot flush are identical.
        const runPipeline = async (
            writablePort: MessagePort,
            overlaysMap: boolean,
            run: (extras: TranscodeRuntimeExtras) => Promise<TranscodeResult>,
            label: string,
        ): Promise<TranscodeResult> => {
            const snapshotClient = overlaysMap ? new MapSnapshotWorkerClient(server) : undefined;
            const cancelSnapshots = () => snapshotClient?.dispose("transcode aborted");
            ctx.signal.addEventListener("abort", cancelSnapshots, { once: true });
            if (ctx.signal.aborted) cancelSnapshots();
            const extras: TranscodeRuntimeExtras = {
                // The pinned StreamTarget retires full chunks after writing;
                // the real-muxer bridge test guards that ownership on upgrades.
                writable: wrapPortAsFsaWritable(writablePort, { transferFullBuffers: true }),
                signal: ctx.signal,
                onProgress: (p) => {
                    const ntf: TranscodeProgressNotificationData = { progress: p };
                    server.notify(TRANSCODE_NOTIFY_PROGRESS, ntf);
                },
                // Attach the snapshotter only when the map overlay is actually
                // enabled - otherwise the pipeline never touches it.
                mapSnapshotter: snapshotClient,
            };
            try {
                return transferMoov(await run(extras));
            } catch (err) {
                if (!(err instanceof DOMException && err.name === "AbortError")) {
                    log.error(`${label} failed`, err);
                }
                throw err;
            } finally {
                ctx.signal.removeEventListener("abort", cancelSnapshots);
                snapshotClient?.dispose("transcode settled");
            }
        };
        if (type === TRANSCODE_REQUEST_SINGLE) {
            const req = data as TranscodeSingleRequestData;
            return runPipeline(
                req.writablePort,
                !!req.args.output.overlays?.map,
                (extras) => transcode({ ...req.args, ...extras }),
                "transcode",
            );
        }
        if (type === TRANSCODE_REQUEST_SPLIT) {
            const req = data as TranscodeSplitRequestData;
            return runPipeline(
                req.writablePort,
                !!req.args.output.overlays?.map,
                (extras) => transcodeSplit({ ...req.args, ...extras }),
                "transcodeSplit",
            );
        }
        throw new Error(`unknown request type: ${type}`);
    },
});

// Public API for chart-hover tooltip frame previews. Heavy lifting
// (mediabunny demux + WebCodecs decode + decoder cache) lives in
// src/workers/frame-extract-worker.ts; this file is a thin singleton client
// that owns the worker.
//
// Previous version did all of this on the main thread which hard-froze the
// UI on MPEG-TS builds (~10 s of 100% CPU on a 1 GB / 7 min file -
// PMT scan + long-GOP decode-forward per frame).

import { combineAbortSignals } from "../abort-signals.js";
import { createLogger } from "../log.js";
import {
    FRAME_NOTIFY_DISPOSE_ALL,
    FRAME_REQUEST_EXTRACT,
    type ExtractRequestData,
    type ExtractResult,
} from "../workers/frame-extract-protocol.js";
import { createWorkerClient, type WorkerClient } from "../workers/_protocol/worker-client.js";

const log = createLogger("frame-extract");

let client: WorkerClient | null = null;

function getClient(): WorkerClient {
    if (client && !client.disposed) return client;
    const worker = new Worker(new URL("../workers/frame-extract-worker.ts", import.meta.url), {
        type: "module",
        name: "frame-extract-worker",
    });
    client = createWorkerClient(worker, {
        name: "frame-extract",
        onDiscardedResult: (result) => {
            const { bitmaps } = result as ExtractResult;
            for (const bitmap of bitmaps) bitmap?.close();
        },
        onCrash: () => {
            // Force re-spawn on next call.
            client = null;
        },
    });
    return client;
}

/** Safety net: bounds caller wait if the worker silently wedges
 *  (e.g. WebCodecs decoder stuck, mediabunny internal deadlock).
 *  Healthy strip-build batch is ~500 ms on a desktop MP4, up to 5-8s on a 1+ GB
 *  MPEG-TS (PMT scan + long-GOP decode); on mobile the decoder is another 2-3x
 *  slower. 20s covers the observed worst case without false timeouts (the
 *  "frame-extract request timed out" warning). */
const WORKER_REQUEST_TIMEOUT_MS = 20000;

/**
 * Batched extraction of N frames from a single file. Worker uses an LRU
 * decoder cache so consecutive calls on the same file reuse the open Input.
 *
 * signal lets the caller cancel a long-running extract on trip change /
 * resize. createWorkerClient forwards the signal to the worker so the
 * handler stops at the next iteration boundary; the returned promise
 * rejects with AbortError immediately so the caller is not blocked.
 * Bitmaps that arrive AFTER cancel are closed by the framework discarding
 * the late response (caller never sees them).
 */
async function workerExtractFrames(
    file: File,
    timestamps: number[],
    signal?: AbortSignal,
): Promise<(ImageBitmap | null)[]> {
    if (timestamps.length === 0) return [];
    if (signal?.aborted) return [];
    // Combine caller signal with a timeout so a wedged worker does not hang
    // the caller forever.
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => {
        log.warn("frame-extract request timed out", { file: file.name, count: timestamps.length });
        timeoutCtrl.abort();
    }, WORKER_REQUEST_TIMEOUT_MS);
    const combined = combineAbortSignals(signal ? [signal, timeoutCtrl.signal] : [timeoutCtrl.signal]);

    const req: ExtractRequestData = { file, timestamps };
    try {
        const result = await getClient().request<ExtractResult>(FRAME_REQUEST_EXTRACT, req, {
            signal: combined.signal,
        });
        return result.bitmaps;
    } catch (err) {
        // Abort / timeout / crash all return an empty array to the caller -
        // strip slot stays black, no exception propagation up the chart path.
        if (err instanceof DOMException && err.name === "AbortError") return [];
        log.debug("frame-extract failed", { file: file.name, err: String(err) });
        return [];
    } finally {
        clearTimeout(timer);
        combined.dispose();
    }
}

/** Closes all decoders inside the worker. Call on active trip change and modal close. */
export function disposeAllFrameDecoders(): void {
    if (!client || client.disposed) return;
    client.notify(FRAME_NOTIFY_DISPOSE_ALL);
}

/**
 * Extracts a single frame at timeSec. mediabunny handles keyframe rounding
 * internally (seeks to the nearest preceding keyframe and decodes forward
 * to timeSec). Returns a transferable ImageBitmap, or null on decode failure.
 */
export async function extractFrameAt(file: File, timeSec: number): Promise<ImageBitmap | null> {
    const out = await workerExtractFrames(file, [timeSec]);
    return out[0] ?? null;
}

// Worker for generating a trip's first-frame preview. Offloads two heavy
// synchronous operations from the main thread: drawImage into canvas
// (sample.drawWithFit) and canvas.toDataURL JPEG encoding. Each takes
// ~100-300ms on a typical HEVC file; across 50 trips this accumulates into
// seconds of visible freeze.
//
// Contract: one file per call. The worker holds no state between requests;
// each Input opens and closes independently. This lets the main-thread pool
// balance load across N workers without cross-talk.

import type { PreviewWorkerContract } from "./preview-protocol.js";

import { CanvasSink, Input, InputDisposedError, UnsupportedInputFormatError } from "mediabunny";

import { PREVIEW_HEIGHT_PX, PREVIEW_JPEG_QUALITY, PREVIEW_WIDTH_PX } from "../preview-config.js";
import { createBlobSource } from "../blob-source.js";
import { VIDEO_INPUT_FORMATS } from "../video-formats.js";

import { PREVIEW_REQUEST_EXTRACT } from "./preview-protocol.js";
import { createTypedWorkerServer, type WorkerScopeEndpoint } from "./_protocol/worker-server.js";

declare const self: WorkerScopeEndpoint;

/**
 * Extracts the first frame via mediabunny + OffscreenCanvas + convertToBlob.
 * convertToBlob is a thread-safe canvas API; it does not block the main
 * thread (which does not exist here anyway). Blob → base64 dataURL is done
 * manually since FileReader is unavailable, but encoding 10-15KB is
 * microseconds.
 */
async function extractFirstFrameDataUrl(file: File): Promise<string | null> {
    let input: Input | null = null;
    try {
        input = new Input({ source: await createBlobSource(file), formats: VIDEO_INPUT_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        if (!track) return null;

        // CanvasSink folds rotation + cover-fit resize into the decode and
        // closes the underlying VideoSample itself, so there is no manual
        // sample.close() to forget. A forgotten close stalls the Chromium
        // decoder queue (~60 counted VideoFrames) and hangs later requests in
        // this worker; input.dispose() in the finally is the backstop.
        const sink = new CanvasSink(track, {
            width: PREVIEW_WIDTH_PX,
            height: PREVIEW_HEIGHT_PX,
            fit: "cover",
        });
        // First frame via the iterator, NOT `getCanvas(0)`. Some files put the
        // first sample at timestamp != 0 (Ambarella `tapt`/`edts` edit-lists,
        // Lavf remuxes with a small pre-roll), where `getCanvas(0)` returns
        // null. The iterator starts from the first real frame regardless of ts.
        const iter = sink.canvases();
        const first = await iter.next();
        await iter.return?.(undefined);
        if (first.done || !first.value) return null;

        // In a worker the sink yields an OffscreenCanvas; convertToBlob is
        // OffscreenCanvas-only. The guard is a type-narrow, never false here.
        const { canvas } = first.value;
        if (!(canvas instanceof OffscreenCanvas)) return null;

        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: PREVIEW_JPEG_QUALITY });
        const buf = new Uint8Array(await blob.arrayBuffer());
        const base64 = bytesToBase64(buf);
        return `data:image/jpeg;base64,${base64}`;
    } catch (err) {
        // InputDisposedError - race on very fast updates, not critical.
        // UnsupportedInputFormatError - file is not MP4 (misclassification).
        if (err instanceof InputDisposedError) return null;
        if (err instanceof UnsupportedInputFormatError) return null;
        throw err;
    } finally {
        try {
            input?.dispose();
        } catch {
            /* ignore */
        }
    }
}

/**
 * Uint8Array → base64 without btoa(String.fromCharCode(...)) - that form
 * crashes on large arrays due to the call/apply argument limit. Processing
 * in 8KB chunks is safe. For a 10-20KB JPEG this is 1-3 iterations.
 */
function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x2000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

createTypedWorkerServer<PreviewWorkerContract>(self, {
    onRequest: {
        [PREVIEW_REQUEST_EXTRACT]: async (req) => {
            const dataUrl = await extractFirstFrameDataUrl(req.file);
            return { dataUrl };
        },
    },
});

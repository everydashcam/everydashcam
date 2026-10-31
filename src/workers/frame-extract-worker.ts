// Worker for chart-strip thumbnails and chart-hover tooltip previews. Owns
// mediabunny Input + CanvasSink + the LRU decoder cache so that the
// main thread is never blocked on demux/decode work - critical for MPEG-TS
// where opening a new Input does a PMT scan (~80 ms on a 1 GB file) and
// long-GOP decode-forward to a keyframe can be hundreds of ms per thumb.
//
// Protocol: one "extract" request carries one file + N timestamps; reply
// has N ImageBitmaps (transferable, nulls for failed slots). Caller batches
// timestamps belonging to the same file to amortise PMT scan / decoder
// init across all thumbs in a strip build.
//
// Cancellation: AbortSignal forwarded by createWorkerClient lands in
// ctx.signal on the handler. The serialize() gate inside still queues
// extract handlers one at a time (DecoderEntry/VideoSampleSink concurrency
// is undocumented in mediabunny), but a fresh request's ctx.signal can
// already be aborted by the time the gate releases - extractFrames checks
// at every iteration boundary.

import type { FrameExtractWorkerContract } from "./frame-extract-protocol.js";

import { CanvasSink, Input, InputDisposedError, type InputVideoTrack, type WrappedCanvas } from "mediabunny";

import { createLogger } from "../log.js";
import { getInputTimeOrigin } from "../media-time.js";
import { createBlobSource } from "../blob-source.js";
import { VIDEO_INPUT_FORMATS } from "../video-formats.js";

import { getCanvasNearestForward } from "./canvas-seek.js";

import { FRAME_NOTIFY_DISPOSE_ALL, FRAME_REQUEST_EXTRACT } from "./frame-extract-protocol.js";
import { createTypedWorkerServer, type WorkerScopeEndpoint } from "./_protocol/worker-server.js";

const log = createLogger("worker:frame-extract");

interface DecoderEntry {
    input: Input;
    track: InputVideoTrack;
    sink: CanvasSink;
    timeOrigin: number;
}

// Long-edge cap for decoded thumbnail canvases. Consumers (chart-strip popup,
// scrubber mini-thumb) are tiny - <=~600 physical px even at DPR 3 - so capping
// well above that keeps them sharp while sparing the ~16x decode-surface memory
// a full 4K frame would cost. Sources smaller than this are not upscaled.
const THUMB_DECODE_MAX_W = 960;

/** Headroom for Juscar-style 3-channel (F/R/I) trips: 3 current + 3 buffer
 * for adjacent segments still leaves slack against Chromium's global
 * VideoDecoder limit (~10-16). At 6 a strip scroll across a channel boundary
 * evicts the decoder we are about to need next; 10 keeps that window cached. */
const DECODER_CACHE_MAX = 10;
const decoderCache = new Map<string, DecoderEntry>();

declare const self: WorkerScopeEndpoint;

function decoderCacheKey(file: File): string {
    return `${file.name}|${file.size}|${file.lastModified}`;
}

function disposeEntry(entry: DecoderEntry): void {
    try {
        entry.input.dispose();
    } catch {
        /* ignore */
    }
}

async function getOrOpenDecoder(file: File): Promise<DecoderEntry | null> {
    const key = decoderCacheKey(file);
    const cached = decoderCache.get(key);
    if (cached) {
        // Promote to MRU.
        decoderCache.delete(key);
        decoderCache.set(key, cached);
        return cached;
    }
    let input: Input | null = null;
    try {
        input = new Input({
            source: await createBlobSource(file),
            formats: VIDEO_INPUT_FORMATS,
        });
        const track = await input.getPrimaryVideoTrack();
        if (!track) {
            input.dispose();
            return null;
        }
        // Decode straight to a downscaled, rotation-corrected canvas via CanvasSink:
        // mediabunny folds the display-matrix rotation into the decode (plain
        // VideoSample.draw did not, so sideways-mounted cams produced sideways
        // thumbs) and downscales to the cap, sparing 4K decode-surface memory.
        const displayW = await track.getDisplayWidth().catch(() => 0);
        const width = Math.min(Math.round(displayW) || THUMB_DECODE_MAX_W, THUMB_DECODE_MAX_W);
        const entry: DecoderEntry = {
            input,
            track,
            // Extraction is serialized and each bitmap snapshots the canvas before reuse.
            sink: new CanvasSink(track, { width, poolSize: 1 }),
            timeOrigin: await getInputTimeOrigin(input),
        };
        decoderCache.set(key, entry);
        // Evict LRU until under cap.
        while (decoderCache.size > DECODER_CACHE_MAX) {
            const oldestKey = decoderCache.keys().next().value;
            if (!oldestKey) break;
            const oldest = decoderCache.get(oldestKey);
            decoderCache.delete(oldestKey);
            if (oldest) disposeEntry(oldest);
        }
        return entry;
    } catch (err) {
        input?.dispose();
        log.debug("decoder open failed", { file: file.name, err: String(err) });
        return null;
    }
}

async function canvasToImageBitmap(wrapped: WrappedCanvas): Promise<ImageBitmap | null> {
    try {
        // createImageBitmap snapshots the source, copying the (already downscaled +
        // rotation-corrected) canvas into a transferable ImageBitmap. The sink is
        // then free to reuse the canvas for the next frame.
        return await createImageBitmap(wrapped.canvas);
    } catch {
        return null;
    }
}

/**
 * Batched extraction. For each timestamp tries up to 2 attempts; on
 * EncodingError the VideoDecoder is in a poisoned state and subsequent
 * samples come back failing too, so we evict + reopen the decoder before
 * the next timestamp. Caps the visible damage of one bad GOP to one slot.
 */
async function extractFrames(file: File, timestamps: number[], signal: AbortSignal): Promise<(ImageBitmap | null)[]> {
    const bitmaps: (ImageBitmap | null)[] = new Array(timestamps.length).fill(null);
    // Release cancelled output here without transferring GPU surfaces to main.
    const dropAndReturn = (): (ImageBitmap | null)[] => {
        for (let i = 0; i < bitmaps.length; i++) {
            bitmaps[i]?.close();
            bitmaps[i] = null;
        }
        return bitmaps;
    };
    if (signal.aborted) return bitmaps;
    let entry = await getOrOpenDecoder(file);
    if (!entry) return bitmaps;
    if (signal.aborted) return bitmaps;

    for (let i = 0; i < timestamps.length; i++) {
        if (signal.aborted) return dropAndReturn();
        const t = timestamps[i];
        if (t === undefined || t === null || !Number.isFinite(t)) continue;
        let bitmap: ImageBitmap | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const wrapped = await getCanvasNearestForward(entry.sink, t + entry.timeOrigin);
                if (signal.aborted) return dropAndReturn();
                if (!wrapped) break;
                bitmap = await canvasToImageBitmap(wrapped);
                if (bitmap) break;
            } catch (err) {
                const isDisposed = err instanceof InputDisposedError;
                if (isDisposed) break;
                log.debug("extract failed", { file: file.name, t, attempt, err: String(err) });
                // Evict the poisoned decoder; reopen on the retry.
                const key = decoderCacheKey(file);
                if (decoderCache.get(key) === entry) {
                    decoderCache.delete(key);
                    disposeEntry(entry);
                }
                const fresh = await getOrOpenDecoder(file);
                if (!fresh) {
                    // Reopen failed - the file is likely inaccessible or
                    // broken. Returning bitmaps as-is (with nulls for the
                    // remaining slots) avoids wasting a 80-ms PMT scan
                    // per remaining timestamp on a file we already know
                    // cannot be opened.
                    return bitmaps;
                }
                entry = fresh;
            }
        }
        bitmaps[i] = bitmap;
    }

    // The final decode can be cancelled without another loop iteration.
    if (signal.aborted) return dropAndReturn();

    return bitmaps;
}

function disposeAllDecoders(): void {
    for (const entry of decoderCache.values()) disposeEntry(entry);
    decoderCache.clear();
}

// Serialize all extract handlers. Without this, two extract messages
// arriving close together (typical case: chart hover during a strip build)
// interleave at the first await inside extractFrames - both would race on
// the same DecoderEntry's CanvasSink. mediabunny does not document
// concurrent CanvasSink access; defensive choice is one-at-a-time.
// dispose-all goes through the same gate so it waits for an in-flight
// extract to finish instead of yanking the decoder out from under it.
let opQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = opQueue.then(fn, fn);
    opQueue = next.catch(() => undefined);
    return next;
}

createTypedWorkerServer<FrameExtractWorkerContract>(self, {
    onRequest: {
        [FRAME_REQUEST_EXTRACT]: async (req, ctx) => {
            return await serialize(async () => {
                const bitmaps = await extractFrames(req.file, req.timestamps, ctx.signal);
                // Mark transferable bitmaps so the framework attaches them to the
                // postMessage transfer list - zero-copy ownership move to main.
                const transferList: Transferable[] = [];
                for (const b of bitmaps) {
                    if (b) transferList.push(b);
                }
                ctx.transfer(transferList);
                return { bitmaps };
            });
        },
    },
    onNotification: {
        [FRAME_NOTIFY_DISPOSE_ALL]: () => {
            // Serialize through the same gate so we do not yank decoders
            // from under an in-flight extract.
            void serialize(async () => disposeAllDecoders());
        },
    },
});

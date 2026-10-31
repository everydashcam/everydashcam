// Export reads go through this source instead of mediabunny's BlobSource so a
// TRANSIENT source-read failure does not kill a multi-minute export. The known
// culprit class is Windows-specific: an on-access scanner takes a momentary
// exclusive lock on the file and Chromium's blob read fails with the literal
// "network error" (see source-read-error.ts) - Chromium hardened its own file
// operations against exactly this by retrying, but a JS-level blob read gets
// no retry from the browser. A dead source (card pulled) still fails: retries
// are bounded and the original error is rethrown for the export flow's
// "check your card/drive" mapping.
//
// Reads are served by a pool of long-lived positioned readers, not a fresh
// blob.slice(start, end).stream() per request: the orchestrator asks for data
// in page-sized sequential ranges, and paying stream setup per range made the
// naive version ~11x slower than BlobSource in the packet-walk bench. A
// pooled reader is a tail slice (start to EOF) consumed across consecutive
// ranges - the same mechanics BlobSource keeps per read worker internally.

import { CustomSource } from "mediabunny";

import { throwIfCancelled, combineAbortSignals } from "./abort-signals.js";
import { createBackgroundReadErrorHandler, demuxView } from "./blob-source.js";
import { identifyBrowser } from "./capabilities.js";
import { createLogger } from "./log.js";
import { isSourceReadError } from "./source-read-error.js";

const log = createLogger("retrying-blob-source");

// Consecutive-failure backoff. Scanner locks are millisecond-scale, so the
// first retry is quick; the tail exists for a scanner that decided to hash a
// gigabyte file. A permanently dead source costs the sum (~4 s) extra before
// the export fails with the original error.
const RETRY_DELAYS_MS = [250, 1000, 3000];

// The orchestrator runs at most 2 read workers per CustomSource; a couple of
// spare slots cover noncontiguous ranges without hoarding open readers.
const MAX_POOLED_READERS = 4;

/**
 * Decides the fate of a failed read attempt: waits out the next backoff step
 * for a retryable source-read error, rethrows anything else (or a read error
 * that exhausted the budget) unchanged. `failuresSoFar` is the count BEFORE
 * this failure; the caller increments it after this resolves.
 */
async function backoffOrRethrow(
    err: unknown,
    failuresSoFar: number,
    offset: number,
    signal: AbortSignal | undefined,
): Promise<void> {
    if (!isSourceReadError(err) || failuresSoFar >= RETRY_DELAYS_MS.length) throw err;
    const delayMs = RETRY_DELAYS_MS[failuresSoFar]!;
    log.warn("source read failed, retrying", {
        attempt: failuresSoFar + 1,
        maxAttempts: RETRY_DELAYS_MS.length,
        delayMs,
        offset,
        err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    await sleepWithAbort(delayMs, signal);
}

/** Rejects with AbortError as soon as `signal` fires; resolves after `ms` otherwise. */
function sleepWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

// A live tail read of the blob. `pos` is the absolute offset of the next
// unserved byte; `leftover` holds bytes already pulled from the reader beyond
// a previous range's end (they start exactly at `pos`). `reader` is null right
// after a read failure - the next attempt re-slices from `pos`.
interface PositionedReader {
    pos: number;
    reader: ReadableStreamDefaultReader<Uint8Array> | null;
    leftover: Uint8Array | null;
}

/**
 * Pool of positioned tail readers over one blob, shared by every range stream
 * of a source. take() hands out an exclusive reader whose position matches the
 * range start (the sequential-read fast path); give() returns it for the next
 * contiguous range, evicting the oldest entry beyond the cap. disposeAll()
 * cancels everything - wired to the source's dispose.
 */
export interface ReaderPool {
    readonly disposed: boolean;
    take(pos: number): PositionedReader;
    give(entry: PositionedReader): void;
    discard(entry: PositionedReader): void;
    disposeAll(): void;
}

/** Creates an empty ReaderPool (one per source; standalone in tests). */
export function createReaderPool(): ReaderPool {
    const entries: PositionedReader[] = [];
    const active = new Set<PositionedReader>();
    let isDisposed = false;
    const drop = (entry: PositionedReader): void => {
        entry.reader?.cancel().catch(() => {});
        entry.reader = null;
        entry.leftover = null;
    };
    return {
        get disposed() {
            return isDisposed;
        },
        take(pos) {
            if (isDisposed) throw new DOMException("aborted", "AbortError");
            const idx = entries.findIndex((e) => e.pos === pos);
            const entry = idx < 0 ? { pos, reader: null, leftover: null } : entries.splice(idx, 1)[0]!;
            active.add(entry);
            return entry;
        },
        give(entry) {
            if (!active.delete(entry)) return;
            if (isDisposed) {
                drop(entry);
                return;
            }
            entries.push(entry);
            while (entries.length > MAX_POOLED_READERS) drop(entries.shift()!);
        },
        discard(entry) {
            active.delete(entry);
            drop(entry);
        },
        disposeAll() {
            isDisposed = true;
            for (const entry of active) drop(entry);
            active.clear();
            while (entries.length > 0) drop(entries.pop()!);
        },
    };
}

/**
 * Streams the byte range [start, end) of `blob`, continuing a pooled reader
 * when one sits at `start` and opening a tail slice otherwise. On a
 * source-read failure the dead reader is dropped, a backoff step waited out,
 * and a fresh tail slice picks up at the exact byte where delivery stopped.
 * The failure counter is consecutive (any delivered chunk resets it), so two
 * independent hiccups minutes apart both get the full retry budget. Non-read
 * errors and AbortError propagate immediately; a read error that survives
 * every retry is rethrown unchanged.
 */
export function createRetryingRangeStream(
    blob: Blob,
    pool: ReaderPool,
    start: number,
    end: number,
    signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
    let entry: PositionedReader | null = null;
    let consecutiveFailures = 0;
    let isCancelled = false;

    const checkAbort = (): void => {
        if (isCancelled || pool.disposed || signal?.aborted) throw new DOMException("aborted", "AbortError");
    };
    const discard = (): void => {
        if (entry) pool.discard(entry);
        entry = null;
    };

    // Serves up to (end - entry.pos) bytes from `bytes`, keeping the excess as
    // leftover for the next range. Returns the part to enqueue.
    const serve = (e: PositionedReader, bytes: Uint8Array): Uint8Array => {
        const want = end - e.pos;
        if (bytes.byteLength <= want) {
            e.pos += bytes.byteLength;
            e.leftover = null;
            return bytes;
        }
        const head = bytes.subarray(0, want);
        e.leftover = bytes.subarray(want);
        e.pos += want;
        return head;
    };

    const enqueue = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        e: PositionedReader,
        bytes: Uint8Array,
    ): void => {
        controller.enqueue(serve(e, bytes));
        consecutiveFailures = 0;
        if (e.pos >= end) {
            pool.give(e);
            entry = null;
            controller.close();
        }
    };

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                for (;;) {
                    checkAbort();
                    entry ??= pool.take(start);
                    const e = entry;
                    if (e.pos >= end) {
                        pool.give(e);
                        entry = null;
                        controller.close();
                        return;
                    }
                    if (e.leftover && e.leftover.byteLength > 0) {
                        enqueue(controller, e, e.leftover);
                        return;
                    }
                    try {
                        // Tail slice: outlives this range and keeps serving the next
                        // contiguous one via the pool.
                        e.reader ??= blob.slice(e.pos).stream().getReader();
                        const { done, value } = await e.reader.read();
                        checkAbort();
                        if (done) {
                            // EOF before `end` - the orchestrator never asks past the
                            // size it was given, so a shrunk blob is a real failure;
                            // closing early lets mediabunny raise its precise error.
                            discard();
                            controller.close();
                            return;
                        }
                        enqueue(controller, e, value);
                        return;
                    } catch (err) {
                        // The reader is poisoned after an error - the next attempt
                        // must re-slice from e.pos to get a fresh one.
                        e.reader?.cancel().catch(() => {});
                        e.reader = null;
                        await backoffOrRethrow(err, consecutiveFailures, e.pos, signal);
                        consecutiveFailures++;
                    }
                }
            } catch (err) {
                discard();
                throw err;
            }
        },
        cancel() {
            // A pending read must settle before another range can reuse its position.
            isCancelled = true;
            discard();
        },
    });
}

/**
 * Reads [start, end) in one arrayBuffer call, retrying with the same backoff
 * policy as the stream path. The WebKit read mode: Safari and everything on
 * iOS cannot stream large blobs reliably (WebKitBlobResource error 1, stalls
 * under backpressure, memory buildup - the bug set mediabunny #184 works
 * around the same way in BlobSource), so no long-lived readers there. A fresh
 * slice per attempt doubles as the retry mechanism.
 */
export async function readRangeWithRetry(
    blob: Blob,
    start: number,
    end: number,
    signal: AbortSignal | undefined,
): Promise<Uint8Array> {
    let consecutiveFailures = 0;
    for (;;) {
        throwIfCancelled(signal);
        try {
            const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
            throwIfCancelled(signal);
            return bytes;
        } catch (err) {
            await backoffOrRethrow(err, consecutiveFailures, start, signal);
            consecutiveFailures++;
        }
    }
}

/**
 * Drop-in replacement for `new BlobSource(file)` on the export read path:
 * a mediabunny CustomSource with the same cache size and prefetch profile as
 * BlobSource, whose range reads survive transient failures. Reads stream
 * through pooled tail readers (createRetryingRangeStream) except on WebKit,
 * which gets whole-range arrayBuffer reads (readRangeWithRetry) - the same
 * engine split BlobSource makes internally. `signal` (optional) aborts a
 * retry backoff mid-wait; pass the export's signal where one exists.
 */
export function createRetryingBlobSource(blob: Blob, signal?: AbortSignal): CustomSource {
    const pool = createReaderPool();
    const disposeController = new AbortController();
    const combined = combineAbortSignals(signal ? [signal, disposeController.signal] : [disposeController.signal]);
    const readSignal = combined.signal;
    readSignal.addEventListener("abort", () => pool.disposeAll(), { once: true });
    if (readSignal.aborted) pool.disposeAll();
    const avoidBlobStream = identifyBrowser().engine === "webkit";
    // A .ts file may need a patched view before mediabunny sees it (see
    // demuxView). getSize is guaranteed to run before read, so resolving the
    // view there routes every read through it.
    let readBlob = blob;
    let effectiveSize: Promise<number> | null = null;
    return new CustomSource({
        getSize: () =>
            (effectiveSize ??= demuxView(blob).then((view) => {
                readBlob = view;
                return view.size;
            })),
        read: (start, end) =>
            avoidBlobStream
                ? readRangeWithRetry(readBlob, start, end, readSignal)
                : createRetryingRangeStream(readBlob, pool, start, end, readSignal),
        dispose: () => {
            disposeController.abort();
            combined.dispose();
        },
        // Mirror BlobSource: 8 MiB cache is its default, fileSystem prefetch is
        // what it hard-codes for local reads.
        maxCacheSize: 8 * 2 ** 20,
        prefetchProfile: "fileSystem",
        handleUnhandledError: createBackgroundReadErrorHandler(blob, readSignal),
    });
}

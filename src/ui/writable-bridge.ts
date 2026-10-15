// Main-thread bridge for worker transcode. Instead of passing a FileSystemWritableFileStream to the
// worker (Chromium throws: writable is not serializable, and a handle from showSaveFilePicker loses
// its permission after structured-clone into a worker scope) or a transferable WritableStream (which
// stable Safari cannot postMessage - DataCloneError, WebKit #215485), the main thread keeps the real
// FSA writable and gives the worker one end of a MessageChannel. A MessagePort is transferable on
// every target browser.
//
// Backpressure lives on the worker side (port-writable.ts) via a credit window sized at
// PORT_WRITABLE_HWM chunks in flight before write() blocks - the same depth the old WritableStream
// highWaterMark=16 gave, without a per-chunk round trip. This side just applies each write to the real
// FSA writable in arrival order and acks it.

import { createLogger } from "../log.js";
import { closeWritableWithWatchdog } from "../export/writable-finalize.js";
import { servePortWritable } from "../workers/port-writable.js";

const log = createLogger("export-flow");

export interface WorkerWritableProxy {
    /** Transferable MessagePort - pass to the worker via the postMessage transfer list. */
    port: MessagePort;
    /**
     * Resolves when the worker's close / abort has been applied on this side. By default that is
     * after realWritable.close() finished - FSA atomic rename temp->final done, handle.getFile()
     * returns the final file. With `deferCommit` it means every write has been applied and the
     * output is still open: the caller may write into it and then runs `commit()`. The worker's
     * close() resolves at the same moment (it waits on the {k:"closed"} ack).
     */
    finalized: Promise<void>;
    /**
     * Deferred-commit mode only: runs the real close - flush + atomic rename - once the caller is
     * done writing into the still-open output (the GPMF post-process, see gpmd-inject.ts). Resolves
     * when the file is on disk; a failure aborts the output before rethrowing. No-op in default
     * mode, after a commit, or after an abort.
     */
    commit: () => Promise<void>;
    /**
     * Forced shutdown from the main side. Call when the worker was terminated, crashed, or aborted
     * before it could post close/abort over the port - in those cases the port goes silent and the
     * real writable would stay open (FSA temp-file in hidden state). forceAbort calls
     * realWritable.abort() and resolves finalized so the caller is not stuck waiting.
     */
    forceAbort: (reason: string) => Promise<void>;
    /**
     * The first failure the REAL writable threw, or null if it never did. The copy
     * that comes back through the worker is a plain Error rebuilt from wire data,
     * so it can no longer be tested with instanceof; the caller re-throws this
     * object instead to keep the export flow's error mapping working (a full disk,
     * a destination that went away).
     */
    sinkError: () => unknown;
}

/**
 * Creates a MessagePort bridge over a real FSA writable. The returned `port` is transferred to the
 * worker (see transcode-shim.ts); write/close/abort posted from the worker are applied to the real
 * writable here, in arrival order.
 *
 * Returns the port together with a finalized promise: the caller must await it before touching
 * handle.getFile() for post-processing (gpmd injection, etc.). Without this there is a race - the
 * worker's request resolves via its close ack, but the main-side close may not have finished the
 * atomic rename yet, so getFile returns a partial file and findMoovInFile cannot find moov.
 *
 * `onDiskCommit` (optional) brackets the final close: (true) when the opaque disk-commit flush
 * starts, (false) when it settles - the UI switches the progress bar to indeterminate for the
 * duration, same as the stream-copy path, so a minutes-long flush does not look like a hang.
 *
 * `deferCommit` keeps the real writable open when the worker closes its end: the caller writes
 * its post-process into the output (truncate + positional writes) and then calls `commit()`.
 * Without it the worker's close commits the file directly.
 */
export function createWorkerWritableProxy(
    realWritable: FileSystemWritableFileStream,
    onDiskCommit?: (on: boolean) => void,
    options: { deferCommit?: boolean } = {},
): WorkerWritableProxy {
    const channel = new MessageChannel();

    let resolveFinalized!: () => void;
    const finalized = new Promise<void>((resolve) => {
        resolveFinalized = resolve;
    });

    // Total bytes forwarded to the real sink, so the close watchdog can size its
    // deadline by output size (a multi-GB flush to slow media takes minutes).
    let bytesWritten = 0;
    // First raw failure from the real writable - see WorkerWritableProxy.sinkError.
    // First, not last: later throws are usually fallout from this one.
    let firstSinkError: unknown = null;
    // Deferred mode: the worker closed its end but the real writable is still
    // open, waiting for commit() (or forceAbort on failure).
    let isCommitPending = false;
    // Watchdog + breadcrumb around the real commit (this is where the re-encode export
    // historically hung at "Finalizing").
    const commitReal = async (): Promise<void> => {
        onDiskCommit?.(true);
        try {
            await closeWritableWithWatchdog(realWritable, log, "transcode-bridge", bytesWritten);
        } finally {
            onDiskCommit?.(false);
        }
    };
    const server = servePortWritable(channel.port1, {
        write: (chunk) => {
            // mediabunny StreamTarget({chunked}) posts {type,position,data}; count data bytes.
            const data = (chunk as { data?: { byteLength?: number } }).data;
            if (typeof data?.byteLength === "number") bytesWritten += data.byteLength;
            return realWritable.write(chunk as FileSystemWriteChunkType);
        },
        close: async () => {
            if (options.deferCommit) {
                isCommitPending = true;
                return;
            }
            await commitReal();
        },
        abort: (reason) => realWritable.abort(reason),
        onFinalized: resolveFinalized,
        onWriteError: (err) => {
            firstSinkError ??= err;
            log.warn("transcode bridge write failed", {
                err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            });
        },
    });

    return {
        port: channel.port2,
        finalized,
        commit: async () => {
            if (!isCommitPending) return;
            isCommitPending = false;
            try {
                await commitReal();
            } catch (err) {
                firstSinkError ??= err;
                try {
                    await realWritable.abort(err instanceof Error ? err.message : String(err));
                } catch {
                    // Already terminal.
                }
                throw err;
            }
        },
        forceAbort: async (reason) => {
            // The port server already ran its close handler, so its own abort is a
            // no-op; the still-open real writable is this side's to discard.
            if (isCommitPending) {
                isCommitPending = false;
                try {
                    await realWritable.abort(reason);
                } catch {
                    // Already terminal.
                }
            }
            await server.forceAbort(reason);
        },
        sinkError: () => firstSinkError,
    };
}

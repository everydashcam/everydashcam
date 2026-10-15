// Main-thread client over a Web Worker endpoint. Handles:
//  - request/response correlation by numeric id (counter, single-process - no
//    UUID needed);
//  - AbortSignal forwarding via WireAbort (worker side cancels its handler);
//  - error propagation with serialized Error (name + message + stack);
//  - push notifications from worker (worker → main events);
//  - structured worker-level error / messageerror with filename:lineno:colno
//    diagnostics (Firefox often delivers ev.message empty on module-load fail);
//    a script-load failure (plain Event, no ErrorEvent fields) is detected and
//    reported separately from a runtime crash;
//  - automatic installWorkerLogBridge so worker `createLogger("...")` entries
//    land in the main ring buffer (fixes the bug where frame-extract and
//    per-file-mse silently lost their logs);
//  - dispose() rejects pending requests so callers do not hang forever.
//
// The pool layer (worker-pool.ts) sits on top and handles lazy slot spawn,
// sharding, and crash respawn via the onCrash hook.

import { createLogger, installWorkerLogBridge } from "../../log.js";
import { captureSentryException } from "../../sentry.js";
import { workerUnavailableError } from "./worker-error.js";

import {
    type WireAbort,
    type WireNotification,
    type WireRequest,
    type WireResponse,
    deserializeError,
    isWireMessage,
} from "./wire.js";

const log = createLogger("worker-client");

/** Options that callers of `request` can pass per call. */
export interface RequestOptions {
    /**
     * Cancellation signal. When it fires we post WireAbort to the worker,
     * remove the pending entry, and reject the returned promise with a
     * DOMException("AbortError"). A late reply from a worker that ignored
     * the abort and finished anyway lands in handleResponse but finds no
     * matching pending entry, so it is dropped quietly - the caller has
     * already moved on and no longer wants the result.
     */
    signal?: AbortSignal;
    /**
     * Transferables for the request payload (ArrayBuffer, ImageBitmap,
     * MessagePort, WritableStream, ...). The structured-clone algorithm moves
     * ownership; after postMessage the main side must not touch them.
     */
    transfer?: Transferable[];
}

/** Options for a fire-and-forget notification. */
export interface NotifyOptions {
    transfer?: Transferable[];
}

/** Constructor options for createWorkerClient. */
export interface WorkerClientOptions {
    /**
     * Short name for logging only. Vite's worker-name option is set separately
     * via `new Worker(url, { name })` and is what shows up in DevTools.
     */
    name: string;
    /**
     * Handler for push events from the worker (worker → main, no id).
     * Optional - some shims only do request/response.
     */
    onNotification?: (msg: WireNotification) => void;
    /** Releases transferred resources in successful replies arriving after cancellation. */
    onDiscardedResult?: (result: unknown) => void;
    /**
     * Called when the worker fires an `error` event (uncaught exception in
     * worker scope, module-load failure). After onCrash returns the client
     * is in a poisoned state: all pending requests have been rejected, new
     * requests reject immediately. The pool uses this to swap in a fresh
     * worker for the slot.
     */
    onCrash?: (err: Error) => void;
    /** False when onCrash forwards even idle crashes into a recovery boundary
     * that owns reporting, such as playback's retry-or-fail decision. */
    reportIdleCrash?: boolean;
}

/** The handle returned by createWorkerClient. */
export interface WorkerClient {
    /**
     * Send a typed request, await the matching response. Throws (rejects)
     * with the worker-side Error (deserialized, preserves stack) or with
     * AbortError if the caller's signal fires before the response arrives.
     */
    request<TResult = unknown>(type: string, data?: unknown, opts?: RequestOptions): Promise<TResult>;
    /**
     * Push a fire-and-forget message to the worker. No reply expected.
     * Used for cancel-like operations (`dispose`, `tick`, `cancel`).
     */
    notify(type: string, data?: unknown, opts?: NotifyOptions): void;
    /**
     * Terminate the worker and reject all pending requests with the given
     * reason. Idempotent. After dispose() further request()/notify() reject
     * or no-op respectively.
     */
    dispose(reason?: string): void;
    /** True after dispose() or crash. */
    readonly disposed: boolean;
}

/**
 * Worker-like endpoint. We accept any object satisfying this shape so tests
 * can pass a mock without spinning up a real Worker.
 */
export interface WorkerEndpoint {
    postMessage(message: unknown, transfer?: Transferable[]): void;
    addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
    addEventListener(type: "messageerror", listener: (ev: MessageEvent) => void): void;
    addEventListener(type: "error", listener: (ev: ErrorEvent) => void): void;
    removeEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
    removeEventListener(type: "messageerror", listener: (ev: MessageEvent) => void): void;
    removeEventListener(type: "error", listener: (ev: ErrorEvent) => void): void;
    terminate(): void;
}

interface PendingEntry {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    signal: AbortSignal | undefined;
    abortListener: (() => void) | undefined;
}

/**
 * Wraps a Worker endpoint in a typed request/notify/dispose API.
 *
 * Counter-based ids: single-process counter is fine; collisions are not
 * possible within one client instance, and ids never leave the client.
 *
 * Order of installation inside the constructor matters - installWorkerLogBridge
 * goes first so a log message arriving during the very first tick still lands
 * in the ring buffer, even if the user's message handler had not been wired
 * yet.
 */
export function createWorkerClient(endpoint: WorkerEndpoint, opts: WorkerClientOptions): WorkerClient {
    const pending = new Map<number, PendingEntry>();
    let nextId = 1;
    let disposed = false;

    // Casts are needed because installWorkerLogBridge is typed for Worker, but
    // we accept any WorkerEndpoint shape. The bridge only uses addEventListener
    // which is present on every conforming endpoint.
    installWorkerLogBridge(endpoint as unknown as Worker);

    const handleMessage = (ev: MessageEvent): void => {
        const data = ev.data;
        if (!isWireMessage(data)) {
            // log-bridge messages (__type: __everydashcam:log) and any unknown
            // shape land here. The log bridge handles its own messages on a
            // separate listener; everything else is foreign noise we ignore
            // silently (would-be-warnings would flood with one entry per log).
            return;
        }
        if (data.__k === "res") {
            handleResponse(data);
        } else if (data.__k === "ntf") {
            if (opts.onNotification) {
                try {
                    opts.onNotification(data);
                } catch (err) {
                    log.warn("onNotification handler threw", { worker: opts.name, err: String(err) });
                }
            }
        }
        // "req" and "abort" are server-bound; if the worker is misconfigured
        // and emits them, we drop silently.
    };

    const handleResponse = (msg: WireResponse): void => {
        const entry = pending.get(msg.id);
        if (!entry) {
            // Cancellation can race a response already transferred by the worker.
            if (msg.ok && opts.onDiscardedResult) {
                try {
                    opts.onDiscardedResult(msg.result);
                } catch (err) {
                    log.warn("discarded result cleanup failed", {
                        worker: opts.name,
                        err: err instanceof Error ? err.message : String(err),
                    });
                }
            }
            return;
        }
        pending.delete(msg.id);
        detachAbort(entry);
        if (msg.ok) {
            entry.resolve(msg.result);
        } else {
            entry.reject(deserializeError(msg.error));
        }
    };

    const handleError = (ev: ErrorEvent): void => {
        // Two failure shapes arrive here (HTML spec "run a worker"):
        //  - a runtime uncaught exception fires an ErrorEvent - the fields are
        //    present but ev.message is often empty in Chromium and Firefox on
        //    top-level import failures, so filename/lineno/colno are the
        //    fallback diagnostics;
        //  - a failed fetch/parse of the worker script itself fires a PLAIN
        //    Event, so none of the ErrorEvent fields exist. Seen in production
        //    as a prewarmed worker dying right after page load (network blip,
        //    AV/proxy interception, extension) - distinguish it so triage does
        //    not start from "crashed (no message)" guessing.
        const fields = ev as Partial<ErrorEvent>;
        const isLoadFailure =
            fields.message === undefined && fields.filename === undefined && fields.error === undefined;
        const detail = isLoadFailure
            ? `${opts.name} script failed to load`
            : fields.message ||
              (fields.error instanceof Error ? fields.error.message : null) ||
              (fields.filename ? `${fields.filename}:${fields.lineno}:${fields.colno}` : null) ||
              `${opts.name} crashed (no message)`;
        const err = new Error(detail);
        // Preserve the original Error fields if the engine handed us one.
        if (fields.error instanceof Error) {
            err.name = fields.error.name;
            if (fields.error.stack) err.stack = fields.error.stack;
        }
        const crashKind = isLoadFailure ? "load-failure" : "error-event";
        // Key is `worker`, not `name`: the Sentry scrubber masks values under
        // *name*-keys (filename heuristic, sentry-scrub.ts FILENAME_KEY_RE),
        // and the worker id is diagnostic, not PII. Undefined fields are
        // omitted from the breadcrumb instead of stringifying to "undefined".
        log.warn("worker crashed", {
            worker: opts.name,
            kind: crashKind,
            message: fields.message,
            filename: fields.filename,
            lineno: fields.lineno,
            colno: fields.colno,
            err:
                fields.error === undefined
                    ? undefined
                    : fields.error instanceof Error
                      ? fields.error.message
                      : String(fields.error),
        });
        // Worker errors are Sentry's blind spot: they fire on the Worker object,
        // not window, so the main-thread SDK's global handlers never see them.
        // Capture ONLY when no request is in flight: a crash mid-request rejects
        // that request, which surfaces (and is captured) at the awaiting call
        // site (e.g. ingest top-level catch) - capturing here too would double-
        // report the same crash. An empty `pending` is otherwise a blind spot,
        // unless onCrash explicitly delegates reporting to a recovery boundary.
        if (pending.size === 0 && opts.reportIdleCrash !== false) {
            captureSentryException(err, {
                fingerprint: ["worker_crash", opts.name, isLoadFailure ? crashKind : "{{ default }}"],
                tags: { worker: opts.name, crash_kind: crashKind },
            });
        }
        crash(err);
    };

    const handleMessageError = (ev: MessageEvent): void => {
        // Some engines (older Firefox) report module-load failures via
        // `messageerror` rather than `error`. We surface it identically so
        // pending requests do not hang forever.
        log.warn("worker messageerror", { worker: opts.name, data: ev.data });
        const err = new Error(`${opts.name} messageerror`);
        // Same dedup rationale as handleError: only the no-in-flight-request
        // case is the blind spot worth capturing here.
        if (pending.size === 0 && opts.reportIdleCrash !== false) {
            captureSentryException(err, {
                fingerprint: ["worker_crash", opts.name, "messageerror"],
                tags: { worker: opts.name, crash_kind: "messageerror" },
            });
        }
        crash(err);
    };

    endpoint.addEventListener("message", handleMessage);
    endpoint.addEventListener("messageerror", handleMessageError);
    endpoint.addEventListener("error", handleError);

    function detachAbort(entry: PendingEntry): void {
        if (entry.signal && entry.abortListener) {
            entry.signal.removeEventListener("abort", entry.abortListener);
        }
    }

    function rejectAll(err: Error): void {
        for (const entry of pending.values()) {
            detachAbort(entry);
            entry.reject(err);
        }
        pending.clear();
    }

    function detachEndpointListeners(): void {
        endpoint.removeEventListener("message", handleMessage);
        endpoint.removeEventListener("messageerror", handleMessageError);
        endpoint.removeEventListener("error", handleError);
    }

    function crash(err: Error): void {
        if (disposed) return;
        disposed = true;
        rejectAll(workerUnavailableError(err));
        // Mirror dispose's teardown: real Worker objects GC away with their
        // listener registry after terminate(), but in tests with paired
        // endpoints the listeners would leak otherwise.
        detachEndpointListeners();
        try {
            endpoint.terminate();
        } catch {
            // Already terminated by the engine after the error event - ignore.
        }
        if (opts.onCrash) {
            try {
                opts.onCrash(err);
            } catch (cbErr) {
                log.warn("onCrash handler threw", { worker: opts.name, err: String(cbErr) });
            }
        }
    }

    return {
        request<TResult = unknown>(type: string, data?: unknown, reqOpts?: RequestOptions): Promise<TResult> {
            if (disposed) {
                return Promise.reject(new Error(`${opts.name} disposed`));
            }
            const signal = reqOpts?.signal;
            if (signal?.aborted) {
                return Promise.reject(new DOMException("aborted", "AbortError"));
            }
            const id = nextId++;
            return new Promise<TResult>((resolve, reject) => {
                const entry: PendingEntry = {
                    resolve: resolve as (value: unknown) => void,
                    reject,
                    signal,
                    abortListener: undefined,
                };
                if (signal) {
                    entry.abortListener = () => {
                        // Best-effort: tell the worker. Even if the worker is
                        // mid-CPU and does not react until the next await, the
                        // caller's promise rejects right now so UI does not
                        // block on the worker.
                        const abortMsg: WireAbort = { __k: "abort", id };
                        try {
                            endpoint.postMessage(abortMsg);
                        } catch {
                            // Endpoint already torn down - ignore.
                        }
                        const pendingEntry = pending.get(id);
                        if (pendingEntry) {
                            pending.delete(id);
                            detachAbort(pendingEntry);
                            reject(new DOMException("aborted", "AbortError"));
                        }
                    };
                    signal.addEventListener("abort", entry.abortListener, { once: true });
                }
                pending.set(id, entry);
                const req: WireRequest = { __k: "req", id, type, data };
                try {
                    endpoint.postMessage(req, reqOpts?.transfer ?? []);
                } catch (err) {
                    // postMessage throws on non-cloneable data (e.g. a closure
                    // inside `data` by mistake). Clean up and reject - we do
                    // not want a permanently-pending entry on a bug-shaped
                    // call.
                    pending.delete(id);
                    detachAbort(entry);
                    reject(err instanceof Error ? err : new Error(String(err)));
                }
            });
        },
        notify(type: string, data?: unknown, ntfOpts?: NotifyOptions): void {
            if (disposed) return;
            const msg: WireNotification = { __k: "ntf", type, data };
            try {
                endpoint.postMessage(msg, ntfOpts?.transfer ?? []);
            } catch (err) {
                log.warn("notify postMessage threw", { worker: opts.name, type, err: String(err) });
            }
        },
        dispose(reason?: string): void {
            if (disposed) return;
            disposed = true;
            const err = new Error(reason ?? `${opts.name} disposed`);
            err.name = "AbortError";
            rejectAll(err);
            detachEndpointListeners();
            try {
                endpoint.terminate();
            } catch {
                // ignore double terminate
            }
        },
        get disposed() {
            return disposed;
        },
    };
}

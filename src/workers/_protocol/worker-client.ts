// Worker lifetime around Comlink RPC: application cancellation, crashes and
// teardown settle callers immediately, independently of the remote operation.
import { expose, wrap, type Endpoint, type Remote } from "comlink";
import { createLogger, installWorkerLogBridge } from "../../log.js";
import { captureSentryException } from "../../sentry.js";
import { workerUnavailableError } from "./worker-error.js";
import {
    dispatchWorkerRequest,
    type WorkerContract,
    type WorkerMessage,
    type WorkerNotifier,
    type WorkerRequester,
    type WorkerRequestHandlers,
} from "./worker-contract.js";
import {
    closeTransferredResources,
    transferValue,
    type WorkerCallbacks,
    type WorkerNotification,
    type WorkerService,
} from "./worker-rpc.js";

const log = createLogger("worker-client");

export interface RequestOptions {
    signal?: AbortSignal;
    transfer?: Transferable[];
}
export interface NotifyOptions {
    transfer?: Transferable[];
}
export interface WorkerClientOptions {
    name: string;
    onNotification?: (message: WorkerNotification) => void;
    /** Reverse RPC, such as a worker requesting a map snapshot from the page. */
    onRequest?: (type: string, data: unknown) => unknown | Promise<unknown>;
    onDiscardedResult?: (result: unknown) => void;
    onCrash?: (error: Error) => void;
    reportIdleCrash?: boolean;
}
export interface WorkerClient {
    request<TResult = unknown>(type: string, data?: unknown, opts?: RequestOptions): Promise<TResult>;
    notify(type: string, data?: unknown, opts?: NotifyOptions): void;
    /** A string cancels intentional teardown; an Error preserves a shared failure. */
    dispose(reason?: string | Error): void;
    readonly disposed: boolean;
}

export interface TypedWorkerClient<Contract extends WorkerContract>
    extends Omit<WorkerClient, "request" | "notify">,
        WorkerRequester<Contract["requests"], RequestOptions>,
        WorkerNotifier<Contract["commands"], NotifyOptions> {}

export interface TypedWorkerClientOptions<Contract extends WorkerContract>
    extends Omit<WorkerClientOptions, "onRequest" | "onNotification" | "onDiscardedResult"> {
    onRequest?: WorkerRequestHandlers<Contract["callbacks"], void>;
    onNotification?: (message: WorkerMessage<Contract["events"]>) => void;
    onDiscardedResult?: (result: Contract["requests"][keyof Contract["requests"]]["result"]) => void;
}

/** Typed application facade over the same cancellation/crash-safe transport. */
export function createTypedWorkerClient<Contract extends WorkerContract>(
    endpoint: WorkerEndpoint,
    opts: TypedWorkerClientOptions<Contract>,
): TypedWorkerClient<Contract> {
    const { onRequest, onNotification, onDiscardedResult, ...options } = opts;
    const client = createWorkerClient(endpoint, {
        ...options,
        onRequest: onRequest && ((type, data) => dispatchWorkerRequest(onRequest, type, data, undefined)),
        // Comlink has deserialized values from our paired worker. Shape checks
        // for external inputs belong in the feature, not in this transport.
        onNotification: onNotification && ((message) => onNotification(message as WorkerMessage<Contract["events"]>)),
        onDiscardedResult:
            onDiscardedResult &&
            ((result) => onDiscardedResult(result as Contract["requests"][keyof Contract["requests"]]["result"])),
    });
    return client as unknown as TypedWorkerClient<Contract>;
}
export interface WorkerEndpoint {
    postMessage(message: unknown, transfer?: Transferable[]): void;
    addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
    addEventListener(type: "messageerror", listener: (event: MessageEvent) => void): void;
    addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
    removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
    removeEventListener(type: "messageerror", listener: (event: MessageEvent) => void): void;
    removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
    terminate(): void;
}
interface PendingRequest {
    reject(error: Error): void;
    detachAbort(): void;
}

export function createWorkerClient(endpoint: WorkerEndpoint, opts: WorkerClientOptions): WorkerClient {
    // These ids identify cancellable work on the server. Comlink owns response
    // correlation and error/transfer serialization.
    let nextOperation = 1;
    let disposed = false;
    const pending = new Map<number, PendingRequest>();
    const rpcListeners = new Map<EventListenerOrEventListenerObject, (event: MessageEvent) => void>();
    const rpcEndpoint: Endpoint = {
        postMessage(message, transfers) {
            if (disposed) closeTransferredResources(transfers);
            else endpoint.postMessage(message, transfers);
        },
        addEventListener(_type, listener) {
            const handle = (event: MessageEvent) =>
                typeof listener === "function" ? listener(event) : listener.handleEvent(event);
            rpcListeners.set(listener, handle);
            endpoint.addEventListener("message", handle);
        },
        removeEventListener(_type, listener) {
            const handle = rpcListeners.get(listener);
            if (handle) endpoint.removeEventListener("message", handle);
            rpcListeners.delete(listener);
        },
    };
    // The adapter matches the log bridge's message endpoint without requiring
    // a native Worker (portable builds and protocol tests supply equivalents).
    installWorkerLogBridge(endpoint as unknown as Worker);
    let remote: Remote<WorkerService> | null = wrap<WorkerService>(rpcEndpoint);
    const callbacks: WorkerCallbacks = {
        notify(type, data) {
            try {
                opts.onNotification?.({ type, data });
            } catch (error) {
                log.warn("onNotification handler threw", { worker: opts.name, err: String(error) });
            }
        },
        async request(type, data) {
            if (!opts.onRequest) throw new Error(`no reverse request handler for ${type}`);
            return opts.onRequest(type, data);
        },
    };
    expose(callbacks, rpcEndpoint);
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

    endpoint.addEventListener("messageerror", handleMessageError);
    endpoint.addEventListener("error", handleError);

    function rejectAll(error: Error): void {
        for (const entry of pending.values()) {
            entry.detachAbort();
            entry.reject(error);
        }
        pending.clear();
    }
    function teardown(): void {
        for (const listener of rpcListeners.values()) endpoint.removeEventListener("message", listener);
        rpcListeners.clear();
        endpoint.removeEventListener("messageerror", handleMessageError);
        endpoint.removeEventListener("error", handleError);
        // A terminated worker cannot acknowledge releaseProxy. Drop our proxy
        // and both owned Comlink listeners so outstanding calls can be collected.
        remote = null;
        try {
            endpoint.terminate();
        } catch {
            /* Already terminated by the engine. */
        }
    }
    function crash(error: Error): void {
        if (disposed) return;
        disposed = true;
        rejectAll(workerUnavailableError(error));
        teardown();
        try {
            opts.onCrash?.(error);
        } catch (cause) {
            log.warn("onCrash handler threw", { worker: opts.name, err: String(cause) });
        }
    }
    return {
        request<TResult>(type: string, data?: unknown, requestOptions?: RequestOptions): Promise<TResult> {
            if (disposed || !remote) return Promise.reject(new Error(`${opts.name} disposed`));
            const signal = requestOptions?.signal;
            if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
            const operation = nextOperation++;
            const service = remote;
            return new Promise<TResult>((resolve, reject) => {
                const onAbort = () => {
                    const entry = pending.get(operation);
                    if (!entry) return;
                    pending.delete(operation);
                    entry.detachAbort();
                    reject(new DOMException("aborted", "AbortError"));
                    void service.cancel(operation).catch(() => {});
                };
                const entry: PendingRequest = {
                    reject,
                    detachAbort: () => signal?.removeEventListener("abort", onAbort),
                };
                pending.set(operation, entry);
                signal?.addEventListener("abort", onAbort, { once: true });
                let resultPromise: Promise<unknown>;
                try {
                    resultPromise = service.run(operation, type, transferValue(data, requestOptions?.transfer));
                } catch (cause) {
                    pending.delete(operation);
                    entry.detachAbort();
                    reject(cause);
                    return;
                }
                void resultPromise.then(
                    (result) => {
                        if (!pending.delete(operation)) {
                            try {
                                opts.onDiscardedResult?.(result);
                            } catch (error) {
                                log.warn("discarded result cleanup failed", { worker: opts.name, err: String(error) });
                            }
                            return;
                        }
                        entry.detachAbort();
                        resolve(result as TResult);
                    },
                    (cause: unknown) => {
                        if (!pending.delete(operation)) return;
                        entry.detachAbort();
                        reject(cause);
                    },
                );
            });
        },
        notify(type, data, notifyOptions) {
            if (!remote) return;
            void remote.notify(type, transferValue(data, notifyOptions?.transfer)).catch((error: unknown) => {
                if (!disposed) log.warn("worker notification failed", { worker: opts.name, type, err: String(error) });
            });
        },
        dispose(reason) {
            if (disposed) return;
            disposed = true;
            rejectAll(
                reason instanceof Error ? reason : new DOMException(reason ?? `${opts.name} disposed`, "AbortError"),
            );
            teardown();
        },
        get disposed() {
            return disposed;
        },
    };
}

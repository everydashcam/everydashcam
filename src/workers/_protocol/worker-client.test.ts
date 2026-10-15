import { afterEach, describe, expect, it, vi } from "vitest";

import { _resetForTests } from "../../log.js";
import { captureSentryException } from "../../sentry.js";
import { makePairedEndpoints, flushMicrotasks } from "./test-helpers.js";
import { createWorkerClient } from "./worker-client.js";
import { isWorkerUnavailableError } from "./worker-error.js";
import { createWorkerServer } from "./worker-server.js";

// Spy on the Sentry capture so the crash-path tests can assert WHAT gets
// reported (fingerprint, tags) without a live SDK. Other exports stay real.
vi.mock("../../sentry.js", async (importOriginal) => {
    const orig = await importOriginal<typeof import("../../sentry.js")>();
    return { ...orig, captureSentryException: vi.fn() };
});

afterEach(() => {
    _resetForTests();
    vi.mocked(captureSentryException).mockClear();
});

describe("createWorkerClient + createWorkerServer", () => {
    it("distinguishes a worker crash from a request handler failure", async () => {
        const pair = makePairedEndpoints();
        const sourceError = new TypeError("invalid state");
        createWorkerServer(pair.workerEndpoint, {
            onRequest: (type) => {
                if (type === "invalid") throw sourceError;
                return new Promise<never>(() => undefined);
            },
        });
        const client = createWorkerClient(pair.mainEndpoint, { name: "failure-kind" });
        const handlerError = await client.request("invalid").catch((err: unknown) => err);
        expect(isWorkerUnavailableError(handlerError)).toBe(false);
        expect(handlerError).toMatchObject({ name: "TypeError", message: "invalid state" });
        const pending = client.request("hang").catch((err: unknown) => err);
        pair.fireMainError({ error: sourceError });
        const crashError = await pending;
        expect(isWorkerUnavailableError(crashError)).toBe(true);
        expect(crashError).toMatchObject({ message: "invalid state", cause: { name: "TypeError" } });
        expect(pair.terminated()).toBe(true);
    });

    it("round-trips a request and resolves with the handler's result", async () => {
        const { mainEndpoint, workerEndpoint } = makePairedEndpoints();
        createWorkerServer(workerEndpoint, {
            onRequest: async (type, data) => {
                expect(type).toBe("echo");
                return { received: data };
            },
        });
        const client = createWorkerClient(mainEndpoint, { name: "test-echo" });

        const result = await client.request("echo", { hello: "world" });
        expect(result).toEqual({ received: { hello: "world" } });
    });

    it("propagates a handler-thrown Error with name, message, and stack", async () => {
        const { mainEndpoint, workerEndpoint } = makePairedEndpoints();
        createWorkerServer(workerEndpoint, {
            onRequest: async () => {
                const e = new TypeError("bad input");
                e.stack = "test-stack\nat handler";
                throw e;
            },
        });
        const client = createWorkerClient(mainEndpoint, { name: "test-throw" });

        await expect(client.request("anything")).rejects.toMatchObject({
            name: "TypeError",
            message: "bad input",
            stack: "test-stack\nat handler",
        });
    });

    it("forwards AbortSignal: signal.abort() rejects the promise and posts WireAbort", async () => {
        const { mainEndpoint, workerEndpoint } = makePairedEndpoints();
        // Server has an onRequest that watches ctx.signal.
        let abortObservedInWorker = false;
        createWorkerServer(workerEndpoint, {
            onRequest: async (_type, _data, ctx) => {
                // Hang until aborted, then surface that the worker actually saw it.
                await new Promise<void>((_, reject) => {
                    ctx.signal.addEventListener("abort", () => {
                        abortObservedInWorker = true;
                        reject(new DOMException("aborted", "AbortError"));
                    });
                });
                return "never";
            },
        });
        const client = createWorkerClient(mainEndpoint, { name: "test-abort" });
        const ctrl = new AbortController();

        const p = client.request("hang", undefined, { signal: ctrl.signal });
        await flushMicrotasks();
        ctrl.abort();
        await expect(p).rejects.toMatchObject({ name: "AbortError" });
        // The worker handler also sees abort - this is the contract that lets
        // long-running handlers actually stop burning CPU, not just have main
        // pretend the call is gone.
        await flushMicrotasks();
        expect(abortObservedInWorker).toBe(true);
    });

    it("rejects immediately if the caller passes an already-aborted signal", async () => {
        const { mainEndpoint, workerEndpoint } = makePairedEndpoints();
        createWorkerServer(workerEndpoint, { onRequest: async () => "should not run" });
        const client = createWorkerClient(mainEndpoint, { name: "test-pre-abort" });
        const ctrl = new AbortController();
        ctrl.abort();
        await expect(client.request("x", undefined, { signal: ctrl.signal })).rejects.toMatchObject({
            name: "AbortError",
        });
    });

    it("delivers notifications from worker to onNotification", async () => {
        const { mainEndpoint, workerEndpoint } = makePairedEndpoints();
        const server = createWorkerServer(workerEndpoint, {});
        const onNotification = vi.fn();
        createWorkerClient(mainEndpoint, { name: "test-ntf", onNotification });

        server.notify("progress", { done: 1, total: 10 });
        server.notify("done");
        await flushMicrotasks();

        expect(onNotification).toHaveBeenCalledTimes(2);
        expect(onNotification).toHaveBeenNthCalledWith(1, {
            __k: "ntf",
            type: "progress",
            data: { done: 1, total: 10 },
        });
    });

    it("supports notify from main to worker", async () => {
        const { mainEndpoint, workerEndpoint } = makePairedEndpoints();
        const onNotification = vi.fn();
        createWorkerServer(workerEndpoint, { onNotification });
        const client = createWorkerClient(mainEndpoint, { name: "test-ntf-main" });

        client.notify("tick", { t: 100 });
        await flushMicrotasks();

        expect(onNotification).toHaveBeenCalledWith("tick", { t: 100 });
    });

    it("rejects pending requests on dispose()", async () => {
        const { mainEndpoint, workerEndpoint } = makePairedEndpoints();
        createWorkerServer(workerEndpoint, {
            onRequest: () => new Promise(() => undefined), // never resolves
        });
        const client = createWorkerClient(mainEndpoint, { name: "test-dispose" });
        const p = client.request("hang");
        await flushMicrotasks();
        client.dispose("test teardown");
        await expect(p).rejects.toMatchObject({ name: "AbortError", message: "test teardown" });
        expect(client.disposed).toBe(true);
    });

    it("crash via worker error event: rejects pending, fires onCrash, marks disposed", async () => {
        const { mainEndpoint, workerEndpoint, fireMainError, terminated } = makePairedEndpoints();
        createWorkerServer(workerEndpoint, { onRequest: () => new Promise(() => undefined) });
        const onCrash = vi.fn();
        const client = createWorkerClient(mainEndpoint, { name: "test-crash", onCrash });

        const p = client.request("hang");
        await flushMicrotasks();
        fireMainError({
            message: "",
            filename: "worker.js",
            lineno: 42,
            colno: 7,
            error: undefined,
        });

        await expect(p).rejects.toThrow(/worker\.js:42:7/);
        expect(onCrash).toHaveBeenCalledTimes(1);
        expect(client.disposed).toBe(true);
        expect(terminated()).toBe(true);
    });

    it("script-load failure (plain Event, no ErrorEvent fields) is reported as such", async () => {
        const { mainEndpoint, workerEndpoint, fireMainError, terminated } = makePairedEndpoints();
        createWorkerServer(workerEndpoint, { onRequest: () => new Promise(() => undefined) });
        const onCrash = vi.fn();
        const client = createWorkerClient(mainEndpoint, { name: "test-load-fail", onCrash });

        const p = client.request("hang");
        await flushMicrotasks();
        // A failed fetch of the worker script fires a plain Event per the HTML
        // spec - none of the ErrorEvent fields exist on it.
        fireMainError({});

        await expect(p).rejects.toThrow(/test-load-fail script failed to load/);
        expect(onCrash).toHaveBeenCalledTimes(1);
        expect(client.disposed).toBe(true);
        expect(terminated()).toBe(true);
        // A request was in flight, so the crash surfaces at the awaiting call
        // site - the direct Sentry capture must stay silent (no double-report).
        expect(captureSentryException).not.toHaveBeenCalled();
    });

    it("idle crash (no request in flight) is captured directly with diagnostic tags", async () => {
        const { mainEndpoint, workerEndpoint, fireMainError } = makePairedEndpoints();
        createWorkerServer(workerEndpoint, {});
        createWorkerClient(mainEndpoint, { name: "test-idle-crash" });

        // Prewarm scenario: the worker dies before any request was sent.
        // Nothing downstream observes this, so the client captures directly.
        fireMainError({});

        expect(captureSentryException).toHaveBeenCalledTimes(1);
        const [err, ctx] = vi.mocked(captureSentryException).mock.calls[0]!;
        expect(err).toMatchObject({ message: "test-idle-crash script failed to load" });
        expect(ctx).toEqual({
            fingerprint: ["worker_crash", "test-idle-crash", "load-failure"],
            // `worker`, not `worker_name`: *name*-keys are masked to "***" by
            // the scrubber, which would erase the one tag this exists for.
            tags: { worker: "test-idle-crash", crash_kind: "load-failure" },
        });
    });

    it("messageerror also triggers crash with diagnostics", async () => {
        const { mainEndpoint, workerEndpoint, fireMainMessageError, terminated } = makePairedEndpoints();
        createWorkerServer(workerEndpoint, { onRequest: () => new Promise(() => undefined) });
        const onCrash = vi.fn();
        const client = createWorkerClient(mainEndpoint, { name: "test-msgerror", onCrash });

        const p = client.request("hang");
        await flushMicrotasks();
        fireMainMessageError({ junk: true });

        await expect(p).rejects.toThrow(/messageerror/);
        expect(onCrash).toHaveBeenCalledTimes(1);
        expect(terminated()).toBe(true);
    });

    it.each(["error", "messageerror"] as const)(
        "leaves an idle %s to a caller that owns recovery and reporting",
        (event) => {
            const pair = makePairedEndpoints();
            const onCrash = vi.fn();
            const client = createWorkerClient(pair.mainEndpoint, {
                name: "playback",
                reportIdleCrash: false,
                onCrash,
            });
            if (event === "error") pair.fireMainError({});
            else pair.fireMainMessageError({});

            expect(onCrash).toHaveBeenCalledTimes(1);
            expect(client.disposed).toBe(true);
            expect(pair.terminated()).toBe(true);
            expect(captureSentryException).not.toHaveBeenCalled();
        },
    );

    it("keeps stack-based grouping for idle runtime exceptions", () => {
        const pair = makePairedEndpoints();
        createWorkerClient(pair.mainEndpoint, { name: "runtime" });
        const error = new TypeError("invalid state");
        pair.fireMainError({ error });

        expect(captureSentryException).toHaveBeenCalledWith(
            expect.objectContaining({ name: "TypeError", stack: error.stack }),
            expect.objectContaining({ fingerprint: ["worker_crash", "runtime", "{{ default }}"] }),
        );
    });

    it("multiple concurrent requests stay correlated by id", async () => {
        const { mainEndpoint, workerEndpoint } = makePairedEndpoints();
        const replies = new Map<number, (result: number) => void>();
        createWorkerServer(workerEndpoint, {
            onRequest: (_type, data) => new Promise<number>((resolve) => replies.set(data as number, resolve)),
        });
        const client = createWorkerClient(mainEndpoint, { name: "test-concurrent" });
        const requests = [
            client.request<number>("double", 1),
            client.request<number>("double", 2),
            client.request<number>("double", 3),
        ];
        await flushMicrotasks();
        // Resolve in reverse order to prove correlation by id, not by FIFO.
        for (const n of [3, 2, 1]) replies.get(n)!(n * 2);
        expect(await Promise.all(requests)).toEqual([2, 4, 6]);
    });

    it("rejects new requests after dispose with a clear error", async () => {
        const { mainEndpoint, workerEndpoint } = makePairedEndpoints();
        createWorkerServer(workerEndpoint, { onRequest: async () => "ok" });
        const client = createWorkerClient(mainEndpoint, { name: "test-post-dispose" });
        client.dispose();
        await expect(client.request("x")).rejects.toThrow(/disposed/);
    });

    // listenerCounts asserts: createWorkerClient subscribes a handleMessage
    // listener; dispose() must unsubscribe it. We compare counts before-create
    // vs after-dispose - they must match (zero leaked subscriptions).
    // installWorkerLogBridge subscribes another, never-removed listener; its
    // presence shows up as a +1 baseline that we account for explicitly.
    it("dispose unsubscribes the framework message listener (no endpoint leak)", async () => {
        const { mainEndpoint, workerEndpoint, listenerCounts } = makePairedEndpoints();
        createWorkerServer(workerEndpoint, { onRequest: async () => "ok" });
        const beforeCreate = listenerCounts().mainMessage;
        const client = createWorkerClient(mainEndpoint, { name: "test-listener-cleanup" });
        // Right after create: framework handleMessage + log bridge = +2.
        expect(listenerCounts().mainMessage).toBe(beforeCreate + 2);
        await client.request("ping");
        client.dispose();
        // After dispose: handleMessage removed, log bridge stays (it has no
        // disposal path - that is a documented limitation, not a leak per
        // request).
        expect(listenerCounts().mainMessage).toBe(beforeCreate + 1);
    });

    it("crash unsubscribes the framework message listener", async () => {
        const { mainEndpoint, workerEndpoint, listenerCounts, fireMainError } = makePairedEndpoints();
        createWorkerServer(workerEndpoint, { onRequest: () => new Promise(() => undefined) });
        const beforeCreate = listenerCounts().mainMessage;
        const client = createWorkerClient(mainEndpoint, { name: "test-crash-listener-cleanup" });
        const p = client.request("hang");
        await flushMicrotasks();
        fireMainError({ message: "boom", filename: "w.js", lineno: 1, colno: 1 });
        await expect(p).rejects.toBeDefined();
        // Crash internally calls the same teardown path as dispose: handleMessage
        // is removed, log bridge stays.
        expect(listenerCounts().mainMessage).toBe(beforeCreate + 1);
        expect(client.disposed).toBe(true);
    });

    it("late successful reply after abort is dropped quietly", async () => {
        const { mainEndpoint, workerEndpoint } = makePairedEndpoints();
        // Handler ignores the abort signal and resolves anyway later. The
        // late reply lands in handleResponse on main, finds no pending entry,
        // drops silently - no unhandled rejection, no double-resolve.
        let resolveHandler: (v: string) => void = () => undefined;
        let handlerInvocations = 0;
        createWorkerServer(workerEndpoint, {
            onRequest: async () => {
                handlerInvocations++;
                return await new Promise<string>((r) => {
                    resolveHandler = r;
                });
            },
        });
        const client = createWorkerClient(mainEndpoint, { name: "test-late-reply" });
        const ctrl = new AbortController();
        const p = client.request("hang", undefined, { signal: ctrl.signal });
        await flushMicrotasks();
        expect(handlerInvocations).toBe(1);
        ctrl.abort();
        await expect(p).rejects.toMatchObject({ name: "AbortError" });

        // Resolve the handler AFTER abort. The reply round-trips back to main
        // and must be dropped without throwing or reviving the rejected
        // promise.
        resolveHandler("late");
        await flushMicrotasks();
        // The client is still functional - no poisoning from the dropped reply.
        expect(client.disposed).toBe(false);
    });

    it("releases late transferred results while keeping delivered results owned by the caller", async () => {
        const { mainEndpoint, workerEndpoint } = makePairedEndpoints();
        const close = vi.fn();
        const lateResult = { bitmaps: [{ close }] };
        let release: (() => void) | undefined;
        createWorkerServer(workerEndpoint, {
            onRequest: async (type) => {
                if (type === "late") {
                    await new Promise<void>((resolve) => {
                        release = resolve;
                    });
                }
                return lateResult;
            },
        });
        const onDiscardedResult = vi.fn((result) => {
            expect(result).toBe(lateResult);
            close();
        });
        const client = createWorkerClient(mainEndpoint, { name: "late-resource", onDiscardedResult });
        const controller = new AbortController();
        const pending = client.request("late", undefined, { signal: controller.signal });
        await flushMicrotasks();
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        release!();
        // A round trip drains the earlier response through the actual client/server path.
        await expect(client.request("fresh")).resolves.toBe(lateResult);
        expect(onDiscardedResult).toHaveBeenCalledExactlyOnceWith(lateResult);
        expect(close).toHaveBeenCalledOnce();
        client.dispose();
    });

    it("postMessage throwing on non-cloneable data cleans up and rejects", async () => {
        const { mainEndpoint, workerEndpoint } = makePairedEndpoints();
        createWorkerServer(workerEndpoint, { onRequest: async () => "ok" });
        const client = createWorkerClient(mainEndpoint, { name: "test-clone-fail" });
        // Wrap postMessage to throw on the first call (the test request).
        const origPostMessage = mainEndpoint.postMessage.bind(mainEndpoint);
        let firstCall = true;
        mainEndpoint.postMessage = (msg: unknown, transfer?: Transferable[]) => {
            if (firstCall) {
                firstCall = false;
                throw new DOMException("could not be cloned", "DataCloneError");
            }
            return origPostMessage(msg, transfer);
        };
        await expect(client.request("x", { circular: undefined })).rejects.toMatchObject({
            name: "DataCloneError",
        });
        // Second request goes through (postMessage works again on second call).
        await expect(client.request("y")).resolves.toBe("ok");
    });

    it("onCrash handler that itself throws does not break the crash path", async () => {
        const { mainEndpoint, workerEndpoint, fireMainError } = makePairedEndpoints();
        createWorkerServer(workerEndpoint, { onRequest: () => new Promise(() => undefined) });
        const onCrash = vi.fn(() => {
            throw new Error("onCrash threw");
        });
        const client = createWorkerClient(mainEndpoint, { name: "test-crash-throw", onCrash });
        const p = client.request("hang");
        await flushMicrotasks();
        // Crash with a throwing handler - the framework must not propagate.
        expect(() => fireMainError({ message: "boom", filename: "x", lineno: 1, colno: 1 })).not.toThrow();
        await expect(p).rejects.toBeDefined();
        expect(onCrash).toHaveBeenCalledTimes(1);
        expect(client.disposed).toBe(true);
    });

    it("server replies with an error when onRequest is not configured", async () => {
        const { mainEndpoint, workerEndpoint } = makePairedEndpoints();
        // Server with no onRequest - any incoming request must be rejected,
        // not hang the caller.
        createWorkerServer(workerEndpoint, {});
        const client = createWorkerClient(mainEndpoint, { name: "test-no-handler" });
        await expect(client.request("anything")).rejects.toMatchObject({
            message: expect.stringMatching(/no onRequest handler/),
        });
    });

    it("aborting the same request twice is idempotent", async () => {
        const { mainEndpoint, workerEndpoint } = makePairedEndpoints();
        createWorkerServer(workerEndpoint, {
            onRequest: () => new Promise(() => undefined),
        });
        const client = createWorkerClient(mainEndpoint, { name: "test-double-abort" });
        const ctrl = new AbortController();
        const p = client.request("hang", undefined, { signal: ctrl.signal });
        await flushMicrotasks();
        ctrl.abort();
        // Second abort on the same signal is a no-op per DOM spec.
        ctrl.abort();
        await expect(p).rejects.toMatchObject({ name: "AbortError" });
        // Client is still healthy.
        expect(client.disposed).toBe(false);
    });

    it("aborted request removes its signal listener (no signal-listener leak across many requests)", async () => {
        const { mainEndpoint, workerEndpoint } = makePairedEndpoints();
        createWorkerServer(workerEndpoint, {
            onRequest: () => new Promise(() => undefined),
        });
        const client = createWorkerClient(mainEndpoint, { name: "test-signal-listener" });
        // Wrap addEventListener / removeEventListener to count abort listeners
        // on this specific signal. The browser auto-removes once:true listeners
        // on fire without calling removeEventListener - tracking that via a
        // wrap-after-fire counter on the user listener would complicate the
        // helper; instead we test the non-fire path (resolve / pre-fire reject)
        // which DOES go through removeEventListener.
        const ctrl = new AbortController();
        let abortAdds = 0;
        let abortRemoves = 0;
        const origAdd = ctrl.signal.addEventListener.bind(ctrl.signal);
        const origRemove = ctrl.signal.removeEventListener.bind(ctrl.signal);
        ctrl.signal.addEventListener = ((
            type: string,
            listener: EventListenerOrEventListenerObject | null,
            options?: AddEventListenerOptions | boolean,
        ) => {
            if (type === "abort") abortAdds++;
            // DOM spec accepts null listener (silently ignored); TS overloads
            // model it as non-null only, so cast through unknown.
            return origAdd(type as "abort", listener as EventListenerOrEventListenerObject, options);
        }) as typeof ctrl.signal.addEventListener;
        ctrl.signal.removeEventListener = ((
            type: string,
            listener: EventListenerOrEventListenerObject | null,
            options?: EventListenerOptions | boolean,
        ) => {
            if (type === "abort") abortRemoves++;
            return origRemove(type as "abort", listener as EventListenerOrEventListenerObject, options);
        }) as typeof ctrl.signal.removeEventListener;

        // Send N requests, resolve them all via dispose - this exits via the
        // rejectAll path which calls detachAbort on every pending entry.
        const promises: Promise<unknown>[] = [];
        for (let i = 0; i < 5; i++) {
            promises.push(client.request("hang", undefined, { signal: ctrl.signal }).catch(() => undefined));
        }
        await flushMicrotasks();
        expect(abortAdds).toBe(5);
        expect(abortRemoves).toBe(0);

        client.dispose();
        await Promise.all(promises);
        // detachAbort runs in rejectAll for every pending entry on dispose.
        expect(abortRemoves).toBe(5);
    });
});

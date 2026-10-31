import { transfer } from "comlink";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createTypedWorkerClient, type TypedWorkerClient, type WorkerEndpoint } from "./worker-client.js";
import type { WorkerContract, WorkerMessage, WorkerRequest, WorkerRequestHandlers } from "./worker-contract.js";
import { createTypedWorkerPool, type TypedWorkerPool } from "./worker-pool.js";
import { createTypedWorkerServer, type TypedWorkerServer } from "./worker-server.js";
import { flushMicrotasks, makePairedEndpoints } from "./test-helpers.js";

type Contract = WorkerContract<
    {
        double: WorkerRequest<{ value: number }, number>;
        bytes: WorkerRequest<Uint8Array, Uint8Array>;
    },
    { reset: undefined; set: { value: number } },
    { progress: { value: number }; ready: undefined },
    { render: WorkerRequest<{ value: number }, Uint8Array> }
>;

// tsc checks invalid operation/payload/result combinations even though this
// function is never run. Vitest alone does not typecheck @ts-expect-error.
function typeAssertions(
    client: TypedWorkerClient<Contract>,
    server: TypedWorkerServer<Contract>,
    pool: TypedWorkerPool<Contract>,
    message: WorkerMessage<Contract["events"]>,
    requestType: "double" | "bytes",
    commandType: "reset" | "set",
): void {
    expectTypeOf(client.request("double", { value: 2 })).toEqualTypeOf<Promise<number>>();
    expectTypeOf(pool.request("bytes", new Uint8Array())).toEqualTypeOf<Promise<Uint8Array>>();
    expectTypeOf(server.request("render", { value: 2 })).toEqualTypeOf<Promise<Uint8Array>>();
    client.notify("reset");
    pool.notifyAll("set", { value: 2 });
    if (message.type === "progress") expectTypeOf(message.data.value).toEqualTypeOf<number>();
    // @ts-expect-error Unknown operation names cannot cross the application boundary.
    void client.request("missing", { value: 2 });
    // @ts-expect-error Result types are selected by the operation, never by the caller.
    void client.request<string>("double", { value: 2 });
    // @ts-expect-error A payload for a different operation must be rejected.
    void client.request("bytes", { value: 2 });
    // @ts-expect-error Required payloads cannot be omitted.
    client.notify("set");
    // @ts-expect-error Request/command directions cannot be mixed.
    client.notify("progress", { value: 2 });
    // @ts-expect-error Pool requests must preserve the same correlation.
    void pool.request("double", new Uint8Array());
    // @ts-expect-error Reverse callbacks also have typed payloads.
    void server.request("render", { value: "2" });
    // @ts-expect-error Union operation names need a correspondingly narrowed payload.
    void client.request(requestType, { value: 2 });
    // @ts-expect-error A union containing a payload-bearing command cannot omit data.
    client.notify(commandType);
    const handlers: WorkerRequestHandlers<Contract["requests"], void> = {
        // @ts-expect-error A server cannot return a mismatched result.
        double: ({ value }) => String(value),
        bytes: (data) => data,
    };
    // @ts-expect-error Every declared request needs a handler.
    const missing: WorkerRequestHandlers<Contract["requests"], void> = { double: ({ value }) => value * 2 };
    const extra: WorkerRequestHandlers<Contract["requests"], void> = {
        double: ({ value }) => value * 2,
        bytes: (data) => data,
        // @ts-expect-error Handler keys must be declared in the shared protocol.
        missing: () => 1,
    };
    void handlers;
    void missing;
    void extra;
}
void typeAssertions;

describe("typed worker contracts", () => {
    it("preserves transfers and reverse calls over a real MessageChannel", async () => {
        const { port1, port2 } = new MessageChannel();
        const endpoint: WorkerEndpoint = {
            postMessage: port1.postMessage.bind(port1),
            addEventListener: port1.addEventListener.bind(port1),
            removeEventListener: port1.removeEventListener.bind(port1),
            terminate() {
                port1.close();
                port2.close();
            },
        };
        port1.start();
        const source = new Uint8Array([3]);
        const response = new Uint8Array([6]);
        const notifications: WorkerMessage<Contract["events"]>[] = [];
        const server: TypedWorkerServer<Contract> = createTypedWorkerServer<Contract>(port2, {
            onRequest: {
                double: ({ value }) => value * 2,
                bytes: async (data, ctx) => {
                    const result = await server.request("render", { value: data[0]! });
                    server.notify("progress", { value: result[0]! });
                    ctx.transfer([result.buffer as ArrayBuffer]);
                    return result;
                },
            },
        });
        const client = createTypedWorkerClient<Contract>(endpoint, {
            name: "typed-transfers",
            onRequest: {
                render: ({ value }) => {
                    expect(value).toBe(3);
                    return transfer(response, [response.buffer]);
                },
            },
            onNotification: (message) => notifications.push(message),
        });
        try {
            expect(await client.request("bytes", source, { transfer: [source.buffer] })).toEqual(new Uint8Array([6]));
            expect(source.byteLength).toBe(0);
            expect(response.byteLength).toBe(0);
            expect(notifications).toEqual([{ type: "progress", data: { value: 6 } }]);
        } finally {
            client.dispose();
        }
    });

    it("keeps commands and request results typed through the pool", async () => {
        let value = 0;
        const pool = createTypedWorkerPool<Contract>({
            name: "typed-pool",
            capacity: 1,
            factory: (_idx, options) => {
                const pair = makePairedEndpoints();
                createTypedWorkerServer<Contract>(pair.workerEndpoint, {
                    onRequest: {
                        double: (data) => data.value * 2 + value,
                        bytes: (data) => data,
                    },
                    onNotification: {
                        set: (data) => {
                            value = data.value;
                        },
                        reset: () => {
                            value = 0;
                        },
                    },
                });
                return createTypedWorkerClient<Contract>(pair.mainEndpoint, { name: "typed-slot", ...options });
            },
        });
        try {
            pool.notify("set", { value: 10 });
            await expect(pool.request("double", { value: 2 })).resolves.toBe(14);
            pool.notifyAll("reset");
            await expect(pool.request("double", { value: 2 })).resolves.toBe(4);
        } finally {
            pool.disposeAll();
        }
    });

    it("forwards cancellation and disposes late results through the typed facade", async () => {
        const pair = makePairedEndpoints();
        let resolve!: (value: Uint8Array) => void;
        let signal: AbortSignal | undefined;
        createTypedWorkerServer<Contract>(pair.workerEndpoint, {
            onRequest: {
                double: ({ value }) => value * 2,
                bytes: (_data, ctx) => {
                    signal = ctx.signal;
                    return new Promise((done) => {
                        resolve = done;
                    });
                },
            },
        });
        const onDiscardedResult = vi.fn();
        const client = createTypedWorkerClient<Contract>(pair.mainEndpoint, { name: "typed-abort", onDiscardedResult });
        try {
            const controller = new AbortController();
            const pending = client.request("bytes", new Uint8Array(), { signal: controller.signal });
            await flushMicrotasks();
            controller.abort();
            await expect(pending).rejects.toMatchObject({ name: "AbortError" });
            await flushMicrotasks();
            expect(signal?.aborted).toBe(true);
            const late = new Uint8Array([1]);
            resolve(late);
            await flushMicrotasks();
            expect(onDiscardedResult).toHaveBeenCalledWith(late);
        } finally {
            client.dispose();
        }
    });
});

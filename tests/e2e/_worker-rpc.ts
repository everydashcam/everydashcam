import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import type { WorkerCallbacks, WorkerService } from "../../src/workers/_protocol/worker-rpc.js";

interface BrowserRpcClient {
    request<T>(type: string, data?: unknown): Promise<T>;
    dispose(): void;
}
interface InterceptedWorker {
    name: string;
    notify(type: string, data: unknown): Promise<void>;
    crash(): void;
}
type RequestHandler = (
    type: string,
    data: unknown,
    forward: () => Promise<unknown>,
    kind: "request" | "notification",
) => unknown | Promise<unknown>;
interface WorkerRpcHarness {
    connect(worker: Worker): BrowserRpcClient;
    intercept(names: string[], setup: (worker: InterceptedWorker) => RequestHandler): void;
}

declare global {
    interface Window {
        Comlink: typeof import("comlink");
        __workerRpc: WorkerRpcHarness;
    }
}

// Browser tests use the same RPC library as the app, without inspecting its wire
// format. A paired MessageChannel lets a test replace or delay domain operations.
function installRuntime(): void {
    if (window.__workerRpc) return;
    const { expose, wrap } = window.Comlink;
    window.__workerRpc = {
        connect(worker) {
            const remote = wrap<WorkerService>(worker);
            expose(
                {
                    notify() {},
                    request() {
                        throw new Error("unexpected reverse request");
                    },
                },
                worker,
            );
            const pending = new Set<(error: Error) => void>();
            let operation = 0;
            let disposed = false;
            const fail = (error: Error): void => {
                for (const reject of pending) reject(error);
                pending.clear();
            };
            const onError = (event: ErrorEvent) => fail(new Error(event.message || "worker failed"));
            const onMessageError = () => fail(new Error("worker message could not be decoded"));
            worker.addEventListener("error", onError);
            worker.addEventListener("messageerror", onMessageError);
            return {
                request<T>(type: string, data?: unknown): Promise<T> {
                    if (disposed) return Promise.reject(new Error("worker disposed"));
                    return new Promise<T>((resolve, reject) => {
                        pending.add(reject);
                        void remote.run(++operation, type, data).then(
                            (result) => {
                                pending.delete(reject);
                                resolve(result as T);
                            },
                            (error: unknown) => {
                                pending.delete(reject);
                                reject(error);
                            },
                        );
                    });
                },
                dispose() {
                    if (disposed) return;
                    disposed = true;
                    fail(new DOMException("worker disposed", "AbortError"));
                    worker.removeEventListener("error", onError);
                    worker.removeEventListener("messageerror", onMessageError);
                    remote[window.Comlink.releaseProxy]();
                    worker.terminate();
                },
            };
        },
        intercept(names, setup) {
            const NativeWorker = window.Worker;
            window.Worker = new Proxy(NativeWorker, {
                construct(_target, args: [string | URL, WorkerOptions?]) {
                    const [url, options] = args;
                    const real = new NativeWorker(url, options);
                    const name = options?.name ?? "unnamed";
                    if (!names.includes(name)) return real;
                    const { port1, port2 } = new MessageChannel();
                    const facade = new EventTarget() as Worker;
                    const remote = wrap<WorkerService>(real);
                    const page = wrap<WorkerCallbacks>(port2);
                    let terminated = false;
                    port1.onmessage = (event) =>
                        facade.dispatchEvent(
                            new MessageEvent("message", {
                                data: event.data,
                                ports: [...event.ports],
                            }),
                        );
                    facade.postMessage = (
                        message: unknown,
                        transfers?: Transferable[] | StructuredSerializeOptions,
                    ) => {
                        if (!terminated)
                            port1.postMessage(
                                message,
                                Array.isArray(transfers) ? transfers : (transfers?.transfer ?? []),
                            );
                    };
                    facade.terminate = () => {
                        terminated = true;
                        remote[window.Comlink.releaseProxy]();
                        page[window.Comlink.releaseProxy]();
                        port1.close();
                        port2.close();
                        real.terminate();
                    };
                    real.addEventListener("error", (event) =>
                        facade.dispatchEvent(
                            new ErrorEvent("error", {
                                message: event.message,
                                filename: event.filename,
                                lineno: event.lineno,
                                error: event.error,
                            }),
                        ),
                    );
                    real.addEventListener("messageerror", () => facade.dispatchEvent(new MessageEvent("messageerror")));
                    const handler = setup({
                        name,
                        notify: async (type, data) => {
                            if (!terminated) await page.notify(type, data);
                        },
                        crash: () => {
                            facade.dispatchEvent(new Event("error"));
                        },
                    });
                    const callbacks: WorkerCallbacks = {
                        notify: (type, data) => {
                            if (!terminated) void page.notify(type, data);
                        },
                        request: (type, data) => page.request(type, data),
                    };
                    expose(callbacks, real);
                    const service: WorkerService = {
                        run: async (operation, type, data) =>
                            handler(type, data, () => remote.run(operation, type, data), "request"),
                        cancel: (operation) => {
                            void remote.cancel(operation);
                        },
                        notify: (type, data) => {
                            void handler(type, data, () => remote.notify(type, data), "notification");
                        },
                    };
                    expose(service, port2);
                    return facade;
                },
            });
        },
    };
}

const comlink = readFileSync(new URL("../../node_modules/comlink/dist/umd/comlink.js", import.meta.url), "utf8");

export async function installWorkerRpc<T = undefined>(page: Page, setup?: (arg: T) => void, arg?: T): Promise<void> {
    const runtime = `if (!window.__workerRpc) { ${comlink}\n(${installRuntime.toString()})(); }`;
    const content = `${runtime}\n${setup ? `(${setup.toString()})(${JSON.stringify(arg)});` : ""}`;
    await page.addInitScript({ content });
    // Direct probes can install after navigation; intercepted app operations
    // initialize with the next document so setup can use that origin's storage.
    if (!setup) await page.evaluate(runtime);
}

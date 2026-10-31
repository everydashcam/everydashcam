// Comlink RPC endpoint for computation workers. Handlers run concurrently;
// decoder/session serialization and stream backpressure belong to each worker.
import { expose, wrap, type Endpoint } from "comlink";
import { createLogger } from "../../log.js";
import { transferValue, type WorkerCallbacks, type WorkerService } from "./worker-rpc.js";
import {
    dispatchWorkerNotification,
    dispatchWorkerRequest,
    type WorkerContract,
    type WorkerNotificationHandlers,
    type WorkerNotifier,
    type WorkerRequester,
    type WorkerRequestHandlers,
} from "./worker-contract.js";

const log = createLogger("worker-server");

export interface RequestContext {
    signal: AbortSignal;
    transfer(items: Transferable[]): void;
}
export interface WorkerServerOptions {
    onRequest?: (type: string, data: unknown, context: RequestContext) => unknown | Promise<unknown>;
    onNotification?: (type: string, data: unknown) => void;
}
export type WorkerScopeEndpoint = Endpoint;
export interface WorkerServer {
    notify(type: string, data?: unknown, transfers?: Transferable[]): void;
    request<TResult = unknown>(type: string, data?: unknown, transfers?: Transferable[]): Promise<TResult>;
}

export interface TypedWorkerServer<Contract extends WorkerContract>
    extends WorkerNotifier<Contract["events"], Transferable[]>,
        WorkerRequester<Contract["callbacks"], Transferable[]> {}

export interface TypedWorkerServerOptions<Contract extends WorkerContract> {
    onRequest: WorkerRequestHandlers<Contract["requests"], RequestContext>;
    onNotification?: WorkerNotificationHandlers<Contract["commands"]>;
}

export function createTypedWorkerServer<Contract extends WorkerContract>(
    endpoint: WorkerScopeEndpoint,
    opts: TypedWorkerServerOptions<Contract>,
): TypedWorkerServer<Contract> {
    const notifications = opts.onNotification;
    return createWorkerServer(endpoint, {
        onRequest: (type, data, context) => dispatchWorkerRequest(opts.onRequest, type, data, context),
        onNotification: notifications && ((type, data) => dispatchWorkerNotification(notifications, type, data)),
    }) as unknown as TypedWorkerServer<Contract>;
}

export function createWorkerServer(endpoint: WorkerScopeEndpoint, opts: WorkerServerOptions): WorkerServer {
    const inflight = new Map<number, AbortController>();
    const callbacks = wrap<WorkerCallbacks>(endpoint);
    const service: WorkerService = {
        async run(operation, type, data) {
            if (!opts.onRequest) throw new Error(`no request handler for ${type}`);
            const controller = new AbortController();
            inflight.set(operation, controller);
            const transfers: Transferable[] = [];
            try {
                const result = await opts.onRequest(type, data, {
                    signal: controller.signal,
                    transfer: (items) => transfers.push(...items),
                });
                return transferValue(result, transfers);
            } finally {
                inflight.delete(operation);
            }
        },
        cancel(operation) {
            inflight.get(operation)?.abort();
        },
        notify(type, data) {
            opts.onNotification?.(type, data);
        },
    };
    expose(service, endpoint);
    return {
        notify(type, data, transfers) {
            void callbacks.notify(type, transferValue(data, transfers)).catch((error: unknown) => {
                log.warn("page notification failed", { type, err: String(error) });
            });
        },
        async request<TResult>(type: string, data?: unknown, transfers?: Transferable[]): Promise<TResult> {
            return (await callbacks.request(type, transferValue(data, transfers))) as TResult;
        },
    };
}

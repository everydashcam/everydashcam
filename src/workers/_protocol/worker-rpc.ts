import { transfer } from "comlink";

export interface WorkerNotification {
    type: string;
    data?: unknown;
}

/** Comlink owns RPC framing. Operation ids exist only to address cancellation. */
export interface WorkerService {
    run(operation: number, type: string, data: unknown): Promise<unknown>;
    cancel(operation: number): void;
    notify(type: string, data: unknown): void;
}

/** The page exposes callbacks on the same bidirectional worker endpoint. */
export interface WorkerCallbacks {
    notify(type: string, data: unknown): void;
    request(type: string, data: unknown): Promise<unknown>;
}

export function transferValue<T>(value: T, transfers?: Transferable[]): T {
    if (!transfers?.length) return value;
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
        throw new TypeError("transferred resources need an owning result or argument object");
    }
    return transfer(value, transfers);
}

/** A callback can finish after its worker was disposed, before Comlink posts it. */
export function closeTransferredResources(transfers?: Transferable[]): void {
    for (const item of transfers ?? []) {
        if ("close" in item && typeof item.close === "function") item.close();
    }
}

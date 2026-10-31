// Pool of worker-clients. Two routing strategies:
//  - shardKey provided: hash(key) % capacity selects the slot. Used by
//    gps-extract for cloneAcrossGroup affinity (Juscar F/R/I share GPS,
//    one parse + clone saves IO - splitting the group across workers would
//    waste it).
//  - shardKey absent: least-inflight load balancing. Used by preview and
//    any RPC-shaped pool.
//
// Lazy spawn: slots are null until the first request targets them. A
// single-file call pays for one worker, not for `capacity` of them.
//
// Crash respawn: when a slot's worker fires `error` (uncaught exception or
// module-load failure), the pool clears it and recreates on next access.
// Pending requests in that slot reject via the client's normal error path.

import { throwIfCancelled } from "../../abort-signals.js";
import { createLogger } from "../../log.js";
import { workerUnavailableError } from "./worker-error.js";
import type { WorkerContract, WorkerNotifier, WorkerRequester } from "./worker-contract.js";
import type { TypedWorkerClient } from "./worker-client.js";

import {
    type WorkerClient,
    type WorkerClientOptions,
    type RequestOptions,
    type NotifyOptions,
} from "./worker-client.js";

const log = createLogger("worker-pool");

/** Constructor options for createWorkerPool. */
export interface WorkerPoolOptions {
    /** Short name for logs only (e.g. "gps-extract", "preview"). */
    name: string;
    /** Max slots. Use a function for cases that depend on navigator.hardwareConcurrency. */
    capacity: number | (() => number);
    /**
     * Builds a fresh WorkerClient for a slot. Pool sets the onCrash handler
     * itself; the factory should NOT set its own (it gets overwritten).
     * Pool also passes idx for naming convenience.
     */
    factory: (idx: number, opts: { onCrash: WorkerClientOptions["onCrash"] }) => WorkerClient;
}

/** Per-call routing options on top of plain request opts. */
export interface PoolRequestOptions extends RequestOptions {
    /**
     * If provided, requests with the same shardKey land on the same slot.
     * The pool hashes the string to pick a slot - same string, same slot.
     * Without shardKey the pool picks the slot with the least in-flight
     * requests (round-robin under equal load).
     */
    shardKey?: string;
}

/** Handle for a pool. */
export interface WorkerPool {
    /**
     * Route a request to a slot per shardKey or least-inflight, await its
     * response. Slot is spawned lazily on first use.
     */
    request<TResult = unknown>(type: string, data?: unknown, opts?: PoolRequestOptions): Promise<TResult>;
    /**
     * Eagerly spawn `count` slots (default 1, clamped to capacity) without
     * sending a request, so their worker chunk is fetched and the worker is
     * ready ahead of the first real call. Used for idle prefetch on the
     * landing - dropping a folder then reuses the warm slot instead of paying
     * the worker-chunk download at that moment. Idempotent: already-spawned
     * slots are left as-is.
     */
    prewarm(count?: number): void;
    /**
     * Broadcast a notification to ALL currently-spawned slots. Lazy slots
     * stay null - we do not spawn just to receive a notify. Used for
     * dispose-style messages (e.g. "drop all caches").
     */
    notifyAll(type: string, data?: unknown, opts?: NotifyOptions): void;
    /**
     * Direct notify to a shardKey-pinned slot. Spawns the slot if needed.
     * Used when a notification must reach a specific worker (e.g. cancel
     * a long-running affinity-pinned task).
     */
    notify(type: string, data?: unknown, opts?: PoolRequestOptions & NotifyOptions): void;
    /** Terminates all spawned slots, rejects in-flight requests. */
    disposeAll(reason?: string): void;
    /** Snapshot of slot states - for diagnostics, not for routing. */
    inspect(): Array<{ idx: number; spawned: boolean; inflight: number }>;
}

export interface TypedWorkerPool<Contract extends WorkerContract>
    extends Omit<WorkerPool, "request" | "notify" | "notifyAll">,
        WorkerRequester<Contract["requests"], PoolRequestOptions>,
        WorkerNotifier<Contract["commands"], PoolRequestOptions & NotifyOptions> {
    notifyAll: WorkerNotifier<Contract["commands"], NotifyOptions>["notify"];
}

export interface TypedWorkerPoolOptions<Contract extends WorkerContract> extends Omit<WorkerPoolOptions, "factory"> {
    factory: (idx: number, opts: { onCrash: WorkerClientOptions["onCrash"] }) => TypedWorkerClient<Contract>;
}

export function createTypedWorkerPool<Contract extends WorkerContract>(
    opts: TypedWorkerPoolOptions<Contract>,
): TypedWorkerPool<Contract> {
    // The pool only forwards calls; the paired endpoints enforce the shared
    // contract. Keep its routing/crash recovery implementation unchanged.
    return createWorkerPool(opts as unknown as WorkerPoolOptions) as unknown as TypedWorkerPool<Contract>;
}

/** Per-slot state. inflight is incremented when request() resolves the slot, decremented when its promise settles. */
interface SlotState {
    client: WorkerClient | null;
    inflight: number;
}

/**
 * djb2 hash. Fast, stable, sufficient for slot routing - we are not after
 * cryptographic distribution, just consistent placement of the same key.
 */
function hashShardKey(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}

export function createWorkerPool(opts: WorkerPoolOptions): WorkerPool {
    const cap = Math.max(1, typeof opts.capacity === "function" ? opts.capacity() : opts.capacity);
    const slots: SlotState[] = Array.from({ length: cap }, () => ({ client: null, inflight: 0 }));

    function ensureSlot(idx: number): WorkerClient {
        const slot = slots[idx]!;
        if (slot.client && !slot.client.disposed) return slot.client;
        let client: WorkerClient;
        try {
            client = opts.factory(idx, {
                onCrash: (err) => {
                    // Mark the slot empty so next ensureSlot respawns. Pending
                    // requests have already been rejected by the client itself.
                    // Key is `pool`, not `name`: *name*-keys get masked to "***" by
                    // the Sentry breadcrumb scrubber (sentry-scrub.ts FILENAME_KEY_RE).
                    log.warn("pool slot crashed, will respawn on next use", {
                        pool: opts.name,
                        idx,
                        err: err.message,
                    });
                    slot.client = null;
                    slot.inflight = 0;
                },
            });
        } catch (err) {
            if (err instanceof Error && err.name === "AbortError") throw err;
            throw workerUnavailableError(err);
        }
        slot.client = client;
        return client;
    }

    function pickSlotIdx(shardKey: string | undefined): number {
        if (shardKey !== undefined) {
            return hashShardKey(shardKey) % cap;
        }
        // Least-inflight. Ties broken by lower index (deterministic).
        let bestIdx = 0;
        let bestInflight = slots[0]!.inflight;
        for (let i = 1; i < cap; i++) {
            const cur = slots[i]!.inflight;
            if (cur < bestInflight) {
                bestIdx = i;
                bestInflight = cur;
            }
        }
        return bestIdx;
    }

    return {
        async request<TResult = unknown>(type: string, data?: unknown, reqOpts?: PoolRequestOptions): Promise<TResult> {
            throwIfCancelled(reqOpts?.signal);
            const idx = pickSlotIdx(reqOpts?.shardKey);
            const slot = slots[idx]!;
            const client = ensureSlot(idx);
            slot.inflight++;
            try {
                return await client.request<TResult>(type, data, {
                    signal: reqOpts?.signal,
                    transfer: reqOpts?.transfer,
                });
            } finally {
                // A crashed or disposed worker may already have a replacement.
                if (slot.client === client) slot.inflight = Math.max(0, slot.inflight - 1);
            }
        },
        prewarm(count = 1): void {
            const n = Math.min(Math.max(1, count), cap);
            for (let i = 0; i < n; i++) ensureSlot(i);
        },
        notifyAll(type: string, data?: unknown, ntfOpts?: NotifyOptions): void {
            for (const slot of slots) {
                if (slot.client && !slot.client.disposed) {
                    slot.client.notify(type, data, ntfOpts);
                }
            }
        },
        notify(type: string, data?: unknown, ntfOpts?: PoolRequestOptions & NotifyOptions): void {
            const idx = pickSlotIdx(ntfOpts?.shardKey);
            const client = ensureSlot(idx);
            client.notify(type, data, { transfer: ntfOpts?.transfer });
        },
        disposeAll(reason?: string): void {
            for (const slot of slots) {
                if (slot.client) {
                    slot.client.dispose(reason);
                    slot.client = null;
                    slot.inflight = 0;
                }
            }
        },
        inspect() {
            return slots.map((slot, idx) => ({
                idx,
                spawned: slot.client !== null && !slot.client.disposed,
                inflight: slot.inflight,
            }));
        },
    };
}

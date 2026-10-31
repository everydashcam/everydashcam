// Shared owner of the tracker-worker singleton. Both pass clients - the Follow
// tracking pass (blur-track.ts) and the detection pass (blur-detect.ts) - talk
// to the SAME worker: it serializes passes internally (single decoder budget,
// shared ort scratch state) and holds the loaded wasm runtime + model sessions,
// so a second Worker instance would double ~14 MB of RAM and the session warm
// for zero parallelism. Notifications fan out to whoever subscribed; each
// client filters by its own message type.

import { createLogger } from "../log.js";
import { createSubscribers } from "../subscribers.js";
import type { TrackerWorkerContract } from "../workers/tracker-protocol.js";
import type { WorkerMessage, WorkerRequestArguments } from "../workers/_protocol/worker-contract.js";

import { invalidateBlurAssetReadiness } from "./blur-assets.js";
import {
    createTypedWorkerClient,
    type TypedWorkerClient,
    type RequestOptions,
} from "../workers/_protocol/worker-client.js";

const log = createLogger("blur-tracker");

let client: TypedWorkerClient<TrackerWorkerContract> | null = null;
/** A thread pool failed to start in this session, so later workers keep ORT on
 *  one thread (see SINGLE_THREAD_TRACKER_WORKER_NAME in ort-runtime.ts). */
let threadsFailed = false;
const singleThreadClients = new WeakSet<TypedWorkerClient<TrackerWorkerContract>>();

export type WorkerNotification = WorkerMessage<TrackerWorkerContract["events"]>;

type NotificationListener = (msg: WorkerNotification) => void;
const notificationListeners = createSubscribers<Parameters<NotificationListener>>("tracker-notifications");

/** Subscribes to ALL notifications of the shared worker (filter by msg.type).
 *  Survives a worker crash/recreate - the fan-out is module-level, not bound to
 *  one Worker instance. Returns unsubscribe. */
export function subscribeTrackerWorkerNotifications(listener: NotificationListener): () => void {
    return notificationListeners.subscribe(listener);
}

/** The shared worker client, (re)created on demand (and after a crash). */
export function trackerWorkerClient(): TypedWorkerClient<TrackerWorkerContract> {
    if (client && !client.disposed) return client;
    // The name is the worker's startup configuration, read by ort-runtime.ts
    // before ORT loads. Vite needs literal worker options, hence one call site
    // per name for the same worker file.
    const worker = threadsFailed
        ? new Worker(new URL("../workers/tracker-worker.ts", import.meta.url), {
              type: "module",
              name: "tracker-worker-single-thread",
          })
        : new Worker(new URL("../workers/tracker-worker.ts", import.meta.url), {
              type: "module",
              name: "tracker-worker",
          });
    client = createTypedWorkerClient<TrackerWorkerContract>(worker, {
        name: "blur-track",
        onCrash: () => {
            client = null;
        },
        onNotification: (msg) => {
            notificationListeners.emit(msg);
        },
    });
    if (threadsFailed) singleThreadClients.add(client);
    return client;
}

/** Initialization, inference and stalled passes can leave ORT unusable.
 * Decode/preprocessing errors outside ORT leave unrelated queued work usable.
 * A thread pool that failed to start is retried once on a single-threaded
 * worker: slower, but it needs no extra threads. */
export async function requestTrackerWorker<
    Args extends WorkerRequestArguments<TrackerWorkerContract["requests"], RequestOptions>,
>(...args: Args): Promise<TrackerWorkerContract["requests"][Args[0]]["result"]> {
    const owner = trackerWorkerClient();
    try {
        return await owner.request<Args>(...args);
    } catch (error) {
        const isAssetFailure = error instanceof Error && error.name.startsWith("Asset");
        if (isAssetFailure) invalidateBlurAssetReadiness();
        const timeout = args[2]?.signal?.reason;
        if (
            isAssetFailure ||
            (error instanceof Error &&
                (error.name === "OrtInitializationError" ||
                    error.name === "OrtThreadStartError" ||
                    error.name === "OrtInferenceError")) ||
            timeout?.name === "TimeoutError"
        ) {
            // Other passes must report this failure too, not mistake worker
            // replacement for their user's cancellation.
            owner.dispose(
                timeout?.name === "TimeoutError" ? timeout : error instanceof Error ? error : new Error(String(error)),
            );
            if (client === owner) client = null;
        }
        // Passes queued on the same worker fail with the same error and retry too.
        if (error instanceof Error && error.name === "OrtThreadStartError" && !singleThreadClients.has(owner)) {
            if (!threadsFailed) log.warn("tracker threads failed to start; using one thread", { err: error.message });
            threadsFailed = true;
            return requestTrackerWorker<Args>(...args);
        }
        throw error;
    }
}

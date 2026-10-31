// Shared owner of the tracker-worker singleton. Both pass clients - the Follow
// tracking pass (blur-track.ts) and the detection pass (blur-detect.ts) - talk
// to the SAME worker: it serializes passes internally (single decoder budget,
// shared ort scratch state) and holds the loaded wasm runtime + model sessions,
// so a second Worker instance would double ~14 MB of RAM and the session warm
// for zero parallelism. Notifications fan out to whoever subscribed; each
// client filters by its own message type.

import type { TrackerWorkerContract } from "../workers/tracker-protocol.js";
import type { WorkerMessage, WorkerRequestArguments } from "../workers/_protocol/worker-contract.js";

import { invalidateBlurAssetReadiness } from "./blur-assets.js";
import {
    createTypedWorkerClient,
    type TypedWorkerClient,
    type RequestOptions,
} from "../workers/_protocol/worker-client.js";

let client: TypedWorkerClient<TrackerWorkerContract> | null = null;

export type WorkerNotification = WorkerMessage<TrackerWorkerContract["events"]>;

type NotificationListener = (msg: WorkerNotification) => void;
const notificationListeners = new Set<NotificationListener>();

/** Subscribes to ALL notifications of the shared worker (filter by msg.type).
 *  Survives a worker crash/recreate - the fan-out is module-level, not bound to
 *  one Worker instance. Returns unsubscribe. */
export function subscribeTrackerWorkerNotifications(listener: NotificationListener): () => void {
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
}

/** The shared worker client, (re)created on demand (and after a crash). */
export function trackerWorkerClient(): TypedWorkerClient<TrackerWorkerContract> {
    if (client && !client.disposed) return client;
    const worker = new Worker(new URL("../workers/tracker-worker.ts", import.meta.url), {
        type: "module",
        name: "tracker-worker",
    });
    client = createTypedWorkerClient<TrackerWorkerContract>(worker, {
        name: "blur-track",
        onCrash: () => {
            client = null;
        },
        onNotification: (msg) => {
            for (const l of notificationListeners) l(msg);
        },
    });
    return client;
}

/** Initialization, inference and stalled passes can leave ORT unusable.
 * Decode/preprocessing errors outside ORT leave unrelated queued work usable. */
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
                (error.name === "OrtInitializationError" || error.name === "OrtInferenceError")) ||
            timeout?.name === "TimeoutError"
        ) {
            // Other passes must report this failure too, not mistake worker
            // replacement for their user's cancellation.
            owner.dispose(
                timeout?.name === "TimeoutError" ? timeout : error instanceof Error ? error : new Error(String(error)),
            );
            if (client === owner) client = null;
        }
        throw error;
    }
}

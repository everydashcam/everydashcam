// Shared owner of the tracker-worker singleton. Both pass clients - the Follow
// tracking pass (blur-track.ts) and the detection pass (blur-detect.ts) - talk
// to the SAME worker: it serializes passes internally (single decoder budget,
// shared ort scratch state) and holds the loaded wasm runtime + model sessions,
// so a second Worker instance would double ~14 MB of RAM and the session warm
// for zero parallelism. Notifications fan out to whoever subscribed; each
// client filters by its own message type.

import { invalidateBlurAssetReadiness } from "./blur-assets.js";
import { createWorkerClient, type WorkerClient } from "../workers/_protocol/worker-client.js";

let client: WorkerClient | null = null;

export interface WorkerNotification {
    type: string;
    data?: unknown;
}

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
export function trackerWorkerClient(): WorkerClient {
    if (client && !client.disposed) return client;
    const worker = new Worker(new URL("../workers/tracker-worker.ts", import.meta.url), {
        type: "module",
        name: "tracker-worker",
    });
    client = createWorkerClient(worker, {
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

/** Native runtime initialization can leave ORT permanently aborted. A failed
 * request ends this instance; the next explicit attempt gets a fresh worker. */
export async function requestTrackerWorker<T>(...args: Parameters<WorkerClient["request"]>): Promise<T> {
    const owner = trackerWorkerClient();
    try {
        return await owner.request<T>(...args);
    } catch (error) {
        if (error instanceof Error && error.name.startsWith("Asset")) invalidateBlurAssetReadiness();
        if (
            !(error instanceof Error && error.name === "AbortError") ||
            args[2]?.signal?.reason?.name === "TimeoutError"
        ) {
            owner.dispose("tracker request failed");
            if (client === owner) client = null;
        }
        throw error;
    }
}

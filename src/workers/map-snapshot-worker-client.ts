// Worker-side map snapshots use reverse RPC because MapLibre renders on the page.
import type { WorkerRequester } from "./_protocol/worker-contract.js";
import type { TranscodeWorkerContract } from "./transcode-protocol.js";
import type { MapSnapshotter, MapSnapshotRequest } from "../transcode/map-snapshotter-types.js";
import { TRANSCODE_REQUEST_MAP_SNAPSHOT } from "./transcode-protocol.js";

// Map initialization and range prewarming can overlap the first two requests.
// Keep the wider budget until an actual reply arrives, then bound each render.
const FIRST_SNAPSHOT_TIMEOUT_MS = 120_000;
const SNAPSHOT_TIMEOUT_MS = 30_000;

export class MapSnapshotWorkerClient implements MapSnapshotter {
    private pending = new Set<(error: Error) => void>();
    private warmedUp = false;

    constructor(private server: WorkerRequester<TranscodeWorkerContract["callbacks"], Transferable[]>) {}

    snapshot(request: MapSnapshotRequest): Promise<ImageBitmap> {
        const timeoutMs = this.warmedUp ? SNAPSHOT_TIMEOUT_MS : FIRST_SNAPSHOT_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            const cancel = (error: Error): void => {
                if (!this.pending.delete(cancel)) return;
                clearTimeout(timeoutId);
                reject(error);
            };
            const timeoutId = setTimeout(() => cancel(new Error("map snapshot timeout")), timeoutMs);
            this.pending.add(cancel);
            void this.server.request(TRANSCODE_REQUEST_MAP_SNAPSHOT, request).then(
                (bitmap) => {
                    if (!this.pending.delete(cancel)) {
                        // Cancellation and timeouts can outlive the page's render.
                        // An unclaimed transferred bitmap still owns GPU memory.
                        bitmap?.close();
                        return;
                    }
                    clearTimeout(timeoutId);
                    this.warmedUp = true;
                    if (bitmap) resolve(bitmap);
                    else reject(new Error("map snapshot returned no bitmap"));
                },
                (error: unknown) => {
                    if (!this.pending.has(cancel)) return;
                    this.warmedUp = true;
                    cancel(error instanceof Error ? error : new Error(String(error)));
                },
            );
        });
    }

    /** Cancels outstanding renders; later transferred replies are closed. */
    dispose(reason: string): void {
        const error = new DOMException(reason, "AbortError");
        for (const cancel of this.pending) cancel(error);
    }
}

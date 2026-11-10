// Page side of the trip-map worker. The worker holds the simplified tracks it
// aggregates into corridor lines; a crash loses them, so the owner is told to
// send every track again.

import type { TripBundle } from "../trip-map/bundle.js";
import type { TripMapTrack } from "../trip-map/track-geometry.js";
import { packedTrackTransfer, type PackedTripTrack } from "../trip-map/track-input.js";
import type { TripMapWorkerContract } from "../workers/trip-map-protocol.js";
import { createTypedWorkerClient, type TypedWorkerClient } from "../workers/_protocol/worker-client.js";
import { createLogger } from "../log.js";

const log = createLogger("trip-map");

// A worker that cannot even load (its chunk gone after a deploy) would crash
// on every resend; past this many crashes the tracks stay lost until reload.
const MAX_CRASH_RESENDS = 3;

let client: TypedWorkerClient<TripMapWorkerContract> | null = null;
let onCrash: (() => void) | null = null;
let crashes = 0;

/** Runs after the worker died and took its tracks with it. */
export function setTripMapWorkerCrashHandler(handler: () => void): void {
    onCrash = handler;
}

function workerClient(): TypedWorkerClient<TripMapWorkerContract> {
    if (client && !client.disposed) return client;
    // Literal options: the portable build embeds workers by this exact shape.
    const worker = new Worker(new URL("../workers/trip-map-worker.ts", import.meta.url), {
        type: "module",
        name: "trip-map-worker",
    });
    client = createTypedWorkerClient<TripMapWorkerContract>(worker, {
        name: "trip-map",
        onCrash: () => {
            client = null;
            crashes++;
            if (crashes <= MAX_CRASH_RESENDS) onCrash?.();
            else if (crashes === MAX_CRASH_RESENDS + 1) log.warn("trip map worker keeps crashing, tracks not resent");
        },
    });
    return client;
}

/** Simplifies one trip's fixes in the worker; the packed arrays are transferred. */
export function requestTripMapTrack(id: number, packed: PackedTripTrack): Promise<TripMapTrack> {
    return workerClient().request("track", { id, packed }, { transfer: packedTrackTransfer(packed) });
}

export function requestTripMapBundle(step: number, ids: number[]): Promise<TripBundle> {
    return workerClient().request("bundle", { step, ids });
}

export function releaseTripMapTracks(ids: number[]): void {
    if (ids.length === 0 || !client || client.disposed) return;
    client.notify("release", { ids });
}

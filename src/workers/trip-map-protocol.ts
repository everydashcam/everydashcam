// Wire payloads between ui/trip-map-worker-client.ts and
// workers/trip-map-worker.ts. The worker owns the simplified tracks of the
// whole library and computes the corridor lines from them; the page keeps a
// copy of each track for its own place queries.

import type { TripBundle } from "../trip-map/bundle.js";
import type { TripMapTrack } from "../trip-map/track-geometry.js";
import type { PackedTripTrack } from "../trip-map/track-input.js";
import type { WorkerContract, WorkerRequest } from "./_protocol/worker-contract.js";

export interface TripMapTrackRequest {
    /** Page-assigned id; one id per distinct trip geometry. */
    id: number;
    packed: PackedTripTrack;
}

export interface TripMapBundleRequest {
    /** Bundle zoom step (see bundleStepForZoom). */
    step: number;
    /** Track ids to aggregate, in a stable order. Unknown ids are ignored. */
    ids: number[];
}

export interface TripMapReleaseCommand {
    ids: number[];
}

export type TripMapWorkerContract = WorkerContract<
    {
        /** Simplifies and stores one track; returns a copy for the page. */
        track: WorkerRequest<TripMapTrackRequest, TripMapTrack>;
        bundle: WorkerRequest<TripMapBundleRequest, TripBundle>;
    },
    { release: TripMapReleaseCommand },
    Record<never, never>,
    Record<never, never>
>;

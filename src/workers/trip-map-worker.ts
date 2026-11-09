import { buildTripBundle, type BundleTrack, type TripBundle } from "../trip-map/bundle.js";
import { buildTripMapTrack, type TripMapTrack } from "../trip-map/track-geometry.js";
import type { TripMapWorkerContract } from "./trip-map-protocol.js";
import { createTypedWorkerServer, type WorkerScopeEndpoint } from "./_protocol/worker-server.js";

declare const self: WorkerScopeEndpoint;

const tracks = new Map<number, TripMapTrack>();
// Zooming back and forth and toggling a place filter revisit the same few
// results; the newest entries stay, the oldest drop first. Keys name the track
// ids, and the page never reuses an id, so entries never go stale.
const BUNDLE_CACHE_SIZE = 8;
const bundleCache = new Map<string, TripBundle>();

function copyTrack(track: TripMapTrack): TripMapTrack {
    return {
        points: track.points.slice(),
        times: track.times.slice(),
        breaks: track.breaks.slice(),
        bounds: { ...track.bounds },
    };
}

function copyBundle(bundle: TripBundle): TripBundle {
    return {
        step: bundle.step,
        lines: bundle.lines.map((line) => ({
            width: line.width,
            coords: line.coords.slice(),
            starts: line.starts.slice(),
        })),
    };
}

createTypedWorkerServer<TripMapWorkerContract>(self, {
    onRequest: {
        track: ({ id, packed }, context) => {
            const track = buildTripMapTrack(packed);
            tracks.set(id, track);
            const copy = copyTrack(track);
            context.transfer([copy.points.buffer, copy.times.buffer, copy.breaks.buffer]);
            return copy;
        },
        bundle: ({ step, ids }, context) => {
            const key = `${step}|${ids.join(",")}`;
            let bundle = bundleCache.get(key);
            if (bundle) {
                bundleCache.delete(key);
            } else {
                const input: BundleTrack[] = [];
                for (const id of ids) {
                    const track = tracks.get(id);
                    if (track) input.push({ id, points: track.points, breaks: track.breaks, bounds: track.bounds });
                }
                bundle = buildTripBundle(input, step);
                if (bundleCache.size >= BUNDLE_CACHE_SIZE) bundleCache.delete(bundleCache.keys().next().value!);
            }
            bundleCache.set(key, bundle);
            // The cache keeps its own buffers; the page receives transferred copies.
            const copy = copyBundle(bundle);
            context.transfer(copy.lines.flatMap((line) => [line.coords.buffer, line.starts.buffer]));
            return copy;
        },
    },
    onNotification: {
        release: ({ ids }) => {
            for (const id of ids) tracks.delete(id);
        },
    },
});

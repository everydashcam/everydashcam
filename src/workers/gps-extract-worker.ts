// Worker for parsing embedded GPS from MP4 files. Offloads from the main
// thread: sample-by-sample parsing of GPMF (GoPro), Novatek streaming,
// Thinkware NMEA in the sbtl track, Garmin PNDM. On long HEVC files with
// embedded telemetry this is hundreds of ms per file - on the main thread
// they accumulate into visible UI freezes during ingest.
//
// Architecture: one worker per pool slot, requests routed by shardKey
// (cloneAcrossGroup affinity). The worker builds its own Mp4Index - the
// main-thread indexer no longer builds it (was an unused cache across the
// worker boundary). On a cold disk this is the first header read for the
// file; on a warm OS page cache it is a cheap repeat read within an ingest
// session.
//
// RPC: Comlink carries calls and errors; createWorkerServer forwards cancellation.
// Per-file progress is pushed via server.notify("progress").

import { createLogger } from "../log.js";
import {
    GPS_NOTIFY_PROGRESS,
    GPS_REQUEST_EXTRACT,
    type ExtractRequestData,
    type ExtractResult,
} from "./gps-extract-protocol.js";
import { dispatchGpsExtractRequest } from "./gps-extract-request.js";
import { createParseGate } from "./_protocol/parse-gate.js";
import { createWorkerServer, type WorkerScopeEndpoint } from "./_protocol/worker-server.js";

const log = createLogger("worker:gps-extract");

declare const self: WorkerScopeEndpoint;

// Cap concurrent extract requests per slot. Batches of ~16 are dispatched
// during indexing without awaiting, and all shard onto the same slots;
// worker-server does not serialize handlers, so without this a 240-file drop
// piles ~10 concurrent IO cycles onto one worker - exactly what the shim's
// "internal concurrency would just trash IO further" promises to avoid.
// Capacity 2 keeps the one-slow-file pipelining argument from ingest-worker
// (see parse-gate.ts for the full rationale).
const parseGate = createParseGate(2);

const server = createWorkerServer(self, {
    onRequest: async (type, data, ctx): Promise<ExtractResult> => {
        if (type !== GPS_REQUEST_EXTRACT) {
            throw new Error(`unknown request type: ${type}`);
        }
        const req = data as ExtractRequestData;
        return parseGate.run(async () => {
            try {
                return await dispatchGpsExtractRequest(req, ctx.signal, (progress) => {
                    server.notify(GPS_NOTIFY_PROGRESS, progress);
                });
            } catch (err) {
                // dispatchParseVideoEmbeddedGps rethrows AbortError on cancel;
                // surface it as-is so the client side sees AbortError, not a
                // generic Error. Other failures get logged before re-throwing so
                // the worker tab in DevTools shows the original error site.
                if (!(err instanceof DOMException && err.name === "AbortError")) {
                    log.error("dispatchParseVideoEmbeddedGps failed", err);
                }
                throw err;
            }
        });
    },
});

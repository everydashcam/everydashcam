// Worker for ingest pre-processing: classify files, parse log-sidecars,
// parse gps-sidecars (non-GPX), parse accel-sidecars. Offloads from the
// main thread the CPU-heavy work of:
//  - extractor.marker probes (~256 byte reads + signature checks per non-video file),
//  - 70mai $V02 CSV parsing (regex + parseFloat over 25 fields x ~50K rows -
//    ~100-200 ms on a single big log),
//  - NMEA / Escort .map line walks.
//
// GPX (XML) is NOT handled here - it uses DOMParser which is not guaranteed
// in DedicatedWorkerGlobalScope across FF/Safari. The ingest-shim parses
// gpx-classified files on the main thread.
//
// Protocol: atomic per file for parse-*, batch for classify (shared
// knownVideoNames). See ingest-protocol.ts for the wire shapes.

import { throwIfCancelled } from "../abort-signals.js";
import type { IngestWorkerContract } from "./ingest-protocol.js";

import { createLogger } from "../log.js";
import { LOG_SIDECAR_PRIMITIVES } from "../parsers/primitives/index.js";
import { ACCEL_SIDECARS, SIDECARS, classifyOneNonVideo, type ClassifiedFile } from "../parsers/registry.js";
import { WrongFormatError } from "../parsers/types.js";

import {
    INGEST_REQUEST_CLASSIFY_BATCH,
    INGEST_REQUEST_PARSE_ACCEL_SIDECAR,
    INGEST_REQUEST_PARSE_LOG,
    INGEST_REQUEST_PARSE_SIDECAR,
    type ClassifyBatchResult,
    type ParseAccelSidecarResult,
    type ParseLogResult,
    type ParseSidecarResult,
} from "./ingest-protocol.js";
import { createParseGate } from "./_protocol/parse-gate.js";
import { createTypedWorkerServer, type WorkerScopeEndpoint } from "./_protocol/worker-server.js";

const log = createLogger("worker:ingest");

declare const self: WorkerScopeEndpoint;

// Sidecars safe to run inside a worker. gpxSidecar is dropped because it
// uses DOMParser; ddpaiGpxSidecar stays (it parses NMEA inside .gpx files,
// no XML parsing). Order mirrors SIDECARS so classifier priority is the
// same minus the GPX slot.
const WORKER_SIDECARS = SIDECARS.filter((s) => s.id !== "gpx");

// Cap on concurrent parse handlers inside this worker slot. classify is NOT
// gated - it is cheap (~256-byte reads + signature checks) and the batch sits
// atomically on one slot already, so gating would only add latency. Parse
// requests (full file read + parse loop) are the ones that justify the gate.
// Two-at-a-time keeps some pipelining for the "one slow file + one fast file"
// case; larger values regress to the ~15-concurrent-parse-per-slot fan-out
// the gate exists to prevent (see parse-gate.ts for the full rationale).
const parseGate = createParseGate(2);

createTypedWorkerServer<IngestWorkerContract>(self, {
    onRequest: {
        [INGEST_REQUEST_CLASSIFY_BATCH]: async (req, ctx) => {
            const knownVideos = new Set(req.knownVideoNames);
            const out: ClassifiedFile[] = [];
            for (const vf of req.files) {
                throwIfCancelled(ctx.signal);
                out.push(await classifyOneNonVideo(vf, knownVideos, WORKER_SIDECARS, ACCEL_SIDECARS));
            }
            return out satisfies ClassifyBatchResult;
        },
        [INGEST_REQUEST_PARSE_LOG]: async (req, ctx) => {
            const extractor = LOG_SIDECAR_PRIMITIVES.find((e) => e.id === req.extractorId);
            if (!extractor) throw new Error(`no log extractor: ${req.extractorId}`);
            return await parseGate.run(async () => {
                try {
                    const parsed = await extractor.parse(req.file, undefined, ctx.signal, {
                        knownVideos: req.knownVideos,
                    });
                    return {
                        records: parsed.records,
                        skipped: parsed.skipped,
                    } satisfies ParseLogResult;
                } catch (err) {
                    // WrongFormatError mirrors registry.dispatchParseLogs: marker
                    // matched but content did not. Surface as empty result; the
                    // shim aggregates errors via the standard error path of
                    // request rejection - WrongFormatError specifically does not
                    // pollute logs there, so we mimic the behavior here.
                    if (err instanceof WrongFormatError) {
                        return { records: [], skipped: [] } satisfies ParseLogResult;
                    }
                    log.warn("parseLog error", { extractor: req.extractorId, file: req.file.file.name, err });
                    throw err;
                }
            });
        },
        [INGEST_REQUEST_PARSE_SIDECAR]: async (req, ctx) => {
            // gpx is handled on main; the shim should never route it here.
            // Defensive check so a mis-wired call surfaces loudly.
            if (req.sidecarId === "gpx") {
                throw new Error("gpx sidecar must be parsed on main thread");
            }
            const handler = WORKER_SIDECARS.find((h) => h.id === req.sidecarId);
            if (!handler) throw new Error(`no sidecar handler: ${req.sidecarId}`);
            return await parseGate.run(async () => {
                try {
                    const records = await handler.parse(req.file, req.mp4Filename, ctx.signal);
                    return { records } satisfies ParseSidecarResult;
                } catch (err) {
                    // WrongFormatError is control flow, not a failure (mirrors
                    // parse-log above). ddpaiGpxSidecar throws it when a .gpx in
                    // a DDPai gps dir turns out to be real XML - which it cannot
                    // parse (no DOMParser in a worker). Return a marker so the
                    // shim reroutes to the main-thread gpxSidecar instead of
                    // surfacing a user-visible parse error + Sentry event.
                    if (err instanceof WrongFormatError) {
                        return { records: [], wrongFormat: true } satisfies ParseSidecarResult;
                    }
                    throw err;
                }
            });
        },
        [INGEST_REQUEST_PARSE_ACCEL_SIDECAR]: async (req, ctx) => {
            const handler = ACCEL_SIDECARS.find((h) => h.id === req.sidecarId);
            if (!handler) throw new Error(`no accel-sidecar handler: ${req.sidecarId}`);
            return await parseGate.run(async () => {
                const samples = await handler.parseAccel(req.file, ctx.signal);
                return { samples } satisfies ParseAccelSidecarResult;
            });
        },
    },
});

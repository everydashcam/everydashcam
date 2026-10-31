// Main-thread wrapper over the transcode worker. Drop-in replacement for transcode()/transcodeSplit()
// with one difference: accepts an already-opened FileSystemWritableFileStream, bridges it to the
// worker over a MessagePort internally, and passes the worker's port end to the worker.
//
// Why a MessagePort bridge instead of direct FSA transfer: neither
// FileSystemWritableFileStream (DataCloneError on postMessage) nor a handle from showSaveFilePicker
// (createWritable fails in worker scope - permission state does not survive structured-clone) work.
// A transferable WritableStream would, in Chromium/Firefox, but stable Safari throws DataCloneError
// when you postMessage a stream (WebKit #215485). A MessagePort is transferable on every target
// browser; backpressure is re-implemented over it (port-writable.ts) with the same 16-chunk depth.
//
// Each call creates its own Worker (transcoding is a rare user-initiated operation; keeping an idle
// worker between exports wastes memory).

import type { TranscodeWorkerContract } from "../workers/transcode-protocol.js";

import { transfer } from "comlink";
import type { MapSnapshotRequest } from "../transcode/map-snapshotter-types.js";
import { createLogger } from "../log.js";
import type { HardwareAccelerationResolver, TranscodeArgs, TranscodeResult } from "../transcode/types.js";
import type { TranscodeSplitArgs } from "../transcode/pipeline-split.js";

import {
    TRANSCODE_REQUEST_HARDWARE_ACCELERATION,
    TRANSCODE_REQUEST_MAP_SNAPSHOT,
    TRANSCODE_NOTIFY_PROGRESS,
    TRANSCODE_REQUEST_SINGLE,
    TRANSCODE_REQUEST_SPLIT,
    type TranscodeArgsForTransfer,
    type TranscodeSplitArgsForTransfer,
} from "../workers/transcode-protocol.js";
import { createTypedWorkerClient } from "../workers/_protocol/worker-client.js";

import { state } from "./state.js";
import type { OverlayMapState } from "./export-state.js";
import { createWorkerWritableProxy } from "./writable-bridge.js";
import type { OverlayPipelineArgs } from "../transcode/types.js";
import { computeOutputSize } from "../transcode/compose.js";
import { createExportHeartbeat } from "../transcode/export-heartbeat.js";
import { MAP_BASE_WIDTH_PCT } from "../transcode/map-overlay.js";
import { recordsInWallWindow } from "../transcode/overlay-pipeline-helpers.js";
import { type ChasePrewarmOpts, createExportMapSnapshotter } from "./export-map-snapshot.js";
import { MapSnapshotSession } from "./map-snapshot-session.js";

const log = createLogger("transcode-shim");

// Margin around the export range for the prewarm walk: covers the viewport
// around the range edges (a viewport-width of track at highway speed is well
// under 30 s) and the 1-second resolution of filename-derived record times.
const PREWARM_RANGE_MARGIN_SEC = 30;

/**
 * Post-process that writes into the finished, still-open output before it is committed to disk
 * (the GPMF track injection). Receives the real writable the worker streamed into and the
 * pipeline result (which carries the captured moov). A throw discards the output and fails the
 * export; cancellation surfaces as AbortError like everywhere else.
 */
export type BeforeCommitHook = (writable: FileSystemWritableFileStream, result: TranscodeResult) => Promise<void>;

/**
 * Runs a single-channel transcode in the worker. `onDiskCommit` (optional) brackets the final
 * opaque disk flush so the caller can show an indeterminate bar (see writable-bridge.ts).
 * `beforeCommit` (optional) runs between the worker's finalize and that flush, with the output
 * still open - see BeforeCommitHook.
 */
export function transcodeViaWorker(
    args: TranscodeArgs,
    onDiskCommit?: (on: boolean) => void,
    mapConfig: Readonly<OverlayMapState> | null = null,
    beforeCommit?: BeforeCommitHook,
): Promise<TranscodeResult> {
    const { signal, onProgress, writable, resolveHardwareAcceleration, ...rest } = args;
    return runInWorker(
        { type: TRANSCODE_REQUEST_SINGLE, args: rest },
        writable,
        signal,
        resolveHardwareAcceleration,
        onProgress,
        args.output.overlays,
        onDiskCommit,
        mapConfig,
        beforeCommit,
    );
}

/** Runs a split-screen transcode in the worker. Same contract as transcodeViaWorker. */
export function transcodeSplitViaWorker(
    args: TranscodeSplitArgs,
    onDiskCommit?: (on: boolean) => void,
    mapConfig: Readonly<OverlayMapState> | null = null,
    beforeCommit?: BeforeCommitHook,
): Promise<TranscodeResult> {
    const { signal, onProgress, writable, resolveHardwareAcceleration, ...rest } = args;
    return runInWorker(
        { type: TRANSCODE_REQUEST_SPLIT, args: rest },
        writable,
        signal,
        resolveHardwareAcceleration,
        onProgress,
        args.output.overlays,
        onDiskCommit,
        mapConfig,
        beforeCommit,
    );
}

function runInWorker(
    request:
        | { type: typeof TRANSCODE_REQUEST_SINGLE; args: TranscodeArgsForTransfer }
        | { type: typeof TRANSCODE_REQUEST_SPLIT; args: TranscodeSplitArgsForTransfer },
    writable: FileSystemWritableFileStream,
    signal: AbortSignal,
    resolveHardwareAcceleration: HardwareAccelerationResolver | undefined,
    onProgress: TranscodeArgs["onProgress"],
    overlays: OverlayPipelineArgs | null,
    onDiskCommit?: (on: boolean) => void,
    mapConfig: Readonly<OverlayMapState> | null = null,
    beforeCommit?: BeforeCommitHook,
): Promise<TranscodeResult> {
    const transferArgs = request.args;
    // name is static - Vite's worker plugin requires static options.
    const worker = new Worker(new URL("../workers/transcode-worker.ts", import.meta.url), {
        type: "module",
        name: "transcode-worker",
    });

    // MessagePort bridge over the real FSA writable. The main side keeps the real writable and
    // applies write/close/abort the worker posts over the port; finalized resolves when the main-side
    // close (and the FSA atomic rename) are done. See writable-bridge.ts / port-writable.ts.
    const {
        port: writablePort,
        finalized: writableFinalized,
        commit: writableCommit,
        forceAbort: writableForceAbort,
        sinkError: writableSinkError,
    } = createWorkerWritableProxy(writable, onDiskCommit, { deferCommit: beforeCommit !== undefined });

    // Initialize once and serialize renders on the map's shared compositor.
    const snapshotSession = new MapSnapshotSession(() => {
        const records = overlays?.gpsRecords ?? [];
        // Snapshot-render concerns stay on the main thread, but still come from
        // the same immutable Save-time contract as the worker args. Reading the
        // live panel here made a delayed export susceptible to later UI state.
        const overlayMap = mapConfig;
        if (!overlayMap) throw new Error("map overlay config missing from export snapshot");
        const mapTheme = overlayMap.theme;
        const chase: ChasePrewarmOpts = {
            headingUp: overlayMap.mode === "chase",
            pitchDeg: overlayMap.pitchDeg,
            adaptiveZoom: overlayMap.adaptiveZoom,
        };
        // Size the snapshot buffer to the overlay slot it lands in - frameWidth *
        // MAP_BASE_WIDTH_PCT * userScale (the same geometry map-overlay.ts draws
        // into) - so the hidden map is not rendered at devicePixelRatio and then
        // thrown away on a small inset. The map scale is locked for the run (panel
        // frozen in "progress"), so one ratio covers every frame. computeOutputSize
        // mirrors the worker's own output-width derivation (same aspect + height).
        const outputWidthPx = computeOutputSize(transferArgs.output.height, transferArgs.output.aspect).width;
        const targetSlotWidthPx = outputWidthPx * MAP_BASE_WIDTH_PCT * (overlayMap.scalePct / 100);
        return createExportMapSnapshotter(records, "export", mapTheme, targetSlotWidthPx, {
            provider: overlayMap.provider,
            labelScalePct: overlayMap.labelScalePct,
            labelDensity: overlayMap.labelDensity,
            markerAppearance: overlayMap.marker,
        }).then(async (snap) => {
            // Pre-warm tiles immediately so the very first per-frame snapshot
            // does not block on tile fetch. Aborted via the transcode signal:
            // the user cancelled, no point loading more tiles.
            if (overlays?.map) {
                // Only the exported range (plus a viewport margin): the
                // export never snapshots outside the range, and a
                // whole-trip walk on a slow network can starve the first
                // snapshot's worker-side timeout, dropping the map from
                // the entire export.
                const prewarmRecords = recordsInWallWindow(
                    records,
                    overlays.rangeStartUtcSec,
                    overlays.rangeEndUtcSec,
                    PREWARM_RANGE_MARGIN_SEC,
                );
                try {
                    await snap.prewarm(prewarmRecords, overlays.map.zoomKm, signal, chase);
                } catch (err) {
                    log.warn("map snapshot prewarm threw", { err: String(err) });
                }
            }
            return snap;
        });
    });
    // Eager start: kick off MapLibre init + prewarm at export start instead of
    // on the worker's first snapshot request, overlapping them with worker
    // startup and the first decodes. The catch only silences the unhandled
    // rejection - the cached rejected promise resurfaces on the first snapshot
    // request, which rejects the worker's reverse RPC.
    if (overlays?.map) void snapshotSession.preload().catch(() => {});

    // Main-thread twin of the worker-side heartbeat: same cadence, this
    // isolate's heap. The FSA writes happen HERE (proxy sink callbacks), so a
    // main-thread heap climb is invisible to the worker's gauge and vice versa.
    const mainHeartbeat = createExportHeartbeat(log);

    const client = createTypedWorkerClient<TranscodeWorkerContract>(worker, {
        name: "transcode",
        onRequest: {
            [TRANSCODE_REQUEST_MAP_SNAPSHOT]: renderOneSnapshot,
            [TRANSCODE_REQUEST_HARDWARE_ACCELERATION]: answerHardwareAcceleration,
        },
        onNotification: (msg) => {
            if (msg.type === TRANSCODE_NOTIFY_PROGRESS) {
                const data = msg.data;
                mainHeartbeat(data.progress.framesDone, data.progress.bytesWritten);
                try {
                    onProgress(data.progress);
                } catch (cbErr) {
                    log.warn("onProgress threw", cbErr);
                }
                return;
            }
        },
    });

    async function renderOneSnapshot(request: MapSnapshotRequest): Promise<ImageBitmap> {
        if (client.disposed || signal.aborted) throw new DOMException("transcode cancelled", "AbortError");
        if (!mapConfig) throw new Error("map overlay config missing from export snapshot");
        const bitmap = await snapshotSession.snapshot({
            ...request,
            headingUp: mapConfig.mode === "chase",
            pitchDeg: mapConfig.pitchDeg,
            adaptiveZoom: mapConfig.adaptiveZoom,
        });
        if (client.disposed || signal.aborted) {
            bitmap.close();
            throw new DOMException("transcode cancelled", "AbortError");
        }
        return transfer(bitmap, [bitmap]);
    }

    // The worker asks only when the request deferred the decision; the
    // resolver owns its own cancellation (it rejects with AbortError).
    async function answerHardwareAcceleration(): Promise<HardwareAcceleration> {
        if (!resolveHardwareAcceleration) throw new Error("hardware acceleration was not deferred");
        if (client.disposed || signal.aborted) throw new DOMException("transcode cancelled", "AbortError");
        return resolveHardwareAcceleration();
    }

    // Lets the map rAF loop and chart hot-path skip work while the worker is writing,
    // so the main thread stays free for the proxy sink callbacks (where the FSA write actually
    // happens).
    state.transcodeInProgress = true;
    // CSS flag that hides the MapLibre canvas via display:none. The export modal visually overlays
    // the map, but the WebGL layer still repaints every frame, keeping the GPU busy (~60-65% on
    // Apple Silicon M-series). The encoder contends for the same GPU - display:none causes the
    // compositor to skip it, freeing the GPU for the encoder.
    if (typeof document !== "undefined") {
        document.body.classList.add("dc-transcode-busy");
    }

    const cleanup = (success: boolean): void => {
        client.dispose();
        void snapshotSession.dispose().catch((err: unknown) => {
            log.warn("snapshotter dispose threw", { err: err instanceof Error ? err.message : String(err) });
        });
        state.transcodeInProgress = false;
        if (typeof document !== "undefined") {
            document.body.classList.remove("dc-transcode-busy");
        }
        // If the worker is terminated before calling writer.close/abort, the proxy sink methods
        // never fire, writableFinalized hangs, and realWritable stays open (FSA temp file in hidden
        // state). On the success path sink.close already ran normally through the worker - skip
        // forceAbort then.
        if (!success) {
            writableForceAbort("transcode failed or cancelled").catch((err) => {
                log.warn("forceAbort threw", err);
            });
        }
    };

    const options = { signal, transfer: [writablePort] };
    const hardwareAccelerationDeferred = resolveHardwareAcceleration !== undefined;
    const resultPromise =
        request.type === TRANSCODE_REQUEST_SINGLE
            ? client.request(request.type, { args: request.args, writablePort, hardwareAccelerationDeferred }, options)
            : client.request(request.type, { args: request.args, writablePort, hardwareAccelerationDeferred }, options);

    return resultPromise.then(
        async (result) => {
            // On the success path the worker's writer.close() has already resolved via ack, but
            // the main side may still be applying the last writes (or, by default, finishing the
            // FSA atomic rename) - wait explicitly via writableFinalized before touching the
            // output: the post-process writes into it, and getFile() must see the final file.
            await writableFinalized.catch(() => undefined);
            try {
                if (beforeCommit) await beforeCommit(writable, result);
                await writableCommit();
            } catch (err) {
                // The output is still uncommitted: discard it like any other failure.
                cleanup(false);
                throw err;
            }
            cleanup(true);
            return result;
        },
        (err) => {
            cleanup(false);
            // A sink failure reaches us twice: once as the real object thrown
            // on THIS thread by the writable, and once as the plain Error the
            // worker rebuilt from the wire and rejected with. Re-throw the real
            // one - it is the only copy the export flow can classify (a
            // DOMException subclass, carrying our sink tag). Cancel is decided
            // by the signal, not the rejection's name: a user cancel aborts the
            // sink too (its complaint is fallout, and the flow must see the
            // AbortError), while a sink failure can surface from the worker AS
            // an AbortError when the pipeline tears itself down - the name
            // alone cannot tell the two apart.
            const sinkErr = writableSinkError();
            if (sinkErr && !signal.aborted) {
                log.warn("rethrowing the sink failure behind the worker error", {
                    worker: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
                });
                throw sinkErr;
            }
            throw err;
        },
    );
}

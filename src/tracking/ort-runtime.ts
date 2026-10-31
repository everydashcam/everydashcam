// Loader for the onnxruntime-web runtime the detectors run on. Two builds:
//
// - "wasm": the plain WASM EP - works everywhere, the floor of performance.
//   Both builds are multithreaded where the page is cross-origin isolated;
//   see threadCount.
// - "webgpu": ort's WebGPU EP (the asyncify wasm build), used by the plate
//   and face detectors to keep automatic detection within the pass budget.
//
// The two entries are separate module instances with separate env config; the
// unused one is never fetched (dynamic import). Follow uses "wasm" for
// ViTTrack; automatic detection uses "webgpu" for its requested detectors.
//
// Runs in a worker. No logging - loaded from per-pass hot paths.

import { type OrtAssets, ortAssetKey } from "./ort-assets.js";
import { loadAssetParts } from "./asset-loader.js";
import { TRACKER_ASSETS } from "./asset-manifest.js";

export type OrtRuntime = "webgpu" | "wasm";

/** Both bundles expose the same API; the wasm entry's types stand for both. */
export type OrtModule = typeof import("onnxruntime-web/wasm");

/** ORT does not distinguish recoverable inference errors from a lost WebGPU
 * device or aborted WASM module. Discard its worker after any inference failure;
 * decoding and preprocessing errors outside this boundary remain pass-local. */
export async function runOrtSession(
    session: Pick<import("onnxruntime-web/wasm").InferenceSession, "run">,
    feeds: import("onnxruntime-web/wasm").InferenceSession.FeedsType,
): Promise<import("onnxruntime-web/wasm").InferenceSession.ReturnType> {
    try {
        return await session.run(feeds);
    } catch (cause) {
        // No user AbortSignal enters session.run; even an AbortError here is
        // a runtime failure, not cancellation of the surrounding pass.
        const error = new Error(cause instanceof Error ? cause.message : String(cause), { cause });
        error.name = "OrtInferenceError";
        if (cause instanceof Error && cause.stack) error.stack = cause.stack;
        throw error;
    }
}

const cached = new Map<string, Promise<OrtModule>>();
/** Modules that created a session, so their runtime and thread pool started. */
const startedModules = new WeakSet<OrtModule>();

/** Name of a tracker worker whose runtimes stay on one thread. The page starts
 * one after a thread pool failed to start (src/ui/tracker-worker-client.ts);
 * the name is the only startup configuration a worker has before ORT loads. */
export const SINGLE_THREAD_TRACKER_WORKER_NAME = "tracker-worker-single-thread";

/** Budget for starting a thread pool, including compiling the runtime, which
 * takes seconds on a slow phone. A thread whose worker never loads (blocked by
 * headers, a failed download, memory) never reports in, and ORT would otherwise
 * wait for it forever. */
const THREAD_POOL_START_TIMEOUT_MS = 15_000;

/** WASM threads need SharedArrayBuffer, which only a cross-origin isolated
 * context has; elsewhere ORT runs on this worker alone. WebKit can report
 * isolation without exposing SharedArrayBuffer, and ORT then warns before it
 * falls back, so both are checked. Each thread is a module worker that loads
 * this runtime's own build chunk, which vite-plugins/ort-thread-chunks.ts keeps
 * free of imports. Half the cores, capped at four, leaves the rest to the video
 * decoder, the page and other workers, and every runtime instance starts its
 * own pool. Busy or few cores only make threads slower; one thread is for a
 * pool that could not start at all. */
function threadCount(): number {
    // WorkerGlobalScope.name; absent in Node tests and outside workers.
    if ((globalThis as { name?: unknown }).name === SINGLE_THREAD_TRACKER_WORKER_NAME) return 1;
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") return 1;
    return Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
}

/** Shares assembly between concurrent session requests, but lets a failed
 * download retry. The manifest pairs each module with its exact binary. */
async function loadOrt(runtime: OrtRuntime, assets: OrtAssets): Promise<OrtModule> {
    const key = `${runtime}|${ortAssetKey(assets)}`;
    const hit = cached.get(key);
    if (hit) return hit;
    const pending = (async () => {
        const module = (
            runtime === "webgpu" ? await import("onnxruntime-web/webgpu") : await import("onnxruntime-web/wasm")
        ) as OrtModule;
        const threads = threadCount();
        module.env.wasm.numThreads = threads;
        // Only a thread pool can stall initialization; one thread keeps ORT's
        // default of no timeout.
        if (threads > 1) module.env.wasm.initTimeout = THREAD_POOL_START_TIMEOUT_MS;
        // Official bundled ESM contains the matching glue. A URL override would
        // force ORT back to an independently fetched module.
        module.env.wasm.wasmBinary = await loadAssetParts(assets.wasm.parts);
        return module;
    })();
    cached.set(key, pending);
    try {
        return await pending;
    } catch (error) {
        cached.delete(key);
        throw error;
    }
}

export async function createOrtSession(
    runtime: OrtRuntime,
    assets: OrtAssets,
    modelUrl: string,
    options: import("onnxruntime-web/wasm").InferenceSession.SessionOptions,
) {
    let ort: OrtModule | undefined;
    try {
        ort = await loadOrt(runtime, assets);
        const model = Object.values(TRACKER_ASSETS.models).find(
            (asset) =>
                new URL(asset.url, globalThis.location.href).href === new URL(modelUrl, globalThis.location.href).href,
        );
        if (!model) throw new Error("model is absent from the build manifest");
        const session = await ort.InferenceSession.create(await loadAssetParts([model]), options);
        startedModules.add(ort);
        // The runtime is initialized and no longer needs its source bytes: the
        // glue hands threads, including ones it starts later, the compiled
        // module. Emscripten retains aliases to wasmBinary, so clearing env alone
        // cannot free them. Detach the backing store without retaining a new owner.
        const binary = ort.env.wasm.wasmBinary;
        if (binary instanceof Uint8Array && binary.buffer instanceof ArrayBuffer && binary.byteLength > 0) {
            structuredClone(null, { transfer: [binary.buffer] });
        }
        ort.env.wasm.wasmBinary = undefined;
        return { ort, session };
    } catch (cause) {
        // Initialization has no user AbortSignal. An AbortError here can leave
        // the native module unusable, just like any other initialization failure.
        if (cause instanceof Error && cause.name.startsWith("Asset")) throw cause;
        const error = new Error(cause instanceof Error ? cause.message : String(cause), { cause });
        // The first session starts the runtime. With a thread pool, its failure
        // may be a thread that never started, which one thread avoids; the page
        // retries once on a single-threaded worker and surfaces any repeat.
        const poolFailed = ort !== undefined && !startedModules.has(ort) && (ort.env.wasm.numThreads ?? 1) > 1;
        error.name = poolFailed ? "OrtThreadStartError" : "OrtInitializationError";
        if (cause instanceof Error && cause.stack) error.stack = cause.stack;
        throw error;
    }
}

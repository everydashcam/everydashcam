// Loader for the onnxruntime-web runtime the detectors run on. Two builds:
//
// - "wasm": the plain WASM EP - works everywhere, the floor of performance.
//   Both builds run single-threaded; see the numThreads note in loadOrt.
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
        // TODO: enable threads when ORT can start its own thread entry. The
        // hosted app is cross-origin isolated, but Emscripten starts each
        // thread as `new Worker(import.meta.url, { type: "module" })`. Vite
        // builds this worker as one IIFE with ORT inlined and replaces
        // import.meta.url with self.location.href, so a thread would boot the
        // whole tracker worker. ORT's thread entry sits behind the inlined
        // dynamic import and never runs, the load handshake never completes,
        // and initialization stays pending. Either ES-format workers or a
        // separately served ORT module could fix it; this needs a build decision.
        module.env.wasm.numThreads = 1;
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
    try {
        const ort = await loadOrt(runtime, assets);
        const model = Object.values(TRACKER_ASSETS.models).find(
            (asset) =>
                new URL(asset.url, globalThis.location.href).href === new URL(modelUrl, globalThis.location.href).href,
        );
        if (!model) throw new Error("model is absent from the build manifest");
        const session = await ort.InferenceSession.create(await loadAssetParts([model]), options);
        // The single-threaded runtime is initialized and no longer needs its source
        // bytes. Emscripten retains aliases to wasmBinary, so clearing env alone
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
        error.name = "OrtInitializationError";
        if (cause instanceof Error && cause.stack) error.stack = cause.stack;
        throw error;
    }
}

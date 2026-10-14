// Loader for the onnxruntime-web runtime the detectors run on. Two builds:
//
// - "wasm": the plain single-thread WASM EP - works everywhere, the floor of
//   performance (multithread needs crossOriginIsolated, which would break the
//   external map-tile fetches - same trade as vittrack.ts).
// - "webgpu": ort's WebGPU EP (the asyncify wasm build), used by the plate
//   and face detectors to keep automatic detection within the pass budget.
//
// The two entries are separate module instances with separate env config; the
// unused one is never fetched (dynamic import). Follow uses "wasm" for
// ViTTrack; automatic detection uses "webgpu" for its requested detectors.
//
// Runs in a worker. No logging - loaded from per-pass hot paths.

import type { OrtAssets } from "./ort-assets.js";
import { loadWasmParts } from "./wasm-parts.js";

export type OrtRuntime = "webgpu" | "wasm";

/** Both bundles expose the same API; the wasm entry's types stand for both. */
export type OrtModule = typeof import("onnxruntime-web/wasm");

const cached = new Map<string, Promise<OrtModule>>();

/** Shares assembly between concurrent session requests, but lets a failed
 * download retry. The manifest pairs each module with its exact binary. */
async function loadOrt(runtime: OrtRuntime, assets: OrtAssets): Promise<OrtModule> {
    const key = `${runtime}|${assets.moduleUrl}`;
    const hit = cached.get(key);
    if (hit) return hit;
    const pending = (async () => {
        const module = (
            runtime === "webgpu" ? await import("onnxruntime-web/webgpu") : await import("onnxruntime-web/wasm")
        ) as OrtModule;
        module.env.wasm.numThreads = 1;
        // Resolve from the worker's origin: its own module lives under /assets/.
        const mjs = new URL(assets.moduleUrl, globalThis.location.href).href;
        if ("parts" in assets.wasm) {
            module.env.wasm.wasmPaths = { mjs };
            module.env.wasm.wasmBinary = await loadWasmParts(assets.wasm.parts);
        } else {
            module.env.wasm.wasmPaths = { mjs, wasm: new URL(assets.wasm.url, globalThis.location.href).href };
        }
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
    const ort = await loadOrt(runtime, assets);
    const session = await ort.InferenceSession.create(modelUrl, options);
    // The single-threaded runtime is initialized and no longer needs its source
    // bytes. Emscripten retains aliases to wasmBinary, so clearing env alone
    // cannot free them. Detach the backing store without retaining a new owner.
    const binary = ort.env.wasm.wasmBinary;
    if (binary instanceof Uint8Array && binary.buffer instanceof ArrayBuffer && binary.byteLength > 0) {
        structuredClone(null, { transfer: [binary.buffer] });
    }
    ort.env.wasm.wasmBinary = undefined;
    return { ort, session };
}

import { env } from "onnxruntime-web/webgpu";
import type { OrtAssets } from "../../src/tracking/ort-assets.js";
import { createOrtSession } from "../../src/tracking/ort-runtime.js";

// Observe the real configuration boundary without replacing the runtime. Keep
// the original views alive, just as Emscripten does, to detect retained bytes.
const binaries: Uint8Array[] = [];
let loadedBinaryBytes = 0;
let currentBinary: typeof env.wasm.wasmBinary;
Object.defineProperty(env.wasm, "wasmBinary", {
    get: () => currentBinary,
    set(value: typeof currentBinary) {
        currentBinary = value;
        if (value instanceof Uint8Array) {
            binaries.push(value);
            loadedBinaryBytes += value.byteLength;
        }
    },
});

async function infer(assets: OrtAssets, modelUrl: string) {
    const { ort, session } = await createOrtSession("webgpu", assets, modelUrl, {
        executionProviders: ["wasm"],
    });
    try {
        const template = new ort.Tensor("float32", new Float32Array(3 * 128 * 128), [1, 3, 128, 128]);
        const search = new ort.Tensor("float32", new Float32Array(3 * 256 * 256), [1, 3, 256, 256]);
        try {
            const result = await session.run({ template, search });
            try {
                return Object.fromEntries(
                    Object.entries(result).map(([name, tensor]) => [
                        name,
                        {
                            dims: tensor.dims,
                            finite: Array.from(tensor.data as Float32Array).every(Number.isFinite),
                        },
                    ]),
                );
            } finally {
                for (const tensor of Object.values(result)) tensor.dispose();
            }
        } finally {
            template.dispose();
            search.dispose();
        }
    } finally {
        await session.release();
    }
}

/** Exercise the production loader with real asyncify WASM and real inference.
 * The CPU execution provider keeps this asset test independent of GPU drivers. */
self.onmessage = async (event: MessageEvent<{ assets: OrtAssets; modelUrl: string }>) => {
    try {
        const { assets, modelUrl } = event.data;
        const outputs = await infer(assets, modelUrl);
        // A second session must reuse the compiled runtime after the source
        // binary is detached, without assembling it again.
        const reusedOutputs = await infer(assets, modelUrl);
        self.postMessage({
            ok: true,
            outputs,
            reusedOutputs,
            binaryReleased: env.wasm.wasmBinary === undefined,
            loadedBinaryBytes,
            retainedBinaryBytes: binaries.reduce((total, binary) => total + binary.buffer.byteLength, 0),
        });
    } catch (error) {
        self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
};

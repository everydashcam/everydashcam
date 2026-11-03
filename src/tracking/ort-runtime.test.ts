import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { TRACKER_ASSETS } from "./asset-manifest.js";
import { createOrtSession, runOrtSession, SINGLE_THREAD_TRACKER_WORKER_NAME } from "./ort-runtime.js";

afterEach(() => vi.unstubAllGlobals());

it.each(["webgpu", { name: "webgpu" }] as const)(
    "rejects incompatible WebGPU provider %j before loading assets without trying a thread fallback",
    async (provider) => {
        vi.stubGlobal("crossOriginIsolated", true);
        vi.stubGlobal("navigator", { hardwareConcurrency: 8, gpu: { requestAdapter: async () => ({}) } });
        const fetch = vi.fn();
        vi.stubGlobal("fetch", fetch);
        await expect(
            createOrtSession("webgpu", TRACKER_ASSETS.ort.webgpu, TRACKER_ASSETS.models.face.url, {
                executionProviders: [provider],
            }),
        ).rejects.toMatchObject({ name: "WebGpuUnavailableError" });
        expect(fetch).not.toHaveBeenCalled();
    },
);

it.each(["wasm", "webgpu"] as const)(
    "runs CPU sessions without WebGPU in the %s bundle and preserves initialization errors",
    async (runtime) => {
        const cause = new DOMException("initialization aborted", "AbortError");
        vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => null } });
        vi.stubGlobal("fetch", async () => {
            throw cause;
        });
        await expect(
            createOrtSession(runtime, TRACKER_ASSETS.ort[runtime], TRACKER_ASSETS.models.tracker.url, {
                executionProviders: ["wasm"],
            }),
        ).rejects.toMatchObject({
            name: "OrtInitializationError",
            message: cause.message,
            cause,
        });
    },
);

it.each([
    new WebAssembly.RuntimeError("unreachable"),
    new DOMException("device lost", "OperationError"),
    new DOMException("runtime aborted", "AbortError"),
    "native inference failed",
])("marks a native inference failure for worker replacement: %s", async (cause) => {
    const result = runOrtSession(
        {
            async run() {
                throw cause;
            },
        },
        {},
    );
    await expect(result).rejects.toMatchObject({
        name: "OrtInferenceError",
        message: cause instanceof Error ? cause.message : cause,
        cause,
        ...(cause instanceof Error ? { stack: cause.stack } : {}),
    });
});

it("starts the single-threaded fallback worker under the name the runtime checks", () => {
    // Vite needs literal worker options, so the page repeats the name.
    const client = readFileSync(new URL("../ui/tracker-worker-client.ts", import.meta.url), "utf8");
    expect(client).toContain(`name: "${SINGLE_THREAD_TRACKER_WORKER_NAME}"`);
});

import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { TRACKER_ASSETS } from "./asset-manifest.js";
import { createOrtSession, runOrtSession, SINGLE_THREAD_TRACKER_WORKER_NAME } from "./ort-runtime.js";

afterEach(() => vi.unstubAllGlobals());

it("does not treat an initialization AbortError as user cancellation", async () => {
    const cause = new DOMException("initialization aborted", "AbortError");
    vi.stubGlobal("fetch", async () => {
        throw cause;
    });
    await expect(
        createOrtSession("wasm", TRACKER_ASSETS.ort.wasm, TRACKER_ASSETS.models.tracker.url, {}),
    ).rejects.toMatchObject({
        name: "OrtInitializationError",
        message: cause.message,
        cause,
    });
});

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

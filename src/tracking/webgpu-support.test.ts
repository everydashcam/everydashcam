import { afterEach, expect, it, vi } from "vitest";
import { requireDetectionWebGpu } from "./webgpu-support.js";

afterEach(() => vi.unstubAllGlobals());

it.each([undefined, {}, { gpu: {} }, { gpu: { requestAdapter: async () => null } }])(
    "rejects an unavailable WebGPU API: %j",
    async (navigator) => {
        vi.stubGlobal("navigator", navigator);
        await expect(requireDetectionWebGpu()).rejects.toMatchObject({ name: "WebGpuUnavailableError" });
    },
);

it.each([{}, { info: undefined }, { info: null }])("rejects adapters without synchronous info: %j", async (adapter) => {
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => adapter } });
    await expect(requireDetectionWebGpu()).rejects.toMatchObject({ name: "WebGpuUnavailableError" });
});

it("accepts adapter info without subgroup sizes or identifying strings", async () => {
    vi.stubGlobal("navigator", {
        gpu: { requestAdapter: async () => ({ info: { vendor: "", architecture: "", device: "", description: "" } }) },
    });
    await expect(requireDetectionWebGpu()).resolves.toBeUndefined();
});

it("preserves the cause when acquiring the adapter fails", async () => {
    const cause = new DOMException("adapter unavailable", "OperationError");
    vi.stubGlobal("navigator", {
        gpu: {
            requestAdapter: async () => {
                throw cause;
            },
        },
    });
    await expect(requireDetectionWebGpu()).rejects.toMatchObject({ name: "WebGpuUnavailableError", cause });
});

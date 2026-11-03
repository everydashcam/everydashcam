export function webGpuUnavailableError(cause?: unknown): Error {
    const error = new Error("webgpu is unavailable for automatic detection", { cause });
    error.name = "WebGpuUnavailableError";
    return error;
}

/** ORT 1.31's native WebGPU bridge reads device.adapterInfo, falling back to
 * adapter.info when the device property is absent. Older implementations can
 * return an adapter without either API, then crash reading subgroupMinSize.
 * Check in both the page and worker; an adapter on the page does not establish
 * worker support. Subgroup sizes themselves are optional; GPU identity strings
 * may be empty. No model or GPU device is created by this probe. */
export async function requireDetectionWebGpu(): Promise<void> {
    try {
        const adapter = typeof navigator !== "undefined" ? await navigator.gpu?.requestAdapter() : null;
        const info = adapter && "info" in adapter ? adapter.info : undefined;
        if (!info || typeof info !== "object") throw new Error("webgpu adapter info is unavailable");
    } catch (cause) {
        throw webGpuUnavailableError(cause);
    }
}

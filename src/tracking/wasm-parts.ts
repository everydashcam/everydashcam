import type { WasmPart } from "./ort-assets.js";

/** Assemble directly into one buffer: retaining every response body would
 * double the temporary memory cost on phones. Verify each immutable piece
 * before handing the complete binary to ONNX Runtime. */
export async function loadWasmParts(
    parts: readonly WasmPart[],
    signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
    signal?.throwIfAborted();
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.bytes, 0));
    let offset = 0;
    for (const part of parts) {
        signal?.throwIfAborted();
        const target = bytes.subarray(offset, offset + part.bytes);
        if (!(await readPart(part, target, signal))) {
            // A bad immutable cache entry must not poison every later attempt.
            // The service worker honors reload for tracker assets as well.
            if (!(await readPart(part, target, signal, "reload"))) {
                throw new Error("wasm part integrity mismatch");
            }
        }
        offset += part.bytes;
    }
    return bytes;
}

async function readPart(
    part: WasmPart,
    target: Uint8Array<ArrayBuffer>,
    signal?: AbortSignal,
    cache?: RequestCache,
): Promise<boolean> {
    const response = await fetch(part.url, {
        signal,
        cache,
        headers: cache === "reload" ? { "x-everydashcam-wasm-repair": "1" } : undefined,
    });
    if (response.status !== 200 || response.redirected || !response.body) {
        throw new Error(`wasm part request failed: ${response.status}`);
    }
    const reader = response.body.getReader();
    let received = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            signal?.throwIfAborted();
            if (done) break;
            if (received + value.byteLength > target.byteLength) {
                await reader.cancel();
                return false;
            }
            target.set(value, received);
            received += value.byteLength;
        }
    } finally {
        reader.releaseLock();
    }
    if (received !== target.byteLength) return false;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", target));
    const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return hash === part.sha256;
}

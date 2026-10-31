import { combineAbortSignals } from "../abort-signals.js";
import type { AssetPart } from "./ort-assets.js";

const STALL_TIMEOUT_MS = 30_000;

/** One assembly buffer, one bounded integrity repair, and no persistent cache
 * ownership here. Both warming and inference verify the exact same manifest. */
export async function loadAssetParts(
    parts: readonly AssetPart[],
    signal?: AbortSignal,
    onProgress?: (fraction: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
    signal?.throwIfAborted();
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.bytes, 0));
    let offset = 0;
    for (const part of parts) {
        signal?.throwIfAborted();
        const target = bytes.subarray(offset, offset + part.bytes);
        const progress = (received: number) => onProgress?.((offset + received) / bytes.length);
        if (!(await readPart(part, target, progress, signal))) {
            if (!(await readPart(part, target, progress, signal, true))) {
                throw new DOMException(`asset integrity mismatch: ${part.url}`, "AssetIntegrityError");
            }
        }
        offset += part.bytes;
        onProgress?.(offset / bytes.length);
    }
    signal?.throwIfAborted();
    return bytes;
}

async function readPart(
    part: AssetPart,
    target: Uint8Array<ArrayBuffer>,
    progress: (received: number) => void,
    signal?: AbortSignal,
    repair = false,
): Promise<boolean> {
    const controller = new AbortController();
    const combined = combineAbortSignals(signal ? [signal, controller.signal] : [controller.signal]);
    const merged = combined.signal;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(
            () => controller.abort(new DOMException("asset download stalled", "TimeoutError")),
            STALL_TIMEOUT_MS,
        );
    };
    arm();
    try {
        // An older controlling SW may ignore repair headers. A fresh URL also
        // bypasses its key; current workers store the response under the canonical URL.
        const url = repair ? `${part.url}?__dc_repair=${crypto.randomUUID()}` : part.url;
        const response = await fetch(url, {
            signal: merged,
            cache: repair ? "reload" : undefined,
            // Keep the published protocol: a new page may still use an old SW.
            headers: repair ? { "x-everydashcam-wasm-repair": "1" } : undefined,
        });
        merged.throwIfAborted();
        const htmlFallback =
            response.status === 200 &&
            /text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") ?? "");
        if ([404, 410].includes(response.status) || htmlFallback) {
            void response.body?.cancel().catch(() => {});
            // Legacy SW/HTTP caches can hold a successful HTML fallback from an
            // incomplete deployment. Try fresh bytes before asking for an update.
            if (htmlFallback && !repair) return false;
            throw new DOMException(`asset version unavailable: ${part.url}`, "AssetUnavailableError");
        }
        if (response.status !== 200 || response.redirected || !response.body) {
            void response.body?.cancel().catch(() => {});
            throw new DOMException(`asset request failed: ${response.status} ${part.url}`, "AssetDownloadError");
        }
        const reader = response.body.getReader();
        let received = 0;
        const abort = () => {
            void reader.cancel(merged.reason).catch(() => {});
        };
        merged.addEventListener("abort", abort, { once: true });
        try {
            for (;;) {
                arm();
                const { done, value } = await reader.read();
                merged.throwIfAborted();
                if (done) break;
                if (received + value.byteLength > target.byteLength) {
                    void reader.cancel().catch(() => {});
                    return false;
                }
                target.set(value, received);
                received += value.byteLength;
                progress(received);
            }
        } finally {
            merged.removeEventListener("abort", abort);
            reader.releaseLock();
        }
        if (received !== target.byteLength) return false;
        clearTimeout(timer!);
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", target));
        merged.throwIfAborted();
        const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
        return hash === part.sha256;
    } catch (error) {
        if (merged.aborted) throw merged.reason;
        if (error instanceof TypeError) {
            throw new DOMException(`asset download failed: ${part.url}: ${error.message}`, "AssetDownloadError");
        }
        throw error;
    } finally {
        clearTimeout(timer!);
        combined.dispose();
    }
}

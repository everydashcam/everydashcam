// Shared abort-aware whole-file readers for sidecar handlers. Every handler
// checks the signal before paying for the read and again after resuming, so a
// cancelled ingest stops at the seam instead of parsing a file nobody is
// waiting for - the checks live here so a handler cannot forget one of them.

import type { VendorFile } from "../types.js";

/** Reads a sidecar's text, optionally limited to a prefix, with the standard abort seams. */
export async function readSidecarText(file: VendorFile, signal?: AbortSignal, maxBytes?: number): Promise<string> {
    throwIfAborted(signal);
    const text = await (maxBytes === undefined ? file.file : file.file.slice(0, maxBytes)).text();
    throwIfAborted(signal);
    return text;
}

/** Reads a sidecar's full bytes with the standard abort seams. */
export async function readSidecarBytes(file: VendorFile, signal?: AbortSignal): Promise<ArrayBuffer> {
    throwIfAborted(signal);
    const buf = await file.file.arrayBuffer();
    throwIfAborted(signal);
    return buf;
}

// Hand-rolled instead of the native signal.throwIfAborted() to keep the
// exact DOMException message the handlers have always thrown.
function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
}

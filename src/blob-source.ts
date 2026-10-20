import { BlobSource } from "mediabunny";

import { createLogger } from "./log.js";
import { maskTsDtsStreams } from "./ts-program-map.js";
import { clampTsTrailingBytes } from "./ts-trailer.js";
import { isTransportStreamName } from "./video-format-names.js";

const log = createLogger("media-source");

/**
 * The bytes of a recording that mediabunny should demux. A .ts file loses the
 * bytes past its last whole packet (ts-trailer.ts) and the DTS typing of
 * private streams (ts-program-map.ts); any other file is returned as is. A
 * changed view is a plain Blob without the File name.
 */
export async function demuxView(blob: Blob): Promise<Blob> {
    if (!(blob instanceof File) || !isTransportStreamName(blob.name)) return blob;
    return maskTsDtsStreams(await clampTsTrailingBytes(blob));
}

/** Background prefetch can fail after the requested bytes already reached the caller. */
export function createBackgroundReadErrorHandler(blob: Blob, signal?: AbortSignal): (err: unknown) => void {
    let reported = false;
    return (err) => {
        if (signal?.aborted || reported) return;
        reported = true;
        // Keep cached data usable. A later demand read still rejects normally if the source remains unreadable.
        log.warn("background source read failed", {
            file: blob instanceof File ? blob.name : undefined,
            err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
    };
}

/** The signal suppresses cancelled-operation diagnostics; the caller still owns Input disposal. */
export async function createBlobSource(blob: Blob, signal?: AbortSignal): Promise<BlobSource> {
    return new BlobSource(await demuxView(blob), {
        handleUnhandledError: createBackgroundReadErrorHandler(blob, signal),
    });
}

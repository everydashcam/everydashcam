import { BlobSource } from "mediabunny";

import { createLogger } from "./log.js";
import { OPENPILOT_FRAME_RATE } from "./parsers/internal/openpilot.js";
import { rawHevcMp4View } from "./raw-hevc-view.js";
import { maskTsDtsStreams } from "./ts-program-map.js";
import { clampTsTrailingBytes } from "./ts-trailer.js";
import { isRawHevcName, isTransportStreamName } from "./video-format-names.js";

const log = createLogger("media-source");

/**
 * The bytes of a recording that mediabunny should demux. A .ts file loses the
 * bytes past its last whole packet (ts-trailer.ts) and the DTS typing of
 * private streams (ts-program-map.ts). A raw .hevc stream is presented as an
 * MP4 that references its bytes (raw-hevc-view.ts); building it reads the
 * file once, so it happens here, on first demux, not at ingest. Any other file
 * is returned as is. A changed view is a plain Blob without the File name.
 */
export async function demuxView(blob: Blob): Promise<Blob> {
    if (!(blob instanceof File)) return blob;
    if (isRawHevcName(blob.name)) {
        // Ingest admits raw HEVC only under the openpilot route layout
        // (registry-light.ts isVideoFile), whose streams all run at its rate.
        return await rawHevcMp4View(blob, OPENPILOT_FRAME_RATE);
    }
    if (!isTransportStreamName(blob.name)) return blob;
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

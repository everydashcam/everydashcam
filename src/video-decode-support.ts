// WebCodecs decode-support probe for indexed video streams. Calls
// VideoDecoder.isConfigSupported directly so opening a recording on the main
// thread does not load mediabunny; the indexer supplies the RFC 6381 string
// (avcC/hvcC for MP4, the demuxer's string for TS/MKV) and the frame size.

import type { VideoCodec } from "./mediabunny.js";

/** What the indexer knows about a video stream's decoder requirements. */
export interface VideoStreamDecodeQuery {
    codec: VideoCodec;
    // Full RFC 6381 string with profile and level, or null when the indexer
    // could not derive one.
    codecString: string | null;
    width: number | null;
    height: number | null;
}

/**
 * Resolves whether this browser's WebCodecs can decode the stream. Without a
 * codec string the answer is optimistic (true), as for an unknown codec: the
 * player and export report a real decode failure where it happens. Resolves
 * false when WebCodecs is absent. Rejects only if the browser's probe itself
 * rejects (a malformed config); callers decide how that affects playback.
 */
export async function canDecodeVideoStream(query: VideoStreamDecodeQuery): Promise<boolean> {
    if (!query.codecString) return true;
    if (typeof VideoDecoder === "undefined") return false;
    const config: VideoDecoderConfig = { codec: query.codecString };
    if (isPositiveInteger(query.width) && isPositiveInteger(query.height)) {
        config.codedWidth = query.width;
        config.codedHeight = query.height;
    }
    const support = await VideoDecoder.isConfigSupported(config);
    return support.supported === true;
}

/** Cache key for a decode-support verdict; equal keys get equal answers. */
export function videoStreamDecodeKey(query: VideoStreamDecodeQuery): string {
    return `${query.codecString ?? query.codec}@${query.width ?? 0}x${query.height ?? 0}`;
}

function isPositiveInteger(value: number | null): value is number {
    return value !== null && Number.isInteger(value) && value > 0;
}

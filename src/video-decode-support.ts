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
 * Whether this context exposes WebCodecs video decoding. Browsers hide it
 * outside secure contexts, such as a plain-HTTP address on the local network.
 * A caller that plays through the native video element has no verdict to take
 * from the probe then.
 */
export function hasWebCodecsVideoDecoder(): boolean {
    return typeof VideoDecoder !== "undefined";
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
    if (!hasWebCodecsVideoDecoder()) return false;
    const config: VideoDecoderConfig = { codec: webCodecsCodecString(query.codecString) };
    if (isPositiveInteger(query.width) && isPositiveInteger(query.height)) {
        config.codedWidth = query.width;
        config.codedHeight = query.height;
    }
    const support = await VideoDecoder.isConfigSupported(config);
    return support.supported === true;
}

// WebKit's VideoDecoder accepts H.264 only under the "avc1." prefix and
// reports an "avc3." string as unsupported. The sample entry says where the
// parameter sets live, not what the decoder must handle, so an avc3 stream is
// probed as the same profile and level under "avc1.".
function webCodecsCodecString(codecString: string): string {
    return codecString.startsWith("avc3.") ? `avc1.${codecString.slice("avc3.".length)}` : codecString;
}

/** Cache key for a decode-support verdict; equal keys get equal answers. */
export function videoStreamDecodeKey(query: VideoStreamDecodeQuery): string {
    return `${query.codecString ?? query.codec}@${query.width ?? 0}x${query.height ?? 0}`;
}

function isPositiveInteger(value: number | null): value is number {
    return value !== null && Number.isInteger(value) && value > 0;
}

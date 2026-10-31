// Native playback tolerates empty access units that WebCodecs rejects. Remux
// affected sources without those packets before decoding, preserving timestamps.
// Healthy MP4s only need a metadata scan; Matroska also benefits from normalization.

import { throwIfCancelled } from "../abort-signals.js";
import {
    AppendOnlyStreamTarget,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    Mp4OutputFormat,
    Output,
} from "mediabunny";
import { createLogger } from "../log.js";
import { createRetryingBlobSource } from "../retrying-blob-source.js";
import { isSourceReadError } from "../source-read-error.js";
import { isMatroskaName } from "../video-format-names.js";
import { VIDEO_INPUT_FORMATS } from "../video-formats.js";

const log = createLogger("normalize-video");
const MAX_CACHED_SOURCES = 4;

// Max byte length of a video packet treated as an empty/phantom access unit and
// dropped. A real coded H.264/HEVC picture - even a tiny P-frame - is well above
// this; only a bare length-prefix (a zero-length NAL, ~4 bytes) falls under it.
// Single source of truth: export.ts's stream-copy loop imports this constant.
export const DEGENERATE_VIDEO_PACKET_MAX_BYTES = 4;

export interface VideoSourceResolver {
    /**
     * Returns a stream-copy MP4 with empty packets dropped when necessary.
     * Healthy MP4s and unsupported containers retain their original File identity.
     *
     * A malformed stream falls back to the original. Cancellation and source
     * read failures propagate so they cannot be mistaken for a damaged stream.
     */
    resolve(file: File): Promise<File>;
}

/**
 * Memoizes the most recent sources per export so repeated timeline intervals
 * reuse a normalized file without retaining every clip of a long trip.
 */
export function createVideoSourceResolver(signal?: AbortSignal): VideoSourceResolver {
    // Cache the PROMISE (not the File) so concurrent slots/segments asking for the
    // same file dedupe onto one remux.
    const cache = new Map<File, Promise<File>>();
    return {
        resolve(file: File): Promise<File> {
            if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
            if (!isMatroskaName(file.name) && !/\.(mp4|mov|m4v)$/i.test(file.name)) return Promise.resolve(file);
            let pending = cache.get(file);
            if (!pending) {
                pending = normalizeToCleanMp4(file, signal).catch((err) => {
                    if (err instanceof DOMException && err.name === "AbortError") throw err;
                    if (isSourceReadError(err)) throw err;
                    log.warn("degenerate-video normalize failed, using original source", {
                        file: file.name,
                        err: err instanceof Error ? err.message : String(err),
                    });
                    return file;
                });
                cache.set(file, pending);
                while (cache.size > MAX_CACHED_SOURCES) cache.delete(cache.keys().next().value!);
            }
            cache.delete(file);
            cache.set(file, pending);
            return pending;
        },
    };
}

/**
 * Stream-copies `file`'s primary video track into an in-memory MP4, dropping
 * degenerate packets. Timestamps are preserved verbatim so the pipeline's
 * file-time seg range still addresses the same frames on the clean copy. Returns
 * the original file untouched when there is nothing to normalize or the copy is
 * not possible (no video track / unreadable codec config / unmuxable codec).
 */
async function normalizeToCleanMp4(file: File, signal?: AbortSignal): Promise<File> {
    const input = new Input({ source: createRetryingBlobSource(file, signal), formats: VIDEO_INPUT_FORMATS });
    let output: Output | null = null;
    try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) return file;
        const codec = await track.getCodec();
        // The decoder config rides the first packet into the output moov; without
        // it the muxer throws. A null here means the source is not cleanly
        // stream-copyable - fall back rather than fail the export.
        const decoderConfig = await track.getDecoderConfig();
        if (!codec || !decoderConfig) return file;
        const transformationMatrix = await track.getTransformationMatrix();

        const sink = new EncodedPacketSink(track);
        if (!isMatroskaName(file.name)) {
            let packet = await sink.getFirstPacket({ metadataOnly: true });
            while (packet && packet.byteLength > DEGENERATE_VIDEO_PACKET_MAX_BYTES) {
                throwIfCancelled(signal);
                packet = await sink.getNextPacket(packet, { metadataOnly: true });
            }
            if (!packet) return file;
        }

        // Blob chunks avoid a contiguous full-file allocation for large camera clips.
        const chunks: Blob[] = [];
        const target = new AppendOnlyStreamTarget(
            new WritableStream<Uint8Array>({
                write(data) {
                    chunks.push(new Blob([new Uint8Array(data)]));
                },
            }),
        );
        output = new Output({ format: new Mp4OutputFormat({ fastStart: "fragmented" }), target });
        const videoSource = new EncodedVideoPacketSource(codec);
        output.addVideoTrack(videoSource, { transformationMatrix });
        await output.start();

        // verifyKeyPackets bitstream-checks the key/delta flag we copy verbatim
        // into the output sync-sample table - a mislabeled source flag would
        // otherwise corrupt seeking on the clean copy (same rationale as export.ts).
        let packet = await sink.getFirstPacket({ verifyKeyPackets: true });
        let pushedAny = false;
        let dropped = 0;
        while (packet) {
            throwIfCancelled(signal);
            if (packet.byteLength <= DEGENERATE_VIDEO_PACKET_MAX_BYTES) {
                dropped++;
                packet = await sink.getNextPacket(packet, { verifyKeyPackets: true });
                continue;
            }
            // Packets arrive in decode order with presentation timestamps; B-frames
            // are reordered by the muxer automatically. The decoder config is pushed
            // once, with the first kept packet.
            await videoSource.add(packet, pushedAny ? undefined : { decoderConfig });
            pushedAny = true;
            packet = await sink.getNextPacket(packet, { verifyKeyPackets: true });
        }
        await output.finalize();

        if (!pushedAny || chunks.length === 0) return file;
        const cleaned = new File(chunks, `${file.name}.clean.mp4`, { type: "video/mp4" });
        log.info("normalized degenerate video to clean mp4", {
            file: file.name,
            droppedPackets: dropped,
            bytes: cleaned.size,
        });
        return cleaned;
    } finally {
        input.dispose();
        if (output && output.state !== "finalized") await output.cancel();
    }
}

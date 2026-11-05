// zstd frames shaped like openpilot's loggerd output, for tests: written as a
// stream, so the header carries a window instead of the content size, and cut
// short the way a crash or an interrupted download leaves them.

import { constants, zstdCompressSync } from "node:zlib";

/** One zstd frame without a content size, as a streaming writer produces. */
export function streamedZstd(bytes: Uint8Array): Uint8Array {
    return zstdCompressSync(bytes, { params: { [constants.ZSTD_c_contentSizeFlag]: 0 } });
}

/**
 * The frame cut in the middle of its last block, so every earlier block stays
 * whole. Only for frames from streamedZstd: no dictionary, no content size.
 * Throws when the frame has a single block, which leaves nothing to keep.
 */
export function cutInsideLastBlock(frame: Uint8Array): Uint8Array<ArrayBuffer> {
    // Magic, frame header descriptor, window descriptor.
    let position = 6;
    let blocks = 0;
    for (;;) {
        const header = frame[position]! | (frame[position + 1]! << 8) | (frame[position + 2]! << 16);
        const isLast = (header & 1) === 1;
        const type = (header >> 1) & 3;
        const size = type === 1 ? 1 : header >> 3;
        blocks++;
        if (isLast) {
            if (blocks === 1) throw new Error("a single-block frame has no whole block to keep");
            return new Uint8Array(frame.subarray(0, position + 3 + Math.floor(size / 2)));
        }
        position += 3 + size;
    }
}

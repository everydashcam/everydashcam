// zstd decompression for logs that may be cut short. A writer that streams
// one frame and closes it only on exit (openpilot's loggerd) leaves the frame
// without its last blocks after a crash, a power loss or an interrupted
// download, and a one-shot decoder rejects the whole file. Blocks decode in
// order, so everything before the cut is still usable.
//
// fzstd allocates each frame's whole window when it reads that frame's header,
// before the frame yields any output, so an output limit alone cannot stop a
// few bytes of crafted header from claiming gigabytes. Every frame header is
// checked against the limit before decoding: a walk over frame and block
// headers, without decompressing anything.

const ZSTD_FRAME_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export type ZstdPrefixResult =
    | { kind: "decoded"; bytes: Uint8Array; complete: boolean }
    | { kind: "invalid" }
    | { kind: "too-large" };

/**
 * Decompresses a zstd stream, keeping the decoded prefix of a truncated or
 * damaged one ("decoded" with complete: false). "invalid" when nothing decodes,
 * "too-large" when any frame's window or the output would pass
 * maxOutputBytes. Errors other than fzstd's own decode errors propagate.
 * Loads fzstd on first use.
 */
export async function inflateZstdPrefix(compressed: Uint8Array, maxOutputBytes: number): Promise<ZstdPrefixResult> {
    const windowBytes = largestFrameWindowBytes(compressed);
    if (windowBytes === null) return { kind: "invalid" };
    if (windowBytes > maxOutputBytes) return { kind: "too-large" };

    const { Decompress } = await import("fzstd");
    const chunks: Uint8Array[] = [];
    let total = 0;
    let tooLarge = false;
    const stream = new Decompress((chunk) => {
        total += chunk.length;
        if (total > maxOutputBytes) {
            tooLarge = true;
            throw new RangeError("zstd output passes its limit");
        }
        // fzstd may hand out views of its own buffers; keep a copy.
        chunks.push(chunk.slice());
    });
    let complete = true;
    try {
        stream.push(compressed, true);
    } catch (err) {
        if (tooLarge) return { kind: "too-large" };
        if (!isZstdDecodeError(err)) throw err;
        complete = false;
    }
    if (!complete && total === 0) return { kind: "invalid" };
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return { kind: "decoded", bytes, complete };
}

/** fzstd tags its decode errors (bad data, early end) with a numeric code. */
function isZstdDecodeError(err: unknown): boolean {
    return err instanceof Error && typeof (err as { code?: unknown }).code === "number";
}

/**
 * The most bytes any frame of the stream asks the decoder to hold up front
 * (RFC 8878 3.1.1): its window, or its whole content for a single-segment
 * frame. Walks frame headers, block headers and skippable frames up to the
 * first that does not fit in the bytes present; the decoder stops there too.
 * null when the stream does not open with a zstd frame.
 */
function largestFrameWindowBytes(stream: Uint8Array): number | null {
    let largest: number | null = null;
    let position = 0;
    while (position + 4 <= stream.length) {
        if (isSkippableFrameMagic(stream, position)) {
            if (largest === null || position + 8 > stream.length) break;
            position += 8 + readUintLE(stream, position + 4, 4);
            continue;
        }
        const header = readFrameHeader(stream, position);
        if (!header) break;
        largest = Math.max(largest ?? 0, header.windowBytes);
        const end = frameEnd(stream, position + header.bytes, header.hasChecksum);
        if (end === null) break;
        position = end;
    }
    return largest;
}

function isSkippableFrameMagic(stream: Uint8Array, at: number): boolean {
    // 0x184D2A50..0x184D2A5F, little-endian.
    return (
        (stream[at]! & 0xf0) === 0x50 && stream[at + 1] === 0x2a && stream[at + 2] === 0x4d && stream[at + 3] === 0x18
    );
}

/** A frame header at `at`: its length, its window and whether a checksum
 *  follows the last block. null without the frame magic or past the end. */
function readFrameHeader(
    stream: Uint8Array,
    at: number,
): { bytes: number; windowBytes: number; hasChecksum: boolean } | null {
    if (at + 5 > stream.length || ZSTD_FRAME_MAGIC.some((byte, i) => stream[at + i] !== byte)) return null;
    const descriptor = stream[at + 4]!;
    const isSingleSegment = (descriptor & 0x20) !== 0;
    const windowDescriptorBytes = isSingleSegment ? 0 : 1;
    const dictionaryIdBytes = [0, 1, 2, 4][descriptor & 3]!;
    const contentSizeBytes = (isSingleSegment ? [1, 2, 4, 8] : [0, 2, 4, 8])[descriptor >> 6]!;
    const bytes = 5 + windowDescriptorBytes + dictionaryIdBytes + contentSizeBytes;
    if (at + bytes > stream.length) return null;
    let windowBytes: number;
    if (isSingleSegment) {
        const contentSize = readUintLE(stream, at + 5 + dictionaryIdBytes, contentSizeBytes);
        // The two-byte field stores the size minus 256.
        windowBytes = contentSizeBytes === 2 ? contentSize + 256 : contentSize;
    } else {
        const windowDescriptor = stream[at + 5]!;
        const base = 2 ** (10 + (windowDescriptor >> 3));
        windowBytes = base + (base / 8) * (windowDescriptor & 7);
    }
    return { bytes, windowBytes, hasChecksum: (descriptor & 0x04) !== 0 };
}

/** Offset just past a frame's last block and checksum, given where its first
 *  block header sits. null when the frame is cut short or malformed. */
function frameEnd(stream: Uint8Array, firstBlock: number, hasChecksum: boolean): number | null {
    let position = firstBlock;
    for (;;) {
        if (position + 3 > stream.length) return null;
        const header = readUintLE(stream, position, 3);
        const type = (header >> 1) & 3;
        if (type === 3) return null; // reserved block type
        // An RLE block stores its one repeated byte; the size field counts output.
        position += 3 + (type === 1 ? 1 : header >> 3);
        if ((header & 1) === 1) break;
    }
    position += hasChecksum ? 4 : 0;
    return position <= stream.length ? position : null;
}

function readUintLE(bytes: Uint8Array, at: number, length: number): number {
    let value = 0;
    for (let i = length - 1; i >= 0; i--) value = value * 256 + bytes[at + i]!;
    return value;
}

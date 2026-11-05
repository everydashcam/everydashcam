// zstd decompression for logs that may be cut short. A writer that streams
// one frame and closes it only on exit (openpilot's loggerd) leaves the frame
// without its last blocks after a crash, a power loss or an interrupted
// download, and a one-shot decoder rejects the whole file. Blocks decode in
// order, so everything before the cut is still usable.
//
// fzstd allocates a frame's whole window up front from its header, so the
// header is checked against the output limit before decoding: a few bytes of
// crafted header must not claim gigabytes. Only the first frame is checked; a
// log is one frame, and the output limit still bounds the rest.

const ZSTD_FRAME_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export type ZstdPrefixResult =
    | { kind: "decoded"; bytes: Uint8Array; complete: boolean }
    | { kind: "invalid" }
    | { kind: "too-large" };

/**
 * Decompresses a zstd stream, keeping the decoded prefix of a truncated or
 * damaged one ("decoded" with complete: false). "invalid" when nothing decodes,
 * "too-large" when the first frame's window or the output would pass
 * maxOutputBytes. Errors other than fzstd's own decode errors propagate.
 * Loads fzstd on first use.
 */
export async function inflateZstdPrefix(compressed: Uint8Array, maxOutputBytes: number): Promise<ZstdPrefixResult> {
    const windowBytes = firstFrameWindowBytes(compressed);
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
 * Bytes the first frame asks the decoder to hold (RFC 8878 3.1.1.1): its
 * window, or its whole content for a single-segment frame. null when the
 * stream does not open with a zstd frame header.
 */
function firstFrameWindowBytes(head: Uint8Array): number | null {
    if (head.length < 6 || ZSTD_FRAME_MAGIC.some((byte, i) => head[i] !== byte)) return null;
    const descriptor = head[4]!;
    if ((descriptor & 0x20) === 0) {
        const windowDescriptor = head[5]!;
        const base = 2 ** (10 + (windowDescriptor >> 3));
        return base + (base / 8) * (windowDescriptor & 7);
    }
    const dictionaryIdBytes = [0, 1, 2, 4][descriptor & 3]!;
    const contentSizeBytes = [1, 2, 4, 8][descriptor >> 6]!;
    const at = 5 + dictionaryIdBytes;
    if (head.length < at + contentSizeBytes) return null;
    let contentSize = 0;
    for (let i = contentSizeBytes - 1; i >= 0; i--) contentSize = contentSize * 256 + head[at + i]!;
    // The two-byte field stores the size minus 256.
    return contentSizeBytes === 2 ? contentSize + 256 : contentSize;
}

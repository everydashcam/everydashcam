// In-memory FileSystemFileHandle shim for the export-to-disk path on browsers
// WITHOUT the native File System Access API (Android Chrome, Firefox, Safari).
//
// The export drives mediabunny's positional StreamTarget with
// `{type:'write', position, data}` chunks and re-opens the file for GPMF
// injection. A streamed, write-once download cannot support that protocol.
//
// This handle instead buffers the whole MP4 in RAM and DOES support the full
// positional write + truncate + getFile + re-open protocol the export and the
// GPMF post-process rely on. The caller then hands the bytes to a normal blob
// download. There is no pre-flight size gate (RAM cannot be measured on
// Safari/Firefox, so a guessed cap only false-blocks clips the machine could
// handle): an oversized export throws when the buffer cannot be allocated, and
// the export flow maps that to a "use Chrome" message. A persistent
// in-memory-limit hint is shown next to Save regardless.
//
// Memory discipline (the whole point - a naive version used ~4x the file size,
// OOMing Safari on a 3 GB clip):
//  - The backing store is a RESIZABLE ArrayBuffer (the technique mediabunny's
//    BufferTarget uses): it grows IN PLACE via `.resize()`, no realloc+copy. The
//    old doubling buffer copied the whole thing on every growth - a multi-GB spike.
//  - It is PRE-ALLOCATED to the expected output size (stream-copy size is exact),
//    so a well-estimated export never grows at all.
//  - The GPMF re-open (createWritable + keepExistingData) does NOT clone the
//    multi-GB buffer. It shares it and STAGES the truncate + the small tail
//    writes (gpmd mdat + augmented moov, a few MB), applying them in place only
//    at close - so an abort/throw mid-injection leaves the committed file intact.
//  - Delivery (getFile / takeDownloadBlob) copies the committed bytes into the
//    download Blob in bounded windows (toBlobParts). It CANNOT be zero-copy:
//    Blink's Blob/File constructor rejects a view over a resizable buffer
//    ("ArrayBufferView value must not be resizable"), and one non-resizable
//    full-size copy doubles JS-heap peak - the finish-line OOM on multi-GB exports.
//    Windowing keeps the extra JS-heap live set to ~one chunk; each window's bytes
//    land in browser-side, disk-spillable blob storage.
//  - `dispose()` frees the backing buffer once the download File has copied it.

import { createLogger } from "../log.js";
import { getNativeSaveFilePicker } from "../native-file-picker.js";

const log = createLogger("export-flow");

let nativeSaveBlocked = false;

export function markNativeSaveBlocked(): void {
    nativeSaveBlocked = true;
}

/** True when the native save picker is callable and no earlier failure has
 *  disabled it for this page. Otherwise export uses RAM and a Blob download. */
export function nativeFsaAvailable(): boolean {
    return !nativeSaveBlocked && getNativeSaveFilePicker() !== null;
}

/** Test-only reset of the page-scoped picker capability. */
export function _resetForTests(): void {
    nativeSaveBlocked = false;
}

const MP4_MIME = "video/mp4";
// Hard ceiling for the backing ArrayBuffer. Matches mediabunny's BufferTarget
// (2^32 = 4 GiB); a grow past this throws RangeError, which export-flow maps to
// the "too large, use Chrome" guidance. Engines also impose their own limit.
const ARRAY_BUFFER_MAX = 2 ** 32;
// Window size for materializing the download Blob (toBlobParts). Blink's Blob/File
// constructor REJECTS a view over a RESIZABLE buffer ("ArrayBufferView value must
// not be resizable"), and one non-resizable full-size copy doubles JS-heap peak -
// the finish-line OOM on multi-GB exports. Copying in bounded windows caps the
// extra JS-heap live set to ~one chunk. Exported for the boundary-stitching test.
export const BLOB_CHUNK = 64 * 1024 * 1024;
// Slack added above a known expected size and on each growth, so a slightly-off
// estimate or the appended gpmd tail does not trigger a resize per write.
const GROWTH_HEADROOM = 64 * 1024 * 1024;
const MIN_INITIAL = 64 * 1024;

// Resizable ArrayBuffer support (Safari 16.4+, Chrome 111+, Firefox 125+). When
// absent (older engines) GrowableBuffer falls back to realloc+copy growth.
const supportsResizableArrayBuffer = ((): boolean => {
    try {
        return "resize" in new ArrayBuffer(0);
    } catch {
        return false;
    }
})();

interface ResizableArrayBuffer extends ArrayBuffer {
    resize(newByteLength: number): void;
}

// ArrayBuffer's resizable 2-arg constructor and resize() are ES2024; our tsconfig
// `lib` predates them, so reach the constructor through a typed cast rather than
// bumping `lib` (matching how mediabunny's BufferTarget sidesteps it).
const ResizableArrayBufferCtor = ArrayBuffer as unknown as {
    new (byteLength: number, options: { maxByteLength: number }): ResizableArrayBuffer;
};

// Growable byte store with random-access positional writes and truncate. Backed
// by a resizable ArrayBuffer that grows in place; `logicalLen` is the file size
// (capacity may exceed it). Gaps created by a write past the current end are
// zero-filled, matching FSA write semantics.
class GrowableBuffer {
    private backing: ArrayBuffer;
    // Length-tracking view over `backing` (a no-length `new Uint8Array(buffer)`
    // over a resizable buffer auto-scales on resize). Re-pointed on the realloc
    // fallback path only.
    private view: Uint8Array<ArrayBuffer>;
    private logicalLen = 0;
    private readonly resizable: boolean;

    /** `expectedBytes` pre-allocates the backing buffer to ~the output size so a
     *  correctly-estimated export (stream-copy size is exact) never grows. The
     *  GROWTH_HEADROOM slack is added only on later growth, not here, so a tiny
     *  expectation does not over-allocate. 0 = unknown, start small. */
    constructor(expectedBytes = 0) {
        const initial =
            expectedBytes > 0 ? Math.max(MIN_INITIAL, Math.min(expectedBytes, ARRAY_BUFFER_MAX)) : MIN_INITIAL;
        if (supportsResizableArrayBuffer) {
            this.backing = new ResizableArrayBufferCtor(initial, { maxByteLength: ARRAY_BUFFER_MAX });
            this.resizable = true;
        } else {
            this.backing = new ArrayBuffer(initial);
            this.resizable = false;
        }
        this.view = new Uint8Array(this.backing);
    }

    get size(): number {
        return this.logicalLen;
    }

    /** The logical bytes [0, len) as an ordered list of Blob parts for a Blob/File
     *  constructor. Copied in <=BLOB_CHUNK windows because delivery cannot be
     *  zero-copy here: Blink REJECTS a view over the resizable backing
     *  ("ArrayBufferView value must not be resizable"), and one non-resizable
     *  full-size copy doubles JS-heap peak (the multi-GB finish-line OOM). Each
     *  window is a fresh NON-RESIZABLE Uint8Array (via slice) Blink accepts;
     *  wrapping it in a Blob copies its bytes into browser-side, disk-spillable
     *  storage and drops the JS reference, so only ~one window is ever live beyond
     *  this backing buffer. Combining the part Blobs references their storage - no
     *  second full-size copy. */
    toBlobParts(): Blob[] {
        const parts: Blob[] = [];
        for (let off = 0; off < this.logicalLen; off += BLOB_CHUNK) {
            const end = Math.min(off + BLOB_CHUNK, this.logicalLen);
            // slice() copies into a fresh NON-RESIZABLE ArrayBuffer; the
            // resizable-backed view itself would be rejected by Blink.
            parts.push(new Blob([this.view.slice(off, end)]));
        }
        return parts;
    }

    /** Ensures the backing buffer can hold `min` bytes, growing in place
     *  (resizable) or via realloc+copy (fallback). Throws RangeError past the
     *  ceiling - export-flow turns that into the "too large, use Chrome" message. */
    private ensureCapacity(min: number): void {
        if (min <= this.backing.byteLength) return;
        if (min > ARRAY_BUFFER_MAX) {
            throw new RangeError(`in-memory export exceeds ${ARRAY_BUFFER_MAX} bytes`);
        }
        const target = Math.min(ARRAY_BUFFER_MAX, min + GROWTH_HEADROOM);
        if (this.resizable) {
            (this.backing as ResizableArrayBuffer).resize(target);
            // The length-tracking view scales automatically; no re-point needed.
        } else {
            const grown = new ArrayBuffer(target);
            const grownView = new Uint8Array(grown);
            grownView.set(this.view.subarray(0, this.logicalLen), 0);
            this.backing = grown;
            this.view = grownView;
        }
    }

    writeAt(position: number, data: Uint8Array): void {
        const end = position + data.byteLength;
        this.ensureCapacity(end);
        // A write starting beyond the current end leaves a hole - zero it so the
        // file does not expose stale bytes from a prior, longer state (e.g. after
        // a truncate). Resizable growth zero-fills new bytes, but bytes already
        // committed below capacity may be stale.
        if (position > this.logicalLen) this.view.fill(0, this.logicalLen, position);
        this.view.set(data, position);
        if (end > this.logicalLen) this.logicalLen = end;
    }

    truncate(size: number): void {
        if (size < this.logicalLen) {
            this.logicalLen = size;
        } else if (size > this.logicalLen) {
            this.ensureCapacity(size);
            this.view.fill(0, this.logicalLen, size);
            this.logicalLen = size;
        }
    }

    /** Releases the backing allocation. After this the buffer is empty; only call
     *  once the bytes have been handed off (e.g. the download blob is built). */
    dispose(): void {
        if (this.resizable) {
            try {
                (this.backing as ResizableArrayBuffer).resize(0);
            } catch {
                /* ignore - dropping the reference below frees it anyway */
            }
        }
        this.backing = new ArrayBuffer(0);
        this.view = new Uint8Array(this.backing);
        this.logicalLen = 0;
    }
}

async function chunkToBytes(data: BufferSource | Blob | string): Promise<Uint8Array> {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof data === "string") return new TextEncoder().encode(data);
    // Blob.
    return new Uint8Array(await data.arrayBuffer());
}

// Minimal write-params shape (subset of the FSA WriteParams the export uses).
type WriteParams =
    | { type: "write"; position?: number; data: BufferSource | Blob | string }
    | { type: "seek"; position: number }
    | { type: "truncate"; size: number };

function isWriteParams(chunk: unknown): chunk is WriteParams {
    // Blob must be excluded explicitly: `"type" in blob` is true
    // (Blob.prototype.type), so a spec-legal write(blob) call was routed into
    // the WriteParams branch where `data` is undefined and chunkToBytes threw.
    if (chunk instanceof Blob) return false;
    if (typeof chunk !== "object" || chunk === null || !("type" in chunk)) return false;
    const t = (chunk as { type: unknown }).type;
    return t === "write" || t === "seek" || t === "truncate";
}

// Mux writable: writes the whole MP4 into a fresh PRE-SIZED working buffer, which
// is committed (swapped into the handle - no copy) on close. Mirrors the subset
// of FileSystemWritableFileStream mediabunny's positional StreamTarget calls.
class InMemoryMuxWritable {
    private position = 0;
    private done = false;

    constructor(
        private readonly commit: (buf: GrowableBuffer) => void,
        private readonly buf: GrowableBuffer,
    ) {}

    async write(chunk: WriteParams | BufferSource | Blob | string): Promise<void> {
        if (this.done) throw new TypeError("write to a closed writable");
        if (isWriteParams(chunk)) {
            if (chunk.type === "seek") {
                this.position = chunk.position;
                return;
            }
            if (chunk.type === "truncate") {
                this.buf.truncate(chunk.size);
                if (this.position > chunk.size) this.position = chunk.size;
                return;
            }
            if (typeof chunk.position === "number") this.position = chunk.position;
            const bytes = await chunkToBytes(chunk.data);
            this.buf.writeAt(this.position, bytes);
            this.position += bytes.byteLength;
            return;
        }
        const bytes = await chunkToBytes(chunk);
        this.buf.writeAt(this.position, bytes);
        this.position += bytes.byteLength;
    }

    async truncate(size: number): Promise<void> {
        if (this.done) throw new TypeError("truncate on a closed writable");
        this.buf.truncate(size);
        if (this.position > size) this.position = size;
    }

    async seek(position: number): Promise<void> {
        if (this.done) throw new TypeError("seek on a closed writable");
        this.position = position;
    }

    async close(): Promise<void> {
        if (this.done) return;
        this.done = true;
        this.commit(this.buf);
    }

    async abort(): Promise<void> {
        // Discard the working buffer - the committed state is untouched.
        this.done = true;
    }
}

// Injection writable: the keepExistingData re-open the GPMF post-process uses.
// Shares the committed buffer (NO clone of the multi-GB media) and STAGES every
// truncate/write op, replaying them in issue order onto the committed buffer in
// place only at close. An abort or a throw before close leaves the committed
// buffer untouched (a valid MP4 without telemetry). The staged ops hold only the
// small gpmd tail (a few MB), never the media bytes.
class InMemoryInjectionWritable {
    private position = 0;
    private done = false;
    private readonly ops: Array<
        { kind: "truncate"; size: number } | { kind: "write"; position: number; bytes: Uint8Array }
    > = [];

    constructor(private readonly target: GrowableBuffer) {}

    async write(chunk: WriteParams | BufferSource | Blob | string): Promise<void> {
        if (this.done) throw new TypeError("write to a closed writable");
        if (isWriteParams(chunk)) {
            if (chunk.type === "seek") {
                this.position = chunk.position;
                return;
            }
            if (chunk.type === "truncate") {
                this.ops.push({ kind: "truncate", size: chunk.size });
                if (this.position > chunk.size) this.position = chunk.size;
                return;
            }
            if (typeof chunk.position === "number") this.position = chunk.position;
            const bytes = await chunkToBytes(chunk.data);
            // Copy: ops are replayed onto the committed buffer at close(), so a
            // caller that mutates/reuses its buffer after write() would corrupt
            // the committed file. chunkToBytes can hand back a view aliasing the
            // caller's buffer. The staged tail is small (gpmd mdat + moov), so the
            // copy is cheap and keeps the isolation guarantee real.
            this.ops.push({ kind: "write", position: this.position, bytes: new Uint8Array(bytes) });
            this.position += bytes.byteLength;
            return;
        }
        const bytes = await chunkToBytes(chunk);
        this.ops.push({ kind: "write", position: this.position, bytes: new Uint8Array(bytes) });
        this.position += bytes.byteLength;
    }

    async truncate(size: number): Promise<void> {
        if (this.done) throw new TypeError("truncate on a closed writable");
        this.ops.push({ kind: "truncate", size });
        if (this.position > size) this.position = size;
    }

    async seek(position: number): Promise<void> {
        if (this.done) throw new TypeError("seek on a closed writable");
        this.position = position;
    }

    async close(): Promise<void> {
        if (this.done) return;
        this.done = true;
        // Replay staged ops in issue order onto the committed buffer in place.
        for (const op of this.ops) {
            if (op.kind === "truncate") this.target.truncate(op.size);
            else this.target.writeAt(op.position, op.bytes);
        }
    }

    async abort(): Promise<void> {
        // Drop the staged ops; the committed buffer was never touched.
        this.done = true;
        this.ops.length = 0;
    }
}

/** The in-memory-specific surface the export pipeline uses beyond the standard
 *  FileSystemFileHandle members. Callers duck-type via `asInMemoryExportHandle`. */
export interface InMemoryExportHandle {
    /** Materializes the final download File and frees the backing buffer in one
     *  step (~1x peak: the File copies the bytes off the JS heap in bounded windows,
     *  then the backing buffer is freed). The handle is spent afterwards. */
    takeDownloadBlob(): File;
    /** Frees the backing buffer without producing a File. Idempotent. The export
     *  flow calls this in its finally to release the (up to 4 GiB) RAM buffer on
     *  any error/abort exit - the success path already freed it via
     *  takeDownloadBlob(), so a second call is a no-op. */
    dispose(): void;
}

// In-memory handle. Holds the committed bytes; createWritable starts from a
// fresh PRE-SIZED buffer for the mux, or a staging writable over the committed
// buffer for the keepExistingData GPMF re-open (no clone).
class InMemoryFileHandle implements InMemoryExportHandle {
    readonly kind = "file" as const;
    private committed: GrowableBuffer;

    constructor(
        readonly name: string,
        private readonly expectedBytes: number,
    ) {
        // committed starts empty - the mux writes into a fresh PRE-SIZED working
        // buffer (see createWritable) and swaps it in on close. Pre-sizing
        // committed here too would double the allocation during the mux.
        this.committed = new GrowableBuffer();
    }

    async getFile(): Promise<File> {
        // Non-destructive (the re-encode injection re-reads this to locate moov,
        // then still mutates committed). Delivery copies in windows - see
        // toBlobParts for why (Blink rejects the resizable-backed view; one
        // full-size non-resizable copy doubles JS-heap peak).
        return new File(this.committed.toBlobParts(), this.name, { type: MP4_MIME });
    }

    takeDownloadBlob(): File {
        // Build the download File from windowed Blob parts (see toBlobParts), THEN
        // free the backing buffer. Peak on the JS heap stays ~1x the file - just
        // this backing buffer plus one live window; the copied bytes land in
        // browser-side, disk-spillable blob storage. The old path pre-copied the
        // whole file into a second full-size JS-heap ArrayBuffer, doubling peak and
        // OOMing multi-GB exports at the finish line. The handle is spent afterwards.
        const file = new File(this.committed.toBlobParts(), this.name, { type: MP4_MIME });
        this.committed.dispose();
        return file;
    }

    async createWritable(opts?: {
        keepExistingData?: boolean;
    }): Promise<InMemoryMuxWritable | InMemoryInjectionWritable> {
        if (opts?.keepExistingData) {
            // GPMF re-open: stage edits onto the committed buffer in place, no clone.
            return new InMemoryInjectionWritable(this.committed);
        }
        // Mux: a fresh pre-sized buffer, swapped into committed on close.
        const working = new GrowableBuffer(this.expectedBytes);
        return new InMemoryMuxWritable((buf) => {
            this.committed = buf;
        }, working);
    }

    dispose(): void {
        this.committed.dispose();
    }
}

/**
 * Creates an in-memory file handle for an export when the native save picker is
 * unavailable. Structurally compatible with the FileSystemFileHandle subset the
 * export pipeline and GPMF injection use; cast to the DOM type at the call site
 * (the runtime only touches name/getFile/createWritable and write/truncate/
 * seek/close/abort, plus the InMemoryExportHandle extras).
 *
 * `expectedBytes` pre-allocates the buffer to avoid growth churn (pass the live
 * export estimate; stream-copy's is exact). 0/omitted starts small and grows.
 */
export function createInMemoryFileHandle(name: string, expectedBytes = 0): FileSystemFileHandle {
    log.debug("in-memory export handle created", { name, expectedBytes });
    return new InMemoryFileHandle(name, expectedBytes) as unknown as FileSystemFileHandle;
}

/** Returns the InMemoryExportHandle surface if `handle` is one of ours, else
 *  null. Lets the export flow take the download blob + free the backing buffer in
 *  one step for the RAM path, without threading a separate flag through. */
export function asInMemoryExportHandle(handle: unknown): InMemoryExportHandle | null {
    if (handle && typeof (handle as { takeDownloadBlob?: unknown }).takeDownloadBlob === "function") {
        return handle as InMemoryExportHandle;
    }
    return null;
}

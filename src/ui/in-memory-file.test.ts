import { afterEach, describe, expect, it, vi } from "vitest";

import {
    _resetForTests,
    asInMemoryExportHandle,
    BLOB_CHUNK,
    createInMemoryFileHandle,
    markNativeSaveBlocked,
    nativeFsaAvailable,
} from "./in-memory-file.js";

// Helper: read the handle's current bytes.
async function bytesOf(handle: FileSystemFileHandle): Promise<Uint8Array> {
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
}

describe("createInMemoryFileHandle", () => {
    it("supports the positional write protocol mediabunny StreamTarget emits", async () => {
        const handle = createInMemoryFileHandle("clip.mp4");
        const w = await handle.createWritable();
        // Two sequential positional writes (how the export feeds chunks).
        await w.write({ type: "write", position: 0, data: new Uint8Array([1, 2, 3]) });
        await w.write({ type: "write", position: 3, data: new Uint8Array([4, 5]) });
        await w.close();

        const file = await handle.getFile();
        expect(file.name).toBe("clip.mp4");
        expect(file.type).toBe("video/mp4");
        expect(Array.from(await bytesOf(handle))).toEqual([1, 2, 3, 4, 5]);
    });

    it("zero-fills a gap when a write starts past the current end", async () => {
        const handle = createInMemoryFileHandle("clip.mp4");
        const w = await handle.createWritable();
        await w.write({ type: "write", position: 2, data: new Uint8Array([9]) });
        await w.close();
        // [0,2) is the hole -> zero-filled; byte at 2 is 9.
        expect(Array.from(await bytesOf(handle))).toEqual([0, 0, 9]);
    });

    it("starts empty on a plain createWritable (default keepExistingData=false)", async () => {
        const handle = createInMemoryFileHandle("clip.mp4");
        let w = await handle.createWritable();
        await w.write({ type: "write", position: 0, data: new Uint8Array([1, 2, 3, 4]) });
        await w.close();
        // A fresh writable discards the committed bytes.
        w = await handle.createWritable();
        await w.write({ type: "write", position: 0, data: new Uint8Array([7]) });
        await w.close();
        expect(Array.from(await bytesOf(handle))).toEqual([7]);
    });

    it("re-opens with keepExistingData and supports the GPMF truncate+append flow", async () => {
        const handle = createInMemoryFileHandle("clip.mp4");
        // Initial file: mdat(0..4) + moov(4..8).
        let w = await handle.createWritable();
        await w.write({ type: "write", position: 0, data: new Uint8Array([10, 11, 12, 13, 20, 21, 22, 23]) });
        await w.close();

        // GPMF post-process: re-open keeping data, truncate at moov start (4),
        // append new mdat + augmented moov.
        w = await handle.createWritable({ keepExistingData: true });
        await w.truncate(4);
        await w.write({ type: "write", position: 4, data: new Uint8Array([30, 31]) });
        await w.write({ type: "write", position: 6, data: new Uint8Array([40, 41, 42]) });
        await w.close();

        // Original mdat preserved, old moov replaced by appended payload.
        expect(Array.from(await bytesOf(handle))).toEqual([10, 11, 12, 13, 30, 31, 40, 41, 42]);
    });

    it("discards the working buffer on abort, leaving the committed file intact", async () => {
        const handle = createInMemoryFileHandle("clip.mp4");
        let w = await handle.createWritable();
        await w.write({ type: "write", position: 0, data: new Uint8Array([1, 2, 3]) });
        await w.close();

        w = await handle.createWritable({ keepExistingData: true });
        await w.write({ type: "write", position: 3, data: new Uint8Array([99]) });
        await w.abort();
        // Abort dropped the appended byte; the committed file is unchanged.
        expect(Array.from(await bytesOf(handle))).toEqual([1, 2, 3]);
    });

    it("keepExistingData re-open stages edits - the committed file is untouched until close", async () => {
        // The whole point of the staging writable: GPMF injection never clones the
        // multi-GB buffer, and an abort/throw mid-injection leaves a valid file.
        const handle = createInMemoryFileHandle("clip.mp4");
        let w = await handle.createWritable();
        await w.write({ type: "write", position: 0, data: new Uint8Array([1, 2, 3, 4, 5, 6]) });
        await w.close();

        w = await handle.createWritable({ keepExistingData: true });
        await w.truncate(2);
        await w.write({ type: "write", position: 2, data: new Uint8Array([9]) });
        // Pre-close: staged, so the committed file still reads as the original.
        expect(Array.from(await bytesOf(handle))).toEqual([1, 2, 3, 4, 5, 6]);
        await w.close();
        // Post-close: truncate(2) + append applied in order.
        expect(Array.from(await bytesOf(handle))).toEqual([1, 2, 9]);
    });

    it("keepExistingData staging copies write payloads - mutating the source after write is isolated", async () => {
        // The staged ops replay at close(); if they held the caller's buffer by
        // reference, a mutation between write() and close() would corrupt the
        // committed file. The injection path stages a small tail, so the copy is
        // cheap and the isolation guarantee must hold.
        const handle = createInMemoryFileHandle("clip.mp4");
        let w = await handle.createWritable();
        await w.write({ type: "write", position: 0, data: new Uint8Array([1, 2, 3, 4]) });
        await w.close();

        w = await handle.createWritable({ keepExistingData: true });
        const payload = new Uint8Array([9, 9]);
        await w.truncate(2);
        await w.write({ type: "write", position: 2, data: payload });
        // Caller mutates its buffer after handing it off but before close().
        payload[0] = 0;
        payload[1] = 0;
        await w.close();
        // The committed file reflects the bytes AS WRITTEN, not the later mutation.
        expect(Array.from(await bytesOf(handle))).toEqual([1, 2, 9, 9]);
    });

    it("pre-sizes to expectedBytes yet still grows when the export exceeds it", async () => {
        // expectedBytes is a hint for the backing allocation, NOT a cap: a write
        // past it must still succeed (the resizable buffer grows in place).
        // expectedBytes=4 floors to the 64 KiB minimum initial; write past that to
        // force an actual in-place grow.
        const handle = createInMemoryFileHandle("clip.mp4", 4);
        const w = await handle.createWritable();
        const big = new Uint8Array(100_000).fill(7);
        await w.write({ type: "write", position: 0, data: big });
        await w.close();
        const out = await bytesOf(handle);
        expect(out.length).toBe(100_000);
        expect(out[0]).toBe(7);
        expect(out[99_999]).toBe(7);
    });

    it("takeDownloadBlob returns the file and frees the backing buffer", async () => {
        const handle = createInMemoryFileHandle("clip.mp4");
        const w = await handle.createWritable();
        await w.write({ type: "write", position: 0, data: new Uint8Array([1, 2, 3]) });
        await w.close();

        const ext = asInMemoryExportHandle(handle);
        expect(ext, "an in-memory handle must expose takeDownloadBlob").not.toBeNull();
        const file = ext!.takeDownloadBlob();
        expect(file.type).toBe("video/mp4");
        expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2, 3]);
        // The backing buffer is freed - the handle is spent.
        expect((await bytesOf(handle)).length).toBe(0);
    });

    it("delivery over a pre-sized (slack) buffer yields exactly the logical bytes", async () => {
        // Regression for the finish-line OOM fix: delivery hands a length-tracking
        // VIEW to the File constructor instead of pre-copying into a fresh
        // full-size ArrayBuffer (which doubled JS-heap peak and OOMed multi-GB
        // exports). The view MUST be bounded to the logical length, not the backing
        // capacity - a buffer pre-sized far past the written content must not leak
        // its trailing zero slack into the download. (The memory property itself is
        // not unit-observable here; this locks the byte-exactness the view relies on.)
        const handle = createInMemoryFileHandle("clip.mp4", 1_000_000); // pre-size >> content
        const w = await handle.createWritable();
        await w.write({ type: "write", position: 0, data: new Uint8Array([1, 2, 3, 4, 5]) });
        await w.close();

        // getFile (non-destructive, used by GPMF injection) is bounded too.
        const viaGetFile = await bytesOf(handle);
        expect(Array.from(viaGetFile)).toEqual([1, 2, 3, 4, 5]);

        const ext = asInMemoryExportHandle(handle);
        expect(ext).not.toBeNull();
        const file = ext!.takeDownloadBlob();
        expect(file.size).toBe(5);
        expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2, 3, 4, 5]);
    });

    it("stitches multi-window delivery in order across the chunk boundary", async () => {
        // Delivery copies in BLOB_CHUNK windows (Blink rejects a resizable-backed
        // view, so it cannot be a single zero-copy view). Cross the boundary and
        // assert the parts concatenate in order with no gap/overlap - marker bytes
        // sit on the seam. Reads are single-byte slices, so no full-file
        // materialization in the test.
        const total = BLOB_CHUNK + 8;
        const data = new Uint8Array(total);
        data[0] = 1;
        data[BLOB_CHUNK - 1] = 2; // last byte of window 0
        data[BLOB_CHUNK] = 3; // first byte of window 1
        data[total - 1] = 4;

        const handle = createInMemoryFileHandle("clip.mp4");
        const w = await handle.createWritable();
        await w.write({ type: "write", position: 0, data });
        await w.close();

        const file = asInMemoryExportHandle(handle)!.takeDownloadBlob();
        expect(file.size).toBe(total);
        const byteAt = async (i: number): Promise<number | undefined> =>
            new Uint8Array(await file.slice(i, i + 1).arrayBuffer())[0];
        expect(await byteAt(0)).toBe(1);
        expect(await byteAt(BLOB_CHUNK - 1)).toBe(2);
        expect(await byteAt(BLOB_CHUNK)).toBe(3);
        expect(await byteAt(total - 1)).toBe(4);
    });
});

describe("nativeFsaAvailable", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        _resetForTests();
    });

    it.each([undefined, {}])("is false when the save picker is not callable: %s", (picker) => {
        vi.stubGlobal("window", { showSaveFilePicker: picker });
        expect(nativeFsaAvailable()).toBe(false);
    });

    it("is true when window.showSaveFilePicker exists", () => {
        vi.stubGlobal("window", { showSaveFilePicker: () => {} });
        expect(nativeFsaAvailable()).toBe(true);
    });

    it("keeps a denied native picker unavailable for the page lifetime", () => {
        vi.stubGlobal("window", { showSaveFilePicker: () => {} });
        markNativeSaveBlocked();
        expect(nativeFsaAvailable()).toBe(false);
        _resetForTests();
        expect(nativeFsaAvailable()).toBe(true);
    });
});

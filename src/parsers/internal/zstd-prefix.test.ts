import { constants, zstdCompressSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { cutInsideLastBlock, streamedZstd } from "../__fixtures__/zstd-stream.js";
import { inflateZstdPrefix } from "./zstd-prefix.js";

/** Barely compressible bytes, so every 128 KiB block carries its own data. */
function payload(size: number): Uint8Array {
    const bytes = new Uint8Array(size);
    let state = 0x9e3779b9;
    for (let i = 0; i < size; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        bytes[i] = state & 0x3f;
    }
    return bytes;
}

describe("inflateZstdPrefix", () => {
    const original = payload(600_000);

    it("decodes a whole stream with and without a content size", async () => {
        for (const compressed of [zstdCompressSync(original), streamedZstd(original)]) {
            const result = await inflateZstdPrefix(compressed, 1 << 20);
            expect(result.kind).toBe("decoded");
            if (result.kind !== "decoded") continue;
            expect(result.complete).toBe(true);
            expect(result.bytes).toEqual(original);
        }
    });

    it("keeps the decoded prefix of a stream cut short", async () => {
        const result = await inflateZstdPrefix(cutInsideLastBlock(streamedZstd(original)), 1 << 20);
        expect(result.kind).toBe("decoded");
        if (result.kind !== "decoded") return;
        expect(result.complete).toBe(false);
        expect(result.bytes.length).toBeGreaterThan(0);
        expect(result.bytes.length).toBeLessThan(original.length);
        expect(result.bytes).toEqual(original.subarray(0, result.bytes.length));
    });

    it("reports a stream that decodes to nothing as invalid", async () => {
        expect(await inflateZstdPrefix(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4, 5]), 1 << 20)).toEqual({
            kind: "invalid",
        });
        expect(await inflateZstdPrefix(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 1 << 20)).toEqual({ kind: "invalid" });
    });

    it("refuses a frame whose header asks for more than the limit, before decoding", async () => {
        // Window descriptor 0xf8: a 2 TiB window.
        const header = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xf8, 0, 0, 0]);
        expect(await inflateZstdPrefix(header, 1 << 20)).toEqual({ kind: "too-large" });
        expect(await inflateZstdPrefix(zstdCompressSync(original), 1000)).toEqual({ kind: "too-large" });
    });

    it("stops a stream whose output passes the limit", async () => {
        // A 1 MiB window passes the header check, the 4 MiB output does not.
        const compressed = zstdCompressSync(new Uint8Array(4 << 20), {
            params: { [constants.ZSTD_c_contentSizeFlag]: 0, [constants.ZSTD_c_windowLog]: 20 },
        });
        expect(await inflateZstdPrefix(compressed, 2 << 20)).toEqual({ kind: "too-large" });
    });

    it("refuses a later frame whose header asks for more than the limit", async () => {
        // A small whole frame, then one with a 4 MiB window (descriptor 0x60)
        // holding a single raw byte: fzstd would allocate that window first.
        const first = zstdCompressSync(new Uint8Array(64));
        const second = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x60, 0x09, 0x00, 0x00, 0x2a]);
        const both = new Uint8Array(first.length + second.length);
        both.set(first, 0);
        both.set(second, first.length);
        expect(await inflateZstdPrefix(both, 4 << 20)).toMatchObject({ kind: "decoded", complete: true });
        expect(await inflateZstdPrefix(both, 1 << 20)).toEqual({ kind: "too-large" });
    });

    it("walks past skippable frames and frame checksums to the next header", async () => {
        const checked = zstdCompressSync(new Uint8Array(64), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
        const skippable = new Uint8Array([0x50, 0x2a, 0x4d, 0x18, 0x02, 0x00, 0x00, 0x00, 0xaa, 0xbb]);
        const large = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x60, 0x09, 0x00, 0x00, 0x2a]);
        const stream = new Uint8Array(checked.length + skippable.length + large.length);
        stream.set(checked, 0);
        stream.set(skippable, checked.length);
        stream.set(large, checked.length + skippable.length);
        expect(await inflateZstdPrefix(stream, 1 << 20)).toEqual({ kind: "too-large" });
    });
});

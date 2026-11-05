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
});

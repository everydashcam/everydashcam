import { readFileSync } from "node:fs";
import { BlobSource, EncodedPacketSink, EncodedVideoPacketSource, Input, MATROSKA } from "../mediabunny.js";
import { describe, expect, it } from "vitest";
import { createMp4StreamOutput } from "../transcode/pipeline-common.js";
import { servePortWritable, wrapPortAsFsaWritable } from "./port-writable.js";

interface WriteChunk {
    type: "write";
    position: number;
    data: Uint8Array<ArrayBuffer>;
}

function readChunk(chunk: unknown): WriteChunk {
    if (
        typeof chunk !== "object" ||
        chunk === null ||
        !("type" in chunk) ||
        chunk.type !== "write" ||
        !("position" in chunk) ||
        typeof chunk.position !== "number" ||
        !("data" in chunk) ||
        !(chunk.data instanceof Uint8Array) ||
        !(chunk.data.buffer instanceof ArrayBuffer)
    ) {
        throw new Error("invalid write chunk");
    }
    return chunk as WriteChunk;
}

function capturedBridge(transferFullBuffers: boolean) {
    const { port1, port2 } = new MessageChannel();
    const received: WriteChunk[] = [];
    servePortWritable(port2, {
        async write(chunk) {
            received.push(readChunk(chunk));
        },
        async close() {},
        async abort() {},
        onFinalized() {},
    });
    return {
        writable: wrapPortAsFsaWritable(port1, { transferFullBuffers }),
        received,
        dispose() {
            port1.close();
            port2.close();
        },
    };
}

function applyWrites(chunks: WriteChunk[]): Uint8Array {
    let length = 0;
    for (const chunk of chunks) length = Math.max(length, chunk.position + chunk.data.byteLength);
    const result = new Uint8Array(length);
    for (const chunk of chunks) result.set(chunk.data, chunk.position);
    return result;
}

describe("port writable buffer ownership", () => {
    it("keeps caller buffers intact by default", async () => {
        const bridge = capturedBridge(false);
        const data = new Uint8Array([1, 2, 3]);
        try {
            await bridge.writable.write({ type: "write", position: 0, data });
            data[0] = 99;
            await bridge.writable.close();
            expect(data.byteLength).toBe(3);
            expect(bridge.received[0]!.data).toEqual(new Uint8Array([1, 2, 3]));
        } finally {
            bridge.dispose();
        }
    });

    it("transfers surrendered full buffers without copying their payload", async () => {
        const bridge = capturedBridge(true);
        const data = new Uint8Array([1, 2, 3]);
        try {
            await bridge.writable.write({ type: "write", position: 0, data });
            expect(data.byteLength).toBe(0);
            await bridge.writable.close();
            expect(bridge.received[0]!.data).toEqual(new Uint8Array([1, 2, 3]));
        } finally {
            bridge.dispose();
        }
    });

    it("copies partial views so later writes can reuse their backing buffer", async () => {
        const bridge = capturedBridge(true);
        const data = new Uint8Array([1, 2, 3, 4]);
        try {
            await bridge.writable.write({ type: "write", position: 0, data: data.subarray(0, 2) });
            await bridge.writable.write({ type: "write", position: 2, data: data.subarray(2) });
            await bridge.writable.close();
            expect(data.byteLength).toBe(4);
            expect(applyWrites(bridge.received)).toEqual(data);
        } finally {
            bridge.dispose();
        }
    });

    it("preserves real MP4 bytes across full-chunk transfers and final header rewrites", async () => {
        const fixture = readFileSync(new URL("../parsers/__fixtures__/generic/clip-h264.mkv", import.meta.url));
        const input = new Input({ source: new BlobSource(new Blob([fixture])), formats: [MATROSKA] });
        const bridge = capturedBridge(true);
        const expected: WriteChunk[] = [];
        let detachedChunks = 0;
        let bytesWritten = 0;
        const writable = {
            async write(chunk: unknown) {
                const value = readChunk(chunk);
                expected.push({ ...value, data: value.data.slice() });
                await bridge.writable.write(value);
                if (value.data.byteLength === 0) detachedChunks++;
            },
            close: () => bridge.writable.close(),
            abort: (reason: unknown) => bridge.writable.abort(reason),
        } as unknown as FileSystemWritableFileStream;
        try {
            const track = await input.getPrimaryVideoTrack();
            if (!track) throw new Error("fixture has no video track");
            const codec = await track.getCodec();
            const config = await track.getDecoderConfig();
            const packet = await new EncodedPacketSink(track).getFirstKeyPacket();
            if (!codec || !config || !packet) throw new Error("fixture has no decodable keyframe");
            const source = new EncodedVideoPacketSource(codec);
            const output = createMp4StreamOutput(writable, new AbortController().signal, (size) => {
                bytesWritten += size;
            });
            output.addVideoTrack(source);
            await output.start();
            // Multiple complete output chunks plus a partial tail and mdat-size rewrite.
            const count = Math.ceil((9 * 1024 * 1024) / packet.byteLength);
            for (let i = 0; i < count; i++) {
                await source.add(
                    packet.clone({ timestamp: i * packet.duration }),
                    i === 0 ? { decoderConfig: config } : undefined,
                );
            }
            await output.finalize();

            expect(detachedChunks).toBeGreaterThanOrEqual(2);
            expect(expected.some((chunk) => chunk.position < expected[0]!.data.byteLength && chunk.position > 0)).toBe(
                true,
            );
            expect(Buffer.compare(applyWrites(bridge.received), applyWrites(expected))).toBe(0);
            expect(bytesWritten).toBe(expected.reduce((sum, chunk) => sum + chunk.data.byteLength, 0));
        } finally {
            input.dispose();
            bridge.dispose();
        }
    });
});

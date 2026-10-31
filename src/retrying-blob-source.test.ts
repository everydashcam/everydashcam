import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Input, InputDisposedError } from "mediabunny";

import {
    createReaderPool,
    createRetryingBlobSource,
    createRetryingRangeStream,
    readRangeWithRetry,
} from "./retrying-blob-source.js";
import { VIDEO_INPUT_FORMATS } from "./video-formats.js";

// Only the environment boundary is faked: a Blob whose slice().stream() we
// script per call, so failures can be injected exactly where a scanner lock
// would land. The unit under test (retry loop, offset continuation, reader
// pooling, abort) is real.
interface SliceCall {
    start: number;
    end: number | undefined;
}

// Builds a Blob-shaped fake over `bytes`. `failAtCall` maps the 1-based slice
// call number to the count of chunk reads to serve before erroring with `err`.
// Chunks are served `chunkSize` bytes at a time.
function scriptedBlob(opts: {
    bytes: Uint8Array;
    chunkSize: number;
    failAtCall?: Map<number, { afterChunks: number; err: unknown }>;
}): { blob: Blob; sliceCalls: SliceCall[] } {
    const sliceCalls: SliceCall[] = [];
    const blob = {
        size: opts.bytes.length,
        slice(start: number, end?: number) {
            sliceCalls.push({ start, end });
            const callNo = sliceCalls.length;
            const failure = opts.failAtCall?.get(callNo);
            const stop = end ?? opts.bytes.length;
            let served = 0;
            let pos = start;
            return {
                stream: () =>
                    new ReadableStream<Uint8Array>({
                        pull: (controller) => {
                            if (failure && served >= failure.afterChunks) {
                                throw failure.err;
                            }
                            if (pos >= stop) {
                                controller.close();
                                return;
                            }
                            const next = Math.min(pos + opts.chunkSize, stop);
                            controller.enqueue(opts.bytes.slice(pos, next));
                            pos = next;
                            served++;
                        },
                    }),
            };
        },
    } as unknown as Blob;
    return { blob, sliceCalls };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.length;
    }
    return out;
}

function sampleBytes(len: number): Uint8Array {
    const b = new Uint8Array(len);
    for (let i = 0; i < len; i++) b[i] = i % 251;
    return b;
}

const readErr = (): TypeError => new TypeError("network error");

function delayedRecording(): { file: File; started: Promise<void>; release(): void; cancellations(): number } {
    const file = new File(
        [readFileSync(new URL("../tests/testdata/no-gps-h264/clip-no-gps.mp4", import.meta.url))],
        "video.mp4",
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    const slice = file.slice.bind(file);
    let cancellations = 0;
    file.slice = (...args): Blob => {
        const blob = slice(...args);
        const stream = blob.stream.bind(blob);
        blob.stream = () => {
            const reader = stream().getReader();
            let isCancelled = false;
            return new ReadableStream<Uint8Array<ArrayBuffer>>({
                async pull(controller) {
                    markStarted();
                    await gate;
                    if (isCancelled) return;
                    const result = await reader.read();
                    if (isCancelled) return;
                    if (result.done) controller.close();
                    else controller.enqueue(result.value);
                },
                cancel() {
                    isCancelled = true;
                    cancellations++;
                    return reader.cancel();
                },
            });
        };
        return blob;
    };
    return { file, started, release, cancellations: () => cancellations };
}

describe("createRetryingRangeStream", () => {
    it("yields exactly the requested range from a single tail slice", async () => {
        const bytes = sampleBytes(1000);
        const { blob, sliceCalls } = scriptedBlob({ bytes, chunkSize: 64 });

        const got = await readAll(createRetryingRangeStream(blob, createReaderPool(), 100, 900, undefined));

        expect(got).toEqual(bytes.slice(100, 900));
        expect(sliceCalls).toEqual([{ start: 100, end: undefined }]);
    });

    it("consecutive ranges share one pooled reader (no re-slice, leftover carried over)", async () => {
        const bytes = sampleBytes(1000);
        // 64 does not divide 500: the first range ends mid-chunk, so the pooled
        // reader carries leftover bytes into the second range.
        const { blob, sliceCalls } = scriptedBlob({ bytes, chunkSize: 64 });
        const pool = createReaderPool();

        const first = await readAll(createRetryingRangeStream(blob, pool, 0, 500, undefined));
        const second = await readAll(createRetryingRangeStream(blob, pool, 500, 1000, undefined));

        expect(first).toEqual(bytes.slice(0, 500));
        expect(second).toEqual(bytes.slice(500, 1000));
        expect(sliceCalls, "the sequential fast path opens exactly one reader").toHaveLength(1);
    });

    it("disposes an active reader and rejects future reads from the closed pool", async () => {
        const recording = delayedRecording();
        const pool = createReaderPool();
        const pending = readAll(createRetryingRangeStream(recording.file, pool, 0, 128, undefined));
        const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
        try {
            await recording.started;
            pool.disposeAll();
            await rejection;
            expect(recording.cancellations()).toBe(1);
            expect(() => pool.take(0)).toThrow();
            pool.disposeAll();
            expect(recording.cancellations(), "repeated disposal is harmless").toBe(1);
        } finally {
            recording.release();
            pool.disposeAll();
        }
    });

    it("cancels a range while its underlying read is pending", async () => {
        const recording = delayedRecording();
        const pool = createReaderPool();
        const reader = createRetryingRangeStream(recording.file, pool, 0, 128, undefined).getReader();
        const pending = reader.read();
        try {
            await recording.started;
            await reader.cancel();
            expect((await pending).done).toBe(true);
            expect(recording.cancellations()).toBe(1);
        } finally {
            recording.release();
            pool.disposeAll();
        }
    });

    // Timing (the backoff) is part of what's under test - fake timers.
    it("retries a transient read failure from the exact byte where it stopped", async () => {
        vi.useFakeTimers();
        try {
            const bytes = sampleBytes(1000);
            // First slice serves 3 chunks of 64 B then dies; second succeeds.
            const { blob, sliceCalls } = scriptedBlob({
                bytes,
                chunkSize: 64,
                failAtCall: new Map([[1, { afterChunks: 3, err: readErr() }]]),
            });

            const pending = readAll(createRetryingRangeStream(blob, createReaderPool(), 0, 1000, undefined));
            await vi.advanceTimersByTimeAsync(10_000);
            const got = await pending;

            expect(got).toEqual(bytes);
            expect(sliceCalls, "the re-slice continues at the delivered offset").toEqual([
                { start: 0, end: undefined },
                { start: 192, end: undefined },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("gives each independent hiccup the full retry budget (counter resets on progress)", async () => {
        vi.useFakeTimers();
        try {
            const bytes = sampleBytes(1000);
            // Calls 1..3: one incident burning two retries; call 4 makes
            // progress (counter resets) then dies; call 5 finishes.
            const { blob, sliceCalls } = scriptedBlob({
                bytes,
                chunkSize: 100,
                failAtCall: new Map([
                    [1, { afterChunks: 2, err: readErr() }],
                    [2, { afterChunks: 0, err: readErr() }],
                    [3, { afterChunks: 0, err: readErr() }],
                    [4, { afterChunks: 1, err: readErr() }],
                ]),
            });

            const pending = readAll(createRetryingRangeStream(blob, createReaderPool(), 0, 1000, undefined));
            await vi.advanceTimersByTimeAsync(60_000);
            const got = await pending;

            expect(got).toEqual(bytes);
            expect(sliceCalls).toHaveLength(5);
        } finally {
            vi.useRealTimers();
        }
    });

    it("rethrows the original error once the consecutive-retry budget is spent", async () => {
        vi.useFakeTimers();
        try {
            const bytes = sampleBytes(100);
            const original = readErr();
            const always = new Map(
                Array.from({ length: 10 }, (_, i) => [i + 1, { afterChunks: 0, err: original }] as const),
            );
            const { blob, sliceCalls } = scriptedBlob({ bytes, chunkSize: 10, failAtCall: new Map(always) });

            const pending = readAll(createRetryingRangeStream(blob, createReaderPool(), 0, 100, undefined));
            pending.catch(() => {});
            await vi.advanceTimersByTimeAsync(60_000);

            await expect(pending).rejects.toBe(original);
            // Initial attempt + one per backoff step, then give up.
            expect(sliceCalls).toHaveLength(4);
        } finally {
            vi.useRealTimers();
        }
    });

    it("rethrows a non-read error immediately without retrying", async () => {
        const bytes = sampleBytes(100);
        const boom = new Error("unrelated bug");
        const { blob, sliceCalls } = scriptedBlob({
            bytes,
            chunkSize: 10,
            failAtCall: new Map([[1, { afterChunks: 0, err: boom }]]),
        });

        await expect(readAll(createRetryingRangeStream(blob, createReaderPool(), 0, 100, undefined))).rejects.toBe(
            boom,
        );
        expect(sliceCalls).toHaveLength(1);
    });

    it("readRangeWithRetry (the WebKit mode) retries a failed arrayBuffer read and returns exact bytes", async () => {
        vi.useFakeTimers();
        try {
            const bytes = sampleBytes(1000);
            const sliceCalls: SliceCall[] = [];
            let failuresLeft = 2;
            const blob = {
                size: bytes.length,
                slice(start: number, end?: number) {
                    sliceCalls.push({ start, end });
                    return {
                        arrayBuffer: async (): Promise<ArrayBuffer> => {
                            if (failuresLeft > 0) {
                                failuresLeft--;
                                throw readErr();
                            }
                            return bytes.slice(start, end).buffer as ArrayBuffer;
                        },
                    };
                },
            } as unknown as Blob;

            const pending = readRangeWithRetry(blob, 100, 900, undefined);
            await vi.advanceTimersByTimeAsync(10_000);
            const got = await pending;

            expect(got).toEqual(bytes.slice(100, 900));
            expect(sliceCalls, "a fresh slice per attempt").toEqual([
                { start: 100, end: 900 },
                { start: 100, end: 900 },
                { start: 100, end: 900 },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("a signal abort cuts a backoff wait short with AbortError", async () => {
        vi.useFakeTimers();
        try {
            const bytes = sampleBytes(100);
            const { blob } = scriptedBlob({
                bytes,
                chunkSize: 10,
                failAtCall: new Map([[1, { afterChunks: 0, err: readErr() }]]),
            });
            const controller = new AbortController();

            const pending = readAll(createRetryingRangeStream(blob, createReaderPool(), 0, 100, controller.signal));
            pending.catch(() => {});
            // Let the first failure land and the backoff start, then cancel.
            await vi.advanceTimersByTimeAsync(1);
            controller.abort();

            await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe.each(["native", "fallback"])("retrying input lifecycle (%s abort composition)", (implementation) => {
    const nativeAny = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
    beforeEach(() => {
        if (implementation === "fallback") Object.defineProperty(AbortSignal, "any", { value: undefined });
    });
    afterEach(() => {
        Object.defineProperty(AbortSignal, "any", nativeAny);
    });

    it("cancels the active file stream when Mediabunny disposes the input", async () => {
        const recording = delayedRecording();
        const input = new Input({ source: createRetryingBlobSource(recording.file), formats: VIDEO_INPUT_FORMATS });
        const rejection = expect(input.getPrimaryVideoTrack()).rejects.toBeInstanceOf(InputDisposedError);
        try {
            await recording.started;
            input.dispose();
            await rejection;
            expect(recording.cancellations()).toBe(1);
        } finally {
            recording.release();
            input.dispose();
        }
    });

    it("cancels the active file stream immediately on export abort", async () => {
        const recording = delayedRecording();
        const controller = new AbortController();
        const input = new Input({
            source: createRetryingBlobSource(recording.file, controller.signal),
            formats: VIDEO_INPUT_FORMATS,
        });
        const rejection = expect(input.getPrimaryVideoTrack()).rejects.toMatchObject({ name: "AbortError" });
        try {
            await recording.started;
            controller.abort();
            await rejection;
            expect(recording.cancellations()).toBe(1);
        } finally {
            recording.release();
            input.dispose();
        }
    });
});

import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { EncodedPacketSink, Input, MP4, type Source } from "mediabunny";

import { createBlobSource } from "./blob-source.js";
import { _resetForTests, getLogBuffer } from "./log.js";
import { createRetryingBlobSource } from "./retrying-blob-source.js";
import { VIDEO_INPUT_FORMATS } from "./video-formats.js";

/** Only the file read boundary is controlled; format detection and prefetch use real Mediabunny sources. */
function failingRecording(yieldPrefix: boolean) {
    const bytes = readFileSync(new URL("../tests/testdata/no-gps-h264/clip-no-gps.mp4", import.meta.url));
    const file = new File([bytes], "video.mp4");
    const error = new Error("source data unavailable");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let started!: () => void;
    const prefetchStarted = new Promise<void>((resolve) => {
        started = resolve;
    });
    const slice = file.slice.bind(file);
    file.slice = (start = 0, end, contentType): Blob => {
        const part = slice(start, end, contentType);
        part.stream = () => {
            let sentPrefix = false;
            let cancelled = false;
            return new ReadableStream<Uint8Array<ArrayBuffer>>({
                async pull(controller) {
                    if (yieldPrefix && start === 0 && !sentPrefix) {
                        sentPrefix = true;
                        controller.enqueue(new Uint8Array(bytes.subarray(0, 4096)));
                        return;
                    }
                    started();
                    await gate;
                    if (!cancelled) throw error;
                },
                cancel() {
                    cancelled = true;
                },
            });
        };
        return part;
    };
    return { file, error, release, prefetchStarted };
}

const factories: Array<{ name: string; create: (file: File, signal?: AbortSignal) => Source | Promise<Source> }> = [
    { name: "blob source", create: (file, signal) => createBlobSource(file, signal ? { signal } : {}) },
    { name: "retrying source", create: createRetryingBlobSource },
];

beforeEach(_resetForTests);

for (const factory of factories) {
    describe(factory.name, () => {
        it("reports a background read failure once and retains foreground error propagation", async () => {
            const recording = failingRecording(true);
            const input = new Input({ source: await factory.create(recording.file), formats: VIDEO_INPUT_FORMATS });
            try {
                expect(await input.getFormat()).toBe(MP4);
                await recording.prefetchStarted;
                recording.release();
                await setImmediate();
                expect(getLogBuffer()).toEqual([
                    expect.objectContaining({
                        ns: "media-source",
                        level: "warn",
                        msg: "background source read failed",
                        ctx: { file: "video.mp4", err: "Error: source data unavailable" },
                    }),
                ]);
                expect(await input.getFormat(), "cached metadata remains usable").toBe(MP4);
                const track = await input.getPrimaryVideoTrack();
                expect(track !== null, "the file header remains readable from cache").toBe(true);
                await expect(new EncodedPacketSink(track!).getFirstPacket()).rejects.toBe(recording.error);
                await setImmediate();
                expect(getLogBuffer(), "foreground failures retain their existing caller-owned reporting").toHaveLength(
                    1,
                );
            } finally {
                recording.release();
                input.dispose();
            }
        });

        it("rejects an awaited read without reporting it as a background failure", async () => {
            const recording = failingRecording(false);
            const input = new Input({ source: await factory.create(recording.file), formats: VIDEO_INPUT_FORMATS });
            try {
                const pending = expect(input.getFormat()).rejects.toBe(recording.error);
                await recording.prefetchStarted;
                recording.release();
                await pending;
                await setImmediate();
                expect(getLogBuffer()).toEqual([]);
            } finally {
                recording.release();
                input.dispose();
            }
        });

        it("does not report a late background failure after cancellation", async () => {
            const recording = failingRecording(true);
            const controller = new AbortController();
            const input = new Input({
                source: await factory.create(recording.file, controller.signal),
                formats: VIDEO_INPUT_FORMATS,
            });
            try {
                expect(await input.getFormat()).toBe(MP4);
                await recording.prefetchStarted;
                controller.abort();
                recording.release();
                await setImmediate();
                expect(getLogBuffer()).toEqual([]);
            } finally {
                recording.release();
                input.dispose();
            }
        });

        it("does not report a late background failure after input disposal", async () => {
            const recording = failingRecording(true);
            const input = new Input({ source: await factory.create(recording.file), formats: VIDEO_INPUT_FORMATS });
            try {
                expect(await input.getFormat()).toBe(MP4);
                await recording.prefetchStarted;
                input.dispose();
                recording.release();
                await setImmediate();
                expect(getLogBuffer()).toEqual([]);
            } finally {
                recording.release();
                input.dispose();
            }
        });
    });
}

describe("cached blob source", () => {
    it("keeps reporting background failures after the opening operation is cancelled", async () => {
        const recording = failingRecording(true);
        const controller = new AbortController();
        const input = new Input({
            source: await createBlobSource(recording.file, { signal: controller.signal, isCached: true }),
            formats: VIDEO_INPUT_FORMATS,
        });
        try {
            expect(await input.getFormat()).toBe(MP4);
            await recording.prefetchStarted;
            controller.abort();
            recording.release();
            await setImmediate();
            expect(getLogBuffer()).toEqual([
                expect.objectContaining({ ns: "media-source", level: "warn", msg: "background source read failed" }),
            ]);
        } finally {
            recording.release();
            input.dispose();
        }
    });
});

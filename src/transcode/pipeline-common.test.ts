import { describe, expect, it } from "vitest";
import { type AudioSample, type AudioSampleSource } from "mediabunny";

import {
    createMp4StreamOutput,
    consumeMapSnapshot,
    discardOutputQuietly,
    emitSilence,
    frameNeedsNoComposite,
    finalizeTranscodeOutput,
    joinAllOrThrowFirst,
    nextTolerant,
    type DecodeProgress,
    resolveAudioPlan,
    resolveVideoEncoderAcceleration,
} from "./pipeline-common.js";

describe("emitSilence", () => {
    it("keeps retained samples silent and tiles the partial final chunk", async () => {
        const retained: AudioSample[] = [];
        const source = {
            async add(sample: AudioSample) {
                retained.push(sample.clone());
            },
        } as unknown as AudioSampleSource;
        try {
            await emitSilence(source, 4, 0.25, 48_000, 2, new AbortController().signal);
            expect(retained.map((sample) => sample.numberOfFrames)).toEqual([4800, 4800, 2400]);
            let frames = 0;
            for (const sample of retained) {
                expect(sample.timestamp).toBeCloseTo(4 + frames / 48_000, 9);
                const data = new Float32Array(sample.numberOfFrames * sample.numberOfChannels);
                sample.copyTo(data, { planeIndex: 0 });
                expect(data.every((value) => value === 0)).toBe(true);
                frames += sample.numberOfFrames;
            }
        } finally {
            for (const sample of retained) sample.close();
        }
    });

    it("closes the sample when the output source rejects it", async () => {
        const boom = new Error("encoder rejected sample");
        let captured: AudioSample | null = null;
        const source = {
            async add(sample: AudioSample) {
                captured = sample;
                throw boom;
            },
        } as unknown as AudioSampleSource;

        await expect(emitSilence(source, 0, 0.1, 48_000, 2, new AbortController().signal)).rejects.toBe(boom);
        expect(captured).not.toBeNull();
        expect(() => captured!.allocationSize({ planeIndex: 0 })).toThrow("AudioSample is closed");
    });
});

// Builds an async iterator that yields each value in turn, then either ends
// cleanly or throws `throwAtEnd` in place of the final {done:true}.
function fakeIterator<T>(values: T[], throwAtEnd?: unknown): AsyncIterator<T> {
    let i = 0;
    return {
        async next() {
            if (i < values.length) {
                return { done: false, value: values[i++]! };
            }
            if (throwAtEnd !== undefined) throw throwAtEnd;
            return { done: true, value: undefined };
        },
    };
}

describe("nextTolerant", () => {
    const sample = { timestamp: 58, duration: 0.04 };
    const progress = (): DecodeProgress => ({
        startTimestamp: 0,
        endTimestamp: 60,
        fileEndTimestamp: 60,
        lastSampleEnd: null,
    });
    const decodeError = () => new DOMException("Decoding error.", "EncodingError");

    it("tracks decoded source time and returns samples unchanged", async () => {
        const state = progress();
        const iterator = fakeIterator([sample]);
        const result = await nextTolerant(iterator, state);
        expect(result).toEqual({ done: false, value: sample });
        expect(state.lastSampleEnd).toBeCloseTo(58.04);
        await expect(nextTolerant(iterator, state)).resolves.toEqual({ done: true, truncated: false });
    });

    it("preserves a small damaged tail after decoding frames", async () => {
        const state = progress();
        const iterator = fakeIterator([sample], decodeError());
        await nextTolerant(iterator, state);
        await expect(nextTolerant(iterator, state)).resolves.toEqual({
            done: true,
            truncated: true,
            error: "Decoding error.",
        });
    });

    it.each([
        ["before any frame", {}],
        ["in the middle of a file", { lastSampleEnd: 30 }],
        ["outside the tail loss bound", { lastSampleEnd: 57.99 }],
        ["at a trim boundary inside the file", { lastSampleEnd: 29, endTimestamp: 30 }],
        ["after decoding only a keyframe before the selected range", { startTimestamp: 59, lastSampleEnd: 58.5 }],
        ["with most of a short selection missing", { startTimestamp: 58, lastSampleEnd: 58.5 }],
        ["with invalid progress", { lastSampleEnd: NaN }],
        ["with an invalid file duration", { lastSampleEnd: 59, fileEndTimestamp: Infinity }],
    ])("propagates a decoder failure %s", async (_label, fields) => {
        const err = decodeError();
        await expect(nextTolerant(fakeIterator([], err), { ...progress(), ...fields })).rejects.toBe(err);
    });

    it("extends the tolerated tail by the spacing of a sparse decode", async () => {
        // 2.5 s missing exceeds the 2 s bound, but a sparse decode one second
        // apart never wanted the frames up to its next selected one.
        const sparse = { ...progress(), lastSampleEnd: 57.5, sparseSpacingSec: 1 };
        await expect(nextTolerant(fakeIterator([], decodeError()), sparse)).resolves.toMatchObject({
            done: true,
            truncated: true,
        });
        const err = decodeError();
        await expect(
            nextTolerant(fakeIterator([], err), { ...progress(), lastSampleEnd: 57.5 }),
            "a dense decode keeps the plain bound",
        ).rejects.toBe(err);
    });

    it("uses the same timestamp origin for source samples and file end", async () => {
        const state: DecodeProgress = {
            startTimestamp: 120,
            endTimestamp: 180,
            fileEndTimestamp: 180,
            lastSampleEnd: null,
        };
        const iterator = fakeIterator([{ timestamp: 179, duration: 0.04 }], decodeError());
        await nextTolerant(iterator, state);
        await expect(nextTolerant(iterator, state)).resolves.toMatchObject({ done: true, truncated: true });
    });

    it.each([
        new Error("decoder closed"),
        new DOMException("Encoding error. (Can't readback frame textures.)", "OperationError"),
        new DOMException("aborted", "AbortError"),
        Object.assign(new Error("cancelled"), { name: "AbortError" }),
        new TypeError("network error"),
        new DOMException("read failed", "NotReadableError"),
        "unexpected rejection",
    ])("preserves non-decode failures even at the file tail: %s", async (err) => {
        await expect(nextTolerant(fakeIterator([], err), { ...progress(), lastSampleEnd: 59 })).rejects.toBe(err);
    });
});

describe("consumeMapSnapshot", () => {
    it("preserves cancellation reconstructed as an Error across a worker boundary", async () => {
        const aborted = Object.assign(new Error("cancelled"), { name: "AbortError" });
        await expect(
            consumeMapSnapshot(
                {} as OffscreenCanvasRenderingContext2D,
                1920,
                1080,
                {
                    xPct: 75,
                    yPct: 75,
                    scalePct: 100,
                    zoomKm: 1,
                    shape: "circle",
                    headingUp: false,
                    adaptiveZoom: false,
                },
                Promise.reject(aborted),
                1,
            ),
        ).rejects.toBe(aborted);
    });
});

// Records the call sequence of an FSA-shaped writable. close() after abort()
// rejects, mirroring both real sinks (the port wrapper stores the abort as its
// failure; a native FSA stream is already errored) - a resolved close here
// would mean the partial file committed.
function recordingWritable() {
    const calls: string[] = [];
    let aborted = false;
    let committed = false;
    const writable = {
        write: async (): Promise<void> => {
            calls.push("write");
        },
        close: async (): Promise<void> => {
            calls.push("close");
            if (aborted) throw new TypeError("cannot close after abort");
            committed = true;
        },
        abort: async (): Promise<void> => {
            aborted = true;
            calls.push("abort");
        },
    } as unknown as FileSystemWritableFileStream;
    return { writable, calls, isCommitted: () => committed };
}

describe("discardOutputQuietly", () => {
    it("discards an export with no video frames instead of committing an unusable file", async () => {
        const { writable, calls, isCommitted } = recordingWritable();
        const signal = new AbortController().signal;
        const out = createMp4StreamOutput(writable, signal, () => {});
        await expect(
            finalizeTranscodeOutput({
                out,
                writable,
                signal,
                onProgress: () => {},
                framesDone: 0,
                framesTotal: 30,
                getBytesWritten: () => 0,
                durationSec: 0,
            }),
        ).rejects.toThrow("no video frames could be exported");
        expect(calls[0]).toBe("abort");
        expect(isCommitted()).toBe(false);
        expect(out.state).toBe("canceled");
    });

    it("aborts the writable first, then cancels the muxer, and never commits", async () => {
        const { writable, calls, isCommitted } = recordingWritable();
        const out = createMp4StreamOutput(writable, new AbortController().signal, () => {});

        await discardOutputQuietly(out, writable);

        expect(calls[0], "abort must precede whatever Output.cancel() does to its target").toBe("abort");
        expect(isCommitted()).toBe(false);
        expect(out.state).toBe("canceled");
    });

    it("still cancels the muxer when the writable is already terminal", async () => {
        const { writable } = recordingWritable();
        const out = createMp4StreamOutput(writable, new AbortController().signal, () => {});
        await writable.abort("earlier failure");

        await expect(discardOutputQuietly(out, writable)).resolves.toBeUndefined();
        expect(out.state).toBe("canceled");
    });
});

// resolveAudioPlan decides how the re-encode export handles audio. The decode/
// encode/copy execution is exercised end-to-end in tests/e2e/export-run.spec.ts;
// here we lock the decision logic, which is plain branching over the source codec.
// node-vitest has no AudioEncoder, so resolveEncodeAudioCodec returns null - which
// lets us assert the "no encoder -> drop" branch deterministically too.
describe("resolveAudioPlan", () => {
    // Passthrough returns before touching the file (no ADPCM probe), so a dummy
    // File is enough for those cases.
    const dummyFile = new File([new Uint8Array(0)], "x.mp4");

    it("stream-copies an AAC source at 1x with a decoder config (passthrough - no encoder needed)", async () => {
        const plan = await resolveAudioPlan(
            { codec: "aac", sampleRate: 48_000, numberOfChannels: 2 },
            dummyFile,
            true,
            true,
        );
        expect(plan.mode).toBe("passthrough");
        if (plan.mode === "passthrough") expect(plan.codec).toBe("aac");
    });

    it("stream-copies an MP3 source at 1x (passthrough)", async () => {
        const plan = await resolveAudioPlan(
            { codec: "mp3", sampleRate: 44_100, numberOfChannels: 2 },
            dummyFile,
            true,
            true,
        );
        expect(plan.mode).toBe("passthrough");
    });

    it("drops audio benignly when a passthrough codec has no decoder config (damaged esds)", async () => {
        // firstHasDecoderConfig=false: a readable AAC/MP3 tag whose decoder config
        // is absent (power-cut/corrupt esds) cannot be muxed - the muxer throws on
        // the first packet's missing config. The plan must skip BENIGNLY
        // (noEncoder:false), mirroring exportClip's guard, not commit a track that
        // crashes mid-export. Regression gate for the null-decoder-config fix.
        const plan = await resolveAudioPlan(
            { codec: "aac", sampleRate: 48_000, numberOfChannels: 2 },
            dummyFile,
            true,
            false,
        );
        expect(plan).toEqual({ mode: "skip", noEncoder: false });
    });

    it("takes the encode path when passthrough is disabled, dropping audio with no encoder", async () => {
        // Precondition: node-vitest genuinely has no AudioEncoder, so
        // resolveEncodeAudioCodec returns null and the encode path falls to drop.
        // Asserted so the test fails LOUD (not a silent green) if node ever gains it.
        expect(typeof (globalThis as { AudioEncoder?: unknown }).AudioEncoder).toBe("undefined");
        // allowPassthrough=false (e.g. a sped-up export) forces re-encode.
        const plan = await resolveAudioPlan(
            { codec: "aac", sampleRate: 48_000, numberOfChannels: 2 },
            dummyFile,
            false,
            true,
        );
        expect(plan).toEqual({ mode: "skip", noEncoder: true });
    });

    it("re-encodes a non-passthrough readable codec, dropping audio with no encoder", async () => {
        // FLAC is readable but not in PASSTHROUGH_AUDIO_CODECS -> encode path (the
        // decoder-config guard is passthrough-only, so the 4th arg is irrelevant
        // here). node has no AudioEncoder -> resolveEncodeAudioCodec null -> drop.
        const plan = await resolveAudioPlan(
            { codec: "flac", sampleRate: 48_000, numberOfChannels: 2 },
            dummyFile,
            true,
            true,
        );
        expect(plan).toEqual({ mode: "skip", noEncoder: true });
    });
});

// AudioTrackResampler was removed when the re-encode pipelines moved back to the
// AAC source's built-in `transform` resampler (mediabunny's documented path).
// Heterogeneous-format ranges are now gated upstream (probeAudioUniformity drops
// audio + warns), so there is no on-our-side resampler left to unit-test. The
// audio re-encode path (transform to 48k/stereo, silence-gap fill) is exercised
// end-to-end by tests/e2e/export-run.spec.ts on a real re-encode export.

describe("joinAllOrThrowFirst", () => {
    it("resolves once every task resolved", async () => {
        const order: string[] = [];
        await joinAllOrThrowFirst([
            (async () => {
                order.push("a");
            })(),
            (async () => {
                order.push("b");
            })(),
        ]);
        expect(order).toEqual(["a", "b"]);
    });

    it("rethrows the first rejection", async () => {
        const boom = new Error("video died");
        await expect(joinAllOrThrowFirst([Promise.reject(boom), Promise.resolve()])).rejects.toBe(boom);
    });

    it("waits for the surviving task before rethrowing", async () => {
        // The caller's finally disposes the segment's Inputs right after this
        // resolves, so a still-running producer must never outlive it.
        let audioFinished = false;
        const audio = new Promise<void>((resolve) => {
            setTimeout(() => {
                audioFinished = true;
                resolve();
            }, 5);
        });
        await expect(joinAllOrThrowFirst([Promise.reject(new Error("video died")), audio])).rejects.toThrow(
            "video died",
        );
        expect(audioFinished, "audio settled before the rejection surfaced").toBe(true);
    });

    it("surfaces the first rejection when both fail", async () => {
        const first = new Error("first");
        await expect(joinAllOrThrowFirst([Promise.reject(first), Promise.reject(new Error("second"))])).rejects.toBe(
            first,
        );
    });
});

describe("frameNeedsNoComposite", () => {
    const frame = (over: Partial<Parameters<typeof frameNeedsNoComposite>[0]> = {}) => ({
        rotation: 0,
        flip: false,
        codedWidth: 1920,
        codedHeight: 1080,
        displayWidth: 1920,
        displayHeight: 1080,
        ...over,
    });

    it("accepts a frame that already is the output frame", () => {
        expect(frameNeedsNoComposite(frame(), 1920, 1080)).toBe(true);
    });

    it("rejects a resize in either direction", () => {
        expect(frameNeedsNoComposite(frame(), 1280, 720)).toBe(false);
        expect(frameNeedsNoComposite(frame({ codedWidth: 1280, displayWidth: 1280 }), 1920, 1080)).toBe(false);
    });

    it("rejects a rotated source", () => {
        expect(frameNeedsNoComposite(frame({ rotation: 90 }), 1920, 1080)).toBe(false);
        expect(frameNeedsNoComposite(frame({ rotation: 180 }), 1920, 1080)).toBe(false);
    });

    it("rejects reflection stored in the source metadata", () => {
        expect(frameNeedsNoComposite(frame({ flip: true }), 1920, 1080)).toBe(false);
    });

    it("rejects a non-square pixel aspect", () => {
        // Anamorphic: 1440 coded pixels displayed as 1920 square ones. Only
        // VideoSample.draw applies that stretch, so the raw frame must not go
        // straight to the encoder.
        expect(frameNeedsNoComposite(frame({ codedWidth: 1440 }), 1920, 1080)).toBe(false);
    });
});

describe("resolveVideoEncoderAcceleration", () => {
    it("uses the output preference when no late decision is pending", async () => {
        const acceleration = await resolveVideoEncoderAcceleration(
            undefined,
            "prefer-hardware",
            new AbortController().signal,
        );
        expect(acceleration).toBe("prefer-hardware");
    });

    it("replaces the output preference with the late decision", async () => {
        const acceleration = await resolveVideoEncoderAcceleration(
            async () => "prefer-software",
            "no-preference",
            new AbortController().signal,
        );
        expect(acceleration).toBe("prefer-software");
    });

    it("fails with AbortError when the run is cancelled while waiting", async () => {
        const controller = new AbortController();
        const pending = resolveVideoEncoderAcceleration(
            async () => {
                controller.abort();
                return "prefer-software";
            },
            "no-preference",
            controller.signal,
        );
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    });

    it("propagates a rejected decision unchanged", async () => {
        const failure = new DOMException("trial cancelled", "AbortError");
        const pending = resolveVideoEncoderAcceleration(
            () => Promise.reject(failure),
            "no-preference",
            new AbortController().signal,
        );
        await expect(pending).rejects.toBe(failure);
    });
});

import { describe, expect, it } from "vitest";

import { detectionSampleTiming, withFinalSample } from "./detection-decode.js";

function sample(id: number) {
    return {
        id,
        closes: 0,
        close() {
            this.closes++;
        },
    };
}

describe("withFinalSample", () => {
    it("marks the final sample and closes each borrowed sample after use", async () => {
        const samples = [sample(0), sample(1), sample(2)];
        let isSourceClosed = false;
        async function* source() {
            try {
                yield* samples;
            } finally {
                isSourceClosed = true;
            }
        }
        const seen: Array<{ id: number; isLast: boolean }> = [];
        for await (const { sample: current, isLast } of withFinalSample(source())) {
            expect(current.closes, "the caller can still read the borrowed sample").toBe(0);
            if (current.id > 0) expect(samples[current.id - 1]!.closes).toBe(1);
            seen.push({ id: current.id, isLast });
        }
        expect(seen).toEqual([
            { id: 0, isLast: false },
            { id: 1, isLast: false },
            { id: 2, isLast: true },
        ]);
        expect(samples.map((value) => value.closes)).toEqual([1, 1, 1]);
        expect(isSourceClosed).toBe(true);
    });

    it("closes the current and prefetched samples when the caller stops early", async () => {
        const samples = [sample(0), sample(1), sample(2)];
        let isSourceClosed = false;
        async function* source() {
            try {
                yield* samples;
            } finally {
                isSourceClosed = true;
            }
        }
        for await (const current of withFinalSample(source())) {
            expect(current.sample.id).toBe(0);
            break;
        }
        expect(samples.map((value) => value.closes)).toEqual([1, 1, 0]);
        expect(isSourceClosed).toBe(true);
    });

    it("closes a pending sample when looking ahead fails to decode", async () => {
        const pending = sample(0);
        const failure = new Error("decode failed");
        async function* source() {
            yield pending;
            throw failure;
        }
        const iterator = withFinalSample(source());
        await expect(iterator.next()).rejects.toBe(failure);
        expect(pending.closes).toBe(1);
    });

    it("closes borrowed and prefetched samples when the caller aborts", async () => {
        const samples = [sample(0), sample(1)];
        const controller = new AbortController();
        let isSourceClosed = false;
        async function* source() {
            try {
                yield* samples;
            } finally {
                isSourceClosed = true;
            }
        }
        const consume = async () => {
            for await (const current of withFinalSample(source())) {
                expect(current.sample.closes).toBe(0);
                controller.abort();
                controller.signal.throwIfAborted();
            }
        };
        await expect(consume()).rejects.toMatchObject({ name: "AbortError" });
        expect(samples.map((value) => value.closes)).toEqual([1, 1]);
        expect(isSourceClosed).toBe(true);
    });

    it("completes an empty source without yielding a sample", async () => {
        async function* source() {
            yield* [] as ReturnType<typeof sample>[];
        }
        expect(await withFinalSample(source()).next()).toEqual({ done: true, value: undefined });
    });
});

describe("detectionSampleTiming", () => {
    it.each([
        [false, { timestamp: 1, duration: 0.04 }, 2, 0.04],
        [true, { timestamp: 1, duration: 0.04 }, 1.02, 0.02],
        [true, { timestamp: 1, duration: 0.04 }, 1.04, 0.04],
    ])("does not scan the source end when no final extension is needed (%s)", async (isLast, frame, end, duration) => {
        const timing = await detectionSampleTiming(frame, isLast, end, async () => {
            throw new Error("unexpected source end scan");
        });
        expect(timing.timestamp).toBe(frame.timestamp);
        expect(timing.duration).toBeCloseTo(duration);
    });

    it("holds the verified final source sample through an audio tail", async () => {
        const frame = { timestamp: 1, duration: 0.04 };
        const timing = await detectionSampleTiming(frame, true, 1.5, async () => frame);
        expect(timing).toEqual({ timestamp: 1, duration: 0.5 });
    });

    it("holds a verified final sample with zero duration", async () => {
        const frame = { timestamp: 1, duration: 0 };
        const timing = await detectionSampleTiming(frame, true, 1.5, async () => frame);
        expect(timing).toEqual({ timestamp: 1, duration: 0.5 });
    });

    it.each([
        ["a trim boundary", { timestamp: 2, duration: 0.04 }],
        ["a dropped final frame", { timestamp: 1.04, duration: 0.04 }],
        ["a dropped final frame with zero duration", { timestamp: 1.04, duration: 0 }],
        ["no final packet", null],
    ])("does not extend the last yielded sample across %s", async (_label, finalPacket) => {
        const timing = await detectionSampleTiming(
            { timestamp: 1, duration: 0.04 },
            true,
            1.5,
            async () => finalPacket,
        );
        expect(timing.timestamp).toBe(1);
        expect(timing.duration).toBeCloseTo(0.04);
    });

    it("propagates a final-packet read failure", async () => {
        const failure = new Error("source read failed");
        await expect(
            detectionSampleTiming({ timestamp: 1, duration: 0.04 }, true, 1.5, async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);
    });
});

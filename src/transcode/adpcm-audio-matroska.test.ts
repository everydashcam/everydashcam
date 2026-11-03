import { readFileSync } from "node:fs";
import type { AudioSample, AudioSampleSource } from "mediabunny";
import { describe, expect, it } from "vitest";
import { openMatroskaAdpcmAudio } from "./adpcm-audio-matroska.js";

const FIXTURE = "../../tests/testdata/audio-export/__fixtures__/ima-adpcm/20260101_120000.mkv";

interface CapturedSample {
    timestamp: number;
    frames: number;
    data: Int16Array;
}

function fixture(): File {
    return new File([readFileSync(new URL(FIXTURE, import.meta.url))], "20260101_120000.mkv");
}

/** Records each added sample's timing and PCM; the reader closes the sample afterwards. */
function captureSource(): { source: AudioSampleSource; samples: CapturedSample[] } {
    const samples: CapturedSample[] = [];
    const source = {
        async add(sample: AudioSample) {
            const data = new Int16Array(sample.allocationSize({ format: "s16", planeIndex: 0 }) / 2);
            sample.copyTo(data, { format: "s16", planeIndex: 0 });
            samples.push({ timestamp: sample.timestamp, frames: sample.numberOfFrames, data });
        },
    } as unknown as AudioSampleSource;
    return { source, samples };
}

/** Checks that every sample starts where the previous one ended. */
function expectContiguous(samples: CapturedSample[], firstTimestamp: number, sampleRate: number): void {
    let frames = 0;
    for (const sample of samples) {
        expect(sample.timestamp, `sample at frame ${frames}`).toBeCloseTo(firstTimestamp + frames / sampleRate, 9);
        frames += sample.frames;
    }
}

describe("openMatroskaAdpcmAudio", () => {
    it("reads the IMA ADPCM track that mediabunny cannot decode", async () => {
        const reader = await openMatroskaAdpcmAudio(fixture());
        expect(reader).not.toBeNull();
        expect(reader!.channels).toBe(1);
        expect(reader!.sampleRate).toBe(32_000);
    });

    it("feeds the same blocks in steps as feedRange over the whole range", async () => {
        const reader = (await openMatroskaAdpcmAudio(fixture()))!;
        const whole = captureSource();
        const wholeSec = await reader.feedRange(whole.source, 0.3, 1.7, 10);

        const stepped = captureSource();
        const cursor = reader.openRange(stepped.source, 0.3, 10);
        await cursor.feedBefore(0.5);
        const afterFirstLimit = stepped.samples.length;
        await cursor.feedBefore(0.4);
        expect(stepped.samples.length, "an earlier limit is a no-op").toBe(afterFirstLimit);
        await cursor.feedBefore(1.2);
        const afterSecondLimit = stepped.samples.length;
        await cursor.finish(1.7);
        await cursor.close();

        expect(afterFirstLimit, "the first limit already emits audio").toBeGreaterThan(0);
        expect(afterSecondLimit, "a later limit emits more").toBeGreaterThan(afterFirstLimit);
        expect(stepped.samples.length, "finish emits the remainder").toBeGreaterThan(afterSecondLimit);
        expect(stepped.samples).toEqual(whole.samples);
        expect(cursor.emittedSec).toBeCloseTo(wholeSec, 9);
        expect(whole.samples[0]!.timestamp).toBe(10);
        expectContiguous(whole.samples, 10, reader.sampleRate);
    });

    it("feeds the player from a start position to the end of the track", async () => {
        const reader = (await openMatroskaAdpcmAudio(fixture()))!;
        const { source, samples } = captureSource();
        let firstEmits = 0;
        await reader.feedToEnd(source, 0, 0.25, undefined, () => firstEmits++);

        expect(firstEmits).toBe(1);
        expect(samples[0]!.timestamp).toBeCloseTo(0.25, 9);
        expectContiguous(samples, 0.25, reader.sampleRate);
        const totalSec = samples.reduce((sum, sample) => sum + sample.frames, 0) / reader.sampleRate;
        expect(totalSec).toBeGreaterThan(1.95);
        expect(totalSec).toBeLessThan(2.1);
    });
});

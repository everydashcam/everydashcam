import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openMatroskaAdpcmAudio } from "./adpcm-audio-matroska.js";
import { captureAudioSamples, expectContiguousSamples } from "./test-helpers.js";

const FIXTURE = "../../tests/testdata/audio-export/__fixtures__/ima-adpcm/20260101_120000.mkv";

function fixture(): File {
    return new File([readFileSync(new URL(FIXTURE, import.meta.url))], "20260101_120000.mkv");
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
        const whole = captureAudioSamples("s16");
        const wholeSec = await reader.feedRange(whole.source, 0.3, 1.7, 10);

        const stepped = captureAudioSamples("s16");
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
        expect(whole.samples[0]!.timestamp).toBeCloseTo(10, 9);
        expectContiguousSamples(whole.samples, 10);
    });

    it("feeds the player from a start position to the end of the track", async () => {
        const reader = (await openMatroskaAdpcmAudio(fixture()))!;
        const { source, samples } = captureAudioSamples("s16");
        let firstEmits = 0;
        await reader.feedToEnd(source, 0, 0.25, undefined, () => firstEmits++);

        expect(firstEmits).toBe(1);
        expect(samples[0]!.timestamp).toBeCloseTo(0.25, 9);
        const totalSec = expectContiguousSamples(samples, 0.25) - 0.25;
        expect(totalSec).toBeGreaterThan(1.95);
        expect(totalSec).toBeLessThan(2.1);
    });
});

// Test-only capture of what an audio reader or cursor feeds to its sink. Kept
// beside the transcode code so the ADPCM readers and the segment cursors are
// checked with one sink and one continuity check.

import type { AudioSample, AudioSampleSource } from "mediabunny";
import { expect } from "vitest";

export type CapturedPcmFormat = "s16" | "f32";

type CapturedPcm<Format extends CapturedPcmFormat> = Format extends "s16" ? Int16Array : Float32Array;

export interface CapturedAudioSample<Format extends CapturedPcmFormat = CapturedPcmFormat> {
    timestamp: number;
    duration: number;
    frames: number;
    /** Interleaved PCM of every channel. */
    data: CapturedPcm<Format>;
}

function allocatePcm<Format extends CapturedPcmFormat>(format: Format, length: number): CapturedPcm<Format> {
    return (format === "s16" ? new Int16Array(length) : new Float32Array(length)) as CapturedPcm<Format>;
}

/**
 * An AudioSampleSource stub recording each added sample's timing and
 * interleaved PCM in `format`. The feeder closes the sample once `add`
 * resolves, so the data is copied out immediately.
 */
export function captureAudioSamples<Format extends CapturedPcmFormat>(
    format: Format,
): { source: AudioSampleSource; samples: CapturedAudioSample<Format>[] } {
    const samples: CapturedAudioSample<Format>[] = [];
    const source = {
        async add(sample: AudioSample) {
            const bytesPerValue = format === "s16" ? 2 : 4;
            const data = allocatePcm(format, sample.allocationSize({ format, planeIndex: 0 }) / bytesPerValue);
            sample.copyTo(data, { format, planeIndex: 0 });
            samples.push({
                timestamp: sample.timestamp,
                duration: sample.duration,
                frames: sample.numberOfFrames,
                data,
            });
        },
    } as unknown as AudioSampleSource;
    return { source, samples };
}

/** Concatenates the captured samples' interleaved PCM into one buffer. */
export function concatCapturedPcm<Format extends CapturedPcmFormat>(
    samples: { data: CapturedPcm<Format> }[],
    format: Format,
): CapturedPcm<Format> {
    const total = samples.reduce((sum, sample) => sum + sample.data.length, 0);
    const pcm = allocatePcm(format, total);
    let offset = 0;
    for (const sample of samples) {
        pcm.set(sample.data, offset);
        offset += sample.data.length;
    }
    return pcm;
}

/**
 * Asserts that the samples tile one continuous run from `firstTimestamp`: each
 * starts where the previous one ended. Returns the end of the run.
 */
export function expectContiguousSamples(samples: CapturedAudioSample[], firstTimestamp: number): number {
    let end = firstTimestamp;
    for (const [index, sample] of samples.entries()) {
        expect(sample.timestamp, `sample ${index} starts where the previous one ended`).toBeCloseTo(end, 6);
        end = sample.timestamp + sample.duration;
    }
    return end;
}

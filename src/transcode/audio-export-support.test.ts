import { describe, expect, it } from "vitest";
import { getPcmLayout } from "./audio-export-support.js";

describe("getPcmLayout", () => {
    it("sizes a frame from the sample width and channel count", () => {
        expect(getPcmLayout("pcm-s16", { codec: "pcm-s16", sampleRate: 8000, numberOfChannels: 1 })).toEqual({
            bytesPerFrame: 2,
            sampleRate: 8000,
        });
        expect(getPcmLayout("pcm-s24be", { codec: "pcm-s24be", sampleRate: 48_000, numberOfChannels: 2 })).toEqual({
            bytesPerFrame: 6,
            sampleRate: 48_000,
        });
        expect(getPcmLayout("pcm-f64", { codec: "pcm-f64", sampleRate: 44_100, numberOfChannels: 2 })).toEqual({
            bytesPerFrame: 16,
            sampleRate: 44_100,
        });
        expect(getPcmLayout("ulaw", { codec: "ulaw", sampleRate: 8000, numberOfChannels: 1 })).toEqual({
            bytesPerFrame: 1,
            sampleRate: 8000,
        });
    });

    it("leaves compressed audio and unusable configurations unsplit", () => {
        expect(getPcmLayout("aac", { codec: "mp4a.40.2", sampleRate: 48_000, numberOfChannels: 2 })).toBeNull();
        expect(getPcmLayout("pcm-s16", { codec: "pcm-s16", sampleRate: 8000, numberOfChannels: 0 })).toBeNull();
    });
});

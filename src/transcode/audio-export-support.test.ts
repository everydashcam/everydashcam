import { EncodedPacket } from "mediabunny";
import { describe, expect, it } from "vitest";
import {
    clonePcmPiece,
    getPcmLayout,
    MIN_PARTIAL_AUDIO_FEED_SEC,
    nextPcmPiece,
    type PcmLayout,
} from "./audio-export-support.js";

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

describe("nextPcmPiece", () => {
    // One two-second packet of 16-bit mono at 8 kHz, presented at 10 s.
    const layout: PcmLayout = { bytesPerFrame: 2, sampleRate: 8000 };
    const packet = { timestamp: 10, byteLength: 16_000 * 2 };

    it("waits until the limit is at least the minimum feed past the copied frames", () => {
        expect(nextPcmPiece(packet, layout, 0, 10.1, false)).toBeNull();
        expect(nextPcmPiece(packet, layout, 0, 10 + MIN_PARTIAL_AUDIO_FEED_SEC, false)).toEqual({
            fromFrame: 0,
            toFrame: 2000,
            startSec: 10,
            isTail: false,
        });
        expect(nextPcmPiece(packet, layout, 2000, 10.3, false), "a short step after a copied head waits").toBeNull();
        expect(nextPcmPiece(packet, layout, 2000, 10.9, false)).toEqual({
            fromFrame: 2000,
            toFrame: 7200,
            startSec: 10.25,
            isTail: false,
        });
    });

    it("ignores a limit behind the copied frames", () => {
        expect(nextPcmPiece(packet, layout, 4000, 10.2, false)).toBeNull();
        expect(nextPcmPiece(packet, layout, 4000, 10.2, true)).toBeNull();
    });

    it("takes the rest of the packet once the limit passes its end", () => {
        expect(nextPcmPiece(packet, layout, 0, 12, false)).toEqual({
            fromFrame: 0,
            toFrame: 16_000,
            startSec: 10,
            isTail: true,
        });
        expect(nextPcmPiece(packet, layout, 7200, 12.5, true)).toEqual({
            fromFrame: 7200,
            toFrame: 16_000,
            startSec: expect.closeTo(10.9, 9),
            isTail: true,
        });
    });

    it("cuts the packet at the segment end however short the rest is", () => {
        expect(nextPcmPiece(packet, layout, 7200, 10.91, true)).toEqual({
            fromFrame: 7200,
            toFrame: 7280,
            startSec: expect.closeTo(10.9, 9),
            isTail: false,
        });
        expect(nextPcmPiece(packet, layout, 0, 10.01, true)).toEqual({
            fromFrame: 0,
            toFrame: 80,
            startSec: 10,
            isTail: false,
        });
    });

    it("treats a packet shorter than one frame as one whole piece", () => {
        expect(nextPcmPiece({ timestamp: 10, byteLength: 1 }, layout, 0, 10.5, false)).toEqual({
            fromFrame: 0,
            toFrame: 0,
            startSec: 10,
            isTail: true,
        });
    });
});

describe("clonePcmPiece", () => {
    const layout: PcmLayout = { bytesPerFrame: 2, sampleRate: 8000 };
    // Sixteen frames plus one trailing byte that completes no frame.
    const data = Uint8Array.from({ length: 33 }, (_, index) => index);
    const packet = new EncodedPacket(data, "key", 10, 0);

    it("keeps a packet copied in one piece byte-identical with a frame-derived duration", () => {
        const copy = clonePcmPiece(packet, layout, { fromFrame: 0, toFrame: 16, startSec: 10, isTail: true }, 3);
        expect(copy.data).toEqual(data);
        expect(copy.timestamp).toBe(3);
        expect(copy.duration).toBeCloseTo(16 / 8000, 12);
        expect(copy.type).toBe("key");
    });

    it("slices an inner piece at frame boundaries", () => {
        const piece = { fromFrame: 4, toFrame: 10, startSec: 10.0005, isTail: false };
        const copy = clonePcmPiece(packet, layout, piece, 3.0005);
        expect(copy.data).toEqual(data.subarray(8, 20));
        expect(copy.timestamp).toBe(3.0005);
        expect(copy.duration).toBeCloseTo(6 / 8000, 12);
    });

    it("keeps the trailing bytes in the tail piece", () => {
        const piece = { fromFrame: 10, toFrame: 16, startSec: 10.00125, isTail: true };
        const copy = clonePcmPiece(packet, layout, piece, 3.00125);
        expect(copy.data).toEqual(data.subarray(20));
        expect(copy.duration).toBeCloseTo(6 / 8000, 12);
    });
});

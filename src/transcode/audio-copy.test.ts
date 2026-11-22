import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    BlobSource,
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    Input,
    Mp4OutputFormat,
    Output,
} from "../mediabunny.js";
import { describe, expect, it } from "vitest";
import { VIDEO_INPUT_FORMATS } from "../video-formats.js";
import { createMp4StreamOutput, feedSegmentAudioCopy, finalizeTranscodeOutput } from "./pipeline-common.js";

function realTransportStream(): File {
    return new File(
        [readFileSync(resolve(import.meta.dirname, "../parsers/__fixtures__/juscar/real-anonymized.TS"))],
        "clip.TS",
    );
}

function open(file: Blob): Input {
    return new Input({ source: new BlobSource(file), formats: VIDEO_INPUT_FORMATS });
}

async function copyAudio(
    input: Input,
    source: EncodedAudioPacketSource,
    options: {
        startInFile?: number;
        endInFile?: number;
        segBaseOutSec?: number;
        audioLastEndSec?: number;
        pushDecoderConfig?: boolean;
    } = {},
) {
    return feedSegmentAudioCopy({
        input,
        audioSource: source,
        startInFile: 0,
        endInFile: 1,
        segBaseOutSec: 0,
        audioLastEndSec: 0,
        pushDecoderConfig: true,
        signal: new AbortController().signal,
        onTruncated: () => {
            throw new Error("real fixture must not truncate");
        },
        ...options,
    });
}

async function delayedMp4Audio(): Promise<File> {
    const input = open(realTransportStream());
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat(), target });
    const source = new EncodedAudioPacketSource("aac");
    output.addAudioTrack(source);
    try {
        const track = (await input.getPrimaryAudioTrack())!;
        const config = (await track.getDecoderConfig())!;
        const firstTimestamp = await track.getFirstTimestamp();
        await output.start();
        for await (const packet of new EncodedPacketSink(track).packets()) {
            await source.add(packet.clone({ timestamp: packet.timestamp - firstTimestamp + 0.25 }), {
                decoderConfig: config,
            });
        }
        await output.finalize();
        return new File([target.buffer!], "delayed.mp4");
    } finally {
        input.dispose();
    }
}

describe("transcode audio copy", () => {
    it("normalizes the transport clock and retains real TS audio from content time zero", async () => {
        const input = open(realTransportStream());
        const target = new BufferTarget();
        const output = new Output({ format: new Mp4OutputFormat(), target });
        const source = new EncodedAudioPacketSource("aac");
        output.addAudioTrack(source);
        try {
            const original = (await input.getPrimaryAudioTrack())!;
            expect(await original.getFirstTimestamp()).toBeGreaterThan(1);
            await output.start();
            const copied = await copyAudio(input, source);
            expect(copied.configPushed).toBe(true);
            await output.finalize();
            const exported = open(new Blob([target.buffer!]));
            try {
                const track = (await exported.getPrimaryAudioTrack())!;
                expect(track).not.toBeNull();
                expect(await track.getFirstTimestamp()).toBeCloseTo(0, 6);
                expect(await track.computeDuration()).toBeGreaterThan(0.95);
                expect(await track.computeDuration()).toBeLessThan(1.03);
            } finally {
                exported.dispose();
            }
        } finally {
            input.dispose();
        }
    });

    it("keeps an MP4 audio delay when the range begins before its first packet", async () => {
        const input = open(await delayedMp4Audio());
        const target = new BufferTarget();
        const output = new Output({ format: new Mp4OutputFormat(), target });
        const source = new EncodedAudioPacketSource("aac");
        output.addAudioTrack(source);
        try {
            await output.start();
            await copyAudio(input, source);
            await output.finalize();
            const exported = open(new Blob([target.buffer!]));
            try {
                const track = (await exported.getPrimaryAudioTrack())!;
                expect(track).not.toBeNull();
                expect(await track.getFirstTimestamp()).toBeCloseTo(0.25, 6);
            } finally {
                exported.dispose();
            }
        } finally {
            input.dispose();
        }
    });

    it("keeps every segment on the video timeline without accumulating packet rounding", async () => {
        const input = open(realTransportStream());
        const target = new BufferTarget();
        const output = new Output({ format: new Mp4OutputFormat(), target });
        const source = new EncodedAudioPacketSource("aac");
        output.addAudioTrack(source);
        let lastEnd = 0;
        try {
            await output.start();
            for (let segment = 0; segment < 20; segment++) {
                const copied = await copyAudio(input, source, {
                    endInFile: 0.5,
                    segBaseOutSec: segment * 0.5,
                    audioLastEndSec: lastEnd,
                    pushDecoderConfig: segment === 0,
                });
                lastEnd = copied.audioLastEndSec;
            }
            await output.finalize();
            expect(lastEnd).toBeGreaterThanOrEqual(10);
            expect(lastEnd).toBeLessThan(10.03);
        } finally {
            input.dispose();
        }
    });

    it("reports bytes flushed during finalization for an output smaller than one chunk", async () => {
        const input = open(realTransportStream());
        let bytesWritten = 0;
        let actualBytes = 0;
        const writable = {
            async write(chunk: { data: Uint8Array }) {
                actualBytes += chunk.data.byteLength;
            },
            async close() {},
            async abort() {},
        } as unknown as FileSystemWritableFileStream;
        const signal = new AbortController().signal;
        const output = createMp4StreamOutput(writable, signal, (count) => {
            bytesWritten += count;
        });
        const source = new EncodedAudioPacketSource("aac");
        output.addAudioTrack(source);
        try {
            await output.start();
            await copyAudio(input, source);
            expect(bytesWritten).toBe(0);
            const result = await finalizeTranscodeOutput({
                out: output,
                writable,
                signal,
                onProgress() {},
                framesDone: 30,
                framesTotal: 30,
                durationSec: 1,
                getBytesWritten: () => bytesWritten,
            });
            expect(result.sizeBytes).toBeGreaterThan(1024);
            expect(result.sizeBytes).toBe(actualBytes);
        } finally {
            input.dispose();
        }
    });
});

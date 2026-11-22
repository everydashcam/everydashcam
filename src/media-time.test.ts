import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    BlobSource,
    BufferTarget,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    Mp4OutputFormat,
    Output,
} from "./mediabunny.js";

import { getInputTimeOrigin } from "./media-time.js";
import { indexOneFile } from "./parsers/internal/mp4-indexing.js";
import { VIDEO_INPUT_FORMATS } from "./video-formats.js";

function recording(path: string, name: string): File {
    return new File([readFileSync(new URL(path, import.meta.url))], name);
}

describe("media time origin", () => {
    it("uses the transport clock origin regardless of the file extension", async () => {
        const input = new Input({
            source: new BlobSource(recording("./parsers/__fixtures__/juscar/real-anonymized.TS", "camera.mp4")),
            formats: VIDEO_INPUT_FORMATS,
        });
        try {
            expect(await getInputTimeOrigin(input)).toBeCloseTo(1.4, 6);
        } finally {
            input.dispose();
        }
    });

    it("indexes the recorded TS span rather than the ending transport timestamp", async () => {
        const file = recording("./parsers/__fixtures__/novatek-ts/real-anonymized.TS", "camera.ts");
        const { indexed } = await indexOneFile(file, false);
        expect(indexed).not.toBeNull();
        expect(indexed!.durationSec).toBeCloseTo(10.112, 6);
    });

    it("preserves a delayed MP4 composition even when it has a TS extension", async () => {
        const original = new Input({
            source: new BlobSource(recording("../tests/testdata/no-gps-h264/clip-no-gps.mp4", "original.mp4")),
            formats: VIDEO_INPUT_FORMATS,
        });
        const target = new BufferTarget();
        const output = new Output({ target, format: new Mp4OutputFormat() });
        try {
            const track = await original.getPrimaryVideoTrack();
            expect(track).not.toBeNull();
            const packet = await new EncodedPacketSink(track!).getFirstKeyPacket({ verifyKeyPackets: true });
            expect(packet).not.toBeNull();
            const source = new EncodedVideoPacketSource("avc");
            output.addVideoTrack(source);
            await output.start();
            const decoderConfig = await track!.getDecoderConfig();
            expect(decoderConfig).not.toBeNull();
            await source.add(packet!.clone({ timestamp: 5 }), { decoderConfig: decoderConfig! });
            await output.finalize();
            const file = new File([target.buffer!], "delayed.ts");
            const input = new Input({ source: new BlobSource(file), formats: VIDEO_INPUT_FORMATS });
            try {
                expect(await input.getFirstTimestamp()).toBeCloseTo(5, 6);
                expect(await getInputTimeOrigin(input)).toBe(0);
                const { indexed } = await indexOneFile(file, false);
                expect(indexed!.durationSec).toBeCloseTo(5 + packet!.duration, 6);
            } finally {
                input.dispose();
            }
        } finally {
            original.dispose();
            if (output.state !== "finalized") await output.cancel();
        }
    });
});

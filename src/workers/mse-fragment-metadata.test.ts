import { readFile } from "node:fs/promises";
import {
    BufferSource,
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    MP4,
    Mp4OutputFormat,
    Output,
    type EncodedPacket,
    type InputTrack,
} from "../mediabunny.js";
import { describe, expect, it } from "vitest";
import { concat } from "../bytes.js";
import { VIDEO_INPUT_FORMATS } from "../video-formats.js";
import { readVideoFragmentMetadata, readVideoTrackMetadata } from "./mse-fragment-metadata.js";

const GOPRO = "../../tests/testdata/gopro-gpmf/hero5-trimmed.mp4";
const B_FRAMES = "../../tests/testdata/70mai-multichannel/Normal/Front/NO20260101-120000-000001F.MP4";
const HEVC = "../parsers/__fixtures__/novatek-ts/real-anonymized.TS";

interface MuxedFragment {
    moof: Uint8Array;
    mdat: Uint8Array;
}

async function packets(track: InputTrack): Promise<EncodedPacket[]> {
    const result: EncodedPacket[] = [];
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { verifyKeyPackets: true })) {
        result.push(packet);
    }
    return result;
}

async function muxFixture(path: string, options: { offset?: number; frameRate?: number; audio?: boolean } = {}) {
    const bytes = await readFile(new URL(path, import.meta.url));
    const input = new Input({ source: new BufferSource(bytes), formats: VIDEO_INPUT_FORMATS });
    let ftyp: Uint8Array | undefined;
    let moov: Uint8Array | undefined;
    let pendingMoof: Uint8Array | undefined;
    const fragments: MuxedFragment[] = [];
    const output = new Output({
        target: new BufferTarget(),
        format: new Mp4OutputFormat({
            fastStart: "fragmented",
            minimumFragmentDuration: 0,
            onFtyp: (bytes) => {
                ftyp = bytes;
            },
            onMoov: (bytes) => {
                moov = bytes;
            },
            onMoof: (bytes) => {
                pendingMoof = bytes;
            },
            onMdat: (bytes) => {
                if (!pendingMoof) throw new Error("missing fixture fragment header");
                fragments.push({ moof: pendingMoof, mdat: bytes });
                pendingMoof = undefined;
            },
        }),
    });
    try {
        const video = await input.getPrimaryVideoTrack();
        if (!video) throw new Error("missing fixture video track");
        const codec = await video.getCodec();
        const config = await video.getDecoderConfig();
        if (!codec || !config) throw new Error("missing fixture video config");
        const videoPackets = await packets(video);
        const videoSource = new EncodedVideoPacketSource(codec);
        const audio = options.audio ? await input.getPrimaryAudioTrack() : null;
        const audioCodec = await audio?.getCodec();
        const audioConfig = await audio?.getDecoderConfig();
        const audioSource = audioCodec && audioConfig ? new EncodedAudioPacketSource(audioCodec) : null;
        if (audioSource) output.addAudioTrack(audioSource);
        output.addVideoTrack(videoSource, options.frameRate ? { frameRate: options.frameRate } : undefined);
        await output.start();
        if (audio && audioSource && audioConfig) {
            const audioPackets = await packets(audio);
            const firstTimestamp = audioPackets[0]!.timestamp;
            for (const packet of audioPackets) {
                await audioSource.add(packet.clone({ timestamp: packet.timestamp - firstTimestamp }), {
                    decoderConfig: audioConfig,
                });
            }
            audioSource.close();
        }
        const origin = videoPackets[0]!.timestamp;
        for (const packet of videoPackets) {
            await videoSource.add(packet.clone({ timestamp: packet.timestamp - origin + (options.offset ?? 0) }), {
                decoderConfig: config,
            });
        }
        videoSource.close();
        await output.finalize();
        if (!ftyp || !moov || fragments.length === 0) throw new Error("missing fixture output");
        return { moov, init: concat([ftyp, moov]), fragments };
    } finally {
        if (output.state !== "finalized" && output.state !== "canceled") await output.cancel();
        input.dispose();
    }
}

async function compareFragments(fixture: Awaited<ReturnType<typeof muxFixture>>) {
    const track = readVideoTrackMetadata(fixture.moov);
    const metadata = [];
    for (const fragment of fixture.fragments) {
        const actual = readVideoFragmentMetadata(fragment.moof, track);
        metadata.push(actual);
        const input = new Input({
            source: new BufferSource(concat([fixture.init, fragment.moof, fragment.mdat])),
            formats: [MP4],
        });
        try {
            const video = await input.getPrimaryVideoTrack();
            if (!video) throw new Error("missing muxed video track");
            const videoPackets = await packets(video);
            const keys = videoPackets.filter((packet) => packet.type === "key").map((packet) => packet.timestamp);
            expect(actual.keyframeTimestamps).toHaveLength(keys.length);
            for (let i = 0; i < keys.length; i++) expect(actual.keyframeTimestamps[i]).toBeCloseTo(keys[i]!, 9);
            if (videoPackets.length === 0) expect(actual.endSec).toBeNull();
            else {
                const expectedEnd = Math.max(...videoPackets.map((packet) => packet.timestamp + packet.duration));
                expect(actual.endSec).toBeCloseTo(expectedEnd, 9);
            }
        } finally {
            input.dispose();
        }
    }
    return { track, metadata };
}

describe("fragmented MP4 video metadata", () => {
    it("matches demuxed B-frame timestamps and presentation ends", async () => {
        const fixture = await muxFixture(B_FRAMES);
        const { metadata } = await compareFragments(fixture);
        expect(metadata.flatMap((fragment) => fragment.keyframeTimestamps)).toEqual([0]);
        expect(Math.max(...metadata.map((fragment) => fragment.endSec ?? 0))).toBeCloseTo(2);
    });

    it("handles signed composition offsets when HEVC has leading B-frames", async () => {
        const fixture = await muxFixture(HEVC);
        const { metadata } = await compareFragments(fixture);
        const keys = metadata.flatMap((fragment) => fragment.keyframeTimestamps);
        expect(keys).toHaveLength(2);
        expect(keys[1]).toBeCloseTo(8 + 1 / 3);
    });

    it("reads the actual track timescale and keeps a positive composition offset", async () => {
        const fixture = await muxFixture(GOPRO, { frameRate: 30, offset: 1.4 });
        const { track, metadata } = await compareFragments(fixture);
        expect(track.timescale).toBe(30);
        expect(metadata[0]!.keyframeTimestamps[0]).toBeCloseTo(1.4);
    });

    it("reports video keys in their own fragment despite leading audio", async () => {
        const fixture = await muxFixture(GOPRO, { audio: true, offset: 1024 / 48000 });
        const { track, metadata } = await compareFragments(fixture);
        expect(track.trackId).toBe(2);
        const firstVideoFragment = metadata.find((fragment) => fragment.endSec !== null)!;
        expect(firstVideoFragment.keyframeTimestamps[0]).toBeCloseTo(1024 / 48000, 4);
        expect(metadata.some((fragment) => fragment.endSec === null)).toBe(true);
    });

    it("retains decode timestamps beyond the 32-bit range", async () => {
        const fixture = await muxFixture(B_FRAMES, { offset: 100_000 });
        const { track, metadata } = await compareFragments(fixture);
        expect(100_000 * track.timescale).toBeGreaterThan(2 ** 32);
        expect(metadata[0]!.keyframeTimestamps[0]).toBeCloseTo(100_000);
        expect(metadata.at(-1)!.endSec).toBeCloseTo(100_002);
    });

    it("rejects truncated real initialization and fragment boxes", async () => {
        const fixture = await muxFixture(B_FRAMES);
        expect(() => readVideoTrackMetadata(fixture.moov.subarray(0, -1))).toThrow("invalid fragmented mp4");
        const track = readVideoTrackMetadata(fixture.moov);
        expect(() => readVideoFragmentMetadata(fixture.fragments[0]!.moof.subarray(0, -1), track)).toThrow(
            "invalid fragmented mp4",
        );
    });
});

import {
    BlobSource,
    BufferTarget,
    EncodedPacket,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    MkvOutputFormat,
    Mp4OutputFormat,
    Output,
    type PacketType,
    type Rotation,
    type VideoCodec,
    type VideoTrackMetadata,
    type TransformationMatrix,
} from "mediabunny";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VIDEO_INPUT_FORMATS } from "../video-formats.js";
import {
    DEGENERATE_VIDEO_PACKET_MAX_BYTES,
    createVideoSourceResolver,
    isDegenerateVideoPacket,
} from "./normalize-degenerate-video.js";

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../parsers/__fixtures__/generic");

interface PacketRecord {
    data: Uint8Array;
    type: PacketType;
    timestamp: number;
    duration: number;
}

interface VideoStream {
    codec: VideoCodec;
    // WebCodecs VideoDecoderConfig (mediabunny's getDecoderConfig returns the DOM
    // type); no need to import it, it is a global.
    decoderConfig: VideoDecoderConfig;
    rotation: Rotation;
    transformationMatrix: TransformationMatrix;
    packets: PacketRecord[];
}

// Reads a container's primary video track into plain packet records (copied out,
// so they survive the Input being disposed).
async function readVideoStream(file: File): Promise<VideoStream> {
    const input = new Input({ source: new BlobSource(file), formats: VIDEO_INPUT_FORMATS });
    try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error("fixture has no video track");
        const codec = await track.getCodec();
        const decoderConfig = await track.getDecoderConfig();
        if (!codec || !decoderConfig) throw new Error("fixture has no readable video codec config");
        const rotation = await track.getRotation();
        const sink = new EncodedPacketSink(track);
        const packets: PacketRecord[] = [];
        let packet = await sink.getFirstPacket();
        while (packet) {
            packets.push({
                data: packet.data.slice(),
                type: packet.type,
                timestamp: packet.timestamp,
                duration: packet.duration,
            });
            packet = await sink.getNextPacket(packet);
        }
        return { codec, decoderConfig, rotation, transformationMatrix: await track.getTransformationMatrix(), packets };
    } finally {
        input.dispose();
    }
}

async function buildVideo(
    stream: VideoStream,
    packets: PacketRecord[],
    name: string,
    metadata?: VideoTrackMetadata,
): Promise<File> {
    const target = new BufferTarget();
    const isMkv = name.endsWith(".mkv");
    const output = new Output({ format: isMkv ? new MkvOutputFormat() : new Mp4OutputFormat(), target });
    const source = new EncodedVideoPacketSource(stream.codec);
    output.addVideoTrack(source, { rotation: stream.rotation, ...metadata });
    await output.start();
    let first = true;
    for (const rec of packets) {
        const pkt = new EncodedPacket(rec.data, rec.type, rec.timestamp, rec.duration);
        await source.add(pkt, first ? { decoderConfig: stream.decoderConfig } : undefined);
        first = false;
    }
    await output.finalize();
    const buffer = target.buffer;
    if (!buffer) throw new Error("mux produced no buffer");
    return new File([buffer], name, { type: isMkv ? "video/x-matroska" : "video/mp4" });
}

describe("isDegenerateVideoPacket", () => {
    it("drops only empty H.264 and HEVC access units", () => {
        expect(isDegenerateVideoPacket("avc", DEGENERATE_VIDEO_PACKET_MAX_BYTES)).toBe(true);
        expect(isDegenerateVideoPacket("hevc", 4)).toBe(true);
        expect(isDegenerateVideoPacket("avc", 5)).toBe(false);
    });

    it("keeps a tiny VP9 or AV1 packet, which can show an earlier frame", () => {
        expect(isDegenerateVideoPacket("vp9", 1)).toBe(false);
        expect(isDegenerateVideoPacket("av1", 3)).toBe(false);
    });
});

describe("createVideoSourceResolver", () => {
    it("returns healthy MP4 and MOV files unchanged", async () => {
        const mkv = new File([readFileSync(resolve(FIXTURES_DIR, "clip-h264.mkv"))], "clip.mkv");
        const stream = await readVideoStream(mkv);
        const resolver = createVideoSourceResolver();
        for (const name of ["clip.mp4", "clip.mov"]) {
            const file = await buildVideo(stream, stream.packets, name);
            await expect(resolver.resolve(file)).resolves.toBe(file);
        }
    });

    it("leaves unsupported containers unchanged", async () => {
        const file = new File([readFileSync(resolve(FIXTURES_DIR, "../juscar/real-anonymized.TS"))], "clip.ts");
        await expect(createVideoSourceResolver().resolve(file)).resolves.toBe(file);
    });

    it("memoizes per file: two resolves of the same MKV yield the same result object", async () => {
        const buf = readFileSync(resolve(FIXTURES_DIR, "clip-h264.mkv"));
        const mkv = new File([buf], "clip-h264.mkv", { type: "video/x-matroska" });
        const resolver = createVideoSourceResolver();
        const [a, b] = await Promise.all([resolver.resolve(mkv), resolver.resolve(mkv)]);
        expect(a).toBe(b);
    });

    it("remuxes a clean MKV to a valid MP4, preserving every packet", async () => {
        const buf = readFileSync(resolve(FIXTURES_DIR, "clip-h264.mkv"));
        const mkv = new File([buf], "clip-h264.mkv", { type: "video/x-matroska" });
        const source = await readVideoStream(mkv);
        expect(source.packets.length).toBeGreaterThan(1);

        const resolver = createVideoSourceResolver();
        const clean = await resolver.resolve(mkv);
        // A real remux happened - a distinct File, not the original.
        expect(clean).not.toBe(mkv);
        expect(clean.name.endsWith(".mp4")).toBe(true);
        await expectValidMp4(clean);

        const out = await readVideoStream(clean);
        // No degenerate packets in the source -> count is preserved exactly.
        expect(out.packets.length).toBe(source.packets.length);
    });

    it.each([
        ["mkv", 4],
        ["mp4", 0],
        ["mp4", 4],
    ] as const)(
        "drops %s packets of %i bytes and preserves real frames and timestamps",
        async (extension, emptySize) => {
            const buf = readFileSync(resolve(FIXTURES_DIR, "clip-h264.mkv"));
            const mkv = new File([buf], "clip-h264.mkv", { type: "video/x-matroska" });
            const source = await readVideoStream(mkv);
            expect(source.packets.length).toBeGreaterThan(4);

            // Keep the empty packet between real frames, with its own presentation time.
            const insertAt = 3;
            const between = (source.packets[insertAt - 1]!.timestamp + source.packets[insertAt]!.timestamp) / 2;
            const degenerate: PacketRecord = {
                data: new Uint8Array(emptySize),
                type: "delta",
                timestamp: between,
                duration: 0,
            };
            const withDegenerate = [
                ...source.packets.slice(0, insertAt),
                degenerate,
                ...source.packets.slice(insertAt),
            ];
            const dirtyFile = await buildVideo(source, withDegenerate, `dirty.${extension}`, {
                rotation: 90,
                flip: true,
            });

            const dirty = await readVideoStream(dirtyFile);
            expect(dirty.packets.some((p) => p.data.byteLength <= DEGENERATE_VIDEO_PACKET_MAX_BYTES)).toBe(true);
            expect(dirty.packets.length).toBe(source.packets.length + 1);

            const resolver = createVideoSourceResolver();
            const clean = await resolver.resolve(dirtyFile);
            expect(clean).not.toBe(dirtyFile);
            await expectValidMp4(clean);

            const out = await readVideoStream(clean);
            expect(out.transformationMatrix).toEqual(dirty.transformationMatrix);
            // The degenerate packet is gone; every real frame survives.
            expect(out.packets.length).toBe(source.packets.length);
            expect(out.packets.every((p) => p.data.byteLength > DEGENERATE_VIDEO_PACKET_MAX_BYTES)).toBe(true);
            // Timestamps of the surviving frames are preserved (remux carries pts
            // verbatim; allow a sub-millisecond tolerance for MP4 timescale rounding).
            for (let i = 0; i < source.packets.length; i++) {
                expect(out.packets[i]!.data).toEqual(source.packets[i]!.data);
                expect(out.packets[i]!.timestamp).toBeCloseTo(source.packets[i]!.timestamp, 3);
            }
        },
    );
});

// Asserts the File is a structurally valid MP4: an `ftyp` box at the head plus
// `moov` and `mdat` boxes somewhere in the bytes.
async function expectValidMp4(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ascii = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    // First box type sits at bytes 4..8 (after the 32-bit box size).
    expect(ascii(4)).toBe("ftyp");
    const haystack = new TextDecoder("latin1").decode(bytes);
    expect(haystack.includes("moov")).toBe(true);
    expect(haystack.includes("mdat")).toBe(true);
}

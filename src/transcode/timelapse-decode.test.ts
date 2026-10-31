import {
    BlobSource,
    BufferTarget,
    CustomVideoDecoder,
    EncodedPacket,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    type InputVideoTrack,
    MkvOutputFormat,
    Mp4OutputFormat,
    Output,
    type PacketType,
    registerDecoder,
    VideoSample,
    VideoSampleSink,
} from "mediabunny";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VIDEO_INPUT_FORMATS } from "../video-formats.js";
import {
    decodeSelectedFrames,
    type DenseFrame,
    type DensePacketScan,
    denseRangeFrames,
    planSparseSplitSlot,
    planSparseTimelapseSegment,
    scanDensePackets,
    selectedFrameSpacingSec,
    selectSplitSlotFrames,
    selectTimelapseFrames,
    shouldDecodeSparsely,
    SPLIT_FRAME_LOOKAHEAD_SEC,
} from "./timelapse-decode.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../parsers/__fixtures__/generic/clip-h264.mkv");

/** Frame i of a constant-rate stream, as denseRangeFrames reports it. */
function frameAt(index: number, fps = 30): DenseFrame {
    return { packetTimestamp: index / fps, sampleTimestamp: index / fps };
}

function framesFrom(first: number, count: number, fps = 30): DenseFrame[] {
    return Array.from({ length: count }, (_, i) => frameAt(first + i, fps));
}

function scanOf(fields: Partial<DensePacketScan> = {}): DensePacketScan {
    return { packetTimestamps: [], maxKeyIntervalSec: 1, hasLeadingPictures: false, ...fields };
}

describe("denseRangeFrames", () => {
    const timestamps = (count: number) => Array.from({ length: count }, (_, i) => i / 30);

    it("yields the frame on screen at the start and every frame before the exclusive end", () => {
        const frames = denseRangeFrames(timestamps(60), 10.5 / 30, 20 / 30, 30);
        expect(frames.map((frame) => Math.round(frame.sampleTimestamp * 30))).toEqual([
            10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
        ]);
    });

    it("starts exactly at a frame that begins on the start timestamp", () => {
        const frames = denseRangeFrames(timestamps(60), 10 / 30, 12 / 30, 30);
        expect(frames.map((frame) => Math.round(frame.sampleTimestamp * 30))).toEqual([10, 11]);
    });

    it("presents B-frame decode order sorted by presentation time", () => {
        const decodeOrder = [0, 3, 1, 2, 6, 4, 5, 9, 7, 8].map((i) => i / 30);
        const frames = denseRangeFrames(decodeOrder, 0, 1, 30);
        expect(frames.map((frame) => Math.round(frame.sampleTimestamp * 30))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it("yields the last earlier frame when the range holds none", () => {
        const frames = denseRangeFrames([0, 1, 2], 1.2, 1.5, 1000);
        expect(frames).toEqual([{ packetTimestamp: 1, sampleTimestamp: 1 }]);
    });

    it("rounds decoded timestamps to the time resolution but keeps the exact query", () => {
        const [frame] = denseRangeFrames([1.00004], 1, 2, 1000);
        expect(frame?.packetTimestamp).toBe(1.00004);
        expect(frame?.sampleTimestamp).toBe(1);
    });
});

describe("selectTimelapseFrames", () => {
    const context = { segBaseOutSec: 0, timeOrigin: 0, startInFile: 0, previousFrameIndex: -1, speedFactor: 4 };

    it("keeps every speedFactor-th in-range frame starting with the first", () => {
        const selection = selectTimelapseFrames(framesFrom(0, 10), context);
        expect(selection.frames).toEqual([frameAt(0), frameAt(4), frameAt(8)]);
        expect(selection.frameIndices).toEqual([0, 4, 8]);
        expect(selection.lastFrameIndex).toBe(9);
    });

    it("continues the global numbering across segments", () => {
        // Segment one ended on index 9: the next kept index is 12, the third frame here.
        const selection = selectTimelapseFrames(framesFrom(0, 6), {
            ...context,
            segBaseOutSec: 10 / 30,
            previousFrameIndex: 9,
        });
        expect(selection.frameIndices).toEqual([12]);
        expect(selection.frames).toEqual([frameAt(2)]);
        expect(selection.lastFrameIndex).toBe(15);
    });

    it("does not count a pre-start frame of the first segment", () => {
        // The dense range starts with the frame on screen at 0.31 s (frame 9 at 0.3 s).
        const selection = selectTimelapseFrames(framesFrom(9, 5), { ...context, startInFile: 0.31 });
        expect(selection.frameIndices).toEqual([0]);
        expect(selection.frames).toEqual([frameAt(10)]);
        expect(selection.lastFrameIndex).toBe(3);
    });

    it("counts a pre-start frame within the drift tolerance or behind accumulated output", () => {
        const withinTolerance = selectTimelapseFrames(framesFrom(9, 5), { ...context, startInFile: 9 / 30 + 5e-4 });
        expect(withinTolerance.frames[0], "drift-sized pre-roll counts as in range").toEqual(frameAt(9));
        const laterSegment = selectTimelapseFrames(framesFrom(9, 5), {
            ...context,
            startInFile: 0.31,
            segBaseOutSec: 5,
            previousFrameIndex: 3,
        });
        expect(laterSegment.frames[0], "a later segment counts its pre-roll frame").toEqual(frameAt(9));
    });

    it("applies the time origin like the pipeline", () => {
        const frames = framesFrom(0, 8).map((frame) => ({
            packetTimestamp: frame.packetTimestamp + 100,
            sampleTimestamp: frame.sampleTimestamp + 100,
        }));
        const selection = selectTimelapseFrames(frames, { ...context, timeOrigin: 100 });
        expect(selection.frameIndices).toEqual([0, 4]);
    });
});

describe("selectSplitSlotFrames", () => {
    it("requests the frame on screen at each tick once", () => {
        const frames = framesFrom(0, 30);
        // Ticks 8 frames apart, the second one between frames.
        const shown = selectSplitSlotFrames(frames, [0, 8.5 / 30, 16 / 30, 16.2 / 30], false);
        expect(shown).toEqual([frameAt(0), frameAt(8), frameAt(16)]);
    });

    it("treats a frame starting within the lookahead tolerance as already shown", () => {
        const frames = framesFrom(0, 30);
        const shown = selectSplitSlotFrames(frames, [8 / 30 - 5e-7], false);
        expect(shown).toEqual([frameAt(8)]);
    });

    it("skips ticks before the first frame", () => {
        const frames = framesFrom(5, 10);
        expect(selectSplitSlotFrames(frames, [0, 6 / 30], false)).toEqual([frameAt(6)]);
    });

    it("adds the segment's final frame when the slot holds through a gap", () => {
        const frames = framesFrom(0, 30);
        expect(selectSplitSlotFrames(frames, [0, 16 / 30], true)).toEqual([frameAt(0), frameAt(16), frameAt(29)]);
        expect(selectSplitSlotFrames(frames, [29.5 / 30], true), "already the final frame").toEqual([frameAt(29)]);
    });
});

describe("shouldDecodeSparsely", () => {
    it("decodes sparsely only when the selected frames are at least a GOP apart", () => {
        const oneSecondApart = [frameAt(0), frameAt(30), frameAt(60)];
        expect(shouldDecodeSparsely(oneSecondApart, scanOf({ maxKeyIntervalSec: 1 }))).toBe(true);
        expect(shouldDecodeSparsely(oneSecondApart, scanOf({ maxKeyIntervalSec: 1.5 }))).toBe(false);
        const halfSecondApart = [frameAt(0), frameAt(16), frameAt(32)];
        expect(selectedFrameSpacingSec(halfSecondApart)).toBeCloseTo(16 / 30);
        expect(shouldDecodeSparsely(halfSecondApart, scanOf({ maxKeyIntervalSec: 0.5 }))).toBe(true);
        expect(shouldDecodeSparsely(halfSecondApart, scanOf({ maxKeyIntervalSec: 1 }))).toBe(false);
    });

    it.each([
        ["fewer than two frames", [frameAt(0)], scanOf()],
        ["no measurable GOP", [frameAt(0), frameAt(60)], scanOf({ maxKeyIntervalSec: null })],
        ["open-GOP leading pictures", [frameAt(0), frameAt(60)], scanOf({ hasLeadingPictures: true })],
        ["duplicate timestamps", [frameAt(0), frameAt(60), frameAt(60)], scanOf({ maxKeyIntervalSec: 0.1 })],
    ])("stays dense with %s", (_label, frames, scan) => {
        expect(shouldDecodeSparsely(frames, scan)).toBe(false);
    });
});

interface PacketPlan {
    frame: number;
    type: PacketType;
}

/** Muxes a real H.264 key-frame payload under a chosen decode order and key
 *  layout at 30 fps. Only the container metadata matters here. */
async function buildClip(plan: PacketPlan[], name: string): Promise<File> {
    const fixture = new Input({
        source: new BlobSource(new File([readFileSync(FIXTURE)], "clip.mkv")),
        formats: VIDEO_INPUT_FORMATS,
    });
    try {
        const track = await fixture.getPrimaryVideoTrack();
        if (!track) throw new Error("fixture has no video track");
        const codec = await track.getCodec();
        const decoderConfig = await track.getDecoderConfig();
        if (!codec || !decoderConfig) throw new Error("fixture has no readable video codec config");
        const payload = (await new EncodedPacketSink(track).getFirstPacket())?.data.slice();
        if (!payload) throw new Error("fixture has no packets");
        const target = new BufferTarget();
        const isMkv = name.endsWith(".mkv");
        const output = new Output({ format: isMkv ? new MkvOutputFormat() : new Mp4OutputFormat(), target });
        const source = new EncodedVideoPacketSource(codec);
        output.addVideoTrack(source, { frameRate: 30 });
        await output.start();
        for (const [i, step] of plan.entries()) {
            const packet = new EncodedPacket(payload, step.type, step.frame / 30, 1 / 30);
            await source.add(packet, i === 0 ? { decoderConfig } : undefined);
        }
        await output.finalize();
        if (!target.buffer) throw new Error("mux produced no buffer");
        return new File([target.buffer], name);
    } finally {
        fixture.dispose();
    }
}

/** `seconds` of 30 fps footage with a key frame every `gopFrames`. */
function closedGops(seconds: number, gopFrames: number): PacketPlan[] {
    return Array.from({ length: seconds * 30 }, (_, frame) => ({
        frame,
        type: frame % gopFrames === 0 ? "key" : "delta",
    }));
}

describe("scanDensePackets", () => {
    async function scan(file: File, startTimestamp: number, endTimestamp: number) {
        const input = new Input({ source: new BlobSource(file), formats: VIDEO_INPUT_FORMATS });
        try {
            const track = await input.getPrimaryVideoTrack();
            if (!track) throw new Error("clip has no video track");
            return await scanDensePackets(input, track, startTimestamp, endTimestamp, new AbortController().signal);
        } finally {
            input.dispose();
        }
    }

    it("starts at the key frame before the range and stops at the second key frame after it", async () => {
        const result = await scan(await buildClip(closedGops(6, 30), "clip.mp4"), 2.5, 2.9);
        expect(result).not.toBeNull();
        const frames = result!.packetTimestamps.map((timestamp) => Math.round(timestamp * 30));
        // Key 2 s precedes the range; key 3 s is the first after it, key 4 s ends the scan.
        expect(frames[0]).toBe(60);
        expect(frames.at(-1)).toBe(119);
        expect(frames).toHaveLength(60);
        expect(result!.maxKeyIntervalSec).toBeCloseTo(1, 6);
        expect(result!.hasLeadingPictures).toBe(false);
    });

    it("reports the longest key interval in the scanned window", async () => {
        const plan = closedGops(6, 30).map((step) => ({
            ...step,
            // Drop the 2 s key frame: the 1 s GOP runs for two seconds.
            type: (step.frame === 60 ? "delta" : step.type) as PacketType,
        }));
        const result = await scan(await buildClip(plan, "clip.mp4"), 0, 3.5);
        expect(result!.maxKeyIntervalSec).toBeCloseTo(2, 6);
    });

    it("detects open-GOP leading pictures", async () => {
        // Frame 29 is decoded after the 1 s key frame but presented before it.
        const plan: PacketPlan[] = [
            ...closedGops(3, 30).filter((step) => step.frame < 29),
            { frame: 30, type: "key" },
            { frame: 29, type: "delta" },
            ...closedGops(3, 30).filter((step) => step.frame > 30),
        ];
        const result = await scan(await buildClip(plan, "clip.mp4"), 0, 2);
        expect(result!.hasLeadingPictures).toBe(true);
    });

    it("gives no GOP for a track whose every packet is a key frame", async () => {
        const plan = closedGops(3, 30).map((step) => ({ ...step, type: "key" as PacketType }));
        const result = await scan(await buildClip(plan, "clip.mp4"), 0, 2);
        expect(result!.maxKeyIntervalSec).toBeNull();
    });

    it("declines containers whose metadata walk reads payloads", async () => {
        await expect(scan(await buildClip(closedGops(3, 30), "clip.mkv"), 0, 2)).resolves.toBeNull();
    });
});

// Node has no WebCodecs, so these cases decode through a stand-in registered
// with mediabunny (only inside this test file's worker). It emits one 1x1
// sample per packet in presentation order, holding two frames back like a
// B-frame reorder buffer, and counts the packets it is fed. The real range and
// timestamp walks of the pinned mediabunny then run on top of it, which is
// what the sparse plan has to reproduce.
class ReorderingStubDecoder extends CustomVideoDecoder {
    static decodedPackets = 0;
    private held: { timestamp: number; duration: number }[] = [];

    static override supports(): boolean {
        return true;
    }

    init(): void {}

    decode(packet: EncodedPacket): void {
        ReorderingStubDecoder.decodedPackets++;
        this.held.push({ timestamp: packet.timestamp, duration: packet.duration });
        this.held.sort((a, b) => a.timestamp - b.timestamp);
        while (this.held.length > 2) this.emit(this.held.shift()!);
    }

    flush(): void {
        for (const frame of this.held.splice(0)) this.emit(frame);
    }

    close(): void {
        this.held = [];
    }

    private emit(frame: { timestamp: number; duration: number }): void {
        this.onSample(
            new VideoSample(new Uint8Array(4), {
                format: "RGBA",
                codedWidth: 1,
                codedHeight: 1,
                timestamp: frame.timestamp,
                duration: frame.duration,
            }),
        );
    }
}
registerDecoder(ReorderingStubDecoder);

describe("sparse timelapse decode", () => {
    interface OpenClip {
        input: Input;
        track: InputVideoTrack;
        sink: VideoSampleSink;
    }

    async function open(file: File): Promise<OpenClip> {
        const input = new Input({ source: new BlobSource(file), formats: VIDEO_INPUT_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error("clip has no video track");
        return { input, track, sink: new VideoSampleSink(track) };
    }

    async function drain(source: AsyncIterable<VideoSample>): Promise<number[]> {
        const timestamps: number[] = [];
        for await (const sample of source) {
            timestamps.push(sample.timestamp);
            sample.close();
        }
        return timestamps;
    }

    interface SegmentRange {
        startInFile: number;
        endInFile: number;
    }

    /** The single-channel loop's keep/skip over a dense decode (pipeline.ts). */
    async function denseKeptTimestamps(clip: OpenClip, segments: SegmentRange[], speedFactor: number) {
        let frameIndex = -1;
        let segBaseOutSec = 0;
        const kept: number[] = [];
        for (const segment of segments) {
            for await (const sample of clip.sink.samples(segment.startInFile, segment.endInFile)) {
                const srcRelTs = segBaseOutSec + (sample.timestamp - segment.startInFile);
                const timestamp = sample.timestamp;
                sample.close();
                if (srcRelTs < -1e-3) continue;
                frameIndex++;
                if (frameIndex % speedFactor === 0) kept.push(timestamp);
            }
            segBaseOutSec += segment.endInFile - segment.startInFile;
        }
        return { kept, frameIndex };
    }

    it.each([
        ["closed GOPs", closedGops(8, 15)],
        [
            "B-frames",
            // I P B B ordering inside 15-frame closed GOPs.
            closedGops(8, 15).map((step, i, all) => {
                const position = step.frame % 15;
                if (position === 0 || position > 12) return step;
                const group = Math.floor((position - 1) / 3) * 3 + 1;
                const order = [group + 2, group, group + 1][(position - 1) % 3]!;
                return { frame: step.frame - position + order, type: all[i]!.type };
            }),
        ],
    ])("picks and decodes the dense loop's frames across segments with %s", async (label, plan) => {
        const clip = await open(await buildClip(plan, "clip.mp4"));
        try {
            const decodeOrder: number[] = [];
            for await (const packet of new EncodedPacketSink(clip.track).packets(undefined, undefined, {
                metadataOnly: true,
            })) {
                decodeOrder.push(packet.timestamp);
            }
            expect(
                decodeOrder.every((timestamp, i) => i === 0 || timestamp > decodeOrder[i - 1]!),
                "decode order matches presentation only without B-frames",
            ).toBe(label === "closed GOPs");
            const speedFactor = 16;
            const segments = [
                { startInFile: 0.31, endInFile: 3.2 },
                { startInFile: 3.2, endInFile: 7.9 },
            ];
            const dense = await denseKeptTimestamps(clip, segments, speedFactor);
            expect(dense.kept.length, "the dense loop keeps frames in both segments").toBeGreaterThan(10);
            ReorderingStubDecoder.decodedPackets = 0;
            await denseKeptTimestamps(clip, segments, speedFactor);
            const densePackets = ReorderingStubDecoder.decodedPackets;

            let previousFrameIndex = -1;
            let segBaseOutSec = 0;
            const decoded: number[] = [];
            ReorderingStubDecoder.decodedPackets = 0;
            for (const segment of segments) {
                const sparse = await planSparseTimelapseSegment(
                    clip.input,
                    clip.track,
                    segment.startInFile,
                    segment.endInFile,
                    {
                        segBaseOutSec,
                        timeOrigin: 0,
                        startInFile: segment.startInFile,
                        previousFrameIndex,
                        speedFactor,
                    },
                    new AbortController().signal,
                );
                expect(sparse, "16 frames apart beats a 15-frame GOP").not.toBeNull();
                decoded.push(...(await drain(decodeSelectedFrames(clip.sink, sparse!.frames))));
                previousFrameIndex = sparse!.selection.lastFrameIndex;
                segBaseOutSec += segment.endInFile - segment.startInFile;
            }
            expect(decoded).toEqual(dense.kept);
            expect(previousFrameIndex, "the global counter ends where the dense loop's does").toBe(dense.frameIndex);
            expect(ReorderingStubDecoder.decodedPackets).toBeLessThan(densePackets);
        } finally {
            clip.input.dispose();
        }
    });

    it("keeps the dense walk when the kept frames are closer than a GOP", async () => {
        const clip = await open(await buildClip(closedGops(4, 30), "clip.mp4"));
        try {
            const sparse = await planSparseTimelapseSegment(
                clip.input,
                clip.track,
                0,
                3.5,
                { segBaseOutSec: 0, timeOrigin: 0, startInFile: 0, previousFrameIndex: -1, speedFactor: 16 },
                new AbortController().signal,
            );
            expect(sparse).toBeNull();
        } finally {
            clip.input.dispose();
        }
    });

    /** The split slot walk (getSlotSampleForFrame) over any sample iterator. */
    async function shownPerTick(source: AsyncIterable<VideoSample>, tickLocalTimes: readonly number[]) {
        const iterator = source[Symbol.asyncIterator]();
        let current: VideoSample | null = null;
        let next = (await iterator.next()).value ?? null;
        const shown: (number | null)[] = [];
        for (const localTime of tickLocalTimes) {
            while (next && next.timestamp <= localTime + SPLIT_FRAME_LOOKAHEAD_SEC) {
                current?.close();
                current = next;
                next = (await iterator.next()).value ?? null;
            }
            shown.push(current?.timestamp ?? null);
        }
        current?.close();
        next?.close();
        await iterator.return?.();
        return shown;
    }

    it("shows the dense split walk's picture on every tick, through a trailing gap", async () => {
        const clip = await open(await buildClip(closedGops(6, 15), "clip.mp4"));
        try {
            const [start, end] = [0.2, 4.5];
            // Ticks 0.55 s apart from before the first frame; the last two lie in a
            // gap after the segment, where the slot holds its final frame.
            const ticks = Array.from({ length: 10 }, (_, i) => 0.15 + i * 0.55);
            const onSegment = ticks.filter((tick) => tick < end);
            const sparse = await planSparseSplitSlot(
                clip.input,
                clip.track,
                start,
                end,
                onSegment,
                true,
                new AbortController().signal,
            );
            expect(sparse).not.toBeNull();
            const dense = await shownPerTick(clip.sink.samples(start, end), ticks);
            const decoded = await shownPerTick(decodeSelectedFrames(clip.sink, sparse!.frames), ticks);
            expect(decoded).toEqual(dense);
            expect(dense.at(-1), "the gap holds the segment's final frame").toBeCloseTo(4.5 - 1 / 30, 6);
        } finally {
            clip.input.dispose();
        }
    });
});

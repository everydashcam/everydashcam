import { readFileSync } from "node:fs";
import {
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacket,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    Mp4OutputFormat,
    MovOutputFormat,
    Output,
    type InputTrack,
    type VideoTrackMetadata,
} from "mediabunny";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportClip, probeAudioUniformity } from "./export.js";
import { _resetForTests as resetLog, getLogBuffer } from "./log.js";
import { getInputTimeOrigin } from "./media-time.js";
import { createRetryingBlobSource } from "./retrying-blob-source.js";
import { groupTrips, type VideoCandidate } from "./trips.js";
import { createInMemoryFileHandle } from "./ui/in-memory-file.js";
import { VIDEO_INPUT_FORMATS } from "./video-formats.js";
import { buildMp4Index } from "./parsers/internal/mp4-index.js";
import { findGpmdTrack } from "./parsers/internal/gpmf-extract.js";
import { findBox, readMediaTimescale, readSampleDurationsInTicks } from "./parsers/internal/mp4-walker.js";

const H264_FIXTURE = "../tests/testdata/70mai-multichannel/Normal/Front/NO20260101-120000-000001F.MP4";

function fixture(path: string): File {
    return new File([readFileSync(new URL(path, import.meta.url))], path.split("/").at(-1)!);
}

function open(file: File): Input {
    return new Input({ source: createRetryingBlobSource(file), formats: VIDEO_INPUT_FORMATS });
}

async function packets(track: InputTrack): Promise<EncodedPacket[]> {
    const sink = new EncodedPacketSink(track);
    const result: EncodedPacket[] = [];
    for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
        result.push(packet);
    }
    return result;
}

async function tripOf(files: File[]) {
    let startUtc = 1_700_000_000;
    const candidates: VideoCandidate[] = [];
    for (const file of files) {
        const input = open(file);
        try {
            const durationSec = (await input.computeDuration()) - (await getInputTimeOrigin(input));
            candidates.push({
                file,
                relativePath: file.name,
                fingerprint: "export-test-camera",
                appliedExtractors: [],
                classifierMatches: { time: null, channel: null, mode: null, sequence: null },
                channel: "front",
                channelConfident: true,
                sequence: candidates.length,
                recordingMode: "normal",
                isTimelapse: false,
                startUtc,
                durationSec,
                wallDurationSec: null,
                driftLeadSec: null,
                startSource: "mp4",
                cameraTzSec: 0,
                localClockOffsetHintSec: null,
                createdUtc: null,
                records: [],
                codec: null,
                codecParam: null,
                videoCodecString: null,
                rotation: 0,
                width: null,
                height: null,
                fps: 30,
                audio: null,
                canPlay: true,
                needsHevcRemux: false,
                isTransportStream: false,
                isMatroska: false,
                audioNeedsTranscode: false,
                embeddedStartUtcHint: null,
            });
            startUtc += durationSec;
        } finally {
            input.dispose();
        }
    }
    const trips = groupTrips(candidates);
    expect(trips).toHaveLength(1);
    return trips[0]!;
}

async function save(files: File[], options: { start?: number; end?: number; withGpmf?: boolean } = {}) {
    const trip = await tripOf(files);
    const handle = createInMemoryFileHandle(
        "export.mp4",
        files.reduce((sum, file) => sum + file.size, 0),
    );
    const result = await exportClip({
        trip,
        channel: "front",
        startTripSec: options.start ?? 0,
        endTripSec: options.end ?? trip.timeline.contentDurationSec,
        withAudio: true,
        withGpmf: options.withGpmf ?? false,
        mp4Writable: await handle.createWritable(),
        mp4Handle: handle,
        onProgress() {},
        signal: new AbortController().signal,
    });
    return { result, file: await handle.getFile() };
}

async function remuxFixture(file: File, withPcm8Audio = false, metadata?: VideoTrackMetadata): Promise<File> {
    const input = open(file);
    const target = new BufferTarget();
    const output = new Output({ target, format: withPcm8Audio ? new MovOutputFormat() : new Mp4OutputFormat() });
    try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error("fixture has no video track");
        const codec = await track.getCodec();
        const config = await track.getDecoderConfig();
        if (!codec || !config) throw new Error("fixture has no video config");
        const source = new EncodedVideoPacketSource(codec);
        output.addVideoTrack(source, metadata);
        const audioSource = withPcm8Audio ? new EncodedAudioPacketSource("pcm-u8") : null;
        if (audioSource) output.addAudioTrack(audioSource);
        await output.start();
        let first = true;
        for (const packet of await packets(track)) {
            await source.add(packet, first ? { decoderConfig: config } : undefined);
            first = false;
        }
        if (audioSource) {
            await audioSource.add(new EncodedPacket(new Uint8Array(8000).fill(128), "key", 0, 1), {
                decoderConfig: { codec: "pcm-u8", sampleRate: 8000, numberOfChannels: 1 },
            });
        }
        await output.finalize();
        return new File([target.buffer!], withPcm8Audio ? "pcm8.mov" : "silent.mp4");
    } finally {
        input.dispose();
    }
}

describe("stream-copy export", () => {
    beforeEach(resetLog);

    it("preserves rotation and reflection when copying a video track", async () => {
        const file = await remuxFixture(fixture(H264_FIXTURE), false, { rotation: 90, flip: true });
        const input = open(file);
        const output = open((await save([file, file])).file);
        try {
            const source = (await input.getPrimaryVideoTrack())!;
            const video = (await output.getPrimaryVideoTrack())!;
            expect(await source.getFlip()).toBe(true);
            expect(await video.getTransformationMatrix()).toEqual(await source.getTransformationMatrix());
            expect((await packets(video)).length).toBe((await packets(source)).length * 2);
        } finally {
            input.dispose();
            output.dispose();
        }
    });

    it("rejects joining files with different reflection metadata", async () => {
        const source = fixture(H264_FIXTURE);
        const flipped = await remuxFixture(source, false, { flip: true });
        await expect(save([source, flipped])).rejects.toMatchObject({ name: "IncompatibleVideoConfigError" });
    });

    it.each([
        "./parsers/__fixtures__/juscar/real-anonymized.TS",
        "./parsers/__fixtures__/novatek-ts/real-anonymized.TS",
        "./parsers/__fixtures__/ligogps-trailer-ts/real-anonymized-count.TS",
        "./parsers/__fixtures__/ligogps-trailer-ts/real-anonymized-empty.TS",
        "./parsers/__fixtures__/ligogps-ts-pes/real-anonymized.TS",
    ])("copies video and audio from a transport clock in %s", async (path) => {
        const file = fixture(path);
        const source = open(file);
        const output = open((await save([file, file])).file);
        try {
            const sourceVideo = (await source.getPrimaryVideoTrack())!;
            const outputVideo = await output.getPrimaryVideoTrack();
            const outputAudio = await output.getPrimaryAudioTrack();
            expect(outputVideo).not.toBeNull();
            expect(outputAudio).not.toBeNull();
            const sourcePackets = await packets(sourceVideo);
            const outputPackets = await packets(outputVideo!);
            const origin = await getInputTimeOrigin(source);
            const firstVideoOffset = sourcePackets[0]!.timestamp - origin;
            const sourceDuration = (await source.computeDuration()) - origin;
            expect(outputPackets).toHaveLength(sourcePackets.length * 2);
            expect(firstVideoOffset).toBeGreaterThan(0);
            expect(outputPackets[0]!.timestamp).toBeCloseTo(firstVideoOffset);
            expect(outputPackets[sourcePackets.length]!.timestamp).toBeCloseTo(sourceDuration + firstVideoOffset);
            expect(outputPackets[sourcePackets.length]!.data).toEqual(outputPackets[0]!.data);
            expect((await packets(outputAudio!)).length).toBeGreaterThan(1);
        } finally {
            source.dispose();
            output.dispose();
        }
    });

    it("hides decoder preroll and preserves the selected start after GPS injection", async () => {
        const file = fixture(H264_FIXTURE);
        const source = open(file);
        const start = 0.35;
        const saved = await save([file], { start, withGpmf: true });
        const output = open(saved.file);
        try {
            const sourceVideo = (await source.getPrimaryVideoTrack())!;
            const video = (await output.getPrimaryVideoTrack())!;
            const sourcePackets = await packets(sourceVideo);
            const outputPackets = await packets(video);
            expect(outputPackets.map((packet) => packet.data)).toEqual(sourcePackets.map((packet) => packet.data));
            for (let i = 0; i < outputPackets.length; i++) {
                expect(outputPackets[i]!.timestamp).toBeCloseTo(sourcePackets[i]!.timestamp - start, 6);
            }
            expect(outputPackets[0]!.timestamp).toBeCloseTo(-start);
            expect(await video.computeDuration()).toBeCloseTo(2 - start);

            const sourceAudio = (await source.getPrimaryAudioTrack())!;
            const sourceBoundary = (await new EncodedPacketSink(sourceAudio).getPacket(start))!;
            const audio = (await output.getPrimaryAudioTrack())!;
            const outputBoundary = (await new EncodedPacketSink(audio).getFirstPacket())!;
            expect(outputBoundary.data).toEqual(sourceBoundary.data);
            expect(outputBoundary.timestamp).toBeCloseTo(sourceBoundary.timestamp - start, 6);
            expect(outputBoundary.timestamp).toBeLessThan(0);
            expect(outputBoundary.timestamp + outputBoundary.duration).toBeGreaterThan(0);
            expect(await audio.computeDuration()).toBeCloseTo(2 - start);

            expect(saved.result.gpmfInjected).toBe(true);
            const index = await buildMp4Index(saved.file);
            const gpmd = findGpmdTrack(index)!;
            expect(gpmd).not.toBeNull();
            const timescale = readMediaTimescale(index.moovView!, gpmd.trakBox)!;
            const durations = readSampleDurationsInTicks(index.moovView!, gpmd.trakBox)!;
            expect(durations.reduce((sum, duration) => sum + duration, 0) / timescale).toBeCloseTo(2 - start);
            const videoBox = index.tracks.find((track) => track.handlerType === "vide")!.trakBox;
            expect(findBox(index.moovView!, videoBox.payloadStart, videoBox.end, "edts")).not.toBeNull();
        } finally {
            source.dispose();
            output.dispose();
        }
    });

    it("keeps trimmed B-frame joins aligned across a long export", async () => {
        const file = fixture(H264_FIXTURE);
        const start = 0.35;
        const output = open((await save(Array<File>(30).fill(file), { start })).file);
        try {
            const video = (await output.getPrimaryVideoTrack())!;
            const audio = (await output.getPrimaryAudioTrack())!;
            const outputPackets = await packets(video);
            expect(outputPackets).toHaveLength(1800);
            expect(outputPackets[0]!.timestamp).toBeCloseTo(-start);
            expect(await video.computeDuration()).toBeCloseTo(60 - start);
            expect(await audio.computeDuration()).toBeCloseTo(60 - start);
            for (let i = 1; i < 30; i++) {
                expect(outputPackets[i * 60]!.timestamp).toBeCloseTo(i * 2 - start);
            }
            expect(new Set(outputPackets.map((packet) => packet.timestamp)).size).toBe(1800);
        } finally {
            output.dispose();
        }
    });

    it("retains complete GOPs when joining files that already contain decoder preroll", async () => {
        const file = (await save([fixture(H264_FIXTURE)], { start: 0.35 })).file;
        const output = open((await save([file, file])).file);
        try {
            const video = (await output.getPrimaryVideoTrack())!;
            const outputPackets = await packets(video);
            expect(outputPackets).toHaveLength(120);
            expect(outputPackets[0]!.timestamp).toBeCloseTo(-0.35);
            expect(outputPackets[60]!.timestamp).toBeCloseTo(1.65);
            expect(outputPackets[60]!.type).toBe("key");
            expect(await video.computeDuration()).toBeCloseTo(3.65);
            expect(new Set(outputPackets.map((packet) => packet.timestamp)).size).toBe(120);
        } finally {
            output.dispose();
        }
    });

    it("keeps B-frame segment joins on the complete presentation timeline", async () => {
        const file = fixture(H264_FIXTURE);
        const output = open((await save(Array<File>(30).fill(file))).file);
        try {
            const video = (await output.getPrimaryVideoTrack())!;
            const audio = (await output.getPrimaryAudioTrack())!;
            const outputPackets = await packets(video);
            expect(outputPackets).toHaveLength(1800);
            expect(await video.computeDuration()).toBeCloseTo(60);
            expect(await audio.computeDuration()).toBeCloseTo(60);
            expect(outputPackets[60]!.timestamp).toBeCloseTo(2);
            expect(new Set(outputPackets.map((packet) => packet.timestamp)).size).toBe(1800);
        } finally {
            output.dispose();
        }
    });

    it("retains in-range B-frames and the later-presented references they depend on", async () => {
        const file = fixture(H264_FIXTURE);
        const source = open(file);
        const output = open((await save([file], { end: 0.5 })).file);
        try {
            const sourcePackets = await packets((await source.getPrimaryVideoTrack())!);
            const outputPackets = await packets((await output.getPrimaryVideoTrack())!);
            for (const packet of sourcePackets.filter((packet) => packet.timestamp < 0.5)) {
                expect(outputPackets.find((candidate) => candidate.timestamp === packet.timestamp)?.data).toEqual(
                    packet.data,
                );
            }
            expect(outputPackets.some((packet) => packet.timestamp > 0.5)).toBe(true);
            expect(outputPackets.map((packet) => packet.data)).toEqual(
                sourcePackets.slice(0, outputPackets.length).map((packet) => packet.data),
            );
        } finally {
            source.dispose();
            output.dispose();
        }
    });

    it("starts the audio track when the first audio-bearing file starts", async () => {
        const file = fixture(H264_FIXTURE);
        const silent = await remuxFixture(file);
        const probe = await probeAudioUniformity([silent, file]);
        expect(probe.uniform).toBe(true);
        expect(probe.firstFile).toBe(file);
        const saved = await save([silent, file]);
        expect(saved.result.audioDroppedHeterogeneous).toBe(false);
        const output = open(saved.file);
        try {
            const audio = await output.getPrimaryAudioTrack();
            expect(audio).not.toBeNull();
            expect(await audio!.getFirstTimestamp()).toBeCloseTo(2);
            expect(await audio!.computeDuration()).toBeCloseTo(4);
        } finally {
            output.dispose();
        }
    });

    it("keeps video when MOV audio cannot be represented in an MP4 track", async () => {
        const file = await remuxFixture(fixture(H264_FIXTURE), true);
        const source = open(file);
        const output = open((await save([file])).file);
        try {
            expect(await (await source.getPrimaryAudioTrack())!.getCodec()).toBe("pcm-u8");
            expect(await output.getPrimaryAudioTrack()).toBeNull();
            const expected = await packets((await source.getPrimaryVideoTrack())!);
            const actual = await packets((await output.getPrimaryVideoTrack())!);
            expect(actual).toHaveLength(expected.length);
            expect(actual.map((packet) => packet.data)).toEqual(expected.map((packet) => packet.data));
        } finally {
            source.dispose();
            output.dispose();
        }
    });

    it("rejects incompatible video before committing any output", async () => {
        const files = [fixture(H264_FIXTURE), fixture("../tests/testdata/no-gps-h264/clip-no-gps.mp4")];
        const trip = await tripOf(files);
        const handle = createInMemoryFileHandle("export.mp4");
        await expect(
            exportClip({
                trip,
                channel: "front",
                startTripSec: 0,
                endTripSec: trip.timeline.contentDurationSec,
                withAudio: true,
                withGpmf: false,
                mp4Writable: await handle.createWritable(),
                onProgress() {},
            }),
        ).rejects.toMatchObject({ name: "IncompatibleVideoConfigError" });
        expect((await handle.getFile()).size).toBe(0);
    });

    it("rejects packet framing changes with an otherwise identical video configuration", async () => {
        const file = fixture("./parsers/__fixtures__/juscar/real-anonymized.TS");
        const remuxed = await remuxFixture(file);
        const source = open(file);
        const mp4 = open(remuxed);
        try {
            const originalConfig = await (await source.getPrimaryVideoTrack())!.getDecoderConfig();
            const remuxedConfig = await (await mp4.getPrimaryVideoTrack())!.getDecoderConfig();
            expect(originalConfig?.codec).toBe(remuxedConfig?.codec);
            expect(originalConfig?.codedWidth).toBe(remuxedConfig?.codedWidth);
            expect(originalConfig?.description).toBeUndefined();
            expect(remuxedConfig?.description).toBeDefined();
        } finally {
            source.dispose();
            mp4.dispose();
        }
        await expect(save([file, remuxed])).rejects.toMatchObject({ name: "IncompatibleVideoConfigError" });
    });

    it("preserves an existing destination when cancelled after copying begins", async () => {
        const file = fixture(H264_FIXTURE);
        const trip = await tripOf([file]);
        const handle = createInMemoryFileHandle("existing.mp4", file.size);
        const existing = await handle.createWritable();
        await existing.write(await file.arrayBuffer());
        await existing.close();
        const controller = new AbortController();
        // The progress throttle is the cancellation trigger under test.
        vi.useFakeTimers({ toFake: ["performance"] });
        try {
            vi.advanceTimersByTime(1000);
            await expect(
                exportClip({
                    trip,
                    channel: "front",
                    startTripSec: 0,
                    endTripSec: trip.timeline.contentDurationSec,
                    withAudio: false,
                    withGpmf: false,
                    mp4Writable: await handle.createWritable(),
                    signal: controller.signal,
                    onProgress(progress) {
                        if (progress.pct !== undefined) controller.abort();
                    },
                }),
            ).rejects.toMatchObject({ name: "AbortError" });
            expect(await (await handle.getFile()).arrayBuffer()).toEqual(await file.arrayBuffer());
            expect(getLogBuffer().filter((entry) => entry.msg.startsWith("writable close"))).toHaveLength(0);
            expect(getLogBuffer().filter((entry) => entry.msg === "segment copy failed")).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("identifies a damaged TS segment and discards its output without closing the aborted file", async () => {
        const original = fixture("./parsers/__fixtures__/juscar/real-anonymized.TS");
        const bytes = new Uint8Array(await original.arrayBuffer());
        bytes[Math.floor(bytes.length / 188 / 2) * 188] = 0;
        const damaged = new File([bytes], "damaged.ts");
        // Index the intact recording; corruption is encountered during the packet walk.
        const trip = await tripOf([original, original]);
        trip.frames[1]!.channels.front!.file = damaged;
        const handle = createInMemoryFileHandle("existing.mp4");
        const existing = await handle.createWritable();
        const previousBytes = new Uint8Array([1, 2, 3]);
        await existing.write(previousBytes);
        await existing.close();

        await expect(
            exportClip({
                trip,
                channel: "front",
                startTripSec: 0,
                endTripSec: trip.timeline.contentDurationSec,
                withAudio: true,
                withGpmf: false,
                mp4Writable: await handle.createWritable(),
                onProgress() {},
            }),
        ).rejects.toThrow("Invalid TS packet sync byte");

        expect(new Uint8Array(await (await handle.getFile()).arrayBuffer())).toEqual(previousBytes);
        const failure = getLogBuffer().find((entry) => entry.msg === "segment copy failed");
        expect(failure?.ctx).toMatchObject({
            segmentNumber: 2,
            segmentsCount: 2,
            file: damaged.name,
            fileSizeBytes: damaged.size,
            videoPackets: 0,
            audioPackets: 0,
        });
        expect(getLogBuffer().filter((entry) => entry.msg === "segment copied")).toHaveLength(1);
        expect(getLogBuffer().filter((entry) => entry.msg.startsWith("writable close"))).toHaveLength(0);
    });

    it("propagates an exhausted source-read failure during audio preflight", async () => {
        const file = fixture(H264_FIXTURE);
        const failure = new DOMException("requested file could not be read", "NotReadableError");
        const slice = file.slice.bind(file);
        let attempts = 0;
        file.slice = (...args) => {
            const blob = slice(...args);
            blob.stream = () =>
                new ReadableStream({
                    start(controller) {
                        attempts++;
                        controller.error(failure);
                    },
                });
            return blob;
        };
        vi.useFakeTimers();
        try {
            const rejected = expect(probeAudioUniformity([file])).rejects.toBe(failure);
            await vi.advanceTimersByTimeAsync(10_000);
            await rejected;
            expect(attempts).toBeGreaterThan(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

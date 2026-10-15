import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { BlobSource, BufferSource, EncodedPacketSink, Input, type EncodedPacket } from "mediabunny";
import { rolldown } from "rolldown";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMseFixture } from "../../tests/helpers/mse-fixtures.js";
import { findBox, iterBoxes, readHandlerType } from "../parsers/internal/mp4-walker.js";
import { clampTsTrailingBytes } from "../ts-trailer.js";
import { VIDEO_INPUT_FORMATS } from "../video-formats.js";
import { isWireMessage, type WireMessage, type WireNotification } from "./_protocol/wire.js";
import type { FeedDoneNotificationData, MediaSegmentNotificationData } from "./per-file-mse-protocol.js";

let tempDirectory: string;
const workers: Worker[] = [];

beforeAll(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "everydashcam-mse-test-"));
    const bundle = await rolldown({
        input: fileURLToPath(new URL("./per-file-mse-worker.ts", import.meta.url)),
        platform: "node",
        transform: { define: { "import.meta.env.DEV": "false", __PORTABLE__: "false" } },
    });
    try {
        await bundle.write({ file: join(tempDirectory, "worker.mjs"), format: "esm" });
    } finally {
        await bundle.close();
    }
    await writeFile(
        join(tempDirectory, "endpoint.mjs"),
        `import { parentPort, workerData } from "node:worker_threads";
        globalThis.self = {
            postMessage(message, transfer) { parentPort.postMessage(message, transfer); },
            addEventListener(type, listener) {
                if (type === "message") parentPort.on("message", data => {
                    // Node 22 clones File as Blob; browser workers retain its name.
                    if (data.__k === "req" && data.type === "init") {
                        data.data.file = new File([data.data.file], workerData.fileName);
                    }
                    listener({ data });
                });
            }
        };
        await import("./worker.mjs");
        parentPort.postMessage({ __k: "ntf", type: "ready" });`,
    );
});

afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

afterAll(async () => {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
});

async function openWorker(bytes: Uint8Array<ArrayBuffer>, startSec = 0, fileName = "sample.mp4") {
    const worker = new Worker(pathToFileURL(join(tempDirectory, "endpoint.mjs")), { workerData: { fileName } });
    workers.push(worker);
    const events: WireMessage[] = [];
    const listeners = new Set<() => void>();
    let failure: Error | null = null;
    worker.on("message", (message: unknown) => {
        if (!isWireMessage(message)) return;
        events.push(message);
        for (const listener of listeners) listener();
    });
    worker.on("error", (error) => {
        failure = error instanceof Error ? error : new Error(String(error));
        for (const listener of listeners) listener();
    });
    const waitFor = (predicate: () => boolean): Promise<void> =>
        new Promise((resolve, reject) => {
            const finish = () => {
                const errorMessage = events.find((event) => event.__k === "ntf" && event.type === "error");
                if (failure || errorMessage) {
                    cleanup();
                    reject(failure ?? new Error(JSON.stringify(errorMessage)));
                } else if (predicate()) {
                    cleanup();
                    resolve();
                }
            };
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error("worker did not produce the expected media"));
            }, 5000);
            const cleanup = () => {
                clearTimeout(timeout);
                listeners.delete(finish);
            };
            listeners.add(finish);
            finish();
        });
    const media = (cycleId: number) =>
        events.filter(
            (event): event is WireNotification =>
                event.__k === "ntf" &&
                event.type === "media-segment" &&
                (event.data as MediaSegmentNotificationData).cycleId === cycleId,
        );
    const send = (type: string, data: unknown) => worker.postMessage({ __k: "ntf", type, data });
    await waitFor(() => events.some((event) => event.__k === "ntf" && event.type === "ready"));
    // Exercise filename restoration even on Node versions that can clone File.
    worker.postMessage({ __k: "req", id: 1, type: "init", data: { file: new Blob([bytes]), startSec } });
    await waitFor(() => events.some((event) => event.__k === "res"));
    const init = events.find((event) => event.__k === "res");
    expect(init, JSON.stringify(init)).toMatchObject({ ok: true });
    send("start-feed", { cycleId: 0 });
    return { events, waitFor, media, send, init };
}

async function readCycle(events: WireMessage[], cycleId: number) {
    const chunks = events.flatMap((event) => {
        if (event.__k !== "ntf" || !["init-segment", "media-segment"].includes(event.type)) return [];
        const data = event.data as MediaSegmentNotificationData;
        return data.cycleId === cycleId ? [data.bytes] : [];
    });
    const input = new Input({ source: new BufferSource(Buffer.concat(chunks)), formats: VIDEO_INPUT_FORMATS });
    try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error("worker output has no video");
        const sink = new EncodedPacketSink(track);
        const audio = await input.getPrimaryAudioTrack();
        const audioPackets: EncodedPacket[] = [];
        if (audio) {
            for await (const packet of new EncodedPacketSink(audio).packets()) audioPackets.push(packet);
        }
        return {
            first: await sink.getFirstPacket(),
            duration: await input.computeDuration([track]),
            audioConfig: (await audio?.getDecoderConfig()) ?? null,
            audioPackets,
        };
    } finally {
        input.dispose();
    }
}

describe("per-file MSE worker with real encoded packets", () => {
    it("emits the first fragment when the GOP exceeds the buffer-ahead window", async () => {
        const harness = await openWorker(await createMseFixture({ gopDurationSec: 10, gopCount: 3 }));
        await harness.waitFor(() => harness.media(0).length > 0);
        const output = await readCycle(harness.events, 0);
        expect(output.first?.timestamp).toBeCloseTo(0);
        expect(output.duration).toBeCloseTo(10);
    });

    it("emits a full video GOP when leading audio flushes earlier fragments", async () => {
        const harness = await openWorker(
            await createMseFixture({
                gopDurationSec: 10,
                gopCount: 3,
                audioDurationSec: 30,
                audioLeadSec: 1024 / 48000,
            }),
        );
        expect(harness.init).toMatchObject({ result: { hasAudio: true } });
        await harness.waitFor(() =>
            harness
                .media(0)
                .some((event) => (event.data as MediaSegmentNotificationData).videoKeyframeTimestamps.length > 0),
        );
        const output = await readCycle(harness.events, 0);
        expect(output.first?.timestamp).toBeCloseTo(1024 / 48000, 3);
        expect(output.duration).toBeGreaterThanOrEqual(10);
    });

    it("keeps video playable when audio ends substantially earlier", async () => {
        const harness = await openWorker(await createMseFixture({ audioDurationSec: 0.4 }));
        expect(harness.init).toMatchObject({ result: { hasAudio: false } });
        await harness.waitFor(() => harness.media(0).length >= 5);
        const output = await readCycle(harness.events, 0);
        expect(output.duration).toBeGreaterThanOrEqual(5);
    });

    it("preserves matched audio despite ordinary codec padding differences", async () => {
        const harness = await openWorker(await createMseFixture({ gopCount: 2, audioDurationSec: 2 }));
        expect(harness.init).toMatchObject({ result: { hasAudio: true } });
        await harness.waitFor(() => harness.events.some((event) => event.__k === "ntf" && event.type === "feed-done"));
        expect((await readCycle(harness.events, 0)).duration).toBeCloseTo(2);
    });

    it("feeds the video tail past the last audio packet of a kept audio track", async () => {
        // Audio within the tail tolerance is kept, so the final video packets
        // carry timestamps no audio packet ever reaches: the audio-lead gate
        // must release them when the audio feed ends, not wait forever.
        const harness = await openWorker(await createMseFixture({ gopCount: 2, audioDurationSec: 1.85 }));
        expect(harness.init).toMatchObject({ result: { hasAudio: true } });
        await harness.waitFor(() => harness.events.some((event) => event.__k === "ntf" && event.type === "feed-done"));
        const output = await readCycle(harness.events, 0);
        expect(output.duration).toBeCloseTo(2);
        expect(output.audioPackets.length).toBeGreaterThan(0);
    });

    it("keeps the video when audio chunk offsets point past the file", async () => {
        const bytes = await createMseFixture({ gopCount: 2, audioDurationSec: 2 });
        const view = new DataView(bytes.buffer);
        const moov = findBox(view, 0, bytes.length, "moov")!;
        const audio = [...iterBoxes(view, moov.payloadStart, moov.end)].find(
            (box) => box.type === "trak" && readHandlerType(view, box) === "soun",
        )!;
        let parent = audio;
        for (const type of ["mdia", "minf", "stbl", "stco"]) {
            parent = findBox(view, parent.payloadStart, parent.end, type)!;
            expect(parent, type).toBeDefined();
        }
        const chunkCount = view.getUint32(parent.payloadStart + 4);
        expect(chunkCount).toBeGreaterThan(0);
        for (let i = 0; i < chunkCount; i++) {
            view.setUint32(parent.payloadStart + 8 + i * 4, bytes.length + 1024);
        }
        const harness = await openWorker(bytes);
        expect(harness.init).toMatchObject({ result: { hasAudio: false } });
        await harness.waitFor(() => harness.events.some((event) => event.__k === "ntf" && event.type === "feed-done"));
        const output = await readCycle(harness.events, 0);
        expect(output.duration).toBeCloseTo(2);
        expect(output.audioConfig).toBeNull();
        expect(output.first?.type).toBe("key");
    });

    it("keeps the video when the audio decoder configuration cannot be read", async () => {
        const bytes = await createMseFixture({ format: "matroska", gopCount: 2, audioDurationSec: 2 });
        const intact = new Input({ source: new BufferSource(bytes), formats: VIDEO_INPUT_FORMATS });
        let privateOffset: number;
        try {
            const description = (await (await intact.getPrimaryAudioTrack())?.getDecoderConfig())?.description;
            if (!(description instanceof Uint8Array)) throw new Error("fixture has no audio decoder description");
            expect(description.length).toBeLessThan(127);
            privateOffset = Buffer.from(bytes).indexOf(
                Buffer.from([0x63, 0xa2, 0x80 | description.length, ...description]),
            );
        } finally {
            intact.dispose();
        }
        expect(privateOffset).toBeGreaterThan(0);
        // Preserve the element's size and payload while making it unknown to the demuxer.
        bytes[privateOffset + 1] = 0xa3;
        const source = new Input({ source: new BufferSource(bytes), formats: VIDEO_INPUT_FORMATS });
        let videoDuration: number;
        try {
            const audio = await source.getPrimaryAudioTrack();
            expect(audio).not.toBeNull();
            await expect(audio!.getDecoderConfig()).rejects.toThrow();
            const video = await source.getPrimaryVideoTrack();
            expect(await video?.getDecoderConfig()).not.toBeNull();
            videoDuration = await video!.computeDuration();
            expect(videoDuration).toBeGreaterThan(1);
        } finally {
            source.dispose();
        }
        const harness = await openWorker(bytes, 0, "sample.mkv");
        expect(harness.init).toMatchObject({ result: { hasAudio: false } });
        await harness.waitFor(() => harness.events.some((event) => event.__k === "ntf" && event.type === "feed-done"));
        const output = await readCycle(harness.events, 0);
        expect(output.duration).toBeCloseTo(videoDuration);
        expect(output.audioConfig).toBeNull();
    });

    it("reports a rejected feed setup instead of leaving the player waiting", async () => {
        const harness = await openWorker(await createMseFixture({ gopCount: 2 }));
        await harness.waitFor(() => harness.media(0).length > 0);
        harness.send("seek", null);
        await expect(harness.waitFor(() => false)).rejects.toThrow("feed-setup-threw");
    });

    it("keeps TS playback and seeks on the same zero-based timeline", async () => {
        const harness = await openWorker(await createMseFixture({ format: "mpegts", sourceOffsetSec: 1.4 }));
        await harness.waitFor(() => harness.media(0).length >= 6);
        expect((await readCycle(harness.events, 0)).first?.timestamp).toBeCloseTo(0);
        harness.send("seek", { cycleId: 1, startSec: 5 });
        await harness.waitFor(() => harness.media(1).length > 0);
        expect((await readCycle(harness.events, 1)).first?.timestamp).toBeCloseTo(5);
        harness.send("seek", { cycleId: 2, startSec: 0.5 });
        await harness.waitFor(() => harness.media(2).length > 0);
        expect((await readCycle(harness.events, 2)).first?.timestamp).toBeCloseTo(0);
    });

    it.each(["avc", "hevc"])("preserves %s TS audio through startup and repeated seeks", async (codec) => {
        const bytes =
            codec === "avc"
                ? await createMseFixture({ format: "mpegts", gopCount: 2, audioDurationSec: 2, sourceOffsetSec: 1.4 })
                : new Uint8Array(
                      await readFile(
                          new URL("../parsers/__fixtures__/ligogps-trailer-ts/real-anonymized.TS", import.meta.url),
                      ),
                  );
        const source = new Input({
            source: new BlobSource(await clampTsTrailingBytes(new File([bytes], "sample.ts"))),
            formats: VIDEO_INPUT_FORMATS,
        });
        let audioPayloads: Uint8Array[];
        let audioTimestamps: number[];
        try {
            const audio = await source.getPrimaryAudioTrack();
            if (!audio) throw new Error("fixture has no audio");
            expect((await audio.getDecoderConfig())?.description).toBeUndefined();
            const packets: EncodedPacket[] = [];
            for await (const packet of new EncodedPacketSink(audio).packets()) packets.push(packet);
            const origin = await source.getFirstTimestamp();
            audioTimestamps = packets.map((packet) => packet.timestamp - origin);
            // MP4 carries the original AAC payload without the ADTS transport header.
            audioPayloads = packets.map((packet) => packet.data.subarray(packet.data[1]! & 1 ? 7 : 9));
        } finally {
            source.dispose();
        }

        const harness = await openWorker(bytes, 0, "sample.ts");
        expect(harness.init).toMatchObject({ result: { hasAudio: true, audioTranscoded: false } });
        const waitForDone = (cycleId: number) =>
            harness.waitFor(() =>
                harness.events.some(
                    (event) =>
                        event.__k === "ntf" &&
                        event.type === "feed-done" &&
                        (event.data as FeedDoneNotificationData).cycleId === cycleId,
                ),
            );
        harness.send("tick", { currentTime: 100, appendQueueLen: 0, playbackRate: 1 });
        await waitForDone(0);
        const initial = await readCycle(harness.events, 0);
        expect(initial.audioConfig?.description).toBeDefined();
        expect(initial.audioPackets.map((packet) => packet.data)).toEqual(audioPayloads);
        for (const [index, packet] of initial.audioPackets.entries()) {
            expect(packet.timestamp).toBeCloseTo(audioTimestamps[index]!, 5);
        }
        for (const [index, startSec] of [0.5, 0].entries()) {
            const cycleId = index + 1;
            harness.send("seek", { cycleId, startSec });
            await harness.waitFor(() => harness.media(cycleId).length > 0);
            harness.send("tick", { currentTime: 100, appendQueueLen: 0, playbackRate: 1 });
            await waitForDone(cycleId);
            const result = await readCycle(harness.events, cycleId);
            expect(result.audioConfig).toEqual(initial.audioConfig);
            const startIndex = audioTimestamps.reduce(
                (found, timestamp, index) => (timestamp <= startSec ? index : found),
                0,
            );
            expect(result.audioPackets.map((packet) => packet.data)).toEqual(audioPayloads.slice(startIndex));
            for (const [index, packet] of result.audioPackets.entries()) {
                expect(packet.timestamp).toBeCloseTo(audioTimestamps[startIndex + index]!, 5);
            }
        }
    });

    it("preserves a positive MP4 composition offset", async () => {
        const harness = await openWorker(await createMseFixture({ sourceOffsetSec: 1.4 }));
        await harness.waitFor(() => harness.media(0).length > 0);
        expect((await readCycle(harness.events, 0)).first?.timestamp).toBeCloseTo(1.4);
    });
});

import { readFile } from "node:fs/promises";
import {
    BufferSource,
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    MP4,
    MkvOutputFormat,
    Mp4OutputFormat,
    MpegTsOutputFormat,
    Output,
    type EncodedPacket,
    type VideoTrackMetadata,
} from "mediabunny";

interface MseFixtureOptions {
    videoMetadata?: VideoTrackMetadata;
    format?: "mp4" | "matroska" | "mpegts";
    gopDurationSec?: number;
    gopCount?: number;
    audioDurationSec?: number;
    audioLeadSec?: number;
    sourceOffsetSec?: number;
    preserveFrameTiming?: boolean;
}

/**
 * Retimes real encoded GoPro packets; no encoder or fabricated codec data is involved.
 * The output carries no container creation time, so the filename anchors the clip.
 */
export async function createMseFixture(options: MseFixtureOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = await readFile(new URL("../testdata/gopro-gpmf/hero5-trimmed.mp4", import.meta.url));
    const input = new Input({ source: new BufferSource(bytes), formats: [MP4] });
    const target = new BufferTarget();
    const format =
        options.format === "mpegts"
            ? new MpegTsOutputFormat()
            : options.format === "matroska"
              ? new MkvOutputFormat()
              : new Mp4OutputFormat();
    const output = new Output({ target, format });
    // Mediabunny stamps the current time by default. The app prefers that
    // stamp over the filename, so clips generated concurrently would share
    // one start, or land a second apart when generation crosses a second
    // boundary, and pair the wrong files.
    output.setMetadataTags({ creationTime: null });
    try {
        const video = await input.getPrimaryVideoTrack();
        if (!video) throw new Error("fixture has no video track");
        const codec = await video.getCodec();
        const config = await video.getDecoderConfig();
        if (!codec || !config) throw new Error("fixture has no video config");
        const sink = new EncodedPacketSink(video);
        const gop: EncodedPacket[] = [];
        let originalGopDuration = 0;
        for await (const packet of sink.packets()) {
            if (packet.type === "key" && gop.length > 0) {
                originalGopDuration = packet.timestamp - gop[0]!.timestamp;
                break;
            }
            gop.push(packet);
        }
        if (originalGopDuration <= 0) throw new Error("fixture has no complete gop");
        const videoSource = new EncodedVideoPacketSource(codec);
        output.addVideoTrack(videoSource, options.videoMetadata);
        const audio = options.audioDurationSec ? await input.getPrimaryAudioTrack() : null;
        const audioCodec = await audio?.getCodec();
        const audioConfig = await audio?.getDecoderConfig();
        const audioSource = audioCodec && audioConfig ? new EncodedAudioPacketSource(audioCodec) : null;
        if (audioSource) output.addAudioTrack(audioSource);
        await output.start();
        const offset = options.sourceOffsetSec ?? 0;
        if (audio && audioSource && audioConfig) {
            const packets: EncodedPacket[] = [];
            for await (const packet of new EncodedPacketSink(audio).packets()) {
                packets.push(packet);
            }
            if (packets.length === 0) throw new Error("fixture has no audio packets");
            const firstTimestamp = packets[0]!.timestamp;
            const last = packets[packets.length - 1]!;
            const span = last.timestamp + last.duration - firstTimestamp;
            if (span <= 0) throw new Error("fixture has no audio duration");
            for (let base = 0; base < options.audioDurationSec!; base += span) {
                for (const packet of packets) {
                    const timestamp = base + packet.timestamp - firstTimestamp;
                    if (timestamp >= options.audioDurationSec!) break;
                    await audioSource.add(packet.clone({ timestamp: timestamp + offset }), {
                        decoderConfig: audioConfig,
                    });
                }
            }
            audioSource.close();
        }
        const gopDuration = options.preserveFrameTiming ? originalGopDuration : (options.gopDurationSec ?? 1);
        const scale = gopDuration / originalGopDuration;
        for (let n = 0; n < (options.gopCount ?? 20); n++) {
            for (const packet of gop) {
                await videoSource.add(
                    packet.clone({
                        timestamp:
                            offset +
                            (options.audioLeadSec ?? 0) +
                            n * gopDuration +
                            (packet.timestamp - gop[0]!.timestamp) * scale,
                        duration: packet.duration * scale,
                    }),
                    { decoderConfig: config },
                );
            }
        }
        videoSource.close();
        await output.finalize();
        if (!target.buffer) throw new Error("fixture output is empty");
        return new Uint8Array(target.buffer);
    } finally {
        if (output.state !== "finalized" && output.state !== "canceled") await output.cancel();
        input.dispose();
    }
}

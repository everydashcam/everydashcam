// Matroska (.mkv) reader for IMA-ADPCM audio, the codec mediabunny cannot read
// (getCodec() -> null). Some dashcam viewers/tools re-export clips as Matroska
// with A_MS/ACM audio wrapping WAVE 0x11 (IMA ADPCM). We decode it ourselves to
// interleaved PCM-s16 (see ima-adpcm.ts) and hand it to a mediabunny
// AudioSampleSource, exactly like the ISOBMFF path (adpcm-audio.ts) - same
// AdpcmAudioReader contract, same two consumers (export + player MSE worker).
//
// Why a separate reader from openAdpcmAudio: that one walks the MP4 moov / stco
// chunk table for the raw blocks. Matroska has no moov; instead mediabunny hands
// each ADPCM block back as one EncodedPacket via EncodedPacketSink. So this
// reader is packet-driven: one packet = one block, decode it, emit one
// AudioSample. Timestamps are laid out by CUMULATIVE decoded frames (not by each
// block's own packet pts): a Matroska pts is rounded to the 1 ms TimestampScale
// grid, so per-block pts would leave a sub-ms gap at every ~32 ms block boundary
// and buzz after resampling. The packet pts is used only to find the start block,
// bound the range, and anchor the first emitted frame on the output timeline.

import { throwIfCancelled } from "../abort-signals.js";
import { EncodedPacketSink, Input, MATROSKA } from "mediabunny";
import { createRetryingBlobSource } from "../retrying-blob-source.js";
import { AudioSample, type AudioSampleSource } from "mediabunny";

import { createLogger } from "../log.js";
import type { AdpcmAudioReader } from "./adpcm-audio.js";
import { decodeImaAdpcmBlock, imaAdpcmFramesPerBlock } from "./ima-adpcm.js";

const log = createLogger("adpcm-matroska");

// Matroska CodecID for WAVE-in-ACM tracks. Combined with getCodec()===null it
// pins the IMA-ADPCM case: a PCM WAVE tag would be recognised by mediabunny
// (getCodec() != null), so a null codec under A_MS/ACM is a non-PCM WAVE codec,
// which for dashcam sources is IMA ADPCM.
const MATROSKA_ACM_CODEC_ID = "A_MS/ACM";

/**
 * Opens the audio track of a Matroska file and, if it is the IMA-ADPCM form
 * mediabunny cannot read, returns a reader that decodes arbitrary file-time
 * ranges to PCM-s16. Returns null when there is no audio track, the codec is
 * something else, or the channel/rate metadata is unusable - the caller then
 * exports without audio / plays silently.
 */
export async function openMatroskaAdpcmAudio(file: File): Promise<AdpcmAudioReader | null> {
    // Validate once on a throwaway Input; the feed methods open their own so no
    // Input lingers between calls (mediabunny Input has no idle release - dispose
    // is the documented lifecycle, and a per-call Input is also cancel-friendly).
    const probe = new Input({ source: createRetryingBlobSource(file), formats: [MATROSKA] });
    let channels: number;
    let sampleRate: number;
    try {
        const at = await probe.getPrimaryAudioTrack();
        if (!at) return null;
        if ((await at.getCodec()) !== null) return null; // recognised codec - not our ADPCM
        if ((await at.getInternalCodecId()) !== MATROSKA_ACM_CODEC_ID) return null;
        channels = at.numberOfChannels;
        sampleRate = at.sampleRate;
        if (channels < 1 || sampleRate < 1) return null;
    } catch (err) {
        log.warn("matroska adpcm probe failed", { file: file.name, err: err instanceof Error ? err.message : err });
        return null;
    } finally {
        probe.dispose();
    }

    /**
     * Streams the ADPCM blocks overlapping the file-time range to `source`,
     * decoding each to PCM-s16 and timestamping via `mapTs`. Returns the number
     * of PCM frames emitted. Opens (and always disposes) its own Input.
     */
    async function streamBlocks(
        source: AudioSampleSource,
        startInFileSec: number,
        endInFileSec: number,
        mapTs: (packetTs: number) => number,
        signal?: AbortSignal,
        onFirstEmit?: () => void,
    ): Promise<number> {
        const input = new Input({ source: createRetryingBlobSource(file), formats: [MATROSKA] });
        try {
            const at = await input.getPrimaryAudioTrack();
            if (!at) return 0;
            const sink = new EncodedPacketSink(at);
            // Start at the block covering startInFileSec (pts <= start), so no
            // audio at the head of the range is missed; getPacket returns null
            // only when start is before the first packet, then take the first.
            let pkt = (await sink.getPacket(startInFileSec)) ?? (await sink.getFirstPacket());
            let firstEmitted = false;
            let emittedFrames = 0;
            // Output timeline position of the FIRST emitted block, captured from
            // its mapped packet pts. Every later block is then placed at
            // anchor + emittedFrames/sampleRate so the decoded PCM tiles SEAMLESSLY.
            // Do NOT timestamp each block by its own mapped packet pts: Matroska
            // rounds pts to the TimestampScale grid (1 ms), while a block is
            // ~31.78 ms (1017 frames @ 32 kHz), so per-block pts leaves a
            // sub-millisecond gap/overlap at every block boundary - an audible
            // ~31 Hz buzz once the 32->48 kHz resample + AAC encode run over it.
            // The ISOBMFF reader (adpcm-audio.ts) tiles by cumulative frames for
            // the same reason; this mirrors it.
            let anchorSec: number | null = null;
            while (pkt) {
                throwIfCancelled(signal);
                if (pkt.timestamp >= endInFileSec) break;
                const block = pkt.data;
                const framesPerChannel = imaAdpcmFramesPerBlock(block.length, channels);
                if (framesPerChannel > 0) {
                    if (anchorSec === null) anchorSec = mapTs(pkt.timestamp);
                    const pcm = new Int16Array(framesPerChannel * channels);
                    decodeImaAdpcmBlock(block, channels, pcm, 0);
                    const sample = new AudioSample({
                        data: pcm,
                        format: "s16",
                        numberOfChannels: channels,
                        sampleRate,
                        timestamp: anchorSec + emittedFrames / sampleRate,
                    });
                    try {
                        await source.add(sample);
                    } finally {
                        sample.close();
                    }
                    if (!firstEmitted) {
                        firstEmitted = true;
                        onFirstEmit?.();
                    }
                    emittedFrames += framesPerChannel;
                }
                pkt = await sink.getNextPacket(pkt);
            }
            return emittedFrames;
        } finally {
            input.dispose();
        }
    }

    return {
        channels,
        sampleRate,
        // Not tracked for the packet-driven reader (no external consumer reads
        // it; the ISOBMFF reader exposes it only for its own frame-index math).
        totalFrames: 0,
        async feedRange(source, startInFileSec, endInFileSec, outStartSec, signal) {
            // Anchor the first emitted block on the output timeline at outStartSec
            // (the first block has pts <= start, so max(0, ...) clamps to 0);
            // streamBlocks then tiles later blocks by cumulative frames, keeping
            // timestamps monotonic (mediabunny requires non-decreasing PTS).
            const emitted = await streamBlocks(
                source,
                startInFileSec,
                endInFileSec,
                (packetTs) => outStartSec + Math.max(0, packetTs - startInFileSec),
                signal,
            );
            return emitted / sampleRate;
        },
        async feedToEnd(source, startInFileSec, framePtsOffsetSec, signal, onFirstEmit) {
            // Player path: anchor the first block at its absolute file time + the
            // cycle's PTS shift (matching the video packet timeline the worker
            // feeds in parallel); streamBlocks tiles the rest by cumulative frames.
            await streamBlocks(
                source,
                startInFileSec,
                Number.POSITIVE_INFINITY,
                (packetTs) => packetTs + framePtsOffsetSec,
                signal,
                onFirstEmit,
            );
        },
    };
}

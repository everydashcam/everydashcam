// Transcode-side reader for Mio/Navman MiVue audio, which is IMA ADPCM (WAVE
// 0x11) in a QuickTime `ms ` sample entry. mediabunny does not recognise the
// codec (getCodec() -> null) and cannot stream-copy it, so we decode it
// ourselves to interleaved PCM-s16 (see ima-adpcm.ts) and feed it to a
// mediabunny AudioSampleSource. The reader is codec-agnostic: it only produces
// PCM AudioSamples; the OUTPUT codec (and any resample) is the consumer's
// AudioSampleSource config. Two consumers share this one reader:
//
//   - EXPORT (src/export.ts): bounded file-time ranges per output segment,
//     timestamps on the output accumulator timeline (feedRange). Sink is an
//     AAC/Opus encode source where the browser can encode, else a lossless
//     pcm-s16 source.
//   - PLAYER (workers/per-file-mse-worker.ts): whole-file feed from a seek
//     position to EOF, timestamps on the absolute file timeline plus the cycle's
//     PTS shift (feedToEnd). Sink prefers Opus where MSE can play it and uses
//     AAC where it cannot (notably Safari); pcm-s16 is not MSE-playable, so the
//     player has no PCM fallback and drops audio if neither encoder is usable.
//
// Both encode consumers resample to 48 kHz / stereo via the source transform
// (AUDIO_TARGET_*): RFC 7845 mandates 48 kHz for Opus-in-ISOBMFF, and it also
// keeps mediabunny on AAC-LC rather than HE-AAC. The reader stays at the source
// rate; the resample is the sink's job.
//
// Block framing note: each container chunk is exactly one self-contained ADPCM
// block, so we read the track as per-chunk byte ranges and treat each as a
// block (the metadata blockAlign is unreliable on these cameras).
//
// Testing: there is deliberately no browser e2e for this path, and it is not a
// gap to be filled later - an anonymized ADPCM-in-MOV fixture cannot be produced
// at all (ffmpeg refuses to mux adpcm_ima_wav into mp4/mov), so there is no
// real-but-safe container to drive a headless browser with. Coverage is instead:
// ima-adpcm.test.ts (the decoder, bit-exact vs a hand reference) +
// adpcm-audio.test.ts (this reader, on a hand-built synthetic MOV); the live
// MSE playback was verified manually against the real Navman sample.

import { AudioSample, type AudioSampleSource } from "mediabunny";
import { isMatroskaName } from "../video-format-names.js";
import { openMatroskaAdpcmAudio } from "./adpcm-audio-matroska.js";
import {
    type Box,
    findMoovInFile,
    isImaAdpcmSampleEntry,
    iterBoxes,
    readChunkByteRanges,
    readHandlerType,
    readSoundSampleParams,
} from "../parsers/internal/mp4-walker.js";
import { decodeImaAdpcmBlock, imaAdpcmFramesPerBlock } from "./ima-adpcm.js";

// Decode at most this many blocks before emitting, to bound transient PCM
// memory. A whole-file player feed (feedToEnd) would otherwise decode the entire
// track up front; a long export range (feedRange) likewise. 64 Navman blocks
// (~1009 frames each) is ~2 s of 32 kHz audio, ~256 KB of PCM per batch.
const DECODE_BATCH_BLOCKS = 64;

// Concurrency for the scattered per-chunk reads (audio chunks are interleaved
// with video in mdat, so each is a separate small File.slice).
const READ_CONCURRENCY = 32;

export interface AdpcmAudioReader {
    channels: number;
    sampleRate: number;
    /** Total decoded PCM frames across the whole track. */
    totalFrames: number;
    /**
     * Decodes the blocks overlapping the file-time range [startInFileSec,
     * endInFileSec) and feeds them to `source` as interleaved PCM-s16
     * AudioSamples, timestamped so the first emitted frame lands at `outStartSec`
     * on the output timeline. Returns the emitted duration in seconds (so the
     * caller can advance its audio accumulator), or 0 if the range is empty.
     * Used by the EXPORT path.
     */
    feedRange(
        source: AudioSampleSource,
        startInFileSec: number,
        endInFileSec: number,
        outStartSec: number,
        signal?: AbortSignal,
    ): Promise<number>;
    /**
     * Decodes from `startInFileSec` to the end of the track and feeds the
     * AudioSamples to `source`, timestamping each frame at its ABSOLUTE file
     * time plus `framePtsOffsetSec`. Used by the PLAYER (MSE worker), where the
     * audio must line up with the video packet timeline (which carries the same
     * shift). Streams in bounded batches so audio starts without decoding the
     * whole file first. Returns when EOF is reached or the signal aborts.
     */
    feedToEnd(
        source: AudioSampleSource,
        startInFileSec: number,
        framePtsOffsetSec: number,
        signal?: AbortSignal,
        /**
         * Called once, right after the first AudioSample has been added to the
         * source. The MSE worker uses it to gate the video feed: the muxer
         * builds the init segment (moov) from whatever tracks have a sample by
         * the first fragment, so the audio track must receive a sample before
         * the first video keyframe or the moov ships video-only.
         */
        onFirstEmit?: () => void,
    ): Promise<void>;
}

/**
 * Container-aware IMA-ADPCM opener. Routes `.mkv` to the Matroska packet-driven
 * reader (openMatroskaAdpcmAudio) and everything else to the ISOBMFF moov-walking
 * reader (openAdpcmAudio). The latter intentionally includes ISO-BMFF recordings
 * mislabeled `.TS` by some cameras. Every export/player call site goes through
 * this so a new container needs one branch here, not a change at each site.
 */
export async function openAdpcmAudioAuto(file: File): Promise<AdpcmAudioReader | null> {
    if (isMatroskaName(file.name)) {
        return openMatroskaAdpcmAudio(file);
    }
    return openAdpcmAudio(file);
}

/**
 * Opens the audio track of an MP4/MOV and, if it is IMA ADPCM in a QuickTime
 * `ms ` entry, returns a reader that can decode arbitrary file-time ranges to
 * PCM-s16. Returns null when there is no soun track, the format is not the
 * IMA-ADPCM form we handle, or the sample table is unreadable - the caller then
 * exports without audio / plays silently.
 */
export async function openAdpcmAudio(file: File): Promise<AdpcmAudioReader | null> {
    const moov = await findMoovInFile(file);
    if (!moov) return null;
    const dv = new DataView(moov.bytes.buffer, moov.bytes.byteOffset, moov.bytes.byteLength);

    let soun: Box | null = null;
    for (const box of iterBoxes(dv, 8, dv.byteLength)) {
        if (box.type === "trak" && readHandlerType(dv, box) === "soun") {
            soun = box;
            break;
        }
    }
    if (!soun) return null;

    const params = readSoundSampleParams(dv, soun);
    if (!params || !isImaAdpcmSampleEntry(params.format)) return null;
    const { channels, sampleRate } = params;
    if (channels < 1 || sampleRate < 1) return null;

    const ranges = readChunkByteRanges(dv, soun);
    if (!ranges || ranges.length === 0) return null;

    // Block = chunk. Per-block frame counts and cumulative frame starts let us
    // map a file-time range onto the block list (timing, not the metadata
    // blockAlign, which is unreliable on these cameras).
    const cumFrames = new Array<number>(ranges.length + 1);
    cumFrames[0] = 0;
    for (let i = 0; i < ranges.length; i++) {
        cumFrames[i + 1] = cumFrames[i]! + imaAdpcmFramesPerBlock(ranges[i]!.length, channels);
    }
    const totalFrames = cumFrames[ranges.length]!;

    /**
     * Streams PCM for file-frames [startFrame, endFrame) to `source`, decoding
     * in bounded batches and emitting ~1 s interleaved-s16 AudioSamples.
     * `mapTs(fileFrame)` gives the output timestamp (seconds) for an absolute
     * file frame - this is the one knob that differs between the export
     * (accumulator timeline) and player (absolute + shift) consumers. Returns
     * the number of frames emitted.
     */
    async function streamPcm(
        source: AudioSampleSource,
        startFrame: number,
        endFrame: number,
        mapTs: (fileFrame: number) => number,
        signal?: AbortSignal,
        onAfterFirstAdd?: () => void,
    ): Promise<number> {
        if (endFrame <= startFrame) return 0;
        const bi0 = blockIndexForFrame(cumFrames, startFrame);
        const bi1 = blockIndexForFrame(cumFrames, endFrame - 1) + 1;
        let emitted = 0;
        let firstAddDone = false;
        for (let b = bi0; b < bi1; b += DECODE_BATCH_BLOCKS) {
            if (signal?.aborted) throw new DOMException("aborted", "AbortError");
            const bEnd = Math.min(b + DECODE_BATCH_BLOCKS, bi1);
            const blocks = await readChunkRanges(file, ranges!, b, bEnd, signal);

            // Decode this batch into one buffer starting at file-frame cumFrames[b].
            const batchStartFrame = cumFrames[b]!;
            const batchFrames = cumFrames[bEnd]! - batchStartFrame;
            const pcm = new Int16Array(batchFrames * channels);
            let written = 0;
            for (const block of blocks) written += decodeImaAdpcmBlock(block, channels, pcm, written);

            // Clip the batch to [startFrame, endFrame): the first batch may begin
            // before startFrame, the last may extend past endFrame.
            const clipStart = Math.max(startFrame, batchStartFrame);
            const clipEnd = Math.min(endFrame, cumFrames[bEnd]!);

            // Emit ~1 s AudioSamples; each carries its first frame's mapped
            // timestamp, the rest follow at the sample rate -> monotonic.
            for (let f = clipStart; f < clipEnd; f += sampleRate) {
                if (signal?.aborted) throw new DOMException("aborted", "AbortError");
                const n = Math.min(sampleRate, clipEnd - f);
                const local = (f - batchStartFrame) * channels;
                const data = pcm.subarray(local, local + n * channels);
                const sample = new AudioSample({
                    data,
                    format: "s16",
                    numberOfChannels: channels,
                    sampleRate,
                    timestamp: mapTs(f),
                });
                try {
                    await source.add(sample);
                } finally {
                    sample.close();
                }
                if (!firstAddDone) {
                    firstAddDone = true;
                    onAfterFirstAdd?.();
                }
                emitted += n;
            }
        }
        return emitted;
    }

    return {
        channels,
        sampleRate,
        totalFrames,
        async feedRange(source, startInFileSec, endInFileSec, outStartSec, signal) {
            const startFrame = clampFrame(Math.floor(startInFileSec * sampleRate), 0, totalFrames);
            const endFrame = clampFrame(Math.ceil(endInFileSec * sampleRate), startFrame, totalFrames);
            const emitted = await streamPcm(
                source,
                startFrame,
                endFrame,
                (f) => outStartSec + (f - startFrame) / sampleRate,
                signal,
            );
            return emitted / sampleRate;
        },
        async feedToEnd(source, startInFileSec, framePtsOffsetSec, signal, onFirstEmit) {
            const startFrame = clampFrame(Math.floor(startInFileSec * sampleRate), 0, totalFrames);
            await streamPcm(
                source,
                startFrame,
                totalFrames,
                (f) => f / sampleRate + framePtsOffsetSec,
                signal,
                onFirstEmit,
            );
        },
    };
}

/** Clamps a frame index into [lo, hi]. */
function clampFrame(frame: number, lo: number, hi: number): number {
    return Math.min(Math.max(lo, frame), hi);
}

/** Last block index `i` with `cumFrames[i] <= frame` (binary search). */
function blockIndexForFrame(cumFrames: readonly number[], frame: number): number {
    let lo = 0;
    let hi = cumFrames.length - 2; // last entry is the total, not a block start
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cumFrames[mid]! <= frame) lo = mid;
        else hi = mid - 1;
    }
    return Math.max(0, lo);
}

/**
 * Reads byte ranges `[from, to)` of `ranges` from the file with bounded
 * concurrency (the chunks are scattered in mdat, one small slice each).
 */
async function readChunkRanges(
    file: File,
    ranges: readonly { offset: number; length: number }[],
    from: number,
    to: number,
    signal?: AbortSignal,
): Promise<Uint8Array[]> {
    const out = new Array<Uint8Array>(to - from);
    let next = from;
    async function worker(): Promise<void> {
        for (;;) {
            const i = next++;
            if (i >= to) return;
            if (signal?.aborted) throw new DOMException("aborted", "AbortError");
            const r = ranges[i]!;
            const buf = await file.slice(r.offset, r.offset + r.length).arrayBuffer();
            out[i - from] = new Uint8Array(buf);
        }
    }
    const workers = Math.min(READ_CONCURRENCY, to - from);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return out;
}

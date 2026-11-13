import { AudioSample, type AudioSampleSource } from "mediabunny";
import { describe, expect, it, vi } from "vitest";
import { decodeImaAdpcmBlocks } from "./ima-adpcm.js";
import { openAdpcmAudio } from "./adpcm-audio.js";
import { captureAudioSamples, concatCapturedPcm } from "./test-helpers.js";
import { AUDIO_TARGET_SAMPLE_RATE } from "./types.js";

describe("ADPCM encode resample target", () => {
    it("is 48000 - RFC 7845 requires the Opus AudioSampleEntry rate to be 48k or MSE rejects the moov", () => {
        // The player worker and export feed their AAC/Opus AudioSampleSource
        // transform.sampleRate this value. Anything else makes Chrome's MSE
        // demuxer reject the fragmented mp4 for Opus (verified with a real
        // avc1+opus MediaSource harness). Do not "optimize" it to the source's
        // native rate.
        expect(AUDIO_TARGET_SAMPLE_RATE).toBe(48000);
    });
});

// ===== synthetic MOV builder (ftyp + mdat + moov with a soun ADPCM trak) =====
//
// The reader treats each container chunk as one ADPCM block. We model that with
// one chunk per block: stsc = 1 sample/chunk, stsz = uniform block length, stco
// = each block's absolute file offset. This exercises the streaming decode/emit
// path end to end (openAdpcmAudio -> feedRange / feedToEnd) on a deterministic
// file, since an anonymized real ADPCM-in-MOV fixture cannot be produced with
// ffmpeg (it refuses to mux adpcm_ima_wav into mp4/mov).

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
    let len = 8;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    new DataView(out.buffer).setUint32(0, len);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}
function u32be(...ns: number[]): Uint8Array {
    const out = new Uint8Array(ns.length * 4);
    const dv = new DataView(out.buffer);
    ns.forEach((n, i) => {
        dv.setUint32(i * 4, n >>> 0);
    });
    return out;
}
function le(spec: [number, number][]): Uint8Array {
    const total = spec.reduce((a, [, w]) => a + w, 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    let o = 0;
    for (const [v, w] of spec) {
        if (w === 2) dv.setUint16(o, v, true);
        else dv.setUint32(o, v, true);
        o += w;
    }
    return out;
}

const MS_IMA = String.fromCharCode(0x6d, 0x73, 0x00, 0x11);

/** Builds a soun trak whose chunk table points one chunk per block into mdat. */
function buildSounTrak(chunkOffsets: number[], blockLen: number, channels: number, sampleRate: number): Uint8Array {
    const wfx = box(
        MS_IMA,
        le([
            [0x11, 2], // wFormatTag
            [channels, 2],
            [sampleRate, 4],
            [sampleRate, 4], // nAvgBytesPerSec (placeholder)
            [blockLen, 2], // nBlockAlign (deliberately the per-chunk byte length)
            [4, 2], // wBitsPerSample
            [0, 2], // cbSize
        ]),
    );
    const wave = box("wave", box("frma", new Uint8Array([0x6d, 0x73, 0x00, 0x11])), wfx);
    // Sound description v1 header (version=1) so childStart math reaches `wave`.
    const soundDescV1 = new Uint8Array(36);
    const sd = new DataView(soundDescV1.buffer);
    sd.setUint16(0, 1); // version=1
    sd.setUint16(8, channels);
    sd.setUint16(10, 4); // sampleSize
    sd.setUint32(12, (sampleRate << 16) >>> 0); // 16.16 sample rate
    const sampleEntry = box(MS_IMA, new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), soundDescV1, wave);
    const stsd = box("stsd", u32be(0, 1), sampleEntry);
    const stco = box("stco", u32be(0, chunkOffsets.length, ...chunkOffsets));
    const stsc = box("stsc", u32be(0, 1, 1, 1, 1)); // 1 sample per chunk
    const stsz = box("stsz", u32be(0, blockLen, chunkOffsets.length)); // uniform size = blockLen
    const stbl = box("stbl", stsd, stco, stsc, stsz);
    const minf = box("minf", stbl);
    const hdlr = box("hdlr", u32be(0, 0), new Uint8Array([0x73, 0x6f, 0x75, 0x6e]), u32be(0, 0, 0)); // 'soun'
    const mdia = box("mdia", hdlr, minf);
    return box("trak", mdia);
}

/** Builds a full [ftyp][mdat][moov] File from raw ADPCM blocks (all same length). */
function buildAdpcmMovFile(blocks: Uint8Array[], channels: number, sampleRate: number): File {
    const blockLen = blocks[0]!.length;
    const ftyp = box("ftyp", new Uint8Array([0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0])); // 'qt  '
    // mdat: 8-byte header then the blocks back to back.
    const mdatPayloadLen = blocks.length * blockLen;
    const mdat = new Uint8Array(8 + mdatPayloadLen);
    new DataView(mdat.buffer).setUint32(0, mdat.length);
    mdat.set([0x6d, 0x64, 0x61, 0x74], 4); // 'mdat'
    const mdatStart = ftyp.length;
    const dataStart = mdatStart + 8;
    const chunkOffsets: number[] = [];
    for (let i = 0; i < blocks.length; i++) {
        const off = dataStart + i * blockLen;
        mdat.set(blocks[i]!, 8 + i * blockLen);
        chunkOffsets.push(off);
    }
    const moov = box("moov", buildSounTrak(chunkOffsets, blockLen, channels, sampleRate));
    const file = new Uint8Array(ftyp.length + mdat.length + moov.length);
    file.set(ftyp, 0);
    file.set(mdat, ftyp.length);
    file.set(moov, ftyp.length + mdat.length);
    return new File([file], "synthetic.mov");
}

/** Deterministic pseudo-random ADPCM blocks (content is irrelevant to framing). */
function makeBlocks(count: number, blockLen: number): Uint8Array[] {
    const blocks: Uint8Array[] = [];
    let seed = 0x1234;
    for (let b = 0; b < count; b++) {
        const block = new Uint8Array(blockLen);
        for (let i = 0; i < blockLen; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            block[i] = (seed >> 8) & 0xff;
        }
        blocks.push(block);
    }
    return blocks;
}

const CHANNELS = 2;
const SR = 1000; // tiny so 5000 frames = 5 s, exercising multi-batch emit
const BLOCK_LEN = 32; // 8-byte header (2ch) + 3 word-pairs -> 25 frames/block
const FRAMES_PER_BLOCK = 25;
const N_BLOCKS = 200; // > DECODE_BATCH_BLOCKS (64) -> multiple decode batches

describe("openAdpcmAudio", () => {
    it("reports channels/sampleRate/totalFrames from the synthetic MOV", async () => {
        const blocks = makeBlocks(N_BLOCKS, BLOCK_LEN);
        const reader = await openAdpcmAudio(buildAdpcmMovFile(blocks, CHANNELS, SR));
        expect(reader).not.toBeNull();
        expect(reader!.channels).toBe(CHANNELS);
        expect(reader!.sampleRate).toBe(SR);
        expect(reader!.totalFrames).toBe(N_BLOCKS * FRAMES_PER_BLOCK);
    });

    it("returns null when there is no IMA-ADPCM soun track", async () => {
        // A bare moov with no soun trak.
        const moov = box("moov", box("trak", box("mdia")));
        const ftyp = box("ftyp", new Uint8Array(8));
        const file = new File([new Uint8Array([...ftyp, ...moov])], "novideo.mov");
        expect(await openAdpcmAudio(file)).toBeNull();
    });

    it("feedToEnd(0) emits the whole track, bit-exact vs a direct decode, ts at file time", async () => {
        const blocks = makeBlocks(N_BLOCKS, BLOCK_LEN);
        const reader = (await openAdpcmAudio(buildAdpcmMovFile(blocks, CHANNELS, SR)))!;
        const { source, samples } = captureAudioSamples("s16");
        let firstEmits = 0;
        await reader.feedToEnd(source, 0, 0, undefined, () => firstEmits++);

        expect(firstEmits).toBe(1); // onFirstEmit fires exactly once
        const got = concatCapturedPcm(samples, "s16");
        const want = decodeImaAdpcmBlocks(blocks, CHANNELS);
        expect(got).toEqual(want);
        // First sample anchored at 0; timestamps monotonic at cumulative frame / SR.
        expect(samples[0]!.timestamp).toBe(0);
        let frameCum = 0;
        for (const s of samples) {
            expect(s.timestamp).toBeCloseTo(frameCum / SR, 9);
            frameCum += s.frames;
        }
        expect(frameCum).toBe(N_BLOCKS * FRAMES_PER_BLOCK);
    });

    it("feedToEnd(startSec) anchors timestamps at absolute file time plus the PTS shift", async () => {
        const blocks = makeBlocks(N_BLOCKS, BLOCK_LEN);
        const reader = (await openAdpcmAudio(buildAdpcmMovFile(blocks, CHANNELS, SR)))!;
        const { source, samples } = captureAudioSamples("s16");
        const startSec = 2.0;
        const offset = 0.5;
        await reader.feedToEnd(source, startSec, offset);

        const startFrame = Math.floor(startSec * SR);
        // First emitted frame is `startFrame`; its ts = startFrame/SR + offset.
        expect(samples[0]!.timestamp).toBeCloseTo(startFrame / SR + offset, 9);
        const want = decodeImaAdpcmBlocks(blocks, CHANNELS).subarray(startFrame * CHANNELS);
        expect(concatCapturedPcm(samples, "s16")).toEqual(want);
    });

    it("feedRange clips to [start,end) and anchors the first frame at outStartSec", async () => {
        const blocks = makeBlocks(N_BLOCKS, BLOCK_LEN);
        const reader = (await openAdpcmAudio(buildAdpcmMovFile(blocks, CHANNELS, SR)))!;
        const { source, samples } = captureAudioSamples("s16");
        const dur = await reader.feedRange(source, 1.0, 2.0, 100);

        const startFrame = 1000;
        const endFrame = 2000;
        expect(dur).toBeCloseTo((endFrame - startFrame) / SR, 9);
        expect(samples[0]!.timestamp).toBe(100);
        const want = decodeImaAdpcmBlocks(blocks, CHANNELS).subarray(startFrame * CHANNELS, endFrame * CHANNELS);
        expect(concatCapturedPcm(samples, "s16")).toEqual(want);
        let total = 0;
        for (const s of samples) total += s.frames;
        expect(total).toBe(endFrame - startFrame);
    });

    it("feedRange clips WITHIN a block when start/end fall mid-block", async () => {
        // The other cases start on a block boundary (1000/25=40 aligns). A real
        // 32 kHz seek lands mid-block, exercising clipStart > batchStartFrame and
        // clipEnd < blockEnd. Frames 1010..1990 both sit inside blocks 40 / 79.
        const blocks = makeBlocks(N_BLOCKS, BLOCK_LEN);
        const reader = (await openAdpcmAudio(buildAdpcmMovFile(blocks, CHANNELS, SR)))!;
        const { source, samples } = captureAudioSamples("s16");
        const dur = await reader.feedRange(source, 1.01, 1.99, 50);

        const startFrame = 1010; // floor(1.01*1000), mid block 40 [1000,1025)
        const endFrame = 1990; // ceil(1.99*1000), mid block 79 [1975,2000)
        expect(dur).toBeCloseTo((endFrame - startFrame) / SR, 9);
        expect(samples[0]!.timestamp).toBe(50);
        const want = decodeImaAdpcmBlocks(blocks, CHANNELS).subarray(startFrame * CHANNELS, endFrame * CHANNELS);
        expect(concatCapturedPcm(samples, "s16")).toEqual(want);
        let total = 0;
        for (const s of samples) total += s.frames;
        expect(total).toBe(endFrame - startFrame);
    });

    it("passes each clipped PCM region to the native AudioData constructor", async () => {
        const captured: { data: Int16Array }[] = [];
        // Node has no AudioData. Capture the native constructor boundary;
        // copyTo alone misses a backing-buffer offset lost by toAudioData.
        class CapturedAudioData {
            constructor(init: AudioDataInit) {
                const bytes = ArrayBuffer.isView(init.data)
                    ? new Uint8Array(init.data.buffer, init.data.byteOffset, init.data.byteLength)
                    : new Uint8Array(init.data);
                const size = init.numberOfFrames * init.numberOfChannels * 2;
                captured.push({ data: new Int16Array(bytes.slice(0, size).buffer) });
            }
            close() {}
        }
        vi.stubGlobal("AudioData", CapturedAudioData);
        try {
            const blocks = makeBlocks(N_BLOCKS, BLOCK_LEN);
            const reader = (await openAdpcmAudio(buildAdpcmMovFile(blocks, CHANNELS, SR)))!;
            const source = {
                async add(sample: AudioSample) {
                    sample.toAudioData().close();
                },
            } as unknown as AudioSampleSource;
            await reader.feedRange(source, 1.01, 4.67, 0);
            const expected = decodeImaAdpcmBlocks(blocks, CHANNELS).subarray(1010 * CHANNELS, 4670 * CHANNELS);
            expect(concatCapturedPcm(captured, "s16")).toEqual(expected);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("openRange fed in steps emits feedRange's PCM and timestamps without passing a limit", async () => {
        const blocks = makeBlocks(N_BLOCKS, BLOCK_LEN);
        const reader = (await openAdpcmAudio(buildAdpcmMovFile(blocks, CHANNELS, SR)))!;
        const { source, samples } = captureAudioSamples("s16");
        const cursor = reader.openRange(source, 1.01, 50);

        await cursor.feedBefore(1.5);
        expect(cursor.emittedSec, "less than a second ahead waits for a later limit").toBe(0);
        await cursor.feedBefore(2.2);
        expect(cursor.emittedSec, "fed exactly up to the limit").toBeCloseTo(1.19, 9);
        await cursor.feedBefore(2);
        expect(cursor.emittedSec, "an earlier limit is a no-op").toBeCloseTo(1.19, 9);
        await cursor.feedBefore(3.9);
        expect(cursor.emittedSec).toBeCloseTo(2.89, 9);
        await cursor.finish(4.67);
        await cursor.close();

        expect(concatCapturedPcm(samples, "s16")).toEqual(
            decodeImaAdpcmBlocks(blocks, CHANNELS).subarray(1010 * CHANNELS, 4670 * CHANNELS),
        );
        let frames = 0;
        for (const sample of samples) {
            expect(sample.timestamp).toBeCloseTo(50 + frames / SR, 9);
            frames += sample.frames;
        }
        expect(frames).toBe(4670 - 1010);
    });

    it("feedRange on an empty range emits nothing", async () => {
        const blocks = makeBlocks(10, BLOCK_LEN);
        const reader = (await openAdpcmAudio(buildAdpcmMovFile(blocks, CHANNELS, SR)))!;
        const { source, samples } = captureAudioSamples("s16");
        const dur = await reader.feedRange(source, 5, 5, 0);
        expect(dur).toBe(0);
        expect(samples.length).toBe(0);
    });

    it("closes an emitted sample when the output source rejects it", async () => {
        const reader = (await openAdpcmAudio(buildAdpcmMovFile(makeBlocks(1, BLOCK_LEN), CHANNELS, SR)))!;
        const boom = new Error("encoder rejected sample");
        let captured: AudioSample | null = null;
        const source = {
            async add(sample: AudioSample) {
                captured = sample;
                throw boom;
            },
        } as unknown as AudioSampleSource;

        await expect(reader.feedRange(source, 0, 1, 0)).rejects.toBe(boom);
        expect(captured).not.toBeNull();
        expect(() => captured!.allocationSize({ planeIndex: 0 })).toThrow("AudioSample is closed");
    });
});

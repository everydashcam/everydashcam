// IMA/DVI ADPCM decoder (WAVE format tag 0x0011), as written by Mio/Navman
// MiVue cameras into a QuickTime `ms \0\x11` audio sample entry.
//
// Browsers do not decode ADPCM (not in the HTML media codec set, not in the
// WebCodecs registry), and mediabunny does not recognise the codec either, so
// the only way to give the exported MP4 working audio is to decode it ourselves
// to linear PCM-s16 (which mediabunny CAN mux and the browser CAN play) here.
//
// Block framing - the non-obvious part: the metadata blockAlign (nBlockAlign in
// the WAVEFORMATEX, bytesPerFrame in the QuickTime v1 sound description) on a
// real Navman sample is 1024, but the ACTUAL stored block size is 1017 bytes -
// the camera makes each container chunk exactly one self-contained ADPCM block.
// So we do NOT trust the metadata blockAlign; the caller passes one Uint8Array
// per chunk (= per block) and the block's sample count is derived from its byte
// length. Verified against ffmpeg (whose own MOV path mis-frames this file).
//
// Block layout (multi-channel WAV IMA): a per-channel 4-byte header (int16 LE
// initial predictor + uint8 step index + 1 reserved byte), then the remaining
// bytes as 4-byte words that interleave per channel (word0 = ch0's next 8
// samples, word1 = ch1's, ...), low nibble first. A trailing partial word is
// ignored. The Navman content is mono duplicated into both channels (the two
// channels carry byte-identical data), so the decoded L and R are equal.

// Canonical IMA ADPCM step-size table (89 entries).
const STEP_TABLE = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
    118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
    6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
] as const;

// Index adjustment per nibble (16 entries).
const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8] as const;

const STEP_TABLE_MAX_INDEX = STEP_TABLE.length - 1; // 88

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max));
}

// Each nibble transition depends only on its step index. Keep the exact integer
// reconstruction (including its separate shifts) outside the PCM sample loop.
const nibbleDeltas = new Int32Array(STEP_TABLE.length * 16);
const nibbleNextIndices = new Uint8Array(STEP_TABLE.length * 16);
for (let index = 0; index < STEP_TABLE.length; index++) {
    const step = STEP_TABLE[index]!;
    for (let nibble = 0; nibble < 16; nibble++) {
        let diff = step >> 3;
        if (nibble & 4) diff += step;
        if (nibble & 2) diff += step >> 1;
        if (nibble & 1) diff += step >> 2;
        const key = index * 16 + nibble;
        nibbleDeltas[key] = nibble & 8 ? -diff : diff;
        nibbleNextIndices[key] = clamp(index + INDEX_TABLE[nibble]!, 0, STEP_TABLE_MAX_INDEX);
    }
}

/**
 * PCM frames per channel a block of `blockBytes` decodes to: 1 from each
 * channel's header predictor, plus 8 per 4-byte data word. A trailing partial
 * word (the block length need not be a multiple of 4*channels) contributes 0.
 */
export function imaAdpcmFramesPerBlock(blockBytes: number, channels: number): number {
    const dataBytes = blockBytes - 4 * channels;
    if (dataBytes < 0) return 0;
    const wordsPerChannel = Math.floor(dataBytes / (4 * channels));
    return 1 + wordsPerChannel * 8;
}

/**
 * Decodes one ADPCM block into interleaved PCM-s16, writing into `out` starting
 * at `outOffset`. The block's sample count is derived from its byte length (see
 * the module note: the metadata blockAlign is unreliable here). Returns the
 * number of int16 values written (frames * channels).
 */
export function decodeImaAdpcmBlock(block: Uint8Array, channels: number, out: Int16Array, outOffset: number): number {
    if (block.length < 4 * channels) return 0;
    const framesPerChannel = imaAdpcmFramesPerBlock(block.length, channels);
    const wordsPerChannel = (framesPerChannel - 1) / 8;
    const wordStride = 4 * channels;

    // Decode channels independently so predictor/index remain scalar locals;
    // no channel-state objects need allocating for each container block.
    for (let ch = 0; ch < channels; ch++) {
        const h = ch * 4;
        let predictor = ((block[h]! | (block[h + 1]! << 8)) << 16) >> 16;
        let index = clamp(block[h + 2]!, 0, STEP_TABLE_MAX_INDEX);
        let writePos = outOffset + ch;
        out[writePos] = predictor;
        writePos += channels;
        let pos = wordStride + h;
        for (let word = 0; word < wordsPerChannel; word++) {
            for (let b = 0; b < 4; b++) {
                const byte = block[pos + b]!;
                let key = index * 16 + (byte & 0x0f);
                predictor = clamp(predictor + nibbleDeltas[key]!, -32768, 32767);
                index = nibbleNextIndices[key]!;
                out[writePos] = predictor;
                writePos += channels;
                key = index * 16 + (byte >> 4);
                predictor = clamp(predictor + nibbleDeltas[key]!, -32768, 32767);
                index = nibbleNextIndices[key]!;
                out[writePos] = predictor;
                writePos += channels;
            }
            pos += wordStride;
        }
    }

    return framesPerChannel * channels;
}

/**
 * Decodes a list of ADPCM blocks (one Uint8Array per container chunk, each a
 * self-contained block) into a single interleaved PCM-s16 buffer.
 */
export function decodeImaAdpcmBlocks(blocks: readonly Uint8Array[], channels: number): Int16Array {
    let totalFrames = 0;
    for (const block of blocks) totalFrames += imaAdpcmFramesPerBlock(block.length, channels);
    const out = new Int16Array(totalFrames * channels);
    let written = 0;
    for (const block of blocks) {
        written += decodeImaAdpcmBlock(block, channels, out, written);
    }
    return written === out.length ? out : out.subarray(0, written);
}

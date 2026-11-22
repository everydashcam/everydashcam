// HEVC helpers for two dashcam cases where native <video>.src produces a black
// screen and the file must go through MSE with a per-file mediabunny remux:
//
//   1. Sample entry hev1 (in-band parameter sets) on BlackVue ELITE 9 and
//      Vantrue N2X. Chrome's native MP4 demuxer and MediaSource both reject
//      the hev1.* codec string; mediabunny always writes hvc1 on HEVC remux,
//      so remux is needed just to normalize the sample entry.
//
//   2. Invalid NAL arrays in HEVCDecoderConfigurationRecord (hvcC).
//      BlackVue ELITE 9 firmware writes a 4th array with nal_unit_type=0
//      and 128 bytes of zero padding. ISO/IEC 14496-15 §8 requires only
//      parameter sets (VPS=32, SPS=33, PPS=34) and SEI (39, 40). Chrome's
//      VideoToolbox strictly parses the record and throws PIPELINE_ERROR_DECODE
//      on the invalid array. Mediabunny copies description as-is, so we
//      clean it before passing to videoSource.add(...).
//
// They are kept separate from the per-file MSE pipeline so:
//   - indexer.ts can use them at ingest time for needsHevcRemux detection
//     without pulling in the full playback pipeline;
//   - cleanHvccDescription stays reusable if the remux strategy changes.

/**
 * Returns true if this HEVC NAL type must not appear in hvcC and will crash
 * the native decoder. 7-bit HEVC NAL type ranges:
 *  - 0..31  - VCL slice data - garbage in hvcC, native crashes.
 *  - 32..40 - parameter sets (VPS/SPS/PPS) and trailers (AUD/EOS/EOB/FD/SEI).
 *             Strictly only PS+SEI per ISO/IEC 14496-15 §8.3.3.1.2, but
 *             firmware often writes AUD/EOS/EOB/FD; native decoders ignore them.
 *  - 41..44 - reserved non-IRAP (not seen on dashcams; kept valid to avoid
 *             false positives).
 *  - 45..63 - reserved IRAP / unspec - must not be in hvcC.
 *
 * In practice only BlackVue ELITE 9 firmware breaks native (writes TRAIL_N=0
 * with 128 bytes of zero padding). The other 22 hev1 files from 6 vendors
 * have clean [VPS, SPS, PPS] and play natively.
 */
function isInvalidHvccNalType(nalType: number): boolean {
    return nalType < 32 || nalType > 44;
}

/**
 * Strips invalid NAL arrays from an HEVCDecoderConfigurationRecord and
 * rebuilds the record with an updated numOfArrays.
 *
 * Returns the original buffer unchanged if nothing needs to be removed,
 * so the caller can use a reference comparison (`out !== input`) to decide
 * whether remux is needed - no allocation on the 99% valid case.
 */
export function cleanHvccDescription(desc: AllowSharedBufferSource | undefined): AllowSharedBufferSource | undefined {
    if (!desc) return desc;
    let src: Uint8Array;
    if (desc instanceof ArrayBuffer) {
        src = new Uint8Array(desc);
    } else if (ArrayBuffer.isView(desc)) {
        // .buffer may be a SharedArrayBuffer in theory; mediabunny always
        // returns ArrayBuffer-backed Uint8Array in our pipeline, so the cast is safe.
        src = new Uint8Array(desc.buffer as ArrayBuffer, desc.byteOffset, desc.byteLength);
    } else {
        // SharedArrayBuffer as the root type - leave it; our writer never produces one.
        return desc;
    }
    if (src.byteLength < 23) return desc; // header(22) + numOfArrays(1)
    const numArrays = src[22]!;
    if (numArrays === 0) return desc;
    type ArrInfo = { headerByte: number; numNalus: number; nalus: Uint8Array[] };
    const valid: ArrInfo[] = [];
    let p = 23;
    let anyDropped = false;
    for (let a = 0; a < numArrays; a++) {
        if (p + 3 > src.length) return desc; // truncated header - leave as-is
        const headerByte = src[p]!;
        const nalType = headerByte & 0x3f;
        const numNalus = (src[p + 1]! << 8) | src[p + 2]!;
        p += 3;
        const nalus: Uint8Array[] = [];
        for (let n = 0; n < numNalus; n++) {
            if (p + 2 > src.length) return desc;
            const naluSize = (src[p]! << 8) | src[p + 1]!;
            const naluStart = p + 2;
            if (naluStart + naluSize > src.length) return desc;
            nalus.push(src.subarray(naluStart, naluStart + naluSize));
            p = naluStart + naluSize;
        }
        if (isInvalidHvccNalType(nalType)) {
            anyDropped = true;
        } else {
            valid.push({ headerByte, numNalus, nalus });
        }
    }
    if (!anyDropped) return desc;
    // Rebuild: header(22) + numOfArrays(1) + arrays.
    let totalLen = 23;
    for (const arr of valid) {
        totalLen += 3;
        for (const n of arr.nalus) totalLen += 2 + n.byteLength;
    }
    const out = new Uint8Array(totalLen);
    out.set(src.subarray(0, 22), 0);
    out[22] = valid.length;
    let q = 23;
    for (const arr of valid) {
        out[q] = arr.headerByte;
        out[q + 1] = (arr.numNalus >> 8) & 0xff;
        out[q + 2] = arr.numNalus & 0xff;
        q += 3;
        for (const n of arr.nalus) {
            out[q] = (n.byteLength >> 8) & 0xff;
            out[q + 1] = n.byteLength & 0xff;
            out.set(n, q + 2);
            q += 2 + n.byteLength;
        }
    }
    return out;
}

/**
 * Returns true if the file needs MSE remux before playback (native
 * <video>.src=URL.createObjectURL(File) would produce a black screen).
 *
 * True when codec === "hevc" AND hvcC contains a NAL array with an invalid
 * type (VCL slice data 0-31 or reserved 45+). Catches exactly BlackVue
 * ELITE 9 (firmware writes TRAIL_N=0 + 128 bytes of zero padding).
 *
 * The former detection "codec=hevc AND codecParam.startsWith('hev1.')"
 * false-positived on 22 hev1 files from 6 vendors (70mai/CARCAM/DDPAI/Vantrue)
 * that play natively via <video>.src. The hev1 sample entry itself is handled
 * natively; only genuinely invalid hvcC content breaks playback.
 *
 * codec and description come from mediabunny during ingest - see indexer.ts.
 * Remux is activated per-file via VideoCandidate.needsHevcRemux.
 */
export function needsHevcRemux(codec: string | null, description: AllowSharedBufferSource | null | undefined): boolean {
    if (codec !== "hevc") return false;
    if (!description) return false;
    return cleanHvccDescription(description) !== description;
}

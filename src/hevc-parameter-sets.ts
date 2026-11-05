// HEVC parameter-set helpers shared by the hvcC repair (repair/hvcc.ts) and the
// raw Annex-B container view (raw-hevc-view.ts). Both need the same SPS fields
// to synthesize an HEVCDecoderConfigurationRecord, so the bit-level parsing
// lives in one place.

export const HEVC_NAL_VPS = 32;
export const HEVC_NAL_SPS = 33;
export const HEVC_NAL_PPS = 34;

/** Fixed prefix of an HEVCDecoderConfigurationRecord before its NAL arrays. */
export const HVCC_HEADER_BYTES = 23;

/** SPS fields needed to synthesize the hvcC header and describe the picture. */
export interface HevcSps {
    profile_space: number;
    tier_flag: number;
    profile_idc: number;
    profile_compatibility_flags: number;
    /** general_constraint_indicator_flags (48 bits), packed into 6 bytes. */
    constraint_indicator_48: bigint;
    level_idc: number;
    chromaFormat: number;
    bitDepthLumaMinus8: number;
    bitDepthChromaMinus8: number;
    /** numTemporalLayers = sps_max_sub_layers_minus1 + 1. */
    numTemporalLayers: number;
    /** sps_temporal_id_nesting_flag. */
    temporalIdNested: number;
    /** Displayed size: the coded size minus the conformance window. */
    width: number;
    height: number;
}

/**
 * Parses an SPS NAL unit (with its 2-byte header) up to and including
 * bit_depth_chroma_minus8, also extracting profile_tier_level. Returns null if:
 *   - sps_max_sub_layers_minus1 > 0 (multi-temporal-layer; not seen on
 *     dashcams; supporting sub-layer profile_tier_level adds more bug surface
 *     than real cases it would cover);
 *   - sanity bounds: profile_idc / chroma_format_idc / bit_depth outside spec;
 *   - the bytes end before the last needed field.
 *
 * Does not parse further than needed; we do not reconstruct VUI/sub_layer/etc.
 */
export function parseHevcSps(spsNalu: Uint8Array): HevcSps | null {
    if (spsNalu.length < 3) return null;
    // Skip 2-byte NAL header.
    const rbsp = stripEmulationPrevention(spsNalu.subarray(2));
    const reader = makeBitReader(rbsp);
    try {
        reader.u(4); // sps_video_parameter_set_id
        const max_sub_layers_minus1 = reader.u(3);
        const temporal_id_nesting_flag = reader.u(1);
        if (max_sub_layers_minus1 > 0) return null;

        // profile_tier_level(profilePresentFlag=1, max_sub_layers_minus1=0)
        const profile_space = reader.u(2);
        const tier_flag = reader.u(1);
        const profile_idc = reader.u(5);
        // profile_compatibility_flags - 32 bits, fits in JS Number (u32 ok).
        const profile_compatibility_flags = reader.u(32);
        // 4 individual constraint flags
        const progressive = reader.u(1);
        const interlaced = reader.u(1);
        const nonPacked = reader.u(1);
        const frameOnly = reader.u(1);
        // 44 bits: read as 22+22 to stay within the 32-bit JS u() limit.
        const reservedHi22 = reader.u(22);
        const reservedLo22 = reader.u(22);
        const level_idc = reader.u(8);
        // max_sub_layers_minus1 = 0 => no sub-layer block.

        // sps_seq_parameter_set_id ue(v)
        reader.ue();
        const chroma_format_idc = reader.ue();
        if (chroma_format_idc === 3) reader.u(1); // separate_colour_plane_flag
        const codedWidth = reader.ue();
        const codedHeight = reader.ue();
        let cropLeft = 0;
        let cropRight = 0;
        let cropTop = 0;
        let cropBottom = 0;
        const conformanceWindow = reader.u(1);
        if (conformanceWindow) {
            cropLeft = reader.ue();
            cropRight = reader.ue();
            cropTop = reader.ue();
            cropBottom = reader.ue();
        }
        const bit_depth_luma_minus8 = reader.ue();
        const bit_depth_chroma_minus8 = reader.ue();

        // Spec sanity bounds:
        //   profile_idc 0..31 (5 bit)
        //   chroma_format_idc 0..3
        //   bit_depth_*_minus8 0..6 (8..14 bit)
        if (profile_idc > 31) return null;
        if (chroma_format_idc > 3) return null;
        if (bit_depth_luma_minus8 > 6) return null;
        if (bit_depth_chroma_minus8 > 6) return null;

        // Conformance window offsets count chroma samples (H.265 Table 6-1).
        const subWidthC = chroma_format_idc === 1 || chroma_format_idc === 2 ? 2 : 1;
        const subHeightC = chroma_format_idc === 1 ? 2 : 1;
        // Not range-checked: the hvcC repair needs only the profile fields, so a
        // nonsensical size must not cancel it. Callers that use the size check it.
        const width = codedWidth - subWidthC * (cropLeft + cropRight);
        const height = codedHeight - subHeightC * (cropTop + cropBottom);

        // 48-bit constraint_indicator: 4 individual flags (MSB first) + 44 reserved.
        const top4 = (progressive << 3) | (interlaced << 2) | (nonPacked << 1) | frameOnly;
        const constraint_indicator_48 = (BigInt(top4) << 44n) | (BigInt(reservedHi22) << 22n) | BigInt(reservedLo22);

        return {
            profile_space,
            tier_flag,
            profile_idc,
            profile_compatibility_flags,
            constraint_indicator_48,
            level_idc,
            chromaFormat: chroma_format_idc,
            bitDepthLumaMinus8: bit_depth_luma_minus8,
            bitDepthChromaMinus8: bit_depth_chroma_minus8,
            numTemporalLayers: max_sub_layers_minus1 + 1,
            temporalIdNested: temporal_id_nesting_flag,
            width,
            height,
        };
    } catch {
        return null;
    }
}

/**
 * Writes the 23-byte hvcC header (ISO/IEC 14496-15 8.3.3.1, FFmpeg
 * hvcc_write) at the start of `out`, describing 4-byte NAL length prefixes.
 * All reserved bits are '1'. The caller owns the NAL arrays after the header
 * and states how many there are.
 */
export function writeHvcCHeader(out: Uint8Array, sps: HevcSps, numOfArrays: number): void {
    out[0] = 1; // configurationVersion
    out[1] = ((sps.profile_space & 0x3) << 6) | ((sps.tier_flag & 0x1) << 5) | (sps.profile_idc & 0x1f);
    // profile_compatibility_flags (32 bit BE)
    writeU32BE(out, 2, sps.profile_compatibility_flags >>> 0);
    // constraint_indicator_flags (48 bit BE)
    const c = sps.constraint_indicator_48;
    out[6] = Number((c >> 40n) & 0xffn);
    out[7] = Number((c >> 32n) & 0xffn);
    out[8] = Number((c >> 24n) & 0xffn);
    out[9] = Number((c >> 16n) & 0xffn);
    out[10] = Number((c >> 8n) & 0xffn);
    out[11] = Number(c & 0xffn);
    out[12] = sps.level_idc & 0xff;
    // 4 reserved '1' + 12 bit min_spatial_segmentation_idc=0
    out[13] = 0xf0;
    out[14] = 0x00;
    // 6 reserved '1' + 2 bit parallelismType=0
    out[15] = 0xfc;
    // 6 reserved '1' + 2 bit chromaFormat
    out[16] = 0xfc | (sps.chromaFormat & 0x3);
    // 5 reserved '1' + 3 bit bitDepthLumaMinus8
    out[17] = 0xf8 | (sps.bitDepthLumaMinus8 & 0x7);
    // 5 reserved '1' + 3 bit bitDepthChromaMinus8
    out[18] = 0xf8 | (sps.bitDepthChromaMinus8 & 0x7);
    // 16 bit avgFrameRate=0 (unspecified - valid per spec)
    out[19] = 0;
    out[20] = 0;
    // 2 bit constantFrameRate=0 + 3 bit numTemporalLayers + 1 bit temporalIdNested + 2 bit lengthSizeMinusOne=3
    out[21] = ((sps.numTemporalLayers & 0x7) << 3) | ((sps.temporalIdNested & 0x1) << 2) | 3;
    out[22] = numOfArrays & 0xff;
}

/** One hvcC NAL array: every NAL unit of one parameter-set type. */
export interface HvcCNalArray {
    nalUnitType: number;
    nalus: readonly Uint8Array[];
}

/**
 * Builds a complete hvcC payload from parameter-set NAL units (each with its
 * 2-byte header, without start codes or emulation stripping). Every array is
 * marked complete: the caller keeps these parameter sets out of the samples.
 * Returns null when the arrays carry no parseable SPS.
 */
export function buildHvcC(arrays: readonly HvcCNalArray[]): Uint8Array | null {
    const nonEmpty = arrays.filter((array) => array.nalus.length > 0);
    const spsNalu = nonEmpty.find((array) => array.nalUnitType === HEVC_NAL_SPS)?.nalus[0];
    const sps = spsNalu ? parseHevcSps(spsNalu) : null;
    if (!sps) return null;
    let size = HVCC_HEADER_BYTES;
    for (const array of nonEmpty) {
        size += 3;
        for (const nalu of array.nalus) size += 2 + nalu.length;
    }
    const out = new Uint8Array(size);
    writeHvcCHeader(out, sps, nonEmpty.length);
    let p = HVCC_HEADER_BYTES;
    for (const array of nonEmpty) {
        // array_completeness=1, reserved=0, NAL_unit_type
        out[p] = 0x80 | (array.nalUnitType & 0x3f);
        out[p + 1] = (array.nalus.length >> 8) & 0xff;
        out[p + 2] = array.nalus.length & 0xff;
        p += 3;
        for (const nalu of array.nalus) {
            out[p] = (nalu.length >> 8) & 0xff;
            out[p + 1] = nalu.length & 0xff;
            out.set(nalu, p + 2);
            p += 2 + nalu.length;
        }
    }
    return out;
}

function writeU32BE(out: Uint8Array, off: number, value: number): void {
    out[off] = (value >>> 24) & 0xff;
    out[off + 1] = (value >>> 16) & 0xff;
    out[off + 2] = (value >>> 8) & 0xff;
    out[off + 3] = value & 0xff;
}

/**
 * Removes emulation_prevention_three_bytes (0x03 after two 0x00) from a NAL
 * RBSP (ITU-T H.265 §B.2). Returns a new Uint8Array.
 */
function stripEmulationPrevention(nalRbsp: Uint8Array): Uint8Array {
    const out: number[] = [];
    let zeroes = 0;
    for (let i = 0; i < nalRbsp.length; i++) {
        const b = nalRbsp[i]!;
        if (zeroes >= 2 && b === 0x03) {
            zeroes = 0;
            continue;
        }
        out.push(b);
        if (b === 0) zeroes++;
        else zeroes = 0;
    }
    return new Uint8Array(out);
}

interface BitReader {
    u(n: number): number;
    ue(): number;
}

/**
 * Bit-reader for RBSP. Big-endian (MSB first) as required by HEVC.
 * u(n) reads an unsigned n-bit field (n up to 32). ue() reads an exp-Golomb
 * unsigned value (ITU-T H.265 §9.2).
 */
function makeBitReader(bytes: Uint8Array): BitReader {
    let bytePos = 0;
    let bitPos = 0;
    const u = (n: number): number => {
        // JS bitwise ops are sign-extended 32 bits. Read a 32-bit field as two
        // u(16) and combine to avoid going negative on the high bit.
        // HEVC profile_compat_flags fits in u32 (≤ 0xFFFFFFFF).
        if (n === 32) {
            const hi = u(16);
            const lo = u(16);
            return hi * 0x10000 + lo;
        }
        if (n > 32) throw new Error("bit reader n > 32");
        let v = 0;
        for (let i = 0; i < n; i++) {
            if (bytePos >= bytes.length) throw new Error("bit reader: out of bounds");
            const b = (bytes[bytePos]! >> (7 - bitPos)) & 1;
            v = (v << 1) | b;
            bitPos++;
            if (bitPos === 8) {
                bitPos = 0;
                bytePos++;
            }
        }
        // Force unsigned in case v went negative via signed left-shift of the MSB.
        return v >>> 0;
    };
    const ue = (): number => {
        let zeroes = 0;
        // Cap to avoid looping forever on an all-zero tail.
        while (zeroes < 32) {
            if (bytePos >= bytes.length) throw new Error("bit reader: out of bounds in ue");
            if (u(1) !== 0) break;
            zeroes++;
        }
        if (zeroes === 0) return 0;
        if (zeroes >= 32) throw new Error("bit reader: ue overflow");
        const tail = u(zeroes);
        // 2**zeroes (not 1<<zeroes): the signed 32-bit shift makes 1<<31
        // negative, flipping the value by 2^32. 2**zeroes is an exact double
        // for zeroes <= 31. Matches the module's other signed-overflow guards.
        return 2 ** zeroes - 1 + tail;
    };
    return { u, ue };
}

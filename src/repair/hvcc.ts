// Repair of HEVCDecoderConfigurationRecord (hvcC) for two independent damage
// patterns. Both manifest in the browser as a black <video> screen with audio
// playing (native or WebCodecs decoder finds no valid parameter sets).
//
// Pattern A - zeroed header. Some dashcam firmwares (observed on 70mai x800
// after a "failed" finalization) write an hvcC where the header fields
// (profile_idc, level_idc, bit_depth, chroma_format, numOfArrays) are filled
// with zeros/garbage, while the actual VPS/SPS/PPS bytes sit at the correct
// payload offsets after the 23-byte header. Fix: parse the first SPS from the
// payload (those bytes are valid), extract profile/level/bit_depth/chroma
// from it, and synthesize a valid 23-byte header.
//
// Pattern B - invalid NAL arrays. BlackVue ELITE 9 (4K HEVC) firmware
// tail-pads the hvcC with 128 bytes of zeros that parse as fake arrays with
// invalid NAL_unit_type. The MSE backend handles this at runtime via
// hevc-remux.ts/cleanHvccDescription, but pure mediabunny decode paths
// (preview-worker, frame-extract via VideoSampleSink) feed the raw description
// to VideoDecoder.configure() and crash with "Decoder error". Fix: strip the
// bad arrays and zero-pad to keep the original payload size (the decoder
// walks only numOfArrays entries, trailing zeros are never read).
//
// Both fixes preserve the on-disk hvcC box size, so stco/co64/stsz offsets
// remain valid - only the payload bytes are replaced via zero-copy Blob
// concatenation: file.slice() + Uint8Array + file.slice().

import { cleanHvccDescription } from "../hevc-remux.js";
import { createLogger } from "../log.js";
import { findBox, findHvccInTrak, findMoovInFile, iterBoxes } from "../parsers/internal/mp4-walker.js";

const log = createLogger("repair:hvcc");

const NAL_TYPE_VPS = 32;
const NAL_TYPE_SPS = 33;
const NAL_TYPE_PPS = 34;

/** Result of a successful repair. */
export interface RepairedHvcC {
    /** New File wrapper with the replaced hvcC. Zero-copy: the original is not loaded into RAM. */
    file: File;
    /** Patched hvcC payload bytes (for the caller to recompute needsHevcRemux). */
    description: Uint8Array;
}

/**
 * hvcC repair computed purely from moov bytes - no file IO. The hvcC box always
 * lives inside moov, which the indexer already reads, so the rebuilt payload can
 * be produced from those bytes alone. Offsets are relative to the start of the
 * moov bytes the caller passed in; the caller writes `rebuilt` at
 * `moovRelPayloadStart` into a moov copy and splices it back via Blob
 * concatenation (constant size, so all file offsets hold).
 */
export interface HvcCRepair {
    /** Offset of the hvcC payload within the moov bytes. */
    moovRelPayloadStart: number;
    /** Rebuilt hvcC payload, same byte length as the original. */
    rebuilt: Uint8Array;
    /** Which damage pattern was fixed. */
    reason: "header" | "arrays";
}

/**
 * Detects a broken hvcC inside already-read moov bytes and returns the rebuilt
 * payload + its moov-relative offset, or null when no hvcC is present / it is
 * healthy / the repair would be unsafe. Pure: no file IO.
 *
 * Two independent damage patterns are handled:
 *   (a) Zeroed header (numOfArrays=0 but VPS/SPS/PPS sit in the tail) -
 *       rebuilt header from SPS introspection, body kept intact.
 *   (b) Header is fine but a NAL array has an invalid NAL_unit_type (BlackVue
 *       ELITE 9 firmware tail-pads with 128 zero bytes that parse as bogus
 *       arrays). Cleaned via cleanHvccDescription (same logic the MSE backend
 *       uses at runtime) and zero-padded back to the original size so the box
 *       size - and every subsequent mp4 offset - stays intact.
 *
 * Used by the indexer worker (repair detection on moov bytes it already holds)
 * and by the file-level repairBrokenHvcC wrapper below.
 */
export function detectHvcCRepair(moovBytes: Uint8Array): HvcCRepair | null {
    const dv = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);

    let located: LocatedHvcC | null;
    try {
        located = findHvcCInDataView(dv);
    } catch {
        // Box walk hit an unexpected structure - leave the file as-is.
        return null;
    }
    if (!located) return null;

    // findHvcCInDataView reports offsets relative to dv (= moov start), which is
    // exactly the moov-relative coordinate the caller patches in.
    const payloadStart = located.payloadStartAbs;
    const payloadEnd = located.endAbs;
    const payloadLen = payloadEnd - payloadStart;
    if (payloadLen < 23) return null; // not enough for a header - not our case
    // The hvcC payload is a view into the moov bytes; rebuild/clean only read it.
    const payload = moovBytes.subarray(payloadStart, payloadEnd);

    let rebuilt: Uint8Array | null = null;
    let reason: "header" | "arrays" = "header";
    if (isBrokenHeader(payload)) {
        try {
            rebuilt = rebuildHvcC(payload);
        } catch {
            return null;
        }
        if (!rebuilt) return null;
    } else {
        const cleaned = cleanHvccDescription(payload);
        if (cleaned !== payload && cleaned instanceof Uint8Array) {
            // Pad-up so the hvcC box size on disk is unchanged - guards stco/co64/stsz.
            const padded = new Uint8Array(payloadLen);
            padded.set(cleaned, 0);
            rebuilt = padded;
            reason = "arrays";
        }
    }
    if (!rebuilt) return null;

    // Guard against corrupting moov offsets: the rebuilt payload must be the
    // same size as the original. Both branches enforce that by construction;
    // the check is explicit in case a future regression breaks it.
    if (rebuilt.byteLength !== payloadLen) return null;

    return { moovRelPayloadStart: payloadStart, rebuilt, reason };
}

/**
 * File-level wrapper over {@link detectHvcCRepair}: locates the moov (works for
 * moov-first AND moov-last layouts - BlackVue 4K writes moov in the tail),
 * detects the repair from those bytes, and returns a zero-copy File wrapper with
 * the patched moov spliced back in. Returns null when nothing is broken.
 *
 * The bulk-ingest path no longer calls this - the indexer worker runs
 * detectHvcCRepair on the moov bytes it already holds (see src/repair/moov-repair.ts)
 * and the main thread applies the splice. This wrapper stays as the standalone
 * file-level entry point, covered by the container fixtures in hvcc.test.ts.
 */
export async function repairBrokenHvcC(file: File): Promise<RepairedHvcC | null> {
    const moov = await findMoovInFile(file).catch((err) => {
        log.debug("hvcc scan: findMoovInFile failed", {
            file: file.name,
            err: err instanceof Error ? err.message : String(err),
        });
        return null;
    });
    if (!moov) return null;

    const repair = detectHvcCRepair(moov.bytes);
    if (!repair) return null;

    // Patch a copy of the moov bytes and splice it back. The hvcC sits inside
    // moov, so the whole-moov splice replaces exactly the rebuilt bytes and
    // nothing else. Zero-copy: file.slice() returns lazy Blob views, only the
    // moov copy (tens of KB) is materialized.
    const patchedMoov = new Uint8Array(moov.bytes);
    patchedMoov.set(repair.rebuilt, repair.moovRelPayloadStart);
    const patchedBlob = new Blob(
        [file.slice(0, moov.fileStart), patchedMoov as unknown as BlobPart, file.slice(moov.fileEnd)],
        { type: file.type },
    );
    const patchedFile = new File([patchedBlob], file.name, {
        type: file.type,
        lastModified: file.lastModified,
    });

    log.info("patched broken hvcc", {
        file: file.name,
        hvcCSize: repair.rebuilt.byteLength,
        reason: repair.reason,
        newHeaderHex: hex(repair.rebuilt.subarray(0, 23)),
    });

    return { file: patchedFile, description: repair.rebuilt };
}

// ====== implementation ======

interface LocatedHvcC {
    /** Absolute offset of the hvcC payload in the file (= box_start + 8). */
    payloadStartAbs: number;
    /** Absolute exclusive-end of the hvcC box in the file. */
    endAbs: number;
}

/**
 * Finds the first hvcC via the standard path
 * moov/trak/mdia/minf/stbl/stsd/(hvc1|hev1)/hvcC. Returns null when no hvcC
 * is found (not an HEVC file / unexpected layout) - the caller leaves the
 * file alone.
 *
 * `dv` covers the moov box bytes from findMoovInFile, so the reported offsets
 * are MOOV-RELATIVE; the caller shifts them by moov.fileStart into absolute
 * file offsets.
 */
function findHvcCInDataView(dv: DataView): LocatedHvcC | null {
    const moov = findBox(dv, 0, dv.byteLength, "moov");
    if (!moov) return null;
    for (const trak of iterBoxes(dv, moov.payloadStart, moov.end)) {
        if (trak.type !== "trak") continue;
        // Reuse the indexer's exact stsd -> hvc1/hev1 -> hvcC walk (mp4-walker's
        // findHvccInTrak) so the 78-byte VisualSampleEntry prefix and the
        // hvc1/hev1 entry set live in one place instead of a second copy here.
        const loc = findHvccInTrak(dv, trak);
        if (loc) return { payloadStartAbs: loc.payloadStart, endAbs: loc.payloadEnd };
    }
    return null;
}

/**
 * Heuristic "header is broken but the NAL array payload in the tail is valid"
 * from the real 70mai pattern. Triggers only when ALL conditions hold:
 *
 *   1. byte[22] (numOfArrays) === 0 - decoder sees no arrays.
 *   2. payload longer than 23 bytes - there is data after the header.
 *   3. parsing from offset 23 as a NAL array sequence yields at least one
 *      valid array of type VPS/SPS/PPS with at least one NAL unit whose
 *      NAL header byte matches array.NAL_unit_type.
 *
 * For parent='hvc1' (not hev1) numOfArrays=0 is a spec violation on its own
 * (inband params are forbidden in hvc1). For hev1 it is technically allowed
 * when params are inband, but we repair anyway: (a) 70mai always uses hvc1,
 * (b) if the payload has valid VPS/SPS/PPS it is the same bug regardless.
 */
function isBrokenHeader(payload: Uint8Array): boolean {
    if (payload.length <= 23) return false;
    const numArrays = payload[22]!;
    if (numArrays !== 0) return false;
    // Also require configurationVersion=1; anything else is an exotic file,
    // not our pattern. Even the broken 70mai firmware writes this field correctly.
    if (payload[0] !== 1) return false;
    // Parse the payload arrays; if at least one valid VPS/SPS/PPS is found, it is our case.
    const arrays = tryParseNalArraysAfterHeader(payload);
    if (!arrays || arrays.length === 0) return false;
    // At least one SPS is required - without it we cannot reconstruct the header.
    const hasSps = arrays.some((a) => a.nalUnitType === NAL_TYPE_SPS && a.nalus.length > 0);
    if (!hasSps) return false;
    // Not gated on the hvc1-vs-hev1 sample-entry type: hev1 with no tail arrays
    // already exited above (arrays.length === 0), and a tail with valid
    // VPS/SPS/PPS is the same bug regardless of type (see the note above).
    return true;
}

interface NalArray {
    headerByte: number;
    nalUnitType: number;
    nalus: Uint8Array[];
}

/**
 * Parses NAL arrays starting at offset 23 in the hvcC payload. Returns null
 * if the structure is broken at any step (lengths overflow the payload, NAL
 * header byte does not match array.NAL_unit_type). This prevents false
 * positives on random padding that happens to start with 0x20.
 *
 * Per-array layout:
 *   1 byte: array_completeness (1 bit) + reserved (1 bit) + NAL_unit_type (6 bits)
 *   2 bytes BE: numNalus
 *   N times: 2 bytes nalUnitLength + nalUnitLength bytes NAL data
 */
function tryParseNalArraysAfterHeader(payload: Uint8Array): NalArray[] | null {
    let p = 23;
    const arrays: NalArray[] = [];
    // Cap array count to avoid looping on garbage; real hvcC has 3-4 arrays
    // (VPS+SPS+PPS, optionally SEI). 16 is deliberately generous.
    while (p < payload.length && arrays.length < 16) {
        if (p + 3 > payload.length) return null;
        const headerByte = payload[p]!;
        const nalUnitType = headerByte & 0x3f;
        const numNalus = (payload[p + 1]! << 8) | payload[p + 2]!;
        p += 3;
        // Accept only {VPS, SPS, PPS}. SEI (39, 40) and AUD (35) could appear
        // here too, but firmware does not write them into hvcC, and accepting
        // them widens the false-positive risk. Keep the filter narrow.
        if (nalUnitType !== NAL_TYPE_VPS && nalUnitType !== NAL_TYPE_SPS && nalUnitType !== NAL_TYPE_PPS) {
            return null;
        }
        if (numNalus === 0) return null; // empty array is suspicious
        const nalus: Uint8Array[] = [];
        for (let i = 0; i < numNalus; i++) {
            if (p + 2 > payload.length) return null;
            const len = (payload[p]! << 8) | payload[p + 1]!;
            p += 2;
            if (len === 0) return null;
            if (p + len > payload.length) return null;
            const nalu = payload.subarray(p, p + len);
            // Verify NAL header: first 2 bytes are
            // forbidden_zero_bit(1) + nal_unit_type(6) + layer_id(6) + tid+1(3).
            // nal_unit_type must match array.NAL_unit_type.
            if (nalu.length < 2) return null;
            const nalHeaderType = (nalu[0]! >> 1) & 0x3f;
            if (nalHeaderType !== nalUnitType) return null;
            nalus.push(nalu);
            p += len;
        }
        arrays.push({ headerByte, nalUnitType, nalus });
    }
    if (p !== payload.length) {
        // Unparsed bytes remain - the data is not a clean array sequence, just similar-looking garbage.
        return null;
    }
    return arrays;
}

/** Fields extracted from SPS needed to synthesize the hvcC header. */
interface SpsExtract {
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
}

/**
 * Parses SPS RBSP up to and including bit_depth_chroma_minus8, also
 * extracting profile_tier_level. Returns null if:
 *   - sps_max_sub_layers_minus1 > 0 (multi-temporal-layer; not seen on
 *     dashcams; supporting sub-layer profile_tier_level adds more bug surface
 *     than real cases it would cover);
 *   - sanity bounds: profile_idc / chroma_format_idc / bit_depth outside spec.
 *
 * Does not parse further than needed; we do not reconstruct VUI/sub_layer/etc.
 */
function parseSps(spsNalu: Uint8Array): SpsExtract | null {
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
        reader.ue(); // pic_width_in_luma_samples
        reader.ue(); // pic_height_in_luma_samples
        const conformanceWindow = reader.u(1);
        if (conformanceWindow) {
            reader.ue();
            reader.ue();
            reader.ue();
            reader.ue();
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
        };
    } catch {
        return null;
    }
}

/**
 * Reconstructs the hvcC payload: a new 23-byte header (all reserved bits = 1
 * as required by ISO/IEC 14496-15) + the original body bytes starting at
 * offset 23. The body already contains valid NAL arrays verified in
 * isBrokenHeader; they are not touched.
 *
 * Returns null if the SPS cannot be parsed or the arrays are invalid
 * (redundant check in case the caller invokes rebuildHvcC directly).
 */
function rebuildHvcC(payload: Uint8Array): Uint8Array | null {
    const arrays = tryParseNalArraysAfterHeader(payload);
    if (!arrays) return null;
    const spsArray = arrays.find((a) => a.nalUnitType === NAL_TYPE_SPS);
    if (!spsArray || spsArray.nalus.length === 0) return null;
    const spec = parseSps(spsArray.nalus[0]!);
    if (!spec) return null;

    const out = new Uint8Array(payload.length);
    // Body is already correct - copy payload as-is, then overwrite the header.
    out.set(payload);

    // Header (23 bytes) per ISO/IEC 14496-15 §8.3.3.1 + FFmpeg hvcc_write.
    // All reserved bits = '1' (via 0xfX masks).
    out[0] = 1; // configurationVersion
    out[1] = ((spec.profile_space & 0x3) << 6) | ((spec.tier_flag & 0x1) << 5) | (spec.profile_idc & 0x1f);
    // profile_compatibility_flags (32 bit BE)
    writeU32BE(out, 2, spec.profile_compatibility_flags >>> 0);
    // constraint_indicator_flags (48 bit BE)
    const c = spec.constraint_indicator_48;
    out[6] = Number((c >> 40n) & 0xffn);
    out[7] = Number((c >> 32n) & 0xffn);
    out[8] = Number((c >> 24n) & 0xffn);
    out[9] = Number((c >> 16n) & 0xffn);
    out[10] = Number((c >> 8n) & 0xffn);
    out[11] = Number(c & 0xffn);
    out[12] = spec.level_idc & 0xff;
    // 4 reserved '1' + 12 bit min_spatial_segmentation_idc=0
    out[13] = 0xf0;
    out[14] = 0x00;
    // 6 reserved '1' + 2 bit parallelismType=0
    out[15] = 0xfc;
    // 6 reserved '1' + 2 bit chromaFormat
    out[16] = 0xfc | (spec.chromaFormat & 0x3);
    // 5 reserved '1' + 3 bit bitDepthLumaMinus8
    out[17] = 0xf8 | (spec.bitDepthLumaMinus8 & 0x7);
    // 5 reserved '1' + 3 bit bitDepthChromaMinus8
    out[18] = 0xf8 | (spec.bitDepthChromaMinus8 & 0x7);
    // 16 bit avgFrameRate=0 (unspecified - valid per spec)
    out[19] = 0;
    out[20] = 0;
    // 2 bit constantFrameRate=0 + 3 bit numTemporalLayers + 1 bit temporalIdNested + 2 bit lengthSizeMinusOne=3
    out[21] =
        ((0 & 0x3) << 6) | ((spec.numTemporalLayers & 0x7) << 3) | ((spec.temporalIdNested & 0x1) << 2) | (3 & 0x3);
    // numOfArrays - actual count found in the payload
    out[22] = arrays.length & 0xff;

    return out;
}

// ====== bit utilities ======

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

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

// ====== exposed for tests ======

/**
 * Test wrapper: parses SPS RBSP and returns extracted fields. Used by
 * `repair/hvcc.test.ts`; production code only calls rebuildHvcC.
 */
export function _testParseSps(spsNalu: Uint8Array): SpsExtract | null {
    return parseSps(spsNalu);
}

/**
 * Test wrapper: rebuild header from a full hvcC payload. No file I/O so
 * tests stay unit-level.
 */
export function _testRebuildHvcC(payload: Uint8Array): Uint8Array | null {
    return rebuildHvcC(payload);
}

/** Test wrapper: "header is broken" heuristic. */
export function _testIsBrokenHeader(payload: Uint8Array): boolean {
    return isBrokenHeader(payload);
}

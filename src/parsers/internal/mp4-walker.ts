// Minimal ISOBMFF (MP4/MOV) walker - extends the box parser in indexer.ts.
// Needed because mediabunny has no public API for reading raw samples from
// non-AV tracks (subtitle, meta, text), but most dashcam formats store GPS
// exactly there:
//
//   - GoPro GPMF: handler=meta, format=gpmd, KLV data.
//   - Garmin Dash Cam (66W/Mini 2/Live): handler=sbtl/text, PNDM magic per sample.
//   - Garmin DriveAssist 51: top-level uuid atom in moov with a record array.
//   - Thinkware F-series: handler=sbtl, NMEA-RMC sentences via \0 delimiters.
//   - BlackVue DR750S+/DR900X+: handler=meta with custom GPS/G-sensor streams.
//   - Novatek-family: top-level `gps ` atom in moov + freeGPS payloads in free boxes.
//
// Two-phase API:
//   1. Offline (DataView over buffered region): findBox, iterBoxes,
//      readSampleTable, readHandlerType, readSampleFormat. Operate on an
//      already-loaded chunk - usually the first ~16 MB (moov section).
//   2. Online (File): loadHeader, loadSamples. Read specific byte ranges via
//      File.slice. Used when a plugin has resolved sample offsets and needs
//      to pull them from arbitrary positions.
//
// All of this is namespace-local (`internal/`), not exposed outside primitives -
// primitive tests verify behavior through the high-level Primitive API.

import type { VideoCodec } from "mediabunny";

import { readMp4BoxHeader } from "./mp4-box-header.js";

import { createLogger } from "../../log.js";

const loadSamplesLog = createLogger("load-samples");

export interface Box {
    type: string; // FourCC, 4 ASCII chars
    start: number; // absolute offset in DataView (including header)
    end: number; // exclusive end offset
    payloadStart: number; // first payload byte (after header)
}

/**
 * Sanity cap for sampleCount/entryCount in sample-table boxes. Guards against
 * allocating a billion-element array on a corrupt stts/stsz. Realistic dashcam
 * max: ~10 h @ 60 fps = 2.16 M, GPMF 18 Hz for 24 h = 1.5 M. 10 M has ample
 * headroom; anything above that indicates a corrupt header.
 */
const MAX_SAMPLE_TABLE_ENTRIES = 10_000_000;

export interface SampleEntry {
    /** Absolute file offset of the sample (chunk_offset + intra-chunk offset). */
    offset: number;
    /** Sample size in bytes. */
    size: number;
    /** 1-based sample index within the track (per spec convention). */
    index: number;
}

interface SttsMetadata {
    entryCount: number;
    arrayStart: number;
    totalSamples: number;
    totalTicks: number;
}

/**
 * Finds the first box with the given type inside [start, end) of the DataView.
 * Returns null if not found. Supports 32-bit and 64-bit (size==1 → largesize)
 * headers. size==0 means the box extends to end of region (last box in file).
 */
export function findBox(dv: DataView, start: number, end: number, type: string): Box | null {
    for (const box of iterBoxes(dv, start, end)) {
        if (box.type === type) return box;
    }
    return null;
}

/**
 * Generator over all top-level boxes in the given region. Use when multiple
 * boxes of the same type are expected (several trak inside moov) or to
 * enumerate structure for debugging.
 */
export function* iterBoxes(dv: DataView, start: number, end: number): Generator<Box> {
    let pos = start;
    while (pos + 8 <= end) {
        const box = readMp4BoxHeader(dv, pos, end - pos);
        if (box === null) return;
        const { type, size, headerSize } = box;
        yield { type, start: pos, end: pos + size, payloadStart: pos + headerSize };
        pos += size;
    }
}

/** Validates stts bounds/counts once and summarizes its run-length entries. */
function readSttsMetadata(dv: DataView, trak: Box): SttsMetadata | null {
    const stbl = walkPath(dv, trak, "mdia", "minf", "stbl");
    if (!stbl) return null;
    const stts = findBox(dv, stbl.payloadStart, stbl.end, "stts");
    if (!stts) return null;
    // FullBox version/flags (4) + entry_count (4).
    if (stts.payloadStart + 8 > stts.end) return null;
    const entryCount = dv.getUint32(stts.payloadStart + 4);
    const arrayStart = stts.payloadStart + 8;
    if (entryCount > MAX_SAMPLE_TABLE_ENTRIES) return null;
    if (arrayStart + entryCount * 8 > stts.end) return null;

    let totalSamples = 0;
    let totalTicks = 0;
    for (let i = 0; i < entryCount; i++) {
        const offset = arrayStart + i * 8;
        const sampleCount = dv.getUint32(offset);
        const sampleDelta = dv.getUint32(offset + 4);
        totalSamples += sampleCount;
        if (totalSamples > MAX_SAMPLE_TABLE_ENTRIES) return null;
        totalTicks += sampleCount * sampleDelta;
    }
    return { entryCount, arrayStart, totalSamples, totalTicks };
}

/**
 * Reads sample start times from stts.
 *
 * stts format:
 *   1 byte version + 3 bytes flags
 *   4 bytes entry_count (u32 BE)
 *   entries: [4 bytes sample_count, 4 bytes sample_delta] (BE)
 *
 * Returns one value per sample: start time in **media-timescale ticks**
 * (not divided by timescale - caller divides). Returns null if stts is
 * absent or corrupt.
 */
export function readSampleStartsInTicks(dv: DataView, trak: Box): number[] | null {
    const metadata = readSttsMetadata(dv, trak);
    if (!metadata) return null;

    const starts: number[] = [];
    starts.length = metadata.totalSamples;
    let writeIdx = 0;
    let cumulativeTicks = 0;
    for (let i = 0; i < metadata.entryCount; i++) {
        const off = metadata.arrayStart + i * 8;
        const sampleCount = dv.getUint32(off);
        const sampleDelta = dv.getUint32(off + 4);
        for (let j = 0; j < sampleCount; j++) {
            starts[writeIdx++] = cumulativeTicks;
            cumulativeTicks += sampleDelta;
        }
    }
    return starts;
}

/**
 * Reads per-sample durations in **media-timescale ticks** from stts. Unlike
 * readSampleStartsInTicks this returns deltas (sample_delta from the stts
 * entry), not cumulative offsets. Caller divides by mediaTimescale to get
 * seconds. Returns null if stts is absent or corrupt.
 */
export function readSampleDurationsInTicks(dv: DataView, trak: Box): number[] | null {
    const metadata = readSttsMetadata(dv, trak);
    if (!metadata) return null;

    const durations: number[] = [];
    durations.length = metadata.totalSamples;
    let writeIdx = 0;
    for (let i = 0; i < metadata.entryCount; i++) {
        const off = metadata.arrayStart + i * 8;
        const sampleCount = dv.getUint32(off);
        const sampleDelta = dv.getUint32(off + 4);
        for (let j = 0; j < sampleCount; j++) {
            durations[writeIdx++] = sampleDelta;
        }
    }
    return durations;
}

/**
 * Reads media timescale from mdhd - the denominator for stts sample times
 * and durations. Supports both mdhd versions.
 *
 * mdhd payload:
 *   1 byte version + 3 bytes flags
 *   v0: 4 creation + 4 modification + 4 timescale + 4 duration
 *   v1: 8 creation + 8 modification + 4 timescale + 8 duration
 */
export function readMediaTimescale(dv: DataView, trak: Box): number | null {
    const mdhd = walkPath(dv, trak, "mdia", "mdhd");
    if (!mdhd) return null;
    const version = dv.getUint8(mdhd.payloadStart);
    const fields = mdhd.payloadStart + 4;
    const tsOffset = version === 1 ? fields + 16 : fields + 8;
    if (tsOffset + 4 > mdhd.end) return null;
    return dv.getUint32(tsOffset);
}

/**
 * Walks a nested box path starting from root. Returns the first match or null.
 * Note: follows only the first child of each type - use iterBoxes if multiple
 * trak boxes need to be visited.
 */
function walkPath(dv: DataView, root: Box, ...types: string[]): Box | null {
    let current: Box | null = root;
    for (const t of types) {
        if (!current) return null;
        current = findBox(dv, current.payloadStart, current.end, t);
    }
    return current;
}

/**
 * Reads handler_type from trak/mdia/hdlr. Returns a 4-char code:
 * 'vide', 'soun', 'meta', 'subt', 'text', 'sbtl', 'data', etc.
 *
 * hdlr format:
 *   1 byte version + 3 bytes flags
 *   4 bytes pre_defined (0)
 *   4 bytes handler_type (FourCC)
 */
export function readHandlerType(dv: DataView, trak: Box): string | null {
    const hdlr = walkPath(dv, trak, "mdia", "hdlr");
    if (!hdlr) return null;
    // Skip version+flags (4) + pre_defined (4) = 8 bytes to handler_type.
    const offset = hdlr.payloadStart + 8;
    if (offset + 4 > hdlr.end) return null;
    return String.fromCharCode(
        dv.getUint8(offset),
        dv.getUint8(offset + 1),
        dv.getUint8(offset + 2),
        dv.getUint8(offset + 3),
    );
}

/**
 * Maps a video sample-entry FourCC ('avc1' / 'hvc1' / 'hev1' / ...) to the
 * mediabunny `VideoCodec` value used across the app. Returns null for
 * unrecognized FourCCs - caller treats as "unknown codec, decoder may still
 * try" (mediabunny's getCodec did the same before).
 *
 * Replaces the per-file mediabunny `getPrimaryVideoTrack().getCodec()` call
 * in the indexer: opening an Input + demux just to read a five-letter string
 * from stsd was 50-200 ms/file on long HEVC clips. FourCC → codec is a
 * pure-CPU table lookup.
 */
export function fourCCToVideoCodec(fourcc: string): VideoCodec | null {
    switch (fourcc) {
        case "avc1":
        case "avc3":
            return "avc";
        case "hvc1":
        case "hev1":
            return "hevc";
        case "vp09":
            return "vp9";
        case "av01":
            return "av1";
        case "vp08":
            return "vp8";
        default:
            return null;
    }
}

/**
 * Reads the tkhd display-matrix rotation, returns 0/90/180/270.
 *
 * tkhd payload layout (after box header):
 *   1 byte version + 3 bytes flags
 *   v0: 4 creation + 4 modification + 4 track_id + 4 reserved + 4 duration   (=20 before reserved/layer)
 *   v1: 8 creation + 8 modification + 4 track_id + 4 reserved + 8 duration   (=32)
 *   Then for both versions:
 *     8 reserved (u32 x2)
 *     2 layer + 2 alternate_group + 2 volume + 2 reserved   = 8
 *     36 bytes matrix (9 x i32 fixed-point: a, b, u, c, d, v, x, y, w)
 *
 * Only a, b, c, d are needed for rotation; u/v/w are perspective, x/y are translation.
 *
 * Standard rotation values in 16.16 fixed-point (0x00010000 = 1.0):
 *   0°:   a=+1 b= 0 c= 0 d=+1
 *   90°:  a= 0 b=+1 c=-1 d= 0
 *   180°: a=-1 b= 0 c= 0 d=-1
 *   270°: a= 0 b=-1 c=+1 d= 0
 *
 * Other transforms return 0 here. Native playback and stream-copy export
 * preserve the full matrix independently.
 */
export type Mp4Rotation = 0 | 90 | 180 | 270;

export function readTkhdRotation(dv: DataView, trak: Box): Mp4Rotation {
    const tkhd = findBox(dv, trak.payloadStart, trak.end, "tkhd");
    if (!tkhd) return 0;
    const version = dv.getUint8(tkhd.payloadStart);
    // version+flags(4) + (v0:20 / v1:32) + reserved(8) + layer/alt/vol/reserved(8) = matrix start
    const matrixOffset = tkhd.payloadStart + 4 + (version === 1 ? 32 : 20) + 8 + 8;
    if (matrixOffset + 36 > tkhd.end) return 0;
    // 16.16 fixed-point sign read. Treat as i32 to preserve sign.
    const a = dv.getInt32(matrixOffset);
    const b = dv.getInt32(matrixOffset + 4);
    const c = dv.getInt32(matrixOffset + 12);
    const d = dv.getInt32(matrixOffset + 16);
    const ONE = 0x00010000;
    if (a === ONE && b === 0 && c === 0 && d === ONE) return 0;
    if (a === 0 && b === ONE && c === -ONE && d === 0) return 90;
    if (a === -ONE && b === 0 && c === 0 && d === -ONE) return 180;
    if (a === 0 && b === -ONE && c === ONE && d === 0) return 270;
    return 0;
}

/**
 * Reads the coded frame size (width x height, in pixels) from the first video
 * sample entry in stsd. These are the encoded dimensions stored in the
 * VisualSampleEntry, not the tkhd display size (which can differ under a
 * non-identity display matrix / anamorphic PAR - rare on dashcams). For the
 * technical-details panel we want the real pixel size the stream carries.
 *
 * VisualSampleEntry layout from the sample-entry box start:
 *   8  box header (size + type)
 *   8  SampleEntry (6 reserved + 2 data_reference_index)
 *   16 pre_defined(2) + reserved(2) + pre_defined[3](12)
 *   -> width  (u16 BE) at +32
 *   -> height (u16 BE) at +34
 *
 * Caller must pass the video (handler "vide") trak so the first stsd entry is a
 * VisualSampleEntry. Returns null when stsd is missing/corrupt or the dims are 0.
 */
export function readVisualSampleDimensions(dv: DataView, trak: Box): { width: number; height: number } | null {
    const stsd = walkPath(dv, trak, "mdia", "minf", "stbl", "stsd");
    if (!stsd) return null;
    if (stsd.payloadStart + 8 > stsd.end) return null;
    const entryStart = stsd.payloadStart + 8;
    for (const entry of iterBoxes(dv, entryStart, stsd.end)) {
        if (entry.start + 36 > entry.end) continue;
        const width = dv.getUint16(entry.start + 32);
        const height = dv.getUint16(entry.start + 34);
        if (width > 0 && height > 0) return { width, height };
    }
    return null;
}

/**
 * Estimates the average frame rate of a video trak: sample count divided by
 * total media duration in seconds (= sampleCount * timescale / sumTicks). Robust
 * to a stray trailing sample and to VFR (returns the mean). Returns null when the
 * timescale or the stts table is missing/corrupt. Caller passes the "vide" trak.
 */
export function readVideoFrameRate(dv: DataView, trak: Box): number | null {
    const timescale = readMediaTimescale(dv, trak);
    if (!timescale || timescale <= 0) return null;
    const metadata = readSttsMetadata(dv, trak);
    if (
        !metadata ||
        metadata.totalSamples === 0 ||
        metadata.totalTicks <= 0 ||
        !Number.isSafeInteger(metadata.totalTicks)
    ) {
        return null;
    }
    return (metadata.totalSamples * timescale) / metadata.totalTicks;
}

/**
 * Finds the hvcC payload inside a video trak. Returns absolute payload start/end
 * offsets in `dv` plus the parent sample-entry type ('hvc1' or 'hev1').
 *
 * Used by the indexer to detect HEVC parameter sets needed for needsHevcRemux
 * detection - replaces mediabunny `getDecoderConfig().description` which used
 * to open a separate Input per file.
 *
 * Returns null if the trak is not HEVC, has no hvcC, or stsd is corrupt.
 */
export interface HvccLocation {
    payloadStart: number;
    payloadEnd: number;
    parent: "hvc1" | "hev1";
}

export function findHvccInTrak(dv: DataView, trak: Box): HvccLocation | null {
    const stsd = walkPath(dv, trak, "mdia", "minf", "stbl", "stsd");
    if (!stsd) return null;
    if (stsd.payloadStart + 8 > stsd.end) return null;
    const entryStart = stsd.payloadStart + 8;
    for (const entry of iterBoxes(dv, entryStart, stsd.end)) {
        if (entry.type !== "hvc1" && entry.type !== "hev1") continue;
        // VisualSampleEntry: 8 box header + 78 fixed prefix → child boxes.
        const childStart = entry.start + 8 + 78;
        if (childStart >= entry.end) continue;
        const hvcC = findBox(dv, childStart, entry.end, "hvcC");
        if (!hvcC) continue;
        return {
            payloadStart: hvcC.payloadStart,
            payloadEnd: hvcC.end,
            parent: entry.type,
        };
    }
    return null;
}

/**
 * Reverses the bit order of a 32-bit unsigned integer. HEVC's
 * general_profile_compatibility_flags sits MSB-first in the record, but the
 * RFC 6381 codec string encodes it in reverse bit order.
 */
function reverseBitsU32(value: number): number {
    let result = 0;
    for (let i = 0; i < 32; i++) {
        result = ((result << 1) | (value & 1)) >>> 0;
        value >>>= 1;
    }
    return result >>> 0;
}

/**
 * Builds the RFC 6381 codec string ("hev1.1.6.L150", "hev1.2.4.L153") from the
 * hvcC payload (HEVCDecoderConfigurationRecord, ISO/IEC 14496-15 8.3.3.1).
 *
 * Why: a config-aware canDecodeVideo needs the real profile_idc/tier/level to
 * tell Main from Main10 and to catch a too-high level. The bare "hevc" codec
 * enum makes mediabunny assume a generic Main profile, so a browser without
 * 10-bit HEVC decode is told (wrongly) that a Main10 clip is playable. We parse
 * the record here rather than open a mediabunny Input per MP4 - the indexer's
 * MP4 path is a direct moov walk with no Input. Always emits the "hev1." prefix
 * (as mediabunny does) whatever the hvc1/hev1 sample entry is; the profile/level
 * part is what drives decode support. Cross-checked against
 * mediabunny.getDecoderConfig().codec by a pin test on a real sample.
 *
 * Returns null when the record is shorter than the fixed 23-byte prefix.
 */
export function hevcCodecStringFromHvcc(description: Uint8Array): string | null {
    if (description.byteLength < 23) return null;
    const view = new DataView(description.buffer, description.byteOffset, description.byteLength);
    const profileByte = view.getUint8(1);
    const generalProfileSpace = (profileByte >> 6) & 0x03;
    const generalTierFlag = (profileByte >> 5) & 0x01;
    const generalProfileIdc = profileByte & 0x1f;
    const compatibilityFlags = reverseBitsU32(view.getUint32(2));
    const generalLevelIdc = view.getUint8(12);
    const constraintFlags: number[] = [];
    for (let i = 0; i < 6; i++) constraintFlags.push(view.getUint8(6 + i));

    let codecString = "hev1.";
    codecString += ["", "A", "B", "C"][generalProfileSpace]! + generalProfileIdc;
    codecString += `.${compatibilityFlags.toString(16).toUpperCase()}`;
    codecString += `.${generalTierFlag === 0 ? "L" : "H"}${generalLevelIdc}`;
    // Trailing all-zero constraint bytes are omitted in the canonical string.
    while (constraintFlags.length > 0 && constraintFlags[constraintFlags.length - 1] === 0) {
        constraintFlags.pop();
    }
    if (constraintFlags.length > 0) {
        codecString += `.${constraintFlags.map((x) => x.toString(16).toUpperCase()).join(".")}`;
    }
    return codecString;
}

/**
 * Reads the FourCC of the first sample entry from stsd - the codec/format
 * identifier, e.g. 'gpmd' for GoPro telemetry, 'tx3g' for Garmin subtitle
 * track, 'avc1'/'hvc1' for video.
 *
 * stsd format:
 *   1 byte version + 3 bytes flags
 *   4 bytes entry_count (u32)
 *   entries: [4 bytes size, 4 bytes format-FourCC, ...]
 */
export function readSampleFormat(dv: DataView, trak: Box): string | null {
    const stsd = walkPath(dv, trak, "mdia", "minf", "stbl", "stsd");
    if (!stsd) return null;
    // version+flags (4) + entry_count (4) = 8 bytes to the first entry.
    const entryStart = stsd.payloadStart + 8;
    // entry header: size (4) + format (4).
    if (entryStart + 8 > stsd.end) return null;
    return String.fromCharCode(
        dv.getUint8(entryStart + 4),
        dv.getUint8(entryStart + 5),
        dv.getUint8(entryStart + 6),
        dv.getUint8(entryStart + 7),
    );
}

/** Contiguous byte range of one chunk in the file. */
export interface ChunkRange {
    /** Absolute file offset of the chunk. */
    offset: number;
    /** Total byte length of the chunk (sum of its samples' sizes). */
    length: number;
}

/**
 * Reads a track's media data as per-chunk byte ranges (stco/co64 + stsc + stsz),
 * WITHOUT materialising one SampleEntry per sample. Concatenating the bytes of
 * every range, in order, reconstructs the track's raw media stream.
 *
 * This is the right reader for audio codecs the container declares with tiny
 * (e.g. 1-byte) samples - IMA ADPCM in a QuickTime `ms ` entry lists millions
 * of 1-byte samples whose real framing is by blockAlign, so a per-sample table
 * would allocate millions of objects for nothing. Per-chunk ranges stay O(chunks).
 *
 * Returns null if any required box is missing; best-effort on a truncated table.
 */
export function readChunkByteRanges(dv: DataView, trak: Box): ChunkRange[] | null {
    const layout = readSampleLayout(dv, trak);
    if (!layout) return null;
    const { sizes, chunks } = layout;

    const ranges: ChunkRange[] = [];
    for (const chunk of chunks) {
        let length: number;
        if (sizes.fixed !== null) {
            // Uniform sample size: the chunk length is a single multiply, NOT a
            // per-sample walk. This is the IMA-ADPCM case - millions of 1-byte
            // samples - so the whole reader stays O(chunks), not O(samples).
            length = chunk.sampleCount * sizes.fixed;
        } else {
            length = 0;
            for (let s = 0; s < chunk.sampleCount; s++) length += sizes.at(chunk.firstSample + s);
        }
        ranges.push({ offset: chunk.offset, length });
    }
    return ranges;
}

/** Block-layout parameters of an audio (soun) track's sample description. */
export interface SoundSampleParams {
    /** Sample-entry 4cc (e.g. "ms\0\x11" for WAVE 0x0011, "ima4", "mp4a"). */
    format: string;
    channels: number;
    sampleRate: number;
    /** Bytes per coded block (ADPCM blockAlign); 0 if not block-based. */
    blockAlign: number;
    /** PCM frames per block per channel; 0 if unknown. */
    samplesPerBlock: number;
}

/**
 * Reads an audio track's sample-description block parameters - the numbers an
 * IMA-ADPCM decoder needs (channels, sampleRate, blockAlign, samplesPerBlock).
 *
 * Prefers the embedded little-endian WAVEFORMATEX inside `wave/<format>` (which
 * states nBlockAlign + wSamplesPerBlock explicitly), falling back to the
 * QuickTime v1 sound-description extension (bytesPerFrame / samplesPerPacket).
 * Returns null if there is no stsd entry. Supports sound description v0/v1; v2
 * (rare on dashcams) yields blockAlign/samplesPerBlock = 0.
 */
export function readSoundSampleParams(dv: DataView, trak: Box): SoundSampleParams | null {
    const stsd = walkPath(dv, trak, "mdia", "minf", "stbl", "stsd");
    if (!stsd) return null;
    const entryStart = stsd.payloadStart + 8;
    if (entryStart + 36 > stsd.end) return null;
    const entrySize = dv.getUint32(entryStart);
    const entryEnd = Math.min(entryStart + entrySize, stsd.end);
    const format = String.fromCharCode(
        dv.getUint8(entryStart + 4),
        dv.getUint8(entryStart + 5),
        dv.getUint8(entryStart + 6),
        dv.getUint8(entryStart + 7),
    );
    const version = dv.getUint16(entryStart + 16);
    const channels = dv.getUint16(entryStart + 24);
    const sampleRate = dv.getUint32(entryStart + 32) >>> 16; // 16.16 fixed -> integer Hz
    // Child atoms (wave/extensions) start after the v0 (20B) or v1 (+16B) sound
    // description body, both measured from entryStart+16 (the version field).
    const childStart = entryStart + 16 + (version >= 1 ? 36 : 20);

    // Preferred: WAVEFORMATEX inside wave/<format> - explicit, little-endian.
    if (childStart < entryEnd) {
        const wave = findBox(dv, childStart, entryEnd, "wave");
        if (wave) {
            const wfx = findBox(dv, wave.payloadStart, wave.end, format);
            if (wfx && wfx.payloadStart + 18 <= wfx.end) {
                const p = wfx.payloadStart;
                const nChannels = dv.getUint16(p + 2, true);
                const nSamplesPerSec = dv.getUint32(p + 4, true);
                const nBlockAlign = dv.getUint16(p + 12, true);
                const cbSize = dv.getUint16(p + 16, true);
                const samplesPerBlock = cbSize >= 2 && p + 20 <= wfx.end ? dv.getUint16(p + 18, true) : 0;
                return {
                    format,
                    channels: nChannels || channels,
                    sampleRate: nSamplesPerSec || sampleRate,
                    blockAlign: nBlockAlign,
                    samplesPerBlock,
                };
            }
        }
    }

    // Fallback: QuickTime v1 sound description extension (big-endian).
    if (version >= 1 && entryStart + 48 <= stsd.end) {
        const samplesPerPacket = dv.getUint32(entryStart + 36);
        const bytesPerFrame = dv.getUint32(entryStart + 44);
        return { format, channels, sampleRate, blockAlign: bytesPerFrame, samplesPerBlock: samplesPerPacket };
    }

    return { format, channels, sampleRate, blockAlign: 0, samplesPerBlock: 0 };
}

// WAVE format-tag 0x0011 (IMA ADPCM) wrapped in a QuickTime `ms ` sample entry:
// the 4cc is "ms" + the 2-byte big-endian WAVE tag, i.e. bytes 6d 73 00 11. This
// is the only ADPCM form we decode (Mio/Navman MiVue). Kept here, in the
// mediabunny-free walker, so both the indexer (detection) and the transcode
// reader can share it without dragging mediabunny into the indexer worker.
export const IMA_ADPCM_SAMPLE_ENTRY: string = String.fromCharCode(0x6d, 0x73, 0x00, 0x11);

/** True for the IMA-ADPCM soun sample-entry 4cc the transcode reader can decode. */
export function isImaAdpcmSampleEntry(format: string): boolean {
    return format === IMA_ADPCM_SAMPLE_ENTRY;
}

/**
 * Reads the sample table for a track: stco/co64 (chunk offsets) + stsc
 * (sample-to-chunk) + stsz (sample sizes) → flat list of SampleEntry.
 *
 * Returns null if any required box is missing. Corrupt structures (entry_count
 * beyond payload, nonexistent chunk index) are handled best-effort: returns
 * whatever was collected before the first bad entry.
 *
 * Sample-to-chunk algorithm: stsc is a compressed table of
 * (first_chunk, samples_per_chunk, sdi). Each entry applies through
 * next.first_chunk - 1. The last entry applies through the final chunk in stco.
 */
export function readSampleTable(dv: DataView, trak: Box): SampleEntry[] | null {
    const layout = readSampleLayout(dv, trak);
    if (!layout) return null;

    const samples: SampleEntry[] = [];
    for (const chunk of layout.chunks) {
        let intraChunkOffset = 0;
        for (let s = 0; s < chunk.sampleCount; s++) {
            const sampleIndex = chunk.firstSample + s;
            const size = layout.sizes.at(sampleIndex);
            samples.push({
                offset: chunk.offset + intraChunkOffset,
                size,
                index: sampleIndex + 1,
            });
            intraChunkOffset += size;
        }
    }

    return samples;
}

/**
 * Resolves only the first sample of a track without materialising the complete
 * per-sample table. Empty leading chunks are skipped according to stsc; the
 * first non-empty chunk starts at its stco/co64 offset, so no preceding sample
 * sizes need to be summed. Returns null for an empty or corrupt table.
 */
export function readFirstSampleEntry(dv: DataView, trak: Box): SampleEntry | null {
    const layout = readSampleLayout(dv, trak);
    if (!layout) return null;

    for (const chunk of layout.chunks) {
        if (chunk.sampleCount > 0) return { offset: chunk.offset, size: layout.sizes.at(0), index: 1 };
    }
    return null;
}

interface SampleChunk {
    offset: number;
    firstSample: number;
    sampleCount: number;
}

interface SampleLayout {
    sizes: SampleSizes;
    chunks: Generator<SampleChunk>;
}

/** Validates the shared sample tables without expanding chunk offsets or samples. */
function readSampleLayout(dv: DataView, trak: Box): SampleLayout | null {
    const stbl = walkPath(dv, trak, "mdia", "minf", "stbl");
    if (!stbl) return null;
    const offsets = readChunkOffsetTable(dv, stbl);
    if (!offsets) return null;
    const stsc = readStsc(dv, stbl);
    if (!stsc) return null;
    const sizes = readSampleSizes(dv, stbl);
    return sizes ? { sizes, chunks: sampleChunks(dv, offsets, stsc, sizes.count) } : null;
}

/**
 * Walks compressed stsc runs once, clipping the last chunk to the available
 * samples. Zero-sample chunks retain their byte range but consume no sizes.
 * Lazy iteration lets the first-sample reader stop before expanding the track.
 */
function* sampleChunks(
    dv: DataView,
    offsets: ChunkOffsetTable,
    stsc: StscEntry[],
    totalSamples: number,
): Generator<SampleChunk> {
    let stscIndex = 0;
    let samplesPerChunk = 0;
    let firstSample = 0;
    for (let chunkIndex = 0; chunkIndex < offsets.count && firstSample < totalSamples; chunkIndex++) {
        while (stscIndex < stsc.length && stsc[stscIndex]!.firstChunk <= chunkIndex + 1) {
            samplesPerChunk = stsc[stscIndex++]!.samplesPerChunk;
        }
        const sampleCount = Math.min(samplesPerChunk, totalSamples - firstSample);
        yield { offset: chunkOffsetAt(dv, offsets, chunkIndex), firstSample, sampleCount };
        firstSample += sampleCount;
    }
}

interface ChunkOffsetTable {
    count: number;
    arrayStart: number;
    stride: 4 | 8;
}

/** Locates and validates stco/co64 without materialising its offsets. */
function readChunkOffsetTable(dv: DataView, stbl: Box): ChunkOffsetTable | null {
    // Preserve stco priority: a present-but-corrupt stco is an error rather
    // than an invitation to fall back to a second co64 table.
    const box = findBox(dv, stbl.payloadStart, stbl.end, "stco") ?? findBox(dv, stbl.payloadStart, stbl.end, "co64");
    if (!box || box.payloadStart + 8 > box.end) return null;
    const count = dv.getUint32(box.payloadStart + 4);
    const arrayStart = box.payloadStart + 8;
    const stride: 4 | 8 = box.type === "stco" ? 4 : 8;
    if (count > MAX_SAMPLE_TABLE_ENTRIES) return null;
    if (arrayStart + count * stride > box.end) return null;
    return { count, arrayStart, stride };
}

function chunkOffsetAt(dv: DataView, table: ChunkOffsetTable, index: number): number {
    const offset = table.arrayStart + index * table.stride;
    if (table.stride === 4) return dv.getUint32(offset);
    return dv.getUint32(offset) * 0x100000000 + dv.getUint32(offset + 4);
}

interface StscEntry {
    firstChunk: number; // 1-based per spec
    samplesPerChunk: number;
}

/** Reads stsc → array of (first_chunk, samples_per_chunk); sample_description_index is ignored. */
function readStsc(dv: DataView, stbl: Box): StscEntry[] | null {
    const stsc = findBox(dv, stbl.payloadStart, stbl.end, "stsc");
    if (!stsc) return null;
    if (stsc.payloadStart + 8 > stsc.end) return null;
    const entryCount = dv.getUint32(stsc.payloadStart + 4);
    const arrayStart = stsc.payloadStart + 8;
    if (entryCount > MAX_SAMPLE_TABLE_ENTRIES) return null;
    if (arrayStart + entryCount * 12 > stsc.end) return null;
    const out: StscEntry[] = [];
    for (let i = 0; i < entryCount; i++) {
        out.push({
            firstChunk: dv.getUint32(arrayStart + i * 12),
            samplesPerChunk: dv.getUint32(arrayStart + i * 12 + 4),
        });
    }
    return out;
}

interface SampleSizes {
    /** Total sample count declared in stsz. */
    count: number;
    /** Uniform per-sample size when stsz declares one (sample_size > 0 in the
     *  header), else null - lets callers skip the per-sample walk for a chunk. */
    fixed: number | null;
    /** Size at an in-bounds 0-based index supplied by sampleChunks. */
    at(sampleIdx0: number): number;
}

/**
 * Reads stsz → {count, fixed, at}. `fixed` is non-null when the header declares
 * a single uniform sample_size (common for constant-size codecs and the millions
 * of 1-byte IMA-ADPCM samples), which lets readChunkByteRanges compute a chunk
 * length by multiply instead of summing per sample.
 *
 * stz2 (compact size table) is rare in dashcam files; add when a real sample
 * appears.
 */
function readSampleSizes(dv: DataView, stbl: Box): SampleSizes | null {
    const stsz = findBox(dv, stbl.payloadStart, stbl.end, "stsz");
    if (!stsz) return null;
    if (stsz.payloadStart + 12 > stsz.end) return null;
    const sampleSize = dv.getUint32(stsz.payloadStart + 4);
    const sampleCount = dv.getUint32(stsz.payloadStart + 8);
    if (sampleCount > MAX_SAMPLE_TABLE_ENTRIES) return null;
    if (sampleSize > 0) {
        return { count: sampleCount, fixed: sampleSize, at: () => sampleSize };
    }
    const arrayStart = stsz.payloadStart + 12;
    if (arrayStart + sampleCount * 4 > stsz.end) return null;
    return {
        count: sampleCount,
        fixed: null,
        at: (idx) => dv.getUint32(arrayStart + idx * 4),
    };
}

// ====== mvhd helpers ======

// MP4 epoch (1904-01-01 UTC). mvhd creation_time/modification_time count seconds
// from this point. Unix epoch (1970-01-01) is 2082844800 seconds after it.
const MP4_EPOCH_OFFSET_SEC = 2082844800;

// Lower plausibility floor for creation_time, in the same 1904-epoch second
// count the field uses: 2000-01-01T00:00:00Z (unix 946684800). Below it the
// value is recorder garbage, not a real recording date - some firmware
// finalizes moov before the RTC syncs and stores a few seconds of boot-uptime
// (DDPAI Z50: ~64s past the 1904 epoch, decoding to 1970-01-01T00:01:04Z).
// Decoded as-is such a value shadows the good filename date in deriveStartUtc
// (the "mvhd as-is" branch outranks the filename) and poisons per-fingerprint
// TZ medians. Same 2000-01-01 floor the filename ymdhms and the garmin-uuid GPS
// reader already enforce; symmetric to the 0xFFFFFFFF (~2040) upper filter.
const MVHD_MIN_PLAUSIBLE_SEC = MP4_EPOCH_OFFSET_SEC + 946_684_800;

/**
 * Reads creation_time from mvhd. Supports both versions (v0 = 32-bit, v1 = 64-bit).
 * Returns null if moov/mvhd are not found, if creation_time == 0 (not set by
 * the recorder - returning 1904-01-01 to the UI would be wrong), if the field is
 * all-bits-set (power-loss/truncated firmware leftovers), or if it decodes to
 * before 2000-01-01 (near-epoch boot-uptime garbage - see MVHD_MIN_PLAUSIBLE_SEC).
 *
 * mvhd payload layout (after box header):
 *   1 byte version + 3 bytes flags
 *   v0: 4 creation + 4 modification + 4 timescale + 4 duration
 *   v1: 8 creation + 8 modification + 4 timescale + 8 duration
 */
export function readMvhdCreationTime(dv: DataView): Date | null {
    const moov = findBox(dv, 0, dv.byteLength, "moov");
    if (!moov) return null;
    const mvhd = findBox(dv, moov.payloadStart, moov.end, "mvhd");
    if (!mvhd) return null;

    const version = dv.getUint8(mvhd.payloadStart);
    // 1 byte version + 3 bytes flags = 4 bytes to the fields.
    const fields = mvhd.payloadStart + 4;

    // Unlike duration (where ISO 14496-12 defines all-bits-set as "unknown"),
    // the spec gives creation_time no sentinel - the all-ones check below is a
    // pragmatic garbage filter: 0xFFFFFFFF decodes to 2040-02-06, no real
    // camera writes that, and power-loss/unfinalized dashcam firmware does
    // leave all-ones behind (same sentinel set as viofosync durations.py
    // _MVHD_UNKNOWN). Without it the 2040 date poisons TZ estimation.
    let creationSec: number;
    if (version === 1) {
        // u64 big-endian. Number loses precision beyond 2^53, but that is ~285
        // million years from the 1904 epoch - fine in practice.
        if (fields + 8 > mvhd.end) return null;
        const high = dv.getUint32(fields);
        const low = dv.getUint32(fields + 4);
        // Compare the raw 32-bit words BEFORE combining: the all-ones u64 is
        // not representable as a double (rounds to 2^64, same as ...FFFE), so
        // a combined comparison would both lose precision and false-match.
        if (high === 0xffffffff && low === 0xffffffff) return null;
        creationSec = high * 0x100000000 + low;
    } else {
        if (fields + 4 > mvhd.end) return null;
        creationSec = dv.getUint32(fields);
        if (creationSec === 0xffffffff) return null;
    }

    if (creationSec === 0) return null;
    // Near-epoch garbage floor: a recorder that finalized moov before its RTC
    // synced stores boot-uptime here (DDPAI Z50 -> 1970). Below 2000-01-01 it is
    // not a real recording date; nulling it lets deriveStartUtc fall through to
    // the filename. See MVHD_MIN_PLAUSIBLE_SEC.
    if (creationSec < MVHD_MIN_PLAUSIBLE_SEC) return null;
    return new Date((creationSec - MP4_EPOCH_OFFSET_SEC) * 1000);
}

/**
 * Same as readMvhdCreationTime but returns Unix seconds directly - avoids
 * wrapping in a Date when the caller needs arithmetic.
 */
export function readMvhdCreationUnixSec(dv: DataView): number | null {
    const d = readMvhdCreationTime(dv);
    return d === null ? null : d.getTime() / 1000;
}

/**
 * Reads duration from mvhd in seconds (fractional number). Supports both
 * versions. Returns null if moov/mvhd not found, timescale/duration is corrupt,
 * duration == 0 (sentinel "not set", typical for fragmented MP4), or duration
 * is all-bits-set (ISO 14496-12 "unknown duration" sentinel - what power-loss
 * / unfinalized dashcam firmware leaves behind; decoded literally it reads as
 * ~49.7 days at timescale 1000 and poisons deriveStartUtc / trip durations).
 *
 * Used instead of mediabunny.getDurationFromMetadata in the indexer: dashcam
 * files have mvhd.duration set, so mediabunny would be a redundant I/O pass.
 *
 * mvhd payload (after box header):
 *   1 byte version + 3 bytes flags
 *   v0: 4 creation + 4 modification + 4 timescale + 4 duration
 *   v1: 8 creation + 8 modification + 4 timescale + 8 duration
 */
export function readMvhdDurationSec(dv: DataView): number | null {
    const moov = findBox(dv, 0, dv.byteLength, "moov");
    if (!moov) return null;
    const mvhd = findBox(dv, moov.payloadStart, moov.end, "mvhd");
    if (!mvhd) return null;

    const version = dv.getUint8(mvhd.payloadStart);
    const fields = mvhd.payloadStart + 4;

    let timescale: number;
    let durationTicks: number;
    if (version === 1) {
        // v1: skip 8+8 (creation+modification) → timescale (u32), duration (u64).
        const tsOffset = fields + 16;
        if (tsOffset + 4 + 8 > mvhd.end) return null;
        timescale = dv.getUint32(tsOffset);
        const high = dv.getUint32(tsOffset + 4);
        const low = dv.getUint32(tsOffset + 8);
        // ISO 14496-12 all-bits-set = "unknown duration". Compare the raw
        // 32-bit words BEFORE combining: the all-ones u64 is not representable
        // as a double (rounds to 2^64, same as ...FFFE), so a combined
        // comparison would both lose precision and false-match.
        if (high === 0xffffffff && low === 0xffffffff) return null;
        // u64 → number: safe up to 2^53. A 1-hour clip at timescale=600 = 2 160 000 ticks.
        durationTicks = high * 0x100000000 + low;
    } else {
        // v0: skip 4+4 (creation+modification) → timescale (u32), duration (u32).
        const tsOffset = fields + 8;
        if (tsOffset + 4 + 4 > mvhd.end) return null;
        timescale = dv.getUint32(tsOffset);
        durationTicks = dv.getUint32(tsOffset + 4);
        // ISO 14496-12 all-bits-set = "unknown duration" (v0 width).
        if (durationTicks === 0xffffffff) return null;
    }

    if (timescale === 0) return null;
    // Consequence of null (both the ==0 and the all-ones sentinel paths, made
    // deliberately identical): indexMp4FileWithMoov returns indexed:null and
    // ingest routes the file into state.unindexed ("N files could not be
    // indexed") - it does NOT reach the filename/mtime fallbacks of
    // deriveStartUtc. Acceptable: a sentinel duration implies an unfinalized
    // moov, most likely unplayable anyway.
    if (durationTicks === 0) return null;
    return durationTicks / timescale;
}

// ====== File-side API ======

/**
 * A moov box found in a file: absolute offsets and raw bytes in a fresh
 * owned buffer (byteOffset always 0). Box offsets from iterBoxes over this
 * DataView are relative to the start of moov, not to the file.
 */
export interface FoundMoov {
    /** Absolute offset of the moov box start (including the 8-byte header). */
    fileStart: number;
    /** Absolute offset of the moov box end (exclusive). */
    fileEnd: number;
    /** Raw moov bytes read from disk. */
    bytes: Uint8Array;
}

/**
 * Finds the moov box anywhere in the file by forward-walking top-level box
 * headers. Works for both moov-at-front and moov-at-end layouts.
 *
 * Reads only 16-byte headers and jumps by `pos += size`, so mdat (gigabytes
 * on long clips) is skipped without reading its payload - O(N_top_level) reads.
 * Typical MP4 needs 3-4 reads.
 *
 * Returns null if moov not found (corrupt file, non-ISOBMFF format).
 *
 * Why not `loadHeader(16MB) + findBox`: our own export puts moov after mdat
 * (hundreds of MB away), so a 16-MB window misses it. Starting iterBoxes
 * inside mdat also fails because the first 4 bytes are random mdat payload,
 * not a valid box size.
 */
export async function findMoovInFile(file: File): Promise<FoundMoov | null> {
    const HEADER_PROBE = 16; // enough for a 64-bit largesize header
    const fileSize = file.size;
    let pos = 0;

    while (pos + 8 <= fileSize) {
        const probeBytes = await file.slice(pos, Math.min(pos + HEADER_PROBE, fileSize)).arrayBuffer();
        const dv = new DataView(probeBytes);
        const box = readMp4BoxHeader(dv, 0, fileSize - pos);
        if (box === null) return null;
        const { type, size } = box;

        if (type === "moov") {
            const moovBuf = await file.slice(pos, pos + size).arrayBuffer();
            return {
                fileStart: pos,
                fileEnd: pos + size,
                bytes: new Uint8Array(moovBuf),
            };
        }

        pos += size;
    }
    return null;
}

/** Top-level box: type + absolute file offsets. No payload bytes. */
export interface TopLevelBox {
    type: string;
    /** Absolute file offset of the box header. */
    offset: number;
    /** Full box size including header. */
    size: number;
    /** Header length: 8 for a normal box, 16 for a 64-bit largesize box.
     *  Payload starts at offset + headerSize. */
    headerSize: 8 | 16;
}

/**
 * Enumerates all top-level boxes by reading only 16-byte headers.
 * Used to find tail atoms (Navitel `gps0`/`IDIT` after moov) where
 * findMoovInFile stops early.
 *
 * Stops at the first corrupt header (size < 8 or beyond fileSize) - everything
 * before that is valid. IO: O(N_top_level) × file.slice(16).
 */
export async function listTopLevelBoxes(file: File): Promise<TopLevelBox[]> {
    const HEADER_PROBE = 16;
    const fileSize = file.size;
    const out: TopLevelBox[] = [];
    let pos = 0;

    while (pos + 8 <= fileSize) {
        const probeBytes = await file.slice(pos, Math.min(pos + HEADER_PROBE, fileSize)).arrayBuffer();
        const dv = new DataView(probeBytes);
        const box = readMp4BoxHeader(dv, 0, fileSize - pos);
        if (box === null) break;
        const { type, size, headerSize } = box;
        // Non-printable types mark vendor trailers, including zero padding.
        // Keep this stricter gate out of the generic in-memory walker.
        if (!/^[\x20-\x7e]{4}$/.test(type)) break;
        out.push({ type, offset: pos, size, headerSize });
        pos += size;
    }
    return out;
}

/**
 * Loads a byte range from a file. Samples may be inside mdat, well beyond
 * the scanLimit; loadRange reads by absolute offset via File.slice.
 */
async function loadRange(file: File, offset: number, length: number): Promise<ArrayBuffer> {
    return await file.slice(offset, offset + length).arrayBuffer();
}

/**
 * Loads all track samples (or a subset). Adaptive: picks between
 *
 *  - random+coalesce (Promise.all over slice() calls, plus adjacency
 *    coalescing): wins on backends with low per-call cost (desktop NVMe
 *    ~0.1 ms/call). For 3600 samples that's ~60 ms total.
 *
 *  - sequential streaming via Blob.stream(): wins on backends with high
 *    per-call cost (mobile Android Chrome via SAF: 5-30 ms/call). One
 *    big slice + a stream reader replaces 3600 small slices. Pays
 *    "read the whole range" in bytes but eliminates per-call overhead.
 *
 * Strategy is picked by `pickLoadStrategy(samples, sliceCost)` and logged
 * for every dispatch so production reports tell us which path ran.
 *
 * sliceCost = measured ms per file.slice().arrayBuffer() call, captured by
 * buildMp4Index during the top-level box walk. Pass `index.sliceCost` when
 * available; pass 0 (default) to stick with random+coalesce (preserves the
 * previous behaviour for callers that don't have an Mp4Index in scope).
 *
 * Returns an ArrayBuffer per input sample. Each per-sample ArrayBuffer is
 * an independent copy.
 */
export async function loadSamples(file: File, samples: SampleEntry[], sliceCost = 0): Promise<ArrayBuffer[]> {
    if (samples.length === 0) return [];
    const strategy = pickLoadStrategy(samples, sliceCost);
    if (strategy === "stream") {
        return await loadSamplesStreamed(file, samples);
    }
    return await loadSamplesRandom(file, samples);
}

type LoadStrategy = "random" | "stream";

/**
 * Decision matrix for loadSamples. Three signals:
 *  - sampleCount: streaming has fixed per-dispatch overhead, only worth it
 *    above a threshold;
 *  - sliceCost: backends with high per-call cost (mobile SAF, slow SD)
 *    benefit massively from sequential streaming;
 *  - density: even on moderate-cost backends, sparse samples that span a
 *    large file range benefit from streaming - the random path would issue
 *    many uncoalesceable reads.
 *
 * Logged at info level - useful for diagnosing "why did this Carcam clip
 * take 18 s on phone but 600 ms on laptop". The log line includes every
 * number the decision used.
 */
/**
 * Per-slice latency (ms) above which a File backend counts as "slow" (mobile
 * SAF / slow SD), where sequential streaming beats random reads. Exported so the
 * progressive ingest storage probe gates on the same threshold
 * loadSamples uses here.
 */
export const SLICE_COST_STREAM_ABOVE = 5;

function pickLoadStrategy(samples: SampleEntry[], sliceCost: number): LoadStrategy {
    const n = samples.length;
    // Below this count the streaming setup (stream open + read loop) is
    // pure overhead. Picked empirically: 50 samples × 5 ms random per call
    // = 250 ms, comparable to streaming setup + small range read.
    const MIN_SAMPLES_FOR_STREAM = 50;
    // Below this slice cost the backend is fast enough that random reads
    // never dominate. 1 ms is the desktop SSD ceiling.
    const SLICE_COST_RANDOM_BELOW = 1;
    // SLICE_COST_STREAM_ABOVE is a module const (shared with the ingest probe):
    // above it the backend is slow enough that streaming wins regardless of
    // density. 5 ms is the mobile-SAF / slow-SD floor.
    // In the 1-5 ms zone we also consider sample density (avg bytes between
    // sample starts). >100 KB per sample = sparse = streaming worth it.
    const SPARSE_DENSITY_BYTES = 100_000;
    // But density alone is a trap for meta-track GPS (gpmd/sbtl/ligo): ~1 Hz
    // samples of a few hundred bytes are spread across the WHOLE mdat, so a
    // 1 GB clip looks "sparse" (density huge) yet streaming has to physically
    // read every gap byte (a stream can't seek) - ~1 GB read for ~1 MB of
    // samples. Only stream when the sample bytes are a meaningful fraction of
    // the spanned range; otherwise random+coalesce reads only what we need.
    // K=8: a handful of slack per useful byte still favors sequential IO on a
    // slow backend; beyond that the gap-read cost dominates.
    const SPAN_TO_BYTES_STREAM_RATIO = 8;

    if (n < MIN_SAMPLES_FOR_STREAM) {
        // Skip the log for tiny tracks - hot path on every Mp4Index build,
        // would flood the ring buffer (first-sample probes, single-frame
        // navitel reads, etc).
        return "random";
    }
    if (sliceCost > SLICE_COST_STREAM_ABOVE) {
        loadSamplesLog.info("pick: stream (slow backend)", {
            n,
            sliceCostMs: round1(sliceCost),
            threshold: SLICE_COST_STREAM_ABOVE,
        });
        return "stream";
    }
    if (sliceCost < SLICE_COST_RANDOM_BELOW) {
        loadSamplesLog.info("pick: random (fast backend)", {
            n,
            sliceCostMs: round1(sliceCost),
            threshold: SLICE_COST_RANDOM_BELOW,
        });
        return "random";
    }
    let minOff = samples[0]!.offset;
    let maxEnd = 0;
    let totalBytes = 0;
    for (const s of samples) {
        if (s.offset < minOff) minOff = s.offset;
        const end = s.offset + s.size;
        if (end > maxEnd) maxEnd = end;
        totalBytes += s.size;
    }
    const span = maxEnd - minOff;
    const density = span / n;
    // Stream only when both hold: samples are sparse enough that random issues
    // many uncoalesceable reads AND the span is not so huge relative to the
    // actual bytes that streaming would waste its time reading gaps.
    const proportionate = span <= SPAN_TO_BYTES_STREAM_RATIO * totalBytes;
    const choice: LoadStrategy = density > SPARSE_DENSITY_BYTES && proportionate ? "stream" : "random";
    loadSamplesLog.info(`pick: ${choice} (density tiebreaker)`, {
        n,
        sliceCostMs: round1(sliceCost),
        densityKb: Math.round(density / 1024),
        rangeMb: Math.round(span / (1024 * 1024)),
        sampleMb: Math.round(totalBytes / (1024 * 1024)),
        spanToBytesRatio: Math.round(span / Math.max(totalBytes, 1)),
        sparseThresholdKb: Math.round(SPARSE_DENSITY_BYTES / 1024),
    });
    return choice;
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

/**
 * Random IO with adjacency-coalescing. The original loadSamples
 * implementation, kept for fast backends where issuing many small slices
 * is cheap. Adjacency coalescing collapses back-to-back same-chunk samples
 * into a single read (typical for dense formats like inline GPMF).
 */
async function loadSamplesRandom(file: File, samples: SampleEntry[]): Promise<ArrayBuffer[]> {
    // Coalesce runs of contiguous samples (offset+size === next.offset).
    const groups: Array<{
        start: number;
        end: number;
        sampleIdxStart: number;
        sampleIdxEnd: number;
    }> = [];
    let runStart = samples[0]!.offset;
    let runEnd = samples[0]!.offset + samples[0]!.size;
    let runIdxStart = 0;
    for (let i = 1; i < samples.length; i++) {
        const s = samples[i]!;
        if (s.offset === runEnd) {
            runEnd += s.size;
        } else {
            groups.push({ start: runStart, end: runEnd, sampleIdxStart: runIdxStart, sampleIdxEnd: i });
            runStart = s.offset;
            runEnd = s.offset + s.size;
            runIdxStart = i;
        }
    }
    groups.push({ start: runStart, end: runEnd, sampleIdxStart: runIdxStart, sampleIdxEnd: samples.length });

    const groupBuffers = await Promise.all(groups.map((g) => loadRange(file, g.start, g.end - g.start)));

    const out = new Array<ArrayBuffer>(samples.length);
    for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi]!;
        const buf = groupBuffers[gi]!;
        if (g.sampleIdxEnd - g.sampleIdxStart === 1 && buf.byteLength === g.end - g.start) {
            out[g.sampleIdxStart] = buf;
            continue;
        }
        for (let si = g.sampleIdxStart; si < g.sampleIdxEnd; si++) {
            const s = samples[si]!;
            const off = s.offset - g.start;
            out[si] = buf.slice(off, off + s.size);
        }
    }
    return out;
}

/**
 * Sequential streaming reader: opens ONE Blob.stream() over the byte range
 * [min(sample.offset), max(sample.offset + sample.size)] and walks samples
 * in offset order, pulling chunks from the stream as needed.
 *
 * Why: on mobile Android Chrome, each file.slice().arrayBuffer() on a
 * SAF-backed File round-trips to ContentResolver and pays 5-30 ms IPC.
 * 3600 small reads = 18 s. Blob.stream() opens ONE InputStream on the
 * underlying FileDescriptor and subsequent chunk reads are buffered IO
 * (~0 SAF cost). On a 1 GB Carcam clip: ~2 s sequential UFS read vs 18 s
 * random.
 *
 * Memory bound: the rolling buffer is trimmed past each consumed sample
 * before pulling more from the stream, so peak buffer ≈ one stream chunk
 * + one target sample. For 64 KB stream chunks + 256 byte samples that's
 * ~64 KB regardless of total sample count.
 */
async function loadSamplesStreamed(file: File, samples: SampleEntry[]): Promise<ArrayBuffer[]> {
    // Sort by offset; remember original positions to map results back.
    const sorted = samples.map((s, idx) => ({ s, idx })).sort((a, b) => a.s.offset - b.s.offset);
    const firstOffset = sorted[0]!.s.offset;
    const lastEnd = sorted[sorted.length - 1]!.s.offset + sorted[sorted.length - 1]!.s.size;

    const t0 = performance.now();
    const stream = file.slice(firstOffset, lastEnd).stream();
    const reader = stream.getReader();

    const out = new Array<ArrayBuffer>(samples.length);

    // Rolling buffer of bytes pulled from the stream but not yet consumed.
    // Invariant: buf[0] corresponds to file offset bufStartOff. streamPos is
    // the next byte the reader will emit (so streamPos = bufStartOff +
    // buf.length when nothing has been trimmed beyond what the reader gave us).
    let buf = new Uint8Array(0);
    let bufStartOff = firstOffset;
    let streamPos = firstOffset;
    let streamEnded = false;
    let chunksPulled = 0;
    let bytesPulled = 0;

    const pull = async (): Promise<boolean> => {
        if (streamEnded) return false;
        const { value, done } = await reader.read();
        if (done) {
            streamEnded = true;
            return false;
        }
        if (!value || value.length === 0) return true; // empty chunk - skip
        streamPos += value.length;
        chunksPulled++;
        bytesPulled += value.length;
        if (buf.length === 0) {
            // Avoid copy when buf is empty - reuse the chunk as the new buffer.
            buf = value;
        } else {
            const grown = new Uint8Array(buf.length + value.length);
            grown.set(buf);
            grown.set(value, buf.length);
            buf = grown;
        }
        return true;
    };

    try {
        for (let i = 0; i < sorted.length; i++) {
            const t = sorted[i]!;
            const tEnd = t.s.offset + t.s.size;

            // Advance past bytes we no longer need.
            if (t.s.offset > bufStartOff) {
                const drop = t.s.offset - bufStartOff;
                if (drop < buf.length) {
                    // Keep the unread chunk by reference; only returned samples need copies.
                    buf = buf.subarray(drop);
                    bufStartOff = t.s.offset;
                } else {
                    // Target is past current buffer end - discard buffer and
                    // skip-read through the gap chunk by chunk. Stream cannot
                    // seek; we have to consume.
                    buf = new Uint8Array(0);
                    bufStartOff = streamPos;
                    while (bufStartOff < t.s.offset) {
                        if (!(await pull())) break;
                        // pull() may have just set buf; trim it forward if the
                        // chunk overshot the target offset.
                        if (bufStartOff + buf.length > t.s.offset) {
                            const overshoot = t.s.offset - bufStartOff;
                            if (overshoot > 0 && overshoot < buf.length) {
                                buf = buf.subarray(overshoot);
                                bufStartOff = t.s.offset;
                            }
                            break;
                        }
                        // Chunk fully consumed (still before target). Discard.
                        bufStartOff += buf.length;
                        buf = new Uint8Array(0);
                    }
                }
            }

            // Pull until we have the full sample bytes.
            while (bufStartOff + buf.length < tEnd) {
                if (!(await pull())) break;
            }

            const localOff = t.s.offset - bufStartOff;
            if (localOff >= 0 && localOff + t.s.size <= buf.length) {
                const ab = new ArrayBuffer(t.s.size);
                new Uint8Array(ab).set(buf.subarray(localOff, localOff + t.s.size));
                out[t.idx] = ab;
            } else {
                // Stream ended before we could read the full sample. Hand out
                // an empty ArrayBuffer so the contract (ArrayBuffer per sample)
                // holds; downstream extractors gate on byteLength.
                out[t.idx] = new ArrayBuffer(0);
            }
        }
    } finally {
        try {
            reader.releaseLock();
        } catch {
            /* ignore */
        }
        try {
            await stream.cancel();
        } catch {
            /* ignore */
        }
    }

    loadSamplesLog.info("stream done", {
        samples: samples.length,
        rangeMb: Math.round((lastEnd - firstOffset) / (1024 * 1024)),
        bytesPulledMb: Math.round(bytesPulled / (1024 * 1024)),
        chunksPulled,
        durationMs: Math.round(performance.now() - t0),
    });
    return out;
}

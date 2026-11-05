// Raw HEVC elementary streams (Annex-B bytes, no container) as virtual MP4s.
//
// Neither <video> nor mediabunny reads a bare .hevc stream. Rewriting it into a
// real MP4 would copy the whole recording, so instead we present a Blob that IS
// an MP4 but references the original bytes: a small ftyp+moov built from one
// scan of the stream, then, for every NAL unit, the 4-byte length the MP4 sample
// format needs followed by file.slice() of that NAL. Video bytes are never
// loaded into memory or copied; only the NAL index and the moov (tens of KB per
// minute of video) stay in RAM.
//
// The view is built on the first demux of a file (blob-source.ts demuxView) and
// cached per File in the current thread. Ingest only reads the head
// (probeRawHevcHead): scanning every recording at import time would read
// gigabytes.
//
// Decode order is taken as presentation order (no B-frames, no ctts box).
// openpilot, the only raw source ingest admits, encodes with b_frames = 0
// (openpilot/system/loggerd/loggerd.h).

import { box, fourCC, fullBox, identityMatrix, u16, u32 } from "./export/iso-write.js";
import { HEVC_NAL_PPS, HEVC_NAL_SPS, HEVC_NAL_VPS, buildHvcC, parseHevcSps } from "./hevc-parameter-sets.js";

// Bounded read size of the scan. The scan holds one chunk at a time.
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
// Start codes are preceded by a few zero bytes (Annex B allows any number).
const MAX_CARRY_ZEROS = 64;
// The parameter sets precede the first picture; a raw stream that has not
// reached one within this head is not a usable recording.
const HEAD_PROBE_BYTES = 256 * 1024;
// Sample entries carry a fixed 72 dpi resolution field (ISO/IEC 14496-12 12.1.3).
const DPI_72 = 0x00480000;

/** Codec description of a raw stream, read from its parameter sets. */
export interface RawHevcHead {
    /** HEVCDecoderConfigurationRecord built from the leading VPS/SPS/PPS. */
    hvcc: Uint8Array;
    width: number;
    height: number;
}

interface NalIndex {
    /** Absolute offset of each NAL header, just after its start code. */
    starts: number[];
    /** Exclusive end of each NAL, before the zero bytes of the next start code. */
    ends: number[];
    types: number[];
    /** first_slice_segment_in_pic_flag of VCL NAL units; false for the rest. */
    firstSlice: boolean[];
}

interface Sample {
    nals: number[];
    sync: boolean;
}

const viewCache = new WeakMap<Blob, Promise<Blob>>();

/**
 * Returns an MP4 Blob (hvc1, one video track, constant frame rate) whose
 * samples reference the raw stream's bytes. Cached per blob in this thread;
 * a failed build is not cached, so a later demux retries.
 *
 * Throws when the stream has no parseable SPS before its first picture or no
 * pictures at all.
 */
export function rawHevcMp4View(blob: Blob, frameRate: number): Promise<Blob> {
    const cached = viewCache.get(blob);
    if (cached) return cached;
    const built = buildRawHevcMp4View(blob, frameRate);
    viewCache.set(blob, built);
    built.catch(() => {
        if (viewCache.get(blob) === built) viewCache.delete(blob);
    });
    return built;
}

/**
 * Reads only the head of a raw stream and describes its codec. Returns null
 * when the head carries no parseable SPS before the first picture. Used by
 * ingest, which must not scan the whole file.
 */
export async function probeRawHevcHead(blob: Blob): Promise<RawHevcHead | null> {
    const index = await scanNalUnits(blob, Math.min(blob.size, HEAD_PROBE_BYTES), (type) => isVcl(type));
    return await readHead(blob, index);
}

async function buildRawHevcMp4View(blob: Blob, frameRate: number): Promise<Blob> {
    if (!Number.isInteger(frameRate) || frameRate <= 0) throw new Error(`unsupported raw hevc frame rate ${frameRate}`);
    const index = await scanNalUnits(blob, blob.size);
    const codec = await readHead(blob, index);
    if (!codec) throw new Error("raw hevc stream has no sequence parameter set before its first picture");
    const { samples, inBandParameterSets } = groupAccessUnits(index);
    if (samples.length === 0) throw new Error("raw hevc stream has no pictures");

    const sampleSizes = samples.map((sample) =>
        sample.nals.reduce((sum, nal) => sum + 4 + index.ends[nal]! - index.starts[nal]!, 0),
    );
    const mdatPayload = sampleSizes.reduce((sum, size) => sum + size, 0);
    // mediabunny reads 32-bit and 64-bit sizes alike; the large form is only
    // needed past 4 GiB, which no per-minute segment reaches.
    const mdatHeaderBytes = mdatPayload + 8 > 0xffffffff ? 16 : 8;
    const timescale = frameRate * 1000;
    const ftyp = box("ftyp", [fourCC("isom"), u32(512), fourCC("isom"), fourCC("iso2"), fourCC("mp41")]);
    const moovFor = (firstSampleOffset: number): Uint8Array => {
        const offsets: number[] = [];
        let offset = firstSampleOffset;
        for (const size of sampleSizes) {
            offsets.push(offset);
            offset += size;
        }
        return buildMoov({
            head: codec,
            sampleEntry: inBandParameterSets ? "hev1" : "hvc1",
            timescale,
            sampleDelta: 1000,
            sampleSizes,
            chunkOffsets: offsets,
            syncSamples: samples.flatMap((sample, i) => (sample.sync ? [i + 1] : [])),
        });
    };
    // The moov precedes the samples, so its size shifts their offsets. Offsets
    // only change its size by switching stco to the wider co64, which only
    // grows it; this settles within two rounds.
    let moov = moovFor(0);
    for (;;) {
        const next = moovFor(ftyp.byteLength + moov.byteLength + mdatHeaderBytes);
        const settled = next.byteLength === moov.byteLength;
        moov = next;
        if (settled) break;
    }

    const mdatHeader = new Uint8Array(mdatHeaderBytes);
    const headerView = new DataView(mdatHeader.buffer);
    if (mdatHeaderBytes === 16) {
        headerView.setUint32(0, 1);
        mdatHeader.set(fourCC("mdat"), 4);
        headerView.setBigUint64(8, BigInt(mdatPayload + 16));
    } else {
        headerView.setUint32(0, mdatPayload + 8);
        mdatHeader.set(fourCC("mdat"), 4);
    }

    const sampleNals = samples.flatMap((sample) => sample.nals);
    const lengths = new Uint8Array(sampleNals.length * 4);
    const lengthsView = new DataView(lengths.buffer);
    // One owned buffer for everything before the sample data.
    const head = new Uint8Array(ftyp.byteLength + moov.byteLength + mdatHeader.byteLength);
    head.set(ftyp, 0);
    head.set(moov, ftyp.byteLength);
    head.set(mdatHeader, ftyp.byteLength + moov.byteLength);
    const parts: BlobPart[] = [head];
    sampleNals.forEach((nal, i) => {
        lengthsView.setUint32(i * 4, index.ends[nal]! - index.starts[nal]!);
        parts.push(lengths.subarray(i * 4, i * 4 + 4), blob.slice(index.starts[nal]!, index.ends[nal]!));
    });
    return new Blob(parts, { type: "video/mp4" });
}

/** Scans Annex-B start codes over [0, limit) in bounded chunks. stopAt ends the
 *  scan right after the first NAL type it accepts; that NAL's end stays unknown. */
async function scanNalUnits(
    blob: Blob,
    limit: number,
    stopAt?: (type: number) => boolean,
    chunkBytes = SCAN_CHUNK_BYTES,
): Promise<NalIndex> {
    const index: NalIndex = { starts: [], ends: [], types: [], firstSlice: [] };
    let carry = new Uint8Array(0);
    let pos = 0;
    while (pos < limit) {
        const chunkEnd = Math.min(limit, pos + chunkBytes);
        const chunk = new Uint8Array(await blob.slice(pos, chunkEnd).arrayBuffer());
        const isLast = chunkEnd >= limit;
        let buf = chunk;
        if (carry.length > 0) {
            buf = new Uint8Array(carry.length + chunk.length);
            buf.set(carry, 0);
            buf.set(chunk, carry.length);
        }
        const base = pos - carry.length;
        // Carry the trailing zero run into the next chunk: it may open a start
        // code whose 0x01 comes next, and every zero before that 0x01 must
        // stay out of the previous NAL. The cap only matters for a corrupt
        // all-zero stretch, where the leftover zeros trail a NAL harmlessly.
        let resumeAt = buf.length;
        while (resumeAt > 0 && buf.length - resumeAt < MAX_CARRY_ZEROS && buf[resumeAt - 1] === 0) resumeAt--;
        let i = buf.indexOf(1, 2);
        while (i !== -1) {
            if (buf[i - 1] === 0 && buf[i - 2] === 0) {
                let zeros = i - 2;
                while (zeros > 0 && buf[zeros - 1] === 0) zeros--;
                // The NAL header (2 bytes) and the slice flag byte after it
                // must be in this buffer; otherwise rescan from the start code.
                if (i + 3 >= buf.length && !isLast) {
                    resumeAt = zeros;
                    break;
                }
                if (index.starts.length > index.ends.length) index.ends.push(base + zeros);
                if (i + 2 < buf.length) {
                    const type = (buf[i + 1]! >> 1) & 0x3f;
                    index.starts.push(base + i + 1);
                    index.types.push(type);
                    index.firstSlice.push(isVcl(type) && i + 3 < buf.length && buf[i + 3]! >> 7 === 1);
                    if (stopAt?.(type)) return index;
                }
            }
            i = buf.indexOf(1, i + 1);
        }
        carry = buf.slice(resumeAt);
        pos = chunkEnd;
    }
    if (index.starts.length > index.ends.length) index.ends.push(limit);
    return index;
}

function isVcl(type: number): boolean {
    return type < 32;
}

function isParameterSet(type: number): boolean {
    return type === HEVC_NAL_VPS || type === HEVC_NAL_SPS || type === HEVC_NAL_PPS;
}

/** NAL types that open a new access unit when they follow a picture's slices
 *  (H.265 7.4.2.4.4): AUD, VPS/SPS/PPS, prefix SEI, 41..44, 48..55. */
function opensAccessUnit(type: number): boolean {
    return (type >= 32 && type <= 35) || type === 39 || (type >= 41 && type <= 44) || (type >= 48 && type <= 55);
}

/** Leading parameter sets (before the first picture) into an hvcC. */
async function readHead(blob: Blob, index: NalIndex): Promise<RawHevcHead | null> {
    const arrays = new Map<number, Uint8Array[]>();
    for (let nal = 0; nal < index.types.length && !isVcl(index.types[nal]!); nal++) {
        const type = index.types[nal]!;
        if (!isParameterSet(type) || index.ends[nal] === undefined) continue;
        const bytes = new Uint8Array(await blob.slice(index.starts[nal]!, index.ends[nal]!).arrayBuffer());
        arrays.set(type, [...(arrays.get(type) ?? []), bytes]);
    }
    const hvcc = buildHvcC(
        [HEVC_NAL_VPS, HEVC_NAL_SPS, HEVC_NAL_PPS].map((type) => ({
            nalUnitType: type,
            nalus: arrays.get(type) ?? [],
        })),
    );
    const sps = arrays.get(HEVC_NAL_SPS)?.[0];
    const parsed = sps ? parseHevcSps(sps) : null;
    if (!hvcc || !parsed || parsed.width <= 0 || parsed.height <= 0) return null;
    return { hvcc, width: parsed.width, height: parsed.height };
}

/**
 * Groups NAL units into access units. Parameter sets before the first picture
 * live in the hvcC and are left out of the samples; any that repeat later stay
 * in-band, which the hev1 sample entry permits. Units after the last picture
 * that would open a new access unit are dropped: they describe no picture.
 */
function groupAccessUnits(index: NalIndex): { samples: Sample[]; inBandParameterSets: boolean } {
    const samples: Sample[] = [];
    let current: Sample | null = null;
    let currentHasPicture = false;
    let seenPicture = false;
    let inBandParameterSets = false;
    for (let nal = 0; nal < index.types.length; nal++) {
        const type = index.types[nal]!;
        if (!seenPicture && isParameterSet(type)) continue;
        if (seenPicture && isParameterSet(type)) inBandParameterSets = true;
        const vcl = isVcl(type);
        const opens = vcl ? index.firstSlice[nal]! : opensAccessUnit(type);
        if (!current || (opens && currentHasPicture)) {
            if (current && currentHasPicture) samples.push(current);
            current = { nals: [], sync: false };
            currentHasPicture = false;
        }
        current.nals.push(nal);
        if (vcl) {
            currentHasPicture = true;
            seenPicture = true;
            // IRAP pictures (BLA/IDR/CRA, types 16..23) are random access points.
            if (type >= 16 && type <= 23) current.sync = true;
        }
    }
    if (current && currentHasPicture) samples.push(current);
    return { samples, inBandParameterSets };
}

interface MoovSpec {
    head: RawHevcHead;
    sampleEntry: "hvc1" | "hev1";
    timescale: number;
    sampleDelta: number;
    sampleSizes: readonly number[];
    chunkOffsets: readonly number[];
    /** 1-based sync sample numbers. */
    syncSamples: readonly number[];
}

/** moov with one video track: one sample per chunk, constant sample delta. */
function buildMoov(spec: MoovSpec): Uint8Array {
    const { head, timescale, sampleDelta, sampleSizes, chunkOffsets, syncSamples } = spec;
    const count = sampleSizes.length;
    const duration = count * sampleDelta;
    const zeros = (n: number): Uint8Array => new Uint8Array(n);

    const mvhd = fullBox("mvhd", 0, 0, [
        u32(0), // creation_time: unknown, raw streams carry no clock
        u32(0), // modification_time
        u32(timescale),
        u32(duration),
        u32(0x00010000), // rate 1.0
        u16(0x0100), // volume 1.0
        zeros(10), // reserved
        identityMatrix(),
        zeros(24), // pre_defined
        u32(2), // next_track_ID
    ]);
    const tkhd = fullBox("tkhd", 0, 0x000003, [
        u32(0),
        u32(0),
        u32(1), // track_ID
        u32(0), // reserved
        u32(duration),
        zeros(8), // reserved
        u16(0), // layer
        u16(0), // alternate_group
        u16(0), // volume: video
        u16(0), // reserved
        identityMatrix(),
        u32(head.width * 0x10000),
        u32(head.height * 0x10000),
    ]);
    const mdhd = fullBox("mdhd", 0, 0, [u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0)]);
    const hdlr = fullBox("hdlr", 0, 0, [u32(0), fourCC("vide"), zeros(12), new TextEncoder().encode("VideoHandler\0")]);
    const vmhd = fullBox("vmhd", 0, 1, [u16(0), zeros(6)]);
    const dinf = box("dinf", fullBox("dref", 0, 0, [u32(1), fullBox("url ", 0, 1, [])]));

    const sampleEntry = box(spec.sampleEntry, [
        zeros(6), // reserved
        u16(1), // data_reference_index
        zeros(16), // pre_defined + reserved
        u16(head.width),
        u16(head.height),
        u32(DPI_72),
        u32(DPI_72),
        u32(0), // reserved
        u16(1), // frame_count
        zeros(32), // compressorname
        u16(0x0018), // depth
        u16(0xffff), // pre_defined = -1
        box("hvcC", head.hvcc),
    ]);
    const stsd = fullBox("stsd", 0, 0, [u32(1), sampleEntry]);
    const stts = fullBox("stts", 0, 0, [u32(1), u32(count), u32(sampleDelta)]);
    const stsc = fullBox("stsc", 0, 0, [u32(1), u32(1), u32(1), u32(1)]);
    const stsz = fullBox("stsz", 0, 0, [u32(0), u32(count), ...sampleSizes.map(u32)]);
    const needs64 = chunkOffsets.some((offset) => offset > 0xffffffff);
    const stco = needs64
        ? fullBox("co64", 0, 0, [u32(count), ...chunkOffsets.map(u64)])
        : fullBox("stco", 0, 0, [u32(count), ...chunkOffsets.map(u32)]);
    const tables = [stsd, stts];
    // Without stss every sample is a sync sample; emit it only when that is false.
    if (syncSamples.length < count) {
        tables.push(fullBox("stss", 0, 0, [u32(syncSamples.length), ...syncSamples.map(u32)]));
    }
    tables.push(stsc, stsz, stco);

    const stbl = box("stbl", tables);
    const minf = box("minf", [vmhd, dinf, stbl]);
    const mdia = box("mdia", [mdhd, hdlr, minf]);
    const trak = box("trak", [tkhd, mdia]);
    return box("moov", [mvhd, trak]);
}

function u64(value: number): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(value));
    return out;
}

/** Test hook: the NAL scan with a small chunk size, to put start codes on
 *  chunk boundaries. */
export function _testScanNalUnits(
    blob: Blob,
    chunkBytes: number,
): Promise<{ starts: number[]; ends: number[]; types: number[]; firstSlice: boolean[] }> {
    return scanNalUnits(blob, blob.size, undefined, chunkBytes);
}

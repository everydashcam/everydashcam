// Timelapse decode planning: decode only the GOPs that hold selected frames.
//
// A sped-up export keeps a fraction of the source frames, but a dense
// VideoSampleSink.samples() walk decodes every one of them. samplesAtTimestamps
// decodes from the key frame preceding each requested frame and skips GOPs
// without one. It also flushes the decoder whenever it jumps to a new key
// frame, which stalls hardware decoders, so it only pays off when the output
// step reaches the GOP length. The selection is computed from packet metadata
// and reproduces the dense loop exactly: the same frames, the same global
// frame numbering, the same decoded timestamps.
//
// Only ISO-BMFF sources qualify: their packet metadata is the in-memory sample
// table, while an MPEG-TS or Matroska metadata walk reads the payload anyway,
// which would double the IO of the very pass this is meant to shorten.

import {
    EncodedPacketSink,
    type Input,
    type InputVideoTrack,
    IsobmffInputFormat,
    type VideoSample,
    type VideoSampleSink,
} from "mediabunny";
import { throwIfCancelled } from "../abort-signals.js";

/** Per-tick lookahead tolerance of the split slot runtime (pipeline-split.ts):
 *  a frame starting within this much after the tick time is already shown. */
export const SPLIT_FRAME_LOOKAHEAD_SEC = 1e-6;

/** Pre-start frames more than this before the range start are dropped by the
 *  single-channel loop (pipeline.ts); closer ones count as in range
 *  (rounding drift). */
export const PRE_ROLL_TOLERANCE_SEC = 1e-3;

/** Packet metadata of the packets a dense decode of a range feeds. */
export interface DensePacketScan {
    /** Presentation timestamps (seconds) in decode order, starting at the key
     *  packet the dense decode starts from. */
    packetTimestamps: number[];
    /** Longest interval between consecutive key packets (seconds), the GOP
     *  length the sparse path has to beat. Null with fewer than two keys or
     *  when every packet is flagged as a key. */
    maxKeyIntervalSec: number | null;
    /** True when a packet follows its key packet in decode order but precedes
     *  it in presentation (open-GOP leading pictures). A sparse jump to such a
     *  key feeds them without the previous GOP they reference; mediabunny
     *  drops HEVC RASL pictures there, but an H.264 open GOP has no such
     *  guard, so these sources stay dense. */
    hasLeadingPictures: boolean;
}

/** One frame of a dense decode. */
export interface DenseFrame {
    /** Exact packet timestamp: a samplesAtTimestamps query for this value
     *  resolves to this very packet. */
    packetTimestamp: number;
    /** The decoded sample's timestamp (rounded to the track's time
     *  resolution), which every downstream computation uses. */
    sampleTimestamp: number;
}

/**
 * Frames VideoSampleSink.samples(startTimestamp, endTimestamp) yields, in
 * presentation order, given the scanned packet timestamps. Mirrors the pinned
 * mediabunny range logic: the last frame at or before the start is included
 * (it is what is on screen at the start), then every frame before the
 * exclusive end; a range holding no frame yields the last earlier one.
 * Decoded samples carry the sorted packet timestamps, rounded to the track's
 * time resolution, which is why sorting the decode-order list is enough even
 * with B-frames.
 */
export function denseRangeFrames(
    packetTimestamps: readonly number[],
    startTimestamp: number,
    endTimestamp: number,
    timeResolution: number,
): DenseFrame[] {
    const sorted = [...packetTimestamps].sort((a, b) => a - b);
    const frames: DenseFrame[] = [];
    let firstQueued = false;
    let lastBeforeStart: DenseFrame | null = null;
    for (const packetTimestamp of sorted) {
        const frame = {
            packetTimestamp,
            sampleTimestamp: Math.round(packetTimestamp * timeResolution) / timeResolution,
        };
        if (frame.sampleTimestamp >= endTimestamp) break;
        if (lastBeforeStart && frame.sampleTimestamp > startTimestamp) {
            frames.push(lastBeforeStart);
            firstQueued = true;
        }
        if (frame.sampleTimestamp >= startTimestamp) {
            frames.push(frame);
            firstQueued = true;
        }
        lastBeforeStart = firstQueued ? null : frame;
    }
    if (!firstQueued && lastBeforeStart) frames.push(lastBeforeStart);
    return frames;
}

/** Where one single-channel segment sits on the export's timelines. */
export interface TimelapseSegmentContext {
    /** Output-axis source seconds accumulated before this segment. */
    segBaseOutSec: number;
    /** The file's timestamp origin (media-time.ts). */
    timeOrigin: number;
    /** Range start inside the file, seconds from its origin. */
    startInFile: number;
    /** The loop's global in-range frame counter before this segment (-1 at
     *  the start of the export). */
    previousFrameIndex: number;
    speedFactor: number;
}

export interface TimelapseFrameSelection {
    /** Frames the single-channel loop keeps, ascending. */
    frames: DenseFrame[];
    /** Global in-range index of each kept frame. */
    frameIndices: number[];
    /** The global counter after the whole segment, as the dense loop leaves it. */
    lastFrameIndex: number;
}

/**
 * The frames the single-channel loop keeps from one segment: frames more
 * than the pre-roll tolerance before the range start are not counted, every
 * other frame advances the global counter, and every speedFactor-th count is
 * kept. Same arithmetic as the loop, so the choice is identical.
 */
export function selectTimelapseFrames(
    frames: readonly DenseFrame[],
    context: TimelapseSegmentContext,
): TimelapseFrameSelection {
    const selection: TimelapseFrameSelection = {
        frames: [],
        frameIndices: [],
        lastFrameIndex: context.previousFrameIndex,
    };
    for (const frame of frames) {
        const srcRelTs = context.segBaseOutSec + (frame.sampleTimestamp - context.timeOrigin - context.startInFile);
        if (srcRelTs < -PRE_ROLL_TOLERANCE_SEC) continue;
        selection.lastFrameIndex++;
        if (selection.lastFrameIndex % context.speedFactor !== 0) continue;
        selection.frames.push(frame);
        selection.frameIndices.push(selection.lastFrameIndex);
    }
    return selection;
}

/**
 * The frames one split slot shows while it stays on a segment: for each tick
 * (in source-file time) the last frame starting at or before it, plus the
 * segment's final frame when the slot then holds through a gap or past its
 * last file. Consecutive ticks on the same frame request it once. A sparse
 * iterator yielding exactly these frames leaves the slot runtime's
 * current/next walk with the same picture on every tick as a dense one.
 */
export function selectSplitSlotFrames(
    frames: readonly DenseFrame[],
    tickLocalTimes: readonly number[],
    holdsLastFrame: boolean,
): DenseFrame[] {
    const shown: DenseFrame[] = [];
    let next = 0;
    for (const localTime of tickLocalTimes) {
        while (next < frames.length && frames[next]!.sampleTimestamp <= localTime + SPLIT_FRAME_LOOKAHEAD_SEC) next++;
        const frame = frames[next - 1];
        if (frame && shown.at(-1) !== frame) shown.push(frame);
    }
    const last = frames.at(-1);
    if (holdsLastFrame && last && shown.at(-1) !== last) shown.push(last);
    return shown;
}

/** Mean source seconds between consecutive selected frames; null below two. */
export function selectedFrameSpacingSec(frames: readonly DenseFrame[]): number | null {
    if (frames.length < 2) return null;
    return (frames.at(-1)!.sampleTimestamp - frames[0]!.sampleTimestamp) / (frames.length - 1);
}

/**
 * Whether decoding only the selected frames' GOPs beats a dense walk: the
 * selected frames must be at least one GOP apart on average, so a decoder
 * flush per jump is paid for by at least a GOP of skipped decoding. Sources
 * without a measurable GOP, with open-GOP leading pictures, or with duplicate
 * timestamps (one query cannot address two frames) stay dense.
 */
export function shouldDecodeSparsely(selected: readonly DenseFrame[], scan: DensePacketScan): boolean {
    const spacingSec = selectedFrameSpacingSec(selected);
    if (spacingSec === null || scan.maxKeyIntervalSec === null || scan.hasLeadingPictures) return false;
    for (let i = 1; i < selected.length; i++) {
        if (selected[i]!.packetTimestamp <= selected[i - 1]!.packetTimestamp) return false;
    }
    return spacingSec >= scan.maxKeyIntervalSec;
}

/**
 * Reads the packet metadata a dense decode of [startTimestamp, endTimestamp)
 * would feed, without touching payloads. Starts at the same key packet as
 * VideoSampleSink.samples() and stops at the second key packet at or after
 * the end: leading pictures of a later key cannot precede the earlier one in
 * presentation, so no frame before the end lies beyond it. Returns null for
 * non-ISO-BMFF inputs (see the module comment). Throws AbortError on cancel.
 */
export async function scanDensePackets(
    input: Input,
    track: InputVideoTrack,
    startTimestamp: number,
    endTimestamp: number,
    signal: AbortSignal,
): Promise<DensePacketScan | null> {
    if (!((await input.getFormat()) instanceof IsobmffInputFormat)) return null;
    const sink = new EncodedPacketSink(track);
    const options = { metadataOnly: true };
    const startPacket = await sink.getPacket(startTimestamp, options);
    const keyPacket =
        (await sink.getKeyPacket(startPacket?.timestamp ?? startTimestamp, options)) ??
        (await sink.getFirstKeyPacket(options));
    const scan: DensePacketScan = { packetTimestamps: [], maxKeyIntervalSec: null, hasLeadingPictures: false };
    if (!keyPacket) return scan;
    let lastKeyTimestamp: number | null = null;
    let keysAtOrAfterEnd = 0;
    let sawDeltaPacket = false;
    for await (const packet of sink.packets(keyPacket, undefined, options)) {
        throwIfCancelled(signal);
        if (packet.type === "key") {
            if (packet.timestamp >= endTimestamp && ++keysAtOrAfterEnd === 2) break;
            if (lastKeyTimestamp !== null) {
                const intervalSec = packet.timestamp - lastKeyTimestamp;
                scan.maxKeyIntervalSec = Math.max(scan.maxKeyIntervalSec ?? intervalSec, intervalSec);
            }
            lastKeyTimestamp = packet.timestamp;
        } else {
            sawDeltaPacket = true;
            if (lastKeyTimestamp !== null && packet.timestamp < lastKeyTimestamp) scan.hasLeadingPictures = true;
        }
        scan.packetTimestamps.push(packet.timestamp);
    }
    // A sample table that flags every packet as a key (an absent stss box)
    // says nothing about the real GOP: the decode side verifies key frames
    // against the bitstream and would walk back to the true ones per request.
    if (!sawDeltaPacket) scan.maxKeyIntervalSec = null;
    return scan;
}

/** A sparse decode decision: the frames to decode and their mean spacing. */
export interface SparseDecodePlan {
    frames: DenseFrame[];
    /** Mean source seconds between the frames (DecodeProgress.sparseSpacingSec). */
    spacingSec: number;
}

/** A single-channel segment's sparse plan plus the loop's frame numbering. */
export interface SparseTimelapseSegmentPlan extends SparseDecodePlan {
    selection: TimelapseFrameSelection;
}

/**
 * Plans one single-channel timelapse segment: the frames the dense loop would
 * keep and whether decoding only those beats the dense walk. Null means
 * "decode densely" (not ISO-BMFF, GOP not measurable, kept frames closer than
 * a GOP). Throws AbortError on cancel; a metadata read failure propagates.
 */
export async function planSparseTimelapseSegment(
    input: Input,
    track: InputVideoTrack,
    startTimestamp: number,
    endTimestamp: number,
    context: TimelapseSegmentContext,
    signal: AbortSignal,
): Promise<SparseTimelapseSegmentPlan | null> {
    const scan = await scanDensePackets(input, track, startTimestamp, endTimestamp, signal);
    if (!scan) return null;
    const frames = denseRangeFrames(
        scan.packetTimestamps,
        startTimestamp,
        endTimestamp,
        await track.getTimeResolution(),
    );
    const selection = selectTimelapseFrames(frames, context);
    if (!shouldDecodeSparsely(selection.frames, scan)) return null;
    return { frames: selection.frames, spacingSec: selectedFrameSpacingSec(selection.frames)!, selection };
}

/**
 * Plans one split slot's stay on a segment (see selectSplitSlotFrames). Null
 * means "decode densely", under the same conditions as
 * planSparseTimelapseSegment.
 */
export async function planSparseSplitSlot(
    input: Input,
    track: InputVideoTrack,
    startTimestamp: number,
    endTimestamp: number,
    tickLocalTimes: readonly number[],
    holdsLastFrame: boolean,
    signal: AbortSignal,
): Promise<SparseDecodePlan | null> {
    const scan = await scanDensePackets(input, track, startTimestamp, endTimestamp, signal);
    if (!scan) return null;
    const frames = denseRangeFrames(
        scan.packetTimestamps,
        startTimestamp,
        endTimestamp,
        await track.getTimeResolution(),
    );
    const shown = selectSplitSlotFrames(frames, tickLocalTimes, holdsLastFrame);
    if (!shouldDecodeSparsely(shown, scan)) return null;
    return { frames: shown, spacingSec: selectedFrameSpacingSec(shown)! };
}

/**
 * Decodes exactly the given frames, in order, through samplesAtTimestamps.
 * A frame the sink cannot resolve is skipped rather than yielded as null, so
 * the result plugs into the same consumers as a dense samples() iterator.
 * Returning early closes the underlying iterator and its queued samples.
 */
export async function* decodeSelectedFrames(
    sink: VideoSampleSink,
    frames: readonly DenseFrame[],
): AsyncGenerator<VideoSample, void, unknown> {
    for await (const sample of sink.samplesAtTimestamps(frames.map((frame) => frame.packetTimestamp))) {
        if (sample) yield sample;
    }
}

// Injection of a gpmd metadata track into a finished MP4 (without re-encoding
// the mediabunny output).
//
// Context. Mediabunny does not support meta-tracks - its Output handles only
// video/audio/subtitle (with a fixed sample format 'wvtt' for the last one).
// To add GPMF telemetry (github.com/gopro/gpmf-parser), we post-process the
// already-finalized export:
//
//   1. Mediabunny streams a normal MP4 via FSA (moov-at-end: fastStart false)
//      and hands us the moov bytes + offset from its onMoov callback.
//   2. We truncate the output at moov.start and write a tail there: a new mdat
//      block with the GPMF sample payloads (densely packed, mdat header
//      [size:u32]['mdat']), then an augmented moov: original moov + our custom
//      gpmd-trak, with mvhd.next_track_ID incremented by 1.
//   3. Preferred: the tail goes into the STILL-OPEN output writable before it
//      is committed (injectGpmdTrackIntoOpen). Re-opening the committed file
//      with createWritable({keepExistingData}) instead makes Chromium copy the
//      whole file into the swap file first - a full extra read+write of a
//      multi-GB export, minutes on the removable media exports often target.
//      The re-open path (injectGpmdTrack) remains for callers that have no
//      captured moov and must walk the finished file.
//
// Trade-off: truncate vs append. Truncating the file at moov.start is cleaner
// (one moov in the file), but requires two FSA syscalls: writable.truncate() +
// sequential write of the tail. Append-only (just adding the new moov at the
// end) is simpler and works with most players (they scan to the last moov), but
// leaves a broken "dangling" old moov inside the file. We use truncate: one
// correct moov, byte-exact standard MP4.
//
// Performance. moov for a 1-hour 4K HEVC trip is ~2-3 MB - safe to read into
// memory. Writing the tail (samples + new moov) is also megabytes. We do not
// rewrite the main mdat (tens of GB for 4K) - mdat is not touched at all.

import { throwIfCancelled } from "../abort-signals.js";
import { findBox, findMoovInFile, type Box } from "../parsers/internal/mp4-walker.js";
import { ascii, box, concat, fourCC, fullBox, identityMatrix, u16, u32 } from "./iso-write.js";
import { type GpmfSample, packGpmfSamples } from "../parsers/internal/gpmf-pack.js";
import { createLogger } from "../log.js";
import { captureSentryException } from "../sentry.js";
import type { Trip } from "../trips.js";

const log = createLogger("export:gpmd");

/** moov box bytes plus its absolute file offset, as handed to us by mediabunny's
 *  onMoov callback during muxing. Lets the post-process locate moov without
 *  re-reading the finished file (a full getFile() copy on the in-memory handle). */
export interface CapturedMoov {
    /** Absolute offset of the moov box start in the output file (= where the
     *  injection truncates and appends). */
    startAbs: number;
    /** The full moov box bytes (including the 8-byte header). */
    bytes: Uint8Array;
}

/** The two operations the in-place injection needs from a still-open output
 *  writable. A FileSystemWritableFileStream (native or the in-memory mux
 *  writable) satisfies this as-is. */
export interface GpmdInjectionWritable {
    write(params: { type: "write"; position: number; data: Uint8Array<ArrayBuffer> }): Promise<void>;
    truncate(size: number): Promise<void>;
}

/**
 * Raised when the in-place injection failed AND putting the original moov back
 * failed too, so the still-open output is no longer a valid MP4. Callers must
 * discard the output (abort the writable) rather than commit it; `cause` is
 * the sink failure that broke the restore, for the export flow's error mapping.
 */
export class OutputDamagedError extends Error {
    constructor(cause: unknown) {
        super("gpmd injection left the output without a valid moov", { cause });
        this.name = "OutputDamagedError";
    }
}

/**
 * Packs the trip's GPS records for [startTripSec, endTripSec) into GPMF samples
 * and injects a gpmd track into the finished mp4. Single entry point shared by
 * the stream-copy (export.ts) and transcode (export-flow.ts) paths so the pack
 * args and error policy live in one place.
 *
 * With `writable` + `capturedMoov` the tail is written into the still-open
 * output before the caller commits it (no re-open, no swap-file copy of the
 * whole export); otherwise the committed file at `handle` is re-opened.
 *
 * Injection is purely additive on a valid mp4: on failure the clip stays intact
 * (just without telemetry), so non-abort errors are logged and swallowed and
 * the function returns false. Two failures propagate: AbortError (the caller's
 * outer handler owns cancellation) and OutputDamagedError (the in-place path
 * could not restore the moov; the output must be discarded). Returns true when
 * the gpmd track was written.
 */
export async function injectClipGpmf(args: {
    handle: FileSystemFileHandle;
    /** The output writable, still open: inject in place and let the caller
     *  commit. Requires capturedMoov; ignored without it. */
    writable?: GpmdInjectionWritable;
    trip: Pick<Trip, "records" | "timeline">;
    // Clip range on the trip's FOOTAGE (content) axis - the same axis the
    // stream-copy video track is built on (pauses removed). Keeping gpmd and
    // video on one axis is what guarantees they stay the same length and in sync.
    clipContentStartSec: number;
    clipContentEndSec: number;
    signal?: AbortSignal;
    // moov bytes + absolute offset captured from mediabunny's onMoov callback
    // during muxing (relayed from the worker on the re-encode path). Without it
    // the committed file is walked to locate moov - on the in-memory export
    // handle that is a full multi-GB getFile() snapshot.
    capturedMoov?: CapturedMoov;
}): Promise<boolean> {
    const { handle, writable, trip, clipContentStartSec, clipContentEndSec, signal, capturedMoov } = args;
    // Video's edit list hides its decoder preroll, so the requested footage
    // start is also the metadata track's zero. Preserve that edit list when
    // appending gpmd; GPSU carries the absolute UTC for external readers.
    let sampleCount = 0;
    try {
        signal?.throwIfAborted();
        const samples = packGpmfSamples(
            trip.records,
            trip.timeline,
            clipContentStartSec,
            clipContentEndSec - clipContentStartSec,
            { includeAccel: true },
        );
        sampleCount = samples.length;
        if (writable && capturedMoov) await injectGpmdTrackIntoOpen(writable, samples, signal, capturedMoov);
        else await injectGpmdTrack(handle, samples, signal, capturedMoov);
        return true;
    } catch (err) {
        if (err instanceof Error && (err.name === "AbortError" || err.name === "OutputDamagedError")) throw err;
        log.error("gpmd injection failed", err);
        // Swallowed (the clip is saved WITHOUT telemetry, user gets only a warn
        // toast) - so this never reaches the export funnel. But GPMF is a hard
        // product requirement (the whole RAM path exists to preserve it), so a
        // silent failure here is a real defect worth seeing.
        captureSentryException(err, {
            tags: { feature: "export", stage: "gpmd-inject" },
            extra: { sampleCount },
        });
        return false;
    }
}

/**
 * Timescale for the gpmd track. 1000 (millisecond) is precise enough for
 * second-grain GPS samples and fits within the 32-bit stts sample_delta even
 * for multi-hour clips.
 */
const GPMD_TIMESCALE = 1000;

/** The replacement tail for an output: truncate at `moovStartAbs` and write
 *  `tail` (new mdat + augmented moov) there. `originalMoov` is what stood at
 *  that offset, kept so a failed write can put the file back together. */
interface GpmdTail {
    moovStartAbs: number;
    originalMoov: Uint8Array;
    tail: Uint8Array;
    mdatBytes: number;
    moovBytes: number;
}

function throwIfAbortedSignal(signal: AbortSignal | undefined): void {
    throwIfCancelled(signal);
}

/**
 * Injects a gpmd track into an existing, committed MP4 file by re-opening it
 * (truncate + append). Prefer injectGpmdTrackIntoOpen while the output is
 * still open: this path makes Chromium copy the whole file into the swap file.
 *
 * @param handle  file handle (FSA or ponyfill). Must support getFile() and
 *                createWritable({keepExistingData: true}).
 * @param samples GPMF samples from packGpmfSamples (one sample per clip
 *                second, payload + duration).
 */
export async function injectGpmdTrack(
    handle: FileSystemFileHandle,
    samples: GpmfSample[],
    signal?: AbortSignal,
    capturedMoov?: CapturedMoov,
): Promise<void> {
    if (samples.length === 0) {
        log.warn("no GPMF samples - skipping injection");
        return;
    }
    const throwIfAborted = (): void => throwIfAbortedSignal(signal);
    throwIfAborted();
    const built = await buildGpmdTail(handle, samples, signal, capturedMoov);

    // Write. Open writable for read+write (keepExistingData), truncate to
    // moovStartAbs (discarding the old moov), then write the new mdat and
    // augmented moov. Truncate first so the file cannot have a dangling old
    // moov after our new one.
    // FSA contract: createWritable returns a buffered stream. Truncate/write
    // are staged in a swap file (Chrome) or staging area; the original file is
    // mutated atomically at close(). abort() drops all staged ops, so a throw
    // anywhere between createWritable and close leaves the original MP4 intact.
    // We keep close() inside try so that if it throws (e.g. disk full at flush
    // time), abort() still gets a chance to drop the swap.
    const writable = await handle.createWritable({ keepExistingData: true });
    let closed = false;
    try {
        throwIfAborted();
        await writable.truncate(built.moovStartAbs);
        // Last cancel-before-commit checkpoint. The truncate above already ran,
        // but the committed file is only mutated at writable.close(), so an abort
        // here still leaves the original mp4 intact.
        throwIfAborted();
        await writable.write({
            type: "write",
            position: built.moovStartAbs,
            data: built.tail as Uint8Array<ArrayBuffer>,
        });
        throwIfAborted();
        logInjected(built, "reopen");
        await writable.close();
        closed = true;
        throwIfAborted();
    } catch (err) {
        // Drop the swap. Without abort, FSA may still flush the buffered
        // truncate on GC and corrupt the file. Skip if close already ran.
        if (!closed) {
            try {
                await writable.abort(err instanceof Error ? err.message : String(err));
            } catch {
                /* ignore: writable may already be in a broken state */
            }
        }
        throw err;
    }
}

/**
 * Injects a gpmd track into the output while its writable is still open, so
 * the caller's commit (close) is the only disk flush: no re-open, no swap-file
 * copy of the whole export. The truncate and the tail write land in the same
 * swap file mediabunny streamed into.
 *
 * Unlike the re-open path there is no "abort drops the staged ops" safety net
 * - a truncate that is not followed by a tail would commit a moov-less file.
 * So a failed (or cancelled) tail write truncates back and puts the original
 * moov back before rethrowing: the caller then commits a valid MP4 without
 * telemetry. If even that restore fails the output is damaged and
 * OutputDamagedError tells the caller to discard it.
 */
export async function injectGpmdTrackIntoOpen(
    writable: GpmdInjectionWritable,
    samples: GpmfSample[],
    signal: AbortSignal | undefined,
    capturedMoov: CapturedMoov,
): Promise<void> {
    if (samples.length === 0) {
        log.warn("no GPMF samples - skipping injection");
        return;
    }
    throwIfAbortedSignal(signal);
    const built = await buildGpmdTail(null, samples, signal, capturedMoov);
    throwIfAbortedSignal(signal);
    await writable.truncate(built.moovStartAbs);
    try {
        throwIfAbortedSignal(signal);
        await writable.write({
            type: "write",
            position: built.moovStartAbs,
            data: built.tail as Uint8Array<ArrayBuffer>,
        });
    } catch (err) {
        // The failed write may have landed part of the tail past the end of the
        // original moov, so cut back to the truncate point before putting the
        // moov back - the restored file must end where the untouched one did.
        try {
            await writable.truncate(built.moovStartAbs);
            await writable.write({
                type: "write",
                position: built.moovStartAbs,
                data: built.originalMoov as Uint8Array<ArrayBuffer>,
            });
        } catch (restoreErr) {
            log.error("gpmd injection could not restore the original moov", restoreErr);
            throw new OutputDamagedError(restoreErr);
        }
        throw err;
    }
    logInjected(built, "open");
}

function logInjected(built: GpmdTail, mode: "open" | "reopen"): void {
    log.info("gpmd track injected", {
        mode,
        mdatBytes: built.mdatBytes,
        moovBytes: built.moovBytes,
        newFileSize: built.moovStartAbs + built.tail.byteLength,
        originalMoovEnd: built.moovStartAbs + built.originalMoov.byteLength,
    });
}

/**
 * Builds the replacement tail (new mdat + augmented moov) for the output.
 * `handle` is only consulted when `capturedMoov` is absent: the committed file
 * is then walked to locate moov, so the in-place path (no committed file yet)
 * must always supply the captured moov.
 */
async function buildGpmdTail(
    handle: FileSystemFileHandle | null,
    samples: GpmfSample[],
    signal: AbortSignal | undefined,
    capturedMoov: CapturedMoov | undefined,
): Promise<GpmdTail> {
    const throwIfAborted = (): void => throwIfAbortedSignal(signal);

    // Step 1. Locate the moov box. Prefer the bytes + offset captured from
    // mediabunny's onMoov callback during muxing - that avoids re-reading the
    // finished file, which on the in-memory export handle means a full multi-GB
    // getFile() snapshot just to walk a few box headers. Fall back to a forward
    // walk (re-encode path: muxed in a worker, no callback bytes on hand).
    // Mediabunny with fastStart:false places moov AFTER mdat; findMoovInFile
    // reads 16-byte headers and skips mdat without reading its payload.
    let moovStartAbs: number;
    let moovBytes: Uint8Array;
    if (capturedMoov) {
        moovStartAbs = capturedMoov.startAbs;
        moovBytes = capturedMoov.bytes;
    } else {
        if (!handle) throw new Error("in-place gpmd injection requires the captured moov");
        const file = await handle.getFile();
        const found = await findMoovInFile(file);
        if (!found) {
            throw new Error("moov box not found - injecting gpmd not supported");
        }
        moovStartAbs = found.fileStart;
        moovBytes = found.bytes;
    }
    throwIfAborted();

    log.info("found moov", {
        moovStart: moovStartAbs,
        moovSize: moovBytes.byteLength,
        source: capturedMoov ? "onMoov" : "walk",
        sampleCount: samples.length,
    });

    // Step 2. Extract mvhd from moov for (a) timescale - not used directly
    // (the gpmd track has its own timescale), but needed for tkhd duration in
    // movie-timescale; (b) current next_track_ID so our new trak gets the
    // correct id.
    const moovBoxLocal: Box = {
        type: "moov",
        start: 0,
        end: moovBytes.byteLength,
        payloadStart: 8,
    };
    const moovDv = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
    const mvhd = findBox(moovDv, moovBoxLocal.payloadStart, moovBoxLocal.end, "mvhd");
    if (!mvhd) throw new Error("mvhd not found inside moov");

    const movieTimescale = readMovieTimescale(moovDv, mvhd);
    const nextTrackId = readMvhdNextTrackId(moovDv, mvhd);

    // Step 3. Compute clip duration (seconds) - sum of sample durations.
    let clipDurationSec = 0;
    for (const s of samples) clipDurationSec += s.durationSec;

    // Step 4. Build the new mdat block with GPMF payloads.
    // Layout: [size:u32 BE]['mdat':4][payload1][payload2]...[payloadN]
    const sampleSizes: number[] = samples.map((s) => s.payload.byteLength);
    let mdatPayloadSize = 0;
    for (const sz of sampleSizes) mdatPayloadSize += sz;
    const mdatHeaderSize = 8;
    const mdatTotalSize = mdatHeaderSize + mdatPayloadSize;

    // Absolute offset of the new mdat = moovStartAbs (where we truncate).
    // Sample offset = mdat_start + 8 (after header) + cumulative sizes.
    const newMdatAbsStart = moovStartAbs;
    const firstSampleAbsOffset = newMdatAbsStart + mdatHeaderSize;

    // Step 5. Build the gpmd trak. Sample offsets must be absolute file offsets
    // (stco/co64 store offsets from the beginning of the FILE, not from moov).
    const gpmdTrak = buildGpmdTrak({
        trackId: nextTrackId,
        movieTimescale,
        gpmdTimescale: GPMD_TIMESCALE,
        clipDurationSec,
        sampleSizes,
        sampleDurationsTicks: samples.map((s) => Math.max(1, Math.round(s.durationSec * GPMD_TIMESCALE))),
        firstSampleAbsOffset,
        useCo64: firstSampleAbsOffset > 0xffffffff,
    });

    // Step 6. Build the augmented moov: copy the original moov, increment
    // next_track_ID in mvhd by 1, and append our trak at the end of
    // moov.children. Simplest path: do not deep-parse moov; patch
    // mvhd.next_track_ID in-place and reassemble the moov block manually:
    // header + old payload (with patched mvhd) + our trak.
    const augmentedMoov = buildAugmentedMoov(moovBytes, mvhd, gpmdTrak);

    // Step 7. Mdat header: size + 'mdat'.
    const mdatHeader = new Uint8Array(8);
    new DataView(mdatHeader.buffer).setUint32(0, mdatTotalSize, false);
    mdatHeader.set(fourCC("mdat"), 4);

    // The whole tail - mdat header + all sample payloads + augmented moov - as
    // ONE contiguous buffer for a SINGLE positional write at newMdatAbsStart.
    // The payloads are densely packed at sequential offsets, so the concat is
    // byte-identical to a per-sample write loop. The tail is only a few MB even
    // for a multi-hour clip (one small GPS sample per second; see the
    // file-header note), so holding it in RAM is cheap - and one write replaces
    // thousands of awaited write() calls (one per GPS second). On native FSA
    // the small writes were coalesced into the swap file anyway, so the saving
    // is call overhead, not disk I/O.
    const tail = concat([mdatHeader, ...samples.map((s) => s.payload), augmentedMoov]);
    return {
        moovStartAbs,
        originalMoov: moovBytes,
        tail,
        mdatBytes: mdatTotalSize,
        moovBytes: augmentedMoov.byteLength,
    };
}

// ===== Reading mvhd fields =====

/**
 * Reads timescale from mvhd. Supports both versions (v0 - 32-bit fields,
 * v1 - 64-bit creation/modification, rest same as v0).
 */
function readMovieTimescale(moovDv: DataView, mvhd: Box): number {
    const version = moovDv.getUint8(mvhd.payloadStart);
    const fields = mvhd.payloadStart + 4; // skip version+flags
    const tsOffset = version === 1 ? fields + 16 : fields + 8;
    return moovDv.getUint32(tsOffset);
}

/**
 * Reads next_track_ID from mvhd. It is the last field of the mvhd payload
 * (4-byte u32), at end - 4 (after matrix and pre_defined).
 */
function readMvhdNextTrackId(moovDv: DataView, mvhd: Box): number {
    const offset = mvhd.end - 4;
    return moovDv.getUint32(offset);
}

// ===== Construction of augmented moov =====

/**
 * Builds a new moov blob: copy of the original (with incremented next_track_ID
 * in mvhd) + the new gpmd trak at the end. The moov box header size is
 * recomputed for the new total.
 *
 * Note: moov exceeding uint32 (4 GB) would require the original moov to be
 * close to that size already, which is unrealistic. No 64-bit support needed.
 */
function buildAugmentedMoov(originalMoov: Uint8Array, mvhd: Box, gpmdTrak: Uint8Array): Uint8Array {
    // Single-copy build: out = [new 8-byte moov header][original payload][gpmd
    // trak]. Copy the original payload straight into out and patch next_track_ID
    // in place - no intermediate "patched"/"oldPayload" buffers (moov can be MBs,
    // and this runs once per stream-copy and once per re-encode export).
    const newSize = originalMoov.byteLength + gpmdTrak.byteLength;
    const out = new Uint8Array(newSize);
    const outView = new DataView(out.buffer);
    // moov box header: size (u32, big-endian) + "moov".
    outView.setUint32(0, newSize, false);
    out.set(fourCC("moov"), 4);
    // Original payload (everything after its own 8-byte header), copied once.
    out.set(originalMoov.subarray(8), 8);
    // Append the gpmd trak right after the original payload.
    out.set(gpmdTrak, originalMoov.byteLength);
    // Increment next_track_ID in mvhd, in place. moov starts at offset 0 in both
    // the source and out and the header stays 8 bytes, so the mvhd offset
    // (mvhd.end - 4, in moov-relative coords) is identical in out.
    const nextTrackIdOffset = mvhd.end - 4;
    outView.setUint32(nextTrackIdOffset, outView.getUint32(nextTrackIdOffset) + 1, false);
    return out;
}

// ===== Construction of gpmd trak =====

interface BuildGpmdTrakArgs {
    trackId: number;
    movieTimescale: number;
    gpmdTimescale: number;
    clipDurationSec: number;
    sampleSizes: number[];
    sampleDurationsTicks: number[];
    firstSampleAbsOffset: number;
    useCo64: boolean;
}

/**
 * Builds a complete trak box for the gpmd track with handler='meta' and
 * sample format='gpmd'. Structure (ISO/IEC 14496-12):
 *
 *   trak
 *     tkhd      track header (id, duration in movie-timescale, flags)
 *     mdia
 *       mdhd    media header (gpmd-timescale, total duration)
 *       hdlr    handler (handler_type='meta', name="GPMF")
 *       minf
 *         nmhd  null media header (for non-AV tracks)
 *         dinf
 *           dref
 *             url   self-reference
 *         stbl
 *           stsd  sample description (one entry with FourCC='gpmd')
 *           stts  sample time-to-sample (durations in gpmd-timescale)
 *           stsc  sample-to-chunk (all in one chunk)
 *           stsz  sample sizes (per-sample)
 *           stco  chunk offsets (one - our newMdatAbsStart + header)
 */
function buildGpmdTrak(args: BuildGpmdTrakArgs): Uint8Array {
    const trakChildren = concat([buildTkhd(args), buildMdia(args)]);
    return box("trak", trakChildren);
}

function buildTkhd(args: BuildGpmdTrakArgs): Uint8Array {
    // version=0 (32-bit fields). Flags=0x3 = track_enabled (0x1) + track_in_movie (0x2).
    // track_in_preview (0x4) is not needed for a metadata track.
    const durationInMovieTimescale = Math.max(1, Math.round(args.clipDurationSec * args.movieTimescale));
    return fullBox("tkhd", 0, 0x3, [
        u32(0), // creation_time
        u32(0), // modification_time
        u32(args.trackId), // track_ID
        u32(0), // reserved
        u32(durationInMovieTimescale),
        new Uint8Array(8), // reserved
        u16(0), // layer
        u16(0), // alternate_group
        u16(0), // volume (0 for non-audio tracks)
        u16(0), // reserved
        identityMatrix(),
        u32(0), // width (32-bit fixed-point - 0 for metadata track)
        u32(0), // height
    ]);
}

function buildMdia(args: BuildGpmdTrakArgs): Uint8Array {
    return box("mdia", concat([buildMdhd(args), buildHdlr(), buildMinf(args)]));
}

function buildMdhd(args: BuildGpmdTrakArgs): Uint8Array {
    const duration = Math.max(1, Math.round(args.clipDurationSec * args.gpmdTimescale));
    // version=0 (32-bit). Language='und' (0x55c4 = 21*32+30*32+04 actually:
    // each char minus 0x60, packed in 5 bits, 16-bit total). 'und' = 0x55c4.
    return fullBox("mdhd", 0, 0, [
        u32(0), // creation_time
        u32(0), // modification_time
        u32(args.gpmdTimescale),
        u32(duration),
        u16(0x55c4), // language = "und"
        u16(0), // pre_defined
    ]);
}

function buildHdlr(): Uint8Array {
    // pre_defined (0) + handler_type ('meta') + reserved×3 + name (nul-terminated).
    return fullBox("hdlr", 0, 0, [
        u32(0), // pre_defined
        fourCC("meta"),
        u32(0), // reserved
        u32(0), // reserved
        u32(0), // reserved
        ascii("GPMF", true),
    ]);
}

function buildMinf(args: BuildGpmdTrakArgs): Uint8Array {
    return box("minf", concat([buildNmhd(), buildDinf(), buildStbl(args)]));
}

function buildNmhd(): Uint8Array {
    return fullBox("nmhd", 0, 0, new Uint8Array(0));
}

function buildDinf(): Uint8Array {
    // dref with one url entry (self-reference, flags=0x1).
    const url = fullBox("url ", 0, 0x1, new Uint8Array(0));
    const dref = fullBox("dref", 0, 0, concat([u32(1), url]));
    return box("dinf", dref);
}

function buildStbl(args: BuildGpmdTrakArgs): Uint8Array {
    return box(
        "stbl",
        concat([
            buildStsdGpmd(),
            buildStts(args),
            buildStsc(args),
            buildStsz(args),
            args.useCo64 ? buildCo64(args) : buildStco(args),
        ]),
    );
}

function buildStsdGpmd(): Uint8Array {
    // SampleEntry for gpmd: 6 reserved bytes + u16 data_reference_index.
    // Standard SampleEntry box layout (ISO/IEC 14496-12 §8.5.2):
    //   [size:u32][type:'gpmd'][reserved×6:u8 = 0][data_reference_index:u16 = 1]
    // No additional config boxes inside - GPMF is self-describing KLV; the
    // player parses the stream without auxiliary configuration.
    const gpmdEntry = box(
        "gpmd",
        concat([
            new Uint8Array(6), // reserved
            u16(1), // data_reference_index
        ]),
    );
    return fullBox(
        "stsd",
        0,
        0,
        concat([
            u32(1), // entry_count
            gpmdEntry,
        ]),
    );
}

function buildStts(args: BuildGpmdTrakArgs): Uint8Array {
    // Group consecutive equal delta durations into one entry (sample_count,
    // sample_delta) for efficiency. Nearly all deltas equal the timescale;
    // the last one may be shorter.
    interface SttsEntry {
        count: number;
        delta: number;
    }
    const entries: SttsEntry[] = [];
    for (const dt of args.sampleDurationsTicks) {
        const last = entries[entries.length - 1];
        if (last && last.delta === dt) last.count++;
        else entries.push({ count: 1, delta: dt });
    }

    const payload: Uint8Array[] = [u32(entries.length)];
    for (const e of entries) {
        payload.push(u32(e.count), u32(e.delta));
    }
    return fullBox("stts", 0, 0, concat(payload));
}

function buildStsc(args: BuildGpmdTrakArgs): Uint8Array {
    // One entry: first chunk (1-based), all samples in it, sample_description_index=1.
    return fullBox(
        "stsc",
        0,
        0,
        concat([
            u32(1), // entry_count
            u32(1), // first_chunk
            u32(args.sampleSizes.length), // samples_per_chunk
            u32(1), // sample_description_index
        ]),
    );
}

function buildStsz(args: BuildGpmdTrakArgs): Uint8Array {
    // sample_size=0 means per-sample size table.
    const payload: Uint8Array[] = [
        u32(0), // sample_size = 0 (variable)
        u32(args.sampleSizes.length), // sample_count
    ];
    for (const sz of args.sampleSizes) payload.push(u32(sz));
    return fullBox("stsz", 0, 0, concat(payload));
}

function buildStco(args: BuildGpmdTrakArgs): Uint8Array {
    // One chunk - all samples packed densely in our mdat. Offset = first sample.
    return fullBox(
        "stco",
        0,
        0,
        concat([
            u32(1), // entry_count
            u32(args.firstSampleAbsOffset),
        ]),
    );
}

function buildCo64(args: BuildGpmdTrakArgs): Uint8Array {
    // 64-bit variant for files > 4 GB.
    const offsetU8 = new Uint8Array(8);
    const dv = new DataView(offsetU8.buffer);
    const hi = Math.floor(args.firstSampleAbsOffset / 0x100000000);
    const lo = args.firstSampleAbsOffset >>> 0;
    dv.setUint32(0, hi, false);
    dv.setUint32(4, lo, false);
    return fullBox("co64", 0, 0, concat([u32(1), offsetU8]));
}

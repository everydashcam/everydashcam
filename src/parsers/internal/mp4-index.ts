// Mp4Index - single pass over the moov section of a file, results shared by
// all plugins during classifyByContent and parseVideoEmbeddedGps. Eliminates
// repeated re-reads of the header (previously each plugin called loadHeader
// independently, and buildMp4Index itself read 16 MB up front).
//
// Adaptive header reads: by default we only load the moov box (typically
// 100 KB - 2 MB) plus the bytes of structural top-level boxes we recognise
// (free, gps0, IDIT). The 16 MB "probe window" used by `hasFreeGpsMarker` /
// `hasLigoGpsMarker` and the streaming free-GPS scan is loaded ON DEMAND
// when the caller asks via the `probeBytes` option. For most files
// (BlackVue X-series, GPMF, Navitel tail, PNDM, NMEA-sbtl, RVMI, Carcam
// LigoGPS-meta) the marker probe is never needed - their GPS lives either
// in moov (track/atom) or in a known structural offset. Saves 14-16 MB of
// IO per such file - dominant cost on mobile SD/UFS.
//
// Contents:
//   - moov box + its DataView (always);
//   - parsed tracks with handler-type and sample-format (gpmd / sbtl / text /
//     meta - foundation for GPMF/PNDM/Thinkware/LigoGPS);
//   - top-level free box (BlackVue X-series), loaded only when present;
//   - top-level/nested `gps ` atom inside moov (Novatek structural path);
//   - presence flags for "freeGPS " and "LIGOGPSINFO" literals - populated
//     ONLY after probeMarkers() is called; undefined means "not probed".
//   - lazy first-sample cache for sbtl/text/meta tracks.
//   - first few freeGPS hit offsets - seeds for predicted-offset jump scan.
//   - ALL top-level udta atoms + payload heads (Kenwood / LigoJSON / GKU
//     carriers), last-top-level-box-end (Kenwood CCCC-trailer probe anchor),
//     and the frea/'ver ' KodakVersion (Rexing affine-deobfuscation gate).
//
// Lifecycle: one Mp4Index per file, built once by the dispatcher via
// buildMp4Index(file, opts), then passed to plugins. probeMarkers() can be
// called after construction when the dispatcher decides marker scans are
// worthwhile (typically for Novatek family files where streaming scan may
// be needed).

import type { VendorFile } from "../types.js";
import {
    findBox,
    iterBoxes,
    listTopLevelBoxes,
    type Box,
    loadSamples,
    readFirstSampleEntry,
    readHandlerType,
    readMvhdCreationTime,
    readMvhdDurationSec,
    readSampleFormat,
    readSampleTable,
} from "./mp4-walker.js";
import { findFreeGpsOffsets } from "./freegps.js";
import { findLigoGpsChunkOffset } from "./ligogps.js";
import { createLogger } from "../../log.js";
import { findTsGpsTrailer, type TsGpsTrailer } from "../../ts-trailer.js";
import { isTransportStreamName } from "../../video-format-names.js";

const log = createLogger("mp4-index");

/** Track descriptor with pre-extracted handler and sample format. */
export interface TrackInfo {
    /** The trak box (used to read the sample table). */
    trakBox: Box;
    /** 'vide' | 'soun' | 'meta' | 'sbtl' | 'text' | 'data' | ... */
    handlerType: string | null;
    /** 'gpmd' | 'tx3g' | 'avc1' | 'hvc1' | 'mp4a' | ... */
    sampleFormat: string | null;
}

/** Single-pass index of the moov region. */
export interface Mp4Index {
    /**
     * Header probe bytes - the first N bytes of the file, where N is the
     * `probeBytes` value passed to buildMp4Index() (or set later via
     * probeMarkers()). null when no probe has been requested; in that case
     * `hasFreeGpsMarker` / `hasLigoGpsMarker` are undefined, and callers that
     * need them must call probeMarkers() to populate.
     *
     * The view covers `[0, headerBytes.byteLength)` of the file - useful for
     * downstream byte-level scans (streaming free-GPS predicted-offset seeds).
     */
    headerBytes: Uint8Array | null;
    headerView: DataView | null;
    fileSize: number;

    /**
     * Duration from mvhd in seconds (fractional). null if mvhd is absent,
     * corrupt, or duration=0 (fragmented MP4 without mvhd.duration).
     */
    durationSec: number | null;

    /**
     * creation_time from mvhd as a UTC Date. null if mvhd is absent, corrupt,
     * or creation_time=0 (recorder did not set the time).
     */
    createdUtc: Date | null;

    /** moov box if found, null otherwise. Offsets are relative to moovView. */
    moov: Box | null;

    /**
     * DataView over the loaded moov bytes. moov.start = 0 always; the view
     * is a standalone buffer (not aliased to any other view). null if moov
     * was not found in the file.
     */
    moovView: DataView | null;

    /** All trak boxes with handler-type and sample-format. Empty if moov is null. */
    tracks: TrackInfo[];

    /** Top-level free box (BlackVue X-series writes GPS inside it). Offsets relative to freeBoxView. */
    topLevelFreeBox: Box | null;

    /**
     * DataView over the loaded `free` box payload, when one was found at the
     * top level. null if no free box present. freeGpsBoxInsideFree offsets
     * are relative to this view.
     */
    freeBoxView: DataView | null;

    /**
     * Nested `gps ` box inside the top-level free box (BlackVue X-series).
     * null if the free box is absent or does not contain `gps `. Offsets are
     * relative to freeBoxView.
     */
    freeGpsBoxInsideFree: Box | null;

    /**
     * Nested `3gf ` box inside the top-level free box - the accelerometer
     * sibling of `gps `, written by BlackVue models that ship no `.3gf`
     * sidecar file. Same byte layout as that sidecar. null when absent.
     * Offsets are relative to freeBoxView.
     */
    free3gfBoxInsideFree: Box | null;

    /**
     * `gps ` atom inside moov (Novatek structural path). null if absent.
     * Searched recursively to depth 3 (matching novatek.ts findGpsAtom).
     * Offsets relative to moovView.
     */
    novatekGpsAtom: Box | null;

    /**
     * "freeGPS " literal present in the probe window. undefined = not probed
     * yet (no probeBytes requested at build time). true/false = probed.
     */
    hasFreeGpsMarker: boolean | undefined;

    /** "LIGOGPSINFO" literal present in the probe window. Same convention. */
    hasLigoGpsMarker: boolean | undefined;

    /**
     * Absolute file offsets of the first few `freeGPS ` hits within the probe
     * window. Used by the predicted-offset jump scan to seed the median-Δ
     * estimate without re-scanning the same bytes from scratch. Empty when
     * the marker is absent or no probe was requested.
     */
    freeGpsSeedOffsets: number[];

    /**
     * Top-level `gps0` atom (Navitel R-series and compatible Ambarella-tail
     * firmware). Absolute file offsets. null if absent.
     */
    navitelGps0Atom: { offset: number; size: number } | null;

    /**
     * Top-level `IDIT` atom alongside `gps0` (Navitel/Ambarella - contains the
     * ASCIIZ local recording-start date). null if absent.
     */
    navitelIditAtom: { offset: number; size: number } | null;

    /**
     * Top-level `gsen` atom alongside `gps0` - the g-sensor stream of the same
     * Ambarella-tail family (3-byte records). null if absent.
     */
    navitelGsenAtom: { offset: number; size: number } | null;

    /**
     * Top-level `GPS ` box (uppercase 4cc) holding direct 36-byte GPS records -
     * the older 70mai Pro generation (gps-box-70mai primitive). Distinct from
     * the lowercase `gps ` Novatek index atom (novatekGpsAtom) and from the
     * newer 70mai freeGPS-block layout. Absolute file offsets; null if absent.
     */
    maiGpsBox: { offset: number; size: number } | null;

    /**
     * Top-level `udat` atom - a plain-ASCII GPS log, NOT to be confused with
     * the `udta` user-data atom one letter away. ExifTool registers it on
     * %QuickTime::Main (QuickTime.pm:900, v13.55) and feeds it to ProcessGPSLog,
     * which tries NMEA (written by Datakam Player software) and then the Denver
     * bracketed dialect. Absolute file offsets; payload = offset + headerSize.
     * null if absent.
     *
     * `head` is the first TEXT_LOG_HEAD_BYTES of the payload, for the same
     * reason the udta atoms carry one: the sync dispatch gate must tell a GPS
     * log from unrelated user data WITHOUT IO. Presence of the atom is not
     * enough, because that gate also decides the freeGPS probe can be skipped -
     * a file with an unrelated udat would then take the whole no-winner retry
     * lap before its freeGPS blocks are found.
     */
    topLevelUdatAtom: { offset: number; size: number; headerSize: number; head: Uint8Array | null } | null;

    /**
     * Top-level `gdat` atom - one Base64 blob decoding to a JSON GPS track,
     * written by Nextbase software (QuickTime.pm:945-951 + Process_gdat,
     * v13.55). Same head-read rationale as `udat` above.
     */
    topLevelGdatAtom: { offset: number; size: number; headerSize: number; head: Uint8Array | null } | null;

    /**
     * Top-level `nbmt` atom (Nextbase). Upstream routes it to its generic
     * plain-text GPS parsing (Process_nbmt -> Process_text,
     * QuickTimeStream.pl:2835-2856, v13.55) and documents nothing about the
     * content, so it is treated as the same kind of text log as `udat`.
     */
    topLevelNbmtAtom: { offset: number; size: number; headerSize: number; head: Uint8Array | null } | null;

    /**
     * ALL top-level `udta` atoms (siblings of moov/mdat, NOT moov/udta), in
     * file order. Several dashcam formats carry GPS in a file-level udta,
     * often in trailer position after mdat: Kenwood VIDEOUUU records, Yada
     * RoadCam 'LIGOGPSINFO {json}', GKU __V35AX_QVDATA__ (ExifTool registers
     * all three on the %QuickTime::Main udta entry, QuickTime.pm:826-847,
     * v13.59, and tests EVERY file-level udta in its sequential walk - a
     * generic udta written before the GPS one must not hide the carrier, so
     * we capture all of them, not just the first). Absolute file offsets;
     * payload = offset + headerSize.
     *
     * `head` is the first bytes of the payload (up to UDTA_HEAD_BYTES = 32 -
     * enough for the longest sync literal, Kenwood's 27-char VIDEOUUU run).
     * The udta usually sits after mdat, far outside the headerBytes probe
     * window, so primitives cannot marker-check it without this dedicated
     * head read (32 bytes per atom - negligible). null when the read failed
     * or the atom has no payload. Empty array when no top-level udta exists.
     */
    topLevelUdtaAtoms: Array<{ offset: number; size: number; headerSize: number; head: Uint8Array | null }>;

    /**
     * Absolute end offset of the LAST valid top-level box - i.e. where
     * trailing non-ISOBMFF junk begins (the walk stops at the first corrupt
     * header). Equals fileSize when the box structure covers the whole file.
     * Used by the Kenwood primitive to probe for the CCCC/GPSDATA trailer,
     * which ExifTool finds exactly where a box header read returns the bogus
     * 'CCCCCCCC' size+type (QuickTime.pm:10179-10184, v13.59). null when the
     * top-level walk failed entirely.
     */
    lastTopLevelBoxEnd: number | null;

    /**
     * First bytes of the region past the last top-level box, when the file has
     * one. Read eagerly (16 bytes) so the synchronous embedded-GPS kind gate
     * can recognize a trailing non-ISOBMFF carrier - Auto-Vox's RIFF chunks -
     * without doing IO of its own. null when there is no trailing region.
     */
    trailerHead: Uint8Array | null;

    /**
     * GPS trailer appended past the last whole TS packet of a .ts recording
     * (src/ts-trailer.ts). Detected eagerly with two tiny reads, only
     * for transport-stream filenames - so the synchronous embedded-GPS kind
     * gate sees this carrier without IO of its own. null for every other
     * container and for TS files with no trailer.
     */
    tsGpsTrailer: TsGpsTrailer | null;

    /**
     * KodakVersion string from the top-level `frea` atom's 'ver ' child
     * (Kodak PixPro lineage firmware, reused by Rexing V1-4K). ExifTool
     * stores it to gate the Rexing affine GPS deobfuscation
     * (Kodak.pm:2987 + QuickTimeStream.pl:2316-2330, v13.59). Trailing
     * NULs/whitespace trimmed. null when no frea/'ver ' exists.
     */
    kodakVersion: string | null;

    /**
     * Lazy first-sample cache for subtitle/text/meta tracks. Key = trakBox.start.
     */
    firstSampleCache: Map<number, Uint8Array | null>;

    /**
     * Measured per-call cost of `file.slice().arrayBuffer()` in milliseconds,
     * averaged over the top-level box walk we do anyway in step 1 of
     * buildMp4Index. Used by `loadSamples` to pick between random-IO and
     * sequential-streaming strategies (mobile SAF backends pay 5-30 ms per
     * call, desktop NVMe pays ~0.1 ms).
     *
     * 0 = not measured (e.g. unit tests with synthetic Mp4Index). Callers
     * default to random IO when sliceCost is 0.
     */
    sliceCost: number;
}

/**
 * Default probe window for marker scans. 4 MB catches the first `freeGPS `
 * block on every Novatek-family sample we have (blocks are interleaved at
 * 1 Hz and the first one is in the opening 1-2 MB on every clip we have
 * measured). Also covers `LIGOGPSINFO` for Juscar TS and Carcam meta.
 *
 * 16 MB (the previous unconditional load) only helps when:
 *  - moov is very large (rare on dashcam files);
 *  - the first marker is unusually deep (no real samples observed).
 *
 * Callers that want more (predicted-offset jump scan benefits from 4-6 seed
 * offsets) pass a larger probeBytes explicitly.
 */
export const DEFAULT_PROBE_BYTES = 4 << 20;

/** Max practical probe limit - matches the previous SCAN_PROBE_LIMIT in freegps.ts. */
export const MAX_PROBE_BYTES = 16 << 20;

/**
 * Head-read window for the top-level udta payload. 32 bytes covers every
 * sync literal matched against it: Kenwood 'VIDEO'+22x'U' (27 bytes,
 * QuickTime.pm:827-833), GKU u32+pad+'__V35AX_QVDATA__' (24 bytes, :841-847),
 * LigoJSON 'LIGOGPSINFO {' (13 bytes, :834-840). All v13.59.
 */
export const UDTA_HEAD_BYTES = 32;

/**
 * Head-read window for the top-level text-log payloads (`udat`, `nbmt`). The
 * marker here is a shape, not a literal, and it need not sit on the FIRST line:
 * a receiver dump opens with whatever sentence the firmware emits first (a
 * single clock-prefixed GGA already runs ~88 bytes), and the Denver dialect can
 * be preceded by a header line. Sized for a couple of such lines so the gate
 * does not turn a mux detail into a dropped file. Cost is one bounded slice per
 * carrier atom, and only for files that have one.
 */
const TEXT_LOG_HEAD_BYTES = 256;

/**
 * Head-read window for the top-level `gdat` payload. Narrower than the text-log
 * one on purpose: the whole atom is Base64, so the gate wants just enough
 * characters for its alphabet check to mean something - a wider window would
 * start eating the atom's NUL padding on a short track.
 */
const GDAT_HEAD_BYTES = 64;

/** Bytes read from the start of a trailing region: enough for a RIFF chunk
 *  header plus the record magic behind it. */
const TRAILER_HEAD_BYTES = 16;

/** Options for buildMp4Index. */
export interface BuildMp4IndexOptions {
    /**
     * Bytes from the start of the file to probe for `freeGPS ` / `LIGOGPSINFO`
     * markers. 0 = skip marker scan entirely (the index will have
     * hasFreeGpsMarker/hasLigoGpsMarker = undefined). Default
     * DEFAULT_PROBE_BYTES = 4 MB.
     *
     * Callers can pass a larger value when they know they will need
     * jump-scan seeds (Novatek streaming-heavy) or 0 when source-hint
     * declares no embedded GPS expected (log-sidecar / basename-sidecar /
     * none) to save IO entirely.
     */
    probeBytes?: number;
    /**
     * Caller-provided moov bytes (the full moov box including the 8-byte
     * header). When supplied, skips the file.slice that loads moov in step 2.
     * Used by the ingest pipeline: the indexer worker already read these
     * bytes for the indexAllMp4Files pass, and re-reading them here on cold
     * SD adds 100 KB - 2 MB of duplicate IO per file.
     *
     * The bytes must include the 8-byte box header (size + 'moov') - same
     * format that findMoovInFile() returns.
     *
     * Unrelated to step 1 (top-level box walk) - we still do that small set
     * of 16-byte reads to discover free/gps0/IDIT atoms and measure sliceCost.
     */
    prebuiltMoov?: Uint8Array;
}

/**
 * Builds an Mp4Index from the file:
 *  1. Forward-walks top-level boxes (single 16-byte slices, 3-5 reads).
 *  2. Loads moov bytes (~100 KB - 2 MB typical).
 *  3. Parses moov: tracks (handler+format), mvhd duration/creation_time,
 *     novatek `gps ` atom.
 *  4. Loads free-box payload if present (BlackVue X-series), finds nested
 *     `gps ` box.
 *  5. Records gps0/IDIT tail atoms (Navitel) by offset+size only - their
 *     payloads are read by the extractor when it runs.
 *  6. Optionally probes the first probeBytes for `freeGPS ` / `LIGOGPSINFO`
 *     markers - controlled by opts.probeBytes.
 */
export async function buildMp4Index(file: File, opts: BuildMp4IndexOptions = {}): Promise<Mp4Index> {
    const fileSize = file.size;
    const probeBytes = opts.probeBytes ?? DEFAULT_PROBE_BYTES;

    // Step 1: forward-walk all top-level boxes. Time it - the avg per-call
    // cost is reused later by loadSamples to pick between random/streaming.
    // listTopLevelBoxes makes one file.slice(16-byte header) per top-level
    // box, which is exactly the cost shape we care about for sample IO.
    const walkStart = performance.now();
    const topLevel = await listTopLevelBoxes(file).catch((err) => {
        // Box-walk failed (IO error / truncated header): proceed with no boxes so
        // the file degrades to "no embedded GPS" instead of aborting ingest. A
        // file that fails ONLY here (but indexes elsewhere) would otherwise drop
        // its GPS with zero trace - this breadcrumb is the only sign.
        log.debug("top-level box walk failed", { file: file.name, err: String(err) });
        return [] as Awaited<ReturnType<typeof listTopLevelBoxes>>;
    });
    const walkMs = performance.now() - walkStart;
    // First slice on a fresh File handle pays warm-up cost (FS open + first
    // OS-cache miss). For backends where steady-state is microseconds this
    // skews the average upward, but the strategy thresholds in loadSamples
    // (random < 1 ms, stream > 5 ms) are wide enough to absorb it. For
    // backends where every call is expensive (SAF), the skew is negligible.
    const sliceCost = topLevel.length > 0 ? walkMs / topLevel.length : 0;
    if (topLevel.length > 0) {
        // debug, not info: one line per video file - at info a 300-file SD
        // ingest evicts everything useful from the ~500-entry ring buffer.
        log.debug("sliceCost measured", {
            file: file.name,
            boxes: topLevel.length,
            totalMs: Math.round(walkMs * 10) / 10,
            avgMs: Math.round(sliceCost * 10) / 10,
        });
    }

    // Step 2: load moov bytes - prebuilt bytes from the caller short-circuit
    // the file.slice. Used by the ingest pipeline to avoid a second moov
    // read on cold SD; the indexer worker already loaded these.
    let moov: Box | null = null;
    let moovView: DataView | null = null;
    if (opts.prebuiltMoov) {
        const pb = opts.prebuiltMoov;
        moovView = new DataView(pb.buffer, pb.byteOffset, pb.byteLength);
        moov = { type: "moov", start: 0, end: pb.byteLength, payloadStart: 8 };
    } else {
        const moovTop = topLevel.find((b) => b.type === "moov");
        if (moovTop) {
            try {
                const moovBuf = await file.slice(moovTop.offset, moovTop.offset + moovTop.size).arrayBuffer();
                moovView = new DataView(moovBuf);
                moov = { type: "moov", start: 0, end: moovBuf.byteLength, payloadStart: 8 };
            } catch (err) {
                // IO error on moov read - leave moov null, callers degrade gracefully.
                // Breadcrumb: a readable file whose moov read fails here loses
                // tracks/duration/embedded-GPS silently otherwise.
                log.debug("moov read failed", { file: file.name, err: String(err) });
            }
        }
    }

    // Step 3: parse moov - tracks, novatek gps atom, mvhd.
    const tracks: TrackInfo[] = [];
    if (moov && moovView) {
        for (const child of iterBoxes(moovView, moov.payloadStart, moov.end)) {
            if (child.type !== "trak") continue;
            tracks.push({
                trakBox: child,
                handlerType: readHandlerType(moovView, child),
                sampleFormat: readSampleFormat(moovView, child),
            });
        }
    }
    const novatekGpsAtom = moov && moovView ? findGpsAtomRecursive(moovView, moov.payloadStart, moov.end, 0) : null;
    const durationSec = moovView ? readMvhdDurationSec(moovView) : null;
    const createdUtc = moovView ? readMvhdCreationTime(moovView) : null;

    // Step 4: free box (BlackVue X-series). Loaded whole only when its head
    // shows the telemetry children; a padding `free` box stays unread.
    let topLevelFreeBox: Box | null = null;
    let freeBoxView: DataView | null = null;
    let freeGpsBoxInsideFree: Box | null = null;
    let free3gfBoxInsideFree: Box | null = null;
    const freeTop = topLevel.find((b) => b.type === "free");
    if (freeTop && (await freeBoxOpensWithTelemetryChildren(file, freeTop))) {
        try {
            const freeBuf = await file.slice(freeTop.offset, freeTop.offset + freeTop.size).arrayBuffer();
            freeBoxView = new DataView(freeBuf);
            topLevelFreeBox = { type: "free", start: 0, end: freeBuf.byteLength, payloadStart: 8 };
            // Both children are wanted, so the walk runs to the end rather than
            // stopping at `gps ` - the free box holds a handful of boxes.
            for (const inner of iterBoxes(freeBoxView, topLevelFreeBox.payloadStart, topLevelFreeBox.end)) {
                if (inner.type === "gps " && !freeGpsBoxInsideFree) freeGpsBoxInsideFree = inner;
                else if (inner.type === "3gf " && !free3gfBoxInsideFree) free3gfBoxInsideFree = inner;
            }
        } catch {
            // free box IO failed - treat as no free box.
        }
    }

    // Step 5: gps0/IDIT tail atoms + the uppercase `GPS ` box (70mai Pro) +
    // the top-level udta/frea carriers (Kenwood, LigoJSON/GKU, Rexing gate).
    let navitelGps0Atom: { offset: number; size: number } | null = null;
    let navitelIditAtom: { offset: number; size: number } | null = null;
    let navitelGsenAtom: { offset: number; size: number } | null = null;
    let maiGpsBox: { offset: number; size: number } | null = null;
    let topLevelUdatAtom: Mp4Index["topLevelUdatAtom"] = null;
    let topLevelGdatAtom: Mp4Index["topLevelGdatAtom"] = null;
    let topLevelNbmtAtom: Mp4Index["topLevelNbmtAtom"] = null;
    const topLevelUdtaAtoms: Mp4Index["topLevelUdtaAtoms"] = [];
    let freaBox: { offset: number; size: number; headerSize: number } | null = null;
    for (const box of topLevel) {
        if (box.type === "gps0" && navitelGps0Atom === null) {
            navitelGps0Atom = { offset: box.offset, size: box.size };
        } else if (box.type === "IDIT" && navitelIditAtom === null) {
            navitelIditAtom = { offset: box.offset, size: box.size };
        } else if (box.type === "gsen" && navitelGsenAtom === null) {
            navitelGsenAtom = { offset: box.offset, size: box.size };
        } else if (box.type === "GPS " && maiGpsBox === null) {
            maiGpsBox = { offset: box.offset, size: box.size };
        } else if (box.type === "udat" && topLevelUdatAtom === null) {
            topLevelUdatAtom = { offset: box.offset, size: box.size, headerSize: box.headerSize, head: null };
        } else if (box.type === "gdat" && topLevelGdatAtom === null) {
            topLevelGdatAtom = { offset: box.offset, size: box.size, headerSize: box.headerSize, head: null };
        } else if (box.type === "nbmt" && topLevelNbmtAtom === null) {
            topLevelNbmtAtom = { offset: box.offset, size: box.size, headerSize: box.headerSize, head: null };
        } else if (box.type === "udta") {
            // ALL of them: mux order is firmware whim, a generic leading udta
            // must not shadow the GPS-bearing one (matches ExifTool, which
            // processes every file-level udta).
            topLevelUdtaAtoms.push({ offset: box.offset, size: box.size, headerSize: box.headerSize, head: null });
        } else if (box.type === "frea" && freaBox === null) {
            freaBox = { offset: box.offset, size: box.size, headerSize: box.headerSize };
        }
    }
    const lastBox = topLevel.length > 0 ? topLevel[topLevel.length - 1]! : null;
    const lastTopLevelBoxEnd = lastBox ? lastBox.offset + lastBox.size : null;

    let trailerHead: Uint8Array | null = null;
    if (lastTopLevelBoxEnd !== null && lastTopLevelBoxEnd < fileSize) {
        try {
            const headEnd = Math.min(lastTopLevelBoxEnd + TRAILER_HEAD_BYTES, fileSize);
            trailerHead = new Uint8Array(await file.slice(lastTopLevelBoxEnd, headEnd).arrayBuffer());
        } catch {
            // Trailer read failed - treated as "no trailer", like every other
            // optional carrier here.
        }
    }

    // Step 5b: head read of each top-level udta payload - the sync-marker
    // window for Kenwood VIDEOUUU / LigoJSON / GKU. 32 bytes per atom, and
    // only for files that actually carry a file-level udta (rare outside
    // these formats), so the IO cost is negligible.
    for (const udta of topLevelUdtaAtoms) {
        if (udta.size <= udta.headerSize) continue;
        const payloadStart = udta.offset + udta.headerSize;
        const payloadEnd = udta.offset + udta.size;
        try {
            const headBuf = await file
                .slice(payloadStart, Math.min(payloadStart + UDTA_HEAD_BYTES, payloadEnd))
                .arrayBuffer();
            udta.head = new Uint8Array(headBuf);
        } catch {
            // IO failure - primitives degrade to "no udta marker".
        }
    }

    // Same treatment for the single-instance text/JSON GPS atoms: one small
    // read each, only on files that carry them at all. Window per carrier - the
    // gates read different shapes (see the constants).
    const headReads: Array<{ atom: Mp4Index["topLevelUdatAtom"]; bytes: number }> = [
        { atom: topLevelUdatAtom, bytes: TEXT_LOG_HEAD_BYTES },
        { atom: topLevelNbmtAtom, bytes: TEXT_LOG_HEAD_BYTES },
        { atom: topLevelGdatAtom, bytes: GDAT_HEAD_BYTES },
    ];
    for (const { atom, bytes } of headReads) {
        if (!atom || atom.size <= atom.headerSize) continue;
        const payloadStart = atom.offset + atom.headerSize;
        const payloadEnd = atom.offset + atom.size;
        try {
            const headBuf = await file.slice(payloadStart, Math.min(payloadStart + bytes, payloadEnd)).arrayBuffer();
            atom.head = new Uint8Array(headBuf);
        } catch {
            // IO failure - degrades to "no marker" for that atom.
        }
    }

    // Step 5c: KodakVersion from frea/'ver ' (Rexing affine-deobfuscation
    // gate). Walks frea child headers with tiny slice reads; never loads the
    // whole frea payload (it also carries thma/scra thumbnail JPEGs).
    const kodakVersion = freaBox ? await readKodakVersionFromFrea(file, freaBox) : null;

    // Step 5d: EOF GPS trailer on transport streams. Name-gated, so no other
    // container pays the two probe reads.
    let tsGpsTrailer: TsGpsTrailer | null = null;
    if (isTransportStreamName(file.name)) {
        tsGpsTrailer = await findTsGpsTrailer(file).catch(() => null);
    }

    // Step 6: optional marker probe.
    const index: Mp4Index = {
        headerBytes: null,
        headerView: null,
        fileSize,
        durationSec,
        createdUtc,
        moov,
        moovView,
        tracks,
        topLevelFreeBox,
        freeBoxView,
        freeGpsBoxInsideFree,
        free3gfBoxInsideFree,
        novatekGpsAtom,
        hasFreeGpsMarker: undefined,
        hasLigoGpsMarker: undefined,
        freeGpsSeedOffsets: [],
        navitelGps0Atom,
        navitelGsenAtom,
        navitelIditAtom,
        maiGpsBox,
        topLevelUdatAtom,
        topLevelGdatAtom,
        topLevelNbmtAtom,
        topLevelUdtaAtoms,
        lastTopLevelBoxEnd,
        trailerHead,
        tsGpsTrailer,
        kodakVersion,
        firstSampleCache: new Map(),
        sliceCost,
    };
    if (probeBytes > 0) {
        await probeMarkers(file, index, probeBytes);
    }
    return index;
}

/**
 * Reads the first `bytes` of the file (or up to fileSize) and populates
 * `index.headerBytes`, `index.hasFreeGpsMarker`, `index.hasLigoGpsMarker`,
 * and `index.freeGpsSeedOffsets`. Idempotent and additive: if a probe was
 * already run with a smaller window and a larger one is requested now,
 * extends the existing buffer.
 *
 * Called from buildMp4Index for the default probe, and by the dispatcher
 * (registry.ts tryParseOne) as the marker-probe escalation: when the default
 * 4 MB window yields kind "none" for a Novatek-family filename, the
 * dispatcher re-probes at MAX_PROBE_BYTES and re-classifies.
 */
export async function probeMarkers(file: File, index: Mp4Index, bytes: number): Promise<void> {
    const want = Math.min(bytes, index.fileSize, MAX_PROBE_BYTES);
    if (want <= 0) return;
    const have = index.headerBytes?.byteLength ?? 0;
    if (have >= want) return; // already covered

    try {
        // Extend the window instead of re-reading it: the escalation from the
        // default to the maximum probe then pays only for the new tail.
        const tail = new Uint8Array(await file.slice(have, want).arrayBuffer());
        let u8: Uint8Array;
        if (index.headerBytes && have > 0) {
            u8 = new Uint8Array(have + tail.byteLength);
            u8.set(index.headerBytes, 0);
            u8.set(tail, have);
        } else {
            u8 = tail;
        }
        index.headerBytes = u8;
        index.headerView = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        index.hasLigoGpsMarker = findLigoGpsChunkOffset(u8) !== null;
        // Collect up to 8 freeGPS hit offsets as seeds for jump-scan. More
        // than 8 wastes a tiny bit of CPU for diminishing accuracy - median
        // of the first 3-5 deltas is already stable on Novatek samples.
        index.freeGpsSeedOffsets = findFreeGpsOffsets(u8, 0, u8.length, 8);
        index.hasFreeGpsMarker = index.freeGpsSeedOffsets.length > 0;
    } catch {
        // IO failure - leave markers undefined, primitives degrade by trying
        // their full parse path (which can self-detect format and bail).
    }
}

/** Cap on the `free` child-walk: BlackVue writes a handful of boxes there. */
const FREE_CHILD_WALK_MAX = 16;

/**
 * Whether a top-level `free` box starts with a run of child boxes that
 * includes the `gps `/`3gf ` carriers BlackVue X-series writes there. Walks
 * child headers with 16-byte reads so a padding `free` box - DDPAI, 70mai and
 * Thinkware reserve 8-20 MB of it - costs a few bytes instead of a full read.
 * The first header that is not a plausible box ends the walk: padding is
 * zero- or junk-filled, never a box chain.
 */
async function freeBoxOpensWithTelemetryChildren(
    file: File,
    free: { offset: number; size: number; headerSize: number },
): Promise<boolean> {
    const end = free.offset + free.size;
    let pos = free.offset + free.headerSize;
    try {
        for (let i = 0; i < FREE_CHILD_WALK_MAX && pos + 8 <= end; i++) {
            const hdr = new DataView(await file.slice(pos, Math.min(pos + 16, end)).arrayBuffer());
            if (hdr.byteLength < 8) return false;
            let size = hdr.getUint32(0);
            let header = 8;
            const type = String.fromCharCode(hdr.getUint8(4), hdr.getUint8(5), hdr.getUint8(6), hdr.getUint8(7));
            if (!/^[\x20-\x7e]{4}$/.test(type)) return false;
            if (size === 1) {
                if (hdr.byteLength < 16) return false;
                size = hdr.getUint32(8) * 0x100000000 + hdr.getUint32(12);
                header = 16;
            } else if (size === 0) {
                size = end - pos;
            }
            if (size < header || pos + size > end) return false;
            if (type === "gps " || type === "3gf ") return true;
            pos += size;
        }
    } catch {
        // IO failure - the full read below would fail the same way.
    }
    return false;
}

/** Cap on the frea child-walk: a genuine Kodak/Rexing frea has 3-4 children
 *  (ver/tima/thma/scra); more headers than this means corrupt data. */
const FREA_MAX_CHILDREN = 16;

/** Cap on the 'ver ' payload read. Real version strings are ~8 chars
 *  ("3.01.054"); 64 bytes is generous slack for unknown firmware. */
const FREA_VER_READ_CAP = 64;

/**
 * Reads the KodakVersion string from a top-level `frea` atom by walking its
 * child box headers with 8-byte slice reads and loading ONLY the 'ver '
 * payload (capped). frea also carries thma/scra thumbnail JPEGs - loading
 * the whole payload would read tens of KB for an 8-char string.
 *
 * Child layout is standard size+type boxes (ExifTool processes
 * %Image::ExifTool::Kodak::frea with the regular MOV walker, Kodak.pm:
 * 2976-2989, v13.59). A largesize (size==1) or otherwise corrupt child
 * header stops the walk - degrading to null, which just disables the
 * Rexing gate. Returns the trimmed version string, or null.
 */
async function readKodakVersionFromFrea(
    file: File,
    frea: { offset: number; size: number; headerSize: number },
): Promise<string | null> {
    const end = frea.offset + frea.size;
    let pos = frea.offset + frea.headerSize;
    try {
        for (let i = 0; i < FREA_MAX_CHILDREN && pos + 8 <= end; i++) {
            const headerBuf = await file.slice(pos, pos + 8).arrayBuffer();
            const hdr = new DataView(headerBuf);
            if (hdr.byteLength < 8) return null;
            const size = hdr.getUint32(0);
            // size < 8 covers both corrupt zeros and the 64-bit largesize
            // marker (size==1) - neither occurs in a sane frea.
            if (size < 8 || pos + size > end) return null;
            const type = String.fromCharCode(hdr.getUint8(4), hdr.getUint8(5), hdr.getUint8(6), hdr.getUint8(7));
            if (type === "ver ") {
                const payloadLen = Math.min(size - 8, FREA_VER_READ_CAP);
                if (payloadLen <= 0) return null;
                const payload = new Uint8Array(await file.slice(pos + 8, pos + 8 + payloadLen).arrayBuffer());
                // Trim trailing NULs/whitespace: the raw bytes of the box are
                // unknown (n=0 samples); ExifTool's string handling would eat
                // padding silently, so an exact-match gate must too.
                const text = new TextDecoder("latin1").decode(payload).replace(/[\s\0]+$/, "");
                return text.length > 0 ? text : null;
            }
            pos += size;
        }
    } catch {
        // IO failure - same degradation as "no version atom".
    }
    return null;
}

/**
 * Recursively searches for a `gps ` atom up to depth 3. Novatek places it
 * at the top level inside moov, but we also look inside udta/meta/trak in
 * case firmware variants nest it deeper.
 */
function findGpsAtomRecursive(dv: DataView, start: number, end: number, depth: number): Box | null {
    const direct = findBox(dv, start, end, "gps ");
    if (direct) return direct;
    if (depth >= 3) return null;
    for (const child of iterBoxes(dv, start, end)) {
        if (child.type === "udta" || child.type === "meta" || child.type === "trak") {
            // `meta` is a FullBox: its children start 4 bytes after payloadStart
            // (1 byte version + 3 bytes flags). udta/trak are plain containers,
            // so their children begin right at payloadStart.
            const innerStart = child.type === "meta" ? child.payloadStart + 4 : child.payloadStart;
            const nested = findGpsAtomRecursive(dv, innerStart, child.end, depth + 1);
            if (nested) return nested;
        }
    }
    return null;
}

/**
 * Shared prologue of the track-based extractors: resolves the track's sample
 * table from the indexed moov and loads every sample payload. Returns null
 * when there is no moov view or the track carries no samples - callers treat
 * that as "format detected but track is empty / not this format". Extractors
 * that must validate the sample table before paying for the load (constant
 * record sizes, stts alignment - see rove-ssmd, rvmi) keep their own inline
 * sequence instead.
 */
export async function loadTrackSampleBuffers(
    file: File,
    index: Mp4Index,
    track: TrackInfo,
): Promise<ArrayBuffer[] | null> {
    if (!index.moovView) return null;
    const samples = readSampleTable(index.moovView, track.trakBox);
    if (!samples || samples.length === 0) return null;
    return await loadSamples(file, samples, index.sliceCost);
}

/**
 * Returns the first sample of a track as Uint8Array. Per-file lazy cache:
 * repeated calls for the same track return the same buffer.
 * Returns null if the track has no samples or the sample table is corrupt.
 * Used by classifyByContent (Garmin/Thinkware/CarCam) to probe format
 * signatures cheaply - reads 1-4 KB instead of a full moov walk.
 */
export async function getFirstSampleOfTrack(
    index: Mp4Index,
    track: TrackInfo,
    vf: VendorFile,
): Promise<Uint8Array | null> {
    const key = track.trakBox.start;
    const cached = index.firstSampleCache.get(key);
    if (cached !== undefined) return cached;

    if (!index.moovView) {
        index.firstSampleCache.set(key, null);
        return null;
    }
    const sample = readFirstSampleEntry(index.moovView, track.trakBox);
    if (!sample) {
        index.firstSampleCache.set(key, null);
        return null;
    }
    const buffers = await loadSamples(vf.file, [sample]);
    const buf = buffers[0];
    if (!buf) {
        index.firstSampleCache.set(key, null);
        return null;
    }
    const arr = new Uint8Array(buf);
    index.firstSampleCache.set(key, arr);
    return arr;
}

/** Returns the first track whose sample-format is in `formats`, or null. */
export function findTrackBySampleFormat(index: Mp4Index, formats: readonly string[]): TrackInfo | null {
    for (const t of index.tracks) {
        if (t.sampleFormat && formats.includes(t.sampleFormat)) return t;
    }
    return null;
}

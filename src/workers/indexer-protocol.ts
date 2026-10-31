// Wire payloads between the ui-side indexer client (src/indexer.ts shim) and
// workers/indexer-worker.ts.
//
// Indexing runs in a worker: over a 240-file drop the O(N) moov walks sum to
// 1-3 s of main-thread work and would freeze the UI during the most
// user-facing phase of ingest. The worker also returns moov bytes for files
// that downstream embedded-GPS extraction re-reads anyway, so cold SD pays one
// moov read instead of two.

import type { WorkerContract, WorkerRequest } from "./_protocol/worker-contract.js";

import type { VideoCodec } from "mediabunny";

import type { Mp4Rotation } from "../parsers/internal/mp4-walker.js";

/** Indexing result for one MP4 - metadata needed by ingest on the main thread. */
export interface IndexedMp4 {
    /** duration in seconds */
    durationSec: number;
    /** creation_time from mvhd, or null if the field is zero or not found */
    createdUtc: Date | null;
    /**
     * Codec of the primary video track. null if there is no video track or
     * the FourCC is unrecognized. Used for the canDecodeVideo check before
     * playback and for the UI badge.
     */
    codec: VideoCodec | null;
    /**
     * FourCC sample entry of the video track from stsd ('avc1' / 'hvc1' / 'hev1' /
     * 'av01' / 'vp09' / ...). null if no video track or stsd is corrupt. Stored
     * for diagnostics in the attach log and feedback report.
     */
    codecParam: string | null;
    /**
     * Full RFC 6381 codec string of the primary video track when derivable
     * ("hev1.1.6.L150", "hev1.2.4.L153"): for HEVC MP4 parsed from hvcC, for
     * MPEG-TS from mediabunny.getCodecParameterString. null for AVC MP4 and when
     * undetermined - the canPlay check then falls back to the bare `codec` enum.
     * Carries the HEVC profile/level so canDecodeVideo can reject Main10 /
     * too-high-level streams the browser cannot decode.
     */
    videoCodecString: string | null;
    /** Quarter-turn component of the MP4 display matrix. */
    rotation: Mp4Rotation;
    /**
     * Frame size of the primary video track, in pixels. null when there is no
     * video track or stsd is corrupt. Display-only (the technical-details panel).
     * MP4 reads the coded size from the VisualSampleEntry; TS/MKV read the display
     * size from mediabunny displayWidth/Height - the two differ only under an
     * anamorphic PAR, which is not a case dashcams produce.
     */
    width: number | null;
    height: number | null;
    /**
     * Estimated frame rate of the primary video track (frames per second). null
     * when undeterminable. MP4 uses sampleCount/duration from stts; TS/MKV infer
     * the intended rate from packet timestamps. Also drives frame stepping and
     * re-encode timing/bitrate.
     */
    fps: number | null;
    /**
     * Primary audio track descriptor for the technical-details panel. null when
     * there is no audio track. `codec` is the sample-entry 4cc for MP4 ("mp4a",
     * "ms\0\x11", ...) or the mediabunny codec name for TS/MKV; the UI maps it to
     * a friendly label. channels/sampleRate are 0 when unknown.
     */
    audio: { codec: string | null; channels: number; sampleRate: number } | null;
    /**
     * True if the file needs MSE remux before playback. True for HEVC files
     * with hvcC containing an invalid NAL array (BlackVue ELITE 9 firmware
     * quirk). See hevc-remux.ts -> needsHevcRemux.
     */
    needsHevcRemux: boolean;
    /**
     * True if the audio track is IMA ADPCM (Mio/Navman MiVue, QuickTime `ms `
     * sample entry / WAVE 0x11), which no browser can decode natively. Such a
     * file otherwise plays with silent audio. The flag routes it through the MSE
     * backend, which decodes the ADPCM to PCM and re-encodes it to an
     * MSE-playable codec on the fly (see workers/per-file-mse-worker.ts). Video
     * stays a stream-copy.
     */
    audioNeedsTranscode: boolean;
}

/**
 * Container-repair descriptor produced by the indexer worker from the moov bytes
 * it already read - no extra IO. The main thread applies it via a zero-copy Blob
 * splice (see src/ui/ingest.ts applyMoovRepair), replacing the file's moov with
 * the patched copy. Present only when a defect (phantom no-data track or broken
 * hvcC) was found, so the common clean-file case carries nothing extra.
 */
export interface IndexerRepair {
    /**
     * Patched moov bytes (transferable, constant size vs the original). Splice:
     * [file.slice(0, moovFileStart), patchedMoov, file.slice(moovFileEnd)].
     */
    patchedMoov: Uint8Array;
    /** Absolute file offset where the moov box starts (= splice cut point). */
    moovFileStart: number;
    /** Absolute file offset where the moov box ends (exclusive). */
    moovFileEnd: number;
    /** Handler types of neutralized phantom tracks ('soun', 'meta', ...). For the toast count. */
    phantomNeutralized: string[];
    /**
     * hvcC repair: recomputed needsHevcRemux (post-fix), damage pattern, and the
     * RFC 6381 codec string re-derived from the REPAIRED hvcC. null if no hvcC fix.
     * The videoCodecString parsed at index time came from the broken header
     * (bogus profile/level), so the config-aware canPlay probe must use this one.
     */
    hvcc: { needsHevcRemux: boolean; reason: "header" | "arrays"; videoCodecString: string | null } | null;
}

/** Request payload. */
export interface IndexRequestData {
    /**
     * Batch identifier - echoed back in every progress notification so the
     * main-side facade can route results when background and foreground
     * recording reads overlap.
     */
    batchId: string;
    /** Files to index. Order is preserved in progress notifications. */
    files: File[];
    /**
     * If true, the worker also returns the raw moov bytes for each MP4 it
     * indexed (in the corresponding progress notification). Bytes are
     * transferred zero-copy. The caller (ingest.ts) filters by source-hint
     * and forwards only embedded/auto-hint files' bytes to gps-extract
     * to avoid a second moov read in the GPS extraction worker.
     *
     * Set to false for indexing-only runs (no embedded GPS expected) -
     * saves heap on the caller side.
     */
    withMoovBytes: boolean;
    /** Concurrency for the file pool inside the worker. 4 matches the
     *  previous main-side default. Higher just trashes IO. */
    concurrency: number;
}

/** Progress notification: one per file as the worker finishes it. */
export interface IndexProgressNotificationData {
    /** Echo of IndexRequestData.batchId. Routes the notification to one batch. */
    batchId: string;
    /** 1-based completed count, matches the main-side onProgress signature. */
    done: number;
    /** Total files in this request. */
    total: number;
    /**
     * Index into IndexRequestData.files. The main thread routes the
     * notification to its File object by this stable position - NOT by
     * basename, which is not unique across folders (channel-in-folder
     * cameras put front/rear of the same moment in different dirs with an
     * identical timestamp-only filename).
     */
    fileIndex: number;
    /** Index result. null for unreadable / non-MP4. */
    result: IndexedMp4 | null;
    /**
     * Raw moov bytes (transferable). Present only when:
     *   - request had withMoovBytes=true, AND
     *   - the file is MP4/MOV (not TS - TS has no moov), AND
     *   - moov was found.
     */
    moovBytes?: Uint8Array;
    /**
     * Container-repair descriptor (transferable patchedMoov inside). Present only
     * when the worker detected a phantom track or broken hvcC in this file's
     * moov. The main thread splices patchedMoov back; see IndexerRepair.
     */
    repair?: IndexerRepair;
}

/** Result payload. Empty - main accumulates via progress notifications. */
export type IndexResult = Record<string, never>;

export const INDEXER_REQUEST_INDEX_ALL = "index-all";
export const INDEXER_NOTIFY_PROGRESS = "progress";

export type IndexerWorkerContract = WorkerContract<
    {
        [INDEXER_REQUEST_INDEX_ALL]: WorkerRequest<IndexRequestData, IndexResult>;
    },
    Record<never, never>,
    {
        [INDEXER_NOTIFY_PROGRESS]: IndexProgressNotificationData;
    },
    Record<never, never>
>;

// VideoCandidate construction and metadata application for progressive ingest.

import type { VideoCodec } from "mediabunny";

import { createLogger } from "../log.js";
import { type IndexerRepair } from "../indexer.js";
import type { IndexedMp4 } from "../workers/indexer-protocol.js";
import type { GpsRecord, VendorFile } from "../parsers/types.js";
import {
    classifyFilenameTimelapse,
    matchFilenameChannel,
    matchFilenameMode,
    matchFilenameSequence,
    matchFilenameTime,
} from "../parsers/filename/index.js";
import { isMatroskaName, isTransportStreamName } from "../video-format-names.js";
import type { StartSource, VideoCandidate } from "../trips.js";
import { vendorFileKey } from "../vendor-file-key.js";

const log = createLogger("ingest-candidate");

/**
 * Session file identity shared by ingest and deferred work maps.
 * Defined in a UI-free root module so parser workers can use the same key.
 */
export { vendorFileKey };

/**
 * Builds a zero-copy patched File from the indexer worker's container-repair
 * descriptor (broken hvcC / phantom track). The patched moov replaces the
 * original moov region via Blob concatenation - only the moov copy (tens of KB)
 * is materialized; the huge mdat stays a lazy file.slice() reference. The patch
 * is constant-size, so every byte offset outside moov stays valid.
 */
export function applyMoovRepair(file: File, repair: IndexerRepair): File {
    const patchedBlob = new Blob(
        [
            file.slice(0, repair.moovFileStart),
            repair.patchedMoov as unknown as BlobPart,
            file.slice(repair.moovFileEnd),
        ],
        { type: file.type },
    );
    return new File([patchedBlob], file.name, { type: file.type, lastModified: file.lastModified });
}

/** Outcome of applying an indexer repair: the (possibly patched) file, the
 *  post-repair needsHevcRemux, and which repair kinds fired (for the toasts). */
export interface RepairApplication {
    file: File;
    needsHevcRemux: boolean;
    phantomRepaired: boolean;
    hvccRepaired: boolean;
}

/**
 * Applies the indexer's container-repair descriptor (or passes the file through
 * untouched when there is none). Single source of truth for "patched file +
 * post-repair needsHevcRemux + repair counters.
 */
export function applyIndexRepair(
    file: File,
    indexedNeedsHevcRemux: boolean,
    repair: IndexerRepair | undefined,
): RepairApplication {
    if (!repair) {
        return { file, needsHevcRemux: indexedNeedsHevcRemux, phantomRepaired: false, hvccRepaired: false };
    }
    return {
        file: applyMoovRepair(file, repair),
        // hvcC repair recomputes needsHevcRemux (it may flip a previously-broken
        // descriptor to the native path); a phantom-only repair keeps the indexed value.
        needsHevcRemux: repair.hvcc ? repair.hvcc.needsHevcRemux : indexedNeedsHevcRemux,
        phantomRepaired: repair.phantomNeutralized.length > 0,
        hvccRepaired: repair.hvcc != null,
    };
}

/** Filename-derived channel, sequence, mode and classifier attribution. */
export interface FilenameClassifierFields {
    classifierMatches: VideoCandidate["classifierMatches"];
    channel: VideoCandidate["channel"];
    channelConfident: boolean;
    sequence: VideoCandidate["sequence"];
    recordingMode: VideoCandidate["recordingMode"];
    isTimelapse: boolean;
}

/** Maps the per-field filename classifiers onto a candidate. */
export function filenameClassifierFields(file: VendorFile): FilenameClassifierFields {
    const timeMatch = matchFilenameTime(file);
    const channelMatch = matchFilenameChannel(file);
    const modeMatch = matchFilenameMode(file);
    const sequenceMatch = matchFilenameSequence(file);
    return {
        classifierMatches: {
            time: timeMatch.matchedId,
            channel: channelMatch.matchedId,
            mode: modeMatch.matchedId,
            sequence: sequenceMatch.matchedId,
        },
        channel: channelMatch.value?.channel ?? null,
        channelConfident: channelMatch.value?.confident ?? false,
        sequence: sequenceMatch.value,
        recordingMode: modeMatch.value,
        isTimelapse: classifyFilenameTimelapse(file),
    };
}

/** Parameters for a provisional (filename-only) VideoCandidate. */
export interface ProvisionalCandidateParams {
    file: VendorFile;
    fingerprint: string;
    startUtc: number;
    startSource: StartSource;
    /** Display-clock zone snapshot (per-fingerprint filenameTzSec), null when unknown. */
    cameraTzSec: number | null;
    /** Per-fingerprint provisional duration (estimateProvisionalDurationByFingerprint). */
    durationSec: number;
    records: GpsRecord[];
    appliedExtractors: string[];
    /** Already-computed filename fields from the discovery pass. */
    classifierFields?: FilenameClassifierFields;
}

/**
 * Builds a provisional candidate without reading file bytes. Byte-derived fields
 * carry safe placeholders until applyIndexedMetadata fills them in place.
 */
export function buildProvisionalCandidate(params: ProvisionalCandidateParams): VideoCandidate {
    const { file } = params;
    return {
        file: file.file,
        relativePath: file.relativePath,
        sourceKey: file.sourceKey,
        fingerprint: params.fingerprint,
        appliedExtractors: params.appliedExtractors,
        ...(params.classifierFields ?? filenameClassifierFields(file)),
        startUtc: params.startUtc,
        durationSec: params.durationSec,
        // Provisional: no moov/GPS read yet, so no wall-span evidence; the
        // post-metadata read rederive sweep fills the real value.
        wallDurationSec: null,
        // Computed at regroup time (applyChannelDriftLead), never at construction.
        driftLeadSec: null,
        startSource: params.startSource,
        cameraTzSec: params.cameraTzSec,
        records: params.records,
        createdUtc: null,
        codec: null,
        // Optimistic until metadata read's canPlay check; null codec stays true (let <video> try).
        canPlay: true,
        codecParam: null,
        videoCodecString: null,
        rotation: 0,
        // Byte-derived display metadata is unknown until the moov read.
        width: null,
        height: null,
        fps: null,
        audio: null,
        needsHevcRemux: false,
        isTransportStream: isTransportStreamName(file.file.name),
        isMatroska: isMatroskaName(file.file.name),
        audioNeedsTranscode: false,
        embeddedStartUtcHint: null,
        localClockOffsetHintSec: null,
        metadataReady: false,
    };
}

/**
 * Fills a provisional candidate's byte-derived fields from a fresh index result,
 * in place (the same object is referenced by the trip's frames, so mutation is
 * what makes the rendered card update). Applies any container repair via
 * applyIndexRepair and marks the metadata ready. Returns which repairs fired so the
 * caller can count them for the post-ingest toast.
 */
export function applyIndexedMetadata(
    candidate: VideoCandidate,
    indexed: IndexedMp4,
    repair: IndexerRepair | undefined,
): { phantomRepaired: boolean; hvccRepaired: boolean } {
    const applied = applyIndexRepair(candidate.file, indexed.needsHevcRemux, repair);
    candidate.file = applied.file;
    candidate.durationSec = indexed.durationSec;
    candidate.createdUtc = indexed.createdUtc;
    candidate.codec = indexed.codec;
    candidate.codecParam = indexed.codecParam;
    candidate.videoCodecString = indexed.videoCodecString;
    candidate.rotation = indexed.rotation;
    candidate.width = indexed.width;
    candidate.height = indexed.height;
    candidate.fps = indexed.fps;
    candidate.audio = indexed.audio;
    candidate.needsHevcRemux = applied.needsHevcRemux;
    candidate.audioNeedsTranscode = indexed.audioNeedsTranscode;
    candidate.metadataReady = true;
    if (repair) {
        log.info("applied container repair", {
            file: candidate.file.name,
            phantom: repair.phantomNeutralized,
            hvcc: repair.hvcc?.reason ?? null,
        });
    }
    return { phantomRepaired: applied.phantomRepaired, hvccRepaired: applied.hvccRepaired };
}

// Decoder support for a codec string cannot change within a session, and the
// progressive fill asks once per trip. One probe per distinct codec keeps a
// long card from paying a GPU-process round trip per trip. A rejected probe is
// dropped so the next trip retries instead of inheriting a transient failure.
const decodableByCodecKey = new Map<string, Promise<boolean>>();

export function _resetForTests(): void {
    decodableByCodecKey.clear();
}

function probeDecodable(key: string, codec: VideoCodec, codecString: string | null): Promise<boolean> {
    const cached = decodableByCodecKey.get(key);
    if (cached) return cached;
    const probe = (async () => {
        // Keep codec capabilities out of the landing graph. The shared helper's
        // named Mediabunny imports expose only the exports the application uses.
        const { canDecodeVideoStream } = await import("../transcode/capabilities.js");
        return canDecodeVideoStream(codec, codecString);
    })();
    decodableByCodecKey.set(key, probe);
    probe.catch(() => {
        if (decodableByCodecKey.get(key) === probe) decodableByCodecKey.delete(key);
    });
    return probe;
}

/**
 * Sets each candidate's canPlay by probing codec decodability (mediabunny
 * canDecodeVideo, deduped by codec string). HEVC stays optimistic: Chromium
 * on Windows can decode it through the OS-backed native/MSE path while
 * WebCodecs reports it unsupported. The player classifies a real attach/decode failure.
 * A codec=null candidate and a thrown probe are optimistic for the same reason.
 */
export async function checkCanPlay(candidates: VideoCandidate[]): Promise<void> {
    // Key = videoCodecString when present, else the codec enum.
    const checks = new Map<string, { codec: VideoCodec; codecString: string | null }>();
    for (const c of candidates) {
        if (!c.codec) continue;
        if (c.codec === "hevc") {
            c.canPlay = true;
            continue;
        }
        const key = c.videoCodecString ?? c.codec;
        if (!checks.has(key)) checks.set(key, { codec: c.codec, codecString: c.videoCodecString });
    }
    if (checks.size === 0) return;
    const decodableByKey = new Map<string, boolean>();
    await Promise.all(
        [...checks].map(async ([key, { codec, codecString }]) => {
            try {
                decodableByKey.set(key, await probeDecodable(key, codec, codecString));
            } catch (err) {
                log.warn("codec check threw, optimistically allowing playback", {
                    codec,
                    codecString,
                    err: err instanceof Error ? err.message : String(err),
                });
                decodableByKey.set(key, true);
            }
        }),
    );
    for (const c of candidates) {
        if (c.codec !== "hevc") {
            c.canPlay = c.codec ? (decodableByKey.get(c.videoCodecString ?? c.codec) ?? true) : true;
        }
    }
}

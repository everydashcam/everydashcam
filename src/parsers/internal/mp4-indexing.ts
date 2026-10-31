// Pure indexing logic - separated from workers/indexer-worker.ts so node
// tests can call it without spinning up a Worker (Worker is undefined in
// node, and we still want unit coverage of the TS branch since nothing else
// in the test suite hits mediabunny.MpegTsInputFormat).

import { Input, InputDisposedError, UnsupportedInputFormatError } from "mediabunny";
import type { VideoCodec } from "mediabunny";

import { createLogger } from "../../log.js";
import { getInputTimeOrigin } from "../../media-time.js";
import { needsHevcRemux } from "../../hevc-remux.js";
import { detectMoovRepairs } from "../../repair/moov-repair.js";
import { createBlobSource } from "../../blob-source.js";
import { VIDEO_INPUT_FORMATS } from "../../video-formats.js";
import { isNonIsobmffContainerName } from "../../video-format-names.js";
import type { IndexedMp4, IndexerRepair } from "../../workers/indexer-protocol.js";

import {
    findBox,
    findHvccInTrak,
    findMoovInFile,
    fourCCToVideoCodec,
    hevcCodecStringFromHvcc,
    isImaAdpcmSampleEntry,
    iterBoxes,
    readHandlerType,
    readMvhdCreationTime,
    readMvhdDurationSec,
    readSampleFormat,
    readSoundSampleParams,
    readTkhdRotation,
    readVideoFrameRate,
    readVisualSampleDimensions,
    type Mp4Rotation,
} from "./mp4-walker.js";

const log = createLogger("mp4-indexing");

// Bounded prefix scan behind the container duration scan; its result drives
// frame stepping and re-encode timing as well as the details panel. Mediabunny
// defaults to 256 packets, but the non-ISOBMFF demuxers read whole packets even
// for a metadata-only pass, so on a 4K transport stream 256 packets cost ~36 MB
// against ~4 MB for 64 - a real difference on removable media. 64 packets still
// span 2-3 s of video, enough to settle the timestamp lattice and to notice a
// dropped frame; MP4 reads its rate from stts and never comes through here.
const FPS_PROBE_PACKETS = 64;

/** Index result + optional moov bytes (only when the caller asked for them). */
export interface IndexedWithMoov {
    indexed: IndexedMp4 | null;
    /** Raw moov bytes (transferable) when captureMoov=true and the file is
     *  MP4/MOV with a valid moov. Undefined for TS or non-MP4. */
    moovBytes?: Uint8Array;
    /** Container-repair descriptor when a phantom track / broken hvcC was found
     *  in this file's moov. Undefined when the moov is clean. */
    repair?: IndexerRepair;
}

/**
 * Indexes one MP4/MOV via a direct moov walk. Returns the moov bytes too
 * so the caller can ship them to gps-extract and skip its second read.
 */
export async function indexMp4FileWithMoov(file: File, captureMoov: boolean): Promise<IndexedWithMoov> {
    const found = await findMoovInFile(file).catch(() => null);
    if (!found) {
        log.info("mp4 indexing skipped: moov not found", { file: file.name });
        return { indexed: null };
    }
    const moovDv = new DataView(found.bytes.buffer, found.bytes.byteOffset, found.bytes.byteLength);
    const durationSec = readMvhdDurationSec(moovDv);
    if (durationSec === null) {
        log.info("mp4 indexing skipped: no valid duration in mvhd", { file: file.name });
        return { indexed: null };
    }
    const createdUtc = readMvhdCreationTime(moovDv);
    let codecParam: string | null = null;
    let codec: VideoCodec | null = null;

    let rotation: Mp4Rotation = 0;
    let needsRemux = false;
    // RFC 6381 string only for HEVC (parsed from hvcC below). AVC stays
    // codec-enum only: H.264 decode is near-universal where the browser claims
    // avc support, so the false-positive that matters (HEVC Main10 / high level
    // on a browser without 10-bit decode) is HEVC-specific. See the canPlay
    // check in ingest.ts.
    let videoCodecString: string | null = null;
    // Audio track is IMA ADPCM (Mio/Navman MiVue) - flagged so playback routes
    // through the MSE backend that decodes it to PCM and re-encodes it to an
    // MSE-playable codec (no browser decodes ADPCM natively). Detected from the
    // soun trak's stsd 4cc in the moov bytes already in hand, so it costs no
    // extra IO.
    let audioNeedsTranscode = false;
    // Display-only technical-details fields read from the same moov already in
    // hand (zero extra IO): coded frame size + average fps from the video trak,
    // audio 4cc/channels/rate from the soun trak.
    let width: number | null = null;
    let height: number | null = null;
    let fps: number | null = null;
    let audio: IndexedMp4["audio"] = null;
    let sawVideo = false;
    let sawAudio = false;
    const moov = findBox(moovDv, 0, moovDv.byteLength, "moov");
    if (moov) {
        for (const child of iterBoxes(moovDv, moov.payloadStart, moov.end)) {
            if (child.type !== "trak") continue;
            const handler = readHandlerType(moovDv, child);
            if (handler === "vide" && !sawVideo) {
                sawVideo = true;
                codecParam = readSampleFormat(moovDv, child);
                codec = codecParam ? fourCCToVideoCodec(codecParam) : null;
                rotation = readTkhdRotation(moovDv, child);
                const dims = readVisualSampleDimensions(moovDv, child);
                if (dims) {
                    width = dims.width;
                    height = dims.height;
                }
                fps = readVideoFrameRate(moovDv, child);
                if (codec === "hevc") {
                    const hvcc = findHvccInTrak(moovDv, child);
                    if (hvcc) {
                        const description = new Uint8Array(
                            moovDv.buffer,
                            moovDv.byteOffset + hvcc.payloadStart,
                            hvcc.payloadEnd - hvcc.payloadStart,
                        );
                        needsRemux = needsHevcRemux(codec, description);
                        videoCodecString = hevcCodecStringFromHvcc(description);
                    }
                }
            } else if (handler === "soun" && !sawAudio) {
                sawAudio = true;
                const sound = readSoundSampleParams(moovDv, child);
                if (sound) {
                    if (isImaAdpcmSampleEntry(sound.format)) audioNeedsTranscode = true;
                    audio = { codec: sound.format, channels: sound.channels, sampleRate: sound.sampleRate };
                }
            }
            if (sawVideo && sawAudio) break;
        }
    }

    // Detect container defects (phantom no-data tracks, broken hvcC) from the
    // moov bytes already in hand. This used to be two post-index stages on the
    // main thread, each re-reading the moov via findMoovInFile. Constant-size
    // patch; the descriptor carries the patched moov for a zero-copy splice on
    // main. null (the common case) means the moov is clean - no extra copy.
    const moovRepair = detectMoovRepairs(found.bytes, codec);
    // When the hvcC header was rebuilt, videoCodecString parsed above came from
    // the broken header (bogus profile/level, e.g. hev1.2.0.L0) - keeping it
    // would make the config-aware canPlay probe reject a file that decodes fine
    // after the splice, and would show the wrong codec in the details panel.
    // Adopt the string re-derived from the repaired hvcC. (needsHevcRemux is
    // corrected on the main thread in applyIndexRepair, so it needs no fix here.)
    if (moovRepair?.hvcc?.videoCodecString) videoCodecString = moovRepair.hvcc.videoCodecString;

    const indexed: IndexedMp4 = {
        durationSec,
        createdUtc,
        codec,
        codecParam,
        videoCodecString,
        rotation,
        width,
        height,
        fps,
        audio,
        needsHevcRemux: needsRemux,
        audioNeedsTranscode,
    };

    const repair: IndexerRepair | undefined = moovRepair
        ? {
              patchedMoov: moovRepair.patchedMoov,
              moovFileStart: found.fileStart,
              moovFileEnd: found.fileEnd,
              phantomNeutralized: moovRepair.phantomNeutralized,
              hvcc: moovRepair.hvcc,
          }
        : undefined;

    return { indexed, moovBytes: captureMoov ? found.bytes : undefined, repair };
}

/**
 * Non-ISOBMFF path (MPEG-TS, Matroska): no mvhd, no display matrix, no embedded
 * wall-clock. Single mediabunny Input call yields durationSec and codec. moov
 * bytes are N/A (these containers have no moov). computeDuration has to locate
 * the last packet without an index (TS: a binary search over 5 MiB chunks;
 * Matroska: a cluster lookup), so both still issue random reads on a cold SD card.
 */
export async function indexNonIsobmffFile(file: File, signal?: AbortSignal): Promise<IndexedWithMoov> {
    let input: Input | null = null;
    let onAbort: (() => void) | null = null;
    try {
        // A GPS trailer at EOF breaks mediabunny's TS packet-sync scan (it made
        // whole cards read as "empty folder"); clamp reads to the clean stream.
        input = new Input({ source: await createBlobSource(file, signal), formats: VIDEO_INPUT_FORMATS });
        // mediabunny has no InputOptions.signal - dispose() is the documented way
        // to cancel in-flight reads. computeDuration searches the container for its
        // last packet (no moov), which is slow on a cold SD card; without this an
        // ingest cancel waits out every in-flight search. dispose() surfaces as
        // InputDisposedError, which the catch below already handles as a clean abort.
        if (signal) {
            const inp = input;
            onAbort = () => {
                if (!inp.disposed) inp.dispose();
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
        }
        const durationSec = (await input.computeDuration()) - (await getInputTimeOrigin(input));
        if (!Number.isFinite(durationSec) || durationSec <= 0) {
            log.info("non-isobmff indexing skipped: invalid duration", { file: file.name, durationSec });
            return { indexed: null };
        }
        let codec: VideoCodec | null = null;
        // Full codec string straight from mediabunny here: the TS path has the
        // track in hand, so getCodecParameterString gives profile/level for free
        // (no extra IO) and feeds the config-aware canPlay check in ingest.ts.
        let videoCodecString: string | null = null;
        let width: number | null = null;
        let height: number | null = null;
        let fps: number | null = null;
        try {
            const vt = await input.getPrimaryVideoTrack();
            if (vt) {
                codec = await vt.getCodec();
                videoCodecString = await vt.getCodecParameterString();
                // Display dims are cached getters once the track is resolved.
                if (vt.displayWidth > 0 && vt.displayHeight > 0) {
                    width = vt.displayWidth;
                    height = vt.displayHeight;
                }
                // Infer the intended frame rate from timestamp spacing rather
                // than averaging observed packets: a dropped frame must not turn
                // a 30 fps camera into a 29.x fps export. Best-effort so a scan
                // failure (or an ingest-cancel dispose) never voids the codec.
                try {
                    const metrics = await vt.computeFrameRateMetrics({ targetPacketCount: FPS_PROBE_PACKETS });
                    if (
                        metrics.probedPacketCount >= 2 &&
                        Number.isFinite(metrics.bestGuessFrameRate) &&
                        metrics.bestGuessFrameRate > 0
                    ) {
                        fps = metrics.bestGuessFrameRate;
                    }
                } catch {
                    // fps stays null - packet scan unavailable / aborted.
                }
            }
        } catch {
            // codec=null is treated optimistically downstream.
        }

        // Matroska can carry IMA-ADPCM audio (A_MS/ACM + null codec: a PCM WAVE
        // tag would be recognised, so null under A_MS/ACM is the ADPCM variant
        // mediabunny cannot read). Some cameras also give ISO-BMFF recordings a
        // `.TS` suffix; extension routing brings them here, but mediabunny still
        // exposes their real QuickTime `ms\0\x11` sample-entry id. Flag either
        // form so playback routes through the existing ADPCM transcode path.
        let audioNeedsTranscode = false;
        let audio: IndexedMp4["audio"] = null;
        try {
            const at = await input.getPrimaryAudioTrack();
            if (at) {
                const audioCodec = await at.getCodec();
                const internalCodecId = await at.getInternalCodecId();
                const isIsobmffImaAdpcm = typeof internalCodecId === "string" && isImaAdpcmSampleEntry(internalCodecId);
                if (isIsobmffImaAdpcm || (audioCodec === null && internalCodecId === "A_MS/ACM")) {
                    audioNeedsTranscode = true;
                }
                audio = {
                    codec: audioCodec ?? (isIsobmffImaAdpcm ? internalCodecId : null),
                    channels: at.numberOfChannels,
                    sampleRate: at.sampleRate,
                };
            }
        } catch {
            // Unreadable audio metadata - leave audio to drop gracefully.
        }

        return {
            indexed: {
                durationSec,
                createdUtc: null,
                codec,
                codecParam: null,
                videoCodecString,
                rotation: 0,
                width,
                height,
                fps,
                audio,
                needsHevcRemux: false,
                audioNeedsTranscode,
            },
        };
    } catch (err) {
        if (err instanceof UnsupportedInputFormatError) {
            log.info("non-isobmff indexing skipped: unsupported format", { file: file.name });
        } else if (err instanceof InputDisposedError) {
            log.debug("non-isobmff indexing aborted: input disposed", { file: file.name });
        } else {
            log.warn("non-isobmff indexing failed", {
                file: file.name,
                err: err instanceof Error ? err.message : String(err),
            });
        }
        return { indexed: null };
    } finally {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        if (input && !input.disposed) input.dispose();
    }
}

/** Routes to the ISOBMFF moov walk or the mediabunny container scan based on
 *  filename extension. The optional signal cuts an in-flight non-ISOBMFF scan on
 *  ingest cancel (see indexNonIsobmffFile); the MP4 path is a bounded moov walk,
 *  fast enough that the worker's loop-boundary abort check suffices, so it takes
 *  no signal. */
export async function indexOneFile(file: File, captureMoov: boolean, signal?: AbortSignal): Promise<IndexedWithMoov> {
    if (isNonIsobmffContainerName(file.name)) {
        return await indexNonIsobmffFile(file, signal);
    }
    return await indexMp4FileWithMoov(file, captureMoov);
}

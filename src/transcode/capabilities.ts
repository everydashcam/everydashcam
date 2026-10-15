// WebCodecs capability probes for playback and re-encode export.
//
// The split / crop / overlay / speed-up export decodes, composites, and
// RE-ENCODES via WebCodecs. mediabunny configures a VideoEncoder for codec "avc"
// as High profile (its buildVideoCodecString hardcodes profile 0x64; only the
// LEVEL is derived, from resolution, bitrate and frame rate) and gates on a single
// VideoEncoder.isConfigSupported with the hardwareAcceleration we pass. On a
// machine with no hardware H.264 encoder and only a Constrained-Baseline software
// one (e.g. Chrome's bundled OpenH264 on a GPU-less Linux box), that High-profile
// config is unsupported and the encode throws mid-export. This probe lets the
// export UI detect that up front and keep the user on stream-copy instead of
// failing with a raw codec error.

import {
    AudioSampleSource,
    canDecodeVideo,
    canEncodeVideo,
    type EncodedPacket,
    getFirstEncodableAudioCodec,
    Quality,
    type VideoCodec,
} from "mediabunny";

import { createLogger } from "../log.js";
import { AUDIO_TARGET_BITRATE, AUDIO_TARGET_CHANNELS, AUDIO_TARGET_SAMPLE_RATE } from "./types.js";
import { h264EncodingConfig } from "./h264-encoding.js";

const log = createLogger("transcode:caps");

/** Probes the indexed codec and profile; callers decide how a failed probe affects playback. */
export function canDecodeVideoStream(codec: VideoCodec, codecString: string | null): Promise<boolean> {
    return canDecodeVideo(codec, codecString ? { codec: codecString } : undefined);
}

/**
 * Picks the audio codec the re-encode export should emit when it has to encode
 * (i.e. cannot stream-copy the source packets): AAC first - universal playback,
 * plays in every container/OS/player - and Opus as the fallback for a browser
 * that cannot encode AAC. The known such browser is codec-stripped Chromium
 * (Linux open-source builds): AAC is a proprietary codec it omits, yet it still
 * bundles libopus, so Opus encode works where AAC does not. Returns null when
 * NEITHER encodes (no audio encoder at all) - the caller drops audio + notifies.
 *
 * Trade-off the caller must surface: Opus-in-MP4 plays in browsers and VLC but
 * NOT in QuickTime / Apple's native players / older Windows, so an Opus fallback
 * is "audio present, but less compatible" - the export flow shows a soft notice.
 *
 * Probes the exact 48 kHz / stereo / 128 kbps config the encode source asks for
 * (AUDIO_TARGET_* shared via types.ts, so the probe can never drift from the real
 * encoder request). Never throws - a probe failure degrades to the next
 * candidate, then to null.
 */
export async function resolveEncodeAudioCodec(
    preference: readonly ("aac" | "opus")[] = ["aac", "opus"],
): Promise<"aac" | "opus" | null> {
    if (preference.length === 0) return null;
    try {
        // Order is the preference. Export callers use the AAC-first default for
        // broad native-player compatibility; the live MSE player may pass an
        // Opus-first list when the browser says it can play Opus-in-MP4. Keeping
        // the playback choice here means the capability probe still exactly
        // matches the encoder that will be constructed.
        // The result is provably one of the two candidates (or null), so the
        // narrowed return type is sound and lets callers (e.g. the MSE worker's
        // mime builder) switch on it without a default branch.
        return (await getFirstEncodableAudioCodec([...preference], {
            numberOfChannels: AUDIO_TARGET_CHANNELS,
            sampleRate: AUDIO_TARGET_SAMPLE_RATE,
            quality: new Quality({ bitrate: AUDIO_TARGET_BITRATE }),
        })) as "aac" | "opus" | null;
    } catch (err) {
        log.debug("audio encode codec probe threw", { err: String(err) });
        return null;
    }
}

/**
 * Audio sample source for any path that decodes to PCM and re-encodes: the MSE
 * player worker's ADPCM transcode, the export stream-copy ADPCM branch, and the
 * re-encode pipelines. `transform` resamples every fed sample to 48 kHz / stereo:
 * for AAC that keeps the encoder on AAC-LC (a mono / low-rate input would make
 * mediabunny pick HE-AAC v1 / mp4a.40.5, which Chromium cannot encode AND which
 * MSE then rejects under the mp4a.40.2 mime); for Opus it satisfies RFC 7845's
 * 48 kHz mandate. `codec` is the result of resolveEncodeAudioCodec.
 *
 * Constraint this leans on: mediabunny's source rejects a mid-track INPUT format
 * change (the guard runs before the transform resampler), so every sample fed -
 * real audio AND emitSilence gaps - must share one source format. Callers
 * guarantee that (export-flow drops audio for mixed-format ranges; silence is
 * emitted at the probed source format, not the 48k/2 target). See feedSegmentAudio.
 *
 * One factory so all four paths request the byte-identical encoder config the
 * probe (resolveEncodeAudioCodec) checks - they can never drift apart.
 */
export function createEncodeAudioSource(
    codec: "aac" | "opus",
    /** Fires for every encoded packet right before it reaches the muxer. */
    onEncodedPacket?: (packet: EncodedPacket) => void,
): AudioSampleSource {
    return new AudioSampleSource({
        codec,
        quality: new Quality({ bitrate: AUDIO_TARGET_BITRATE }),
        transform: { numberOfChannels: AUDIO_TARGET_CHANNELS, sampleRate: AUDIO_TARGET_SAMPLE_RATE },
        onEncodedPacket,
    });
}

/**
 * Whether the browser can encode the H.264 stream the re-encode export emits at
 * the given output size, bitrate and frame rate. Mirrors the pipeline's encoder config:
 * codec "avc" (mediabunny hardcodes High profile 0x64 and derives only the H.264
 * level from resolution, bitrate and frame rate), with the selected acceleration preference.
 *
 * We ask mediabunny's own canEncodeVideo rather than a bare isConfigSupported:
 * it builds the same encoder config the pipeline uses AND, on Firefox (where
 * isConfigSupported lies - mediabunny #222), actually encodes a probe frame.
 * Result is memoized per-config inside mediabunny.
 *
 * The bitrate matters: mediabunny passes it to isConfigSupported, and a mobile
 * encoder rejects a config whose bitrate (and/or the level it implies) exceeds
 * what its hardware supports at that resolution - the same High-profile config
 * it accepts at a lower bitrate. resolveEncodableH264 exploits exactly this.
 *
 * width/height must be even (H.264 requirement; the export path already rounds
 * to even via ensureEven). bitrate is in bits per second. Never throws -
 * returns false when no usable encoder exists.
 */
export async function canReencodeH264(
    width: number,
    height: number,
    bitrate: number,
    frameRate?: number,
    hardwareAcceleration: HardwareAcceleration = "no-preference",
): Promise<boolean> {
    try {
        return await canEncodeVideo("avc", {
            ...h264EncodingConfig(bitrate, hardwareAcceleration),
            width,
            height,
            frameRate,
        });
    } catch (err) {
        // canEncodeVideo is defensive, but guard anyway: a probe failure must
        // degrade to "can't re-encode", never bubble up into the export flow.
        log.debug("h264 encode probe threw", { err: String(err) });
        return false;
    }
}

/** The highest H.264-encodable config the device accepts at a given size. */
export interface EncodableH264 {
    /** Accepted video bitrate in bps. Equal to the desired bitrate when the
     *  device handles it, lower when we had to step down to fit. */
    bitrate: number;
    /** True when bitrate < desired, i.e. quality was reduced to fit the device. */
    degraded: boolean;
}

// Pixel-area floor (w*h*4 * factor) probed before the binary search: the
// lowest bitrate we are willing to fall back to. NOT tied to the UI quality
// presets (High is source-aware now, not a fixed fraction) - this is purely a
// "what can this encoder actually do" lower bound.
const FLOOR_FRACTION = 0.25;

// Binary search stops refining once the bracket is this tight - probing closer
// buys no perceptible quality difference for one extra isConfigSupported round
// trip. Also caps total probes as a backstop against float-rounding stalls.
const SEARCH_STOP_BPS = 200_000;
const MAX_SEARCH_PROBES = 12;

/**
 * Resolves the highest H.264 bitrate this device can actually encode at the
 * given output size, at or below `desiredBitrate`. Probes the desired bitrate
 * first (the ideal); if the device rejects it, probes the floor (w*h*4 *
 * FLOOR_FRACTION) - if even that fails, returns null. Otherwise binary-searches
 * the bracket between the known-good floor and the known-bad desired bitrate,
 * converging on the highest accepted bitrate to within SEARCH_STOP_BPS. This
 * lands much closer to the device's actual ceiling than a fixed ladder of
 * fractions would (a fixed step can leave most of the device's real headroom
 * unused - see the test for a worked example).
 *
 * Why a search over bitrates and not profiles: mediabunny hardcodes High
 * profile (we never override via fullCodecString), but the bitrate is an
 * independent axis the device's encoder checks - lowering it (which also
 * lowers the auto-selected level at smaller resolutions) is what flips
 * isConfigSupported from false to true on a mobile or software encoder. No
 * profile override, so no need to reconstruct mediabunny's internal level
 * table here.
 *
 * Assumes monotonicity (accepted at bitrate B implies accepted at every
 * bitrate < B) - true of every encoder observed so far, since a lower bitrate
 * only relaxes the level the encoder must support.
 *
 * Returns null when even the floor is unencodable - the caller blocks the
 * export and advises lowering the output resolution. width/height must be even.
 */
export async function resolveEncodableH264(
    width: number,
    height: number,
    desiredBitrate: number,
    frameRate?: number,
    hardwareAcceleration: HardwareAcceleration = "no-preference",
): Promise<EncodableH264 | null> {
    if (await canReencodeH264(width, height, desiredBitrate, frameRate, hardwareAcceleration)) {
        return { bitrate: desiredBitrate, degraded: false };
    }
    const floor = Math.round(width * height * 4 * FLOOR_FRACTION);
    if (floor >= desiredBitrate || !(await canReencodeH264(width, height, floor, frameRate, hardwareAcceleration))) {
        return null;
    }

    let good = floor;
    let bad = desiredBitrate;
    for (let probes = 0; bad - good > SEARCH_STOP_BPS && probes < MAX_SEARCH_PROBES; probes++) {
        const mid = Math.round((good + bad) / 2);
        if (await canReencodeH264(width, height, mid, frameRate, hardwareAcceleration)) {
            good = mid;
        } else {
            bad = mid;
        }
    }
    // Only fires when the device actually forced a reduction, and how far it
    // went is the difference between "this device is limited" and "the probe
    // misfired" in a quality report. The panel only tells the user THAT it was
    // capped, never by how much.
    log.info("encode ceiling below request", {
        width,
        height,
        desiredKbps: Math.round(desiredBitrate / 1000),
        acceptedKbps: Math.round(good / 1000),
    });
    return { bitrate: good, degraded: true };
}

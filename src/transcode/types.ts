// Contract between the export UI and the transcode pipeline. Flat: one main
// source range + optional PiP overlay, no editor-style mainTrack[]/pipTrack[]
// - this is a viewer, not an editor. Extend only if multi-segment splicing
// from a single trip is ever needed.

import type { CameraFlip } from "../camera-flip.js";
import type { BlurRegion } from "../blur-regions.js";
import type { Channel, GpsRecord } from "../parsers/types.js";
import type { Trip } from "../trips.js";

import type { CropRect } from "./compose.js";
import type { MapSnapshotter } from "./map-snapshotter-types.js";

/**
 * Aspect id for the pipeline. Discriminated union: 4 named presets (string)
 * OR custom arbitrary dimensions (object). Custom is used when the user picks
 * "As source" (we take the source W×H) or explicitly types a Custom W×H in
 * the output selector - in both cases the ratio is not snapped to a preset.
 */
export type AspectPreset = "16:9" | "9:16" | "4:5" | "1:1";
export type AspectId = AspectPreset | { readonly kind: "custom"; readonly w: number; readonly h: number };

/** Watermark corner on the output frame. null = do not apply. */
export type WatermarkAnchor = "tl" | "tr" | "bl" | "br";

/** Visual system for the burned-in telemetry overlays. "min" is text + drop
 *  shadow (the plate-less default); "card" plates each widget; "bold" makes the
 *  speed a hero readout with a hazard stripe. See STYLE_CHROME. */
export type OverlayStyleId = "min" | "card" | "bold";

/** Mini-map clip shape. "rect" is the legacy rounded rectangle. */
export type MapShape = "rect" | "circle";

/** Letterbox fill mode (single + per-slot in split). */
export type LetterboxFill = "black" | "blur";

/** One main range from a specific trip channel. */
interface TranscodeSource {
    trip: Trip;
    channel: Channel;
    /** Range in trip-local seconds. */
    startTripSec: number;
    endTripSec: number;
}

/** Output parameters. */
interface TranscodeOutput {
    hardwareAcceleration?: HardwareAcceleration;
    /** Target frame height. Width is computed from aspect (compose.computeOutputSize). */
    height: number;
    aspect: AspectId;
    /** Bitrate in bps. null = use default from pixel-area formula (resolveBitrate). */
    bitrate: number | null;
    /** Crop in normalized reflected-image coordinates (0..1). null = full frame. */
    crop: CropRect | null;
    flip?: CameraFlip;
    /** Watermark corner. null = do not apply. */
    watermarkAnchor: WatermarkAnchor | null;
    /** Whether to include an audio track. */
    withAudio: boolean;
    /** Letterbox fill (single mode + slot letterbox in split). Default "black". */
    letterboxFill: LetterboxFill;
    /** GPS-derived overlays painted on every frame. null = no overlays. */
    overlays: OverlayPipelineArgs | null;
    /**
     * Timelapse speed-up factor. 1 = real time (every source frame kept). N > 1
     * keeps every Nth source frame and compresses output timestamps by N, so the
     * clip plays N times faster at the same output fps. See SPEED_FACTORS.
     */
    speedFactor: number;
    /**
     * Privacy blur regions for the active trip (plain data, keyframes on the
     * content axis - see src/blur-regions.ts). The pipeline resolves rects per
     * frame and filters by channel itself; null/empty = no blurring. Any region
     * intersecting the range must force the re-encode path (the stream-copy
     * gate in export-flow owns that).
     */
    blurRegions: BlurRegion[] | null;
}

/**
 * Inputs the pipeline needs to paint GPS-derived overlays. Built from
 * formState + the active trip in the export UI and passed to the worker as
 * plain serializable data. All fields are required so the pipeline can
 * resolve a frame timestamp into a (lat, lon, speedMs) via interpolatePosition
 * without reaching back into the UI module.
 */
export interface OverlayPipelineArgs {
    /**
     * GPS records covering the export range. Subset of trip.records is enough;
     * the pipeline does a binary-search interpolation against this array. We do
     * NOT pre-compute per-frame samples here - a trip-wide records[] is small
     * (few KB) and lets the worker handle hover/range changes without resampling.
     */
    gpsRecords: GpsRecord[];
    // NOTE: there is deliberately NO tripStartUtc here. Frame -> wall-clock
    // resolution goes through contentToWallUtc(trip.timeline, ...) inside the
    // pipelines - a naive `tripStartUtc + contentSec` formula is wrong for
    // trips with recording pauses (the footage axis collapses them).
    /** Wall-clock UTC bounds of the export range (pauses skipped). The map
     *  snapshotter prewarms tiles only for records inside this window - the
     *  export never snapshots outside the range, and a whole-trip walk can
     *  outlast the worker-side first-snapshot timeout on slow networks. */
    rangeStartUtcSec: number;
    rangeEndUtcSec: number;
    /** User units snapshot resolved at modal open. */
    units: "metric" | "imperial";
    /** Browser-local offset (minutes) for the clock widget, matching the chart's
     *  absolute ruler (Intl with no timeZone = browser local), not raw UTC.
     *  0 = UTC. Set by the caller, see export-flow.ts. */
    tzOffsetMin: number;
    /** Localized unit suffixes for the speed and distance readouts ("km/h" vs
     *  "км/ч", "km" vs "км"). Resolved via units.* on the main thread. */
    unitSpeed: string;
    unitDistance: string;
    /** Compass cardinal letters in N, E, S, W order, localized (С/В/Ю/З, ...). */
    cardinals: readonly [string, string, string, string];
    /** Localized short month names, 12 entries Jan..Dec order, for the clock
     *  date line. Built with Intl on the main thread. */
    monthsShort: readonly string[];
    /** Script the overlay locale needs, so the worker loads the matching font
     *  subset: "latin" covers en/de/es/pt/fr/pl (and the zh/ja/ko English
     *  fallback); "cyrillic" adds the ru glyphs. */
    localeScript: "latin" | "cyrillic";
    /** Visual system applied to every widget. See OverlayStyleId. */
    style: OverlayStyleId;
    /** Accent color (hex) for units / brackets / dials. CSS variables do not
     *  exist in the worker, so the resolved color is shipped as data. */
    accent: string;
    /** Dark top+bottom gradient drawn before the widgets for legibility on
     *  bright footage. */
    scrim: boolean;
    /** Braking threshold in g, resolved from events.ts on the main thread (the
     *  worker has no localStorage). The G-force dial flags frames whose derived
     *  deceleration magnitude reaches this. */
    brakeThresholdG: number;
    /** Cumulative haversine distance (meters) at each gpsRecords[i], same length
     *  as gpsRecords. Precomputed in the UI so the per-frame distance is a single
     *  interpolation instead of an O(records) sum every frame. null when the
     *  distance widget is off. */
    cumulativeDistanceM: number[] | null;
    /** ~fixed-count speed samples (m/s) spanning the export range, for the speed
     *  graph sparkline. Precomputed in the UI. null when the graph is off. */
    graphSamples: number[] | null;
    /** Speed readout placement / scale. null = disabled. */
    speed: OverlayTextPipelineOpts | null;
    /** Coordinates readout placement / scale. null = disabled. */
    coords: OverlayTextPipelineOpts | null;
    /** Map slot placement / scale / zoom / shape. null = disabled. */
    map: OverlayMapPipelineOpts | null;
    /** Date + time readout. null = disabled. */
    clock: OverlayTextPipelineOpts | null;
    /** Compass dial (heading). null = disabled. */
    compass: OverlayTextPipelineOpts | null;
    /** G-force dial. null = disabled. */
    gforce: OverlayTextPipelineOpts | null;
    /** Trip distance readout. null = disabled. */
    distance: OverlayTextPipelineOpts | null;
    /** Running speed graph. null = disabled. */
    graph: OverlayTextPipelineOpts | null;
}

export interface OverlayTextPipelineOpts {
    xPct: number;
    yPct: number;
    scalePct: number;
}

export interface OverlayMapPipelineOpts {
    xPct: number;
    yPct: number;
    scalePct: number;
    zoomKm: number;
    shape: MapShape;
    /** Chase camera (heading-up, tilted) rather than north-up. The render
     *  itself reads the full map config on the main thread; the pipeline only
     *  needs to know how a pose change moves pixels, so it can reuse a
     *  snapshot across frames whose camera did not visibly move
     *  (map-snapshot-camera.ts). */
    headingUp: boolean;
    /** Chase only: the zoom follows speed, so a speed change can invalidate
     *  an otherwise identical pose. */
    adaptiveZoom: boolean;
}

export interface TranscodeProgress {
    /** Current pipeline stage. */
    stage: "preparing" | "transcoding" | "finalizing";
    /** Progress 0..1 within the current stage. */
    stageProgress: number;
    /** Overall progress 0..1. */
    totalProgress: number;
    /** Video frames processed / total (approximate). */
    framesDone: number;
    framesTotal: number;
    /** Estimated time remaining in seconds (-1 = unknown during warm-up). */
    etaSec: number;
    /** Bytes already written to the FSA writer (for live readout). */
    bytesWritten: number;
}

/** moov bytes + absolute offset captured from mediabunny's onMoov callback
 *  during muxing. Relayed across the worker boundary so the GPMF post-process
 *  locates moov without re-reading the finished file - on the in-memory (RAM)
 *  export handle that re-read is a full multi-GB getFile() snapshot, exactly
 *  on the memory-constrained path the RAM sink serves. */
export interface CapturedMoovBytes {
    /** Absolute file offset of moov = the gpmd-injection truncate point. */
    position: number;
    /** Raw moov box bytes (copied out of mediabunny's reusable buffer). */
    bytes: Uint8Array;
}

export interface TranscodeResult {
    /** Output duration in seconds. */
    durationSec: number;
    /** Total bytes written. */
    sizeBytes: number;
    /** Number of frames included in the output. */
    framesEncoded: number;
    /** True when the user enabled the map overlay but it was dropped mid-encode
     *  after a snapshot failure (the rest of the frames render without it). The
     *  caller surfaces this so the missing map is not a silent surprise. Absent /
     *  false when no map overlay was requested or it rendered fine. */
    mapOverlayDropped?: boolean;
    /** True when the bounded source-tail policy tolerated a decode failure.
     * The caller surfaces a soft "damaged end" notice. */
    decodeTruncated?: boolean;
    /** True when audio was requested but dropped because the range's segments
     *  carry mixed audio formats (a single output audio track cannot span them).
     *  The caller surfaces a soft "audio dropped" notice; the video saved fine.
     *  Absent/false when audio was off, uniform, or absent. */
    audioDroppedHeterogeneous?: boolean;
    /** True when audio was requested but dropped because the browser has no audio
     *  encoder at all (neither AAC nor Opus) AND the source could not be
     *  stream-copied (e.g. IMA-ADPCM on codec-stripped Chromium). The caller
     *  surfaces a "no sound" notice. Absent/false when audio saved (copied or
     *  encoded). See resolveAudioPlan / resolveEncodeAudioCodec. */
    audioDroppedNoEncoder?: boolean;
    /** True when the re-encode path had to fall back to Opus because the browser
     *  cannot encode AAC. Audio IS present, but Opus-in-MP4 is less compatible
     *  (no QuickTime / Apple native / older Windows) - the caller surfaces a soft
     *  "less compatible audio" notice. Absent/false when audio is AAC (encoded or
     *  copied), copied MP3, or absent. */
    audioReencodedToOpus?: boolean;
    /** Captured moov for the GPMF post-process (see CapturedMoovBytes). */
    capturedMoov?: CapturedMoovBytes;
}

export interface TranscodeArgs {
    source: TranscodeSource;
    output: TranscodeOutput;
    /** FSA writable for streaming mp4 (same contract as exportClip). */
    writable: FileSystemWritableFileStream;
    signal: AbortSignal;
    onProgress: (p: TranscodeProgress) => void;
    /**
     * Map snapshotter for the map overlay. Resolves per-frame to an
     * ImageBitmap. Omit when the map overlay is not in use - the pipeline
     * then skips the map slot entirely. Not serialized through the worker
     * bridge - the worker builds its own snapshotter from the notification
     * channel.
     */
    mapSnapshotter?: MapSnapshotter;
    /** See HardwareAccelerationResolver. Not serialized through the worker
     *  bridge: the worker asks the page for the value instead. */
    resolveHardwareAcceleration?: HardwareAccelerationResolver;
}

/**
 * Supplies the encoder acceleration when the caller is still deciding it (the
 * automatic encoder trial). The pipelines call it once, right before they
 * create the video encoder, so the decision overlaps their own setup instead
 * of delaying the whole export. When set, it replaces
 * output.hardwareAcceleration. A rejection (AbortError on cancel) fails the
 * transcode like any other setup error.
 */
export type HardwareAccelerationResolver = () => Promise<HardwareAcceleration>;

/**
 * Allowed export speed-up factors. 1 = real time, N = the clip plays N times
 * faster (timelapse). Powers of two up to 32: the frame-drop cadence stays
 * exact (every Nth frame) and the high end matches the user-requested range.
 */
export const SPEED_FACTORS = [1, 2, 4, 8, 16, 32] as const;

/**
 * Clamps an arbitrary number to a usable integer speed factor (>= 1). Guards the
 * pipeline against a 0 / NaN / fractional value that would break frame-drop
 * modulo or timestamp division.
 */
export function clampSpeedFactor(n: number): number {
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.round(n);
}

/**
 * Output frame count for a timelapse re-encode: a `totalOutputSec` source range
 * at `fps`, sped up by `speedFactor`, yields about this many kept frames (every
 * Nth). Drives the progress/ETA reporter so the bar reflects kept frames, not
 * the full source frame count. Always >= 1 to avoid a divide-by-zero in ETA.
 */
export function framesForSpeed(totalOutputSec: number, fps: number, speedFactor: number): number {
    const factor = clampSpeedFactor(speedFactor);
    return Math.max(1, Math.round((totalOutputSec * fps) / factor));
}

/**
 * Shared re-encode audio target. The re-encode pipelines resample every audio
 * sample to this format before the encoder, AND the codec probe checks exactly
 * this config via resolveEncodeAudioCodec - one source of truth so the probe can
 * never drift from what the pipeline actually asks the encoder for.
 *
 * 48 kHz / stereo is not just a normalization: it keeps mediabunny on AAC-LC
 * (a mono 16 kHz source would otherwise make it pick HE-AAC v1 / mp4a.40.5,
 * which Chromium cannot encode) and satisfies Opus's RFC 7845 48 kHz mandate, so
 * the same target works for both the AAC and Opus encode codecs. Note this
 * applies only to the ENCODE path; the stream-copy passthrough (AAC/MP3 source
 * at 1x) copies the original packets untouched and ignores this target. Lives
 * here (a leaf both the worker pipelines and the main-thread capabilities module
 * import) rather than in pipeline-common, which drags the overlay code into
 * whatever imports it.
 */
export const AUDIO_TARGET_SAMPLE_RATE = 48_000;
export const AUDIO_TARGET_CHANNELS = 2;
export const AUDIO_TARGET_BITRATE = 128_000;

/**
 * Last-resort bitrate (bps) for a caller that expressed no preference at all
 * (output.bitrate === null). Pixel area alone, knowing nothing about the source
 * - the real budget is chosen from the measured footage in src/export-bitrate.ts
 * and every UI-driven export passes an explicit number. Takes width+height (not
 * height + aspect) because a custom output may have an arbitrary ratio.
 */
export function resolveBitrate(width: number, height: number): number {
    return Math.round(width * height * 4);
}

/** Aspect ratio as a float (width/height). */
export function aspectRatio(a: AspectId): number {
    if (typeof a === "string") {
        const [w, h] = a.split(":").map(Number);
        if (!w || !h) throw new Error(`bad aspect: ${a}`);
        return w / h;
    }
    if (a.h <= 0) throw new Error(`bad custom aspect: h=${a.h}`);
    return a.w / a.h;
}

/** Round up to the nearest even number (H.264 requirement for w/h). */
export function ensureEven(n: number): number {
    const r = Math.round(n);
    return r % 2 === 0 ? r : r + 1;
}

// Export flow: save pipeline driven by inline composition + export panel state.
// Replaces the legacy onExportStart that lived in export-modal.ts. Pure logic,
// no DOM coupling - the export-panel UI hands a progress / done / error
// callback set and consumes the result.
//
// Routing:
//   - composition.layout === "single" + quality = "original" + output = "source"
//     + no overlays + no manual bitrate -> exportClip stream-copy (mediabunny).
//   - composition.layout != "single"                        -> transcodeSplit
//   - else                                                   -> transcode
//
// The pipeline picks the bitrate from the quality preset, the output dims from
// the preset (or source / custom), and the optional overlays/watermark from
// exportPanelState. All UI inputs persist in exportPanelState; this module
// only reads.

import { hasCameraFlip } from "../camera-flip.js";
import { cameraFlipForChannel } from "./camera-flip-pref.js";
import { showSaveFilePicker } from "native-file-system-adapter";

// export.js / gpmd-inject.js / transcode-capabilities carry value imports of
// mediabunny and the transcode audio stack; this module is EAGER (app.ts ->
// export-mode/export-panel), so they are pulled via dynamic import() at their
// run-time call sites to keep that graph out of the landing entry chunk
// (guarded by vite-plugins/lazy-boundaries.ts). Type-only imports stay static.
import type { VideoCodec } from "mediabunny";

import type { ExportClipResult } from "../export.js";
import { resolveOutputFps } from "../transcode/frame-rate.js";
import { reencodeBitrateForQuality } from "../export-bitrate.js";
import {
    buildClipGpx,
    candidatesInRange,
    rangeSourceBitrateBps,
    rangeSourceFps,
    sliceTripChannelForRange,
} from "../export-range.js";
import { recordsHaveGps } from "../parser.js";
import { t, getCurrentLang, getDateLocale, type Lang } from "../i18n/index.js";
import type { I18nKey } from "../i18n/keys.js";
import { createLogger } from "../log.js";
import { captureSentryException } from "../sentry.js";
import { aspectRatio, ensureEven, type CapturedMoovBytes } from "../transcode/types.js";
import type {
    AspectId,
    AspectPreset,
    OverlayPipelineArgs,
    OverlayTextPipelineOpts,
    TranscodeProgress,
    TranscodeResult,
    WatermarkAnchor,
} from "../transcode/types.js";
import { contentToWallUtc, displayTzSec, tripCandidatesByChannel } from "../trips.js";
import type { Trip } from "../trips.js";
import { getBrakeThresholdG } from "../events.js";
import { computeCumulativeDistanceM, sampleSpeedAcross } from "../transcode/frame-pos.js";
import { getUnits } from "../units-pref.js";
import { encoderAcceleration, getEncoderPreference, subscribeEncoderPreference } from "../encoder-pref.js";
import { selectAutoEncoder } from "./encoder-selection.js";

import { anyRegionOnChannels, cloneBlurRegions, type BlurRegion } from "../blur-regions.js";

import { isAllocationFailure } from "./allocation-failure.js";
import { isDestinationLostError, isSinkFailure, tagSinkFailures } from "./destination-error.js";
import { isMediabunnyReadAssert } from "./mediabunny-read-assert.js";
import { isQuotaExceededError } from "./quota-error.js";
import { isSourceReadError } from "../source-read-error.js";
import { dom } from "./dom.js";
import { withFilePicker } from "./file-picker.js";
import { exportPanelState, OVERLAY_STATE_ACCESSORS, type Quality } from "./export-state.js";
import { activeBlurRegions } from "./blur-regions-state.js";
import {
    anyDetectEnabled,
    captureDetectExportRequest,
    detectPassState,
    detectRegions,
    detectStale,
    ensureDetectRegionsForExport,
} from "./blur-detect.js";
import {
    asInMemoryExportHandle,
    createInMemoryFileHandle,
    markNativeSaveBlocked,
    nativeFsaAvailable,
} from "./in-memory-file.js";
import { notify } from "./notifications.js";
import { clipBasename, formatBytes, randomFilenameSuffix } from "./format.js";
import { activeTrip, activeTripHasGps, state, mainChannel } from "./state.js";
import {
    type BeforeCommitHook,
    transcodeSplitViaWorker as transcodeSplit,
    transcodeViaWorker as transcode,
} from "./transcode-shim.js";
import type { GpmdInjectionWritable } from "../export/gpmd-inject.js";

const log = createLogger("export-flow");

/** H.264 requires even dimensions; custom inputs clamp to [240, 3840]. */
const OUTPUT_CUSTOM_MIN = 240;
const OUTPUT_CUSTOM_MAX = 3840;

interface OutputDims {
    width: number;
    height: number;
    aspect: AspectId;
}

interface PresetSpec {
    height: number;
    aspect: AspectPreset;
}

const OUTPUT_PRESETS: Record<string, PresetSpec> = {
    "1080_16x9": { height: 1080, aspect: "16:9" },
    "720_16x9": { height: 720, aspect: "16:9" },
    "1080_9x16": { height: 1080, aspect: "9:16" },
    "720_9x16": { height: 720, aspect: "9:16" },
    "1080_1x1": { height: 1080, aspect: "1:1" },
    "1080_4x5": { height: 1080, aspect: "4:5" },
};

/**
 * Resolves the selected output preset id into final {width, height, aspect}.
 * "source" reads the active video element's natural dims (must have loaded
 * metadata; otherwise 1920x1080 as a sane default). "custom" uses
 * outputCustomW/H clamped to [240, 3840] and rounded to even.
 */
export function resolveOutputDims(): OutputDims {
    const id = exportPanelState.outputPresetId;
    if (id === "custom") {
        const w = clampCustomDim(exportPanelState.outputCustomW);
        const h = clampCustomDim(exportPanelState.outputCustomH);
        return { width: w, height: h, aspect: { kind: "custom", w, h } };
    }
    if (id in OUTPUT_PRESETS) {
        const preset = OUTPUT_PRESETS[id]!;
        const h = ensureEven(preset.height);
        const w = ensureEven(Math.round(h * aspectRatio(preset.aspect)));
        return { width: w, height: h, aspect: preset.aspect };
    }
    // "source": use the active <video> dims if available; else fall back to
    // 1920x1080 (sane default for unknown sources).
    const v = dom.player;
    const sourceW = ensureEven(v?.videoWidth || 1920);
    const sourceH = ensureEven(v?.videoHeight || 1080);
    return { width: sourceW, height: sourceH, aspect: { kind: "custom", w: sourceW, h: sourceH } };
}

function clampCustomDim(n: number): number {
    if (!Number.isFinite(n)) return OUTPUT_CUSTOM_MIN;
    return ensureEven(Math.max(OUTPUT_CUSTOM_MIN, Math.min(OUTPUT_CUSTOM_MAX, Math.round(n))));
}

/**
 * What the footage inside the selected range actually looks like: its average
 * bitrate (summed over the visible cameras - a split composites them all into
 * one output frame, so the content the encoder faces is their sum) and the
 * frame rate the export must run at (the busiest camera's).
 *
 * Measured over the RANGE, not the whole trip: see rangeSourceBitrateBps. Falls
 * back to the whole trip only when no range is set, which is what a save would
 * export anyway.
 */
function measureRangeSource(trip: Trip): { bitrate: number; fps: number | null } {
    const range = exportPanelState.range;
    const startSec = range ? range.startTripSec : 0;
    const endSec = range ? range.endTripSec : trip.timeline.contentDurationSec;
    let bitrate = 0;
    let fps: number | null = null;
    for (const channel of state.composition.channelOrder) {
        const segments = sliceTripChannelForRange(trip, channel, startSec, endSec);
        bitrate += rangeSourceBitrateBps(segments);
        const channelFps = rangeSourceFps(segments);
        if (channelFps !== null && (fps === null || channelFps > fps)) fps = channelFps;
    }
    return { bitrate, fps };
}

/**
 * Single source of truth for the re-encode target bitrate, so the estimate and
 * both real-export branches (split + single-channel) agree.
 *
 * A manual bitrate wins outright over the tier: it is the user overriding our
 * arithmetic on purpose, and silently clamping it to a computed range would make
 * the control a lie. The device encoder probe still applies afterwards - that
 * one is a hard capability limit, not an opinion about quality.
 */
function resolveReencodeBitrate(trip: Trip, dims: OutputDims): number {
    const manualMbps = exportPanelState.manualBitrateMbps;
    if (manualMbps !== null) return manualMbps * 1_000_000;
    const source = measureRangeSource(trip);
    return reencodeBitrateForQuality(exportPanelState.quality, dims.width, dims.height, source.bitrate, source.fps);
}

/** Corner the mark is burned into, or null when the user opted out. Never gates
 *  stream-copy: that path leaves the frames untouched and so carries no mark
 *  either way, which is exactly what the opt-out asks for. */
function watermarkAnchorForExport(): WatermarkAnchor | null {
    return exportPanelState.withWatermark ? exportPanelState.watermarkAnchor : null;
}

/** The quality-independent half of the stream-copy gate: no manual bitrate +
 *  single channel + output=source + black letterbox + no crop + no overlays + real-time. When
 *  this is false the export MUST re-encode regardless of the chosen tier - the
 *  panel uses it to relabel the top tier "Original" -> "High". A speed-up drops
 *  frames and rewrites timestamps (impossible without decoding), so it counts as
 *  re-encode-forcing too. */
function streamCopyEligibleConfig(): boolean {
    return (
        exportPanelState.manualBitrateMbps === null &&
        exportPanelState.outputPresetId === "source" &&
        state.composition.channelOrder.length <= 1 &&
        !state.composition.perSlotCrops[0] &&
        !state.composition.channelOrder.some((ch) => hasCameraFlip(cameraFlipForChannel(ch))) &&
        exportPanelState.letterboxFill === "black" &&
        exportPanelState.speedFactor === 1 &&
        !anyOverlayEnabled() &&
        !anyBlurRegionInExport()
    );
}

/** True when privacy regions require re-encoding on a visible channel. */
function anyBlurRegionInExport(): boolean {
    // A detect checkbox gates too, pessimistically: while its pass is stale or
    // still running we do not yet know whether regions will exist, and the
    // safe assumption is "they will". Only a FRESH empty result (checkbox on,
    // pass ran, nothing found) leaves stream-copy available.
    if (anyDetectEnabled() && (detectStale() || detectPassState() !== null || detectRegions().length > 0)) {
        return true;
    }
    return anyRegionOnChannels(activeBlurRegions(), state.composition.channelOrder);
}

/** Active trip's regions for the worker args - manual zones plus the detection
 *  pass's auto regions; null when none so the pipelines skip the blur path
 *  entirely. Plain data - structured-clones through the worker bridge as-is,
 *  and the clone is a snapshot: edits made mid-export do not affect the
 *  running encode. */
function blurRegionsForExport(manual: readonly BlurRegion[], detected: readonly BlurRegion[]): BlurRegion[] | null {
    const list = [...manual, ...detected];
    return list.length ? list : null;
}

/** True iff stream-copy is possible: the top tier ("original") is selected AND
 *  the config is stream-copy-eligible. quality "medium"/"low" always re-encode. */
function canStreamCopy(): boolean {
    return exportPanelState.quality === "original" && streamCopyEligibleConfig();
}

/**
 * First source file in the export range this browser cannot decode
 * (canPlay=false, typically HEVC without platform decode support), carried as
 * {codec} (the codec itself may be unknown/null), or null when everything
 * decodes. Every re-encode branch decodes exactly these files, so a hit makes
 * any re-encoding config impossible - only stream-copy remains. The panel
 * disables Save with guidance; the save handler backstops.
 */
function undecodableSource(trip: Trip): { codec: VideoCodec | null } | null {
    const range = exportPanelState.range;
    const startSec = range ? range.startTripSec : 0;
    const endSec = range ? range.endTripSec : trip.timeline.contentDurationSec;
    for (const channel of state.composition.channelOrder) {
        const overlapping = candidatesInRange(tripCandidatesByChannel(trip, channel), trip.timeline, startSec, endSec);
        for (const { candidate } of overlapping) {
            if (!candidate.canPlay) return { codec: candidate.codec };
        }
    }
    return null;
}

/** Every widget enable flag, so the stream-copy gate and the args builder agree
 *  on the full set. Derived from the canonical OVERLAY_STATE_ACCESSORS so the
 *  widget set stays in sync with the panel without a hand-kept parallel list. */
function enabledOverlayFlags(): boolean[] {
    return OVERLAY_STATE_ACCESSORS.map((o) => o.state().enabled);
}

function anyOverlayEnabled(): boolean {
    // Overlays draw from GPS - on a trip with no fix they render nothing, so a
    // flag left enabled on a previous (GPS-carrying) trip must not force the
    // re-encode path here (the panel disables the matching checkboxes too).
    return activeTripHasGps() && enabledOverlayFlags().some(Boolean);
}

/** Maps a UI text-overlay state to the worker placement opts, or null when off. */
function textOpts(o: {
    enabled: boolean;
    xPct: number;
    yPct: number;
    scalePct: number;
}): OverlayTextPipelineOpts | null {
    return o.enabled ? { xPct: o.xPct, yPct: o.yPct, scalePct: o.scalePct } : null;
}

// Locales whose script the overlay fonts can render. zh/ja/ko carry no CJK
// glyph in the worker fonts, so their burned-in text falls back to English (and
// Latin units / month names) rather than tofu - see OverlayPipelineArgs.localeScript.
const OVERLAY_CJK_LANGS = new Set<Lang>(["zh", "ja", "ko"]);

/** Font script the overlay locale needs (drives which subset the worker loads). */
function overlayLocaleScript(lang: Lang): "latin" | "cyrillic" {
    return lang === "ru" ? "cyrillic" : "latin";
}

/** 12 localized short month names in Jan..Dec order via Intl. UTC mid-month
 *  dates avoid any locale day-rollover affecting the month. */
function buildShortMonths(localeTag: string): string[] {
    const fmt = new Intl.DateTimeFormat(localeTag, { month: "short", timeZone: "UTC" });
    return Array.from({ length: 12 }, (_, m) => fmt.format(new Date(Date.UTC(2021, m, 15))));
}

/** Builds the worker overlay args from the panel state + trip. Exported so the
 *  live player preview renders from the EXACT same inputs the export uses
 *  (preview == burned-in output). Returns null when no widget is enabled. */
export function buildOverlayPipelineArgs(trip: Trip): OverlayPipelineArgs | null {
    if (trip.records.length === 0) return null;
    if (!anyOverlayEnabled()) return null;
    const s = exportPanelState;

    // Range in footage seconds -> wall-clock UTC bounds (skipping pauses), for
    // the per-range precomputes (graph samples, tz, distance base, file tag).
    const range = s.range ?? { startTripSec: 0, endTripSec: trip.timeline.contentDurationSec };
    const startUtc = contentToWallUtc(trip.timeline, range.startTripSec);
    const endUtc = contentToWallUtc(trip.timeline, range.endTripSec);
    // Zone for the burned-in clock readout, matching the on-screen chart/map:
    // camera clock when known, browser zone otherwise (displayTzSec). A single
    // offset at the range start is enough - a clip is minutes long, well
    // within one DST side.
    const tzOffsetMin = displayTzSec(startUtc, trip.cameraTzSec) / 60;

    // Burned-in text is localized here on the main thread - the worker has no
    // i18n. zh/ja/ko fall back to English labels/cardinals (their dict values
    // are English) and Latin units / month names, because the overlay fonts
    // carry no CJK glyphs (localeScript stays "latin" for them too).
    const lang = getCurrentLang();
    const cjk = OVERLAY_CJK_LANGS.has(lang);
    const units = getUnits();
    const unitSpeed = cjk
        ? units === "imperial"
            ? "mph"
            : "km/h"
        : t(units === "imperial" ? "units.mph" : "units.kmh");
    const unitDistance = cjk ? (units === "imperial" ? "mi" : "km") : t(units === "imperial" ? "units.mi" : "units.km");
    const cardinals: [string, string, string, string] = [
        t("export.overlays.compass.n"),
        t("export.overlays.compass.e"),
        t("export.overlays.compass.s"),
        t("export.overlays.compass.w"),
    ];

    return {
        gpsRecords: trip.records,
        rangeStartUtcSec: startUtc,
        rangeEndUtcSec: endUtc,
        units,
        tzOffsetMin,
        unitSpeed,
        unitDistance,
        cardinals,
        monthsShort: buildShortMonths(cjk ? "en-US" : getDateLocale()),
        localeScript: overlayLocaleScript(lang),
        style: s.overlayStyle,
        accent: s.overlayAccent,
        scrim: s.overlayScrim,
        // Kept even with the brake banner gone: the G-force dial uses it to flag
        // braking frames.
        brakeThresholdG: getBrakeThresholdG(),
        cumulativeDistanceM: s.overlayDistance.enabled ? computeCumulativeDistanceM(trip.records) : null,
        graphSamples: s.overlayGraph.enabled ? sampleSpeedAcross(trip.records, startUtc, endUtc, 80) : null,
        speed: textOpts(s.overlaySpeed),
        coords: textOpts(s.overlayCoords),
        map: s.overlayMap.enabled
            ? {
                  xPct: s.overlayMap.xPct,
                  yPct: s.overlayMap.yPct,
                  scalePct: s.overlayMap.scalePct,
                  zoomKm: s.overlayMap.zoomKm,
                  shape: s.overlayMap.shape,
                  headingUp: s.overlayMap.mode === "chase",
                  adaptiveZoom: s.overlayMap.adaptiveZoom,
              }
            : null,
        clock: textOpts(s.overlayClock),
        compass: textOpts(s.overlayCompass),
        gforce: textOpts(s.overlayGforce),
        distance: textOpts(s.overlayDistance),
        graph: textOpts(s.overlayGraph),
    };
}

/* --------------------- device encode ceiling (re-encode) ------------------ */

// Cache of "what bitrate can THIS device actually encode at the current
// re-encode output size". Populated asynchronously (resolveEncodableH264 awaits
// VideoEncoder.isConfigSupported) so the panel estimate and the Save button can
// reflect the device limit BEFORE the user hits Export, instead of dead-ending
// mid-flow. Null = not applicable (stream-copy) or not yet probed for the
// current config. The real export run probes authoritatively again (cheap -
// mediabunny memoizes), so a stale/pending cache never produces a wrong file.

interface EncodeCeiling {
    /** Config key this entry reflects (dimensions, FPS and desired bitrate). */
    key: string;
    /** Desired (requested) bitrate before any device-fit reduction. */
    desiredBitrate: number;
    /** Accepted bitrate, <= desired. Meaningless when blocked. */
    bitrate: number;
    /** Device can encode but only below the desired bitrate. */
    degraded: boolean;
    /** Device cannot encode at this resolution even at the lowest rung. */
    blocked: boolean;
}

let encodeCeiling: EncodeCeiling | null = null;
// Key of the config a probe is currently in-flight for (or already cached), so
// repeated syncExportPanel ticks with unchanged options do not re-probe.
let encodeCeilingInFlightKey = "";
const encodeCeilingListeners = new Set<() => void>();

/** Subscribes to device-encode-ceiling updates (fired when an async probe
 *  resolves). Returns an unsubscribe function. The panel re-renders the
 *  estimate + Save availability from this. */
export function subscribeEncodeCeiling(listener: () => void): () => void {
    encodeCeilingListeners.add(listener);
    return () => encodeCeilingListeners.delete(listener);
}

function ceilingKey(dims: OutputDims, desiredBitrate: number, frameRate: number): string {
    return `${dims.width}x${dims.height}@${frameRate}:${desiredBitrate}:${getEncoderPreference()}`;
}

/**
 * Refreshes the device encode ceiling for the current export config. No-op for
 * the stream-copy path (no encode) and when the config key is unchanged (avoids
 * re-probing on every unrelated panel tick). Probes asynchronously; on resolve
 * it updates the cache and wakes subscribers so the estimate/Save button update.
 * Safe to call repeatedly from syncExportPanel.
 */
export function refreshEncodeCeiling(): void {
    const trip = activeTrip();
    if (!trip || canStreamCopy()) {
        // Stream-copy or no trip: no encode ceiling applies. Clear so the
        // estimate stops reporting a stale cap from a previous config.
        if (encodeCeiling || encodeCeilingInFlightKey) {
            encodeCeiling = null;
            encodeCeilingInFlightKey = "";
        }
        return;
    }
    const dims = resolveOutputDims();
    const desiredBitrate = resolveReencodeBitrate(trip, dims);
    const frameRate = resolveOutputFps(measureRangeSource(trip).fps);
    const key = ceilingKey(dims, desiredBitrate, frameRate);
    const acceleration = encoderAcceleration(getEncoderPreference());
    if (key === encodeCeilingInFlightKey) return; // already probed / probing
    encodeCeilingInFlightKey = key;
    void import("../transcode/capabilities.js")
        .then(({ resolveEncodableH264 }) =>
            resolveEncodableH264(dims.width, dims.height, desiredBitrate, frameRate, acceleration),
        )
        .then((res) => {
            // Drop a result whose config was superseded while the probe ran.
            if (key !== encodeCeilingInFlightKey) return;
            encodeCeiling = res
                ? { key, desiredBitrate, bitrate: res.bitrate, degraded: res.degraded, blocked: false }
                : { key, desiredBitrate, bitrate: desiredBitrate, degraded: false, blocked: true };
            for (const listener of encodeCeilingListeners) listener();
        });
}

subscribeEncoderPreference(refreshEncodeCeiling);

/** The cached ceiling for the given config, or null if it does not match (stale
 *  / pending / cleared). Used by estimateExport to fold the device cap into the
 *  shown size without itself awaiting. */
function ceilingFor(dims: OutputDims, desiredBitrate: number, frameRate: number): EncodeCeiling | null {
    const current = encodeCeiling;
    if (current && current.key === ceilingKey(dims, desiredBitrate, frameRate)) return current;
    return null;
}

/* ------------------------------ live estimate ----------------------------- */

export interface ExportEstimate {
    /** Estimated file size in bytes. For stream-copy (exact=true) it is the
     *  whole-file average bitrate x clip span - CLOSE but not byte-exact
     *  (bitrate drifts with scene content across the file); symmetric error,
     *  shown as a plain size. For a VBR re-encode it is the TARGET-based size:
     *  the encoder treats the requested bitrate as a soft floor and usually
     *  exceeds it by an amount the WebCodecs spec leaves
     *  "implementation-defined" (observed overshoot ~1.1x to 20x+ across
     *  encoders/content), so no fixed multiplier is honest - the UI shows
     *  this as "from ~X". */
    bytes: number;
    /** True on the stream-copy path: `bytes` is a close symmetric estimate
     *  (vs the re-encode floor). NOT a byte-exactness guarantee. */
    exact: boolean;
    width: number;
    height: number;
    /** Output (played) duration: source span / speedFactor. */
    durationSec: number;
    /** Output codec label: "H.264" (re-encode or H.264 source copy) or "HEVC". */
    codecLabel: string;
    /** Video data-rate (bytes/sec) per quality preset at the current output dims,
     *  for the per-row "~X/s" hint. "original" reflects the source bitrate. */
    rateByQuality: Record<Quality, number>;
    /** Measured average bitrate (bps) of the footage inside the selected range,
     *  across the visible cameras. Shown next to the manual bitrate field as the
     *  reference point for picking a number. 0 when it could not be measured. */
    sourceBitrate: number;
    /** Re-encode path only: the device cannot encode the requested bitrate and
     *  the export will step down to a lower one (bytes already reflects the cap).
     *  False on the stream-copy path and while the device probe is still pending. */
    deviceCapped: boolean;
    /** Re-encode path only: the device cannot encode at this resolution at all,
     *  even at the lowest rung. The panel pre-disables Save and shows guidance. */
    blocked: boolean;
    /** Re-encode path only: a source file in the range this browser cannot
     *  decode ({codec} may itself be unknown/null) - the export cannot run at
     *  all with the current config. null when all sources decode (or on the
     *  stream-copy path, which never decodes). The panel disables Save and
     *  shows the shared codec advice. */
    sourceUndecodable: { codec: VideoCodec | null } | null;
    /** Whether the current config (regardless of selected tier) would let the top
     *  tier stream-copy. False = re-encode is unavoidable, so the panel relabels
     *  the top tier "Original" -> "High". */
    topStreamCopyEligible: boolean;
}

/**
 * Estimates the export output (size, dims, duration, codec) from the current
 * panel state. Reuses the same dim / bitrate / stream-copy resolvers the real
 * export uses, so the preview tracks reality. Pure read; null when there is no
 * active trip or range. Numbers are approximate (source bitrate swings with
 * scene content, ~±20%) - the UI prefixes them with "~".
 */
export function estimateExport(): ExportEstimate | null {
    const trip = activeTrip();
    if (!trip) return null;
    const range = exportPanelState.range;
    if (!range) return null;

    const speedFactor = Math.max(1, exportPanelState.speedFactor);
    const durationSec = Math.max(0, range.endTripSec - range.startTripSec) / speedFactor;
    const dims = resolveOutputDims();
    const source = measureRangeSource(trip);
    const sourceBitrate = source.bitrate;
    const topEligible = streamCopyEligibleConfig();

    // Per-tier "~/s" data rate. The top ("original") row shows what it will
    // actually output: the raw source bitrate when it stream-copies, else the
    // source-matched re-encode target. medium/low are fractions of the capped
    // source. All three stay monotonic (original >= medium >= low). Shown for
    // the tiers themselves even while a manual bitrate overrides them - the rows
    // then read as "what this tier would give", which is what they are.
    const rateByQuality: Record<Quality, number> = {
        original:
            (topEligible
                ? sourceBitrate
                : reencodeBitrateForQuality("original", dims.width, dims.height, sourceBitrate, source.fps)) / 8,
        medium: reencodeBitrateForQuality("medium", dims.width, dims.height, sourceBitrate, source.fps) / 8,
        low: reencodeBitrateForQuality("low", dims.width, dims.height, sourceBitrate, source.fps) / 8,
    };

    const stream = canStreamCopy();
    // Stream-copy size uses the raw source bitrate; a re-encode uses the shared
    // resolveReencodeBitrate so the estimate matches BOTH real-export branches.
    const desiredReencodeBitrate = resolveReencodeBitrate(trip, dims);
    // Fold in the device encode ceiling (re-encode path only). When the device
    // can only encode below the requested bitrate, the shown size must reflect
    // the bitrate that will ACTUALLY be used, not the optimistic request. Null
    // ceiling (stream-copy / probe pending) keeps the optimistic desired value.
    const ceiling = stream ? null : ceilingFor(dims, desiredReencodeBitrate, resolveOutputFps(source.fps));
    const deviceCapped = !!ceiling && ceiling.degraded;
    const blocked = !!ceiling && ceiling.blocked;
    const sourceUndecodable = stream ? null : undecodableSource(trip);
    // Use the bitrate that will actually be encoded: the device cap when it
    // forced a reduction, else the requested bitrate. Stream-copy uses source.
    let videoBitrate: number;
    if (stream) {
        videoBitrate = sourceBitrate;
    } else if (deviceCapped && ceiling) {
        videoBitrate = ceiling.bitrate;
    } else {
        videoBitrate = desiredReencodeBitrate;
    }
    // Audio: a 128 kbps proxy for kept audio; dropped on a sped-up clip (see
    // reencodeAudio). On the re-encode path the source audio is usually
    // stream-copied untouched (AAC/MP3 passthrough), so its real bitrate may differ
    // from 128k - a rough stand-in is fine for a size estimate. NOT added on
    // stream-copy: sourceBitrate derives from file sizes, which already
    // include the source audio track - adding 128k would double-count it. (When
    // audio is dropped the stream-copy estimate still carries the source audio
    // bytes; accepted - a small fraction, and an over-estimate is the safe
    // direction for the RAM pre-size.)
    const audioBitrate = !stream && exportPanelState.withAudio && speedFactor === 1 ? 128_000 : 0;
    // Target-based size. Stream-copy: average source bitrate x clip span -
    // close, but NOT byte-exact (bitrate varies with scene content across the
    // file). Re-encode: a floor (actual VBR output usually larger).
    const bytes = Math.round(((videoBitrate + audioBitrate) / 8) * durationSec);

    return {
        bytes,
        exact: stream,
        width: dims.width,
        height: dims.height,
        durationSec,
        codecLabel: stream ? sourceCodecLabel(trip) : "H.264",
        rateByQuality,
        sourceBitrate,
        deviceCapped,
        blocked,
        sourceUndecodable,
        topStreamCopyEligible: topEligible,
    };
}

/** Localizes an estimate's size: an exact stream-copy size ("≈ X") or a VBR
 *  re-encode floor ("≈ from X"). Shared by the panel's estimate block and the
 *  trim bar's length readout so the two can never phrase the same estimate
 *  differently. */
export function formatEstimatedSize(est: ExportEstimate): string {
    return t(est.exact ? "export.estimate.size" : "export.estimate.sizeFloor", {
        size: formatBytes(est.bytes),
    });
}

/** Display codec for the stream-copy path: the main channel's source codec. */
function sourceCodecLabel(trip: Trip): string {
    const codec = tripCandidatesByChannel(trip, mainChannel())[0]?.codec ?? null;
    return codec === "hevc" ? "HEVC" : "H.264";
}

/* ----------------------------- wake lock ------------------------------- */

let exportWakeLock: WakeLockSentinel | null = null;
let activeExportController: AbortController | null = null;

async function acquireExportWakeLock(): Promise<void> {
    if (!("wakeLock" in navigator)) return;
    if (exportWakeLock) return;
    try {
        exportWakeLock = await navigator.wakeLock.request("screen");
        exportWakeLock.addEventListener("release", () => {
            exportWakeLock = null;
        });
    } catch (err) {
        log.debug("wake-lock acquire failed", { err: String(err) });
    }
}

async function releaseExportWakeLock(): Promise<void> {
    const lock = exportWakeLock;
    if (!lock) return;
    exportWakeLock = null;
    try {
        await lock.release();
    } catch (err) {
        log.debug("wake-lock release failed", { err: String(err) });
    }
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!activeExportController) return;
    if (exportWakeLock) return;
    void acquireExportWakeLock();
});

/* ------------------------------- post-process telemetry ------------------- */

type DownloadBlobFn = (blob: Blob, name: string) => void;

async function postProcessTelemetry(
    trip: Trip,
    startTripSec: number,
    endTripSec: number,
    mp4Handle: Awaited<ReturnType<typeof showSaveFilePicker>>,
    withGpmf: boolean,
    onProgressStatus: (s: string) => void,
    signal?: AbortSignal,
    capturedMoov?: CapturedMoovBytes,
    // The still-open output (re-encode: the real writable the worker streamed
    // into, handed over by the before-commit hook). With capturedMoov the track
    // is written in place before the commit; without it the committed file is
    // re-opened - on native FSA that copies the whole export into a swap file.
    openWritable?: GpmdInjectionWritable,
): Promise<boolean> {
    // GPX is handled up front in runExportFlow (independent download); this
    // post-process only does the in-MP4 GPMF track injection. Returns whether a
    // gpmd track ended up in the file: true when not requested (nothing to do, no
    // failure), the injection result otherwise. The caller surfaces a notice when
    // the user asked for telemetry but it was not embedded.
    if (!withGpmf) return true;
    onProgressStatus(t("export.progress.embeddingGps"));
    // GPMF lives on the footage axis to match the video track. startTripSec/
    // endTripSec are already content-sec, so pass them through. capturedMoov
    // (relayed from the transcode worker's muxer) lets the injection locate
    // moov without re-reading the finished file - on the in-memory handle that
    // re-read was a full multi-GB getFile() snapshot on the exact
    // memory-constrained path the RAM sink serves.
    const { injectClipGpmf } = await import("../export/gpmd-inject.js");
    return injectClipGpmf({
        handle: mp4Handle as unknown as FileSystemFileHandle,
        writable: openWritable,
        trip,
        clipContentStartSec: startTripSec,
        clipContentEndSec: endTripSec,
        signal,
        capturedMoov: capturedMoov ? { startAbs: capturedMoov.position, bytes: capturedMoov.bytes } : undefined,
    });
}

/**
 * Surfaces export degradations the user did not ask for but silently got: their
 * requested GPS telemetry was not embedded, or the configured map overlay was
 * dropped mid-encode. The clip itself saved fine (hence warn, not error). The
 * underlying errors are already logged in gpmd-inject / the pipeline; this only
 * tells the user. Gated on the request flag so a non-requested feature is silent.
 */
function notifyExportDegradations(opts: {
    gpmfRequested: boolean;
    gpmfInjected: boolean;
    mapOverlayDropped?: boolean;
    decodeTruncated?: boolean;
    audioDroppedHeterogeneous?: boolean;
    audioDroppedNoEncoder?: boolean;
    audioReencodedToOpus?: boolean;
}): void {
    if (opts.gpmfRequested && !opts.gpmfInjected) {
        notify({ severity: "warn", messageKey: "export.notify.gpmfFailed" });
    }
    if (opts.mapOverlayDropped) {
        notify({ severity: "warn", messageKey: "export.notify.mapDropped" });
    }
    if (opts.decodeTruncated) {
        notify({ severity: "warn", messageKey: "export.notify.damagedEnd" });
    }
    if (opts.audioDroppedHeterogeneous) {
        notify({ severity: "warn", messageKey: "export.notify.audioFormatMixed" });
    }
    if (opts.audioDroppedNoEncoder) {
        notify({ severity: "warn", messageKey: "export.notify.audioEncodeUnsupported" });
    }
    if (opts.audioReencodedToOpus) {
        notify({ severity: "warn", messageKey: "export.notify.audioFallbackOpus" });
    }
}

/* ------------------------------ main flow ------------------------------- */

export interface ExportDoneSummary {
    fileName: string;
    durationSec: number;
    sizeBytes: number;
    hasGpx: boolean;
    gpxName: string | null;
    /** No-native-FSA (RAM) path only: the finished MP4 lives in an in-memory
     *  buffer, not yet in the user's Downloads. The done view renders a Download
     *  button that saves it via a fresh user gesture (a programmatic download
     *  after the long export is blocked by the recent-activation guard - same
     *  reason GPX is fired up front). Absent on the native path, where the file
     *  is already on disk. */
    pendingDownload?: { kind: "blob"; blob: Blob; name: string };
}

export interface ExportFlowHooks {
    /** Status string for the progress bar header (i18n already resolved). */
    onStatus: (status: string) => void;
    /** Determinate progress from the transcode pipeline (per-frame). */
    onProgress: (p: TranscodeProgress) => void;
    /** Determinate fill (0..1) for the stream-copy path, which reports progress
     *  as a human-readable status string rather than a TranscodeProgress. */
    onProgressFill?: (fraction: number) => void;
    /** Switches the bar to/from an indeterminate animation. Used on the final
     *  disk-commit phase, whose flush has no observable progress. */
    onProgressIndeterminate?: (on: boolean) => void;
    /** Completion summary. */
    onDone: (s: ExportDoneSummary) => void;
    /** Error path. Takes an i18n key (+ params) rather than a resolved string so
     *  the panel can re-localize the error on a language switch, and so a raw
     *  browser exception never reaches the user - the flow always maps a failure
     *  to a localized error key. */
    onError: (messageKey: I18nKey, params?: Record<string, string | number | boolean>) => void;
    /** Called when the export is cancelled (user clicked Cancel). */
    onCancel: () => void;
    /** Fired once the save-file picker resolves (handle acquired) - the point at
     *  which the UI should switch to the progress view. NOT called if the user
     *  cancels the picker, so the panel stays on the options form. */
    onExportStart?: () => void;
    /** Wrapper for downloading the GPX side file (passed in so the panel can
     *  inject a custom downloader if needed). Default browser download. */
    downloadBlob: DownloadBlobFn;
    /** Called before the export begins (after the save picker resolves), and
     *  again with false in the finally block. Used to disable / re-enable the
     *  player-bar Export button (existing setExportInProgress hook). */
    onInProgress: (inProgress: boolean) => void;
}

// True from runExportFlow entry to its settle. Spans the WHOLE flow including
// the pre-controller awaits (save picker, encode preflight) - guarding on
// activeExportController alone left those windows open to a double-click.
let exportFlowInFlight = false;

/**
 * Runs the export. Snapshots configuration from the inline state singletons
 * (exportPanelState + state.composition + state.active) synchronously at entry,
 * before its first await. The function handles its own save-file picker; the
 * caller only supplies UI hooks.
 *
 * Calls onDone on success, onError on failure, onCancel on user abort. The
 * AbortController is stored module-side so visibilitychange can re-acquire
 * the wake lock during a long export.
 *
 * Re-entrant calls are ignored: a second concurrent flow would clobber
 * activeExportController (Cancel then aborts only the newer run) and the
 * first finisher's cleanup would fire under the still-running one. Reachable
 * via Save double-click on the no-native path (no modal picker swallows the
 * second click) or via the E hotkey re-opening the panel mid-export.
 */
export async function runExportFlow(hooks: ExportFlowHooks): Promise<void> {
    if (exportFlowInFlight) {
        log.warn("export already in progress - second run ignored");
        return;
    }
    exportFlowInFlight = true;
    try {
        await runExportFlowInner(hooks);
    } finally {
        exportFlowInFlight = false;
    }
}

async function runExportFlowInner(hooks: ExportFlowHooks): Promise<void> {
    const trip = activeTrip();
    if (!trip) {
        // Guards the UI normally prevents (no export button without a trip/range);
        // if one does fire, show the neutral fallback rather than a raw string.
        hooks.onError("export.error.generic");
        return;
    }
    const range = exportPanelState.range;
    if (!range) {
        hooks.onError("export.error.generic");
        return;
    }
    const startTripSec = range.startTripSec;
    const endTripSec = range.endTripSec;

    // GPS-dependent options collapse to off on a trip with no fix: a stale tick
    // carried over from a previous (GPS-carrying) trip must not embed an empty
    // telemetry track or write a point-less .gpx. The panel already disables
    // these checkboxes; this is the matching pipeline-side gate. Overlays are
    // gated the same way via anyOverlayEnabled (same recordsHaveGps predicate).
    const hasGps = recordsHaveGps(trip.records);
    const withGpmf = exportPanelState.withGpmf && hasGps;
    const withGpx = exportPanelState.withGpx && hasGps;

    // Capture every mutable input BEFORE the first await. Native pickers,
    // capability probes and detector/model work can all suspend for seconds or
    // minutes. Reading the active singleton afterwards used to let a trip,
    // layout or blur edit from the future leak into this already-started run
    // (in the worst case re-enabling stream-copy and shipping raw frames).
    const channelOrder = [...state.composition.channelOrder];
    const slotFlips = channelOrder.map((ch) => ({ ...cameraFlipForChannel(ch, trip) }));
    const channel = channelOrder[0] ?? mainChannel();
    const layout = state.composition.layout;
    const slotCrops = state.composition.perSlotCrops.map((crop) => (crop ? { ...crop } : null));
    const slotPipPositions = state.composition.perSlotPipPositions.map((pos) => (pos ? { ...pos } : null));
    const slotPipScales = [...state.composition.perSlotScales];
    const quality = exportPanelState.quality;
    const encoderPreference = getEncoderPreference();
    const manualBitrateMbps = exportPanelState.manualBitrateMbps;
    const outputPresetId = exportPanelState.outputPresetId;
    const letterboxFill = exportPanelState.letterboxFill;
    const speedFactor = exportPanelState.speedFactor;
    const withAudio = exportPanelState.withAudio;
    const watermarkAnchor = watermarkAnchorForExport();
    const overlays = buildOverlayPipelineArgs(trip);
    const mapConfig = overlays?.map
        ? { ...exportPanelState.overlayMap, marker: { ...exportPanelState.overlayMap.marker } }
        : null;
    const dims = resolveOutputDims();
    const desiredBitrate = resolveReencodeBitrate(trip, dims);
    const frameRate = resolveOutputFps(measureRangeSource(trip).fps);
    const sourceUndecodable = undecodableSource(trip);
    const expectedBytes = estimateExport()?.bytes ?? 0;
    const manualBlurRegions = cloneBlurRegions(activeBlurRegions());
    const detectRequest = captureDetectExportRequest();
    const initiallyStreamCopy = canStreamCopy();
    const streamCopyWithoutDetectedRegions =
        quality === "original" &&
        manualBitrateMbps === null &&
        outputPresetId === "source" &&
        channelOrder.length <= 1 &&
        !slotCrops[0] &&
        !slotFlips.some(hasCameraFlip) &&
        letterboxFill === "black" &&
        speedFactor === 1 &&
        overlays === null &&
        !anyRegionOnChannels(manualBlurRegions, channelOrder);

    if (dom.player && !dom.player.paused) dom.player.pause();

    const basename = `${clipBasename(trip, startTripSec, endTripSec)}_${randomFilenameSuffix()}`;
    const fileName = `${basename}.mp4`;

    // Export sink, picked by capability:
    //   1. Native save picker (Chromium desktop) - streams straight to disk, any
    //      size, GPMF injected in place after finalize.
    //   2. In-memory shim (no native picker: Firefox, Safari, mobile) - the whole
    //      MP4 is built in RAM, GPMF injected on the re-readable buffer, then
    //      handed to a plain blob download. NOT pre-gated by size: we cannot read
    //      RAM on Safari/Firefox, so a guessed cap only false-blocks clips the
    //      machine could handle. The export always attempts; if the buffer cannot
    //      be allocated it throws and the catch surfaces a clean "use desktop
    //      Chrome" message. The panel shows a persistent "builds in memory" hint
    //      (fallbackWarn) so the user knows large clips may run out of RAM.
    // We deliberately do NOT stream to disk via OPFS / the service worker on
    // no-native browsers: a streamed, write-once sink cannot be re-read for the
    // post-finalize GPMF injection, and embedded telemetry is a hard product
    // requirement. RAM keeps one simple, reliable path that always carries GPMF.
    const noNative = !nativeFsaAvailable();

    // Drives the done-view delivery (see buildPendingDownload).
    let deliveryMode: "ram" | "native" = noNative ? "ram" : "native";

    let mp4Handle: Awaited<ReturnType<typeof showSaveFilePicker>> | null = null;
    if (!noNative) {
        try {
            const picked = await withFilePicker(
                "save",
                () =>
                    showSaveFilePicker({
                        suggestedName: fileName,
                        types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
                    }),
                () => hooks.onError("filePicker.busy"),
            );
            if (!picked) return;
            mp4Handle = picked;
        } catch (err) {
            if (err instanceof Error && err.name === "AbortError") return;
            log.warn("save picker failed", { err: err instanceof Error ? err.message : String(err) });
            if (__PORTABLE__ && err instanceof Error && err.name === "SecurityError") {
                markNativeSaveBlocked();
                deliveryMode = "ram";
                notify({ severity: "warn", messageKey: "portable.export.memory" });
            } else {
                hooks.onError("export.error.generic");
                return;
            }
        }
    }
    // User-facing name for the download, GPX sidecar and done summary. Native:
    // the name the user picked in the save dialog. RAM: the suggested fileName.
    const downloadName = mp4Handle?.name ?? fileName;

    // Re-encode preflight: split / crop / overlays / speed-up all decode and
    // RE-ENCODE via WebCodecs, and the pipeline emits a High-profile H.264
    // stream. A mobile (or GPU-less) encoder may reject that config at the
    // requested bitrate/resolution and the worker would throw a raw codec error
    // mid-export. resolveEncodableH264 finds the highest bitrate this device
    // CAN encode at the chosen size: full request when it fits, a lower rung
    // when it does not, or null when even the lowest rung is unencodable. Done
    // AFTER the picker so its user activation is spent on showSaveFilePicker,
    // not on the probe's await; we abort before writing anything to the handle.
    // The picked bitrate flows into the transcode branches below so the encode
    // matches the probe. The panel already surfaced this via the estimate; this
    // is the authoritative backstop (and the only gate if the user clicked Save
    // before the panel's async probe resolved).
    let reencodeBitrate = 0;
    let hardwareAcceleration = encoderAcceleration(encoderPreference);
    if (!initiallyStreamCopy) {
        // Decode preflight: a source this browser cannot decode makes every
        // re-encode branch impossible. The panel already disables Save with
        // guidance; this backstops a Save clicked before the panel synced.
        if (sourceUndecodable) {
            log.warn("re-encode export blocked: source not decodable in this browser", {
                codec: sourceUndecodable.codec,
            });
            hooks.onError("export.error.sourceNotPlayable");
            return;
        }
        const { resolveEncodableH264 } = await import("../transcode/capabilities.js");
        const encodable = await resolveEncodableH264(
            dims.width,
            dims.height,
            desiredBitrate,
            frameRate,
            hardwareAcceleration,
        );
        if (!encodable) {
            log.warn("re-encode export blocked: device cannot encode at this resolution", {
                width: dims.width,
                height: dims.height,
                desiredBitrate,
            });
            hooks.onError(
                encoderPreference === "auto"
                    ? "export.error.cannotEncodeResolution"
                    : "export.error.encoderUnavailable",
            );
            return;
        }
        reencodeBitrate = encodable.bitrate;
        if (encodable.degraded) {
            log.info("re-encode bitrate reduced to fit device", {
                width: dims.width,
                height: dims.height,
                desiredBitrate,
                bitrate: encodable.bitrate,
            });
        }
        // Audio is handled inside the worker pipeline (resolveAudioPlan): it
        // stream-copies an AAC/MP3 source untouched (no encoder needed - the case
        // that used to lose audio on codec-stripped Chromium), re-encodes other
        // sources to AAC or, when AAC encode is unavailable, falls back to Opus,
        // and only drops audio when no encoder exists at all. The outcome
        // (dropped / Opus fallback) rides back in TranscodeResult and surfaces
        // after the clip saves.
    }

    // Picker resolved (not cancelled) - only now switch the UI to the progress
    // view. Cancelling the picker returns above without firing this, leaving the
    // options form intact; the caller unlocks it when this flow settles.
    hooks.onExportStart?.();

    activeExportController = new AbortController();
    const exportDurationSec = endTripSec - startTripSec;
    // The produced file's duration: the source span compressed by the speed
    // factor (equals exportDurationSec at 1x / stream-copy).
    const outputDurationSec = exportDurationSec / Math.max(1, speedFactor);
    // Audio is meaningless on a sped-up clip (no WebCodecs pitch-shift; it would
    // desync). Drop it whenever speed > 1, regardless of the panel toggle. The
    // no-encoder drop now happens inside the worker (resolveAudioPlan) and is
    // reported back in TranscodeResult, not gated here.
    const reencodeAudio = withAudio && speedFactor === 1;
    const isSplit = channelOrder.length > 1;
    // let, not const: the detection pre-pass below can settle a pessimistic
    // "assume blur" gate into a fresh empty result, re-enabling stream-copy.
    let streamCopy = initiallyStreamCopy;
    const exportStartedAt = performance.now();
    let lastProgress: TranscodeProgress | null = null;
    const onTranscodeProgress = (progress: TranscodeProgress): void => {
        lastProgress = { ...progress };
        hooks.onProgress(progress);
    };
    // Capture counts before awaits can change the active trip. No filenames,
    // coordinates or recording dates belong in the export diagnostic.
    const segmentCounts = channelOrder.map((ch) => sliceTripChannelForRange(trip, ch, startTripSec, endTripSec).length);

    hooks.onInProgress(true);
    void acquireExportWakeLock();
    hooks.onStatus(t("export.status.preparing"));

    // GPX is independent of the MP4 output - it is built straight from
    // trip.records - so save it now, up front, while the save-picker's user
    // activation is still fresh. Firing it AFTER a long re-encode (the old
    // behavior) tripped Chrome's "programmatic download without a recent user
    // gesture" guard, and the sidecar silently never saved. This is a plain
    // anchor download (downloadBlob), independent of the FSA mp4 stream, so it
    // lands in the default downloads folder regardless of stream-copy vs
    // re-encode.
    //
    // Trade-off: because this fires before the MP4 export, a later abort
    // (Cancel) or export error leaves an orphan .gpx with no matching MP4.
    // Accepted on purpose - a stray sidecar the user can delete is the lesser
    // evil vs the stale-gesture path where the GPX silently never saved. There
    // is no good middle ground: GPX must go either before the export (orphan
    // risk) or after it (stale-gesture silent-loss risk).
    let gpxName: string | null = null;
    if (withGpx) {
        try {
            // Range is footage-axis (content) seconds - what buildClipGpx wants.
            const gpxText = buildClipGpx(trip, startTripSec, endTripSec);
            gpxName = `${downloadName.replace(/\.mp4$/i, "")}.gpx`;
            hooks.downloadBlob(new Blob([gpxText], { type: "application/gpx+xml" }), gpxName);
        } catch (err) {
            log.error("gpx export failed", err);
            gpxName = null;
        }
    }

    let writable: FileSystemWritableFileStream;
    let sizeBytes = 0;
    // No-native (RAM) path: the finished File from the in-memory buffer, captured
    // for the done-view Download button. The file is not in Downloads yet - a
    // fresh user gesture saves it (the post-export programmatic download is
    // blocked by the recent-activation guard). Null on the native path.
    let producedFile: File | null = null;
    const buildPendingDownload = (): ExportDoneSummary["pendingDownload"] => {
        if (!producedFile) return undefined;
        // RAM: anchor download of the in-memory blob via the done-view button.
        if (deliveryMode === "ram") return { kind: "blob", blob: producedFile, name: downloadName };
        // Native: already saved to disk by the picker.
        return undefined;
    };
    // Shared success tail for the stream-copy and re-encode branches: delivery,
    // degradation notices, done summary, telemetry. One implementation so a fix
    // cannot land on one branch only (the size-read block used to be a verbatim
    // copy in both).
    const finishExport = async (
        handle: Awaited<ReturnType<typeof showSaveFilePicker>>,
        opts: {
            gpmfInjected: boolean;
            mapOverlayDropped?: boolean;
            decodeTruncated?: boolean;
            audioDroppedHeterogeneous?: boolean;
            audioDroppedNoEncoder?: boolean;
            audioReencodedToOpus?: boolean;
        },
    ): Promise<void> => {
        const inMem = asInMemoryExportHandle(handle);
        if (inMem) {
            // RAM path: takeDownloadBlob() IS the delivery, not a cosmetic
            // size read - its snapshot allocates the full file size again and
            // can legitimately OOM on the multi-GB exports this path serves.
            // No try/catch: the failure must reach the outer catch, which maps
            // allocation failures to export.error.tooLargeForMemory. Swallowing
            // it rendered a success view with no Download button and the
            // output irrecoverably lost.
            const f = inMem.takeDownloadBlob();
            sizeBytes = f.size;
            producedFile = f;
        } else {
            try {
                // Native path: the file is already on disk; getFile() here only
                // feeds the size figure in the done summary. THAT is the
                // genuinely cosmetic read (unreliable in some FSA polyfill
                // paths), so only this branch may swallow.
                sizeBytes = (await handle.getFile()).size;
            } catch (err) {
                // Breadcrumb for a "done summary says 0 MB" report.
                log.debug("export size read failed", { err: String(err) });
            }
        }
        notifyExportDegradations({
            gpmfRequested: withGpmf,
            gpmfInjected: opts.gpmfInjected,
            mapOverlayDropped: opts.mapOverlayDropped,
            decodeTruncated: opts.decodeTruncated,
            audioDroppedHeterogeneous: opts.audioDroppedHeterogeneous,
            audioDroppedNoEncoder: opts.audioDroppedNoEncoder,
            audioReencodedToOpus: opts.audioReencodedToOpus,
        });
        hooks.onDone({
            fileName: downloadName,
            durationSec: outputDurationSec,
            sizeBytes,
            hasGpx: !!gpxName,
            gpxName,
            pendingDownload: buildPendingDownload(),
        });
    };
    // Auto blur regions from the detection pass, resolved below before the
    // encode branches read them.
    let detectedBlurRegions: BlurRegion[] = [];
    try {
        // Even the empty RAM handle allocates. Keep it after capability probes
        // and inside this catch so allocation failure always reaches the UI.
        mp4Handle ??= createInMemoryFileHandle(fileName, expectedBytes) as unknown as Awaited<
            ReturnType<typeof showSaveFilePicker>
        >;
        // Detection pre-pass (the "blur all plates / faces" checkboxes): must
        // settle BEFORE the encode so found regions burn into THIS export.
        // Placed after the GPX download - that anchor download rides the save
        // picker's user activation, and a multi-minute pass would stale it.
        // Usually a fast cache hit: the checkbox toggle already ran the pass
        // over this range; this is the export-time guarantee for the leftovers
        // (range nudged right before Save, pass still running, etc.).
        if (detectRequest) {
            hooks.onStatus(t("export.progress.detecting"));
            detectedBlurRegions = await ensureDetectRegionsForExport(
                detectRequest,
                activeExportController.signal,
                (fraction) => hooks.onProgressFill?.(fraction),
            );
            hooks.onStatus(t("export.status.preparing"));
            // A fresh empty result may settle the initial pessimistic gate back
            // to copy, but ONLY against the captured config/manual zones.
            streamCopy = streamCopyWithoutDetectedRegions && detectedBlurRegions.length === 0;
        }

        const effectiveBlurRegions = blurRegionsForExport(manualBlurRegions, detectedBlurRegions);

        if (!streamCopy && encoderPreference === "auto") {
            hooks.onStatus(t("export.progress.checkingEncoder"));
            const selection = await selectAutoEncoder(
                {
                    width: dims.width,
                    height: dims.height,
                    frameRate,
                    bitrate: reencodeBitrate || desiredBitrate,
                },
                activeExportController.signal,
            );
            hardwareAcceleration = selection.hardwareAcceleration;
            if (selection.hardwareAcceleration === "prefer-software")
                notify({ severity: "warn", messageKey: "export.notify.softwareEncoder" });
            hooks.onStatus(t("export.status.preparing"));
        }
        activeExportController.signal.throwIfAborted();

        // Tagged so a failure thrown by the SINK can be told apart from a
        // source-side one that shares its DOMException name (see destination-error.ts).
        writable = tagSinkFailures(await mp4Handle.createWritable());

        log.info("export settings", {
            mode: streamCopy ? "stream-copy" : isSplit ? "composite" : "single",
            quality,
            manualBitrateMbps,
            outputPresetId,
            width: dims.width,
            height: dims.height,
            frameRate,
            speedFactor,
            desiredBitrate: streamCopy ? null : desiredBitrate,
            encodeBitrate: streamCopy ? null : reencodeBitrate || desiredBitrate,
            encoderPreference,
            hardwareAcceleration: streamCopy ? null : hardwareAcceleration,
        });

        if (streamCopy) {
            // exportClip closes `writable` itself via output.finalize() on
            // success. On abort/error it throws BEFORE finalize, so mediabunny
            // never closes the StreamTarget writer and the writable stays open
            // (native: its .crswap temp lingers on disk; RAM: the working buffer
            // is held). Abort it to discard the partial file and release the
            // handle. abort() (not close()) so a truncated MP4 is not committed.
            // Mirrors transcode-shim's forceAbort on the re-encode path.
            let streamCopyOk = false;
            let clipResult: ExportClipResult | null = null;
            // Quiesce the viewer map's rAF marker loop (map.ts guards on this
            // flag) for the duration of the stream copy. exportClip runs ON THE
            // MAIN THREAD - its packet loop + moov sample-table build otherwise
            // contend with the per-frame map rAF behind the export modal. The
            // re-encode path sets this via transcode-shim; stream-copy never did.
            // No GPU class (dc-transcode-busy) here: stream-copy has no encoder,
            // so there is no encoder/GPU contention to relieve - only the CPU
            // rAF callback to suppress.
            state.transcodeInProgress = true;
            try {
                const { exportClip } = await import("../export.js");
                clipResult = await exportClip({
                    trip,
                    channel,
                    startTripSec,
                    endTripSec,
                    withAudio,
                    withGpmf,
                    mp4Writable: writable,
                    mp4Handle: mp4Handle as unknown as FileSystemFileHandle,
                    onProgress: (p) => {
                        hooks.onStatus(p.stage);
                        // Drive the bar fill too - otherwise stream-copy leaves it
                        // at 0% the whole time and reads as a freeze.
                        if (typeof p.pct === "number") hooks.onProgressFill?.(p.pct / 100);
                        // Final disk-commit phase has no measurable progress -
                        // switch to an indeterminate bar so it does not look hung.
                        hooks.onProgressIndeterminate?.(p.indeterminate === true);
                    },
                    signal: activeExportController.signal,
                });
                streamCopyOk = true;
            } finally {
                // Resume the map rAF loop regardless of outcome.
                state.transcodeInProgress = false;
                if (!streamCopyOk) {
                    // try/catch (not .catch) so a writable that is already
                    // terminal - or lacks abort entirely - never throws here and
                    // masks exportClip's original error.
                    try {
                        await writable.abort("export cancelled or failed");
                    } catch {
                        /* writable already terminal / no abort - nothing to clean */
                    }
                }
            }
            // Stream-copy can never carry a map overlay (canStreamCopy requires
            // no overlays), so only the GPMF outcome is relevant here.
            await finishExport(mp4Handle, {
                gpmfInjected: clipResult?.gpmfInjected ?? false,
                audioDroppedHeterogeneous: clipResult?.audioDroppedHeterogeneous,
            });
        } else {
            // Re-encode path (split-screen or single-channel re-encode). The two
            // transcode calls differ only in their args; the delivery/done tail
            // is the shared finishExport below.
            let transcodeResult: TranscodeResult;
            // GPMF goes into the still-open output between the worker's finalize
            // and the disk commit, so the committed file is written exactly once.
            // Null until the hook ran; the hook leaves it null when the worker
            // relayed no moov, and the post-commit re-open below takes over.
            let gpmfInjectedBeforeCommit: boolean | null = null;
            // Narrowed alias: the hook is a closure, where TypeScript forgets that
            // mp4Handle was assigned above.
            const outputHandle = mp4Handle;
            const injectBeforeCommit: BeforeCommitHook | undefined = withGpmf
                ? async (openWritable, result) => {
                      if (!result.capturedMoov) return;
                      gpmfInjectedBeforeCommit = await postProcessTelemetry(
                          trip,
                          startTripSec,
                          endTripSec,
                          outputHandle,
                          withGpmf,
                          hooks.onStatus,
                          activeExportController?.signal,
                          result.capturedMoov,
                          openWritable,
                      );
                  }
                : undefined;
            if (isSplit) {
                // Device-fit bitrate from the preflight (full request when the
                // device handles it, a lower rung when it does not). Fallback
                // keeps this defensive if the preflight somehow left it unset.
                const bitrate = reencodeBitrate || desiredBitrate;
                transcodeResult = await transcodeSplit(
                    {
                        source: {
                            trip,
                            slotChannels: channelOrder,
                            startTripSec,
                            endTripSec,
                        },
                        output: {
                            height: dims.height,
                            aspect: dims.aspect,
                            layout,
                            bitrate,
                            hardwareAcceleration,
                            watermarkAnchor,
                            withAudio: reencodeAudio,
                            speedFactor,
                            slotCrops,
                            slotFlips,
                            overlayPositions: slotPipPositions,
                            slotPipScales,
                            letterboxFill,
                            overlays,
                            blurRegions: effectiveBlurRegions,
                        },
                        writable,
                        signal: activeExportController.signal,
                        onProgress: onTranscodeProgress,
                        // The final disk-commit flush is opaque (no progress events) -
                        // sweep an indeterminate bar for its duration, like stream-copy.
                    },
                    hooks.onProgressIndeterminate,
                    mapConfig,
                    injectBeforeCommit,
                );
            } else {
                // Device-fit bitrate from the preflight (full request when the
                // device handles it, a lower rung when it does not). Fallback
                // keeps this defensive if the preflight somehow left it unset.
                const bitrate = reencodeBitrate || desiredBitrate;
                transcodeResult = await transcode(
                    {
                        source: { trip, channel, startTripSec, endTripSec },
                        output: {
                            height: dims.height,
                            aspect: dims.aspect,
                            bitrate,
                            hardwareAcceleration,
                            crop: slotCrops[0] ?? null,
                            flip: slotFlips[0],
                            watermarkAnchor,
                            withAudio: reencodeAudio,
                            speedFactor,
                            letterboxFill,
                            overlays,
                            blurRegions: effectiveBlurRegions,
                        },
                        writable,
                        signal: activeExportController.signal,
                        onProgress: onTranscodeProgress,
                        // Same indeterminate-bar bracket as the split path above.
                    },
                    hooks.onProgressIndeterminate,
                    mapConfig,
                    injectBeforeCommit,
                );
            }
            const gpmfInjected: boolean =
                gpmfInjectedBeforeCommit ??
                (await postProcessTelemetry(
                    trip,
                    startTripSec,
                    endTripSec,
                    mp4Handle,
                    withGpmf,
                    hooks.onStatus,
                    activeExportController.signal,
                    transcodeResult.capturedMoov,
                ));
            await finishExport(mp4Handle, {
                gpmfInjected,
                mapOverlayDropped: transcodeResult.mapOverlayDropped,
                decodeTruncated: transcodeResult.decodeTruncated,
                audioDroppedHeterogeneous: transcodeResult.audioDroppedHeterogeneous,
                audioDroppedNoEncoder: transcodeResult.audioDroppedNoEncoder,
                audioReencodedToOpus: transcodeResult.audioReencodedToOpus,
            });
        }
    } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
            log.info("export cancelled");
            hooks.onCancel();
            return;
        }
        log.error("export failed", err);
        // The raw exception text is logged above (ring buffer, for bug reports);
        // the user only ever sees a known, friendly export.error.* message. Map
        // the failure shapes we recognize, fall back to a neutral one otherwise:
        //  - out of room on disk / over storage quota (isQuotaExceededError also
        //    catches the wrapped variants the ponyfill and SW streams re-throw);
        //  - the RAM path could not allocate the MP4 buffer for an oversized clip
        //    (RangeError / out-of-memory). The no-native path is intentionally not
        //    pre-gated by size, so a too-large export surfaces HERE; the message
        //    points the user at desktop Chrome, which streams to disk at any size;
        //  - the DESTINATION went away mid-write (drive unplugged, a sync client
        //    or an antivirus took the staging file) - only ever read from a
        //    sink-tagged throw, since a source-side failure shares the name;
        //  - a SOURCE file stopped being readable mid-export (card/drive dropped,
        //    file changed since it was picked) - the one failure the user can
        //    actually fix themselves, so it gets its own message. Gated on the
        //    sink tag: the source-read shapes are name/text matches, and a
        //    write failure carrying one of them would otherwise send the user
        //    to check the card when the destination is the problem.
        // An OutputDamagedError (the in-place GPMF injection could not restore the
        // moov) wraps the sink failure that caused it; classify that cause.
        const failure =
            err instanceof Error && err.name === "OutputDamagedError" && err.cause !== undefined ? err.cause : err;
        const errorKey: I18nKey =
            failure instanceof Error && failure.name === "IncompatibleVideoConfigError"
                ? "export.error.incompatibleVideo"
                : isQuotaExceededError(failure)
                  ? "export.error.diskFull"
                  : isAllocationFailure(failure)
                    ? __PORTABLE__
                        ? "portable.export.tooLargeForMemory"
                        : "export.error.tooLargeForMemory"
                    : isDestinationLostError(failure)
                      ? "export.error.destinationLost"
                      : !isSinkFailure(failure) && isSourceReadError(failure)
                        ? "export.error.sourceReadFailed"
                        : "export.error.generic";
        hooks.onError(errorKey);
        // mediabunny's internal read-orchestrator assert during stream-copy (see
        // isMediabunnyReadAssert): an upstream-side failure class we want to COUNT
        // on its own, not bury in the generic bucket. The user still gets the honest
        // generic failure - we cannot recover the copy and must not mask it as a
        // "damaged end" partial, since the assert fires on an early read, not a tail.
        const readAssert = streamCopy && isMediabunnyReadAssert(err);
        const reason = err instanceof Error ? err.name || "Error" : "unknown";
        // Where users silently abandon. Capture the RAW exception (not the
        // friendly key). Recognized buckets (diskFull / tooLargeForMemory) are
        // expected and high-volume, so collapse each to ONE issue via a custom
        // fingerprint. The generic bucket keeps Sentry's default stack-based
        // grouping, so distinct unknown failures (a wedged writable close, a
        // muxer error, a codec crash) stay separate instead of merging into one
        // "generic Error" blob.
        captureSentryException(err, {
            // Breadcrumbs roll over on long exports; retain the run settings
            // and last progress on the failure event itself.
            extra: {
                export: {
                    outputWidth: dims.width,
                    outputHeight: dims.height,
                    bitrate: streamCopy ? null : reencodeBitrate || desiredBitrate,
                    frameRate,
                    durationSec: endTripSec - startTripSec,
                    speedFactor,
                    channelCount: channelOrder.length,
                    segmentCounts,
                    layout,
                    mapOverlay: !!overlays?.map,
                    withAudio: streamCopy ? withAudio : reencodeAudio,
                    deliveryMode,
                    elapsedMs: Math.round(performance.now() - exportStartedAt),
                    progress: lastProgress,
                },
            },
            fingerprint: readAssert
                ? ["export", "stream-copy", "mediabunny-read-assert"]
                : errorKey === "export.error.generic"
                  ? undefined
                  : ["export_failed", errorKey],
            tags: {
                error_key: errorKey,
                reason,
                stream_copy: String(streamCopy),
                ...(readAssert ? { read_defect: "mediabunny-read-assert" } : {}),
            },
        });
    } finally {
        activeExportController = null;
        hooks.onInProgress(false);
        void releaseExportWakeLock();
        // RAM path: free the in-memory backing buffer (up to 4 GiB) on any exit.
        // The success tails already took it via takeDownloadBlob() (which disposes
        // and leaves an independent download File), so this is a no-op there;
        // its job is the error/abort exits, where the buffer would otherwise sit
        // resident until GC and OOM a retry. No-op on the native path (null handle).
        asInMemoryExportHandle(mp4Handle)?.dispose();
    }
}

/** Cancels the active export, if any. Used by the panel Cancel button. */
export function cancelActiveExport(): void {
    activeExportController?.abort();
}

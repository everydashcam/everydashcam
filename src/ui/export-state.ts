// Export-mode state. Most fields live for the page session; the Overlay slice
// additionally persists across reloads. Composition (layout / channels / audio /
// per-slot crops) lives in state.composition - it is shared between casual
// playback and export, and persists across mode toggles.
//
// This module owns the open/close transition: openExportMode flips
// state.exportModeOpen and notifies subscribers; closeExportMode reverses.
// All UI modules that need to render export-only chrome (top-panel output
// preset, export-panel itself, range pull-tabs, watermark overlay) subscribe
// here.

import { createSubscribers } from "../subscribers.js";
import type { BlurStyle } from "../blur-regions.js";
import { createLogger } from "../log.js";
import type { MapShape, OverlayStyleId, WatermarkAnchor } from "../transcode/types.js";
import type { Trip } from "../trips.js";

import type { StreetLabelDensity } from "./map-label-scale.js";
import { getMapMarkerAppearance, type MapMarkerAppearance } from "./map-marker-pref.js";
import type { OverlayMapProvider, OverlayMapProviderPreference } from "./map-provider.js";
import { activeTrip, state } from "./state.js";
import type { MapStyleId } from "./theme.js";
import {
    cloneOverlayPreferences,
    overlayPreferencesKey,
    persistOverlayPreferences,
    readStoredOverlayPreferences,
} from "./export-overlay-pref.js";

/**
 * Bitrate quality preset. "original" is the top tier: stream-copy (lossless)
 * when the composition permits it (output=source, no crop/split/overlays/speed),
 * otherwise a source-matched re-encode - the panel relabels it "High" in that
 * case to signal the re-encode. "medium"/"low" are source-relative size-saver
 * tiers (a fraction of the capped source bitrate - smaller shareable files that
 * still scale with the footage). See canStreamCopy / streamCopyEligibleConfig in
 * the export-flow logic.
 */
export type Quality = "original" | "medium" | "low";

/**
 * Output dimensions preset id. "source" = master channel dims (largest tile
 * in current layout). Named presets fix the output aspect + a 1080p/720p
 * height. "custom" reads outputCustomW/outputCustomH.
 */
export type OutputPresetId =
    | "source"
    | "1080_16x9"
    | "720_16x9"
    | "1080_9x16"
    | "720_9x16"
    | "1080_1x1"
    | "1080_4x5"
    | "custom";

/** Phase of the export panel: configure -> encode -> finished summary, with a
 *  terminal error branch that offers a way back to the configure view. */
export type ExportPhase = "options" | "progress" | "done" | "error";

/**
 * What the panel produces. "video" = the MP4 clip (with its optional gpx
 * sidecar, audio, telemetry, overlays). "gpx" = the GPS track only, no video
 * at all - a fast, picker-free download straight from trip.records, for users
 * who just want the route. Offered only when the active trip carries GPS.
 */
export type ExportOutputKind = "video" | "gpx";

/**
 * Position + scale of a text overlay (speed, coords) burned into the output
 * frame. xPct/yPct = top-left of the rendered text box in output-frame
 * fractions. scalePct = percentage of base font size (default base ~4.5% of
 * frame height).
 */
export interface OverlayTextState {
    enabled: boolean;
    xPct: number;
    yPct: number;
    scalePct: number;
}

/**
 * Position + size + zoom for the map overlay. PiP-style rectangular slot:
 * xPct/yPct = top-left, scalePct = percentage of the default width (base width
 * defined in transcode/map-overlay.ts); zoomKm = approximate diameter of the
 * visible area in kilometers, capped by latitude.
 */
/** Map overlay camera: north-up (legacy) vs the tilted heading-up "chase" view.
 *  A render-only concern (never crosses into the transcode worker - the
 *  snapshotter reads it on the main thread, like `theme`). */
export type MapViewMode = "north" | "chase";

export interface OverlayMapState {
    enabled: boolean;
    /** Export maps keep a provider that permits overlays, independent of the viewer. */
    provider: OverlayMapProviderPreference;
    xPct: number;
    yPct: number;
    scalePct: number;
    zoomKm: number;
    /** Clip shape of the mini-map slot. */
    shape: MapShape;
    /** Base-layer style of the mini-map, independent of the app UI theme. */
    theme: MapStyleId;
    /** Label size of the burned-in map's street/place names, percent of the
     *  style's own sizes (one of the MAP_LABEL_SIZE_PCT_VALUES presets). A
     *  render-only concern like `theme`: the snapshotter scales the style on
     *  the main thread. Independent of the viewer's label-scale preference -
     *  the overlay slot is sized for a video frame, not the user's screen. */
    labelScalePct: number;
    /** Street-name density of the burned-in map (how often road names repeat
     *  and how early by zoom they turn on). Same lifecycle as labelScalePct;
     *  independent of the viewer's density preference. */
    labelDensity: StreetLabelDensity;
    /** Current-position marker for exported overlays. The first default comes
     *  from the global map preference, then the overlay choice is independent. */
    marker: MapMarkerAppearance;
    /** Camera view. "north" = north-up (the legacy look); "chase" = tilted,
     *  heading-up (the car points up, road ahead in view). Default "north". */
    mode: MapViewMode;
    /** Chase camera tilt in degrees (0..70). Ignored when mode === "north". */
    pitchDeg: number;
    /** Chase: zoom out as speed rises so more of the road ahead stays visible.
     *  The whole zoom range stays above the tile source maxzoom, so it never
     *  refetches tiles. Ignored when mode === "north". */
    adaptiveZoom: boolean;
}

/** The complete Overlay fieldset configuration. It is independent of the
 *  active trip and survives reloads; everything outside this interface keeps
 *  the export panel's existing session or trip lifecycle. */
export interface OverlayPreferences {
    /** Visual style applied to every overlay widget. */
    overlayStyle: OverlayStyleId;
    /** Accent color (hex) for units / dials / brackets. */
    overlayAccent: string;
    /** Dark scrim behind the widgets for legibility on bright footage. */
    overlayScrim: boolean;
    overlaySpeed: OverlayTextState;
    overlayCoords: OverlayTextState;
    overlayMap: OverlayMapState;
    overlayClock: OverlayTextState;
    overlayCompass: OverlayTextState;
    overlayGforce: OverlayTextState;
    overlayDistance: OverlayTextState;
    overlayGraph: OverlayTextState;
}

/**
 * Time range selected for export, in trip-local seconds. The pull-tabs on the
 * timeline mutate these directly; the chart-zoom view-window is independent
 * (zoom is just a visual aid for picking precise endpoints).
 */
export interface ExportRange {
    /** Footage-axis (content) seconds. Bounded by [0, trip.timeline.contentDurationSec].
     *  Pauses are removed from this axis, so the range maps 1:1 to the exported clip. */
    startTripSec: number;
    endTripSec: number;
}

/**
 * Minimum export clip length, in content-axis seconds. Below it the two range
 * boundaries collapse onto each other and the clip is too short to be useful.
 * Enforced only inside setRangeEdge, which both the timeline pull-tabs and the
 * trim bar's numeric range inputs funnel through - so the floor lives as one
 * literal in one place, not duplicated per control.
 */
const MIN_RANGE_SEC = 1;

export interface ExportRangeEdgeBounds {
    minTripSec: number;
    maxTripSec: number;
    valueTripSec: number;
}

export interface ExportPanelState extends OverlayPreferences {
    phase: ExportPhase;
    /** True from a video Save click until that flow settles, including the file
     *  picker and encode preflight while phase is still `options`. The form and
     *  on-video editors become inert so post-Save edits cannot imply they affect
     *  the immutable run. */
    configurationLocked: boolean;
    /** Video clip vs GPS-track-only. See ExportOutputKind. The panel hides every
     *  video control in "gpx" mode and turns Save into a plain .gpx download. */
    outputKind: ExportOutputKind;
    quality: Quality;
    /** Explicit encode bitrate in Mbit/s, or null for the quality tier's own
     *  budget. Set, it overrides the tier outright on the re-encode path (the
     *  device encoder probe still applies) and the panel disables the tiers, so
     *  the two never claim to be in charge at once. Ignored by a stream-copy,
     *  which encodes nothing at all. See clampManualBitrateMbps for the range. */
    manualBitrateMbps: number | null;
    outputPresetId: OutputPresetId;
    outputCustomW: number;
    outputCustomH: number;
    /** Range; full trip on first open per session, last-edited on subsequent opens. */
    range: ExportRange | null;
    /** What to fill letterbox bars with: black or blurred source. */
    letterboxFill: "black" | "blur";
    watermarkAnchor: WatermarkAnchor;
    /** true = burn the everydashcam mark into the output. Off means the pipelines
     *  get a null anchor - the preview drops the mark too, so what the user sees
     *  is still what they get. */
    withWatermark: boolean;
    /** Timelapse speed-up factor (1 = real time). One of SPEED_FACTORS. Forces
     *  re-encode and mutes audio when > 1. */
    speedFactor: number;
    /** true = keep the source audio track in the output. Default true. */
    withAudio: boolean;
    /** true = embed the GPS track into the output MP4. Default true. Distinct
     *  from withGpx (a separate sidecar file, genuinely additive / default off). */
    withGpmf: boolean;
    withGpx: boolean;
    /** Redaction style for privacy blur zones. One style for all zones (kept
     *  per-region in the data model for a future per-zone override); changing
     *  it in the panel re-styles every zone of the active trip. */
    blurStyle: BlurStyle;
}

/** Presets for OverlayMapState.labelScalePct (percent of the style's own
 *  label sizes). Mirrors the viewer's MAP_LABEL_SCALE_VALUES ratios. */
export const MAP_LABEL_SIZE_PCT_VALUES = [100, 125, 150, 200] as const;

/** Default brand-orange accent for new overlays. Mirrors --dc-orange. */
export const OVERLAY_ACCENT_DEFAULT = "#FF9000";

/** Accent swatches offered in the constructor (brand + 5 common alternates). */
export const OVERLAY_ACCENT_SWATCHES = ["#FF9000", "#FFFFFF", "#1AA7EC", "#1FA463", "#E5102B", "#F5C518"] as const;

/** Initial / reset values for the Overlay fieldset. Kept separate from the
 *  rest of the export form because this is the only cross-reload slice. */
function freshOverlayPreferences(): OverlayPreferences {
    return {
        overlayStyle: "min",
        overlayAccent: OVERLAY_ACCENT_DEFAULT,
        overlayScrim: false,
        // Default positions form collision-free corner slots: speed + coords
        // stacked bottom-left, clock top-right, map top-left. The advanced
        // dials/graph/distance occupy plausible empty spots on the right/bottom.
        overlaySpeed: { enabled: false, xPct: 0.035, yPct: 0.78, scalePct: 100 },
        overlayCoords: { enabled: false, xPct: 0.035, yPct: 0.9, scalePct: 100 },
        overlayMap: {
            enabled: false,
            provider: "openfreemap",
            xPct: 0.045,
            yPct: 0.05,
            scalePct: 100,
            zoomKm: 1,
            shape: "circle",
            theme: "neon",
            labelScalePct: 100,
            labelDensity: "standard",
            marker: getMapMarkerAppearance(),
            mode: "chase",
            pitchDeg: 58,
            adaptiveZoom: true,
        },
        overlayClock: { enabled: false, xPct: 0.8, yPct: 0.045, scalePct: 100 },
        overlayCompass: { enabled: false, xPct: 0.81, yPct: 0.28, scalePct: 100 },
        overlayGforce: { enabled: false, xPct: 0.81, yPct: 0.56, scalePct: 100 },
        overlayDistance: { enabled: false, xPct: 0.035, yPct: 0.68, scalePct: 100 },
        overlayGraph: { enabled: false, xPct: 0.32, yPct: 0.86, scalePct: 100 },
    };
}

const defaultOverlayPreferences = freshOverlayPreferences();

/** Initial / reset values for the export panel. See field semantics on
 *  ExportPanelState. Kept as a function so callers always get a fresh object
 *  (mutating the defaults would silently leak across opens). */
function freshExportPanelState(): ExportPanelState {
    const overlays = readStoredOverlayPreferences(defaultOverlayPreferences);
    return {
        phase: "options",
        configurationLocked: false,
        outputKind: "video",
        quality: "original",
        manualBitrateMbps: null,
        outputPresetId: "source",
        outputCustomW: 1920,
        outputCustomH: 1080,
        range: null,
        letterboxFill: "black",
        // br matches drawWatermark's default and keeps the mark clear of the
        // mini-map (top-left by default), so it stays grabbable for drag.
        watermarkAnchor: "br",
        withWatermark: true,
        speedFactor: 1,
        withAudio: true,
        withGpmf: true,
        withGpx: false,
        ...overlays,
        blurStyle: "pixelate",
    };
}

/**
 * Live mutable state. Direct mutation is the convention across this codebase
 * (see state.ts); call notifyExportStateChanged() after batch edits to wake
 * subscribers.
 */
export const exportPanelState: ExportPanelState = freshExportPanelState();

let mapPreviewProvider: { preference: OverlayMapProviderPreference; active: OverlayMapProvider } | null = null;

/** A preview fallback affects available controls, but never overwrites saved choices. */
export function getExportMapPreviewProvider(): OverlayMapProvider {
    const preference = exportPanelState.overlayMap.provider;
    return mapPreviewProvider?.preference === preference ? mapPreviewProvider.active : preference;
}

export function setExportMapPreviewProvider(
    preference: OverlayMapProviderPreference,
    active: OverlayMapProvider,
): void {
    if (mapPreviewProvider?.preference === preference && mapPreviewProvider.active === active) return;
    mapPreviewProvider = { preference, active };
    notifyExportStateChanged();
}

function currentOverlayPreferences(): OverlayPreferences {
    return cloneOverlayPreferences(exportPanelState);
}

function applyOverlayPreferences(preferences: OverlayPreferences): void {
    exportPanelState.overlayStyle = preferences.overlayStyle;
    exportPanelState.overlayAccent = preferences.overlayAccent;
    exportPanelState.overlayScrim = preferences.overlayScrim;
    Object.assign(exportPanelState.overlaySpeed, preferences.overlaySpeed);
    Object.assign(exportPanelState.overlayCoords, preferences.overlayCoords);
    Object.assign(exportPanelState.overlayMap, preferences.overlayMap, {
        marker: { ...preferences.overlayMap.marker },
    });
    Object.assign(exportPanelState.overlayClock, preferences.overlayClock);
    Object.assign(exportPanelState.overlayCompass, preferences.overlayCompass);
    Object.assign(exportPanelState.overlayGforce, preferences.overlayGforce);
    Object.assign(exportPanelState.overlayDistance, preferences.overlayDistance);
    Object.assign(exportPanelState.overlayGraph, preferences.overlayGraph);
}

let lastOverlayPreferencesKey = overlayPreferencesKey(currentOverlayPreferences());

/** Whether Reset has anything to do in the Overlay fieldset. */
export function hasCustomOverlayPreferences(): boolean {
    return overlayPreferencesKey(currentOverlayPreferences()) !== overlayPreferencesKey(defaultOverlayPreferences);
}

function refreshDefaultOverlayMarker(): void {
    defaultOverlayPreferences.overlayMap.marker = getMapMarkerAppearance();
}

/** Restores only the Overlay fieldset; output, trim, cameras and privacy zones
 *  are deliberately left untouched. The following notification removes the
 *  persisted entry and refreshes the preview. */
export function resetOverlayPreferences(): void {
    refreshDefaultOverlayMarker();
    applyOverlayPreferences(defaultOverlayPreferences);
    notifyExportStateChanged();
}

/** Stable id for each overlay widget. Single source shared by the panel UI, the
 *  stream-copy gate and the pipeline args, so adding a widget touches one list. */
export type OverlayWidgetId = "speed" | "coords" | "map" | "clock" | "compass" | "gforce" | "distance" | "graph";

/** Canonical ordered list pairing each overlay-widget id with an accessor to its
 *  live enable+placement state. The single source of "which overlays exist and in
 *  what order": the export panel builds its widget defs from this (attaching the
 *  UI-only labelKey/isMap), and the export flow derives the enabled-flag set from
 *  it - so adding an overlay is one entry here, not three parallel edits. */
export const OVERLAY_STATE_ACCESSORS: ReadonlyArray<{
    id: OverlayWidgetId;
    state: () => OverlayTextState | OverlayMapState;
}> = [
    { id: "speed", state: () => exportPanelState.overlaySpeed },
    { id: "coords", state: () => exportPanelState.overlayCoords },
    { id: "map", state: () => exportPanelState.overlayMap },
    { id: "clock", state: () => exportPanelState.overlayClock },
    { id: "compass", state: () => exportPanelState.overlayCompass },
    { id: "gforce", state: () => exportPanelState.overlayGforce },
    { id: "distance", state: () => exportPanelState.overlayDistance },
    { id: "graph", state: () => exportPanelState.overlayGraph },
];

type Listener = () => void;
const listeners = createSubscribers<Parameters<Listener>>("export-state");
const log = createLogger("export-state");
let prepareExportMode: (() => Promise<boolean> | null) | null = null;
let pendingOpen: object | null = null;

/** Lets the player leave its expanded presentation before exposing the editor.
 *  Returning null keeps ordinary opens synchronous. */
export function setExportModePreparation(handler: (() => Promise<boolean> | null) | null): void {
    prepareExportMode = handler;
}

/** Subscribes to export-state changes (open/close + panel field edits).
 *  Returns an unsubscribe function. */
export function subscribeExportState(listener: Listener): () => void {
    return listeners.subscribe(listener);
}

/** Notifies subscribers. Called by openExportMode/closeExportMode and by any
 *  UI module that batched a state change. */
export function notifyExportStateChanged(): void {
    listeners.emit();
    const current = currentOverlayPreferences();
    const key = overlayPreferencesKey(current);
    if (key === lastOverlayPreferencesKey) return;
    lastOverlayPreferencesKey = key;
    persistOverlayPreferences(current, defaultOverlayPreferences);
}

/**
 * Opens export-mode: flips state.exportModeOpen, populates the default range
 * from the active trip if no range survives from a prior open, and wakes
 * subscribers. No-op if already open.
 *
 * Overlay settings survive page reloads. Other preferences keep their existing
 * in-session lifecycle: quality, output preset, watermark anchor + opt-out and
 * audio/gpmf/gpx toggles survive panel closes only.
 */
export function openExportMode(): void {
    if (state.exportModeOpen || pendingOpen) return;
    const trip = activeTrip();
    // Callers can immediately trim a newly opened export, even while the
    // browser is still leaving fullscreen. Seed the range before that wait.
    if (!exportPanelState.range && trip) {
        exportPanelState.range = { startTripSec: 0, endTripSec: trip.timeline.contentDurationSec };
    }
    const preparation = prepareExportMode?.();
    if (preparation) {
        const request = {};
        pendingOpen = request;
        void preparation.then(
            (canOpen) => {
                if (pendingOpen !== request) return;
                pendingOpen = null;
                if (canOpen && activeTrip() === trip) activateExportMode();
            },
            (err: unknown) => {
                if (pendingOpen === request) pendingOpen = null;
                log.warn("could not prepare export editor", {
                    err: err instanceof Error ? err.message : String(err),
                });
            },
        );
        return;
    }
    activateExportMode();
}

function activateExportMode(): void {
    if (state.exportModeOpen) return;
    state.exportModeOpen = true;
    // Until the overlay constructor is customized, its marker follows the main
    // map preference just as a fresh export does. Once any overlay setting is
    // saved, that complete layout (including its marker) stays independent.
    if (!hasCustomOverlayPreferences()) {
        refreshDefaultOverlayMarker();
        exportPanelState.overlayMap.marker = { ...defaultOverlayPreferences.overlayMap.marker };
    }
    notifyExportStateChanged();
}

/**
 * Closes export-mode. Phase resets to "options" so a re-open lands on the
 * configure view, but per-session preferences (quality, watermark anchor,
 * etc.) stay. The range is also kept - leaving export-mode and coming back
 * should not silently widen the range to full trip.
 *
 * Exception: a RUNNING export ("progress") keeps its phase. Public UI paths no
 * longer close a running/locked session (they expose explicit Cancel instead),
 * but retaining the phase is a defensive backstop for direct callers.
 */
export function closeExportMode(): void {
    pendingOpen = null;
    if (!state.exportModeOpen) return;
    state.exportModeOpen = false;
    if (exportPanelState.phase !== "progress") {
        exportPanelState.phase = "options";
    }
    notifyExportStateChanged();
}

/**
 * Resets the export range to the full span of the given trip. Called when the
 * active trip changes: a range picked on the previous (possibly longer) trip
 * must not leak into a shorter one - endTripSec past the new trip's duration
 * slices no files and throws "range covers no files". Resetting to the full new
 * trip matches what a first open of the panel would pick anyway.
 */
export function resetExportRangeForTrip(trip: Trip): void {
    pendingOpen = null;
    exportPanelState.range = { startTripSec: 0, endTripSec: trip.timeline.contentDurationSec };
    notifyExportStateChanged();
}

/**
 * Returns the legal interval for one export-range edge. The timeline sliders
 * use this same result for ARIA bounds that setRangeEdge enforces, so their
 * announced limits cannot drift from pointer/input clamping.
 */
export function getExportRangeEdgeBounds(which: "start" | "end"): ExportRangeEdgeBounds | null {
    const range = exportPanelState.range;
    const trip = activeTrip();
    if (!range || !trip) return null;
    const durationSec = Math.max(0, trip.timeline.contentDurationSec);
    // A sub-second trip cannot satisfy the normal floor. Its only valid range
    // is the whole trip, matching setRange's defensive fallback.
    const minSpanSec = Math.min(MIN_RANGE_SEC, durationSec);
    if (which === "start") {
        return {
            minTripSec: 0,
            maxTripSec: Math.max(0, Math.min(durationSec, range.endTripSec) - minSpanSec),
            valueTripSec: range.startTripSec,
        };
    }
    return {
        minTripSec: Math.min(durationSec, Math.max(0, range.startTripSec) + minSpanSec),
        maxTripSec: durationSec,
        valueTripSec: range.endTripSec,
    };
}

/**
 * Moves one edge of the export range to `tripSec` (content-axis seconds),
 * clamped so the range stays inside [0, contentDuration] and keeps
 * end - start >= MIN_RANGE_SEC. The single choke point every range edit funnels
 * through - the timeline pull-tabs, the trim bar's numeric inputs and the
 * set-to-playhead actions all call it - so the controls, the chart shading and
 * the estimate never diverge.
 * Mutates exportPanelState.range in place and notifies subscribers. No-op when
 * no range is set.
 *
 * Returns whether the MIN_RANGE_SEC floor moved the value (the edges would have
 * collided) - callers surface that as feedback; the benign trip-bounds clamp is
 * not reported.
 */
export function setRangeEdge(which: "start" | "end", tripSec: number): { clampedToMinLength: boolean } {
    // Save snapshots the whole export configuration before opening the native
    // picker. Keep that snapshot's visible range immutable even if a keyboard
    // shortcut or a synthetic event reaches this shared mutation boundary.
    if (exportPanelState.configurationLocked) return { clampedToMinLength: false };
    const range = exportPanelState.range;
    const bounds = getExportRangeEdgeBounds(which);
    if (!range || !bounds) return { clampedToMinLength: false };
    const next = Math.max(bounds.minTripSec, Math.min(tripSec, bounds.maxTripSec));
    const clampedToMinLength = which === "start" ? tripSec > bounds.maxTripSec : tripSec < bounds.minTripSec;
    if (which === "start") {
        range.startTripSec = next;
    } else {
        range.endTripSec = next;
    }
    notifyExportStateChanged();
    return { clampedToMinLength };
}

/**
 * Sets both range edges at once (content-axis seconds), clamped to
 * [0, contentDuration] and widened to MIN_RANGE_SEC if the requested span is
 * shorter. One atomic commit + one notify - two sequential setRangeEdge calls
 * would cross-clamp against the STALE opposite edge when the new window does
 * not overlap the old one (e.g. "export this moment" on an event far outside
 * the current range). Mutates in place: replacing the object identity is
 * reserved for resetExportRangeForTrip, whose new identity is what the panel
 * reads as "trip switched under me". No-op when no range or no active trip.
 */
export function setRange(startTripSec: number, endTripSec: number): void {
    if (exportPanelState.configurationLocked) return;
    const range = exportPanelState.range;
    const trip = activeTrip();
    if (!range || !trip) return;
    const dur = trip.timeline.contentDurationSec;
    let start = Math.max(0, Math.min(startTripSec, dur - MIN_RANGE_SEC));
    let end = Math.min(dur, Math.max(endTripSec, start + MIN_RANGE_SEC));
    // A trip shorter than MIN_RANGE_SEC cannot honor the floor - fall back to
    // its full span rather than producing an inverted range.
    if (end <= start) {
        start = 0;
        end = dur;
    }
    range.startTripSec = start;
    range.endTripSec = end;
    notifyExportStateChanged();
}

/** Toggles export-mode. Used by the E hotkey and the player-bar Export button. */
export function toggleExportMode(): void {
    // A running export owns an immutable UI session. Hiding it with the E
    // hotkey made it possible to switch trips/edit zones behind the progress
    // view, while the encoder was still working on the old clip. Cancellation
    // remains available through the explicit progress-view button.
    if (exportPanelState.phase === "progress" || exportPanelState.configurationLocked) return;
    if (state.exportModeOpen) closeExportMode();
    else openExportMode();
}

export function _resetForTests(): void {
    mapPreviewProvider = null;
    pendingOpen = null;
    prepareExportMode = null;
    listeners.clear();
}

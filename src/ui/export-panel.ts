import { maybeShowPostExportToast } from "./pwa-install.js";
// Export panel: side-drawer (desktop) / bottom-sheet (mobile) housing the
// inline save UI - output frame size/aspect, quality, audio/gpmf/gpx, letterbox
// blur, overlays toggles (incl. the map-scale slider), plus the Save button and
// the progress / done sections. The watermark has no form row: it is positioned
// by dragging it on the preview (see player-overlays.ts).
//
// This panel owns the entire save flow. The Save
// click delegates to src/ui/export-flow.ts (pure logic), which handles
// stream-copy vs transcode vs split routing.

import { identifyBrowser } from "../capabilities.js";
import { getEncoderPreference } from "../encoder-pref.js";
import { clampManualBitrateMbps, MANUAL_BITRATE_MAX_MBPS, MANUAL_BITRATE_MIN_MBPS } from "../export-bitrate.js";
import { createLogger } from "../log.js";
import { dom } from "./dom.js";
import { codecPlaybackAdviceHtml } from "./empty-state.js";
import { activateModal, deactivateModal, wireBackdropDismiss } from "./modal-helper.js";
import {
    closeExportMode,
    type ExportOutputKind,
    exportPanelState,
    getExportMapPreviewProvider,
    hasCustomOverlayPreferences,
    MAP_LABEL_SIZE_PCT_VALUES,
    type MapViewMode,
    notifyExportStateChanged,
    openExportMode,
    OVERLAY_ACCENT_SWATCHES,
    OVERLAY_STATE_ACCESSORS,
    type OutputPresetId,
    type OverlayWidgetId,
    type Quality,
    resetOverlayPreferences,
    subscribeExportState,
} from "./export-state.js";
import type { MapShape, OverlayStyleId } from "../transcode/types.js";
import type { MapStyleId } from "./theme.js";
import {
    cancelActiveExport,
    estimateExport,
    formatEstimatedSize,
    refreshEncodeCeiling,
    runExportFlow,
    subscribeEncodeCeiling,
} from "./export-flow.js";
import type { ExportDoneSummary } from "./export-flow.js";
import { nativeFsaAvailable } from "./in-memory-file.js";
import {
    channelDisplayLabel,
    clipBasename,
    formatBytes,
    formatRateBytes,
    formatTime,
    randomFilenameSuffix,
} from "./format.js";
import { setExportInProgress, syncExportButton } from "./player-export-button.js";
import { activeTrip, activeTripHasGps, state } from "./state.js";
import { downloadBlob } from "../download.js";
import { buildClipGpx, clipRecordsForRange } from "../export-range.js";
import { totalDistanceKm } from "../parser.js";
import { notify } from "./notifications.js";
import { getDateLocale, t } from "../i18n/index.js";
import { DETECTION_QUALITIES, type DetectionQuality } from "../tracking/detection-sampling.js";
import {
    DETECTION_POLICIES,
    DETECTION_THRESHOLD_MIN,
    DETECTION_THRESHOLD_MAX,
    DETECTION_THRESHOLD_STEP,
} from "../tracking/detector-policy.js";
import type { I18nKey } from "../i18n/keys.js";
import { formatDistanceFromKm } from "../units-pref.js";
import { SPEED_FACTORS, type TranscodeProgress } from "../transcode/types.js";
import { enterCropEditMain } from "./player-crop.js";
import { isBlurDrawArmed, toggleBlurDraw } from "./player-blur.js";
import {
    activeBlurRegions,
    notifyBlurRegionsChanged,
    removeBlurRegion,
    subscribeBlurRegions,
} from "./blur-regions-state.js";
import {
    type BlurRegion,
    type BlurStyle,
    MIN_ZONE_SPAN_SEC,
    regionHasTrackedKeyframes,
    ZONE_START_PLAYHEAD_BACKOFF_SEC,
} from "../blur-regions.js";
import { seekPresentedContentTime } from "./player.js";
import { channelPresentedFrame } from "./player-frame-time.js";
import { cancelTrackPass, subscribeTrackPasses, toggleTrackPass, trackPassOf } from "./blur-track.js";
import {
    detectAssetGroups,
    detectCounts,
    detectEnabled,
    detectQuality,
    detectThreshold,
    detectRegions,
    detectStyle,
    type DetectKind,
    detectPassState,
    ensureDetectPass,
    detectAvailable,
    setDetectEnabled,
    setDetectQuality,
    setDetectThreshold,
    setDetectStyle,
    subscribeBlurDetect,
} from "./blur-detect.js";
import {
    type BlurAssetGroupId,
    type BlurAssetDownloadOptions,
    blurAssetsBlockedOffline,
    blurAssetsDownloadMb,
    blurAssetsNeedDownload,
    blurAssetsReady,
    blurAssetsState,
    downloadBlurAssets,
    subscribeBlurAssets,
} from "./blur-assets.js";
import { isMapAvailable } from "./map.js";
import { STREET_LABEL_DENSITY_LABEL_KEYS, STREET_LABEL_DENSITY_VALUES } from "./map-label-scale.js";
import { renderMapMarkerControl } from "./map-marker-control.js";
import { createMapProviderSelect } from "./map-provider-control.js";
import { MAP_PROVIDER_REGISTRY, MAX_MAP_PITCH_DEG } from "./map-provider-registry.js";
import { buildLucideIcon } from "./icons.js";
import { isMobileLayout } from "./media-queries.js";

const log = createLogger("export-panel");

// Output presets shown in the panel's Output <select>, in display order.
const OUTPUT_PRESETS: OutputPresetId[] = [
    "source",
    "1080_16x9",
    "720_16x9",
    "1080_9x16",
    "720_9x16",
    "1080_1x1",
    "1080_4x5",
    "custom",
];

// Player-refresh callback (player.ts applyComposition), injected at init. The
// Output control mutates the output-frame aspect, so it must re-stage the grid
// for an immediate WYSIWYG letterbox snap. Injected, not imported, to keep the
// dep tree acyclic - player.ts imports this module, not the reverse.
let onCompositionApply: () => void = () => {};

export function initExportPanel(opts: { onCompositionApply: () => void }): void {
    onCompositionApply = opts.onCompositionApply;
    renderOptionsSection();
    renderProgressSection();
    renderDoneSection();
    renderErrorSection();

    // Player-bar Export button: toggles export-mode (opens this panel). On
    // mobile it stays in the bar and overflows into the kebab last; the kebab
    // clone forwards its click here too (overflow-bar default onActivate).
    dom.exportBtn?.addEventListener("click", openOrCloseExportMode);
    // Initial state-of-button - export-mode false at boot.
    syncExportButton();

    // "Open in a Chromium browser" modal, opened from the non-Chromium banner.
    dom.chromiumBrowsersModalClose?.addEventListener("click", closeChromiumModal);
    // Click on the overlay (outside the card) also closes.
    if (dom.chromiumBrowsersModal) wireBackdropDismiss(dom.chromiumBrowsersModal, closeChromiumModal);

    subscribeExportState(syncExportPanel);
    // Blur zones: rows + armed-button label track region edits; export-state
    // changes (arm/disarm notifies it) are covered by syncExportPanel below.
    subscribeBlurRegions(syncBlurGroup);
    // Track-pass lifecycle ticks re-render the zone rows and keep Save blocked
    // until Follow has committed a complete result.
    if (!__PORTABLE__) {
        subscribeTrackPasses(() => {
            syncBlurGroup();
            syncSaveAvailability();
        });
        // Model asset download state drives the consent / progress / offline strips
        // (Follow's and the detect checkboxes' - separate rows, same machinery).
        subscribeBlurAssets(syncBlurDownloadStrips);
        // Detect pass lifecycle (progress %, fresh counts) re-renders its status row.
        subscribeBlurDetect(syncDetectGroup);
        // Model files are same-origin; a tile provider outage does not block them.
        window.addEventListener("online", syncBlurDownloadStrips);
        window.addEventListener("offline", syncBlurDownloadStrips);
    }
    // The device encode ceiling resolves asynchronously (a WebCodecs probe). When
    // it lands, re-run the estimate so the size / device-cap note / Save state
    // reflect what this device can actually encode - without a full panel notify
    // (which would re-trigger the probe and loop).
    subscribeEncodeCeiling(syncEstimate);
    // Language is fixed for the page lifetime (a switch is a full navigation),
    // so the panel is built once here in the active language and never needs a
    // live relocalization pass.
    syncExportPanel();
}

function openOrCloseExportMode(): void {
    if (exportPanelState.phase === "progress" || exportPanelState.configurationLocked) return;
    if (state.exportModeOpen) closeExportMode();
    else openExportMode();
}

let wasExportModeOpen = false;
let hasSavedClip = false;
let previousPhase = exportPanelState.phase;
let shouldFocusPhase = false;

function syncExportPanel(): void {
    const hasJustOpened = state.exportModeOpen && !wasExportModeOpen;
    if (!state.exportModeOpen && wasExportModeOpen && hasSavedClip) {
        hasSavedClip = false;
        if (!__PORTABLE__) void maybeShowPostExportToast();
    }
    wasExportModeOpen = state.exportModeOpen;
    if (hasJustOpened && selectedOverlayKey === "map") refreshOverlayInspector();
    syncBlurGroup();
    // Trip switches and range edits re-key the detect state (per-trip flags,
    // stale results) - keep the checkbox block honest alongside the zones.
    if (!__PORTABLE__) syncDetectGroup();
    const phase = exportPanelState.phase;
    if (phase !== previousPhase) {
        shouldFocusPhase =
            document.activeElement === document.body || !!dom.exportPanel?.contains(document.activeElement);
        previousPhase = phase;
    }
    if (!state.exportModeOpen) shouldFocusPhase = false;
    if (dom.exportPanelOptions) {
        dom.exportPanelOptions.hidden = phase !== "options";
        dom.exportPanelOptions.inert = exportPanelState.configurationLocked;
        dom.exportPanelOptions.setAttribute("aria-busy", String(exportPanelState.configurationLocked));
    }
    if (dom.exportPanelActions) {
        dom.exportPanelActions.hidden = phase !== "options" || !state.exportModeOpen;
        dom.exportPanelActions.inert = exportPanelState.configurationLocked;
    }
    if (dom.exportPanelProgress) dom.exportPanelProgress.hidden = phase !== "progress";
    if (dom.exportPanelDone) dom.exportPanelDone.hidden = phase !== "done";
    if (dom.exportPanelError) dom.exportPanelError.hidden = phase !== "error";
    // Show/hide the video-vs-gpx switch for the active trip (no GPS -> no switch,
    // forced back to video). Built once, toggled here - same pattern as
    // syncMapOverlayAvailability, so the switch tracks trip changes without a
    // full options rebuild (which only runs on init / language change).
    syncModeAvailability();
    // Reflect the output kind (video controls shown/hidden, Save label, summary).
    // Cheap and idempotent; keeps the panel honest after any external state change.
    syncOutputKindUi();
    syncOverlayReset();
    syncExportMapControls();
    const videoMode = exportPanelState.outputKind === "video";
    // Everything below configures the video pipeline - skip it entirely in
    // gpx-only mode (the controls are hidden and there is no encode to size). In
    // gpx mode we instead refresh the track summary (points / distance / length).
    if (videoMode) {
        // Keep the speed UI (active factor, audio state, result length) in sync with
        // the current factor AND range - the range pull-tabs notify through here too.
        syncSpeedDependentUi();
        // Re-probe what this device can encode for the current re-encode config
        // (no-op for stream-copy / unchanged config). Resolves async; on landing it
        // wakes syncEstimate via subscribeEncodeCeiling. Gated to the open configure
        // view so we do not probe while the panel is closed or mid-export.
        if (state.exportModeOpen && phase === "options") refreshEncodeCeiling();
        // Live export estimate (per-quality clip sizes and output summary) tracks
        // every Output / quality / range / speed / audio change routed through here.
        syncEstimate();
        // Refresh the in-memory-blob warning whenever the configure view is shown
        // (the result is memoized, so this is cheap on repeated state ticks).
        if (state.exportModeOpen && phase === "options") void updateFallbackWarn();
        // Hide the map-overlay option when the map can't render (no WebGL). Done here
        // rather than at build time because the WebGL probe runs only on first
        // trip-open, after this panel is built.
        syncMapOverlayAvailability();
        // Grey out the GPS-dependent options (telemetry / .gpx / overlays) on a
        // trip with no GPS - same per-tick reconciliation as the map gate above.
        syncGpsOptionsAvailability();
        // Overlay style/accent/scrim appear only once a widget is on (widget
        // toggles notify through here).
        syncOverlayExtras();
        // The watermark plea follows the opt-out checkbox, which the preview's
        // own state changes can never flip - but the tick keeps them paired.
        syncWatermarkOpt();
    } else {
        syncGpxSummary();
    }
    if (shouldFocusPhase && (phase !== "options" || !exportPanelState.configurationLocked)) {
        shouldFocusPhase = false;
        const target =
            phase === "progress"
                ? progressStatusEl
                : phase === "done"
                  ? document.getElementById("export-panel-done-summary")
                  : phase === "error"
                    ? errorStatusEl
                    : saveBtnEl;
        target?.focus();
    }
}

/**
 * Shows the video/gpx switch only for a trip that carries GPS - a gpx export of
 * a track with no points is pointless. Mirrors syncMapOverlayAvailability: the
 * control is built once and its visibility is reconciled here on every state
 * tick, so it tracks trip changes (resetExportRangeForTrip notifies through
 * syncExportPanel) without rebuilding the whole options section. When the trip
 * has no GPS, a stale "gpx" pick (carried from a previous trip) is forced back
 * to video so Save stays meaningful.
 */
function syncModeAvailability(): void {
    const hasGps = activeTripHasGps();
    if (modeGroupEl) modeGroupEl.hidden = !hasGps;
    if (!hasGps && exportPanelState.outputKind === "gpx") {
        exportPanelState.outputKind = "video";
    }
}

/**
 * Hides the map-overlay row (and unticks it) when the map is unavailable. The
 * overlay needs a WebGL snapshotter, so offering it on a context-less GPU would
 * only produce a silently-overlay-less export (or, worse, a stalled snapshot).
 */
function syncMapOverlayAvailability(): void {
    const row = document.getElementById("export-panel-map-overlay-row");
    if (!row) return;
    const available = isMapAvailable();
    row.hidden = !available;
    if (!available && exportPanelState.overlayMap.enabled) {
        exportPanelState.overlayMap.enabled = false;
        const cb = document.getElementById("export-panel-ov-map") as HTMLInputElement | null;
        if (cb) cb.checked = false;
    }
}

/**
 * Greys out (disables) every GPS-dependent export option on a trip with no GPS:
 * embedded telemetry, the .gpx sidecar, and the speed/coords/map overlays all
 * need at least one fix to do anything. Reconciles only the controls' DISPLAY
 * every tick (mirrors the audio handling in syncSpeedDependentUi) - it never
 * touches the persistent exportPanelState, so a tick set on a GPS trip survives
 * a hop through a no-GPS one and the default "embed GPS" is not silently
 * cleared. The export itself already ignores these on a no-GPS trip (export-flow
 * recordsHaveGps gate); this is the matching, honest UI affordance.
 *
 * Distinct from syncMapOverlayAvailability (no-WebGL) on purpose: that gate is
 * permanent for the session and hides the map row outright, so it mutates state;
 * GPS presence flips per trip, so this one must not.
 */
function syncGpsOptionsAvailability(): void {
    const hasGps = activeTripHasGps();
    // id -> the box's checked state when GPS is present.
    const rows: Array<[id: string, checkedWithGps: boolean]> = [
        ["export-panel-gpmf", exportPanelState.withGpmf],
        ["export-panel-gpx", exportPanelState.withGpx],
        // Every overlay-widget checkbox mirrors its enable flag with GPS.
        ...OVERLAY_WIDGET_DEFS.map((d): [string, boolean] => [overlayCbId(d.id), d.state().enabled]),
    ];
    for (const [id, checkedWithGps] of rows) {
        const cb = document.getElementById(id) as HTMLInputElement | null;
        if (!cb) continue;
        cb.disabled = !hasGps;
        const name = cb.closest(".export-panel__ov-row")?.querySelector<HTMLButtonElement>("button");
        if (name) {
            name.disabled = !hasGps;
            if (!hasGps) name.setAttribute("aria-expanded", "false");
        }
        // No GPS -> show every box cleared, so a stale tick carried from a
        // previous trip never reads as "this will happen"; with GPS, mirror the
        // live state.
        cb.checked = hasGps && checkedWithGps;
        // The widget rows are not .export-panel__checkbox labels; toggle the
        // disabled class on whichever wrapper exists.
        (cb.closest(".export-panel__checkbox") ?? cb.closest(".export-panel__ov-row"))?.classList.toggle(
            "is-disabled",
            !hasGps,
        );
    }
    // The inspector targets one widget; on a no-GPS trip nothing renders, so
    // hide it rather than offer placement controls for a data-less overlay. Only
    // rebuild on a no-GPS -> GPS transition (see inspectorBuiltForGps): a rebuild
    // on every steady-state tick would wipe a slider mid-drag.
    if (overlayInspectorEl) {
        if (!hasGps) {
            overlayInspectorEl.hidden = true;
        } else if (inspectorBuiltForGps !== true) {
            refreshOverlayInspector();
        }
    }
    inspectorBuiltForGps = hasGps;
}

/* ----------------------------- options section ---------------------------- */

let actionsObserver: ResizeObserver | null = null;

function renderDisclosure(group: HTMLElement, iconPaths: string[]): HTMLDetailsElement {
    const details = document.createElement("details");
    details.className = "export-panel__disclosure";
    details.open = !isMobileLayout();
    const summary = document.createElement("summary");
    const legend = group.querySelector("legend");
    const title = document.createElement("span");
    title.className = "export-panel__disclosure-title";
    title.textContent = legend?.textContent ?? "";
    const icon = buildLucideIcon(iconPaths, 16);
    icon.classList.add("export-panel__disclosure-icon");
    icon.setAttribute("aria-hidden", "true");
    const chevron = buildLucideIcon(["m9 5 7 7-7 7"], 14);
    chevron.classList.add("export-panel__disclosure-chevron");
    chevron.setAttribute("aria-hidden", "true");
    summary.append(icon, title, chevron);
    details.append(summary, group);
    return details;
}

function renderOptionsSection(): void {
    const root = dom.exportPanelOptions;
    const actions = dom.exportPanelActions;
    if (!root || !actions) return;
    root.innerHTML = "";
    actions.innerHTML = "";

    // "Video clip" vs "GPS track only" switch + the gpx track summary. Both are
    // always built; their visibility is reconciled by syncModeAvailability /
    // syncOutputKindUi (the switch hides on a no-GPS trip, the summary shows only
    // in gpx mode). Building once - not gated on the active trip - is what lets
    // the switch appear after a trip loads, since the options section is rebuilt
    // only on init / language change, not on trip open.
    root.appendChild(renderModeGroup());
    root.appendChild(renderGpxSummary());

    // Every video-only control lives under one wrapper so the gpx mode can hide
    // the whole block with a single flag (syncOutputKindUi).
    const videoOnly = document.createElement("div");
    videoOnly.className = "export-panel__video-only";

    // Non-Chromium nudge. Firefox / Safari / iOS-WebKit: the re-encode editor is
    // limited (Firefox H.264 encode is broken) and the in-RAM build caps very
    // large exports - a soft banner opens a modal with Chromium-browser
    // downloads. engine "unknown" is left alone: it may be a Chromium fork we did
    // not name, and nagging it would misfire. Inside videoOnly: it is about the
    // video export, irrelevant to a plain gpx download.
    const engine = identifyBrowser().engine;
    if (engine === "gecko" || engine === "webkit") {
        videoOnly.appendChild(renderChromiumBanner());
    }

    videoOnly.appendChild(renderOutputGroup());
    videoOnly.appendChild(renderQualityGroup());
    videoOnly.appendChild(renderSpeedGroup());
    videoOnly.appendChild(renderCropGroup());
    videoOnly.appendChild(
        renderDisclosure(renderBlurGroup(), ["M12 3 4 6v6c0 4 3 7 8 9 5-2 8-5 8-9V6Z", "m9 12 2 2 4-4"]),
    );
    videoOnly.appendChild(renderToggleGroup());
    videoOnly.appendChild(
        renderDisclosure(renderOverlaysGroup(), ["m12 3 9 5-9 5-9-5Z", "m3 12 9 5 9-5", "m3 16 9 5 9-5"]),
    );
    const estimate = renderEstimateGroup();
    estimate.id = "export-panel-action-estimate";
    actions.appendChild(estimate);

    // In-memory-build warning. Shown (async) on every browser without a native
    // save picker (Firefox / Safari / mobile), where the whole MP4 is built in
    // RAM. Long clips can then exhaust memory, so the user must see this BEFORE
    // clicking Save. Hidden by default; updateFallbackWarn() flips it.
    const warn = document.createElement("div");
    warn.id = "export-panel-fallback-warn";
    warn.className = "export-panel__warn";
    warn.textContent = t(__PORTABLE__ ? "portable.export.memory" : "export.fallbackWarn");
    warn.hidden = true;
    fallbackWarnEl = warn;
    actions.appendChild(warn);

    root.appendChild(videoOnly);
    videoOnlyEl = videoOnly;

    // Capture the audio checkbox so a speed-up can disable it (audio is muted on
    // sped-up clips - see export-flow), and apply the initial speed-dependent
    // state (button highlight + audio enable/disable + note visibility).
    audioCheckboxEl = root.querySelector<HTMLInputElement>("#export-panel-audio");
    syncSpeedDependentUi();

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.id = "export-panel-save-btn";
    saveBtn.className = "export-panel__primary-btn";
    saveBtn.textContent = t("export.start");
    saveBtn.addEventListener("click", onSaveClick);
    saveBtnEl = saveBtn;
    const buttons = document.createElement("div");
    buttons.className = "export-panel__action-buttons";
    const trimBtn = document.createElement("button");
    trimBtn.type = "button";
    trimBtn.id = "export-panel-back-to-trim";
    trimBtn.className = "export-panel__secondary-btn";
    trimBtn.textContent = t("export.backToTrim");
    trimBtn.addEventListener("click", () => {
        const trim = document.getElementById("export-trim-bar");
        trim?.scrollIntoView({ block: "center", behavior: "instant" });
        trim?.querySelector<HTMLInputElement>("input:not([disabled])")?.focus({ preventScroll: true });
    });
    buttons.append(trimBtn, saveBtn);
    actions.appendChild(buttons);

    if (!__PORTABLE__) {
        const followNote = document.createElement("div");
        followNote.id = "export-panel-follow-save-note";
        followNote.className = "export-panel__warn";
        followNote.textContent = t("export.blur.tracker.saveBlocked");
        followNote.hidden = true;
        followSaveNoteEl = followNote;
        actions.appendChild(followNote);
    }
    actionsObserver?.disconnect();
    actionsObserver = new ResizeObserver(() => {
        document.documentElement.style.setProperty("--dc-export-actions-h", `${actions.offsetHeight}px`);
    });
    actionsObserver.observe(actions);

    // Reflect the current mode (hide video controls + relabel Save) now that all
    // the nodes exist.
    syncOutputKindUi();

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.id = "export-panel-cancel-btn";
    cancelBtn.className = "export-panel__secondary-btn";
    cancelBtn.textContent = t("export.close");
    cancelBtn.addEventListener("click", () => {
        closeExportMode();
    });
    root.appendChild(cancelBtn);
}

function setToggleSelected(button: Element, selected: boolean, activeClass = "is-active"): void {
    button.classList.toggle(activeClass, selected);
    button.setAttribute("aria-pressed", String(selected));
}

// "What to export" switch: the video clip (with all the controls below) or just
// the GPS track as a .gpx. A compact segmented toggle - low visual weight for
// the common (video) case, while staying discoverable. Always built; hidden on
// a no-GPS trip by syncModeAvailability.
//
// This is one axis only: the whole output (video vs track). It is deliberately
// NOT merged with the "Also save a .gpx" checkbox into a Video/Video+.gpx/Only
// .gpx selector - the video already carries embedded GPS by default, so such a
// selector would wrongly imply plain "Video" has no GPS. The .gpx checkbox is a
// separate, orthogonal axis (attach a sidecar to the video) and never shows
// alongside this switch (it lives in the videoOnly block, hidden in gpx mode).
function renderModeGroup(): HTMLElement {
    const wrap = document.createElement("fieldset");
    wrap.className = "export-panel__group";
    const legend = document.createElement("legend");
    legend.textContent = t("export.mode.legend");
    wrap.appendChild(legend);

    const row = document.createElement("div");
    row.className = "export-panel__segmented";
    modeButtons = [];
    const opts: Array<{ id: ExportOutputKind; label: string }> = [
        { id: "video", label: t("export.mode.video") },
        { id: "gpx", label: t("export.mode.gpx") },
    ];
    for (const o of opts) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "export-panel__seg-btn";
        btn.dataset.mode = o.id;
        btn.textContent = o.label;
        btn.addEventListener("click", () => {
            if (exportPanelState.outputKind === o.id) return;
            exportPanelState.outputKind = o.id;
            // Toggle the video block + Save label + summary immediately; notify
            // keeps the range line / estimate / summary in step.
            syncOutputKindUi();
            notifyExportStateChanged();
        });
        row.appendChild(btn);
        modeButtons.push(btn);
    }
    wrap.appendChild(row);
    modeGroupEl = wrap;
    return wrap;
}

/**
 * GPS-track summary, shown in place of the (hidden) video controls in gpx mode:
 * a caption ("the .gpx file, no video") over a live "N points · distance ·
 * length" line. Reassures the user the track is non-empty and how big it is
 * before saving. Always built; visibility toggled by syncOutputKindUi, content
 * filled by syncGpxSummary.
 */
function renderGpxSummary(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "export-panel__gpx-summary";
    wrap.hidden = true;

    const caption = document.createElement("div");
    caption.className = "export-panel__gpx-summary-caption";
    caption.textContent = t("export.mode.gpx.sub");
    wrap.appendChild(caption);

    const stats = document.createElement("div");
    stats.className = "export-panel__gpx-summary-stats";
    gpxSummaryStatsEl = stats;
    wrap.appendChild(stats);

    gpxSummaryEl = wrap;
    return wrap;
}

/** Applies the current output kind to the DOM: hides every video control in gpx
 *  mode (showing the track summary instead), highlights the active segment, and
 *  swaps the Save button between the MP4 export and the .gpx download label. In
 *  gpx mode it force-enables Save - the video encode-ceiling block (set by
 *  syncEncodeNote) must never gate a .gpx, which does no encoding. Safe before
 *  first render (refs may be null). */
function syncOutputKindUi(): void {
    const gpx = exportPanelState.outputKind === "gpx";
    if (videoOnlyEl) videoOnlyEl.hidden = gpx;
    const estimate = document.getElementById("export-panel-action-estimate");
    if (estimate) estimate.hidden = gpx;
    if (fallbackWarnEl && gpx) fallbackWarnEl.hidden = true;
    if (gpxSummaryEl) gpxSummaryEl.hidden = !gpx;
    for (const btn of modeButtons) {
        setToggleSelected(btn, btn.dataset.mode === exportPanelState.outputKind, "active");
    }
    if (saveBtnEl) {
        saveBtnEl.textContent = gpx ? t("export.gpx.start") : t("export.start");
    }
    syncSaveAvailability();
    // The summary content itself is filled by syncGpxSummary (called from the
    // gpx branch of syncExportPanel, which runs right after this on every tick).
}

/**
 * Fills the gpx-mode track summary (points · distance · length) for the selected
 * range, using the same in-range record set the .gpx export writes
 * (clipRecordsForRange) so the count the user sees matches the file. No-op when
 * there is no active trip or range.
 */
function syncGpxSummary(): void {
    if (!gpxSummaryStatsEl) return;
    const trip = activeTrip();
    const range = exportPanelState.range;
    if (!trip || !range) {
        gpxSummaryStatsEl.textContent = "";
        return;
    }
    const records = clipRecordsForRange(trip, range.startTripSec, range.endTripSec);
    const dist = formatDistanceFromKm(totalDistanceKm(records));
    // 1 decimal under 10 units (a short clip is < 1 km, which rounds to "0");
    // whole units above, where the fraction is noise.
    const distText = `${dist.value.toFixed(dist.value < 10 ? 1 : 0)} ${t(dist.unitKey)}`;
    gpxSummaryStatsEl.textContent = t("export.gpx.summary", {
        n: records.length,
        dist: distText,
        dur: formatTime(Math.max(0, range.endTripSec - range.startTripSec)),
    });
}

// Output frame size/aspect. The <select> picks a preset; "custom" reveals a
// W/H number pair. Every write re-stages the grid (onCompositionApply) so the
// player letterbox snaps to the new aspect immediately, then notifies so the
// rest of the panel (e.g. stream-copy eligibility hint) reacts.
function renderOutputGroup(): HTMLElement {
    const wrap = document.createElement("fieldset");
    wrap.className = "export-panel__group";
    const legend = document.createElement("legend");
    legend.textContent = t("export.output.legend");
    wrap.appendChild(legend);

    const select = document.createElement("select");
    select.id = "export-panel-output";
    select.className = "export-panel__output-select";
    select.setAttribute("aria-label", t("export.output.legend"));
    for (const id of OUTPUT_PRESETS) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = outputPresetLabel(id);
        if (id === exportPanelState.outputPresetId) opt.selected = true;
        select.appendChild(opt);
    }
    wrap.appendChild(select);

    // Custom W/H row: built once, shown only for the "custom" preset. Toggled in
    // place (not re-rendered) since the group itself is built once per panel.
    const custom = renderCustomDims();
    wrap.appendChild(custom.el);
    custom.setVisible(exportPanelState.outputPresetId === "custom");

    select.addEventListener("change", () => {
        exportPanelState.outputPresetId = select.value as OutputPresetId;
        custom.setVisible(exportPanelState.outputPresetId === "custom");
        onCompositionApply();
        notifyExportStateChanged();
    });

    return wrap;
}

// Custom output dimensions (W × H). Values are clamped to [240, 3840] and
// snapped to even numbers - encoders reject odd dimensions. Each edit re-stages
// the grid so the WYSIWYG preview stays honest.
function renderCustomDims(): { el: HTMLElement; setVisible: (visible: boolean) => void } {
    const wrap = document.createElement("span");
    wrap.className = "export-panel__output-custom";

    const wIn = document.createElement("input");
    wIn.type = "number";
    // Numeric soft-keyboard on mobile (integer even-step dimensions).
    wIn.inputMode = "numeric";
    wIn.min = "240";
    wIn.max = "3840";
    wIn.step = "2";
    wIn.value = String(exportPanelState.outputCustomW);
    wIn.setAttribute("aria-label", t("export.output.customW"));
    wIn.title = t("export.output.customW");
    wIn.addEventListener("change", () => {
        const v = Math.max(240, Math.min(3840, Number.parseInt(wIn.value, 10) || 1920));
        exportPanelState.outputCustomW = v - (v % 2);
        wIn.value = String(exportPanelState.outputCustomW);
        onCompositionApply();
        notifyExportStateChanged();
    });
    wrap.appendChild(wIn);

    const sep = document.createElement("span");
    sep.textContent = "×";
    sep.className = "export-panel__output-sep";
    wrap.appendChild(sep);

    const hIn = document.createElement("input");
    hIn.type = "number";
    hIn.inputMode = "numeric";
    hIn.min = "240";
    hIn.max = "3840";
    hIn.step = "2";
    hIn.value = String(exportPanelState.outputCustomH);
    hIn.setAttribute("aria-label", t("export.output.customH"));
    hIn.title = t("export.output.customH");
    hIn.addEventListener("change", () => {
        const v = Math.max(240, Math.min(3840, Number.parseInt(hIn.value, 10) || 1080));
        exportPanelState.outputCustomH = v - (v % 2);
        hIn.value = String(exportPanelState.outputCustomH);
        onCompositionApply();
        notifyExportStateChanged();
    });
    wrap.appendChild(hIn);

    return {
        el: wrap,
        setVisible: (visible: boolean) => {
            wrap.hidden = !visible;
        },
    };
}

function outputPresetLabel(id: OutputPresetId): string {
    switch (id) {
        case "source":
            return t("export.output.source");
        case "1080_16x9":
            return t("export.output.preset.1080_16x9");
        case "720_16x9":
            return t("export.output.preset.720_16x9");
        case "1080_9x16":
            return t("export.output.preset.1080_9x16");
        case "720_9x16":
            return t("export.output.preset.720_9x16");
        case "1080_1x1":
            return t("export.output.preset.1080_1x1");
        case "1080_4x5":
            return t("export.output.preset.1080_4x5");
        case "custom":
            return t("export.output.preset.custom");
    }
}

function renderQualityGroup(): HTMLElement {
    const wrap = document.createElement("fieldset");
    wrap.className = "export-panel__group";
    const legend = document.createElement("legend");
    legend.textContent = t("export.quality.legend");
    wrap.appendChild(legend);

    // The top tier ("original") carries a live, config-dependent label: "Original"
    // (lossless stream-copy) when the config permits it, "High" (source-matched
    // re-encode) when an overlay/crop/resize/split/speed forces a re-encode -
    // flipped by syncEstimate. Medium/Light keep a static label + one-word use
    // note; the live "~/s" rate (appended below) is the size hint.

    // Rebuilt with the group (the options section wipes itself on render), so the
    // ref list must start empty or a rebuild would leave stale rows behind.
    qualityRows.length = 0;
    const opts: Array<{ id: Quality; label: string; sub: string }> = [
        { id: "original", label: t("export.quality.original"), sub: t("export.quality.original.sub") },
        { id: "medium", label: t("export.quality.medium"), sub: t("export.quality.medium.sub") },
        { id: "low", label: t("export.quality.low"), sub: t("export.quality.low.sub") },
    ];
    for (const o of opts) {
        const row = document.createElement("label");
        row.className = "export-panel__radio";
        const r = document.createElement("input");
        r.type = "radio";
        r.name = "export-panel-quality";
        r.value = o.id;
        r.checked = exportPanelState.quality === o.id;
        r.addEventListener("change", () => {
            if (r.checked) {
                exportPanelState.quality = o.id;
                notifyExportStateChanged();
            }
        });
        row.appendChild(r);
        const label = document.createElement("span");
        const head = document.createElement("strong");
        head.textContent = o.label;
        label.appendChild(head);
        // Capture the top tier's head so syncEstimate can flip it between the
        // Original (stream-copy) and High (re-encode) wording. Unconditional - the
        // head always exists, independent of whether the tier has a sub-label.
        if (o.id === "original") topTierHeadEl = head;
        if (o.sub) {
            const sub = document.createElement("span");
            sub.className = "export-panel__radio-sub";
            sub.textContent = ` · ${o.sub}`;
            label.appendChild(sub);
            if (o.id === "original") topTierSubEl = sub;
        }
        const size = document.createElement("span");
        size.className = "export-panel__radio-sub";
        qualitySizeEls.set(o.id, size);
        label.appendChild(size);
        row.appendChild(label);
        wrap.appendChild(row);
        qualityRows.push({ row, input: r });
    }
    // Says WHY the tiers just went grey. Shown only while the override is on.
    const active = document.createElement("div");
    active.className = "export-panel__note";
    active.textContent = t("export.quality.manual.active");
    active.hidden = true;
    manualBitrateActiveEl = active;
    wrap.appendChild(active);
    wrap.appendChild(renderManualBitrate());
    syncManualBitrateUi(null);
    return wrap;
}

// Tier rows + their radios, so a manual bitrate can visibly take them out of
// play (it overrides them; two controls claiming to own quality is a lie).
const qualityRows: Array<{ row: HTMLElement; input: HTMLInputElement }> = [];
let manualBitrateSourceEl: HTMLElement | null = null;
let manualBitrateActiveEl: HTMLElement | null = null;

/**
 * Collapsed "set the bitrate manually" disclosure under the quality tiers: an
 * empty field means auto (the tier decides), a number overrides it outright.
 *
 * Folded away rather than inline because the tiers are the answer for almost
 * everyone - but the number is the only answer for someone who already knows
 * the figure their footage needs, and burying it in nothing at all is what
 * sent them to write in.
 */
function renderManualBitrate(): HTMLElement {
    const details = document.createElement("details");
    details.className = "export-panel__manual-bitrate";
    const summary = document.createElement("summary");
    summary.textContent = t("export.quality.manual.toggle");
    details.appendChild(summary);

    const row = document.createElement("div");
    row.className = "export-panel__manual-bitrate-row";

    const input = document.createElement("input");
    input.type = "number";
    input.id = "export-panel-bitrate";
    input.className = "settings-number-input";
    // Numeric soft keyboard; the value is whole megabits (clampManualBitrateMbps).
    input.inputMode = "numeric";
    input.min = String(MANUAL_BITRATE_MIN_MBPS);
    input.max = String(MANUAL_BITRATE_MAX_MBPS);
    input.step = "1";
    input.placeholder = t("export.quality.manual.auto");
    input.setAttribute("aria-label", `${t("export.quality.manual.label")}, ${t("export.quality.manual.unit")}`);
    input.value = exportPanelState.manualBitrateMbps === null ? "" : String(exportPanelState.manualBitrateMbps);
    input.addEventListener("change", () => {
        // An empty (or unparseable) field is the way back to auto - clamping it
        // to the minimum instead would make the control impossible to undo.
        const mbps = input.value.trim() === "" ? null : clampManualBitrateMbps(Number.parseFloat(input.value));
        exportPanelState.manualBitrateMbps = mbps;
        input.value = mbps === null ? "" : String(mbps);
        notifyExportStateChanged();
    });
    row.appendChild(input);

    const unit = document.createElement("span");
    unit.className = "export-panel__manual-bitrate-unit";
    unit.textContent = t("export.quality.manual.unit");
    row.appendChild(unit);
    details.appendChild(row);

    // What the camera itself wrote - the only reference point that makes a
    // number meaningful. Filled by syncManualBitrateUi from the live estimate.
    const source = document.createElement("div");
    source.className = "export-panel__note";
    source.hidden = true;
    manualBitrateSourceEl = source;
    details.appendChild(source);

    return details;
}

/**
 * Reflects the manual-bitrate override: greys out and disables the quality tiers
 * while a number is set (it wins over them - see resolveReencodeBitrate), and
 * shows the source's own bitrate as the reference for choosing one. `est` may be
 * null before the first estimate resolves, which only hides the reference line.
 */
function syncManualBitrateUi(est: ReturnType<typeof estimateExport>): void {
    const manual = exportPanelState.manualBitrateMbps !== null;
    for (const { row, input } of qualityRows) {
        input.disabled = manual;
        row.classList.toggle("is-disabled", manual);
    }
    if (manualBitrateActiveEl) manualBitrateActiveEl.hidden = !manual;
    if (manualBitrateSourceEl) {
        const bps = est && est.sourceBitrate > 0 ? est.sourceBitrate : 0;
        manualBitrateSourceEl.hidden = bps <= 0;
        if (bps > 0) {
            const mbit = bps / 1_000_000;
            // Both units on purpose. The field takes Mbit/s (what a bitrate is
            // conventionally quoted in) while the tier rows above quote bytes per
            // second, so a bare "32 Mbit/s" under a row reading "5 MB/s" looks
            // like a contradiction until you do the x8 in your head.
            manualBitrateSourceEl.textContent = t("export.quality.manual.source", {
                mbit: mbit < 10 ? mbit.toFixed(1) : String(Math.round(mbit)),
                perSecond: formatRateBytes(bps / 8),
            });
        }
    }
}

// Per-quality clip-size spans (filled by syncEstimate from estimateExport).
const qualitySizeEls = new Map<Quality, HTMLElement>();

// Top-tier ("original") head + sub spans, relabeled live by syncEstimate between
// "Original" (stream-copy) and "High" (re-encode forced by the current config).
let topTierHeadEl: HTMLElement | null = null;
let topTierSubEl: HTMLElement | null = null;

// Estimated-output block (size / resolution / duration) shown above
// Save. Refs filled by renderEstimateGroup, values by syncEstimate.
let estimateSizeEl: HTMLDivElement | null = null;
let estimateDetailsEl: HTMLDivElement | null = null;
// Device-encode note: shown when this device must reduce quality to encode
// (deviceCapped) or cannot encode at this resolution at all (blocked). Toggled
// by syncEstimate; the latter also disables Save.
let encodeNoteEl: HTMLDivElement | null = null;
let saveBtnEl: HTMLButtonElement | null = null;
let followSaveNoteEl: HTMLDivElement | null = null;
let saveBlockedByEncode = false;
// Wrapper around every video-only control; hidden in gpx mode (syncOutputKindUi).
let videoOnlyEl: HTMLDivElement | null = null;
// The video/gpx segmented switch (hidden on a no-GPS trip) and its two buttons
// (active class tracks outputKind). Built once; reconciled by sync* helpers.
let modeGroupEl: HTMLElement | null = null;
let modeButtons: HTMLButtonElement[] = [];
// GPS-track summary block (shown in gpx mode) + its live stats line.
let gpxSummaryEl: HTMLDivElement | null = null;
let gpxSummaryStatsEl: HTMLDivElement | null = null;

/** "Estimated output" group: a prominent size line plus a muted
 *  resolution · duration · codec line. Updated live by syncEstimate on every
 *  state change (Output / quality / range / speed / audio). */
function renderEstimateGroup(): HTMLElement {
    const wrap = document.createElement("fieldset");
    wrap.className = "export-panel__group";
    const legend = document.createElement("legend");
    legend.textContent = t("export.estimate.legend");
    wrap.appendChild(legend);

    const size = document.createElement("div");
    size.className = "export-panel__estimate-size";
    estimateSizeEl = size;
    wrap.appendChild(size);

    const details = document.createElement("div");
    details.className = "export-panel__estimate-details";
    estimateDetailsEl = details;
    wrap.appendChild(details);

    // Device-encode note (hidden by default). Warn tone for a quality reduction,
    // error tone for an outright block (set in syncEstimate).
    const note = document.createElement("div");
    note.id = "export-panel-encode-note";
    note.className = "export-panel__warn";
    note.hidden = true;
    encodeNoteEl = note;
    wrap.appendChild(note);

    return wrap;
}

/** Flips the top quality tier's wording: "Original" + its sub when the config
 *  permits a lossless stream-copy, "High" + the re-encode sub when an overlay /
 *  crop / resize / split / speed forces a re-encode. Mirrors
 *  streamCopyEligibleConfig on the export-flow side via est.topStreamCopyEligible. */
function syncTopTierLabel(streamCopyEligible: boolean): void {
    if (topTierHeadEl) {
        topTierHeadEl.textContent = streamCopyEligible ? t("export.quality.original") : t("export.quality.high");
    }
    if (topTierSubEl) {
        topTierSubEl.textContent = ` · ${
            streamCopyEligible ? t("export.quality.original.sub") : t("export.quality.high.sub")
        }`;
    }
}

/** Recomputes the live estimate and writes the per-quality clip sizes + the
 *  estimated-output block. Cheap pure read; called from syncExportPanel. */
function syncEstimate(): void {
    const est = estimateExport();
    // The manual-bitrate block tracks the estimate (it shows the source's own
    // rate), so it is reconciled on both branches - including the no-estimate one.
    syncManualBitrateUi(est);
    if (!est) {
        for (const el of qualitySizeEls.values()) el.textContent = "";
        if (estimateSizeEl) estimateSizeEl.textContent = "";
        if (estimateDetailsEl) estimateDetailsEl.textContent = "";
        syncTopTierLabel(true);
        syncEncodeNote(null);
        return;
    }
    syncTopTierLabel(est.topStreamCopyEligible);
    for (const [q, el] of qualitySizeEls) {
        el.textContent = t("export.quality.size", { size: formatBytes(est.rateByQuality[q] * est.durationSec) });
    }
    if (estimateSizeEl) {
        // Exact stream-copy size vs VBR re-encode floor - shared wording with
        // the trim bar's readout (formatEstimatedSize).
        estimateSizeEl.textContent = formatEstimatedSize(est);
    }
    if (estimateDetailsEl) {
        estimateDetailsEl.textContent = `${formatTime(est.durationSec)} · ${est.width}×${est.height}`;
    }
    syncEncodeNote(est);
}

/**
 * Reflects the device encode ceiling in the panel: a warn note when the device
 * forced a quality reduction (deviceCapped), an error note + disabled Save when
 * it cannot encode at this resolution at all (blocked). Anything else clears the
 * encode gate; Follow/configuration locks can still keep Save disabled. Keeps
 * the Save button as the single gate the user sees BEFORE committing, matching
 * the "surface the limit up front" decision.
 */
function syncEncodeNote(est: ReturnType<typeof estimateExport>): void {
    const note = encodeNoteEl;
    const undecodable = est ? est.sourceUndecodable : null;
    const blocked = !!est?.blocked;
    const capped = !!est?.deviceCapped;
    if (note) {
        // Hard blocks (error tone, disabled Save) take precedence over the soft
        // device-capped warning; an undecodable source outranks the encode
        // ceiling (more fundamental, and its guidance supersedes). The no-native
        // RAM path is no longer pre-blocked by size - an oversized export
        // surfaces at run time as a clean "use desktop Chrome" message (see
        // export-flow), and the persistent fallbackWarn already flags the
        // in-memory limit before Save.
        if (undecodable) {
            // Why it is blocked + how to get a browser where editing works
            // (shared advice, may carry the Store link) + what works right here.
            note.hidden = false;
            note.classList.add("is-error");
            note.innerHTML = `${t("export.error.sourceNotPlayable")} ${codecPlaybackAdviceHtml(undecodable.codec)} ${t("export.error.sourceNotPlayable.asIs")}`;
        } else if (blocked) {
            note.hidden = false;
            note.classList.add("is-error");
            note.textContent = t(
                getEncoderPreference() === "auto"
                    ? "export.error.cannotEncodeResolution"
                    : "export.error.encoderUnavailable",
            );
        } else if (capped) {
            note.hidden = false;
            note.classList.remove("is-error");
            note.textContent = t("export.estimate.deviceCapped");
        } else {
            note.hidden = true;
            note.classList.remove("is-error");
            note.textContent = "";
        }
    }
    saveBlockedByEncode = blocked || undecodable !== null;
    syncSaveAvailability();
}

/** Save must never snapshot a half-finished Follow. Before the pass commits,
 *  the region still has its old short end and seed geometry; exporting that
 *  would silently uncover the remaining clip. Pending asset consent counts as
 *  unfinished too: the user already asked for Follow and must explicitly
 *  cancel that intent before saving without it. */
function followWorkPending(): boolean {
    if (__PORTABLE__) return false;
    return pendingFollowRegionIds.size > 0 || activeBlurRegions().some((region) => trackPassOf(region.id) !== null);
}

function syncSaveAvailability(): void {
    const video = exportPanelState.outputKind === "video";
    const followPending = video && followWorkPending();
    if (followSaveNoteEl) followSaveNoteEl.hidden = !followPending;
    if (!saveBtnEl) return;
    saveBtnEl.disabled = exportPanelState.configurationLocked || (video && (saveBlockedByEncode || followPending));
    if (followPending) saveBtnEl.setAttribute("aria-describedby", "export-panel-follow-save-note");
    else saveBtnEl.removeAttribute("aria-describedby");
}

// Refs touched by syncSpeedDependentUi: the speed buttons (highlight the active
// factor), the "audio muted" note, and the audio checkbox (disabled at speed > 1).
let speedButtons: HTMLButtonElement[] = [];
let speedNoteEl: HTMLDivElement | null = null;
let speedResultEl: HTMLDivElement | null = null;
let audioCheckboxEl: HTMLInputElement | null = null;

// Speed-up (timelapse) selector: a segmented row of factors. > 1 forces the
// re-encode path and mutes audio (handled in export-flow); the UI reflects that
// via syncSpeedDependentUi. Labels mirror the player speed control ("2x").
function renderSpeedGroup(): HTMLElement {
    const wrap = document.createElement("fieldset");
    wrap.className = "export-panel__group";
    const legend = document.createElement("legend");
    legend.textContent = t("export.speed.legend");
    wrap.appendChild(legend);

    const row = document.createElement("div");
    row.className = "export-panel__segmented";
    speedButtons = [];
    for (const factor of SPEED_FACTORS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "export-panel__seg-btn";
        btn.dataset.factor = String(factor);
        btn.textContent = `${factor}x`;
        btn.addEventListener("click", () => {
            exportPanelState.speedFactor = factor;
            // notify -> syncExportPanel -> syncSpeedDependentUi refreshes the
            // highlight, audio state and result length in one place.
            notifyExportStateChanged();
        });
        row.appendChild(btn);
        speedButtons.push(btn);
    }
    wrap.appendChild(row);

    // Resulting clip length (selected range / factor). Shown only when sped up;
    // kept current by syncSpeedDependentUi on both speed and range changes.
    const result = document.createElement("div");
    result.className = "export-panel__note export-panel__speed-result";
    speedResultEl = result;
    wrap.appendChild(result);

    const note = document.createElement("div");
    note.className = "export-panel__note";
    note.textContent = t("export.speed.note");
    speedNoteEl = note;
    wrap.appendChild(note);

    return wrap;
}

// Reflects the current speed factor: highlights the active button, shows the
// "audio muted" note and, since audio is force-dropped above 1x, clears and
// disables the "include audio" checkbox. Called on init and after every
// speed-button click. Cheap - a handful of DOM toggles.
function syncSpeedDependentUi(): void {
    const factor = exportPanelState.speedFactor;
    const spedUp = factor > 1;
    for (const btn of speedButtons) {
        const active = Number(btn.dataset.factor) === factor;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
    }
    if (speedNoteEl) speedNoteEl.hidden = !spedUp;
    if (audioCheckboxEl) {
        audioCheckboxEl.disabled = spedUp;
        audioCheckboxEl.checked = !spedUp && exportPanelState.withAudio;
        audioCheckboxEl.closest(".export-panel__checkbox")?.classList.toggle("is-disabled", spedUp);
    }
    // Resulting clip length = selected range / factor. The range falls back to
    // the full trip when no explicit range is set (mirrors the trim bar).
    if (speedResultEl) {
        if (!spedUp) {
            speedResultEl.hidden = true;
        } else {
            const trip = activeTrip();
            const range = exportPanelState.range;
            const span = range ? Math.max(0, range.endTripSec - range.startTripSec) : (trip?.durationSec ?? 0);
            speedResultEl.textContent = t("export.speed.result", { dur: formatTime(span / factor) });
            speedResultEl.hidden = false;
        }
    }
}

// Crop affordance: a button that opens the on-tile crop editor for the active
// channel (the double-click-a-tile gesture still works and is the only way to
// crop a non-main slot in split layouts). The editor itself owns the aspect
// presets, the "Original" reset and the how-to hint (player-crop shows
// export.crop.hint in the editor overlay, when it is actionable) - this is just
// a discoverable entry point, so no hint here.
function renderCropGroup(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "export-panel__group";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "export-panel__secondary-btn export-panel__crop-btn";
    btn.textContent = t("export.crop.button");
    btn.addEventListener("click", () => enterCropEditMain());
    wrap.appendChild(btn);

    return wrap;
}

// --- Privacy blur zones ----------------------------------------------------
// Built once (like the rest of the options section); the dynamic parts (add
// button label, zone rows) live in module refs and are re-synced by
// syncBlurGroup on blur-region / export-state changes (subscribed in
// initExportPanel - the section itself is never rebuilt at runtime).

let blurAddBtnEl: HTMLButtonElement | null = null;
let blurListEl: HTMLDivElement | null = null;
let blurStyleRowEl: HTMLDivElement | null = null;
let blurMoveHintEl: HTMLDivElement | null = null;
let blurTrackerStripEl: HTMLDivElement | null = null;
// Asset groups the Follow path needs (the detect checkboxes have their own).
const FOLLOW_GROUPS: readonly BlurAssetGroupId[] = ["track"];
// Detect-checkbox UI refs (the "blur all plates / faces" block).
let blurDetectStripEl: HTMLDivElement | null = null;
let blurDetectStatusEl: HTMLDivElement | null = null;
let detectReviewCursor = 0;
let detectReviewTrip: ReturnType<typeof activeTrip> = null;
let blurDetectPlatesCbEl: HTMLInputElement | null = null;
let blurDetectFacesCbEl: HTMLInputElement | null = null;
let blurDetectGpuNoteEl: HTMLDivElement | null = null;
let blurDetectQualityEl: HTMLInputElement | null = null;
const blurDetectQualityLabels = new Map<DetectionQuality, HTMLElement>();
const blurDetectThresholdControls = new Map<DetectKind, { input: HTMLInputElement; output: HTMLOutputElement }>();
let blurDetectThresholdResetEl: HTMLButtonElement | null = null;
// The second checkbox can queue a warm behind the first; Cancel owns both.
const detectDownloadControllers = new Set<AbortController>();
// Zones a user asked to Follow that are waiting on the one-time tracker download.
// A Set (not one slot) so Follow on two zones before the download lands both get
// followed, not just the last click. Held across re-renders; drained on success,
// cleared on "not now" / vanished zones.
const pendingFollowRegionIds = new Set<string>();
// Live controller for the in-flight warm, so the strip's Cancel button can abort
// a stalled download. Null when nothing is downloading.
let trackerDownloadCtrl: AbortController | null = null;

function renderBlurGroup(): HTMLElement {
    const wrap = document.createElement("fieldset");
    wrap.className = "export-panel__group";
    const legend = document.createElement("legend");
    legend.textContent = t("export.blur.legend");
    wrap.appendChild(legend);

    if (!__PORTABLE__) {
        // Two labeled halves - automatic (the find-everything checkboxes) and
        // manual (zones) - so the panel reads as two distinct tools, not one
        // stack of controls.
        const autoHead = document.createElement("div");
        autoHead.className = "export-panel__blur-subhead";
        autoHead.textContent = t("export.blur.auto.legend");
        // "beta" pill: detection quality is not guaranteed yet - set that
        // expectation before the first toggle, not after a disappointing result.
        const betaBadge = document.createElement("span");
        betaBadge.className = "export-panel__blur-beta-badge";
        betaBadge.textContent = t("export.blur.auto.beta");
        autoHead.appendChild(betaBadge);
        wrap.appendChild(autoHead);
        // Range-first + takes-a-while nudge ABOVE the checkboxes: it must land
        // before the first toggle burns minutes scanning the wrong span.
        const detectHint = document.createElement("div");
        detectHint.className = "export-panel__note";
        detectHint.textContent = t("export.blur.detect.hint");
        wrap.appendChild(detectHint);
        const platesRow = renderCheckbox("export-panel-blur-plates", t("export.blur.detect.plates"), false, (v) =>
            onDetectToggle("plate", v),
        );
        blurDetectPlatesCbEl = platesRow.querySelector("input");
        wrap.appendChild(platesRow);
        const facesRow = renderCheckbox("export-panel-blur-faces", t("export.blur.detect.faces"), false, (v) =>
            onDetectToggle("face", v),
        );
        blurDetectFacesCbEl = facesRow.querySelector("input");
        wrap.appendChild(facesRow);
        wrap.appendChild(renderDetectQualityControl());
        wrap.appendChild(renderDetectThresholdSettings());
        // Detection is WebGPU-only (see blur-detect.ts) - when the adapter is
        // absent both checkboxes are disabled and this note says why. Availability
        // resolves from an async probe, so syncDetectGroup owns both states.
        const gpuNote = document.createElement("div");
        gpuNote.className = "export-panel__note";
        gpuNote.textContent = t("export.blur.detect.needsGpu");
        gpuNote.hidden = true;
        blurDetectGpuNoteEl = gpuNote;
        wrap.appendChild(gpuNote);
        // No-guarantees note BELOW the checkboxes: check the result, cover any
        // miss with a manual zone.
        const reviewNote = document.createElement("div");
        reviewNote.className = "export-panel__note";
        reviewNote.textContent = t("export.blur.detect.review");
        wrap.appendChild(reviewNote);
        // Detect model-download strip (consent / progress / offline / error) -
        // same machinery as the Follow strip below, keyed to the checkbox intent.
        // Own class (not __blur-tracker): e2e locators address each strip uniquely.
        const detectStrip = document.createElement("div");
        detectStrip.className = "export-panel__blur-detect-strip";
        detectStrip.hidden = true;
        blurDetectStripEl = detectStrip;
        wrap.appendChild(detectStrip);
        // Live pass status: "Scanning… {pct}%" while running, found-counts after.
        const detectStatus = document.createElement("div");
        detectStatus.className = "export-panel__blur-detect-status";
        detectStatus.hidden = true;
        blurDetectStatusEl = detectStatus;
        wrap.appendChild(detectStatus);
    }
    const manualHead = document.createElement("div");
    manualHead.className = "export-panel__blur-subhead";
    manualHead.textContent = t("export.blur.manual.legend");
    wrap.appendChild(manualHead);
    // One capability line (voice.md: outcomes, not internals): draw over
    // anything + a moving object gets followed. The how-to lives where it is
    // actionable - the on-video draw hint while drawing, the keyframe hint
    // under the list once a zone exists.
    const explainer = document.createElement("div");
    explainer.className = "export-panel__note export-panel__blur-explainer";
    explainer.textContent = t(__PORTABLE__ ? "portable.blur.explainer" : "export.blur.explainer");
    wrap.appendChild(explainer);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "export-panel__secondary-btn export-panel__blur-add-btn";
    btn.textContent = t("export.blur.add");
    btn.addEventListener("click", () => toggleBlurDraw());
    blurAddBtnEl = btn;
    wrap.appendChild(btn);

    // Style select: one style for every zone (per-zone override is a possible
    // later refinement; the data model already stores style per region).
    const styleRow = document.createElement("div");
    styleRow.className = "export-panel__blur-style-row";
    const styleLabel = document.createElement("label");
    styleLabel.textContent = t("export.blur.style.label");
    styleLabel.htmlFor = "export-panel-blur-style";
    const styleSelect = document.createElement("select");
    styleSelect.className = "export-panel__blur-style-select";
    styleSelect.id = "export-panel-blur-style";
    for (const styleId of ["pixelate", "fill", "blur"] as const) {
        const opt = document.createElement("option");
        opt.value = styleId;
        opt.textContent = t(`export.blur.style.${styleId}`);
        styleSelect.appendChild(opt);
    }
    styleSelect.value = exportPanelState.blurStyle;
    styleSelect.addEventListener("change", () => {
        const style = styleSelect.value as BlurStyle;
        exportPanelState.blurStyle = style;
        for (const region of activeBlurRegions()) region.style = style;
        // Auto-detected regions follow the same select - one style for all blur.
        if (!__PORTABLE__) setDetectStyle(style);
        notifyBlurRegionsChanged();
        notifyExportStateChanged();
    });
    styleRow.appendChild(styleLabel);
    styleRow.appendChild(styleSelect);
    blurStyleRowEl = styleRow;
    wrap.appendChild(styleRow);

    if (!__PORTABLE__) {
        // One-time tracker-download strip: consent / progress / offline / error.
        // Hidden until a Follow needs the assets (syncTrackerStrip owns visibility).
        const strip = document.createElement("div");
        strip.className = "export-panel__blur-tracker";
        strip.hidden = true;
        blurTrackerStripEl = strip;
        wrap.appendChild(strip);
    }
    const list = document.createElement("div");
    list.className = "export-panel__blur-list";
    blurListEl = list;
    wrap.appendChild(list);

    // Keyframe how-to: the box is re-pinned by moving it while scrubbing.
    // Meaningless before the first zone exists, so syncBlurGroup shows it only
    // when the list is non-empty.
    const moveHint = document.createElement("div");
    moveHint.className = "export-panel__note";
    moveHint.textContent = t("export.blur.hint");
    moveHint.hidden = true;
    blurMoveHintEl = moveHint;
    wrap.appendChild(moveHint);

    syncBlurGroup();
    if (!__PORTABLE__) syncTrackerStrip();
    if (!__PORTABLE__) syncDetectGroup();
    return wrap;
}

function formatDetectionThreshold(value: number): string {
    return new Intl.NumberFormat(getDateLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function renderDetectThresholdSettings(): HTMLElement {
    const details = document.createElement("details");
    details.className = "export-panel__detect-settings";
    const summary = document.createElement("summary");
    summary.textContent = t("export.blur.detect.settings");
    const hint = document.createElement("div");
    hint.id = "export-panel-detect-threshold-hint";
    hint.className = "export-panel__note";
    hint.textContent = t("export.blur.detect.threshold.hint");
    details.append(summary, hint);
    blurDetectThresholdControls.clear();
    for (const kind of ["face", "plate"] as const) {
        const control = document.createElement("div");
        control.className = "export-panel__detect-threshold";
        const defaultValue = DETECTION_POLICIES[kind].seedScoreMin;
        const fraction = (defaultValue - DETECTION_THRESHOLD_MIN) / (DETECTION_THRESHOLD_MAX - DETECTION_THRESHOLD_MIN);
        control.style.setProperty("--default-position", `${fraction * 100}%`);
        const heading = document.createElement("div");
        heading.className = "export-panel__detect-threshold-heading";
        const label = document.createElement("label");
        label.htmlFor = `export-panel-detect-threshold-${kind}`;
        label.textContent = t(`export.blur.detect.threshold.${kind}`);
        const output = document.createElement("output");
        output.htmlFor.value = label.htmlFor;
        heading.append(label, output);
        const range = document.createElement("div");
        range.className = "export-panel__detect-threshold-range";
        const input = document.createElement("input");
        input.id = label.htmlFor;
        input.type = "range";
        input.min = String(DETECTION_THRESHOLD_MIN);
        input.max = String(DETECTION_THRESHOLD_MAX);
        input.step = String(DETECTION_THRESHOLD_STEP);
        const defaultNote = document.createElement("div");
        defaultNote.id = `${input.id}-default`;
        defaultNote.className = "export-panel__note";
        defaultNote.textContent = t("export.blur.detect.threshold.default", {
            value: formatDetectionThreshold(defaultValue),
        });
        input.setAttribute("aria-describedby", `${hint.id} ${defaultNote.id}`);
        input.addEventListener("input", () => {
            setDetectThreshold(kind, Number(input.value));
            notifyExportStateChanged();
        });
        const marker = document.createElement("div");
        marker.className = "export-panel__detect-threshold-marker";
        marker.setAttribute("aria-hidden", "true");
        range.append(input, marker);
        const ends = document.createElement("div");
        ends.className = "export-panel__detect-threshold-ends";
        for (const key of ["more", "confident"] as const) {
            const end = document.createElement("span");
            end.textContent = t(`export.blur.detect.threshold.${key}`);
            ends.appendChild(end);
        }
        control.append(heading, range, ends, defaultNote);
        details.appendChild(control);
        blurDetectThresholdControls.set(kind, { input, output });
    }
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "export-panel__secondary-btn";
    reset.textContent = t("export.blur.detect.threshold.reset");
    reset.addEventListener("click", () => {
        for (const kind of ["face", "plate"] as const) setDetectThreshold(kind, DETECTION_POLICIES[kind].seedScoreMin);
        notifyExportStateChanged();
    });
    blurDetectThresholdResetEl = reset;
    details.appendChild(reset);
    return details;
}

function renderDetectQualityControl(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "export-panel__detect-quality";
    const label = document.createElement("label");
    label.htmlFor = "export-panel-detect-quality";
    label.textContent = t("export.blur.detect.quality.label");
    const input = document.createElement("input");
    input.id = label.htmlFor;
    input.type = "range";
    input.min = "0";
    input.max = String(DETECTION_QUALITIES.length - 1);
    input.step = "1";
    input.setAttribute("aria-describedby", "export-panel-detect-quality-hint");
    input.addEventListener("input", () => {
        const quality = DETECTION_QUALITIES[Number(input.value)];
        if (!quality) return;
        setDetectQuality(quality);
        notifyExportStateChanged();
    });
    blurDetectQualityEl = input;
    const stops = document.createElement("div");
    stops.className = "export-panel__detect-quality-stops";
    stops.setAttribute("aria-hidden", "true");
    blurDetectQualityLabels.clear();
    for (const quality of DETECTION_QUALITIES) {
        const stop = document.createElement("span");
        stop.textContent = t(`export.blur.detect.quality.${quality}`);
        blurDetectQualityLabels.set(quality, stop);
        stops.appendChild(stop);
    }
    const hint = document.createElement("div");
    hint.id = "export-panel-detect-quality-hint";
    hint.className = "export-panel__note";
    hint.textContent = t("export.blur.detect.quality.hint");
    wrap.append(label, input, stops, hint);
    return wrap;
}

// --- tracker download gate --------------------------------------------------

/** Follow-button handler. Cancels a running pass, else routes through the
 *  one-time asset download: ready -> follow now; never downloaded -> ask for
 *  consent; consented-but-not-warmed-this-session -> warm silently then follow. */
function onFollowClick(region: BlurRegion): void {
    const trip = activeTrip();
    if (!trip) return;
    if (pendingFollowRegionIds.has(region.id)) {
        cancelRegionFollow(region.id);
        syncBlurGroup();
        return;
    }
    if (trackPassOf(region.id)) {
        void toggleTrackPass(trip, region); // running -> cancel
        return;
    }
    if (blurAssetsReady(FOLLOW_GROUPS)) {
        runFollow(region);
        return;
    }
    if (blurAssetsNeedDownload(FOLLOW_GROUPS)) {
        // First time on this device: surface the size + offline story and wait
        // for an explicit click before pulling ~14 MB.
        pendingFollowRegionIds.add(region.id);
        syncBlurGroup();
        if (!__PORTABLE__) syncTrackerStrip();
        return;
    }
    // Already consented once (assets cached): warm from cache (fast) and follow.
    pendingFollowRegionIds.add(region.id);
    syncBlurGroup();
    void startTrackerDownload();
}

function cancelRegionFollow(regionId: string): void {
    const wasPending = pendingFollowRegionIds.delete(regionId);
    cancelTrackPass(regionId);
    if (!wasPending) return;
    if (pendingFollowRegionIds.size === 0) trackerDownloadCtrl?.abort();
    if (!__PORTABLE__) syncTrackerStrip();
}

/** Flips the zone to auto-tracked and starts the pass. Follow always owns the
 *  end (autoEnd) - it is the tool for something that moves, so tracking decides
 *  where the cover stops. */
function runFollow(region: BlurRegion): void {
    const trip = activeTrip();
    if (!trip) return;
    const previousAutoEnd = region.autoEnd;
    region.autoEnd = true;
    notifyBlurRegionsChanged();
    void toggleTrackPass(trip, region).then((outcome) => {
        // Follow is optimistic while the async pass runs. If it never produced
        // a result (cancel, timeout, worker failure, no usable span), restore
        // the user's previous timing mode. Do not undo an explicit Set-time
        // click made while cancellation was settling.
        if (outcome !== "completed" && region.autoEnd) {
            region.autoEnd = previousAutoEnd;
            notifyBlurRegionsChanged();
            notifyExportStateChanged();
        }
    });
}

/** Runs the download (progress + Cancel land on the strip) and, on success,
 *  follows every zone that was waiting. Used by the consent Download button and
 *  the error/offline Retry. Concurrent calls share the one in-flight warm. */
async function startTrackerDownload(): Promise<void> {
    if (trackerDownloadCtrl) return; // a warm is already in flight
    const ctrl = new AbortController();
    trackerDownloadCtrl = ctrl;
    let ok = false;
    try {
        ok = await downloadBlurAssets(FOLLOW_GROUPS, ctrl.signal);
    } finally {
        trackerDownloadCtrl = null;
    }
    if (ok) {
        // Drain the queue: follow every still-existing waiting zone.
        const regions = activeBlurRegions();
        const ids = [...pendingFollowRegionIds];
        pendingFollowRegionIds.clear();
        for (const id of ids) {
            const region = regions.find((r) => r.id === id);
            if (region) runFollow(region);
        }
    }
    if (!__PORTABLE__) syncTrackerStrip();
}

type BlurDownloadStripPhase = "hidden" | "downloading" | "offline" | "error" | "consent";

interface BlurDownloadStripOptions {
    phase: BlurDownloadStripPhase;
    progress: number;
    consentMessage: () => string;
    downloadLabel: I18nKey;
    onDownload: () => Promise<void>;
    onCancel: () => void;
    onDismiss: () => void;
}

function syncBlurDownloadStrips(): void {
    if (!__PORTABLE__) syncTrackerStrip();
    syncDetectStrip();
}

/** Progress updates preserve the focused Cancel button; only phase changes
 * rebuild the strip. Each feature owns its consent and download lifecycle. */
function syncBlurDownloadStrip(
    strip: HTMLElement,
    previousPhase: BlurDownloadStripPhase | null,
    options: BlurDownloadStripOptions,
): BlurDownloadStripPhase {
    const { phase, progress } = options;
    if (phase === previousPhase) {
        if (phase === "downloading") syncTrackerProgress(strip, progress);
        if (phase === "consent") {
            const message = strip.querySelector(".export-panel__blur-tracker-msg");
            if (message) message.textContent = options.consentMessage();
        }
        return phase;
    }
    strip.innerHTML = "";
    strip.classList.toggle("is-error", phase === "error");
    strip.hidden = phase === "hidden";
    if (phase === "hidden") return phase;
    if (phase === "downloading") {
        strip.append(
            trackerProgressNode(progress),
            trackerActionsNode([
                { label: t("export.blur.tracker.cancel"), onClick: options.onCancel, secondary: true },
            ]),
        );
        return phase;
    }
    strip.append(
        trackerMessageNode(phase === "consent" ? options.consentMessage() : t(`export.blur.tracker.${phase}`)),
        trackerActionsNode([
            {
                label: t(phase === "consent" ? options.downloadLabel : "export.blur.tracker.retry"),
                onClick: () => void options.onDownload(),
            },
            { label: t("export.blur.tracker.notNow"), onClick: options.onDismiss, secondary: true },
        ]),
    );
    return phase;
}

let trackerStripPhase: BlurDownloadStripPhase | null = null;

/** Renders the consent / progress / offline / error strip from tracker state +
 *  the pending-follow intent. Hidden when nothing is downloading and no Follow
 *  is waiting. */
function syncTrackerStrip(): void {
    const strip = blurTrackerStripEl;
    if (!strip) return;
    syncSaveAvailability();
    const { phase, progress, activeGroups } = blurAssetsState();
    const pending = pendingFollowRegionIds.size > 0;
    // Only downloads/errors this strip initiated (the Follow path) belong here -
    // a detect-checkbox warm renders on its own row, not on the Follow strip.
    const followDownload = activeGroups?.includes("track") ?? false;
    // Offline-ness is derived LIVE (no sticky phase), so a reconnect flips the
    // strip from "reconnect once" straight to consent on the next render.
    const offlineNow = blurAssetsBlockedOffline(FOLLOW_GROUPS);
    // Ready hides immediately, before the waiting zones are drained in the next
    // microtask. In-flight warms always show Cancel, even when already consented.
    const stripPhase =
        phase === "downloading" && followDownload
            ? "downloading"
            : blurAssetsReady(FOLLOW_GROUPS) || !pending
              ? "hidden"
              : offlineNow
                ? "offline"
                : phase === "error" && followDownload
                  ? "error"
                  : "consent";
    trackerStripPhase = syncBlurDownloadStrip(strip, trackerStripPhase, {
        phase: stripPhase,
        progress,
        consentMessage: () => t("export.blur.tracker.consent", { mb: blurAssetsDownloadMb(FOLLOW_GROUPS) }),
        downloadLabel: "export.blur.tracker.download",
        onDownload: startTrackerDownload,
        onCancel: cancelTrackerDownload,
        onDismiss: dismissTrackerStrip,
    });
}

function dismissTrackerStrip(): void {
    pendingFollowRegionIds.clear();
    syncBlurGroup();
    if (!__PORTABLE__) syncTrackerStrip();
}

// --- detect checkboxes ("blur all plates / faces") ---------------------------

function enabledDetectKinds(): DetectKind[] {
    const kinds: DetectKind[] = [];
    if (detectEnabled("plate")) kinds.push("plate");
    if (detectEnabled("face")) kinds.push("face");
    return kinds;
}

/** Checkbox handler. Enabling routes through the one-time model download:
 *  consented before -> warm silently and scan; never downloaded -> the consent
 *  strip appears (derived from need-download state, no pending set required)
 *  and its Download button starts the scan. */
function onDetectToggle(kind: DetectKind, on: boolean): void {
    setDetectEnabled(kind, on);
    if (on) void startDetectDownload({ canDownloadNew: false });
    else if (enabledDetectKinds().length === 0) cancelDetectDownload();
    if (!__PORTABLE__) syncDetectGroup();
    // The re-encode gate + size estimate flip with the checkbox (a pending scan
    // is assumed to find something - see anyBlurRegionInExport).
    notifyExportStateChanged();
}

/** Runs the detect-model download (progress + Cancel land on the detect strip)
 *  and starts the scan on success. */
async function startDetectDownload(options?: BlurAssetDownloadOptions): Promise<void> {
    const ctrl = new AbortController();
    detectDownloadControllers.add(ctrl);
    let ok = false;
    try {
        ok = await downloadBlurAssets(detectAssetGroups(enabledDetectKinds()), ctrl.signal, options);
    } finally {
        detectDownloadControllers.delete(ctrl);
    }
    if (ok && !ctrl.signal.aborted && blurAssetsReady(detectAssetGroups(enabledDetectKinds()))) ensureDetectPass();
    if (!__PORTABLE__) syncDetectGroup();
}

/** "Not now": un-check the kinds that still need a download - a checked box
 *  with no model would silently protect nothing. */
function dismissDetectStrip(): void {
    cancelDetectDownload();
    for (const kind of enabledDetectKinds()) {
        if (blurAssetsNeedDownload(detectAssetGroups([kind]))) setDetectEnabled(kind, false);
    }
    if (enabledDetectKinds().length > 0) void startDetectDownload({ canDownloadNew: false });
    if (!__PORTABLE__) syncDetectGroup();
    notifyExportStateChanged();
}

function cancelDetectDownload(): void {
    for (const controller of detectDownloadControllers) controller.abort();
    syncDetectStrip();
}

let detectStripPhase: BlurDownloadStripPhase | null = null;

/** Detection consent follows the enabled kinds' asset state, independent of
 *  pending Follow requests. */
function syncDetectStrip(): void {
    const strip = blurDetectStripEl;
    if (!strip) return;
    const kinds = enabledDetectKinds();
    const groups = detectAssetGroups(kinds);
    const { phase, progress, activeGroups } = blurAssetsState();
    const detectDownload = activeGroups?.some((g) => g !== "track") ?? false;
    const need = kinds.length > 0 && blurAssetsNeedDownload(groups);
    const offlineNow = kinds.length > 0 && blurAssetsBlockedOffline(groups);
    const stripPhase =
        phase === "downloading" && detectDownload
            ? "downloading"
            : !need
              ? "hidden"
              : offlineNow
                ? "offline"
                : phase === "error" && detectDownload
                  ? "error"
                  : "consent";
    detectStripPhase = syncBlurDownloadStrip(strip, detectStripPhase, {
        phase: stripPhase,
        progress,
        consentMessage: () => t("export.blur.detect.consent", { mb: blurAssetsDownloadMb(groups) }),
        downloadLabel: "export.blur.detect.download",
        onDownload: startDetectDownload,
        onCancel: cancelDetectDownload,
        onDismiss: dismissDetectStrip,
    });
}

let detectStatusSig: string | null = null;

/** Re-syncs the checkbox checked state (per-trip flags) and the status row:
 *  scan progress while running, per-kind found counts once fresh. */
function syncDetectGroup(): void {
    const reviewTrip = activeTrip();
    if (reviewTrip !== detectReviewTrip) {
        detectReviewTrip = reviewTrip;
        detectReviewCursor = 0;
    }
    if (blurDetectPlatesCbEl) {
        blurDetectPlatesCbEl.checked = detectEnabled("plate");
        blurDetectPlatesCbEl.disabled = !detectAvailable();
    }
    if (blurDetectFacesCbEl) {
        blurDetectFacesCbEl.checked = detectEnabled("face");
        blurDetectFacesCbEl.disabled = !detectAvailable();
    }
    if (blurDetectQualityEl) {
        const quality = detectQuality();
        blurDetectQualityEl.value = String(DETECTION_QUALITIES.indexOf(quality));
        blurDetectQualityEl.disabled = !detectAvailable();
        blurDetectQualityEl.setAttribute("aria-valuetext", t(`export.blur.detect.quality.${quality}`));
        for (const [value, label] of blurDetectQualityLabels) label.classList.toggle("is-active", value === quality);
    }
    let hasCustomThreshold = false;
    for (const [kind, { input, output }] of blurDetectThresholdControls) {
        const threshold = detectThreshold(kind);
        input.value = String(threshold);
        input.disabled = !detectAvailable();
        const formatted = formatDetectionThreshold(threshold);
        input.setAttribute("aria-valuetext", formatted);
        output.value = formatted;
        hasCustomThreshold ||= threshold !== DETECTION_POLICIES[kind].seedScoreMin;
    }
    if (blurDetectThresholdResetEl) blurDetectThresholdResetEl.disabled = !detectAvailable() || !hasCustomThreshold;
    if (blurDetectGpuNoteEl) blurDetectGpuNoteEl.hidden = detectAvailable();
    syncDetectStrip();
    const el = blurDetectStatusEl;
    if (!el) return;
    const kinds = enabledDetectKinds();
    const pass = detectPassState();
    const counts = detectCounts();
    const sig = pass
        ? `p${Math.round(pass.fraction * 100)}`
        : counts && kinds.length > 0
          ? `c${counts.plate}|${counts.face}|${kinds.join("+")}`
          : "hidden";
    if (sig === detectStatusSig) return;
    const wasProgress = detectStatusSig?.startsWith("p") ?? false;
    detectStatusSig = sig;
    if (pass) {
        const label = t("export.blur.detect.scanning", { pct: Math.round(pass.fraction * 100) });
        if (wasProgress) {
            syncTrackerProgress(el, pass.fraction, label);
            return;
        }
        el.innerHTML = "";
        el.appendChild(trackerProgressNode(pass.fraction, label));
        el.hidden = false;
        return;
    }
    el.innerHTML = "";
    if (counts && kinds.length > 0) {
        const parts: string[] = [];
        if (kinds.includes("plate")) parts.push(t("export.blur.detect.countPlates", { n: counts.plate }));
        if (kinds.includes("face")) parts.push(t("export.blur.detect.countFaces", { n: counts.face }));
        el.appendChild(trackerMessageNode(parts.join(" · ")));
        const findings = detectRegions()
            .slice()
            .sort((a, b) => a.startSec - b.startSec);
        if (findings.length > 0) {
            const review = document.createElement("button");
            review.type = "button";
            review.className = "export-panel__secondary-btn export-panel__blur-review-btn";
            review.textContent = t("export.blur.detect.reviewFindings");
            review.addEventListener("click", () => {
                const live = detectRegions()
                    .slice()
                    .sort((a, b) => a.startSec - b.startSec);
                if (live.length === 0) return;
                const finding = live[detectReviewCursor % live.length]!;
                detectReviewCursor = (detectReviewCursor + 1) % live.length;
                // Keep short findings strictly inside their exclusive end.
                // The midpoint also avoids seeking just before the first frame.
                seekPresentedContentTime(finding.startSec + Math.min(0.1, (finding.endSec - finding.startSec) / 2));
            });
            el.appendChild(review);
        } else {
            detectReviewCursor = 0;
        }
        el.hidden = false;
        return;
    }
    el.hidden = true;
}

/** Cancel a warm in flight and drop the waiting Follows - the strip hides once
 *  the abort settles the phase back to idle. (Cancel = "never mind", not "retry".) */
function cancelTrackerDownload(): void {
    trackerDownloadCtrl?.abort();
    pendingFollowRegionIds.clear();
    syncBlurGroup();
    if (!__PORTABLE__) syncTrackerStrip();
}

function trackerMessageNode(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "export-panel__blur-tracker-msg";
    el.textContent = text;
    return el;
}

function trackerProgressNode(progress: number, labelText?: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.setAttribute("aria-live", "polite");
    const label = document.createElement("div");
    label.className = "export-panel__blur-tracker-msg";
    const bar = document.createElement("div");
    bar.className = "export-panel__blur-tracker-bar";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    const fill = document.createElement("div");
    fill.className = "export-panel__blur-tracker-bar-fill";
    bar.appendChild(fill);
    wrap.append(label, bar);
    syncTrackerProgress(wrap, progress, labelText);
    return wrap;
}

function syncTrackerProgress(root: HTMLElement, progress: number, labelText?: string): void {
    const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
    const bar = root.querySelector<HTMLElement>(".export-panel__blur-tracker-bar");
    if (!bar || bar.getAttribute("aria-valuenow") === String(pct)) return;
    const progressLabel = labelText ?? t("export.blur.tracker.progress", { pct });
    const label = root.querySelector(".export-panel__blur-tracker-msg");
    if (label) label.textContent = progressLabel;
    bar.setAttribute("aria-label", progressLabel);
    bar.setAttribute("aria-valuenow", String(pct));
    const fill = bar.querySelector<HTMLElement>(".export-panel__blur-tracker-bar-fill");
    if (fill) fill.style.width = `${pct}%`;
}

function trackerActionsNode(
    actions: ReadonlyArray<{ label: string; onClick: () => void; secondary?: boolean }>,
): HTMLElement {
    const row = document.createElement("div");
    row.className = "export-panel__blur-tracker-actions";
    for (const a of actions) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = a.secondary ? "export-panel__secondary-btn" : "export-panel__primary-btn";
        b.textContent = a.label;
        b.addEventListener("click", a.onClick);
        row.appendChild(b);
    }
    return row;
}

/** Small state badge for a zone, shown only when it says something the mode
 *  control below cannot: a persistent ending-review warning after a pass
 *  ended early (the incomplete-tail risk must outlive the toast), or "Tracked"
 *  for a Set-time zone whose box still moves on keyframes a pass filled in. A
 *  healthy Follow shows nothing - the active Follow segment already says it. */
function zoneStateLabel(region: BlurRegion): string | null {
    if (!regionHasTrackedKeyframes(region)) return null;
    if (region.lastTrackLost) return t("export.blur.state.lostCheckEnd");
    return region.autoEnd ? null : t("export.blur.state.tracked");
}

/** Re-syncs the blur group's dynamic parts: add-button label (armed state) and
 *  the zone rows. Cheap full rebuild of the small list - zones are few.
 *  null (not "") is the initial sentinel: an empty zone list has signature "",
 *  so a "" start would short-circuit the very first sync and never apply the
 *  zero-zone DOM state (hide the style row and the keyframe hint). */
let blurListSig: string | null = null;
const followProgressButtons = new Map<string, { button: HTMLButtonElement; pct: number }>();

function syncFollowProgress(): void {
    for (const [id, entry] of followProgressButtons) {
        const pass = trackPassOf(id);
        if (!pass) continue;
        const pct = Math.round(pass.fractionDone * 100);
        if (entry.pct === pct) continue;
        entry.pct = pct;
        entry.button.textContent = t("export.blur.tracker.working", { pct });
    }
}

function syncBlurGroup(): void {
    if (blurAddBtnEl) {
        blurAddBtnEl.textContent = isBlurDrawArmed() ? t("export.blur.cancel") : t("export.blur.add");
        blurAddBtnEl.classList.toggle("is-armed", isBlurDrawArmed());
        blurAddBtnEl.setAttribute("aria-pressed", String(isBlurDrawArmed()));
    }
    const list = blurListEl;
    if (!list) return;
    const regions = activeBlurRegions();
    const autoStyle = __PORTABLE__ ? null : detectStyle();
    // Manual zones are authoritative when present; an auto-only trip uses its
    // own remembered detect style. Do this before the signature early-return:
    // switching between two trips with no manual rows must still update Select.
    const effectiveStyle = regions[0]?.style ?? autoStyle ?? exportPanelState.blurStyle;
    if (!__PORTABLE__ && regions.length > 0 && autoStyle !== effectiveStyle) setDetectStyle(effectiveStyle);
    exportPanelState.blurStyle = effectiveStyle;
    if (blurStyleRowEl) {
        blurStyleRowEl.hidden = regions.length === 0 && enabledDetectKinds().length === 0;
        const select = blurStyleRowEl.querySelector<HTMLSelectElement>("select");
        if (select) select.value = effectiveStyle;
    }
    // Drop pending Follows whose zone vanished (deleted, or a trip switch swapped
    // the region set) so the consent strip does not linger for a zone that no
    // longer exists and a completed download does not follow a stale region.
    if (pendingFollowRegionIds.size > 0) {
        let changed = false;
        for (const id of pendingFollowRegionIds) {
            if (!state.exportModeOpen || !regions.some((r) => r.id === id)) {
                pendingFollowRegionIds.delete(id);
                changed = true;
            }
        }
        if (changed) {
            if (pendingFollowRegionIds.size === 0) trackerDownloadCtrl?.abort();
            if (!__PORTABLE__) syncTrackerStrip();
        }
    }
    // Box drags notify at pointermove rate but only touch keyframes - skip
    // the DOM rebuild unless something the rows actually render changed. autoEnd
    // + tracked + lost flags drive the state badge. Follow progress only updates
    // its button text: rebuilding every zone row would discard focus and create
    // DOM churn while the worker is already busy analyzing frames.
    const sig = `${effectiveStyle}|${enabledDetectKinds().join("+")}|${regions
        .map((r) => {
            const pct = trackPassOf(r.id);
            return `${r.id}|${r.startSec.toFixed(3)}|${r.endSec.toFixed(3)}|${r.style}|${r.autoEnd ? 1 : 0}|${
                regionHasTrackedKeyframes(r) ? 1 : 0
            }|${r.lastTrackLost ? 1 : 0}|${pct ? 1 : 0}|${pendingFollowRegionIds.has(r.id)}`;
        })
        .join(";")}`;
    if (sig === blurListSig) {
        syncFollowProgress();
        return;
    }
    blurListSig = sig;
    // The keyframe hint refers to a box that exists - hide it until the first
    // zone (the empty list needs no note: the Add button IS the empty state).
    if (blurMoveHintEl) blurMoveHintEl.hidden = regions.length === 0;
    const focused = document.activeElement;
    const focusedRow =
        focused instanceof HTMLElement && list.contains(focused)
            ? focused.closest<HTMLElement>("[data-region-id]")
            : null;
    const focusedAction = focused instanceof HTMLElement ? focused.dataset.action : undefined;
    followProgressButtons.clear();
    list.innerHTML = "";
    regions.forEach((region, i) => {
        list.appendChild(renderBlurRow(region, i));
    });
    if (focusedRow && focusedAction) {
        const row = Array.from(list.children).find(
            (el) => el instanceof HTMLElement && el.dataset.regionId === focusedRow.dataset.regionId,
        );
        const target = Array.from(row?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
            (button) => button.dataset.action === focusedAction,
        );
        (target ?? blurAddBtnEl)?.focus({ preventScroll: true });
    }
}

/** Manual timing mode: the user owns the start/end, while tracked motion and
 *  any tail-review warning stay intact. autoEnd is timing ownership, not
 *  geometry. */
function setBlurManualTimeMode(region: BlurRegion): void {
    cancelRegionFollow(region.id);
    region.autoEnd = false;
    notifyBlurRegionsChanged();
    notifyExportStateChanged();
}

/** Whole-export shortcut: use the selected clip range, not the whole source
 *  trip (which made a row labelled "whole clip" show unrelated timestamps). */
function setBlurWholeClip(region: BlurRegion, startSec: number, endSec: number): void {
    cancelRegionFollow(region.id);
    region.startSec = startSec;
    region.endSec = endSec;
    region.autoEnd = false;
    notifyBlurRegionsChanged();
    notifyExportStateChanged();
}

/** Anchor to this channel's displayed frame, preserving the conservative
 *  back-off and minimum span used by zone creation. */
function setBlurStartHere(region: BlurRegion): void {
    const frame = channelPresentedFrame(region.channel, true);
    if (!frame) return;
    cancelRegionFollow(region.id);
    region.startSec = Math.min(
        Math.max(0, frame.contentSec - ZONE_START_PLAYHEAD_BACKOFF_SEC),
        Math.max(0, region.endSec - MIN_ZONE_SPAN_SEC),
    );
    notifyBlurRegionsChanged();
    notifyExportStateChanged();
}

/** Move the zone end to this channel's displayed frame without collapsing it. */
function setBlurEndHere(region: BlurRegion): void {
    const frame = channelPresentedFrame(region.channel, true);
    if (!frame) return;
    cancelRegionFollow(region.id);
    const durationSec = activeTrip()?.timeline.contentDurationSec ?? region.endSec;
    region.endSec = Math.min(durationSec, Math.max(frame.contentSec, region.startSec + MIN_ZONE_SPAN_SEC));
    if (region.endSec - region.startSec < MIN_ZONE_SPAN_SEC) {
        region.startSec = Math.max(0, region.endSec - MIN_ZONE_SPAN_SEC);
    }
    notifyBlurRegionsChanged();
    notifyExportStateChanged();
}

/** One zone row:
 *  - header: name (left) · clickable time-range + delete (right).
 *  - the state badge on its own line, when the zone has a tracked pass.
 *  - a two-way mode control: Follow (tracking owns the box, for a moving object)
 *    vs Set time (hand-set timing; tracked motion stays). autoEnd is the single source of truth, so there
 *    is no ambiguous state to derive on short clips.
 *  - in Set time: the Start-here / End-here setters plus a Whole-clip shortcut.
 *  Plain labels + a mode selector replace the old cryptic glyph row: the audience
 *  is drivers, not video editors, and tooltips do not exist on touch. */
function renderBlurRow(region: BlurRegion, index: number): HTMLElement {
    const trip = activeTrip();

    const row = document.createElement("div");
    row.className = "export-panel__blur-row";
    row.dataset.regionId = region.id;

    // --- header: name + badge (left), time-range + delete (right) -------------
    const head = document.createElement("div");
    head.className = "export-panel__blur-row-head";

    const name = document.createElement("span");
    name.className = "export-panel__blur-row-name";
    const zoneName = t("export.blur.zone", { n: index + 1 });
    name.textContent = trip ? `${zoneName} · ${channelDisplayLabel(region.channel, trip)}` : zoneName;
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", name.textContent);
    head.appendChild(name);

    // The range doubles as the "jump to start" control: the old ▸ glyph sat right
    // next to the player's real play button and read as play.
    const range = document.createElement("button");
    range.type = "button";
    range.dataset.action = "jump";
    range.className = "export-panel__blur-row-range";
    range.textContent = `${formatTime(region.startSec)}-${formatTime(region.endSec)}`;
    range.title = t("export.blur.row.jump");
    range.setAttribute("aria-label", t("export.blur.row.jump"));
    range.addEventListener("click", () => seekPresentedContentTime(region.startSec));
    head.appendChild(range);

    const del = document.createElement("button");
    del.type = "button";
    del.dataset.action = "delete";
    del.className = "export-panel__blur-del-btn";
    del.textContent = "✕";
    del.title = t("export.blur.row.delete");
    del.setAttribute("aria-label", t("export.blur.row.delete"));
    del.addEventListener("click", () => {
        // Abort an in-flight pass first: an orphaned pass keeps decoding and holds
        // the worker's single-pass gate, blocking the next Follow.
        cancelRegionFollow(region.id);
        removeBlurRegion(region.id);
        notifyExportStateChanged();
    });
    head.appendChild(del);
    row.appendChild(head);

    // The state badge gets its own line: sharing the header with the time range
    // truncated it mid-word in the narrow drawer, and "check end" is a privacy
    // warning that must stay fully readable.
    const stateLabel = __PORTABLE__ ? null : zoneStateLabel(region);
    if (stateLabel) {
        const badge = document.createElement("span");
        badge.className = "export-panel__blur-row-state";
        // Warn tone when the tail needs review, so "check end" reads as caution.
        badge.classList.toggle("is-warn", region.lastTrackLost);
        badge.textContent = stateLabel;
        row.appendChild(badge);
    }

    if (!__PORTABLE__) {
        // --- mode: Follow-owned vs user-owned timing -------------------------------
        const seg = document.createElement("div");
        seg.className = "export-panel__segmented export-panel__blur-duration";
        const mkSeg = (
            action: string,
            label: string,
            title: string,
            active: boolean,
            onClick: () => void,
        ): HTMLButtonElement => {
            const b = document.createElement("button");
            b.type = "button";
            b.dataset.action = action;
            b.className = "export-panel__seg-btn";
            b.textContent = label;
            b.title = title;
            b.setAttribute("aria-label", title);
            b.classList.toggle("active", active);
            b.setAttribute("aria-pressed", String(active));
            b.addEventListener("click", onClick);
            return b;
        };

        const pass = trackPassOf(region.id);
        const running = !!pass;
        const pending = pendingFollowRegionIds.has(region.id);
        // Follow shows live decode progress ("Following… 42%") while a pass runs and
        // cancels on click - the async pass is otherwise invisible and reads as stuck.
        // The percent tracks footage decoded; on early loss it ends before 100%
        // (loss-defined span), which is honest.
        const followSeg = mkSeg(
            "follow",
            running
                ? t("export.blur.tracker.working", { pct: Math.round((pass?.fractionDone ?? 0) * 100) })
                : pending
                  ? t("export.blur.tracker.cancel")
                  : t("export.blur.follow"),
            running || pending ? t("export.blur.row.trackCancel") : t("export.blur.row.track"),
            region.autoEnd || pending,
            () => onFollowClick(region),
        );
        followSeg.classList.add("export-panel__blur-follow-btn");
        followSeg.classList.toggle("is-running", running);
        if (pass) followProgressButtons.set(region.id, { button: followSeg, pct: Math.round(pass.fractionDone * 100) });
        seg.appendChild(followSeg);
        seg.appendChild(
            mkSeg(
                "fixed",
                t("export.blur.mode.fixed"),
                t("export.blur.mode.fixedHint"),
                !region.autoEnd && !pending,
                () => setBlurManualTimeMode(region),
            ),
        );
        row.appendChild(seg);
    }
    // --- Manual timing: playhead setters + a whole-clip shortcut --------------
    if (__PORTABLE__ || !region.autoEnd) {
        const fixed = document.createElement("div");
        fixed.className = "export-panel__blur-row-actions";
        const mkBtn = (action: string, label: string, title: string, onClick: () => void): HTMLButtonElement => {
            const b = document.createElement("button");
            b.type = "button";
            b.dataset.action = action;
            b.className = "dc-btn dc-btn--secondary export-panel__blur-row-btn";
            b.textContent = label;
            b.title = title;
            b.setAttribute("aria-label", title);
            b.addEventListener("click", onClick);
            return b;
        };
        fixed.appendChild(
            mkBtn("start", t("export.blur.setStart"), t("export.blur.row.setStart"), () => setBlurStartHere(region)),
        );
        fixed.appendChild(
            mkBtn("end", t("export.blur.setEnd"), t("export.blur.row.setEnd"), () => setBlurEndHere(region)),
        );
        fixed.appendChild(
            mkBtn("whole", t("export.blur.mode.wholeClip"), t("export.blur.wholeClip"), () => {
                const range = exportPanelState.range;
                if (range) setBlurWholeClip(region, range.startTripSec, range.endTripSec);
            }),
        );
        row.appendChild(fixed);
    }

    return row;
}

function renderToggleGroup(): HTMLElement {
    const wrap = document.createElement("fieldset");
    wrap.className = "export-panel__group";
    const legend = document.createElement("legend");
    legend.textContent = t("export.opt.legend");
    wrap.appendChild(legend);
    wrap.appendChild(
        renderCheckbox("export-panel-audio", t("export.opt.audio"), exportPanelState.withAudio, (v) => {
            exportPanelState.withAudio = v;
            notifyExportStateChanged();
        }),
    );
    wrap.appendChild(
        renderCheckbox("export-panel-gpmf", t("export.opt.gpmf"), exportPanelState.withGpmf, (v) => {
            exportPanelState.withGpmf = v;
            notifyExportStateChanged();
        }),
    );
    wrap.appendChild(
        renderCheckbox("export-panel-gpx", t("export.opt.gpx"), exportPanelState.withGpx, (v) => {
            exportPanelState.withGpx = v;
            notifyExportStateChanged();
        }),
    );
    wrap.appendChild(
        renderCheckbox(
            "export-panel-blur",
            t("export.opt.letterboxBlur"),
            exportPanelState.letterboxFill === "blur",
            (v) => {
                exportPanelState.letterboxFill = v ? "blur" : "black";
                notifyExportStateChanged();
            },
        ),
    );
    // Watermark control last in the group so revealing the plea below it shifts
    // nothing the user is about to click (same rule as the overlay extras block).
    wrap.appendChild(
        renderCheckbox("export-panel-watermark", t("export.opt.watermark"), exportPanelState.withWatermark, (v) => {
            exportPanelState.withWatermark = v;
            // The preview mark lives in player-overlays and re-reads this on notify.
            notifyExportStateChanged();
        }),
    );
    const plea = document.createElement("div");
    plea.id = "export-panel-watermark-plea";
    plea.className = "export-panel__note export-panel__watermark-plea";
    plea.textContent = t("export.opt.watermark.plea");
    plea.hidden = true;
    watermarkPleaEl = plea;
    wrap.appendChild(plea);
    syncWatermarkOpt();
    return wrap;
}

// The "why the mark is there" note and its checkbox are reconciled per state tick.
let watermarkPleaEl: HTMLElement | null = null;

/** Shows the note only once the user turns the mark off. */
function syncWatermarkOpt(): void {
    const removing = !exportPanelState.withWatermark;
    const cb = document.getElementById("export-panel-watermark") as HTMLInputElement | null;
    if (cb) cb.checked = exportPanelState.withWatermark;
    if (watermarkPleaEl) watermarkPleaEl.hidden = !removing;
}

// --- Overlay constructor --------------------------------------------------
// The panel is built once (renderOptionsSection); widget toggles / style /
// accent write straight into exportPanelState and notify, and the live player
// preview (player-overlays.ts) re-renders from the same state. The inspector is
// a sub-tree rebuilt imperatively on selection (UI-local, not persisted).

interface OverlayWidgetDef {
    id: OverlayWidgetId;
    labelKey: I18nKey;
    /** Common enable+placement slice (map carries extra fields read directly). */
    state: () => { enabled: boolean; xPct: number; yPct: number; scalePct: number };
    isMap?: boolean;
}

// Built from the canonical OVERLAY_STATE_ACCESSORS (export-state) so the widget
// set and its order live in one place; only the UI-only labelKey (always
// export.overlays.<id>) and the map flag are attached here.
const OVERLAY_WIDGET_DEFS: OverlayWidgetDef[] = OVERLAY_STATE_ACCESSORS.map((o) => ({
    id: o.id,
    labelKey: `export.overlays.${o.id}` as I18nKey,
    state: o.state,
    isMap: o.id === "map",
}));

/** Checkbox DOM id for a widget (stable - syncGpsOptionsAvailability + e2e
 *  reference these). */
function overlayCbId(id: OverlayWidgetId): string {
    return `export-panel-ov-${id}`;
}

function overlayDefFor(id: OverlayWidgetId): OverlayWidgetDef | undefined {
    return OVERLAY_WIDGET_DEFS.find((d) => d.id === id);
}

// Which widget the inspector targets, i.e. which row is expanded (UI-local,
// reset when the panel rebuilds). null = nothing expanded.
let selectedOverlayKey: OverlayWidgetId | null = null;
let overlayInspectorEl: HTMLElement | null = null;
// Per-widget DOM element the inline inspector docks right after (the row, or the
// map-row wrapper). Rebuilt with the widget list; refreshOverlayInspector moves
// the single inspector element under whichever widget is expanded (accordion).
const overlayRowAnchors = new Map<OverlayWidgetId, HTMLElement>();
// GPS availability the inspector DOM was last (re)built for. The per-tick
// reconcile must NOT rebuild the inspector on every notify: refreshOverlayInspector
// wipes innerHTML, and notifyExportStateChanged fires on every slider `input`
// event - a rebuild mid-drag destroys the <input type=range> under the pointer
// and the drag aborts on the first move. So we rebuild only on a real
// no-GPS -> GPS transition; steady-state ticks leave the live slider DOM intact
// (every legitimate content change - selection, preset, align - calls
// refreshOverlayInspector directly, not through this tick).
let inspectorBuiltForGps: boolean | null = null;

function renderOverlaysGroup(): HTMLElement {
    const wrap = document.createElement("fieldset");
    wrap.className = "export-panel__group";
    const legend = document.createElement("legend");
    legend.textContent = t("export.overlays.legend");
    wrap.appendChild(legend);

    const top = document.createElement("div");
    top.className = "export-panel__ov-top";
    top.appendChild(overlaySubhead(t("export.overlays.widgets")));
    const reset = document.createElement("button");
    reset.type = "button";
    reset.id = "export-panel-overlays-reset";
    reset.className = "export-panel__ov-reset";
    reset.textContent = t("export.overlays.reset");
    reset.hidden = !hasCustomOverlayPreferences();
    reset.addEventListener("click", () => {
        selectedOverlayKey = null;
        resetOverlayPreferences();
        const replacement = renderOverlaysGroup();
        wrap.replaceWith(replacement);
        syncMapOverlayAvailability();
        syncGpsOptionsAvailability();
        syncOverlayExtras();
    });
    top.appendChild(reset);
    wrap.appendChild(top);
    overlayResetButtonEl = reset;

    // The widget list owns the inline inspector: a widget's settings expand
    // directly under its row (accordion), so there is no separate bottom
    // inspector block any more.
    wrap.appendChild(renderWidgetList());

    // Style / accent / scrim configure widgets that are on - with zero widgets
    // enabled they style nothing, so the block stays hidden until the first
    // tick (syncOverlayExtras). One block BELOW the widget list on purpose:
    // it appears the moment the first widget is ticked, and anything revealed
    // above the list would shift the just-clicked checkbox out from under the
    // pointer.
    const extras = document.createElement("div");
    extras.appendChild(overlaySubhead(t("export.overlays.style")));
    extras.appendChild(renderStyleSegment());
    extras.appendChild(overlaySubhead(t("export.overlays.accent")));
    extras.appendChild(renderAccentRow());
    extras.appendChild(
        renderCheckbox("export-panel-ov-scrim", t("export.overlays.scrim"), exportPanelState.overlayScrim, (v) => {
            exportPanelState.overlayScrim = v;
            notifyExportStateChanged();
        }),
    );
    extras.hidden = true;
    wrap.appendChild(extras);

    overlayExtrasEl = extras;
    syncOverlayExtras();
    refreshOverlayInspector();
    return wrap;
}

// Appearance block (style + accent + scrim), toggled by syncOverlayExtras.
let overlayExtrasEl: HTMLElement | null = null;
let overlayResetButtonEl: HTMLButtonElement | null = null;

function syncOverlayReset(): void {
    if (overlayResetButtonEl) overlayResetButtonEl.hidden = !hasCustomOverlayPreferences();
}

/**
 * Shows the overlay style / accent / scrim block only when it configures
 * something: at least one widget enabled AND the trip has GPS (without GPS the
 * widget checkboxes render cleared+disabled - see syncGpsOptionsAvailability -
 * so appearance controls for overlays that will not render would contradict
 * that). Display-only, mirrors that same rule: exportPanelState is never
 * touched, so the picked style/accent survive a hop through a no-GPS trip.
 */
function syncOverlayExtras(): void {
    const show = activeTripHasGps() && OVERLAY_WIDGET_DEFS.some((d) => d.state().enabled);
    if (overlayExtrasEl) overlayExtrasEl.hidden = !show;
}

/** A small section sub-heading inside the overlays group. */
function overlaySubhead(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "export-panel__ov-subhead";
    el.textContent = text;
    return el;
}

interface OverlaySegmentOptions<Value extends string | number> {
    label: string;
    dataKey: string;
    choices: ReadonlyArray<readonly [Value, string]>;
    current: Value;
    onChange: (value: Value) => void;
}

function renderOverlaySegment<Value extends string | number>(options: OverlaySegmentOptions<Value>): HTMLElement {
    const seg = document.createElement("div");
    seg.className = "export-panel__segment";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", options.label);
    const buttons: HTMLButtonElement[] = [];
    for (const [value, label] of options.choices) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.dataset[options.dataKey] = String(value);
        setToggleSelected(btn, options.current === value);
        btn.addEventListener("click", () => {
            if (btn.disabled) return;
            options.onChange(value);
            for (const button of buttons) setToggleSelected(button, button === btn);
            notifyExportStateChanged();
        });
        buttons.push(btn);
        seg.appendChild(btn);
    }
    return seg;
}

function renderOverlaySegmentField<Value extends string | number>(options: OverlaySegmentOptions<Value>): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "export-panel__ov-field";
    const label = document.createElement("span");
    label.className = "export-panel__ov-field-label";
    label.textContent = options.label;
    wrap.append(label, renderOverlaySegment(options));
    return wrap;
}

function renderStyleSegment(): HTMLElement {
    return renderOverlaySegment<OverlayStyleId>({
        label: t("export.overlays.style"),
        dataKey: "style",
        choices: [
            ["min", t("export.overlays.style.min")],
            ["card", t("export.overlays.style.card")],
            ["bold", t("export.overlays.style.bold")],
        ],
        current: exportPanelState.overlayStyle,
        onChange: (style) => {
            exportPanelState.overlayStyle = style;
        },
    });
}

/** The widget toggle rows. Each: a checkbox (enable) + a name button that
 *  expands the widget's settings inline, right under the row (accordion - click
 *  the name again to collapse). The map row is wrapped in the container
 *  syncMapOverlayAvailability() hides when there is no WebGL. The single inline
 *  inspector element is parked at the end of the list and relocated under the
 *  expanded row by refreshOverlayInspector. */
function renderWidgetList(): HTMLElement {
    const list = document.createElement("div");
    list.className = "export-panel__ov-widgets";
    overlayRowAnchors.clear();
    for (const def of OVERLAY_WIDGET_DEFS) {
        const row = document.createElement("div");
        row.className = "export-panel__ov-row";
        row.dataset.widget = def.id;

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.id = overlayCbId(def.id);
        cb.setAttribute("aria-label", t(def.labelKey));
        cb.checked = def.state().enabled;
        cb.addEventListener("change", () => {
            def.state().enabled = cb.checked;
            // Enabling expands the settings under the row; disabling collapses
            // them if this was the open one.
            if (cb.checked) {
                selectOverlay(def.id);
            } else if (selectedOverlayKey === def.id) {
                selectedOverlayKey = null;
                refreshOverlayInspector();
            }
            notifyExportStateChanged();
        });

        const name = document.createElement("button");
        name.type = "button";
        name.className = "export-panel__ov-name";
        name.textContent = t(def.labelKey);
        name.setAttribute("aria-expanded", "false");
        name.setAttribute("aria-controls", "export-panel-overlay-inspector");
        name.addEventListener("click", () => {
            // Accordion toggle: clicking the open widget collapses its settings
            // (the widget stays enabled - the checkbox owns on/off).
            if (selectedOverlayKey === def.id) {
                selectedOverlayKey = null;
                refreshOverlayInspector();
                return;
            }
            // Expanding a disabled widget enables it - settings are only
            // meaningful for a widget that will actually render.
            if (!def.state().enabled) {
                def.state().enabled = true;
                cb.checked = true;
                notifyExportStateChanged();
            }
            selectOverlay(def.id);
        });

        row.appendChild(cb);
        row.appendChild(name);

        if (def.isMap) {
            const mapWrap = document.createElement("div");
            mapWrap.id = "export-panel-map-overlay-row";
            mapWrap.appendChild(row);
            list.appendChild(mapWrap);
            overlayRowAnchors.set(def.id, mapWrap);
        } else {
            list.appendChild(row);
            overlayRowAnchors.set(def.id, row);
        }
    }

    // Single inline inspector, parked at the end; refreshOverlayInspector docks
    // it right after the expanded row.
    const inspector = document.createElement("div");
    inspector.id = "export-panel-overlay-inspector";
    inspector.className = "export-panel__ov-inspector";
    inspector.hidden = true;
    overlayInspectorEl = inspector;
    list.appendChild(inspector);

    return list;
}

function selectOverlay(id: OverlayWidgetId): void {
    selectedOverlayKey = id;
    refreshOverlayInspector();
}

/** Accent swatches. */
function renderAccentRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "export-panel__ov-accents";
    for (const color of OVERLAY_ACCENT_SWATCHES) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "export-panel__ov-swatch";
        btn.style.setProperty("--swatch", color);
        btn.dataset.color = color;
        btn.setAttribute("aria-label", color);
        setToggleSelected(btn, exportPanelState.overlayAccent.toLowerCase() === color.toLowerCase());
        btn.addEventListener("click", () => {
            exportPanelState.overlayAccent = color;
            for (const b of Array.from(row.children)) {
                setToggleSelected(b, (b as HTMLElement).dataset.color === color);
            }
            notifyExportStateChanged();
        });
        row.appendChild(btn);
    }
    return row;
}

/** Docks the inline inspector under the expanded widget's row and fills it with
 *  that widget's settings (size, plus map shape/theme/scale). Positioning is by
 *  dragging on the preview frame - hence only a hint here, no X/Y or align grid.
 *  Hidden when nothing is expanded. */
function refreshOverlayInspector(): void {
    const root = overlayInspectorEl;
    if (!root) return;
    // Reflect the current selection on the widget rows.
    for (const r of Array.from(document.querySelectorAll<HTMLElement>(".export-panel__ov-row"))) {
        const expanded = r.dataset.widget === selectedOverlayKey && activeTripHasGps();
        r.classList.toggle("is-selected", expanded);
        r.querySelector("button")?.setAttribute("aria-expanded", String(expanded));
    }
    root.innerHTML = "";
    const id = selectedOverlayKey;
    const def = id ? overlayDefFor(id) : undefined;
    if (!def?.state().enabled) {
        root.hidden = true;
        return;
    }
    // Dock right under the expanded row (accordion).
    const anchor = id ? overlayRowAnchors.get(id) : undefined;
    if (anchor) anchor.after(root);
    root.hidden = false;

    const st = def.state();
    root.appendChild(
        renderOverlaySlider(
            t("export.overlays.size"),
            50,
            200,
            st.scalePct,
            (v) => `${v}%`,
            (v) => {
                st.scalePct = v;
                notifyExportStateChanged();
            },
        ),
    );

    if (def.isMap) {
        root.appendChild(renderMapProviderField());
        root.appendChild(renderMapMarkerField());
        root.appendChild(renderMapShapeSegment());
        root.appendChild(renderMapThemeSegment());
        root.appendChild(renderMapLabelSizeSegment());
        root.appendChild(renderMapStreetNamesSegment());
        root.appendChild(
            renderOverlaySlider(
                t("export.overlays.mapScale"),
                0.1, // 100 m floor
                10, // 10 km ceiling
                exportPanelState.overlayMap.zoomKm,
                (v) => {
                    const d = formatDistanceFromKm(v);
                    const rounded = d.value >= 10 ? Math.round(d.value) : Math.round(d.value * 10) / 10;
                    return `${rounded} ${t(d.unitKey)}`;
                },
                (v) => {
                    exportPanelState.overlayMap.zoomKm = v;
                    notifyExportStateChanged();
                },
                0.1, // step 100 m
            ),
        );
        root.appendChild(renderMapModeControls());
        const appearanceHint = document.createElement("p");
        appearanceHint.id = "export-map-appearance-unavailable";
        appearanceHint.className = "export-panel__note";
        appearanceHint.textContent = t("settings.map.styleUnavailable");
        root.appendChild(appearanceHint);
        syncExportMapControls();
    }

    // Positioning is drag-on-the-frame; the X/Y sliders + align grid are gone.
    const hint = document.createElement("div");
    hint.className = "export-panel__note export-panel__ov-hint";
    hint.textContent = t("export.overlays.dragHint");
    root.appendChild(hint);
}

function renderMapProviderField(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "export-panel__ov-field";
    const label = document.createElement("label");
    label.className = "export-panel__ov-field-label";
    label.textContent = t("export.overlays.mapProvider");
    const select = createMapProviderSelect({
        id: "export-map-provider-select",
        value: exportPanelState.overlayMap.provider,
        isYandexDisabled: true,
        onChange: (provider) => {
            if (provider === "yandex" || exportPanelState.configurationLocked) return;
            exportPanelState.overlayMap.provider = provider;
            notifyExportStateChanged();
        },
    });
    label.htmlFor = select.id;
    select.className = "export-panel__output-select";
    const note = document.createElement("p");
    note.id = "export-map-provider-description";
    note.className = "export-panel__note";
    note.textContent = t("export.overlays.mapProvider.yandexUnavailable");
    wrap.append(label, select);
    if (!__PORTABLE__) {
        select.setAttribute("aria-describedby", note.id);
        wrap.append(note);
    }
    return wrap;
}

function renderMapMarkerField(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "export-panel__ov-field";
    const label = document.createElement("span");
    label.className = "export-panel__ov-field-label";
    label.textContent = t("export.overlays.mapMarker");
    const host = document.createElement("div");
    host.id = "export-map-marker-control";
    renderMapMarkerControl(host, {
        appearance: exportPanelState.overlayMap.marker,
        onChange: (appearance) => {
            exportPanelState.overlayMap.marker = appearance;
            notifyExportStateChanged();
        },
        idPrefix: "export",
    });
    const note = document.createElement("p");
    note.className = "export-panel__note";
    note.textContent = t("export.overlays.mapMarker.description");
    wrap.append(label, host, note);
    return wrap;
}

function renderMapShapeSegment(): HTMLElement {
    return renderOverlaySegmentField<MapShape>({
        label: t("export.overlays.shape"),
        dataKey: "shape",
        choices: [
            ["rect", t("export.overlays.shape.rect")],
            ["circle", t("export.overlays.shape.circle")],
        ],
        current: exportPanelState.overlayMap.shape,
        onChange: (shape) => {
            exportPanelState.overlayMap.shape = shape;
        },
    });
}

/** The export map's appearance stays independent of the viewer's preferences. */
function renderMapThemeSegment(): HTMLElement {
    return renderOverlaySegmentField<MapStyleId>({
        label: t("export.overlays.mapTheme"),
        dataKey: "maptheme",
        choices: [
            ["light", t("export.overlays.mapTheme.light")],
            ["dark", t("export.overlays.mapTheme.dark")],
            ["neon", t("export.overlays.mapTheme.neon")],
        ],
        current: exportPanelState.overlayMap.theme,
        onChange: (theme) => {
            exportPanelState.overlayMap.theme = theme;
        },
    });
}

function renderMapLabelSizeSegment(): HTMLElement {
    return renderOverlaySegmentField({
        label: t("export.overlays.mapLabelSize"),
        dataKey: "maplabelsize",
        choices: MAP_LABEL_SIZE_PCT_VALUES.map((pct) => [pct, `${pct}%`]),
        current: exportPanelState.overlayMap.labelScalePct,
        onChange: (pct) => {
            exportPanelState.overlayMap.labelScalePct = pct;
        },
    });
}

function renderMapStreetNamesSegment(): HTMLElement {
    return renderOverlaySegmentField({
        label: t("export.overlays.mapStreetNames"),
        dataKey: "mapstreetnames",
        choices: STREET_LABEL_DENSITY_VALUES.map((density) => [density, t(STREET_LABEL_DENSITY_LABEL_KEYS[density])]),
        current: exportPanelState.overlayMap.labelDensity,
        onChange: (density) => {
            exportPanelState.overlayMap.labelDensity = density;
        },
    });
}

/** Map view-mode controls (inspector, map only): a north-up vs chase segment,
 *  plus - when chase is selected - a tilt slider and a speed-adaptive-zoom
 *  toggle. The chase extras are shown/hidden inline (no full inspector rebuild).
 *  None of these cross into the worker: the snapshotter reads them on the main
 *  thread (like the base-layer theme). */
function renderMapModeControls(): HTMLElement {
    const wrap = document.createElement("div");
    const om = exportPanelState.overlayMap;

    const extras = document.createElement("div");
    extras.id = "export-map-chase-controls";
    extras.hidden = om.mode !== "chase";
    wrap.appendChild(
        renderOverlaySegmentField<MapViewMode>({
            label: t("export.overlays.mapMode"),
            dataKey: "mapmode",
            choices: [
                ["north", t("export.overlays.mapMode.north")],
                ["chase", t("export.overlays.mapMode.chase")],
            ],
            current: om.mode,
            onChange: (mode) => {
                om.mode = mode;
                extras.hidden = mode !== "chase";
            },
        }),
    );

    // Tilt slider (degrees).
    extras.appendChild(
        renderOverlaySlider(
            t("export.overlays.mapTilt"),
            0,
            MAX_MAP_PITCH_DEG,
            om.pitchDeg,
            (v) => `${v}°`,
            (v) => {
                om.pitchDeg = v;
                notifyExportStateChanged();
            },
        ),
    );
    // Speed-adaptive-zoom toggle.
    extras.appendChild(
        renderCheckbox("export-panel-ov-adaptive", t("export.overlays.mapAdaptive"), om.adaptiveZoom, (v) => {
            om.adaptiveZoom = v;
            notifyExportStateChanged();
        }),
    );
    wrap.appendChild(extras);
    return wrap;
}

function syncExportMapControls(): void {
    if (selectedOverlayKey !== "map" || !overlayInspectorEl) return;
    const { camera, supportsAppearanceSettings } = MAP_PROVIDER_REGISTRY[getExportMapPreviewProvider()];
    const mode = camera.supportsHeadingUp ? exportPanelState.overlayMap.mode : "north";
    for (const button of overlayInspectorEl.querySelectorAll<HTMLButtonElement>("button[data-mapmode]")) {
        button.disabled = button.dataset.mapmode === "chase" && !camera.supportsHeadingUp;
        setToggleSelected(button, button.dataset.mapmode === mode);
    }
    const extras = overlayInspectorEl.querySelector<HTMLElement>("#export-map-chase-controls");
    if (extras) extras.hidden = mode !== "chase";
    const hint = overlayInspectorEl.querySelector<HTMLElement>("#export-map-appearance-unavailable");
    if (hint) hint.hidden = supportsAppearanceSettings;
    for (const button of overlayInspectorEl.querySelectorAll<HTMLButtonElement>(
        "button[data-maptheme], button[data-maplabelsize], button[data-mapstreetnames]",
    )) {
        button.disabled = !supportsAppearanceSettings;
        if (button.disabled) button.setAttribute("aria-describedby", "export-map-appearance-unavailable");
        else button.removeAttribute("aria-describedby");
    }
}

/** A labelled range slider with a live value readout. Values snap to the step
 *  grid (step defaults to 1, i.e. integer; the map-scale slider passes 0.1 km so
 *  it can reach the 100 m floor). */
function renderOverlaySlider(
    labelText: string,
    min: number,
    max: number,
    value: number,
    fmt: (v: number) => string,
    onInput: (v: number) => void,
    step = 1,
): HTMLElement {
    const row = document.createElement("label");
    row.className = "export-panel__slider";
    const head = document.createElement("span");
    head.className = "export-panel__slider-label";
    const title = document.createElement("span");
    title.textContent = labelText;
    const val = document.createElement("span");
    val.className = "export-panel__slider-val";
    val.textContent = fmt(value);
    head.appendChild(title);
    head.appendChild(val);
    row.appendChild(head);

    const input = document.createElement("input");
    input.type = "range";
    input.setAttribute("aria-label", labelText);
    input.setAttribute("aria-valuetext", fmt(value));
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener("input", () => {
        const raw = Number(input.value);
        if (!Number.isFinite(raw)) return;
        // Snap to the step grid, then strip binary-fp dust (0.30000000000000004
        // -> 0.3) so stored values stay tidy. step=1 collapses to Math.round.
        const snapped = Math.round(Math.round(raw / step) * step * 1000) / 1000;
        const clamped = Math.max(min, Math.min(max, snapped));
        val.textContent = fmt(clamped);
        input.setAttribute("aria-valuetext", fmt(clamped));
        onInput(clamped);
    });
    row.appendChild(input);
    return row;
}

function renderCheckbox(id: string, label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "export-panel__checkbox";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = id;
    cb.checked = checked;
    cb.addEventListener("change", () => onChange(cb.checked));
    wrap.appendChild(cb);
    const span = document.createElement("span");
    span.textContent = label;
    wrap.appendChild(span);
    return wrap;
}

/* --------------------------- fallback warning --------------------------- */

let fallbackWarnEl: HTMLDivElement | null = null;

/**
 * True iff a save will build the whole MP4 in an in-memory buffer rather than
 * stream to disk: no native showSaveFilePicker (Firefox, Safari, mobile). That
 * path is RAM-bounded, so the panel shows the "builds in memory, desktop Chrome
 * is most reliable" hint before Save. The native path streams to disk at any
 * size and never warns.
 */
function isExportFallbackBlob(): boolean {
    return !nativeFsaAvailable();
}

/** Updates the in-memory-build warning visibility. */
function updateFallbackWarn(): void {
    if (!fallbackWarnEl) return;
    fallbackWarnEl.hidden = !isExportFallbackBlob();
}

/* --------------------- non-Chromium recommendation --------------------- */

/** Top-of-panel banner (non-Chromium engines only). Opens the "open in a
 *  Chromium browser" modal. Built per render; cheap. */
function renderChromiumBanner(): HTMLElement {
    const banner = document.createElement("button");
    banner.type = "button";
    banner.id = "export-panel-chromium-banner";
    banner.className = "export-panel__chromium-banner";
    // Chrome glyph (signals "Chromium") + label + chevron. Icons are static,
    // trusted markup (innerHTML); the translated label goes via textContent.
    banner.innerHTML =
        '<svg class="export-panel__chromium-banner-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728Z"/></svg>' +
        '<span class="export-panel__chromium-banner-text"></span>' +
        '<svg class="export-panel__chromium-banner-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
    const textEl = banner.querySelector<HTMLSpanElement>(".export-panel__chromium-banner-text");
    if (textEl) textEl.textContent = t("export.chromiumBanner");
    banner.addEventListener("click", openChromiumModal);
    return banner;
}

function openChromiumModal(): void {
    const modal = dom.chromiumBrowsersModal;
    if (!modal) return;
    modal.hidden = false;
    activateModal(modal, { onClose: closeChromiumModal, initialFocus: dom.chromiumBrowsersModalClose });
}

function closeChromiumModal(): void {
    const modal = dom.chromiumBrowsersModal;
    if (!modal) return;
    modal.hidden = true;
    deactivateModal(modal);
}

/* ----------------------------- save flow ------------------------------- */

/**
 * GPS-track-only export: builds a .gpx for the selected range straight from
 * trip.records and downloads it. No save picker, no transcode, no phase change -
 * it is a single small file, so it lands like any other browser download and the
 * panel stays open for another export. A range with no GPS points is reported as
 * a warning rather than saving an empty track.
 */
function runGpxOnlyDownload(): void {
    const trip = activeTrip();
    const range = exportPanelState.range;
    if (!trip || !range) {
        notify({ severity: "error", messageKey: "export.error.generic" });
        return;
    }
    let gpxText: string;
    try {
        gpxText = buildClipGpx(trip, range.startTripSec, range.endTripSec);
    } catch (err) {
        log.error("gpx-only export failed", err);
        notify({ severity: "error", messageKey: "export.error.generic" });
        return;
    }
    // serializeGpx always emits the document scaffold; an empty <trkseg> means no
    // points fell in the range. Saving that helps nobody - tell the user instead.
    if (!/<trkpt/.test(gpxText)) {
        notify({ severity: "warn", messageKey: "export.gpx.empty" });
        return;
    }
    const base = `${clipBasename(trip, range.startTripSec, range.endTripSec)}_${randomFilenameSuffix()}`;
    const name = `${base}.gpx`;
    downloadBlob(new Blob([gpxText], { type: "application/gpx+xml" }), name);
    notify({ severity: "info", messageKey: "export.gpx.done" });
}

async function onSaveClick(): Promise<void> {
    if (exportPanelState.configurationLocked) return;
    if (exportPanelState.outputKind === "gpx") {
        runGpxOnlyDownload();
        return;
    }
    if (followWorkPending()) {
        syncSaveAvailability();
        return;
    }
    exportPanelState.configurationLocked = true;
    notifyExportStateChanged();
    try {
        await runExportFlow({
            onStatus: (s) => setProgressStatus(s),
            onProgress: (p) => onTranscodeProgress(p),
            onProgressFill: (fraction) => setProgressFill(fraction * 100),
            onProgressIndeterminate: (on) => setProgressIndeterminate(on),
            // Switch to the progress view only after the save picker resolves.
            // Cancelling the picker never fires this, so the options form stays put;
            // the outer finally block unlocks it when the flow settles.
            onExportStart: () => {
                exportPanelState.phase = "progress";
                setProgressStatus(t("export.status.preparing"));
                // A previous run can end with the indeterminate sweep still on (the
                // disk-commit tick is the last progress event) - reset it here or it
                // leaks into this run's determinate bar.
                setProgressIndeterminate(false);
                setProgressFill(0);
                setProgressMeta("");
                notifyExportStateChanged();
            },
            onDone: (s) => {
                hasSavedClip = true;
                renderDoneSummary(s);
                exportPanelState.phase = "done";
                notifyExportStateChanged();
            },
            onError: (messageKey, params) => {
                // Keep a way back to configuration after a failure. The message
                // is already localized; show it directly, no "Error:" wrap.
                setErrorStatus(t(messageKey, params));
                exportPanelState.phase = "error";
                notifyExportStateChanged();
            },
            onCancel: () => {
                exportPanelState.phase = "options";
                notifyExportStateChanged();
            },
            downloadBlob,
            onInProgress: setExportInProgress,
        });
    } finally {
        exportPanelState.configurationLocked = false;
        notifyExportStateChanged();
    }
}

const TRANSCODE_STAGE_KEY = {
    preparing: "export.status.preparing",
    transcoding: "export.status.transcoding",
    finalizing: "export.status.finalizing",
} as const;

function onTranscodeProgress(p: TranscodeProgress): void {
    setProgressStatus(t(TRANSCODE_STAGE_KEY[p.stage]));
    if (Number.isFinite(p.totalProgress)) {
        setProgressFill(p.totalProgress * 100);
    }
    // Rich readout during the encode: frames · ETA · bytes. Only the transcoding
    // stage moves the frame/byte counters; blank it in preparing/finalizing.
    if (p.stage === "transcoding") {
        const eta =
            p.etaSec >= 0 ? t("export.progress.eta", { sec: formatTime(p.etaSec) }) : t("export.progress.etaUnknown");
        const frames = t("export.progress.frames", { done: p.framesDone, total: p.framesTotal });
        const bytes = t("export.progress.bytes", { bytes: formatBytes(p.bytesWritten) });
        setProgressMeta(`${frames}  ·  ${eta}  ·  ${bytes}`);
    } else {
        setProgressMeta("");
    }
}

/* ---------------------------- progress section --------------------------- */

let progressBarEl: HTMLDivElement | null = null;
let progressFillEl: HTMLDivElement | null = null;
let progressStatusEl: HTMLDivElement | null = null;
let progressMetaEl: HTMLDivElement | null = null;

function renderProgressSection(): void {
    const root = dom.exportPanelProgress;
    if (!root) return;
    root.innerHTML = "";

    const status = document.createElement("div");
    status.className = "export-panel__progress-status";
    status.id = "export-panel-progress-status";
    status.tabIndex = -1;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    progressStatusEl = status;
    root.appendChild(status);

    const bar = document.createElement("div");
    bar.className = "export-panel__progress-bar";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-labelledby", status.id);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", "0");
    progressBarEl = bar;
    const fill = document.createElement("div");
    fill.className = "export-panel__progress-fill";
    progressFillEl = fill;
    bar.appendChild(fill);
    root.appendChild(bar);

    // Live readout (frames · ETA · bytes) under the bar. Populated only while
    // transcoding; stays empty for the fast stream-copy path.
    const meta = document.createElement("div");
    meta.className = "export-panel__progress-meta";
    progressMetaEl = meta;
    root.appendChild(meta);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "export-panel__secondary-btn";
    cancelBtn.textContent = t("export.cancel");
    cancelBtn.addEventListener("click", () => {
        cancelActiveExport();
    });
    root.appendChild(cancelBtn);
}

function setProgressStatus(text: string): void {
    if (progressStatusEl) progressStatusEl.textContent = text;
}

function setProgressFill(pct: number): void {
    const value = Math.max(0, Math.min(100, pct));
    if (progressFillEl) progressFillEl.style.width = `${value}%`;
    progressBarEl?.setAttribute("aria-valuenow", String(Math.round(value)));
}

// Toggles the indeterminate (animated) bar for phases with no measurable
// progress - the final disk-commit flush, whose native close() is opaque.
function setProgressIndeterminate(on: boolean): void {
    progressBarEl?.classList.toggle("export-panel__progress-bar--indeterminate", on);
    // setProgressFill leaves an inline width that beats the stylesheet's
    // indeterminate width (35% sweep / reduced-motion 100%) - drop it while
    // the sweep runs; the next determinate tick re-establishes it.
    if (on && progressFillEl) progressFillEl.style.width = "";
    if (on) progressBarEl?.removeAttribute("aria-valuenow");
}

function setProgressMeta(text: string): void {
    if (progressMetaEl) progressMetaEl.textContent = text;
}

/* ------------------------------ done section ----------------------------- */

function renderDoneSection(): void {
    const root = dom.exportPanelDone;
    if (!root) return;
    root.innerHTML = "";

    const summary = document.createElement("div");
    summary.id = "export-panel-done-summary";
    summary.className = "export-panel__done-summary";
    summary.tabIndex = -1;
    root.appendChild(summary);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "export-panel__primary-btn";
    closeBtn.textContent = t("export.close");
    closeBtn.addEventListener("click", () => {
        exportPanelState.phase = "options";
        notifyExportStateChanged();
        closeExportMode();
    });
    root.appendChild(closeBtn);
}

/* ------------------------------ error section ---------------------------- */

let errorStatusEl: HTMLDivElement | null = null;

function renderErrorSection(): void {
    const root = dom.exportPanelError;
    if (!root) return;
    root.innerHTML = "";

    const status = document.createElement("div");
    status.className = "export-panel__error-status";
    status.tabIndex = -1;
    errorStatusEl = status;
    root.appendChild(status);

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "export-panel__primary-btn";
    backBtn.textContent = t("export.backToOptions");
    backBtn.addEventListener("click", () => {
        // Back to configure - the range and all options are preserved, so the
        // user can adjust (e.g. shorten the clip, free disk space) and retry.
        exportPanelState.phase = "options";
        notifyExportStateChanged();
    });
    root.appendChild(backBtn);

    // A failed export is where a report is worth most - the ring buffer still
    // holds the run that just died, and the user is right there. .feedback-link
    // is picked up by the delegated handler in feedback.ts, which opens the
    // report wizard with the topic pre-tagged; the panel is a drawer (not a
    // dialog), so it stays behind the wizard and keeps its error state.
    const reportBtn = document.createElement("button");
    reportBtn.type = "button";
    reportBtn.className = "export-panel__secondary-btn feedback-link";
    reportBtn.dataset.feedbackPreset = "export";
    reportBtn.textContent = t("feedback.entry.title");
    root.appendChild(reportBtn);
}

function setErrorStatus(text: string): void {
    if (errorStatusEl) errorStatusEl.textContent = text;
}

function renderDoneSummary(s: ExportDoneSummary): void {
    const root = dom.exportPanelDone;
    if (!root) return;
    const summary = root.querySelector<HTMLDivElement>("#export-panel-done-summary");
    if (!summary) return;
    // sizeBytes is 0 when mp4Handle.getFile() is unavailable on some FSA
    // ponyfill paths - omit the size rather than print a misleading "0 B".
    const meta =
        s.sizeBytes > 0 ? `${formatTime(s.durationSec)} · ${formatBytes(s.sizeBytes)}` : formatTime(s.durationSec);
    const lines = [s.fileName, meta];
    if (s.hasGpx && s.gpxName) lines.push(`+ ${s.gpxName}`);
    summary.innerHTML = "";
    for (const line of lines) {
        const p = document.createElement("p");
        p.textContent = line;
        summary.appendChild(p);
    }

    // RAM path: the finished MP4 is an in-memory blob, not in Downloads yet (a
    // programmatic download right after the long export is blocked by the
    // recent-activation guard), so we hand the user an explicit button - clicking
    // it is a fresh user gesture that anchor-downloads the blob. Re-clickable: a
    // blob download is idempotent and cheap. Absent on the native path (the
    // picker already saved the file to disk).
    const pending = s.pendingDownload;
    if (pending) {
        const dlBtn = document.createElement("button");
        dlBtn.type = "button";
        dlBtn.className = "export-panel__primary-btn";
        dlBtn.textContent = t("export.download");
        dlBtn.addEventListener("click", () => {
            downloadBlob(pending.blob, pending.name);
        });
        summary.appendChild(dlBtn);
    }
}

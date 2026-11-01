// Chart.js progress strip below the video: speed + |G|, X axis = relSec
// from trip start. cursorPlugin draws on top (file boundaries, hover,
// current player position, event markers). Drag-zoom selects an export range -
// flags in state.chartZoomed; the export modal sits on top.
//
// Reverse deps on player (getTripCurrentTime, seekTripTime, pause) go through
// initChart callbacks to keep the dependency graph tree-shaped.

// Type-only: the Chart constructor is loaded lazily via loadChart() (see the
// holder below). All `Chart` references in this file are type positions
// (state.chart, callback params) and are erased at build.
import { hasSpeed, isSameTrackSegment } from "../gps-telemetry.js";
import type { Chart, ChartDataset } from "chart.js";

// Keep Chart.js behind the viewer's lazy boundary.
// chart-library registers only the components used by the timeline through
// static named imports, so the bundler can remove the other chart types.
// runTripUiInit awaits loadChart before initChart creates an instance.
type ChartCtor = typeof import("chart.js")["Chart"];
let ChartClass: ChartCtor | null = null;

// The dynamic import keeps the chart runtime out of the eager graph.
export async function loadChart(): Promise<void> {
    if (ChartClass) return;
    ChartClass = (await import("./chart-library.js")).Chart;
}

import { gMagnitude, hasAccelData } from "../events.js";
import type { TripEvent } from "../events.js";
import {
    inferredSegmentsAtRelSec,
    initInferredStrip,
    renderInferredEventChipsHtml,
    type InferredStripHandle,
} from "./inferred-strip-canvas.js";
import { escapeHtml } from "../escape.js";
import { getDateLocale, t } from "../i18n/index.js";
import { emitLifecycle } from "../perf.js";
import { findNearestIndex, isValidGpsFix } from "../parser.js";
import {
    pickFrameChannel,
    wallToContentSec,
    contentToWallUtc,
    contentToFrame,
    displayClockDate,
    frameRecordingMode,
    frameMediaOffset,
} from "../trips.js";
import type { Trip, TripGap, VideoCandidate } from "../trips.js";
import type { RecordingMode } from "../parsers/types.js";
import { formatSpeedFromMs, subscribeUnitsChange } from "../units-pref.js";

import { gapAwareDecimationPlugin } from "./chart-decimation.js";
import { dom } from "./dom.js";
import { openExportMode, setRange } from "./export-state.js";
import { formatClock, formatDateTime } from "./date-format.js";
import { eventLabel, formatDuration, formatEventSeverity, formatNumber, formatTime } from "./format.js";
import { extractFrameAt } from "./frame-extract.js";
import { buildRecordPopupHtml } from "./map.js";
import { isCoarsePointer } from "./media-queries.js";
import { attachPointerDrag, capturePointer, suppressEdgeSwipeNav } from "./pointer-drag.js";
import { attachPinchGesture } from "./pinch-gesture.js";
import { renderRangeRuler } from "./range-ruler.js";
import { activeTrip, mainChannel, state } from "./state.js";
import {
    applyPinchZoom,
    applyWheelPan,
    applyWheelZoom,
    computeEffectiveMinViewSpan,
    computeFollowPan,
    computeMinViewSpan,
    normalizeWheelDelta,
    resizeZoomViewEdge,
    type ZoomViewState,
} from "./strip-zoom.js";
import { eventColors, subscribeThemeChange, themeColors } from "./theme.js";
import { subscribeViewPanels } from "./view-menu.js";

interface ChartCallbacks {
    /** Current player position in seconds from trip start. Needed by cursorPlugin. */
    getTripCurrentTime: () => number;
    /** Seek: triggered by a click on the chart or on drag-zoom complete. */
    onSeekTripTime: (sec: number) => void;
    /** Pause the player on zoom-complete so the user immediately hears/sees the selection start. */
    onPause: () => void;
    /**
     * Called when the chart-zoom selection state changes (created or cleared).
     * Used by the Export button in the player bar to update its tooltip with
     * the current selection range.
     */
    onSelectionChange?: () => void;
    /**
     * Called on EVERY visible-window change (each wheel-zoom/pan step, reset,
     * programmatic zoom) - not just the zoomed<->unzoomed toggle. Window-anchored
     * DOM overlays (playhead, progress thumb, range pull-tabs) map trip-seconds
     * to x through the current window, so they go stale on zoom unless re-synced
     * here. Distinct from onSelectionChange, which fires only on the toggle.
     */
    onViewChanged?: () => void;
}

let callbacks: ChartCallbacks = {
    getTripCurrentTime: () => 0,
    onSeekTripTime: () => {},
    onPause: () => {},
};

/**
 * Event marker dot radius in pixels. Small enough not to obscure chart data,
 * but clearly visible. Tooltip hit radius is larger (see EVENT_HIT_PX).
 */
const EVENT_MARKER_RADIUS_PX = 5;
/**
 * Hit radius for "is the cursor over an event" in pixels. Larger than the visual
 * radius so the user does not need to aim precisely.
 */
const EVENT_HIT_PX = 8;

// --- chart layout ---
//
// The chart is always visible - collapsing it is not allowed because the
// drag-zoom export selection is attached to the chart itself. Without GPS data
// the chart shrinks via .no-gps to a thin timeline strip (cursor + file
// boundaries without speed/G datasets), so it does not waste screen space
// when data is empty but drag-zoom still works.

/**
 * Redraws the time scale (relative top + absolute bottom) for the current
 * xScale.min/max. Called on trip change, zoom (drag/wheel), pan, and resize.
 *
 * Works in no-gps mode too - the time scale only depends on trip.timeline.contentDurationSec
 * and the current chart xScale, no GPS data is needed.
 */
// Extra overlay layer hooked into the ruler re-sync (trip change, zoom, pan,
// resize) - the timeline-marker pins reposition through this. A registered
// callback, not an import: markers import this module for the geometry
// helpers, so the reverse edge would cycle.
let timelineOverlaySync: (() => void) | null = null;

/** Registers the overlay refresh run after every ruler re-sync. */
export function registerTimelineOverlaySync(callback: () => void): void {
    timelineOverlaySync = callback;
}

function syncChartRulers(): void {
    timelineOverlaySync?.();
    if (!state.chart || !state.active) return;
    const trip = state.trips[state.active.trip];
    if (!trip) return;
    const dur = trip.timeline.contentDurationSec;
    if (dur <= 0) return;
    const top = dom.playerChartRulerTop;
    // Gutter + window come from the shared getTimelineView (chartArea-derived
    // when the canvas is visible, synthetic when it is hidden) so ruler ticks
    // stay aligned with the playhead/thumb/range tabs in every mode.
    const view = getTimelineView();
    if (!view) return;
    const viewStartPct = view.startSec / dur;
    const viewEndPct = view.endSec / dur;
    // Expose the gutter to CSS: the mini-progress track (::before) insets
    // itself to the content span so the visible track matches the thumb's
    // actual travel instead of running under the gutters.
    const host = dom.playerChartEl;
    if (host) {
        host.style.setProperty("--timeline-gutter-left", `${(view.leftFrac * 100).toFixed(3)}%`);
        host.style.setProperty("--timeline-gutter-right", `${(view.rightFrac * 100).toFixed(3)}%`);
    }
    if (top) {
        // The gutter goes in as label-percentage math, not host padding: the
        // labels are position:absolute, so padding cannot shift them.
        renderRangeRuler(top, trip, viewStartPct, viewEndPct, view.leftFrac, view.rightFrac);
    }
    // Strip wrap padding makes the (in-flow) strip canvas occupy exactly the
    // chartArea width, so bars line up with chart datasets. Axis labels live
    // inside the canvas edge so they sit in the first visible bar column
    // instead of in the padding gutter.
    const wrap = dom.chartInferredStripWrap;
    if (wrap) {
        wrap.style.paddingLeft = `${(view.leftFrac * 100).toFixed(3)}%`;
        wrap.style.paddingRight = `${(view.rightFrac * 100).toFixed(3)}%`;
    }
}

/**
 * Clears both ruler containers. Called on trip change before the switch so
 * old-trip ticks do not linger on the new trip until it renders.
 */
function clearChartRulers(): void {
    if (dom.playerChartRulerTop) dom.playerChartRulerTop.innerHTML = "";
}

/** Keeps the navigator and its controls inert while there is no active trip. */
function concealChartZoomReset(isConcealed: boolean): void {
    dom.playerChartOverviewReset.classList.toggle("is-concealed", isConcealed);
    dom.playerChartOverviewReset.disabled = isConcealed;
    if (isConcealed) dom.playerChartOverviewReset.setAttribute("aria-hidden", "true");
    else dom.playerChartOverviewReset.removeAttribute("aria-hidden");
}

function hideChartZoomNavigation(): void {
    dom.playerChartZoomRow.hidden = true;
    dom.playerChartOverview.hidden = true;
    dom.playerChartZoomStatus.hidden = true;
    concealChartZoomReset(true);
    dom.playerChartZoomOut.disabled = true;
    dom.playerChartZoomIn.disabled = true;
}

function setOverviewHandleValue(handle: HTMLDivElement, valueSec: number, minSec: number, maxSec: number): void {
    const safeMin = Math.max(0, Math.min(minSec, maxSec));
    const safeMax = Math.max(safeMin, maxSec);
    const safeValue = Math.max(safeMin, Math.min(valueSec, safeMax));
    handle.setAttribute("aria-valuemin", String(safeMin));
    handle.setAttribute("aria-valuemax", String(safeMax));
    handle.setAttribute("aria-valuenow", String(safeValue));
    handle.setAttribute("aria-valuetext", formatTime(safeValue));
}

// Navigator drags sync on every pointer move. Reuse the locale formatters so
// updating the compact status does not compile ICU patterns in that hot path.
const chartZoomFactorFormatters: Array<Intl.NumberFormat | undefined> = [];

function formatChartZoomClock(trip: Trip, contentSec: number): string {
    const unixSec = contentToWallUtc(trip.timeline, contentSec);
    return formatClock(displayClockDate(unixSec, trip.cameraTzSec), { seconds: true });
}

function formatChartZoomFactor(factor: number, isFullView: boolean): string {
    if (isFullView) return "1";
    const precision = factor < 1.1 ? 3 : factor < 2 ? 2 : factor < 10 ? 1 : 0;
    const formatter =
        chartZoomFactorFormatters[precision] ??
        new Intl.NumberFormat(getDateLocale(), {
            minimumFractionDigits: 0,
            maximumFractionDigits: precision,
        });
    chartZoomFactorFormatters[precision] = formatter;
    return formatter.format(factor);
}

function syncChartZoomStatus(trip: Trip, startSec: number, endSec: number, isFullView: boolean): void {
    const visibleSpanSec = Math.max(Number.EPSILON, endSec - startSec);
    const zoom = formatChartZoomFactor(trip.timeline.contentDurationSec / visibleSpanSec, isFullView);
    const start = formatChartZoomClock(trip, startSec);
    const end = formatChartZoomClock(trip, endSec);
    const accessibleText = t("chart.zoomStatus", { zoom, start, end });

    dom.playerChartZoomFactor.textContent = `${zoom}×`;
    dom.playerChartZoomRange.textContent = `${start}–${end}`;
    dom.playerChartZoomStatus.title = accessibleText;
    dom.playerChartZoomStatus.setAttribute("aria-label", accessibleText);
}

// While one edge owns pointer capture, ARIA bounds keep the floor captured at
// pointerdown. A programmatic export preview can be narrower than the normal
// navigation floor, and reversing that same drag must remain possible.
let overviewResizeMinSpanPct: number | null = null;

/**
 * Full-trip navigator for the current visible window. It remains present at
 * full view so its edge handles also provide a visible way to zoom in.
 *
 * Works in no-gps mode too: it only depends on the trip duration and x scale.
 */
function syncChartOverview(): void {
    if (!state.chart || !state.active) {
        hideChartZoomNavigation();
        return;
    }
    const trip = state.trips[state.active.trip];
    if (!trip) {
        hideChartZoomNavigation();
        return;
    }
    const xScale = state.chart.scales.x;
    if (!xScale) {
        hideChartZoomNavigation();
        return;
    }
    const dur = trip.timeline.contentDurationSec;
    if (dur <= 0) {
        hideChartZoomNavigation();
        return;
    }
    const viewStartPct = Math.max(0, Math.min(1, xScale.min / dur));
    const viewEndPct = Math.max(viewStartPct, Math.min(1, xScale.max / dur));
    const span = viewEndPct - viewStartPct;
    const normalMinSpan = computeMinViewSpan(dur);
    const edgeMinSpan = overviewResizeMinSpanPct ?? computeEffectiveMinViewSpan(dur, span);
    const isFullView = span >= 1 - 1e-6;

    dom.playerChartZoomRow.hidden = false;
    dom.playerChartOverview.hidden = false;
    dom.playerChartZoomStatus.hidden = isFullView;
    concealChartZoomReset(isFullView);
    dom.playerChartZoomOut.disabled = isFullView;
    dom.playerChartZoomIn.disabled = span <= normalMinSpan * (1 + 1e-3);
    dom.playerChartOverviewViewport.style.left = `${viewStartPct * 100}%`;
    dom.playerChartOverviewViewport.style.width = `${span * 100}%`;

    // A long trip can make the visual viewport narrower than a pixel. Do not
    // shrink its two edge controls with it: below two target widths they become
    // adjacent clipped halves of one stable hit region. Clamp that region into
    // the overview so both halves remain reachable at the trip edges too.
    const overviewWidthPx = dom.playerChartOverview.clientWidth;
    const targetSizePx = isCoarsePointer() ? 36 : 24;
    const viewportWidthPx = span * overviewWidthPx;
    const usesCompactHandles = overviewWidthPx >= targetSizePx * 2 && viewportWidthPx < targetSizePx * 2;
    dom.playerChartOverviewViewport.classList.toggle("is-compact", usesCompactHandles);
    if (usesCompactHandles) {
        const viewportStartPx = viewStartPct * overviewWidthPx;
        const viewportCenterPx = ((viewStartPct + viewEndPct) / 2) * overviewWidthPx;
        const hitRegionCenterPx = Math.max(targetSizePx, Math.min(viewportCenterPx, overviewWidthPx - targetSizePx));
        dom.playerChartOverviewViewport.style.setProperty(
            "--compact-handle-center-x",
            `${hitRegionCenterPx - viewportStartPx}px`,
        );
    } else {
        dom.playerChartOverviewViewport.style.removeProperty("--compact-handle-center-x");
    }

    const minSpanSec = edgeMinSpan * dur;
    const startSec = viewStartPct * dur;
    const endSec = viewEndPct * dur;
    syncChartZoomStatus(trip, startSec, endSec, isFullView);
    setOverviewHandleValue(dom.playerChartOverviewStart, startSec, 0, endSec - minSpanSec);
    setOverviewHandleValue(dom.playerChartOverviewEnd, endSec, startSec + minSpanSec, dur);
}

/**
 * Applies a navigator gesture as inspection zoom. This deliberately breaks an
 * export preview's playback clamp and pauses auto-follow, matching wheel, pinch,
 * and drag-select gestures.
 */
function applyNavigatorView(next: ZoomViewState, durationSec: number): void {
    const fullView = next.viewStartPct <= 1e-6 && next.viewEndPct >= 1 - 1e-6;
    state.isPreviewZoom = false;
    noteUserTimelineInteraction();
    applyChartXRange(next.viewStartPct * durationSec, next.viewEndPct * durationSec, fullView);
}

function overviewRatioAt(clientX: number): number | null {
    const box = dom.playerChartOverview.getBoundingClientRect();
    if (box.width <= 0) return null;
    return Math.max(0, Math.min(1, (clientX - box.left) / box.width));
}

function currentOverviewView(): { durationSec: number; view: ZoomViewState } | null {
    if (!state.chart || !state.active) return null;
    const trip = state.trips[state.active.trip];
    const xScale = state.chart.scales.x;
    if (!trip || !xScale || trip.timeline.contentDurationSec <= 0) return null;
    const durationSec = trip.timeline.contentDurationSec;
    const viewStartPct = Math.max(0, Math.min(1, xScale.min / durationSec));
    return {
        durationSec,
        view: {
            viewStartPct,
            viewEndPct: Math.max(viewStartPct, Math.min(1, xScale.max / durationSec)),
        },
    };
}

let overviewGesturePointerId: number | null = null;

function attachOverviewHandleEvents(handle: HTMLDivElement, edge: "start" | "end"): void {
    suppressEdgeSwipeNav(handle);
    const resizeTo = (clientX: number, gestureMinSpan: number): void => {
        const current = currentOverviewView();
        const ratio = overviewRatioAt(clientX);
        if (!current || ratio === null) return;
        applyNavigatorView(
            resizeZoomViewEdge(current.view, edge, ratio, current.durationSec, gestureMinSpan),
            current.durationSec,
        );
    };

    let gestureMinSpan = 0;
    attachPointerDrag(handle, {
        onStart: (e) => {
            if (overviewGesturePointerId !== null) return false;
            const initial = currentOverviewView();
            if (dom.playerChartOverview.hidden || !initial) return false;
            gestureMinSpan = computeEffectiveMinViewSpan(
                initial.durationSec,
                initial.view.viewEndPct - initial.view.viewStartPct,
            );
            e.preventDefault();
            e.stopPropagation();
            overviewGesturePointerId = e.pointerId;
            overviewResizeMinSpanPct = gestureMinSpan;
            handle.classList.add("is-dragging");
            return true;
        },
        onMove: (e) => resizeTo(e.clientX, gestureMinSpan),
        onEnd: () => {
            handle.classList.remove("is-dragging");
            overviewGesturePointerId = null;
            overviewResizeMinSpanPct = null;
            // Announce the current span as the next gesture's floor.
            syncChartOverview();
            // Conditional export actions may change the trim-bar height; keep
            // them deferred until the timeline can no longer move under a drag.
            callbacks.onSelectionChange?.();
        },
    });

    handle.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        const current = currentOverviewView();
        if (!current) return;
        e.preventDefault();
        e.stopPropagation();
        const minSpan = computeMinViewSpan(current.durationSec);
        const gestureMinSpan = computeEffectiveMinViewSpan(
            current.durationSec,
            current.view.viewEndPct - current.view.viewStartPct,
        );
        const baseStep = Math.max(0.01, minSpan);
        const step = Math.min(1, e.shiftKey ? baseStep * 5 : baseStep);
        const value = edge === "start" ? current.view.viewStartPct : current.view.viewEndPct;
        const target = value + (e.key === "ArrowLeft" ? -step : step);
        applyNavigatorView(
            resizeZoomViewEdge(current.view, edge, target, current.durationSec, gestureMinSpan),
            current.durationSec,
        );
    });
}

/** Attaches track centering, viewport pan, and edge-resize handlers. */
function attachOverviewEvents(): void {
    const overview = dom.playerChartOverview;
    suppressEdgeSwipeNav(overview);
    attachOverviewHandleEvents(dom.playerChartOverviewStart, "start");
    attachOverviewHandleEvents(dom.playerChartOverviewEnd, "end");

    // Pointerdown already applies track centering; swallow its synthetic click
    // before the chart-wide seek handler sees it.
    dom.playerChartZoomRow.addEventListener("click", (e) => e.stopPropagation());
    let moveViewportTo: (clientX: number) => void = () => {};
    attachPointerDrag(overview, {
        onStart: (e) => {
            if (overviewGesturePointerId !== null) return false;
            if (overview.hidden || !(e.target instanceof Element)) return false;
            if (e.target.closest(".range-overview-handle")) return false;
            const current = currentOverviewView();
            const pointerRatio = overviewRatioAt(e.clientX);
            if (!current || pointerRatio === null) return false;
            e.preventDefault();
            const span = current.view.viewEndPct - current.view.viewStartPct;
            const startsInsideViewport = Boolean(e.target.closest("#player-chart-overview-viewport"));
            const grabOffset = startsInsideViewport ? pointerRatio - current.view.viewStartPct : span / 2;
            moveViewportTo = (clientX) => {
                const ratio = overviewRatioAt(clientX);
                if (ratio === null) return;
                const newStart = Math.max(0, Math.min(ratio - grabOffset, 1 - span));
                applyNavigatorView({ viewStartPct: newStart, viewEndPct: newStart + span }, current.durationSec);
            };
            overviewGesturePointerId = e.pointerId;
            overview.classList.add("is-panning");
            moveViewportTo(e.clientX);
            return true;
        },
        onMove: (e) => moveViewportTo(e.clientX),
        onEnd: () => {
            overview.classList.remove("is-panning");
            overviewGesturePointerId = null;
            // Reveal export actions after panning, never under the pointer.
            callbacks.onSelectionChange?.();
        },
    });
}

/** Re-anchors every window-dependent timeline overlay after the visible x-window
 *  changes: rulers, overview viewport, inferred strip, and the px-positioned
 *  playhead/progress thumb/range tabs (via onViewChanged). Shared by the
 *  zoom/reset/resize paths so a new overlay is re-anchored in one place. */
function syncTimelineAfterViewChange(): void {
    syncChartRulers();
    syncChartOverview();
    redrawInferredStrip();
    callbacks.onViewChanged?.();
}

/**
 * Applies the visible x window for every timeline gesture. Full view uses the
 * active trip's bounds, so changing trips never restores a previous trip's range.
 */
function applyChartXRange(min: number, max: number, fullView: boolean): void {
    if (!state.chart || !state.active) return;
    const trip = state.trips[state.active.trip];
    if (!trip) return;
    const xOptions = state.chart.options.scales?.x;
    if (!xOptions) return;
    xOptions.min = fullView ? 0 : min;
    xOptions.max = fullView ? trip.timeline.contentDurationSec || 1 : max;
    state.chart.update("none");
    if (fullView) {
        if (state.chartZoomed) {
            state.chartZoomed = false;
            // No window left - clear the preview mark and the follow grace.
            state.isPreviewZoom = false;
            resetFollowTimelinePause();
            callbacks.onSelectionChange?.();
        }
    } else {
        if (!state.chartZoomed) {
            state.chartZoomed = true;
            callbacks.onSelectionChange?.();
        }
    }
    // The window just moved, so cached pixel positions are stale - re-anchor.
    syncTimelineAfterViewChange();
}

export function applyChartLayout(): void {
    const noGps = !state.hasTrack;
    dom.playerWrap.classList.toggle("no-gps", noGps);
    dom.playerWrap.classList.toggle("no-chart-data", noGps && !hasAccelData(activeTrip()?.records ?? []));
    // Chart.js must recalculate canvas size after area height changes.
    requestAnimationFrame(() => {
        if (state.chart) state.chart.resize();
    });
}

/** Resets the timeline zoom back to the full trip view. Shared by the canvas
 *  dblclick, the overview reset button, and (potential) keyboard reset. No-op
 *  when not zoomed. */
export function resetTimelineZoom(): void {
    if (!state.chart || !state.chartZoomed) return;
    applyChartXRange(0, 0, true);
}

/**
 * Zooms the timeline to an explicit [startSec, endSec] window (content-axis).
 * Used by the export panel's "preview clip" bridge and the event popup's export
 * action. A window covering the whole trip resets the zoom instead of zooming
 * to a full-width view (fullView mirrors zoomTimelineStep's epsilon check -
 * without it state.chartZoomed would stay true on a de-facto full view and
 * keep playback clamped).
 */
export function zoomTimelineToRange(startSec: number, endSec: number): void {
    if (!state.chart || !state.active) return;
    const trip = state.trips[state.active.trip];
    if (!trip) return;
    const dur = trip.timeline.contentDurationSec;
    if (dur <= 0 || endSec <= startSec) return;
    const fullView = startSec <= 1e-6 && endSec >= dur - 1e-6;
    applyChartXRange(Math.max(0, startSec), Math.min(dur, endSec), fullView);
    // This is THE preview path (export "Preview clip"): the window equals the
    // clip, so playback must be bounded to it (seek clamp + stop/loop). A
    // fullView call reset the zoom, so there is no preview window to mark.
    state.isPreviewZoom = !fullView;
    // applyChartXRange fires onSelectionChange only on the zoom-state
    // TRANSITION; refresh dependents (export button, range tabs) on every call.
    callbacks.onSelectionChange?.();
}

/**
 * Pans a zoomed timeline window (same span) so `sec` falls inside it. No-op
 * when not zoomed or already visible. Lets "jump playhead to clip boundary"
 * land on the real boundary: seekTripTime clamps every seek to the zoom
 * window, so without the pan a boundary outside the window is unreachable.
 */
export function panTimelineToInclude(sec: number): void {
    if (!state.chart || !state.active || !state.chartZoomed) return;
    const trip = state.trips[state.active.trip];
    if (!trip) return;
    const dur = trip.timeline.contentDurationSec;
    const xScale = state.chart.scales.x;
    if (!xScale || dur <= 0) return;
    const span = xScale.max - xScale.min;
    if (span <= 0 || span >= dur) return;
    if (sec >= xScale.min && sec <= xScale.max) return;
    // Place the target a small margin inside the leading edge of the window.
    const margin = span * 0.1;
    let min = sec < xScale.min ? sec - margin : sec + margin - span;
    min = Math.max(0, Math.min(min, dur - span));
    applyChartXRange(min, min + span, false);
    callbacks.onSelectionChange?.();
}

// Follow-pause grace (mirrors the map's noteUserMapInteraction /
// FOLLOW_RESUME_DELAY_MS): a manual pan/zoom takes control, so auto-follow stays
// quiet for a few seconds after the gesture. Timestamp (performance.now scale)
// after which follow may resume; 0 = not paused.
const FOLLOW_RESUME_DELAY_MS = 5000;
let followResumeAtMs = 0;

/** Arms the follow-pause grace after a manual timeline pan/zoom. */
function noteUserTimelineInteraction(): void {
    followResumeAtMs = performance.now() + FOLLOW_RESUME_DELAY_MS;
}

/** Clears the follow-pause grace (zoom reset / trip change - no gesture to honor). */
function resetFollowTimelinePause(): void {
    followResumeAtMs = 0;
}

/**
 * Auto-pans an inspection zoom window to keep the playing playhead in view: once
 * `sec` crosses ~85% of the window it pans forward so the playhead sits back near
 * ~15% (lookahead context). No-op when not zoomed, in a Preview-clip window (that
 * one bounds playback on purpose), during the post-gesture grace, or when no pan
 * is needed. Called from the player's timeupdate; the math is in computeFollowPan.
 */
export function followPlayheadInZoom(sec: number): void {
    if (!state.chart || !state.active || !state.chartZoomed || state.isPreviewZoom) return;
    if (performance.now() < followResumeAtMs) return;
    const trip = state.trips[state.active.trip];
    if (!trip) return;
    const dur = trip.timeline.contentDurationSec;
    const xScale = state.chart.scales.x;
    if (!xScale || dur <= 0) return;
    const span = xScale.max - xScale.min;
    const newStartPct = computeFollowPan(xScale.min / dur, xScale.max / dur, sec / dur);
    if (newStartPct == null) return;
    const min = newStartPct * dur;
    applyChartXRange(min, min + span, false);
    callbacks.onSelectionChange?.();
}

/** Zooms the timeline one step in (direction=1) or out (-1). The playhead is the
 *  anchor while it is visible; otherwise the window centre is stable. Used by
 *  both the explicit controls and the global +/- shortcuts. */
export function zoomTimelineStep(direction: 1 | -1): void {
    if (!state.chart || !state.active) return;
    const trip = state.trips[state.active.trip];
    if (!trip) return;
    const dur = trip.timeline.contentDurationSec;
    if (dur <= 0) return;
    const xScale = state.chart.scales.x;
    if (!xScale) return;
    const view = { viewStartPct: xScale.min / dur, viewEndPct: xScale.max / dur };
    const playheadSec = callbacks.getTripCurrentTime();
    const spanSec = xScale.max - xScale.min;
    const isPlayheadVisible = playheadSec >= xScale.min && playheadSec <= xScale.max && spanSec > 0;
    const anchorRatio = isPlayheadVisible ? (playheadSec - xScale.min) / spanSec : 0.5;
    // dy < 0 zooms in; applyWheelZoom keeps the chosen anchor stable.
    const next = applyWheelZoom(view, anchorRatio, direction === 1 ? -240 : 240, dur);
    if (!next) return;
    const fullView = next.viewStartPct <= 1e-6 && next.viewEndPct >= 1 - 1e-6;
    // Keyboard zoom is inspection, not a preview - the window follows the
    // playhead; arm the grace so it does not yank right after the keypress.
    state.isPreviewZoom = false;
    noteUserTimelineInteraction();
    applyChartXRange(next.viewStartPct * dur, next.viewEndPct * dur, fullView);
}

/** Chart.js uses the canvas inline width/height for rendering. When the user
 *  shows/hides the chart via the "View" menu (hidden attr on
 *  #player-chart-canvas), Chart.js gets no event - the canvas was just
 *  display:none, its bbox is real now, but Chart has not recomputed. Result:
 *  content drawn at the old dimensions looks squashed. Subscribe to view-menu
 *  state changes and poke chart.resize. */
function initChartViewMenuSync(): void {
    subscribeViewPanels(() => {
        // Double rAF: first waits for layout reflow after the :has() CSS
        // applies; second waits until Chart.js updates its internal dimensions
        // before the next draw.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (state.chart) state.chart.resize();
                redrawInferredStrip();
            });
        });
    });
}

/**
 * Creates the Chart.js instance on the canvas. Called once on startup.
 * Datasets and scales stay stable across trips; only data is swapped on trip change.
 *
 * Chart.js plugin/callback types are very generic; we type our callbacks minimally
 * (Chart, CanvasRenderingContext2D) rather than fighting the full generic chain.
 */
export function initChart(cb: ChartCallbacks): void {
    if (state.chart) return;
    callbacks = cb;
    const ctx = dom.chartCanvas.getContext("2d");
    if (!ctx) throw new Error("chart canvas: 2d context unavailable");

    // Plugin draws file-boundary tick marks + event-marker dots on top of
    // the datasets. Player playhead and hover cursor are NOT drawn here -
    // they live as DOM overlays on .player-chart (single visual elements
    // spanning chart canvas + ruler + strip), see setPlayerCursorRelSec /
    // setHoverCursorRelSec below.
    const cursorPlugin = {
        id: "playerCursor",
        beforeDraw(chart: Chart): void {
            // Recording-mode bands are the bottom-most data layer: drawing them
            // in beforeDraw (before grid, curves, pause blocks, markers) lets a
            // non-normal span tint the whole plot height without obscuring
            // anything above it. No-op for an all-normal trip (fast path).
            drawModeBands(chart, chart.ctx);
        },
        afterDatasetsDraw(chart: Chart): void {
            const top = chart.chartArea.top;
            const bottom = chart.chartArea.bottom;
            const c = chart.ctx;
            const xScale = chart.scales.x;
            if (!xScale) return;

            // Segment boundaries on the footage axis. A plain file-join (back-to-
            // back clips) draws a thin dashed tick; a recording PAUSE draws a
            // narrow neutral-gray block, since on the content axis the paused time
            // is removed and the join would otherwise be invisible. The block has a
            // fixed width (the axis does not reserve room for the pause) and carries
            // no inline label - its duration shows in the hover tooltip and the trip
            // card's pause count. gap.contentPos == the following segment's
            // contentStart (same value computed in buildTripTimeline), so we match
            // by position.
            if (state.active) {
                const trip = state.trips[state.active.trip];
                const segments = trip?.timeline.segments;
                if (trip && segments && segments.length > 1) {
                    const gapByPos = new Map(trip.timeline.gaps.map((g) => [g.contentPos, g]));
                    c.save();
                    for (let i = 1; i < segments.length; i++) {
                        const pos = segments[i]!.contentStart;
                        const fx = xScale.getPixelForValue(pos);
                        const gap = gapByPos.get(pos);
                        if (gap) {
                            drawPauseBlock(c, fx, top, bottom);
                        } else {
                            c.strokeStyle = themeColors().chartTickText;
                            c.globalAlpha = 0.35;
                            c.lineWidth = 1;
                            c.setLineDash([3, 3]);
                            c.beginPath();
                            c.moveTo(fx, top);
                            c.lineTo(fx, bottom);
                            c.stroke();
                        }
                    }
                    c.restore();
                }
            }

            // Event markers - circles at the top of chartArea, above the data curves.
            // Drawn last so they are not covered by file-boundary ticks
            // (events are visually more important - they are what users look for).
            drawEventMarkers(chart, c);
        },
        afterDraw(): void {
            // The hover cursor is a DOM overlay, not drawn on the canvas. Sync
            // it from the single source of truth (state.chartHoverX) on every
            // redraw so a zoom, pan or resize re-positions it on the new
            // x-scale. Pointer moves never redraw for it: the chart's own
            // mousemove calls setHoverCursorRelSec directly, and map/mini-map
            // hover reach it through the onHoverTripTime map callback (chart
            // depends on map, not the other way round).
            setHoverCursorRelSec(state.chartHoverX);
        },
    };

    // Chart.js options/scales types are deeply generic. The config below is a
    // stable literal; we cast to ChartOptions via `as any` to avoid fighting
    // strict literal types ("linear" vs string). Contents are standard Chart.js options.
    const tc = themeColors();
    const chartConfig: any = {
        type: "line",
        data: {
            datasets: [
                {
                    label: t("chart.axis.speed"),
                    data: [],
                    yAxisID: "ySpeed",
                    borderColor: tc.chartSpeed,
                    // 1.4 (was 1.5) reads cleaner on the now-frameless background.
                    // Per design 03-chart.md - slightly thinner line on clean dark.
                    borderWidth: 1.4,
                    // pointHoverRadius: 0 - no point highlight on hover; we show
                    // our own vertical line via the cursor plugin instead.
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    pointHitRadius: 8,
                    // fill removed - the trip strip background (G3) sits under the
                    // speed curve; a semi-transparent fill would obscure the frames.
                    fill: false,
                    spanGaps: false,
                    // tension + monotone mode smooth the 1 Hz "fence" into a
                    // continuous curve. Monotone does not overshoot beyond the data
                    // (cubic spline can exceed max(y) at steep transitions).
                    tension: 0.3,
                    cubicInterpolationMode: "monotone",
                },
                {
                    label: t("chart.axis.accel"),
                    data: [],
                    yAxisID: "yAccel",
                    borderColor: tc.chartAccel,
                    borderWidth: 1.2,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    pointHitRadius: 8,
                    fill: false,
                    spanGaps: true,
                    tension: 0.3,
                    cubicInterpolationMode: "monotone",
                },
            ],
        },
        options: {
            animation: false,
            // Decimation reads raw {x, y} points; parsing would copy them.
            parsing: false,
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "nearest", intersect: false, axis: "x" },
            scales: {
                x: {
                    type: "linear",
                    min: 0,
                    max: 1,
                    // Chart.js x-axis ticks/labels disabled: replaced by the shared
                    // range-rulers (top = relative, bottom = absolute clock). Without
                    // display:false labels duplicated and the Chart.js "+0:00…+1:30:00"
                    // row consumed vertical space.
                    ticks: { display: false },
                    grid: { color: `${tc.chartGrid}55` },
                },
                ySpeed: {
                    type: "linear",
                    position: "left",
                    beginAtZero: true,
                    ticks: { color: tc.chartSpeed, maxTicksLimit: 4 },
                    grid: { color: `${tc.chartGrid}33` },
                    // UX-16: vertical title hidden - unit label lives as .chart-axis-label--speed overlay in HTML.
                    title: { display: false },
                    afterFit: enforceEdgeGutterAxisWidth,
                },
                yAccel: {
                    type: "linear",
                    position: "right",
                    beginAtZero: true,
                    ticks: { color: tc.chartAccel, maxTicksLimit: 4 },
                    grid: { display: false },
                    // UX-16: see ySpeed.title above.
                    title: { display: false },
                    afterFit: enforceEdgeGutterAxisWidth,
                },
            },
            plugins: {
                // Built-in legend disabled - it consumes vertical space at the top.
                // Replaced by inline overlay .player-chart-legend in HTML.
                legend: { display: false },
                // Tooltip plugin fully disabled. Previously `enabled:false, external:`
                // still subscribed Chart.js to canvas mousemove and `notifyPlugins.afterEvent`
                // called our function - landing in the hot path (~12% CPU during active
                // hovering). We now render tooltip DOM ourselves in processChartHover;
                // Chart.js does no work on mousemove through the tooltip plugin.
                tooltip: false,
            },
            // options.onClick is intentionally not set: Chart.js v4 _handleEvent
            // only calls it when inChartArea === true (i.e. inside the
            // plot-rectangle, excluding the X-axis labels band at the bottom and
            // the Y-axis padding on the left/right). Because of that, a click on
            // any "non-working" zone of the chart - the time ticks below, the
            // corner axis-label overlays, the 1px between chart and event-strip,
            // the strip-wrap padding where axis labels project - did not lead to
            // a seek, even though the chart grid/numbers are visually there. The
            // single handler below on the .player-chart wrap itself covers ALL
            // those zones via the bubble.
        },
        // Gap-aware LTTB over the visible window; see chart-decimation.ts.
        plugins: [gapAwareDecimationPlugin, cursorPlugin],
    };
    state.chart = new ChartClass!(ctx, chartConfig);

    // View-menu visibility sync: showing/hiding the chart canvas via the
    // "View" menu requires a resize, otherwise content stays squashed.
    initChartViewMenuSync();

    // Inferred event strip (Variant B). Bound to the chart's x-scale via
    // factory closure - redraws on chart events (zoom/pan/resize/theme).
    // The host canvas lives in a wrap div with axis-label overlays; here
    // we hand the strip module the inner canvas + wrap (for DOM overlays
    // like playhead, scrub-line, overlap diamonds, click flash) + onSeek.
    if (dom.chartInferredStrip && dom.chartInferredStripWrap) {
        inferredStripHandle = initInferredStrip({
            canvas: dom.chartInferredStrip,
            wrap: dom.chartInferredStripWrap,
            chart: state.chart,
            getTrip: activeTrip,
            onSeek: callbacks.onSeekTripTime,
            // Flash overlay spans chart + ruler + strip (not just strip) so
            // the pulse reads as a click on the column, not "something
            // happened at the bottom".
            onFlash: flashPlayerChartAtRelSec,
        });
        // Strip canvas reads colors from themeColors() cache that gets
        // invalidated by applyTheme/prefers-color-scheme. The strip itself
        // does not redraw automatically on cache invalidation, only on
        // chart events (zoom/pan/resize). Subscribe to push a manual redraw
        // on theme switch so cached colors land on the canvas immediately.
        subscribeThemeChange(() => redrawInferredStrip());
    }

    // Hover indicator: vertical gray line following the cursor + no-gps tooltip
    // (when datasets are empty and Chart.js internal tooltip is disabled).
    // Previously two independent mousemove listeners each did their own compute +
    // chart.draw()/DOM-write. At 60 Hz × 2 handlers × ~5 ms/draw that was noticeable
    // (Chart.js tooltip plugin afterEvent showed up hot in profiles).
    //
    // rAF coalescing: store the latest event, process it once per frame. If
    // pointermove arrives faster than 60 Hz (browser buffering under load) we
    // deduplicate to one update. Cache the last processed pixel position - a
    // stationary mouse can still trigger pointermove (subpixel jitter, focus
    // events). Skip work when the pixel has not moved.
    let lastProcessedPx = -1;
    let chartHoverRafScheduled = false;
    let pendingChartMouseEvent: MouseEvent | null = null;
    const processChartHover = (): void => {
        chartHoverRafScheduled = false;
        const e = pendingChartMouseEvent;
        pendingChartMouseEvent = null;
        if (!e || !state.chart || !state.active) return;
        const xScale = state.chart.scales.x;
        if (!xScale) return;
        const rect = dom.chartCanvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        if (Math.abs(px - lastProcessedPx) < 1) return;
        lastProcessedPx = px;
        const x = xScale.getValueForPixel(px);
        if (x === undefined || !Number.isFinite(x)) return;
        const trip = state.trips[state.active.trip];
        if (!trip) return;

        // Hover cursor is a DOM overlay spanning the whole .player-chart -
        // no canvas redraw needed. state.chartHoverX is still updated for
        // any other consumers (none active now, kept for safety).
        state.chartHoverX = x;
        setHoverCursorRelSec(x);

        // Event-marker popup hit-test rides the same coalesced tick (before
        // the pause early-return: events and pauses live in different y-zones).
        maybeShowEventPopupOnHover(e, rect);

        // Pause block takes priority: over a recording-pause marker show
        // "pause N min" instead of a record popup, and skip the thumb decode
        // (a pause has no footage).
        const pauseGap = pauseGapAtPx(trip, px);
        if (pauseGap) {
            renderPauseTooltip(e, pauseGap);
            return;
        }

        // Keep pushing the thumb-idle timer further if a decode is pending.
        // renderHasTrackTooltip below dedups on GPS-record key, so a slow
        // drag inside a single record would otherwise fail to reset the
        // timer and the decode would fire mid-drag.
        pingTooltipThumbIdleTimer();

        // Tooltip box: different data sources in has-track vs no-gps modes,
        // but shared positioning/animation. Chart.js tooltip plugin is disabled -
        // this is the only path, no parallel handlers.
        if (state.hasTrack) {
            renderHasTrackTooltip(e, trip, x);
        } else {
            renderNoGpsTooltip(e, trip, x);
        }
    };
    // Hover belongs to pointers that can hover. A tap on a touch screen is
    // followed by compatibility mouse events, and its synthetic mousemove
    // opened the tooltip (and decoded a thumbnail) that no mouseleave ever
    // closed, covering the chart the user had just tapped to seek. Pointer
    // events precede their compatibility mouse events, so the last pointer
    // type seen on the row classifies each mousemove, the strip's forwarded
    // ones included.
    let lastChartPointerType = "mouse";
    const notePointerType = (e: PointerEvent): void => {
        lastChartPointerType = e.pointerType;
    };
    dom.playerChartEl?.addEventListener("pointermove", notePointerType, { capture: true });
    dom.playerChartEl?.addEventListener(
        "pointerdown",
        (e) => {
            notePointerType(e);
            // A hybrid device may still show the mouse's tooltip.
            if (e.pointerType === "touch") dom.chartCanvas.dispatchEvent(new MouseEvent("mouseleave"));
        },
        { capture: true },
    );
    dom.chartCanvas.addEventListener("mousemove", (e) => {
        if (lastChartPointerType === "touch") return;
        pendingChartMouseEvent = e;
        if (!chartHoverRafScheduled) {
            chartHoverRafScheduled = true;
            requestAnimationFrame(processChartHover);
        }
    });
    dom.chartCanvas.addEventListener("mouseleave", () => {
        pendingChartMouseEvent = null;
        lastProcessedPx = -1;
        lastTooltipKey = null;
        state.chartHoverX = null;
        setHoverCursorRelSec(null);
        if (state.chartTooltipEl) state.chartTooltipEl.style.opacity = "0";
        // Increment race token so in-flight extracts do not flash after mouseleave.
        // Cancel a pending idle-timer too - otherwise extractFrameAt would fire
        // 1 s after the user already left the chart.
        tooltipThumbToken++;
        cancelTooltipThumbIdleTimer();
        tooltipThumbLastKey = null;
        tooltipThumbDrawnKey = null;
        clearTooltipThumb();
    });

    // Unified hover zone: mousemove over the inferred-strip canvas should also
    // drive the chart tooltip (single popover for chart + strip per design
    // 02-scrub-thumb.md). Forward synthetic mousemove with the same clientX/Y
    // so the existing handler computes hover X via chart.scales.x.getValueForPixel
    // without duplicating logic. mouseleave from the strip triggers the same
    // cleanup ONLY when the cursor truly leaves the chart canvas too -
    // event.relatedTarget tells us where it went.
    const stripCanvas = dom.chartInferredStrip;
    if (stripCanvas) {
        // A hidden canvas has no hover geometry to forward to.
        const chartCanvasInteractive = (): boolean => !dom.chartCanvas.hidden;
        stripCanvas.addEventListener("mousemove", (ev) => {
            if (!chartCanvasInteractive()) return;
            dom.chartCanvas.dispatchEvent(
                new MouseEvent("mousemove", { clientX: ev.clientX, clientY: ev.clientY, bubbles: false }),
            );
        });
        stripCanvas.addEventListener("mouseleave", (ev) => {
            if (!chartCanvasInteractive()) return;
            // If moving from strip back into chart - chart already has its own
            // mousemove keeping the tooltip alive. Only dispatch leave when going
            // somewhere else.
            if (ev.relatedTarget !== dom.chartCanvas) {
                dom.chartCanvas.dispatchEvent(new MouseEvent("mouseleave"));
            }
        });
    }

    // The single seek-click for the whole .player-chart row. Covers zones with
    // no native click handler: the range-ruler on top, the canvas X/Y-axis
    // labels (which Chart.js draws OUTSIDE chartArea, so options.onClick stays
    // silent there), the 1px border between canvas and event-strip, the
    // strip-wrap padding on the left/right where the chart axis labels project.
    // The click event bubbles up to this node from all descendants:
    //  - chart canvas: lands here directly (options.onClick removed).
    //  - strip canvas: its own onClick does the snap-to-event-start and stops
    //    propagation, so there is no second seek here.
    //  - navigator drag: also stops its own click below.
    //  - event-marker capture-click: already calls stopImmediatePropagation
    //    (see the canvas click handler in initEventPopupListeners), which keeps
    //    this handler from firing on top of the marker.
    if (dom.playerChartEl) {
        dom.playerChartEl.addEventListener("click", (e: MouseEvent) => {
            if (!state.chart || !state.active) return;
            // A pinch that just ended may synthesize a click, and a completed
            // drag-select always fires one - do not read either as a seek.
            // The drag window deliberately swallows EVERY click until the
            // timer expires, not just the first trailing one: a dblclick
            // right after a drag is the reset gesture, and letting its
            // component clicks through would seek mid-reset.
            if (chartPinchSuppressClick || chartDragSuppressClick) return;
            // The progress bar lives inside this row and already seeks on its
            // own pointerdown with its own px->sec mapping. Letting the bubbled
            // click seek again lands a fraction of a second away from the first
            // target, and on the MSE pipeline every seek restarts the feed.
            if (e.target instanceof Node && dom.miniProgress?.contains(e.target)) return;
            const sec = chartSecAtClientX(e.clientX);
            if (sec !== null && Number.isFinite(sec)) callbacks.onSeekTripTime(sec);
        });
    }

    // Double-click on the canvas resets zoom.
    dom.chartCanvas.addEventListener("dblclick", resetTimelineZoom);
    // Keyboard activation has detail=0. When an action reaches its limit and
    // disables itself, keep focus on the remaining usable zoom control.
    dom.playerChartZoomOut.addEventListener("click", (e) => {
        e.stopPropagation();
        zoomTimelineStep(-1);
        if (e.detail === 0 && dom.playerChartZoomOut.disabled) dom.playerChartZoomIn.focus();
    });
    dom.playerChartZoomIn.addEventListener("click", (e) => {
        e.stopPropagation();
        zoomTimelineStep(1);
        if (e.detail === 0 && dom.playerChartZoomIn.disabled) dom.playerChartZoomOut.focus();
    });
    // Visible reset affordance left of the stable -/+ pair (shown only while zoomed), so
    // returning to full view doesn't depend on the undiscoverable dblclick - and
    // works on touch, where dblclick-to-reset is unreliable. stopPropagation so
    // the tap isn't also read by the chart-wide seek handler.
    dom.playerChartOverviewReset.addEventListener("click", (e) => {
        e.stopPropagation();
        resetTimelineZoom();
        if (e.detail === 0) dom.playerChartZoomIn.focus();
    });

    // UX-15: hover/click on an event marker shows a popup with ±5/±10/±30 s buttons.
    // Implemented as a separate canvas listener that only fires when the mouse is
    // physically over a marker (EVENT_HIT_PX), not on every mousemove.
    initEventPopupListeners();

    // Initial sync - imperial users need the label flipped to "mph" before
    // their first chart render. Idempotent for metric (overlay text already
    // matches the static i18n baseline).
    syncSpeedAxisUnitLabel();

    // Units preference (km/h vs mph) changes both the Y-axis label and the
    // numeric speed values in the dataset. Re-render the active trip so the
    // curve heights match the displayed unit.
    subscribeUnitsChange(() => {
        syncSpeedAxisUnitLabel();
        if (state.chart && state.active) {
            const trip = state.trips[state.active.trip];
            if (trip) rebuildChartFromTrip(trip);
        }
    });

    // Resize sync: ruler ticks and navigator viewport rect depend on
    // chartArea.width; redraw on resize. Observes the host row, not the
    // canvas: a display:none canvas (no-GPS collapse / View menu) stops
    // resizing, but the ruler + the synthetic gutter (px-derived fractions in
    // getTimelineView) still go stale when the row width changes.
    if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => {
            // The visible window did not move, but its pixel basis did:
            // setPlayerCursorRelSec writes `left` in absolute px (frac * canvas
            // width), so a width change (e.g. entering export-mode: sidebar
            // vacates, panel reserves margin) leaves the playhead stale. While
            // paused no timeupdate fires to refresh it - and export-mode pauses
            // playback - so it would freeze off by how far into the trip we are.
            syncTimelineAfterViewChange();
        });
        if (dom.playerChartEl) ro.observe(dom.playerChartEl);
    }

    // Overview - click centres, body drag pans, edge drag resizes.
    attachOverviewEvents();

    // Wheel: vertical → zoom around cursor, horizontal → pan view.
    // Attached to the whole #player-chart wrap (not just the canvas) so the
    // gesture works anywhere the timeline is drawn - chart, ruler, event-strip,
    // and the padding gutters - matching the single seek-click handler's hit
    // area. Wheel events from those descendants bubble up here. The x-scale
    // pixel math still anchors to the canvas rect (xScale.left/right are in
    // canvas pixels), with cursorRatio clamped so a cursor over the ruler
    // gutter maps to the nearest edge.
    // Math lives in strip-zoom.ts (shared with export-slider). preventDefault
    // only when a change was applied - at full-overview zoom-out or minimum
    // zoom-in we let the wheel propagate to the page scroll.
    dom.playerChartEl?.addEventListener(
        "wheel",
        (e: WheelEvent) => {
            if (!state.chart || !state.active || !dom.chartCanvas) return;
            const trip = state.trips[state.active.trip];
            if (!trip) return;
            const dur = trip.timeline.contentDurationSec;
            if (dur <= 0) return;
            const xScale = state.chart.scales.x;
            if (!xScale) return;
            const view = {
                viewStartPct: xScale.min / dur,
                viewEndPct: xScale.max / dur,
            };
            const { dx, dy } = normalizeWheelDelta(e);
            const rect = dom.chartCanvas.getBoundingClientRect();

            if (Math.abs(dx) > Math.abs(dy)) {
                // Pan: deltaPx translated to trip-time via chartArea width (scale
                // pixels), not canvas.width - ruler ticks use the same coordinate
                // system, so pan speed stays in sync with the visual chart width.
                const sliderWidth = xScale.right - xScale.left;
                const next = applyWheelPan(view, dx, sliderWidth);
                if (!next) return;
                e.preventDefault();
                // Manual pan = inspection + take control (pause auto-follow).
                state.isPreviewZoom = false;
                noteUserTimelineInteraction();
                applyChartXRange(next.viewStartPct * dur, next.viewEndPct * dur, false);
            } else {
                // Zoom around cursor: cursorRatio is relative to chartArea (not
                // canvas) so the zoom anchor aligns exactly with the x-coord under
                // the cursor. Clamped to [0,1] for events over the axis gutters.
                const cursorPx = e.clientX - rect.left;
                const sliderWidth = xScale.right - xScale.left;
                const rawRatio = sliderWidth > 0 ? (cursorPx - xScale.left) / sliderWidth : 0;
                const cursorRatio = Math.max(0, Math.min(1, rawRatio));
                const next = applyWheelZoom(view, cursorRatio, dy, dur);
                if (!next) return;
                e.preventDefault();
                const fullView = next.viewStartPct <= 1e-6 && next.viewEndPct >= 1 - 1e-6;
                // Wheel zoom = inspection + take control (pause auto-follow).
                state.isPreviewZoom = false;
                noteUserTimelineInteraction();
                applyChartXRange(next.viewStartPct * dur, next.viewEndPct * dur, fullView);
            }
        },
        { passive: false },
    );

    // Touch: two-finger pinch is the gesture counterpart of the wheel zoom above
    // (a phone has no wheel). Mirrors the video pinch in player-zoom.ts.
    initChartTouchZoom();

    // Mouse: Audacity-style drag-select zooms to the selected span.
    initChartDragSelectZoom();
}

/**
 * Trip-time (content-sec) under a clientX. Uses the chart x-scale when the
 * canvas is visible; with the canvas hidden (no-gps trip or the "View" menu)
 * falls back to the shared timelineFracToSec over the .player-chart width -
 * the same mapping the always-on progress bar and the playhead use. Null when
 * the pointer is outside the usable width or no trip is active.
 */
function chartSecAtClientX(clientX: number): number | null {
    if (!state.chart || !state.active || !dom.playerChartEl) return null;
    if (dom.chartCanvas.hidden) {
        const rect = dom.playerChartEl.getBoundingClientRect();
        if (rect.width <= 0) return null;
        return timelineFracToSec((clientX - rect.left) / rect.width);
    }
    const xScale = state.chart.scales.x;
    if (!xScale) return null;
    const rect = dom.chartCanvas.getBoundingClientRect();
    const px = clientX - rect.left;
    // Guard against a position to the right/left of the canvas (invariant in
    // theory, but .player-chart can be wider than the canvas due to paddings).
    if (px < 0 || px > rect.width) return null;
    const x = xScale.getValueForPixel(px);
    return x === undefined ? null : x;
}

// === Touch pinch zoom on the timeline ===
//
// The desktop wheel zooms the visible window; a phone needs the same via a
// two-finger pinch. We track touch contacts on the whole .player-chart and
// promote to a pinch on the second finger, anchoring the content under the
// gesture-start centroid to the moving centroid (zoom + pan in one motion -
// same model as the video pinch). The navigator (pan) and mini-progress (seek)
// keep their own single-finger drag, so a finger there is NOT counted toward a
// pinch and we never fight their pointer capture.
interface ChartPinchState {
    startDist: number;
    startView: { viewStartPct: number; viewEndPct: number };
    startCentroidRatio: number;
}
let chartPinch: ChartPinchState | null = null;
// A pinch usually fires no trailing click; a persistent flag would eat the next
// real tap, so this self-clears if no click arrives shortly after the gesture.
let chartPinchSuppressClick = false;
let chartPinchSuppressTimer = 0;

/** Centroid of the given client-X coords as a [0,1] ratio across the chart's
 *  plot area (xScale.left..right), matching the wheel handler's cursorRatio.
 *  Null when the chart/scale is not ready or the plot area has no width. */
function chartCentroidRatio(clientX: number): number | null {
    if (!state.chart) return null;
    const xScale = state.chart.scales.x;
    if (!xScale) return null;
    const sliderWidth = xScale.right - xScale.left;
    if (sliderWidth <= 0) return null;
    const rect = dom.chartCanvas.getBoundingClientRect();
    const ratio = (clientX - rect.left - xScale.left) / sliderWidth;
    return Math.max(0, Math.min(1, ratio));
}

function initChartTouchZoom(): void {
    const host = dom.playerChartEl;
    if (!host) return;
    attachPinchGesture(host, {
        accepts: (event) => {
            // Navigator, scrubber and range tabs own their single-finger drags;
            // stealing capture from one would interrupt the selected range.
            return (
                !(event.target instanceof Element) ||
                !event.target.closest(".chart-zoom-row, #player-mini-progress, .timeline-range__tab")
            );
        },
        onStart: (geometry) => {
            if (!state.chart || !state.active) return false;
            const trip = state.trips[state.active.trip];
            const dur = trip?.timeline.contentDurationSec ?? 0;
            const xScale = state.chart.scales.x;
            const ratio = chartCentroidRatio(geometry.centerX);
            if (dur <= 0 || !xScale || ratio === null) return false;
            chartPinch = {
                startDist: geometry.distance,
                startView: { viewStartPct: xScale.min / dur, viewEndPct: xScale.max / dur },
                startCentroidRatio: ratio,
            };
            return true;
        },
        onMove: (geometry) => {
            if (!chartPinch || !state.chart || !state.active) return;
            const trip = state.trips[state.active.trip];
            const dur = trip?.timeline.contentDurationSec ?? 0;
            const curRatio = chartCentroidRatio(geometry.centerX);
            if (dur <= 0 || curRatio === null) return;
            const next = applyPinchZoom(
                chartPinch.startView,
                chartPinch.startCentroidRatio,
                curRatio,
                geometry.distance / chartPinch.startDist,
                dur,
            );
            const fullView = next.viewStartPct <= 1e-6 && next.viewEndPct >= 1 - 1e-6;
            // Pinch zoom = inspection + take control (pause auto-follow), like wheel.
            state.isPreviewZoom = false;
            noteUserTimelineInteraction();
            applyChartXRange(next.viewStartPct * dur, next.viewEndPct * dur, fullView);
        },
        onEnd: () => {
            chartPinch = null;
            // A pinch often fires no trailing click; do not swallow the next tap.
            chartPinchSuppressClick = true;
            if (chartPinchSuppressTimer) clearTimeout(chartPinchSuppressTimer);
            chartPinchSuppressTimer = window.setTimeout(() => {
                chartPinchSuppressClick = false;
                chartPinchSuppressTimer = 0;
            }, 400);
        },
    });
}

// === Mouse drag-select zoom on the timeline ===
//
// Audacity-style: press on the timeline background, drag horizontally, release -
// the selected span becomes the visible window (the same applyChartXRange path
// as wheel/pinch, so chartZoomed/export-selection semantics are identical).
// Mouse-only: touch keeps pinch, and the navigator / mini-progress / export
// pull-tabs own their pointers and never start a selection. A press that stays
// under the threshold remains a plain seek-click.

/** Horizontal travel (px) that turns a press into a selection instead of a click.
 *  A deliberate chart selection crosses this easily; ordinary pointer wobble
 *  while seeking does not turn into a surprise deep zoom. */
const DRAG_SELECT_THRESHOLD_PX = 12;
// A completed drag fires a trailing click on the host (down/up share the
// ancestor); suppress it so the release is not read as a seek. Self-clears in
// case the browser skips the click (mirrors chartPinchSuppressClick).
let chartDragSuppressClick = false;
let chartDragSuppressTimer = 0;

function initChartDragSelectZoom(): void {
    const host = dom.playerChartEl;
    if (!host) return;

    let dragPointerId: number | null = null;
    let dragStartClientX = 0;
    let isSelecting = false;
    let selectRectEl: HTMLDivElement | null = null;

    // The zoom row and mini-progress own their drags; export pull-tabs and
    // buttons keep their native behavior.
    const eligible = (target: EventTarget | null): boolean => {
        if (!(target instanceof Element)) return true;
        return !target.closest(".chart-zoom-row, #player-mini-progress, .timeline-range__tab, button");
    };

    // Selection endpoints must resolve even when the mouse travels past the
    // plot edge mid-drag, so clamp into the coordinate host chartSecAtClientX
    // reads from (canvas when visible, the whole row otherwise).
    const clampToTimelineWidth = (clientX: number): number => {
        const basis = dom.chartCanvas.hidden ? host : dom.chartCanvas;
        const rect = basis.getBoundingClientRect();
        return Math.min(Math.max(clientX, rect.left), rect.right);
    };

    const removeSelectRect = (): void => {
        selectRectEl?.remove();
        selectRectEl = null;
    };

    const updateSelectRect = (clientX: number): void => {
        if (!selectRectEl) {
            selectRectEl = document.createElement("div");
            selectRectEl.className = "chart-drag-select";
            host.appendChild(selectRectEl);
        }
        const hostRect = host.getBoundingClientRect();
        const a = clampToTimelineWidth(dragStartClientX) - hostRect.left;
        const b = clampToTimelineWidth(clientX) - hostRect.left;
        selectRectEl.style.left = `${Math.min(a, b)}px`;
        selectRectEl.style.width = `${Math.abs(b - a)}px`;
    };

    const endDrag = (): void => {
        dragPointerId = null;
        isSelecting = false;
        removeSelectRect();
    };

    host.addEventListener("pointerdown", (e: PointerEvent) => {
        if (e.pointerType !== "mouse" || e.button !== 0 || !eligible(e.target)) return;
        if (!state.chart || !state.active) return;
        dragPointerId = e.pointerId;
        dragStartClientX = e.clientX;
        isSelecting = false;
    });

    host.addEventListener("pointermove", (e: PointerEvent) => {
        if (dragPointerId !== e.pointerId) return;
        // A mouse keeps one persistent pointerId, so a pointerup missed outside
        // the row (no capture before the threshold) would leave the drag armed;
        // a hover without the primary button held is that stale state - drop it.
        if ((e.buttons & 1) === 0) {
            endDrag();
            return;
        }
        if (!isSelecting) {
            if (Math.abs(e.clientX - dragStartClientX) < DRAG_SELECT_THRESHOLD_PX) return;
            isSelecting = true;
            // Keep receiving moves when the mouse leaves the timeline row.
            capturePointer(host, e.pointerId);
            // Capture retargets pointer/mouse events to the host, which starves
            // the canvas hover handler mid-fade; run its mouseleave cleanup so
            // the tooltip and hover cursor do not freeze over the selection.
            dom.chartCanvas.dispatchEvent(new MouseEvent("mouseleave"));
        }
        updateSelectRect(e.clientX);
    });

    host.addEventListener("pointerup", (e: PointerEvent) => {
        if (dragPointerId !== e.pointerId) return;
        const wasSelecting = isSelecting;
        const endClientX = e.clientX;
        endDrag();
        if (!wasSelecting) return; // plain click - the click handler seeks
        chartDragSuppressClick = true;
        if (chartDragSuppressTimer) clearTimeout(chartDragSuppressTimer);
        chartDragSuppressTimer = window.setTimeout(() => {
            chartDragSuppressClick = false;
            chartDragSuppressTimer = 0;
        }, 400);

        if (!state.chart || !state.active) return;
        const trip = state.trips[state.active.trip];
        if (!trip) return;
        const dur = trip.timeline.contentDurationSec;
        if (dur <= 0) return;
        const secA = chartSecAtClientX(clampToTimelineWidth(dragStartClientX));
        const secB = chartSecAtClientX(clampToTimelineWidth(endClientX));
        if (secA === null || secB === null) return;
        let start = Math.max(0, Math.min(secA, secB));
        let end = Math.min(dur, Math.max(secA, secB));
        // Same floor as wheel/pinch zoom: a selection tighter than the minimum
        // window grows symmetrically around its centre instead of over-zooming.
        const minSpanSec = computeMinViewSpan(dur) * dur;
        if (end - start < minSpanSec) {
            const centre = (start + end) / 2;
            start = Math.max(0, Math.min(centre - minSpanSec / 2, dur - minSpanSec));
            end = start + minSpanSec;
        }
        // Selection = inspection + take control (pause auto-follow), like wheel.
        state.isPreviewZoom = false;
        noteUserTimelineInteraction();
        const fullView = start <= 1e-6 && end >= dur - 1e-6;
        applyChartXRange(start, end, fullView);
    });

    host.addEventListener("pointercancel", (e: PointerEvent) => {
        if (dragPointerId !== e.pointerId) return;
        endDrag();
    });

    // Capture can vanish without pointerup/pointercancel (host detached from
    // the DOM mid-gesture); after a normal release this is a no-op because
    // pointerup already cleared dragPointerId.
    host.addEventListener("lostpointercapture", (e: PointerEvent) => {
        if (dragPointerId !== e.pointerId) return;
        endDrag();
    });
}

// === UX-15: event pop-action popup ===

/** Half-window of the popup's "save clip" action: the committed export range is
 *  event ± this many seconds (clamped to the trip). ±10s captures the lead-up
 *  and aftermath of a braking event without dragging in unrelated footage. */
const EVENT_EXPORT_SPAN_SEC = 10;

/** Sticky mode: popup was opened by a click; stays open until Escape, outside click, or click on a different marker. */
let eventPopupSticky = false;
let eventPopupShowTimer: ReturnType<typeof setTimeout> | null = null;
let eventPopupHideTimer: ReturnType<typeof setTimeout> | null = null;
let eventPopupCurrent: TripEvent | null = null;

function ensureEventPopupElement(): HTMLDivElement {
    let el = document.querySelector<HTMLDivElement>("#event-popup");
    if (el) return el;
    el = document.createElement("div");
    el.id = "event-popup";
    el.className = "event-popup";
    el.hidden = true;
    document.body.appendChild(el);
    return el;
}

function showEventPopup(ev: TripEvent, anchorPx: { x: number; y: number }): void {
    if (!state.active) return;
    const trip = state.trips[state.active.trip];
    if (!trip) return;
    const el = ensureEventPopupElement();
    eventPopupCurrent = ev;

    const titleStr = t("event.popup.titleFmt", {
        time: formatTime(ev.relSec),
        severity: formatNumber(ev.severity, 2),
    });
    el.innerHTML = `
        <div class="event-popup-title mono">${escapeHtml(titleStr)}</div>
        <div class="event-popup-actions">
            <button type="button" class="event-popup-btn" data-pop-span="5">${escapeHtml(t("event.popup.action5"))}</button>
            <button type="button" class="event-popup-btn" data-pop-span="10">${escapeHtml(t("event.popup.action10"))}</button>
            <button type="button" class="event-popup-btn" data-pop-span="30">${escapeHtml(t("event.popup.action30"))}</button>
        </div>
        <button type="button" class="event-popup-export" data-pop-export="${EVENT_EXPORT_SPAN_SEC}">${escapeHtml(
            t("event.popup.export"),
        )}</button>
    `;
    el.hidden = false;

    // Position above the marker (anchor X = marker pixel in viewport).
    // Clamp to screen edges.
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = anchorPx.x - w / 2;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    if (left < 8) left = 8;
    let top = anchorPx.y - h - 14;
    if (top < 8) top = anchorPx.y + 14;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
}

function hideEventPopup(): void {
    const el = document.querySelector<HTMLElement>("#event-popup");
    if (el) el.hidden = true;
    eventPopupSticky = false;
    eventPopupCurrent = null;
}

/**
 * Hover hit-test for the event markers in the chart's top strip. Called from
 * the rAF-coalesced processChartHover (NOT from its own mousemove listener -
 * see the note in initEventPopupListeners), so it runs at most once per frame
 * and reuses the rect/scale the hover pipeline already computed.
 */
function maybeShowEventPopupOnHover(e: MouseEvent, rect: DOMRect): void {
    if (!state.active || !state.chart) return;
    const trip = state.trips[state.active.trip];
    if (!trip || trip.events.length === 0) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const xScale = state.chart.scales.x;
    if (!xScale) return;
    const top = state.chart.chartArea.top;
    // Only test points near the top of chartArea + EVENT_HIT_PX radius.
    if (cy > top + EVENT_HIT_PX * 2) {
        // Cursor is far from the marker strip - schedule a delayed hide (non-sticky).
        if (eventPopupSticky) return;
        if (!eventPopupHideTimer && !document.querySelector<HTMLElement>("#event-popup")?.hidden) {
            eventPopupHideTimer = setTimeout(hideEventPopup, 300);
        }
        return;
    }
    const chartX = xScale.getValueForPixel(cx);
    const bestEv = chartX == null ? null : findVisibleEventNearX(trip, chartX);
    if (!bestEv) return;

    if (eventPopupHideTimer) {
        clearTimeout(eventPopupHideTimer);
        eventPopupHideTimer = null;
    }
    // Already showing this event - no need to rebuild.
    if (eventPopupCurrent === bestEv && !document.querySelector<HTMLElement>("#event-popup")?.hidden) return;

    if (eventPopupShowTimer) clearTimeout(eventPopupShowTimer);
    const evRef = bestEv;
    const anchor = { x: rect.left + xScale.getPixelForValue(evRef.relSec), y: rect.top + top };
    eventPopupShowTimer = setTimeout(() => {
        eventPopupShowTimer = null;
        showEventPopup(evRef, anchor);
    }, 200);
}

function initEventPopupListeners(): void {
    const el = ensureEventPopupElement();

    // Mouseenter into the popup - cancel the pending hide timer.
    el.addEventListener("mouseenter", () => {
        if (eventPopupHideTimer) {
            clearTimeout(eventPopupHideTimer);
            eventPopupHideTimer = null;
        }
    });
    el.addEventListener("mouseleave", () => {
        if (eventPopupSticky) return;
        eventPopupHideTimer = setTimeout(hideEventPopup, 300);
    });

    // Action button click: zoom chart around the event and seek to event start.
    el.addEventListener("click", (e) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;
        // "Save clip" leg: same ±span window, but committed as the EXPORT range
        // (not just the scratch zoom view) with the panel opened on it. The
        // headline dashcam use case - one tap from a detected event to an
        // export pre-trimmed around it.
        const exportBtn = target.closest<HTMLButtonElement>(".event-popup-export");
        if (exportBtn && eventPopupCurrent) {
            const span = Number(exportBtn.dataset.popExport);
            if (!Number.isFinite(span) || span <= 0) return;
            const ev = eventPopupCurrent;
            // Open first: a first-ever open seeds the range object setRange
            // mutates. Then zoom+pause+seek exactly like the ±N buttons, so the
            // clip window fills the timeline with the playhead on its start.
            openExportMode();
            setRange(ev.relSec - span, ev.relSec + span);
            applyEventSelection(ev, span);
            hideEventPopup();
            return;
        }
        const btn = target.closest<HTMLButtonElement>(".event-popup-btn");
        if (!btn || !eventPopupCurrent) return;
        const span = Number(btn.dataset.popSpan);
        if (!Number.isFinite(span) || span <= 0) return;
        applyEventSelection(eventPopupCurrent, span);
        hideEventPopup();
    });

    // NOTE: the hover hit-test for the event markers does NOT get its own
    // canvas mousemove listener - it is folded into the rAF-coalesced
    // processChartHover (see maybeShowEventPopupOnHover). A second raw-rate
    // listener here used to half-restore the per-event getBoundingClientRect
    // + marker scan cost the coalescing exists to remove.

    dom.chartCanvas.addEventListener("mouseleave", () => {
        if (eventPopupShowTimer) {
            clearTimeout(eventPopupShowTimer);
            eventPopupShowTimer = null;
        }
        if (eventPopupSticky) return;
        if (!eventPopupHideTimer) {
            eventPopupHideTimer = setTimeout(hideEventPopup, 300);
        }
    });

    // Click - sticky mode. Click on a marker keeps popup open until Esc / outside click.
    dom.chartCanvas.addEventListener(
        "click",
        (e) => {
            if (!state.active || !state.chart) return;
            const trip = state.trips[state.active.trip];
            if (!trip || trip.events.length === 0) return;
            const rect = dom.chartCanvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const xScale = state.chart.scales.x;
            if (!xScale) return;
            const top = state.chart.chartArea.top;
            if (cy > top + EVENT_HIT_PX * 2) return;
            const chartX = xScale.getValueForPixel(cx);
            const bestEv = chartX == null ? null : findVisibleEventNearX(trip, chartX);
            if (!bestEv) return;
            // Keep the enclosing chart-row click from seeking through the marker.
            e.stopImmediatePropagation();
            eventPopupSticky = true;
            const anchor = { x: rect.left + xScale.getPixelForValue(bestEv.relSec), y: rect.top + top };
            showEventPopup(bestEv, anchor);
        },
        true,
    ); // Capture phase precedes the enclosing chart-row seek handler.

    // Esc / outside-click close the sticky popup.
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && eventPopupSticky) hideEventPopup();
    });
    // "click", not "mousedown": click is synthesized on touch too, so the popup
    // dismisses on the next tap/scroll-start on a phone (mousedown is not reliably
    // produced for touch, leaving the sticky popup undismissable). Matches the
    // outside-dismiss convention used elsewhere (view-menu).
    document.addEventListener("click", (e) => {
        if (!eventPopupSticky) return;
        const t = e.target;
        if (!(t instanceof Node)) return;
        const el2 = document.querySelector<HTMLElement>("#event-popup");
        if (!el2) return;
        if (!el2.contains(t) && !dom.chartCanvas.contains(t)) {
            hideEventPopup();
        }
    });
}

/**
 * Zooms the chart around the event (±spanSec), pauses the player, and seeks to the
 * range start. Equivalent to a manual drag-zoom selection.
 */
function applyEventSelection(ev: TripEvent, spanSec: number): void {
    if (!state.active || !state.chart) return;
    const trip = state.trips[state.active.trip];
    if (!trip) return;
    const from = Math.max(0, ev.relSec - spanSec);
    const to = Math.min(trip.timeline.contentDurationSec, ev.relSec + spanSec);
    if (to <= from) return;

    // Same window-set + overlay re-anchor as a manual drag-zoom selection.
    // fullView epsilon (as in zoomTimelineToRange): a ±span window that covers
    // a short trip resets the zoom instead of leaving chartZoomed=true on a
    // de-facto full view, which would keep playback clamped for no reason.
    const fullView = from <= 1e-6 && to >= trip.timeline.contentDurationSec - 1e-6;
    applyChartXRange(from, to, fullView);
    // Zoom-to-event is inspection (look at the event and its surroundings), not a
    // bounded preview - playback follows the playhead through and past the window.
    state.isPreviewZoom = false;
    // applyChartXRange fires onSelectionChange only on the unzoomed->zoomed
    // transition; call it explicitly so the export tooltip refreshes even when
    // already zoomed (idempotent DOM sync, safe to double-fire on transition).
    callbacks.onSelectionChange?.();
    callbacks.onPause();
    callbacks.onSeekTripTime(from);
}

// --- Inferred event strip ---
//
// Variant B (52px bipolar longitudinal + turn + stop) lives in a separate
// module (src/ui/inferred-strip-canvas.ts). We hold a handle returned from
// initInferredStrip and call redraw() on chart events that change the visible
// x-range (zoom/pan/resize/theme). The strip is bound to the active trip via
// the getTrip closure registered at init time.

/** Single instance bound to the host canvas. Initialized in initChart after
 *  the Chart.js instance and dom.chartInferredStrip are ready. */
let inferredStripHandle: InferredStripHandle | null = null;

/** Toggles the strip wrap visibility and triggers a redraw. Called from
 *  rebuildChartFromTrip when a trip becomes active, from refreshThemeColors
 *  on theme switch, and from the chart zoom/pan/resize hooks. */
function redrawInferredStrip(): void {
    if (!inferredStripHandle) return;
    // Wrap visibility is driven by the "View" menu (localStorage panels.strip),
    // not by trip presence. Strip stays visible even with no trip / no signals
    // so layout does not shift trip-to-trip - canvas paints an empty state
    // (i18n "no recognized events" + dashed baseline) instead. Per design
    // 01-strip.md: "don't hide strip, layout shifts are bad".
    inferredStripHandle.redraw();
}

/** Maps trip-relative seconds to a CSS pixel offset inside the .player-chart
 *  wrap for the DOM overlays (playhead, hover cursor, flash). Goes through the
 *  shared timelineSecToFrac so it stays aligned with the progress bar + range
 *  overlay AND keeps working when the chart canvas is hidden (no plot area for
 *  getPixelForValue). Null before a trip is active. */
function relSecToPlayerChartCssX(relSec: number, view: TimelineView | null = getTimelineView()): number | null {
    const frac = view ? timelineSecToFracInView(relSec, view) : null;
    if (frac == null || !dom.playerChartEl) return null;
    return frac * dom.playerChartEl.clientWidth;
}

/** Updates the playhead overlay - one DOM element spanning chart
 *  canvas + ruler + strip. Called from player.ts on timeupdate. Cheap:
 *  CSS left only, no canvas redraw. */
const PLAYHEAD_VIEW_EDGE_EPSILON_SEC = 0.001;

export function setPlayerCursorRelSec(relSec: number | null, view: TimelineView | null = getTimelineView()): void {
    const el = dom.playerChartPlayhead;
    if (!el) return;
    if (relSec == null) {
        dom.playerChartEl.classList.remove("is-playhead-outside-view");
        el.hidden = true;
        return;
    }
    const frac = view ? timelineSecToFracInView(relSec, view) : null;
    if (frac == null) {
        dom.playerChartEl.classList.remove("is-playhead-outside-view");
        el.hidden = true;
        return;
    }
    const isOutsideView = Boolean(
        view &&
            (relSec < view.startSec - PLAYHEAD_VIEW_EDGE_EPSILON_SEC ||
                relSec > view.endSec + PLAYHEAD_VIEW_EDGE_EPSILON_SEC),
    );
    dom.playerChartEl.classList.toggle("is-playhead-outside-view", isOutsideView);
    // A percentage follows resizing without reading layout after text updates.
    el.style.left = `calc(${frac * 100}% - 1px)`;
    el.hidden = false;
}

/**
 * Minimum edge gutter of the timeline on touch devices, in CSS px. Two jobs:
 * keep the playhead/progress thumb/range tabs off the container edges, and -
 * the critical one - keep the export range pull-tabs (centered on the plot
 * edge) outside the OS edge-swipe zones: Android's back-gesture strip is
 * ~24dp by default (user-tunable up to ~40), iOS arms swipe-back at ~20-27pt.
 * No in-page CSS/JS can suppress those system gestures, so a layout inset is
 * the only reliable mitigation. Enforced as a minimum Y-axis width while the
 * chart canvas is visible (see enforceEdgeGutterAxisWidth) and synthesized in
 * getTimelineView when it is hidden.
 */
const TIMELINE_EDGE_GUTTER_TOUCH_PX = 28;
/** Fine-pointer gutter floor: just enough that the playhead, the 12px
 *  progress thumb and the 16px export pull-tabs (centered on the plot edge)
 *  do not clip against the container edges. Matters as an axis-width floor
 *  when a Y axis is hidden (accel-less trip hides yAccel - a display:false
 *  scale fits to width 0, putting the plot edge at the very container edge)
 *  and as the synthetic gutter when the whole canvas is hidden. */
const TIMELINE_EDGE_GUTTER_MOUSE_PX = 12;
/** Cap so the synthetic gutter never eats a meaningful share of a tiny host. */
const MAX_SYNTHETIC_GUTTER_FRAC = 0.1;

/**
 * afterFit for both Y axes: widen the axis to the pointer-appropriate edge
 * gutter (gesture-safe on touch, clip-safe on mouse). Going through the axis
 * width (not CSS padding or a frac override) keeps xScale.left/right the
 * single geometry truth, so the ruler, strip, playhead and range tabs all
 * follow via getTimelineView with no extra sync. Runs (and reserves width)
 * even for a display:false scale - that is what keeps the right gutter alive
 * when the accel axis is hidden.
 */
function enforceEdgeGutterAxisWidth(axis: { width: number }): void {
    const gutterPx = isCoarsePointer() ? TIMELINE_EDGE_GUTTER_TOUCH_PX : TIMELINE_EDGE_GUTTER_MOUSE_PX;
    axis.width = Math.max(axis.width, gutterPx);
}

/**
 * The current timeline window + horizontal gutter, the single source of truth
 * shared by every timeline row (chart, strip, ruler, the always-on progress
 * bar) and the range overlay so they all map trip-seconds to x consistently.
 *
 * - startSec/endSec: the visible window (chart zoom state, from scales.x). When
 *   not zoomed this is the whole trip. Survives the chart being hidden (it is
 *   the zoom state, not derived from pixels).
 * - leftFrac/rightFrac: the chart's plot-area gutter as a fraction of canvas
 *   width (Y-axis labels eat the edges). Rows align their content to this so
 *   the playhead lines up across all of them. When the chart canvas is hidden
 *   there is no plot area to align to - a small symmetric gutter is
 *   synthesized instead (see TIMELINE_EDGE_GUTTER_*), else the playhead and
 *   the range tabs ride into the very container edge.
 *
 * Returns null before a trip is active.
 */
export interface TimelineView {
    startSec: number;
    endSec: number;
    leftFrac: number;
    rightFrac: number;
}

export function getTimelineView(): TimelineView | null {
    if (!state.chart) return null;
    const trip = activeTrip();
    // Footage-time axis: the timeline spans the concatenated footage, pauses
    // removed (see TripTimeline). All sec values here are content-sec.
    if (!trip || trip.timeline.contentDurationSec <= 0) return null;
    const xScale = state.chart.scales.x;
    if (!xScale) return null;
    let startSec = Number(xScale.min);
    let endSec = Number(xScale.max);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
        startSec = 0;
        endSec = trip.timeline.contentDurationSec;
    }
    const canvasW = state.chart.width;
    const canvasVisible = !dom.chartCanvas?.hidden && canvasW > 0 && xScale.right > xScale.left;
    if (canvasVisible) {
        return { startSec, endSec, leftFrac: xScale.left / canvasW, rightFrac: (canvasW - xScale.right) / canvasW };
    }
    // Canvas hidden (no-GPS collapse or the View menu): synthesize the gutter
    // relative to the host row width - state.chart.width is stale for a
    // display:none canvas.
    const hostW = dom.playerChartEl?.clientWidth ?? 0;
    if (hostW <= 0) return { startSec, endSec, leftFrac: 0, rightFrac: 0 };
    const gutterPx = isCoarsePointer() ? TIMELINE_EDGE_GUTTER_TOUCH_PX : TIMELINE_EDGE_GUTTER_MOUSE_PX;
    const gutterFrac = Math.min(gutterPx / hostW, MAX_SYNTHETIC_GUTTER_FRAC);
    return { startSec, endSec, leftFrac: gutterFrac, rightFrac: gutterFrac };
}

/** Maps trip-relative seconds to a fraction [0,1] of the timeline host width
 *  using a captured geometry snapshot. Shared by the playhead, progress bar,
 *  markers and export range so each update reads mutable chart state once.
 *  Out-of-window values clamp to the nearest edge. */
export function timelineSecToFracInView(sec: number, view: TimelineView): number {
    const v = view;
    const span = v.endSec - v.startSec;
    const posFrac = span > 0 ? Math.max(0, Math.min(1, (sec - v.startSec) / span)) : 0;
    return v.leftFrac + posFrac * (1 - v.leftFrac - v.rightFrac);
}

/** Inverse mapping: a fraction [0,1] of the host width back to trip-seconds,
 *  clamped to the visible window. Used for click/drag seek and range-tab
 *  dragging. Null before a trip is active. */
export function timelineFracToSec(frac: number): number | null {
    const v = getTimelineView();
    if (!v) return null;
    const content = 1 - v.leftFrac - v.rightFrac;
    const posFrac = content > 0 ? Math.max(0, Math.min(1, (frac - v.leftFrac) / content)) : 0;
    return v.startSec + posFrac * (v.endSec - v.startSec);
}

/** Plays a single radial-pulse flash at the given trip-relative seconds.
 *  The element is inserted inside .player-chart so the pulse spans chart
 *  canvas + ruler + strip as one column (same idea as the playhead). One
 *  600ms keyframe, removed on animationend - no infinite loops. */
export function flashPlayerChartAtRelSec(relSec: number): void {
    const wrap = dom.playerChartEl;
    if (!wrap) return;
    const x = relSecToPlayerChartCssX(relSec);
    if (x == null) return;
    const flashEl = document.createElement("div");
    flashEl.className = "player-chart-flash";
    flashEl.style.left = `${x - 12}px`;
    wrap.appendChild(flashEl);
    flashEl.addEventListener("animationend", () => flashEl.remove(), { once: true });
    // Safety net for browsers that delay animationend on hidden tabs.
    setTimeout(() => flashEl.remove(), 800);
}

/** Updates the hover scrub overlay. Called from chart mousemove (and
 *  forwarded from strip mousemove via synthetic events). Pass null to hide
 *  (e.g. on mouseleave). */
export function setHoverCursorRelSec(relSec: number | null): void {
    const el = dom.playerChartHoverCursor;
    if (!el) return;
    if (relSec == null) {
        el.hidden = true;
        return;
    }
    const x = relSecToPlayerChartCssX(relSec);
    if (x == null) {
        el.hidden = true;
        return;
    }
    // transform, not left: pointer movement is not recent input for CLS, so a
    // left-driven move would count as a layout shift.
    el.style.transform = `translateX(${x - 0.5}px)`;
    el.hidden = false;
}

// i18n via data-i18n only handles km/h (the baseline string); when the
// user switches to imperial we override the textContent to "mph".
function syncSpeedAxisUnitLabel(): void {
    const el = document.querySelector<HTMLElement>(".chart-axis-label--speed");
    if (!el) return;
    const sample = formatSpeedFromMs(0);
    el.textContent = t(sample.unitKey);
}

export function rebuildChartFromTrip(trip: Trip): void {
    if (!state.chart) return;

    // Rebuilding telemetry restores the active trip's full range below.
    if (state.chartZoomed) {
        state.chartZoomed = false;
        state.isPreviewZoom = false;
        resetFollowTimelinePause();
        callbacks.onSelectionChange?.();
    }

    const speedData: Array<{ x: number; y: number }> = [];
    const estimatedIndices = new Set<number>();
    let previous: Trip["records"][number] | undefined;
    const accelData: Array<{ x: number; y: number }> = [];
    for (const r of trip.records) {
        // Project the wall-clock record onto the footage axis so pauses collapse
        // (a record during a pause snaps to the divider; everything else shifts
        // left by the preceding pauses).
        const x = wallToContentSec(trip.timeline, r.unixSeconds);
        // Speed scaled to the user's unit preference (km/h or mph); the Y-axis
        // overlay label is updated separately via syncSpeedAxisUnit().
        if (previous && !isSameTrackSegment(previous, r)) {
            speedData.push({ x: (wallToContentSec(trip.timeline, previous.unixSeconds) + x) / 2, y: Number.NaN });
        }
        if (r.speedSource === "estimated") estimatedIndices.add(speedData.length);
        speedData.push({ x, y: isValidGpsFix(r) && hasSpeed(r) ? formatSpeedFromMs(r.speedMs).value : Number.NaN });
        previous = r;
        accelData.push({ x, y: gMagnitude(r) });
    }
    state.chart.data.datasets[0]!.data = speedData;
    const speedDataset = state.chart.data.datasets[0]! as ChartDataset<"line", Array<{ x: number; y: number }>>;
    if (estimatedIndices.size) {
        // LTTB retains source point objects but changes their dataset indices.
        // Count estimates over the original span so a discarded short estimate
        // still marks the rendered segment that crosses it.
        const sourceIndices = new Map(speedData.map((point, index) => [point, index]));
        const estimatedCounts = new Uint32Array(speedData.length + 1);
        for (let i = 0; i < speedData.length; i++) {
            estimatedCounts[i + 1] = estimatedCounts[i]! + (estimatedIndices.has(i) ? 1 : 0);
        }
        speedDataset.segment = {
            borderDash: (context) => {
                const start = sourceIndices.get(speedDataset.data[context.p0DataIndex]!);
                const end = sourceIndices.get(speedDataset.data[context.p1DataIndex]!);
                return start !== undefined && end !== undefined && estimatedCounts[end + 1]! > estimatedCounts[start]!
                    ? [4, 3]
                    : [];
            },
        };
    } else {
        speedDataset.segment = undefined;
    }
    state.chart.data.datasets[1]!.data = accelData;
    // options.scales.x comes as ScaleOptions | undefined; we know it was configured in initChart.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xOpts = state.chart.options.scales!.x as any;
    xOpts.min = 0;
    xOpts.max = trip.timeline.contentDurationSec || 1;
    // GPS controls the speed axis; accelerometer-only recordings keep their own curve.
    const noGps = !speedData.some((point) => Number.isFinite(point.y));
    // A format without an accelerometer (e.g. GPS-only embedded tracks) yields
    // all-zero |G| - a flat line at 0 reads as "no G-force ever", so hide the
    // curve, its axis and the "g" unit overlay instead of charting zeros.
    const hasAccel = hasAccelData(trip.records);
    state.chart.data.datasets[1]!.hidden = !hasAccel;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ySpeedOpts = state.chart.options.scales!.ySpeed as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const yAccelOpts = state.chart.options.scales!.yAccel as any;
    ySpeedOpts.display = !noGps;
    yAccelOpts.display = hasAccel;
    const accelAxisLabel = document.querySelector<HTMLElement>(".chart-axis-label--accel");
    if (accelAxisLabel) accelAxisLabel.hidden = !hasAccel;
    state.chart.update("none");

    syncChartRulers();
    syncChartOverview();
    redrawInferredStrip();

    // Lifecycle: cursor/rulers reflect the new trip.
    emitLifecycle("chart-rendered", { speedPoints: speedData.length, accelPoints: accelData.length });
}

/**
 * Returns the current zoom range. Used by export-modal to populate trip + bounds.
 * Returns null when not zoomed or no active trip.
 */
export function getSelectedRange(): { trip: Trip; startTripSec: number; endTripSec: number } | null {
    if (!state.chartZoomed || !state.active || !state.chart) return null;
    const trip = state.trips[state.active.trip];
    if (!trip) return null;
    const xScale = state.chart.scales.x;
    if (!xScale) return null;
    // xScale is on the footage axis, so these are content-sec - the coordinate
    // system the whole export chain now consumes end to end.
    const startTripSec = Math.max(0, xScale.min);
    const endTripSec = Math.min(trip.timeline.contentDurationSec, xScale.max);
    if (endTripSec <= startTripSec) return null;
    return { trip, startTripSec, endTripSec };
}

/** Minimum on-screen band width (px). A short event clip in a long trip
 *  collapses to sub-pixel on the content axis; without a floor it would vanish. */
const MODE_BAND_MIN_PX = 2;

/** One contiguous non-normal recording-mode run, in content-seconds. */
interface ModeBand {
    startSec: number;
    endSec: number;
    mode: Exclude<RecordingMode, "normal">;
}

/**
 * Merges the trip's content-time segments into bands of contiguous non-normal
 * recording mode. Segments are laid back-to-back on the content axis
 * (buildTripTimeline), so same-mode neighbours extend one band and a
 * normal/unknown frame breaks the run. Returns [] when no frame is non-normal -
 * the all-normal fast path that keeps most trips visually unchanged.
 */
function computeModeBands(trip: Trip): ModeBand[] {
    const bands: ModeBand[] = [];
    let current: ModeBand | null = null;
    for (const seg of trip.timeline.segments) {
        const mode = frameRecordingMode(trip.frames[seg.frameIndex]!);
        if (mode == null || mode === "normal") {
            current = null;
            continue;
        }
        if (current && current.mode === mode) {
            current.endSec = seg.contentEnd; // extend the run
        } else {
            current = { startSec: seg.contentStart, endSec: seg.contentEnd, mode };
            bands.push(current);
        }
    }
    return bands;
}

/**
 * Draws low-alpha, full-plot-height bands behind everything else for each
 * contiguous non-normal recording-mode run (event / parking / manual). Runs in
 * the plugin's beforeDraw so it sits UNDER grid, curves, pause blocks, markers
 * and the DOM-overlay playhead / export mask. Uses the same content-sec -> x
 * mapping (xScale.getPixelForValue) and plot-area clip as the other layers, so
 * bands track zoom/pan/resize. Colors carry their own ~10% alpha from
 * themeColors(), so a theme switch (which repaints the chart) recolors them.
 * No-op for an all-normal trip - nothing is drawn, so those trips are unchanged.
 */
function drawModeBands(chart: Chart, c: CanvasRenderingContext2D): void {
    if (!state.active) return;
    const trip = state.trips[state.active.trip];
    if (!trip) return;
    const bands = computeModeBands(trip);
    if (bands.length === 0) return; // all-normal fast path: skip the layer entirely
    const xScale = chart.scales.x;
    if (!xScale) return;
    const { left, right, top, bottom } = chart.chartArea;
    const tc = themeColors();
    const colorFor: Record<ModeBand["mode"], string> = {
        event: tc.bandEvent,
        parking: tc.bandParking,
        manual: tc.bandManual,
    };
    c.save();
    // Clip to the plot rectangle like the other layers so a band never bleeds
    // into the Y-axis gutters, including after the min-width expansion below.
    c.beginPath();
    c.rect(left, top, right - left, bottom - top);
    c.clip();
    for (const band of bands) {
        let x0 = xScale.getPixelForValue(band.startSec);
        let x1 = xScale.getPixelForValue(band.endSec);
        if (x1 < left || x0 > right) continue; // fully outside the visible window
        if (x1 - x0 < MODE_BAND_MIN_PX) {
            const mid = (x0 + x1) / 2;
            x0 = mid - MODE_BAND_MIN_PX / 2;
            x1 = mid + MODE_BAND_MIN_PX / 2;
        }
        c.fillStyle = colorFor[band.mode];
        c.fillRect(x0, top, x1 - x0, bottom - top);
    }
    c.restore();
}

/**
 * Draws event markers above the chart data. Markers are filled circles color-coded by
 * event type, placed at chartArea.top + radius so they do not obscure the curves.
 * Events outside the visible x range (after drag-zoom) are clipped by the chartArea check.
 */
function drawEventMarkers(chart: Chart, c: CanvasRenderingContext2D): void {
    if (!state.active) return;
    const trip = state.trips[state.active.trip];
    if (!trip?.events.length) return;
    const xScale = chart.scales.x;
    if (!xScale) return;

    const top = chart.chartArea.top;
    const left = chart.chartArea.left;
    const right = chart.chartArea.right;
    const yLine = top + EVENT_MARKER_RADIUS_PX + 2;

    c.save();
    c.lineWidth = 1.5;
    // Stroke separates the marker from the background/curves (white on dark, dark on light).
    // Source: --dc-marker-stroke, invalidated on theme change.
    const tc = themeColors();
    c.strokeStyle = tc.markerStroke;
    const eventPalette = eventColors();
    for (const ev of trip.events) {
        const x = xScale.getPixelForValue(ev.relSec);
        if (x < left || x > right) continue;
        c.fillStyle = eventPalette[ev.kind];
        c.beginPath();
        c.arc(x, yLine, EVENT_MARKER_RADIUS_PX, 0, Math.PI * 2);
        c.fill();
        c.stroke();
    }
    c.restore();
}

/** Half-width (px) of the pause block; also the base hover hit-radius. */
const PAUSE_BLOCK_HALF_PX = 4;
/** Extra px around the block so the hover tooltip is easy to trigger. */
const PAUSE_HIT_PAD_PX = 3;

/**
 * Draws a recording-pause marker on the footage axis: a narrow neutral-gray
 * block centered on the join. Fixed width on purpose - the content axis collapses
 * the pause, so the block does not represent its real length (that lives in the
 * hover tooltip). Gray (not the orange accent) so it reads as "dead time", not an
 * event. The thin side edges keep the block legible over the speed curve fill.
 */
function drawPauseBlock(c: CanvasRenderingContext2D, x: number, top: number, bottom: number): void {
    const tc = themeColors();
    c.save();
    c.setLineDash([]);
    c.fillStyle = tc.chartTickText;
    c.globalAlpha = 0.28;
    c.fillRect(x - PAUSE_BLOCK_HALF_PX, top, PAUSE_BLOCK_HALF_PX * 2, bottom - top);
    c.globalAlpha = 0.55;
    c.lineWidth = 1;
    c.strokeStyle = tc.chartTickText;
    c.beginPath();
    c.moveTo(x - PAUSE_BLOCK_HALF_PX, top);
    c.lineTo(x - PAUSE_BLOCK_HALF_PX, bottom);
    c.moveTo(x + PAUSE_BLOCK_HALF_PX, top);
    c.lineTo(x + PAUSE_BLOCK_HALF_PX, bottom);
    c.stroke();
    c.restore();
}

/**
 * Finds the visible event nearest to the cursor's x-axis value (not pixels).
 * Returns null when the nearest event is farther than EVENT_HIT_PX pixels on screen.
 * Used in tooltip logic: hovering over a marker shows an event-type badge above the
 * normal record popup.
 */
function findVisibleEventNearX(trip: Trip, chartX: number): TripEvent | null {
    if (!state.chart || !trip?.events.length) return null;
    const xScale = state.chart.scales.x;
    if (!xScale) return null;
    const cursorPx = xScale.getPixelForValue(chartX);
    let best: TripEvent | null = null;
    let bestDistPx = Infinity;
    for (const ev of trip.events) {
        const evPx = xScale.getPixelForValue(ev.relSec);
        const d = Math.abs(evPx - cursorPx);
        if (d < bestDistPx) {
            bestDistPx = d;
            best = ev;
        }
    }
    return bestDistPx <= EVENT_HIT_PX ? best : null;
}

/**
 * Returns the pause gap whose block the cursor (pixel x) is over, or null. The
 * block is fixed-width, so the hit zone is a small pixel radius around the join -
 * not an axis-value range (the pause occupies no axis space).
 */
function pauseGapAtPx(trip: Trip, px: number): TripGap | null {
    if (!state.chart) return null;
    const xScale = state.chart.scales.x;
    if (!xScale) return null;
    const hit = PAUSE_BLOCK_HALF_PX + PAUSE_HIT_PAD_PX;
    for (const gap of trip.timeline.gaps) {
        if (Math.abs(xScale.getPixelForValue(gap.contentPos) - px) <= hit) return gap;
    }
    return null;
}

/**
 * Tooltip for a pause block: just "pause N min" (the duration the content axis
 * dropped). No record/thumb - a pause has no footage. Cancels any in-flight
 * thumb decode so a late frame cannot flash over the pause popover.
 */
function renderPauseTooltip(e: MouseEvent, gap: TripGap): void {
    updateChartTooltip(
        e,
        `p:${gap.contentPos}`,
        () => {
            const label = t("chart.pause", { duration: formatDuration(gap.durationSec) });
            return `<div class="track-popup"><div class="track-popup-title">${label}</div></div>`;
        },
        () => {
            // No preview for a pause - drop any pending/drawn thumb from a prior record.
            tooltipThumbToken++;
            cancelTooltipThumbIdleTimer();
            tooltipThumbLastKey = null;
            tooltipThumbDrawnKey = null;
            clearTooltipThumb();
        },
    );
}

/**
 * Renders the tooltip box in has-track mode. Called from processChartHover
 * (rAF-coalesced mousemove handler). Finds the nearest record (or event when
 * close to its marker) and builds the same HTML as the map popup.
 */
// Tooltip content cache. innerHTML rebuild is expensive (full DOM teardown +
// HTML parse); adjacent pixels over the same record (1 Hz GPS = ~10-50 px
// between points at typical zoom) must not retrigger it. Memoize on a content
// key - rebuild only when record/event/file changes. offsetWidth/Height cause
// forced reflow; cache dimensions between rebuilds and update only on key change.
let lastTooltipKey: string | null = null;
let lastTooltipW = 0;
let lastTooltipH = 0;

/**
 * Shared tooltip render skeleton for all three chart tooltips (pause / has-track
 * / no-gps). Ensures the element, memoizes innerHTML on `key` (rebuild + the
 * offsetWidth/Height reflow are the hot-path cost), runs the optional key-change
 * side-effect (thumb load or cancel) BEFORE measuring - it toggles the thumb
 * canvas/skeleton which changes the box size - then reveals and positions.
 * No-ops when the body element is missing.
 */
function updateChartTooltip(e: MouseEvent, key: string, buildBody: () => string, onKeyChange?: () => void): void {
    const el = ensureChartTooltipElement();
    const body = el.querySelector<HTMLDivElement>(".track-popup-body");
    if (!body) return;
    if (key !== lastTooltipKey) {
        lastTooltipKey = key;
        body.innerHTML = buildBody();
        onKeyChange?.();
        lastTooltipW = el.offsetWidth;
        lastTooltipH = el.offsetHeight;
    }
    el.style.opacity = "1";
    positionTooltip(el, e);
}

function renderHasTrackTooltip(e: MouseEvent, trip: Trip, x: number): void {
    // If cursor is near an event marker, show the event-type badge above the normal
    // popup. The popup is built from the event's record (peak for brake, midpoint for
    // turn, start for stop).
    const ev = findVisibleEventNearX(trip, x);
    let recIdx: number;
    if (ev) {
        recIdx = ev.recordIndex;
    } else {
        // x is a footage-axis position; map it back to wall-clock to find the
        // nearest record (records are indexed by unixSeconds).
        recIdx = findNearestIndex(trip.records, contentToWallUtc(trip.timeline, x));
        if (recIdx < 0) return;
    }
    const rec = trip.records[recIdx];
    if (!rec) return;

    // Unified scrub-thumb: when over an inferred-strip active range, surface
    // the kind chips + intensity in the same popover (no parallel tooltip).
    const inferred = inferredSegmentsAtRelSec(trip, x);
    const inferredKey = inferred.length ? inferred.map((s) => `${s.kind}:${s.startRelSec.toFixed(1)}`).join("|") : "";

    // Cache key includes inferred-event signature - moving from a clean
    // record to one with stop/brake/turn/accel coverage must rebuild HTML.
    const baseKey = ev ? `e:${ev.kind}:${ev.recordIndex}` : `r:${recIdx}`;
    const key = inferredKey ? `${baseKey}#${inferredKey}` : baseKey;
    updateChartTooltip(
        e,
        key,
        () => {
            const eventBadge = ev
                ? `<div class="track-popup-event ev-${ev.kind}">${eventLabel(ev.kind)} · ${formatEventSeverity(ev)}</div>`
                : "";
            const inferredChips = renderInferredEventChipsHtml(inferred);
            return eventBadge + inferredChips + buildRecordPopupHtml(rec, trip);
        },
        () => {
            // Lazy hover-thumb fetch - frame in the active channel at this time
            // (cached per 0.5 s bucket). Event time for events, cursor x otherwise.
            const relSec = ev ? wallToContentSec(trip.timeline, rec.unixSeconds) : x;
            loadTooltipThumb(trip, relSec);
        },
    );
}

/**
 * Positions the tooltip in viewport coords - right of the cursor, shifted
 * left/up when it would go off-screen. The element lives on body (see
 * ensureChartTooltipElement) to avoid clipping by .player-wrap overflow:hidden
 * and z-index conflicts with the map. It moves with transform, not left/top:
 * pointer movement is not recent input for CLS, so every left/top move would
 * count as a layout shift.
 *
 * Uses cached dimensions (lastTooltipW/H) valid until lastTooltipKey changes.
 * Without the cache every mouse move would call offsetWidth/Height = forced reflow.
 */
function positionTooltip(el: HTMLDivElement, e: MouseEvent): void {
    const offset = 12;
    const w = lastTooltipW || el.offsetWidth;
    const h = lastTooltipH || el.offsetHeight;
    let posX = e.clientX + offset;
    if (posX + w > window.innerWidth) posX = e.clientX - w - offset;
    let posY = e.clientY - h - offset;
    if (posY < 0) posY = e.clientY + offset;
    el.style.transform = `translate(${posX}px, ${posY}px)`;
}

/**
 * Tooltip for no-gps mode (empty datasets). Shows a reduced popup: relative time,
 * absolute time, and current MP4 filename (looked up by relSec against trip frame
 * bounds). Speed/G/coordinates are omitted - they simply do not exist without GPS.
 *
 * Memoized on (filename, rounded second) - content changes infrequently in no-gps mode.
 */
function renderNoGpsTooltip(e: MouseEvent, trip: Trip, relSec: number): void {
    const file = findFileForRelSec(trip, relSec);
    updateChartTooltip(
        e,
        `n:${file?.file.name ?? "-"}:${Math.round(relSec)}`,
        () => buildNoGpsTooltipHtml(relSec, trip, file),
        () => {
            // Show a preview even without GPS - a frame at the current time in the
            // active channel. No GPS, but MP4 is present; user wants a visual
            // reference just as much as in has-track mode.
            loadTooltipThumb(trip, relSec);
        },
    );
}

/**
 * Finds the trip file that contains the given relSec. Returns null when relSec is
 * outside all files (should not happen for valid values, but possible at drag edges).
 */
function findFileForRelSec(trip: Trip, relSec: number): VideoCandidate | null {
    // Primary candidate of the frame containing relSec (no-gps tooltip needs
    // only the display name). relSec is on the footage axis; contentToFrame
    // clamps a past-the-end value to the last frame, matching the old fallback.
    const at = contentToFrame(trip.timeline, relSec);
    return pickFrameChannel(trip.frames[at.index]!, mainChannel())?.candidate ?? null;
}

/**
 * HTML for the no-gps tooltip: relative time, absolute time, and filename.
 * Uses the same .track-popup class as the normal tooltip, minus speed/G/coord rows.
 */
function buildNoGpsTooltipHtml(relSec: number, trip: Trip, file: VideoCandidate | null): string {
    // relSec is footage-axis; map to wall-clock for the absolute timestamp.
    const absUtc = contentToWallUtc(trip.timeline, relSec);
    // Display clock (camera clock when known) - see displayClockDate contract.
    const titleStr = t("popup.title", {
        rel: formatTime(relSec),
        abs: formatDateTime(displayClockDate(absUtc, trip.cameraTzSec), { seconds: true }),
    });
    // Filename comes from the local FS - user may have renamed it to anything,
    // including HTML/JS injection. Escape before innerHTML.
    const fileStr = escapeHtml(file ? file.file.name : t("popup.placeholder"));
    return `
        <div class="track-popup">
            <div class="track-popup-title">${titleStr}</div>
            <div class="track-popup-row mono"><span class="track-popup-label">${t("popup.label.file")}</span><span>${fileStr}</span></div>
        </div>
    `;
}

/**
 * Lazily creates and returns the chart tooltip element.
 * Same .track-popup class as the map popup - one CSS for both.
 */
function ensureChartTooltipElement(): HTMLDivElement {
    if (state.chartTooltipEl) return state.chartTooltipEl;
    const el = document.createElement("div");
    el.className = "ez-chart-tooltip";
    el.style.opacity = "0";
    // Structure: stable thumb canvas (drawn async after frame fetch) + body div
    // (innerHTML rebuilt on hover-key change). Canvas is outside the innerHTML
    // namespace so it survives body rebuilds - otherwise we would re-decode the
    // frame on every mouse move over the same record.
    const thumb = document.createElement("canvas");
    thumb.className = "track-popup-thumb";
    // Physical canvas size in device pixels (DPR-scaled); CSS size is 200×112
    // (track-popup-thumb style). Without DPR scaling on retina (DPR=2) the
    // 200×112 canvas would stretch to 400×224 device pixels via bitmap upscale,
    // producing a blurry result. Downscaling from native source resolution gives
    // a crisp preview.
    const dpr = window.devicePixelRatio || 1;
    thumb.width = Math.round(TOOLTIP_THUMB_W * dpr);
    thumb.height = Math.round(TOOLTIP_THUMB_H * dpr);
    thumb.hidden = true;
    el.appendChild(thumb);
    // Skeleton placeholder: same box as the canvas, shimmer animation. Shown
    // while the cursor is idling on a new bucket before TOOLTIP_THUMB_IDLE_MS
    // elapses (and while extractFrameAt is in flight afterward). Avoids
    // firing the decoder on every bucket the cursor sweeps through and lets
    // the user see immediately that a preview is "on the way".
    const skel = document.createElement("div");
    skel.className = "track-popup-thumb-skeleton";
    skel.hidden = true;
    el.appendChild(skel);
    const body = document.createElement("div");
    body.className = "track-popup-body";
    el.appendChild(body);
    // Appended to body (not .player-chart) to avoid clipping by .player-wrap
    // overflow:hidden and z-index conflicts with the map. Positioned by
    // positionTooltip.
    document.body.appendChild(el);
    state.chartTooltipEl = el;
    return el;
}

// Hover thumbnail: on hover-key change (record or event) decode a frame asynchronously
// into the canvas. Size 200×112 (16:9). Aspect is handled by CSS object-fit so slight
// deviations from 16:9 (e.g. 4:3 on older cameras) do not break layout.
const TOOLTIP_THUMB_W = 200;
const TOOLTIP_THUMB_H = 112;
const TOOLTIP_THUMB_CACHE_MAX = 64;
// LRU cache of decoded ImageBitmaps. Key = file.name + time rounded to 0.5 s
// (1 Hz GPS at 30+ fps = ~15 frames per bucket; hovering over adjacent pixels
// of the same record must not trigger re-decode).
const tooltipThumbCache = new Map<string, ImageBitmap>();
// Race protection: increment before each fetch, compare in the resolve callback.
// If the key changed while waiting, discard the stale frame.
let tooltipThumbToken = 0;

function clearTooltipThumb(): void {
    if (!state.chartTooltipEl) return;
    const canvas = state.chartTooltipEl.querySelector<HTMLCanvasElement>(".track-popup-thumb");
    if (canvas) canvas.hidden = true;
    const skel = state.chartTooltipEl.querySelector<HTMLDivElement>(".track-popup-thumb-skeleton");
    if (skel) skel.hidden = true;
}

function showTooltipThumbSkeleton(): void {
    if (!state.chartTooltipEl) return;
    const canvas = state.chartTooltipEl.querySelector<HTMLCanvasElement>(".track-popup-thumb");
    if (canvas) canvas.hidden = true;
    const skel = state.chartTooltipEl.querySelector<HTMLDivElement>(".track-popup-thumb-skeleton");
    if (skel) skel.hidden = false;
}

function drawTooltipThumb(bitmap: ImageBitmap): void {
    if (!state.chartTooltipEl) return;
    const canvas = state.chartTooltipEl.querySelector<HTMLCanvasElement>(".track-popup-thumb");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const skel = state.chartTooltipEl.querySelector<HTMLDivElement>(".track-popup-thumb-skeleton");
    if (skel) skel.hidden = true;
    // Cover-fit: fill the 16:9 canvas without letterboxing. For source aspect != 16:9
    // (4:3, vertical, etc.) crop from center - this is a preview; full image available
    // by seeking the player.
    const sw = bitmap.width;
    const sh = bitmap.height;
    const dstAspect = TOOLTIP_THUMB_W / TOOLTIP_THUMB_H;
    const srcAspect = sw / sh;
    let sx = 0;
    let sy = 0;
    let cw = sw;
    let ch = sh;
    if (srcAspect > dstAspect) {
        cw = Math.round(sh * dstAspect);
        sx = Math.round((sw - cw) / 2);
    } else {
        ch = Math.round(sw / dstAspect);
        sy = Math.round((sh - ch) / 2);
    }
    // canvas.width/height are in physical pixels (DPR-scaled); browser compresses
    // to CSS size 200×112. Drawing to TOOLTIP_THUMB_W/H directly would leave
    // the canvas blurry on retina displays.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, sx, sy, cw, ch, 0, 0, canvas.width, canvas.height);
    canvas.hidden = false;
}

/**
 * Returns (file, localTime) for the given trip-relative relSec on the active channel.
 * Linear search over trip.frames is fine - trips typically have 5-50 frames.
 */
function locateFileAndLocalTime(trip: Trip, relSec: number): { file: File; localTime: number } | null {
    // A frame can start inside a longer file from another camera.
    const at = contentToFrame(trip.timeline, relSec);
    const frame = trip.frames[at.index]!;
    const picked = pickFrameChannel(frame, mainChannel());
    if (!picked) return null;
    return { file: picked.candidate.file, localTime: frameMediaOffset(frame, picked.channel) + at.offsetInFrame };
}

/**
 * Asynchronously fetches and draws a hover thumbnail into the tooltip canvas.
 * Cached by (file, roundedTime); hovering over adjacent pixels of the same record
 * reuses the bitmap. Race token ensures a stale fetch does not overwrite a newer thumb.
 *
 * Fire-and-forget; errors are logged inside extractFrameAt.
 */
// Idle-delay before kicking off extractFrameAt on a NEW bucket. Decoding a
// 4K HEVC/H.264 frame costs ~150-400 ms on warm hardware decoders, several
// times that on software decoders; firing extractFrameAt at every bucket the
// cursor sweeps over saturates the decoder pipeline and pegs the CPU on
// fast scrub. With this delay the user sees the cursor line + the textual
// fields immediately, a shimmering skeleton in the thumb slot, and the real
// frame only after the cursor settles. Cache hits stay instant.
const TOOLTIP_THUMB_IDLE_MS = 200;
let tooltipThumbIdleTimer: ReturnType<typeof setTimeout> | null = null;
// Pending fire callback for the idle timer. Captured here (not just inside
// setTimeout) so a ping from the mousemove handler can re-arm the timer
// without having to rebuild the closure - even when the hover stays inside
// the same GPS record and renderHasTrackTooltip's key-dedup skips
// loadTooltipThumb.
let tooltipThumbPendingFire: (() => void) | null = null;
// Key of the bucket the cursor is currently hovering on (kept in sync on every
// mousemove). Lets the idle-timer callback check that the user is still on
// the same bucket before firing the decoder.
let tooltipThumbLastKey: string | null = null;
// Key of the bucket whose real frame is currently drawn on the canvas. Used
// to short-circuit the mousemove handler: if the cursor stays in the same
// bucket as the drawn thumb, we skip the timer reset and DOM work entirely.
let tooltipThumbDrawnKey: string | null = null;

function cancelTooltipThumbIdleTimer(): void {
    if (tooltipThumbIdleTimer !== null) {
        clearTimeout(tooltipThumbIdleTimer);
        tooltipThumbIdleTimer = null;
    }
    tooltipThumbPendingFire = null;
}

/**
 * Resets the idle-timer to a fresh TOOLTIP_THUMB_IDLE_MS countdown using the
 * same pending fire callback. Called from the chart mousemove handler so the
 * countdown reflects PHYSICAL cursor stillness, not just bucket-stillness -
 * fast jitter inside a single bucket (or a single GPS record, which is the
 * dedup unit upstream) keeps pushing the decode further away.
 *
 * No-op if no decode is currently pending.
 */
function pingTooltipThumbIdleTimer(): void {
    if (tooltipThumbIdleTimer === null || tooltipThumbPendingFire === null) return;
    clearTimeout(tooltipThumbIdleTimer);
    tooltipThumbIdleTimer = setTimeout(tooltipThumbPendingFire, TOOLTIP_THUMB_IDLE_MS);
}

function loadTooltipThumb(trip: Trip, relSec: number): void {
    const located = locateFileAndLocalTime(trip, relSec);
    if (!located) {
        cancelTooltipThumbIdleTimer();
        tooltipThumbLastKey = null;
        tooltipThumbDrawnKey = null;
        clearTooltipThumb();
        return;
    }
    const { file, localTime } = located;
    // 0.5 s bucket: hover within 500 ms of the same record reuses the frame.
    const bucket = Math.round(localTime * 2) / 2;
    const cacheKey = `${file.name}@${bucket}`;

    // Fast path: the real frame for this bucket is already on screen. Any
    // mousemove that stays inside the same bucket lands here. No timer
    // restart, no DOM work.
    if (cacheKey === tooltipThumbDrawnKey) return;

    const cached = tooltipThumbCache.get(cacheKey);
    if (cached) {
        // Cache hit (either cold cache from a previous hover or strip-side
        // pre-populate). Promote to MRU and draw - no delay.
        cancelTooltipThumbIdleTimer();
        tooltipThumbCache.delete(cacheKey);
        tooltipThumbCache.set(cacheKey, cached);
        tooltipThumbLastKey = cacheKey;
        drawTooltipThumb(cached);
        tooltipThumbDrawnKey = cacheKey;
        return;
    }

    // Cache miss. Show shimmer (idempotent) and arm the idle timer. The
    // mousemove handler upstream calls pingTooltipThumbIdleTimer on every
    // event - that ping re-arms the timer with this exact fire callback,
    // so the decode happens only after the cursor is physically still for
    // TOOLTIP_THUMB_IDLE_MS, not just bucket-still or record-still.
    tooltipThumbLastKey = cacheKey;
    tooltipThumbDrawnKey = null;
    showTooltipThumbSkeleton();
    cancelTooltipThumbIdleTimer();
    const myToken = ++tooltipThumbToken;
    const fire = (): void => {
        tooltipThumbIdleTimer = null;
        tooltipThumbPendingFire = null;
        // The bucket may have changed via mouseleave or a swift hover after
        // the timer was scheduled - bail in that case.
        if (tooltipThumbLastKey !== cacheKey) return;
        // Cache may have been filled by another caller in the meantime.
        const lateCached = tooltipThumbCache.get(cacheKey);
        if (lateCached) {
            tooltipThumbCache.delete(cacheKey);
            tooltipThumbCache.set(cacheKey, lateCached);
            drawTooltipThumb(lateCached);
            tooltipThumbDrawnKey = cacheKey;
            return;
        }
        extractFrameAt(file, bucket).then((bm) => {
            if (!bm) return;
            if (myToken !== tooltipThumbToken || tooltipThumbLastKey !== cacheKey) {
                // User moved off this record; close the bitmap to release the GPU
                // buffer (mediabunny warns about leaks).
                bm.close();
                return;
            }
            tooltipThumbCache.set(cacheKey, bm);
            while (tooltipThumbCache.size > TOOLTIP_THUMB_CACHE_MAX) {
                const oldest = tooltipThumbCache.keys().next().value;
                if (!oldest) break;
                const evicted = tooltipThumbCache.get(oldest);
                tooltipThumbCache.delete(oldest);
                evicted?.close();
            }
            drawTooltipThumb(bm);
            tooltipThumbDrawnKey = cacheKey;
        });
    };
    tooltipThumbPendingFire = fire;
    tooltipThumbIdleTimer = setTimeout(fire, TOOLTIP_THUMB_IDLE_MS);
}

/**
 * Clears the hover-thumb cache. Call on trip change - cached bitmaps from
 * the previous trip hold GPU memory unnecessarily.
 */
export function disposeChartHoverThumbs(): void {
    for (const bm of tooltipThumbCache.values()) {
        bm.close();
    }
    tooltipThumbCache.clear();
    tooltipThumbToken++;
    cancelTooltipThumbIdleTimer();
    tooltipThumbLastKey = null;
    tooltipThumbDrawnKey = null;
    clearTooltipThumb();
    // Trip change: drop the old-trip ruler and navigator state until the new
    // trip's chart has rendered.
    clearChartRulers();
    hideChartZoomNavigation();
}

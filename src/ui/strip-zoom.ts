// Pure math for wheel-zoom and wheel-pan over the trip time axis.
// Used by both the export slider (selection range) and the main player chart (zoom view).
// Also owns wheel-event normalization and zoom sensitivity, which the video
// digital zoom shares so a wheel gesture zooms alike on both surfaces.
//
// Zoom-view state is {viewStartPct, viewEndPct} in [0, 1] where 1 = trip.durationSec.
// All functions are stateless: they take the current state + event and return the new state.

/** Wheel zoom sensitivity: change of the zoom's natural log per normalized
 *  wheel pixel. One classic wheel notch (100 px in Chromium on Windows) is
 *  about a 16% zoom step. */
const WHEEL_ZOOM_LOG_PER_PX = 0.0015;

/** Chromium delivers a trackpad pinch as a ctrl+wheel event with
 *  deltaY = -100 * ln(scale) (components/input/touchpad_pinch_event_queue.cc),
 *  so this rate makes the zoom follow the fingers 1:1. */
const PINCH_WHEEL_LOG_PER_PX = 0.01;

/** Largest zoom change a single wheel event may make (natural log): one
 *  classic notch, x1.15. Bounds accelerated, page-mode and ctrl+mouse-wheel
 *  deltas without slowing the classic notch. */
const MAX_WHEEL_ZOOM_LOG_PER_EVENT = Math.log(1.15);

/**
 * Scale multiplier for one wheel event over a zoomable surface; above 1 zooms
 * in. deltaYPx is the vertical delta after normalizeWheelDelta (negative =
 * wheel up = zoom in). isCtrlWheel marks a ctrl+wheel event, which is how
 * Chromium reports a trackpad pinch.
 *
 * The change is proportional to the delta. High-resolution and free-spinning
 * wheels and trackpad momentum send dozens of small events per notch or
 * swipe; a fixed step per event would jump across the whole zoom range in a
 * fraction of a second. Each event is capped at one classic notch. Returns 1
 * for a zero or non-finite delta.
 */
export function wheelZoomScaleFactor(deltaYPx: number, isCtrlWheel: boolean): number {
    if (!Number.isFinite(deltaYPx) || deltaYPx === 0) return 1;
    const rate = isCtrlWheel ? PINCH_WHEEL_LOG_PER_PX : WHEEL_ZOOM_LOG_PER_PX;
    const logChange = Math.max(-MAX_WHEEL_ZOOM_LOG_PER_EVENT, Math.min(MAX_WHEEL_ZOOM_LOG_PER_EVENT, -deltaYPx * rate));
    return Math.exp(logChange);
}

/** Absolute minimum viewport width as a fraction of the trip (~22 s on a 6 h trip). */
const MIN_VIEW_WIDTH = 0.001;

/** Minimum viewport span accounting for trip duration. On short trips 0.001 of duration is less than 1 s, which is the finest useful zoom. */
export function computeMinViewSpan(durationSec: number): number {
    if (durationSec <= 0) return MIN_VIEW_WIDTH;
    const oneSecPct = 1 / durationSec;
    return Math.max(MIN_VIEW_WIDTH, Math.min(0.5, oneSecPct));
}

/** Returns the zoom floor for a gesture that starts from `initialSpan`.
 *  Programmatic views such as a one-second export preview may legitimately be
 *  narrower than the normal navigation floor on a long trip. Preserve that
 *  starting span instead of making the first outward gesture jump to the
 *  normal floor; the gesture still cannot make the view any narrower. */
export function computeEffectiveMinViewSpan(durationSec: number, initialSpan: number): number {
    const normalMin = computeMinViewSpan(durationSec);
    if (!Number.isFinite(initialSpan) || initialSpan <= 0) return normalMin;
    return Math.min(normalMin, Math.min(1, initialSpan));
}

/** Nice tick intervals in seconds: 1, 2, 5, 10, 15, 30 s, then 1, 2, 5, 10, 15, 30, 60, 120, 240 min. */
const RULER_NICE_INTERVALS_SEC = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];

/** Picks a tick interval targeting non-overlapping labels on the visible
 *  range. Each label ~"0:00 | 17:00:00" - ~95-110 CSS px. If the host
 *  container is narrow (on a mobile chart-canvas ~340 px), 7 labels = a label
 *  per ~48 px = merging. The optional containerWidthPx narrows the target down
 *  to what fits without overlap. If not provided - fallback 7 (legacy).
 *  Returns a value in seconds from RULER_NICE_INTERVALS_SEC. */
const LABEL_MIN_WIDTH_PX = 110;
export function pickRulerInterval(visibleDurSec: number, containerWidthPx?: number): number {
    const labelCount =
        containerWidthPx !== undefined && containerWidthPx > 0
            ? Math.max(2, Math.floor(containerWidthPx / LABEL_MIN_WIDTH_PX))
            : 7;
    const target = visibleDurSec / labelCount;
    for (const i of RULER_NICE_INTERVALS_SEC) if (i >= target) return i;
    const last = RULER_NICE_INTERVALS_SEC[RULER_NICE_INTERVALS_SEC.length - 1];
    if (last === undefined) throw new Error("RULER_NICE_INTERVALS_SEC empty");
    return last;
}

export interface ZoomViewState {
    viewStartPct: number;
    viewEndPct: number;
}

/** Moves one viewport boundary while keeping the opposite boundary fixed.
 *  The result stays inside the trip and never becomes narrower than the
 *  captured gesture floor. The default is the normal duration-aware floor;
 *  callers can preserve a narrower programmatic view by passing its start span. */
export function resizeZoomViewEdge(
    view: ZoomViewState,
    edge: "start" | "end",
    edgePct: number,
    durationSec: number,
    gestureMinSpan = computeMinViewSpan(durationSec),
): ZoomViewState {
    const minSpan = computeEffectiveMinViewSpan(durationSec, gestureMinSpan);
    const start = Math.max(0, Math.min(1, view.viewStartPct));
    const end = Math.max(start, Math.min(1, view.viewEndPct));
    if (edge === "start") {
        return {
            viewStartPct: Math.max(0, Math.min(edgePct, end - minSpan)),
            viewEndPct: end,
        };
    }
    return {
        viewStartPct: start,
        viewEndPct: Math.min(1, Math.max(edgePct, start + minSpan)),
    };
}

/**
 * Applies zoom around the cursor. dy < 0 = zoom in (scroll up), dy > 0 = zoom out.
 * cursorRatio in [0, 1] is the cursor's position within the slider (0 = left edge, 1 = right).
 * After zoom the cursor's trip position stays at the same slider fraction.
 *
 * Returns null when zoom is not applicable (already at full overview or minimum span),
 * allowing the caller to not consume the wheel event and let the page scroll.
 */
export function applyWheelZoom(
    view: ZoomViewState,
    cursorRatio: number,
    deltaY: number,
    durationSec: number,
): ZoomViewState | null {
    const viewSpan = view.viewEndPct - view.viewStartPct;
    const normalMinSpan = computeMinViewSpan(durationSec);
    const minSpan = computeEffectiveMinViewSpan(durationSec, viewSpan);
    const wantsZoomIn = deltaY < 0;
    const wantsZoomOut = deltaY > 0;
    if (wantsZoomOut && viewSpan >= 1 - 1e-6) return null;
    if (wantsZoomIn && viewSpan <= normalMinSpan * (1 + 1e-3)) return null;

    const cursorTripPct = view.viewStartPct + cursorRatio * viewSpan;
    const zoomFactor = Math.exp(deltaY * WHEEL_ZOOM_LOG_PER_PX);
    let newSpan = viewSpan * zoomFactor;
    newSpan = Math.max(minSpan, Math.min(1, newSpan));
    let newStart = cursorTripPct - cursorRatio * newSpan;
    let newEnd = newStart + newSpan;
    if (newStart < 0) {
        newStart = 0;
        newEnd = newSpan;
    }
    if (newEnd > 1) {
        newEnd = 1;
        newStart = 1 - newSpan;
    }
    return { viewStartPct: newStart, viewEndPct: newEnd };
}

/**
 * Touch pinch zoom over the time axis - the gesture counterpart of applyWheelZoom
 * (what the desktop vertical wheel does, two fingers do on a phone). Keeps the
 * content point that sat under the gesture-start centroid pinned under the moving
 * centroid at the new span, so the gesture zooms AND pans in one motion - the same
 * anchor model as the video pinch in player-zoom.ts.
 *
 * distRatio = currentFingerDistance / startFingerDistance (>1 = fingers spread =
 * zoom in). startCentroidRatio / currentCentroidRatio are the two-finger centroid's
 * position within the slider [0, 1] at gesture start and now. startView is the
 * visible window captured when the pinch began. Always returns a clamped window;
 * the caller decides whether it actually changed (e.g. to detect full overview).
 */
export function applyPinchZoom(
    startView: ZoomViewState,
    startCentroidRatio: number,
    currentCentroidRatio: number,
    distRatio: number,
    durationSec: number,
): ZoomViewState {
    const startSpan = startView.viewEndPct - startView.viewStartPct;
    const minSpan = computeEffectiveMinViewSpan(durationSec, startSpan);
    // Trip fraction under the centroid when the gesture started - the anchor we
    // keep under the finger centroid as it moves.
    const contentPct = startView.viewStartPct + startCentroidRatio * startSpan;
    let newSpan = startSpan / Math.max(distRatio, 1e-6);
    newSpan = Math.max(minSpan, Math.min(1, newSpan));
    let newStart = contentPct - currentCentroidRatio * newSpan;
    let newEnd = newStart + newSpan;
    if (newStart < 0) {
        newStart = 0;
        newEnd = newSpan;
    }
    if (newEnd > 1) {
        newEnd = 1;
        newStart = 1 - newSpan;
    }
    return { viewStartPct: newStart, viewEndPct: newEnd };
}

/**
 * Applies horizontal pan: shifts the view window right by deltaPx (positive deltaPx moves content left, like scroll).
 * sliderWidth is the current visual width of the slider in pixels.
 * Returns null when pan is not needed (full overview - nothing to shift).
 */
export function applyWheelPan(view: ZoomViewState, deltaPx: number, sliderWidth: number): ZoomViewState | null {
    const viewSpan = view.viewEndPct - view.viewStartPct;
    if (viewSpan >= 1 - 1e-6) return null;
    if (sliderWidth <= 0) return null;
    const deltaPct = (deltaPx / sliderWidth) * viewSpan;
    let newStart = view.viewStartPct + deltaPct;
    let newEnd = view.viewEndPct + deltaPct;
    if (newStart < 0) {
        newStart = 0;
        newEnd = viewSpan;
    }
    if (newEnd > 1) {
        newEnd = 1;
        newStart = 1 - viewSpan;
    }
    return { viewStartPct: newStart, viewEndPct: newEnd };
}

/** Fraction of the visible window past which a playing playhead triggers a
 *  follow-pan. Leaves a lookahead margin (1 - 0.85) of window still visible
 *  ahead of the playhead at the moment the pan fires. */
const FOLLOW_TRIGGER_RATIO = 0.85;
/** Where the playhead is re-seated inside the window after a follow-pan
 *  (fraction from the leading edge) - a small back-context margin. */
const FOLLOW_ANCHOR_RATIO = 0.15;

/**
 * Follow-pan math for a zoomed timeline window during playback. Given the visible
 * window ({viewStartPct, viewEndPct} in [0, 1]) and the playhead position
 * (playheadPct in [0, 1]), returns a new viewStartPct that re-seats the playhead
 * at FOLLOW_ANCHOR_RATIO once it crosses FOLLOW_TRIGGER_RATIO of the window (or
 * falls left of the window after a backward seek), clamped so the window never
 * leaves [0, 1]. Returns null when no pan is needed - the playhead sits
 * comfortably inside, the view is not zoomed, or the clamp leaves the window
 * where it already is (e.g. riding the trip end). Same span in, same span out.
 */
export function computeFollowPan(viewStartPct: number, viewEndPct: number, playheadPct: number): number | null {
    const span = viewEndPct - viewStartPct;
    // span >= 1 means full overview (not zoomed): there is nothing to follow.
    if (span <= 0 || span >= 1 - 1e-6) return null;
    const rel = (playheadPct - viewStartPct) / span;
    // rel < 0: playhead left the window on the left (backward seek) - recenter.
    if (rel < FOLLOW_TRIGGER_RATIO && rel >= 0) return null;
    let newStart = playheadPct - FOLLOW_ANCHOR_RATIO * span;
    newStart = Math.max(0, Math.min(newStart, 1 - span));
    // Clamp pinned the window (e.g. trip end): re-applying the same range only
    // churns a repaint, so signal "no pan".
    if (Math.abs(newStart - viewStartPct) < 1e-6) return null;
    return newStart;
}

/** Normalizes WheelEvent.delta to pixels: deltaMode differs across browsers/devices (0 = pixel, 1 = line ~16px, 2 = page ~800px). Without this, pan/zoom speed is unpredictable. */
export function normalizeWheelDelta(e: WheelEvent): { dx: number; dy: number } {
    const norm = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 800 : 1;
    return { dx: e.deltaX * norm, dy: e.deltaY * norm };
}

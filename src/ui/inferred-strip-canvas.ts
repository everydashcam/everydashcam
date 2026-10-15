// Inferred events strip.
//
// 52px-tall canvas under the chart with three rows:
//   - longitudinal (brake DOWN red + accel UP green sharing centerline y=16)
//   - turn (bars grow UP from y=43, 13px max)
//   - stop ribbon (y=46, 4px fixed)
//
// Intensity in [0..1] encodes bar HEIGHT (not opacity). Mild events
// (< 0.4) also get an alpha falloff via 0.55 + intensity * 1.1.
//
// Bars are placed in time via chart.scales.x.getPixelForValue so the strip
// stays in sync with chart.js zoom and pan. Event-by-event rendering (not
// winner-pixel) preserves per-segment intensity and rounded corners - we
// expect O(hundreds) segments per typical trip, well below any perf budget.
//
// DOM overlays inside the strip wrap:
//   - .inferred-strip__overlap (one per brake+turn coincidence): orange
//     5x5 rotated diamond. Single overlay type living here.
//
// Playhead / hover-scrub / click-flash overlays are NOT in this module:
// they live on the .player-chart wrapper level (see chart.ts
// setPlayerCursorRelSec / setHoverCursorRelSec / flashPlayerChartAtRelSec)
// and span chart + ruler + strip as one vertical cursor.
//
// Redraws on chart zoom/pan/resize/theme. Click → onSeek; click flash
// is delegated through opts.onFlash to the host (chart.ts).

import type { Chart } from "chart.js";

import { escapeHtml } from "../escape.js";
import { t } from "../i18n/index.js";
import type { Trip } from "../trips.js";

import { formatTime } from "./format.js";
import { themeColors } from "./theme.js";

import type { InferredSegment } from "../inferred-events.js";

// --- Geometry (CSS px; canvas backing store at DPR) ---
const STRIP_H = 52;
const LONG_ROW_CENTERLINE_Y = 16; // brake hangs DOWN from here, accel rises UP
const LONG_BAR_MAX_H = 11;
const DIVIDER_Y = 28;
const TURN_ROW_BOTTOM_Y = 43; // turn bars grow UP from here
const TURN_BAR_MAX_H = 13;
const STOP_RIBBON_Y = 46;
const STOP_RIBBON_H = 4;
// Corner radius on bar caps. Applied to all 4 corners across every kind;
// fillRoundRect caps it at min(w,h)/2 internally, so short events render
// as pill/oval and tall ones keep flat sides with rounded ends ("sausage").
// Bar max heights are 11-13px (long/turn) and 4px (stop) - radius 3 gives
// a clear capsule shape without over-rounding into pure circles.
const BAR_RADIUS_CSS = 3;

// --- Rendering constants ---
const EV_MIN_BAR_W_CSS = 2; // minimum visible width in CSS px
const EV_MIN_BAR_H = 2; // mild events keep at least 2px tall
const MILD_THRESHOLD = 0.4; // < this -> desaturate via alpha ramp
const STOP_ALPHA_BASE = 0.35;
const STOP_ALPHA_SPAN = 0.55;

/** Hit-test intensity threshold - "hard" events (>= 0.6) trigger enriched
 *  tooltip in the unified scrub-thumb (kind chip + metadata bar). */
export const HARD_INTENSITY = 0.6;

/** Overlap-marker activation: both brake and turn must clear this within
 *  the OVERLAP_TIME_WINDOW. */
const OVERLAP_INTENSITY = 0.4;
const OVERLAP_TIME_WINDOW_SEC = 1;

/** Returns segments active at the given trip-relative time. Exported so the
 *  unified chart tooltip can enrich its body with event chips when hovering
 *  over a strip-active range. Linear scan is fine - typical trip < ~200 segments. */
export function inferredSegmentsAtRelSec(trip: Trip, relSec: number): InferredSegment[] {
    const out: InferredSegment[] = [];
    for (const seg of trip.inferredSegments) {
        if (seg.startRelSec <= relSec && seg.endRelSec >= relSec) out.push(seg);
    }
    return out;
}

export interface InferredStripOptions {
    /** Canvas element to draw bars onto. Sized from its CSS bounding box. */
    canvas: HTMLCanvasElement;
    /** Wrap element (position: relative). Hosts DOM overlays for playhead /
     *  scrub-line / overlap diamonds / click flash. */
    wrap: HTMLElement;
    /** Chart.js instance - read for scales.x.getPixelForValue. */
    chart: Chart;
    /** Returns the currently active trip (null when nothing loaded). */
    getTrip: () => Trip | null;
    /** Called when the user clicks on the strip - seconds relative to trip start. */
    onSeek: (relSec: number) => void;
    /** Optional: plays a visual flash at the given trip-relative seconds.
     *  Strip module is decoupled from the chart-spanning flash overlay -
     *  the host (chart.ts) hands in flashPlayerChartAtRelSec so the pulse
     *  spans chart + ruler + strip as one column. */
    onFlash?: (relSec: number) => void;
}

export interface InferredStripHandle {
    /** Forces a full redraw with the current trip / chart scale. */
    redraw(): void;
    /** Tears down observers and listeners. Safe to call multiple times. */
    dispose(): void;
}

/**
 * Creates an inferred-event strip bound to an HTML canvas and a Chart.js
 * instance. The strip auto-redraws on canvas resize via ResizeObserver -
 * the caller is responsible for triggering `redraw()` on chart zoom/pan,
 * theme change, and trip/data change (the chart and trip aren't reactive).
 */
export function initInferredStrip(opts: InferredStripOptions): InferredStripHandle {
    let disposed = false;

    // Playhead + hover-scrub are unified across chart + ruler + strip (see
    // setPlayerCursorRelSec / setHoverCursorRelSec in chart.ts) - this
    // module no longer maintains its own vertical lines.
    //
    // Overlap markers are pooled - we recreate the set on each redraw because
    // events array does not mutate at a high frequency.
    const overlapPool: HTMLDivElement[] = [];

    function clearOverlapPool(): void {
        for (const el of overlapPool) el.remove();
        overlapPool.length = 0;
    }

    /** CSS-px offset of the canvas left edge inside the wrap. Wrap has
     *  inline padding-left applied by syncChartRulers (so the canvas sits
     *  under the chartArea); DOM overlays positioned absolute within wrap
     *  must add this offset to align with bars. */
    function canvasOffsetInWrap(): number {
        return opts.canvas.getBoundingClientRect().left - opts.wrap.getBoundingClientRect().left;
    }

    function redraw(): void {
        if (disposed) return;
        const trip = opts.getTrip();
        const canvas = opts.canvas;
        const segments = trip?.inferredSegments ?? [];

        // DPR setup. Backing store at cssW*dpr; we draw in CSS coords via setTransform.
        const cssRect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const cssW = cssRect.width || 0;
        if (cssW <= 0) return;
        const targetW = Math.max(1, Math.round(cssW * dpr));
        const targetH = Math.max(1, Math.round(STRIP_H * dpr));
        if (canvas.width !== targetW) canvas.width = targetW;
        if (canvas.height !== targetH) canvas.height = targetH;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, STRIP_H);

        const colors = themeColors();

        // Hairline dividers (centerline + long/turn boundary). 1px in CSS.
        const dividerAlpha = "1a"; // ~10% on hex - subtle, like the JSX divider
        ctx.fillStyle = `${colors.chartGrid}${dividerAlpha}`;
        ctx.fillRect(0, LONG_ROW_CENTERLINE_Y, cssW, 1);
        ctx.fillRect(0, DIVIDER_Y, cssW, 1);

        clearOverlapPool();

        if (!trip || segments.length === 0) {
            drawEmptyState(ctx, cssW, colors.chartTickText);
            return;
        }

        // Convert relSec -> CSS pixel via chart x-scale.
        const xScale = opts.chart.scales.x;
        const xMin = xScale ? Number(xScale.min) : 0;
        const xMax = xScale ? Number(xScale.max) : trip.timeline.contentDurationSec;
        const valRange = xMax - xMin;
        if (valRange <= 0) return;
        const relToPx = (relSec: number): number => ((relSec - xMin) / valRange) * cssW;

        // Event-by-event draw. Each segment keeps its own intensity-driven
        // height and alpha, plus rounded caps on the bar ends. Order matches
        // the JSX reference (brake -> accel -> turn -> stop) so visual stacking
        // is deterministic when bars touch.
        drawSegments(ctx, segments, relToPx, cssW, colors);

        // Overlap markers (brake + turn coincident within OVERLAP_TIME_WINDOW).
        // DOM elements - cheaper than canvas paths for ~handful per trip.
        //
        // On mobile (<=767px) hide the overlap markers - a 5x5 diamond at
        // the very top edge of the 52px strip is unreadable under a finger,
        // see spec/05-mobile.md "What's disabled on mobile". matchMedia with
        // no listener: redraw fires on the chart canvas ResizeObserver on
        // window rotate/resize - the overlap decision is recomputed then too.
        if (window.matchMedia("(max-width: 767px)").matches) return;
        const brakes = segments.filter((s) => s.kind === "brake" && s.intensity >= OVERLAP_INTENSITY);
        // Hoist canvas-in-wrap offset out of the loop: each call does two
        // getBoundingClientRect() reads (forced layout). Offset is the same
        // for every diamond drawn this frame.
        const offsetInWrap = canvasOffsetInWrap();
        for (const b of brakes) {
            const t2 = segments.find(
                (s) =>
                    s.kind === "turn" &&
                    s.intensity >= OVERLAP_INTENSITY &&
                    s.startRelSec < b.endRelSec + OVERLAP_TIME_WINDOW_SEC &&
                    s.endRelSec > b.startRelSec - OVERLAP_TIME_WINDOW_SEC,
            );
            if (!t2) continue;
            const midRel = (b.startRelSec + b.endRelSec) / 2;
            const midCss = relToPx(midRel);
            if (midCss < 0 || midCss > cssW) continue;
            const diamond = document.createElement("div");
            diamond.className = "inferred-strip__overlap";
            // Position inside the wrap, offset by canvas-in-wrap so the
            // diamond aligns with the bar columns, not the padding gutter.
            diamond.style.left = `${offsetInWrap + midCss - 2.5}px`;
            opts.wrap.appendChild(diamond);
            overlapPool.push(diamond);
        }
    }

    function drawSegments(
        ctx: CanvasRenderingContext2D,
        segments: InferredSegment[],
        relToPx: (rel: number) => number,
        cssW: number,
        colors: ReturnType<typeof themeColors>,
    ): void {
        // Draw order matches the JSX reference. Within each kind iteration is
        // event-by-event (no aggregation) - intensity drives height per segment.
        for (const kind of ["brake", "accel", "turn", "stop"] as const) {
            ctx.fillStyle = kindColor(kind, colors);
            for (const seg of segments) {
                if (seg.kind !== kind) continue;
                const x0 = relToPx(seg.startRelSec);
                const x1 = relToPx(seg.endRelSec);
                if (x1 < 0 || x0 > cssW) continue;
                const visX0 = Math.max(0, x0);
                const visX1 = Math.min(cssW, x1);
                const w = Math.max(EV_MIN_BAR_W_CSS, visX1 - visX0);
                const alpha = barAlpha(kind, seg.intensity);
                ctx.globalAlpha = alpha;
                const r = BAR_RADIUS_CSS;
                if (kind === "brake") {
                    const h = Math.max(EV_MIN_BAR_H, seg.intensity * LONG_BAR_MAX_H);
                    fillRoundRect(ctx, visX0, LONG_ROW_CENTERLINE_Y, w, h, [r, r, r, r]);
                } else if (kind === "accel") {
                    const h = Math.max(EV_MIN_BAR_H, seg.intensity * LONG_BAR_MAX_H);
                    fillRoundRect(ctx, visX0, LONG_ROW_CENTERLINE_Y - h, w, h, [r, r, r, r]);
                } else if (kind === "turn") {
                    const h = Math.max(EV_MIN_BAR_H, seg.intensity * TURN_BAR_MAX_H);
                    fillRoundRect(ctx, visX0, TURN_ROW_BOTTOM_Y - h, w, h, [r, r, r, r]);
                } else {
                    // stop: fixed 4px ribbon, intensity drives alpha only.
                    // h=4 means fillRoundRect caps the radius at 2 -> short
                    // stops become pills, long bands stay nearly flat-sided.
                    fillRoundRect(ctx, visX0, STOP_RIBBON_Y, w, STOP_RIBBON_H, [r, r, r, r]);
                }
            }
        }
        ctx.globalAlpha = 1;
    }

    function drawEmptyState(ctx: CanvasRenderingContext2D, cssW: number, dimColor: string): void {
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = dimColor;
        const dashY = Math.round(STRIP_H / 2);
        for (let x = 0; x < cssW; x += 8) {
            ctx.fillRect(x, dashY, 4, 1);
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = dimColor;
        ctx.font = "11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(t("chart.inferredStrip.empty"), cssW / 2, STRIP_H / 2 + 0.5);
        ctx.restore();
    }

    // --- Click + flash ---

    // Convert a clientX to a trip-relative second. Maps via the chart canvas
    // (not the strip canvas) so width / left-offset mismatches between the
    // two canvases never throw the click off-target: chart.scales.x already
    // knows its own pixel offset within chart canvas, and getValueForPixel
    // takes that into account.
    function relSecAtClientX(clientX: number): number | null {
        const xScale = opts.chart.scales.x;
        if (!xScale) return null;
        const chartRect = opts.chart.canvas.getBoundingClientRect();
        if (chartRect.width <= 0) {
            // Chart canvas hidden via the "View" menu while the strip stays
            // visible: its rect is all-zero, so getValueForPixel maps an
            // absolute viewport X through a degenerate scale and returns
            // garbage/NaN. Map over the strip canvas's OWN box using the same
            // data-space window (xScale.min/max) that redraw's relToPx uses, so
            // the click lands on exactly the bar drawn under it. Mirrors the
            // hidden-canvas fallback in chart.ts's .player-chart seek handler.
            const stripRect = opts.canvas.getBoundingClientRect();
            if (stripRect.width <= 0) return null;
            const xMin = Number(xScale.min);
            const xMax = Number(xScale.max);
            const range = xMax - xMin;
            if (!(range > 0)) return null;
            const val = xMin + ((clientX - stripRect.left) / stripRect.width) * range;
            return Number.isFinite(val) ? val : null;
        }
        const xInChartPx = clientX - chartRect.left;
        const val = xScale.getValueForPixel(xInChartPx);
        if (typeof val !== "number" || !Number.isFinite(val)) return null;
        return val;
    }

    // When multiple segments overlap at relSec, prefer the one with the highest
    // intensity. Returns the segment (so the click handler can both seek to its
    // start and report its kind/intensity), or null when no synthetic event is active.
    function strongestActiveSegment(trip: Trip, relSec: number): InferredSegment | null {
        const active = inferredSegmentsAtRelSec(trip, relSec);
        if (active.length === 0) return null;
        let best = active[0]!;
        for (const seg of active) {
            if (seg.intensity > best.intensity) best = seg;
        }
        return best;
    }

    function onClick(e: MouseEvent): void {
        const trip = opts.getTrip();
        if (!trip) return;
        const relSec = relSecAtClientX(e.clientX);
        if (relSec == null) return;
        const seg = strongestActiveSegment(trip, relSec);
        // No active segment under the click: seek to the raw position (prior behavior).
        const target = seg ? seg.startRelSec : relSec;
        opts.onSeek(target);
        opts.onFlash?.(target);
        // Stop the bubble: parent .player-chart has a shared seek-handler that
        // without stopPropagation would do a second seek (to the exact position,
        // without snapping to the event start) right after ours.
        e.stopPropagation();
    }

    const canvas = opts.canvas;
    canvas.addEventListener("click", onClick);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => redraw());
        ro.observe(canvas);
    }

    function dispose(): void {
        if (disposed) return;
        disposed = true;
        canvas.removeEventListener("click", onClick);
        ro?.disconnect();
        ro = null;
        clearOverlapPool();
    }

    return { redraw, dispose };
}

/** Bar alpha. Mild events (< 0.4) fade with a linear ramp matching the JSX
 *  reference: `0.55 + intensity * 1.1`. Stop has its own narrower ramp. */
function barAlpha(kind: InferredSegment["kind"], intensity: number): number {
    if (kind === "stop") return STOP_ALPHA_BASE + intensity * STOP_ALPHA_SPAN;
    if (intensity < MILD_THRESHOLD) return Math.min(1, 0.55 + intensity * 1.1);
    return 1;
}

function kindColor(kind: InferredSegment["kind"], colors: ReturnType<typeof themeColors>): string {
    switch (kind) {
        case "stop":
            return colors.inferredStop;
        case "brake":
            return colors.inferredBrake;
        case "turn":
            return colors.inferredTurn;
        case "accel":
            return colors.inferredAccel;
    }
}

/** Fills a rect with per-corner radii [tl, tr, br, bl]. Tiny enough (1px on
 *  bar caps) that the visual effect is subtle anti-aliasing of bar ends. */
function fillRoundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    radii: [number, number, number, number],
): void {
    const [tl, tr, br, bl] = radii;
    const maxR = Math.min(w, h) / 2;
    const r = {
        tl: Math.min(tl, maxR),
        tr: Math.min(tr, maxR),
        br: Math.min(br, maxR),
        bl: Math.min(bl, maxR),
    };
    ctx.beginPath();
    ctx.moveTo(x + r.tl, y);
    ctx.lineTo(x + w - r.tr, y);
    ctx.arcTo(x + w, y, x + w, y + r.tr, r.tr);
    ctx.lineTo(x + w, y + h - r.br);
    ctx.arcTo(x + w, y + h, x + w - r.br, y + h, r.br);
    ctx.lineTo(x + r.bl, y + h);
    ctx.arcTo(x, y + h, x, y + h - r.bl, r.bl);
    ctx.lineTo(x, y + r.tl);
    ctx.arcTo(x, y, x + r.tl, y, r.tl);
    ctx.closePath();
    ctx.fill();
}

/**
 * Renders a compact list of event-chips for the unified scrub-thumb tooltip.
 * Returns "" when no events are active - caller can append unconditionally.
 * Reuses the .inferred-strip-tooltip__row markup; CSS lives in chart.css.
 */
export function renderInferredEventChipsHtml(active: InferredSegment[]): string {
    if (active.length === 0) return "";
    const rows = active
        .map((seg) => {
            const range = `${formatTime(seg.startRelSec)} - ${formatTime(seg.endRelSec)}`;
            const pct = Math.round(seg.intensity * 100);
            const isHard = seg.intensity >= HARD_INTENSITY;
            return `<div class="inferred-strip-tooltip__row" data-kind="${seg.kind}">
                <span class="inferred-strip-tooltip__chip inferred-strip-tooltip__chip--${seg.kind}">${escapeHtml(t(`chart.inferredStrip.kind.${seg.kind}` as const))}</span>
                <span class="inferred-strip-tooltip__range">${escapeHtml(range)}</span>
                <span class="inferred-strip-tooltip__pct${isHard ? " is-hard" : ""}">${pct}%</span>
            </div>`;
        })
        .join("");
    // The segments are computed from the GPS track, not read from any sensor.
    // Without the note the percentages read as black-box telemetry - and get
    // quoted as evidence in disputes.
    return `${rows}<div class="inferred-strip-tooltip__note">${escapeHtml(t("chart.inferredStrip.estimated"))}</div>`;
}

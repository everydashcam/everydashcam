// Driving dynamics drawn on the speed chart: two continuous lanes right under
// the plot. The upper one is longitudinal acceleration - grey while the speed
// holds, greener the harder the car speeds up, redder the harder it brakes; the
// lower one is turn rate - grey on a straight, yellower the sharper the turn.
// Colour strength scales with the same "very strong" caps as the inferred
// segments' intensity (src/inferred-events.ts), so a lane and the tooltip's
// event chips agree. Holes mark missing GPS data, not calm driving. Stops are
// not drawn separately - a stop is the speed curve lying on zero.
//
// The lanes sit in padding the chart reserves under the plot (see
// INFERRED_LANE_RESERVE_PX), labelled in the plot's left gutter. The hover
// tooltip lists the inferred segments under the cursor through
// renderInferredEventChipsHtml, and a click on a lane snaps to the start of
// the segment under it.

import { escapeHtml } from "../escape.js";
import { t } from "../i18n/index.js";
import {
    ACCEL_INTENSITY_CAP_MS2,
    BRAKE_INTENSITY_CAP_MS2,
    type DrivingDynamicsSpan,
    type InferredSegment,
    TURN_INTENSITY_CAP_DEG_PER_SEC,
} from "../inferred-events.js";
import type { Trip } from "../trips.js";

import { formatTime } from "./format.js";
import { compositeOver, oklabRamp, parseHexRgb, type Rgb } from "./oklab-ramp.js";
import type { themeColors } from "./theme.js";

/** Lane thickness in CSS px. */
const LANE_H = 10;
/** Gap between the plot's bottom edge and the first lane: enough for the zero
 *  speed label, centred on that edge, to stand clear of the first lane's
 *  label. */
const LANE_GAP = 6;
/** Hairline between the two lanes. */
const LANE_SPACING = 1;
/** Clearance between the lower lane and the canvas bottom. */
const LANE_BOTTOM_CLEARANCE = 2;
/** Corner radius of a lane run. */
const LANE_RADIUS = 2;
/** Padding the chart keeps clear under its plot area for both lanes. */
export const INFERRED_LANE_RESERVE_PX = LANE_GAP + LANE_H * 2 + LANE_SPACING + LANE_BOTTOM_CLEARANCE;
/** Vertical slack below the lanes that still counts as a click on the lower one. */
const LANE_HIT_SLACK_PX = 2;
/** Horizontal slack around a segment for the click snap. */
const SEGMENT_HIT_SLACK_PX = 3;
/** Opacity of the grey under the colour, where there is data: a quiet track
 *  the colour stands out from. */
const BASE_ALPHA = 0.16;
/** Opacity of the lane labels, as quiet as the axis unit labels. */
const LABEL_ALPHA = 0.8;
/** Share of the "very strong" cap that already paints the full colour: low
 *  enough that ordinary braking (~1 m/s^2, a third of the cap) is a clear
 *  colour rather than a pale tint of the track, high enough that a hard brake
 *  still stands out from it. */
const FULL_COLOUR_SHARE_OF_CAP = 0.6;
/** Steps a lane's colour ramp is quantised to: finer than the eye separates on
 *  a 10 px lane, and a lookup instead of a colour conversion per column. */
const RAMP_STEPS = 64;
/** Space between a lane label and the plot edge. */
const LABEL_GAP_PX = 4;
/** Lane label font size. */
const LABEL_FONT_PX = 9;

/** Hit-test intensity threshold - "hard" events (>= 0.6) are emphasised in
 *  the tooltip chips. */
export const HARD_INTENSITY = 0.6;

/** Plot rectangle and time mapping the lanes are drawn against. */
export interface InferredLaneGeometry {
    left: number;
    right: number;
    top: number;
    bottom: number;
    /** Content-seconds to canvas x. */
    xForSec: (sec: number) => number;
}

type Lane = "longitudinal" | "turn";

function laneOf(kind: InferredSegment["kind"]): Lane | null {
    if (kind === "accel" || kind === "brake") return "longitudinal";
    if (kind === "turn") return "turn";
    return null;
}

function laneTop(lane: Lane, geometry: InferredLaneGeometry): number {
    return geometry.bottom + LANE_GAP + (lane === "longitudinal" ? 0 : LANE_H + LANE_SPACING);
}

/** Colour strength in [0..1] on a smoothstep: flat at zero, so small jitter
 *  stays grey and the colour rises out of it without a visible threshold. */
function strength(magnitude: number, cap: number): number {
    const t = Math.min(1, Math.max(0, magnitude / (cap * FULL_COLOUR_SHARE_OF_CAP)));
    return t * t * (3 - 2 * t);
}

type LaneColors = ReturnType<typeof themeColors>;

/** Ramps from the grey track to each lane's full colour, RAMP_STEPS + 1 long. */
interface LaneRamps {
    brake: readonly string[];
    accel: readonly string[];
    turn: readonly string[];
}

/** Ramps per palette. themeColors() hands out a new object after a theme
 *  change, so a stale palette's entry simply stops being used. */
const laneRampsCache = new WeakMap<LaneColors, LaneRamps | null>();

/**
 * The lane colour ramps for a palette, mixed in OKLab so a partial strength is
 * a lighter step of the lane's own hue: painting the full colour at partial
 * alpha blends in sRGB and turns the red pink and the green mint. Each ramp
 * starts at the grey track as it shows on the chart surface, so strength 0
 * matches the track. Null when a palette colour does not resolve to an opaque
 * sRGB colour; the lanes then fall back to alpha.
 */
function laneRamps(ctx: CanvasRenderingContext2D, colors: LaneColors): LaneRamps | null {
    const cached = laneRampsCache.get(colors);
    if (cached !== undefined) return cached;
    // The canvas normalises any CSS colour syntax to #rrggbb, including the
    // shorthands and names a CSS minifier may substitute in the tokens.
    const resolve = (color: string): Rgb | null => {
        ctx.fillStyle = color;
        return parseHexRgb(String(ctx.fillStyle));
    };
    ctx.save();
    const surface = resolve(colors.chartSurface);
    const trackInk = resolve(colors.chartTickText);
    const brake = resolve(colors.inferredBrake);
    const accel = resolve(colors.inferredAccel);
    const turn = resolve(colors.inferredTurn);
    ctx.restore();
    let ramps: LaneRamps | null = null;
    if (surface && trackInk && brake && accel && turn) {
        const track = compositeOver(trackInk, BASE_ALPHA, surface);
        ramps = {
            brake: oklabRamp(track, brake, RAMP_STEPS),
            accel: oklabRamp(track, accel, RAMP_STEPS),
            turn: oklabRamp(track, turn, RAMP_STEPS),
        };
    }
    laneRampsCache.set(colors, ramps);
    return ramps;
}

/** Returns segments active at the given trip-relative time. Exported so the
 *  unified chart tooltip can enrich its body with event chips when hovering
 *  over a span with inferred events. Linear scan is fine - typical trip < ~200
 *  segments. */
export function inferredSegmentsAtRelSec(trip: Trip, relSec: number): InferredSegment[] {
    const out: InferredSegment[] = [];
    for (const seg of trip.inferredSegments) {
        if (seg.startRelSec <= relSec && seg.endRelSec >= relSec) out.push(seg);
    }
    return out;
}

/** Lane labels, each drawn as one line in the plot's left gutter. */
export interface InferredLaneLabels {
    /** Canvas font for both labels. */
    font: string;
    longitudinal: string;
    turn: string;
}

/** Gutter width (CSS px) the lane labels need left of the plot. */
export function inferredLaneLabelWidthPx(ctx: CanvasRenderingContext2D, labels: InferredLaneLabels): number {
    ctx.save();
    ctx.font = labels.font;
    const width = Math.max(ctx.measureText(labels.longitudinal).width, ctx.measureText(labels.turn).width);
    ctx.restore();
    return Math.ceil(width) + LABEL_GAP_PX * 2;
}

/** Canvas font for the lane labels in the given family. */
export function inferredLaneLabelFont(family: string): string {
    return `500 ${LABEL_FONT_PX}px ${family}`;
}

/**
 * Draws both lanes and their labels. Each span's value sits at its midpoint
 * and the lanes interpolate between neighbouring midpoints column by column,
 * so the colour changes as smoothly as the data allows. A hole in the data
 * breaks the interpolation: each side keeps its own value up to its edge.
 * Several spans can share a pixel column on a long trip; the column keeps the
 * strongest value, so a hard brake survives the overview instead of averaging
 * away.
 */
export function drawDrivingDynamicsLanes(
    ctx: CanvasRenderingContext2D,
    spans: readonly DrivingDynamicsSpan[],
    geometry: InferredLaneGeometry,
    colors: LaneColors,
    labels: InferredLaneLabels,
): void {
    const columns = Math.ceil(geometry.right - geometry.left);
    if (spans.length === 0 || columns <= 0) return;
    const ramps = laneRamps(ctx, colors);
    const hasData = new Uint8Array(columns);
    const accel = new Float32Array(columns);
    const turn = new Float32Array(columns);
    const write = (column: number, accelMs2: number, turnRate: number): void => {
        if (column < 0 || column >= columns) return;
        if (!hasData[column] || Math.abs(accelMs2) > Math.abs(accel[column]!)) accel[column] = accelMs2;
        if (!hasData[column] || turnRate > turn[column]!) turn[column] = turnRate;
        hasData[column] = 1;
    };
    /** Fills the column centres in [fromX, toX) with one span's value. */
    const fillFlat = (fromX: number, toX: number, span: DrivingDynamicsSpan): void => {
        const first = Math.max(0, Math.ceil(fromX - 0.5));
        const last = Math.min(columns - 1, Math.ceil(toX - 0.5) - 1);
        for (let column = first; column <= last; column++) write(column, span.accelMs2, span.turnRateDegPerSec);
        // A span narrower than a column still marks the column it falls in.
        if (last < first) write(Math.floor((fromX + toX) / 2), span.accelMs2, span.turnRateDegPerSec);
    };
    const xOf = (sec: number): number => geometry.xForSec(sec) - geometry.left;
    let previous: { span: DrivingDynamicsSpan; mid: number } | null = null;
    for (const span of spans) {
        const start = xOf(span.startSec);
        const end = xOf(span.endSec);
        const mid = (start + end) / 2;
        const joinsPrevious = previous !== null && span.startSec <= previous.span.endSec + 1e-6;
        if (previous && joinsPrevious && mid > previous.mid) {
            // Interpolate between the two midpoints.
            const from = previous;
            const first = Math.max(0, Math.ceil(from.mid - 0.5));
            const last = Math.min(columns - 1, Math.ceil(mid - 0.5) - 1);
            for (let column = first; column <= last; column++) {
                const t = (column + 0.5 - from.mid) / (mid - from.mid);
                write(
                    column,
                    from.span.accelMs2 + (span.accelMs2 - from.span.accelMs2) * t,
                    from.span.turnRateDegPerSec + (span.turnRateDegPerSec - from.span.turnRateDegPerSec) * t,
                );
            }
            if (last < first) write(Math.floor(mid), span.accelMs2, span.turnRateDegPerSec);
        } else {
            // A run starts here: its first half keeps the span's own value.
            if (previous) fillFlat(previous.mid, xOf(previous.span.endSec), previous.span);
            fillFlat(start, mid, span);
        }
        previous = { span, mid };
        // Spans are in time order; nothing past the right edge can still matter.
        if (start > columns) break;
    }
    if (previous) fillFlat(previous.mid, xOf(previous.span.endSec), previous.span);

    const accelTop = laneTop("longitudinal", geometry);
    const turnTop = laneTop("turn", geometry);
    ctx.save();
    // Each run of data is a rounded track in both lanes; the colour is clipped
    // to it so its ends stay round.
    const tracks = new Path2D();
    for (let column = 0; column < columns; ) {
        if (!hasData[column]) {
            column++;
            continue;
        }
        const start = column;
        while (column < columns && hasData[column]) column++;
        for (const top of [accelTop, turnTop]) {
            tracks.roundRect(geometry.left + start, top, column - start, LANE_H, LANE_RADIUS);
        }
    }
    ctx.clip(tracks);
    ctx.fillStyle = colors.chartTickText;
    ctx.globalAlpha = BASE_ALPHA;
    ctx.fill(tracks);
    // Colour over the grey, one column at a time.
    const paint = (
        column: number,
        top: number,
        colourStrength: number,
        ramp: readonly string[] | undefined,
        fullColour: string,
    ): void => {
        if (colourStrength <= 0) return;
        if (ramp) {
            ctx.globalAlpha = 1;
            ctx.fillStyle = ramp[Math.round(colourStrength * RAMP_STEPS)]!;
        } else {
            ctx.globalAlpha = colourStrength;
            ctx.fillStyle = fullColour;
        }
        ctx.fillRect(geometry.left + column, top, 1, LANE_H);
    };
    for (let column = 0; column < columns; column++) {
        if (!hasData[column]) continue;
        const value = accel[column]!;
        const isBrake = value < 0;
        const accelStrength = strength(Math.abs(value), isBrake ? BRAKE_INTENSITY_CAP_MS2 : ACCEL_INTENSITY_CAP_MS2);
        if (isBrake) paint(column, accelTop, accelStrength, ramps?.brake, colors.inferredBrake);
        else paint(column, accelTop, accelStrength, ramps?.accel, colors.inferredAccel);
        paint(
            column,
            turnTop,
            strength(turn[column]!, TURN_INTENSITY_CAP_DEG_PER_SEC),
            ramps?.turn,
            colors.inferredTurn,
        );
    }
    // Labels, right-aligned against the plot, outside the track clip.
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = LABEL_ALPHA;
    ctx.fillStyle = colors.chartTickText;
    ctx.font = labels.font;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const labelX = geometry.left - LABEL_GAP_PX;
    ctx.fillText(labels.longitudinal, labelX, accelTop + LANE_H / 2);
    ctx.fillText(labels.turn, labelX, turnTop + LANE_H / 2);
    ctx.restore();
}

/**
 * The segment a click at canvas (x, y) lands on: the strongest accel/brake
 * segment under the upper lane, the strongest turn under the lower one. Null
 * anywhere else, or between segments, so such a click keeps its exact seek.
 */
export function inferredSegmentAtLane(
    segments: readonly InferredSegment[],
    geometry: InferredLaneGeometry,
    x: number,
    y: number,
): InferredSegment | null {
    const accelTop = laneTop("longitudinal", geometry);
    const turnTop = laneTop("turn", geometry);
    let lane: Lane | null = null;
    if (y >= accelTop - 1 && y < turnTop) lane = "longitudinal";
    else if (y >= turnTop && y <= turnTop + LANE_H + LANE_HIT_SLACK_PX) lane = "turn";
    if (!lane) return null;
    let best: InferredSegment | null = null;
    for (const seg of segments) {
        if (laneOf(seg.kind) !== lane) continue;
        const x0 = geometry.xForSec(seg.startRelSec) - SEGMENT_HIT_SLACK_PX;
        const x1 = geometry.xForSec(seg.endRelSec) + SEGMENT_HIT_SLACK_PX;
        if (x < x0 || x > x1) continue;
        if (!best || seg.intensity > best.intensity) best = seg;
    }
    return best;
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

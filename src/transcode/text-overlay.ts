// Text-based telemetry widgets (speed, coords, clock, distance) painted on top
// of every transcoded frame, themed by the active style system.
//
// drawWidgetBox is the layout primitive: a primary value (+ optional unit
// suffix) and an optional secondary line, laid out top-left from a normalized
// (xPct, yPct) anchor and clamped to the frame. The coordinate widget has its
// own two-line N/E renderer (drawCoordsBox) because its hemisphere keys are
// accent-colored mid-string. The style (min / card / bold) decides plate, fonts,
// colors, and decoration via STYLE_CHROME. Position is fractions of the OUTPUT
// frame; the UI preview calls the same code so what the user arranges matches
// the file.

import { formatSpeedReading } from "../gps-telemetry.js";
import type { SpeedSample } from "../parsers/types.js";
import { clamp, drawNoFixIcon, measureTextWidth, roundRectPath } from "./canvas-draw.js";
import { composeFont, resolveStyleColor, type StyleChrome, STYLE_CHROME } from "./overlay-styles.js";
import type { OverlayStyleId } from "./types.js";

type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Base font height as a fraction of the output frame height at scalePct=100,
 *  for a primary value with valueScale=1 (the speed readout). */
export const TEXT_OVERLAY_BASE_FONT_PCT = 0.045;

/** Hero-speed (bold style) oversize factor: the speed number jumps from the
 *  base ~38px to ~60px on a 1080p frame, matching the design handoff. */
const HERO_SCALE = 1.55;

export interface TextOverlayDrawOpts {
    /** Top-left anchor of the rendered box, fraction of output width. */
    xPct: number;
    /** Top-left anchor of the rendered box, fraction of output height. */
    yPct: number;
    /** Percentage of the base font size. 50..200 in the UI. */
    scalePct: number;
}

/** One widget's content. `secondary` renders as a small dim line below the
 *  primary (clock time). `unit` is an accent suffix after the value. */
export interface WidgetContent {
    value: string;
    unit?: string;
    secondary?: string;
    /** Multiplier on the base primary font (speed=1, clock/distance ~0.55..0.85). */
    valueScale: number;
    /** Worst-case value sample (e.g. "000" for a 0-999 speed). When set, the
     *  value field reserves this width and the value is right-aligned in it, so
     *  a changing digit count does not make the plate width / unit position
     *  jitter frame to frame. null/omitted = field hugs the actual value. */
    reserveValue?: string;
    /** Multiplier on the primary for the secondary line. Defaults to the
     *  unit-suffix ratio (0.46), which is right for a suffix but dwarfs a line
     *  that carries equal information - the clock passes ~0.75 so the time
     *  reads as a peer of the date, not a footnote. */
    secondaryScale?: number;
    /** Speed only: render as the bold-style hero (oversized accent number +
     *  hazard stripe) when the style enables it (chrome.heroSpeed). Ignored by
     *  other widgets and by min/card. */
    hero?: boolean;
}

/** Paints the plate background + optional hairline border behind a widget box.
 *  No-op for plate-less styles (min/bold) so the shared draw stays one branch. */
function drawPlate(ctx: AnyCtx, chrome: StyleChrome, x: number, y: number, w: number, h: number, radius: number): void {
    if (!chrome.plate) return;
    roundRectPath(ctx, x, y, w, h, radius);
    ctx.fillStyle = chrome.plate;
    ctx.fill();
    if (chrome.plateBorder) {
        ctx.lineWidth = Math.max(1, Math.round(radius * 0.18));
        ctx.strokeStyle = chrome.plateBorder;
        ctx.stroke();
    }
}

/** Draws the left-edge hazard stripe (45deg black/accent bars) for the bold
 *  hero speed. The strip is clipped to [x, x+w] over the full box height. */
function drawHazardStripe(ctx: AnyCtx, x: number, y: number, w: number, h: number, accent: string): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = "#000000";
    ctx.fillRect(x, y, w, h);
    // Diagonal accent bars at 45deg. Step = 2*w keeps the bar width ~= the gap.
    ctx.strokeStyle = accent;
    ctx.lineWidth = w;
    ctx.lineCap = "butt";
    const step = w * 2;
    ctx.beginPath();
    for (let d = -h; d < w + h; d += step) {
        ctx.moveTo(x + d, y + h);
        ctx.lineTo(x + d + h, y);
    }
    ctx.stroke();
    ctx.restore();
}

/**
 * Draws a themed text widget. Returns nothing; the caller owns enable gating.
 * Layout is measured so the plate hugs the content, then the whole box is
 * clamped to stay inside the frame (a long value dragged to the right edge must
 * not paint past the border).
 */
export function drawWidgetBox(
    ctx: AnyCtx,
    frameWidth: number,
    frameHeight: number,
    opts: TextOverlayDrawOpts,
    style: OverlayStyleId,
    accent: string,
    content: WidgetContent,
): void {
    if (!content.value) return;
    const chrome = STYLE_CHROME[style];
    const hero = !!content.hero && chrome.heroSpeed;
    const scale = clamp(opts.scalePct, 50, 200) / 100;
    const heroMul = hero ? HERO_SCALE : 1;
    const primaryPx = Math.max(
        10,
        Math.round(frameHeight * TEXT_OVERLAY_BASE_FONT_PCT * scale * content.valueScale * heroMul),
    );
    const unitPx = Math.max(8, Math.round(primaryPx * 0.46));
    const secondaryPx = Math.max(8, Math.round(primaryPx * (content.secondaryScale ?? 0.46)));
    const gap = Math.round(primaryPx * 0.18);
    const pad = chrome.plate ? Math.round(primaryPx * 0.36) : 0;
    // Hero value is accent; its unit drops to white (the number carries the
    // accent). Non-hero widgets use the style's value/unit colors.
    const valueColor = hero ? accent : resolveStyleColor(chrome.valueColor, accent);
    const unitColor = hero ? "#FFFFFF" : resolveStyleColor(chrome.unitColor, accent);

    const numFont = composeFont(chrome.numWeight, primaryPx, chrome.numFont);
    const unitFont = composeFont(chrome.readWeight, unitPx, chrome.readFont);
    const secondaryFont = composeFont(chrome.readWeight, secondaryPx, chrome.readFont);

    // --- measure ---
    ctx.save();
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.font = numFont;
    const valueW = Math.ceil(measureTextWidth(ctx, content.value));
    // Reserved value-field width: the wider of the actual value and the
    // worst-case sample, so the plate edge and unit position hold steady as the
    // digit count changes (max() so an over-long value is never clipped).
    const reserveW = content.reserveValue ? Math.ceil(measureTextWidth(ctx, content.reserveValue)) : 0;
    const valueFieldW = Math.max(valueW, reserveW);
    ctx.font = unitFont;
    const unitW = content.unit ? Math.ceil(measureTextWidth(ctx, content.unit)) + Math.round(unitPx * 0.3) : 0;
    ctx.font = secondaryFont;
    const secondaryW = content.secondary ? Math.ceil(measureTextWidth(ctx, content.secondary)) : 0;

    const valueRowW = valueFieldW + unitW;
    const contentW = Math.max(valueRowW, secondaryW);
    const secondaryH = content.secondary ? secondaryPx : 0;
    const secondaryGap = content.secondary ? gap : 0;
    const contentH = primaryPx + secondaryGap + secondaryH;

    // Hero hazard stripe occupies a left strip the width of which scales with the
    // number, plus a gap before the value (mirrors the 8px stripe @ 60px = ~0.13).
    const stripeW = hero ? Math.max(5, Math.round(primaryPx * 0.13)) : 0;
    const stripeGap = hero ? Math.round(primaryPx * 0.2) : 0;
    const leadW = stripeW + stripeGap;
    const boxW = contentW + pad * 2 + leadW;
    const boxH = contentH + pad * 2;

    // --- clamp to frame ---
    const xLeft = clamp(opts.xPct, 0, 1) * frameWidth;
    const yTop = clamp(opts.yPct, 0, 1) * frameHeight;
    const x = Math.min(Math.max(0, xLeft), Math.max(0, frameWidth - boxW));
    const y = Math.min(Math.max(0, yTop), Math.max(0, frameHeight - boxH));

    drawPlate(ctx, chrome, x, y, boxW, boxH, Math.round(primaryPx * 0.12));
    if (hero) drawHazardStripe(ctx, x + pad, y + pad, stripeW, boxH - pad * 2, accent);

    // --- content ---
    const innerX = x + pad + leadW;
    const cy = y + pad;

    // primary value + unit on one baseline row. The value is right-aligned
    // inside its reserved field (odometer style) so the unit sits at a fixed x
    // regardless of digit count; with no reserve the field equals the value
    // width, so this is a no-op shift for the hugging widgets.
    ctx.font = numFont;
    ctx.fillStyle = valueColor;
    const valueX = innerX + (valueFieldW - valueW);
    withShadow(ctx, chrome.shadow, primaryPx, () => ctx.fillText(content.value, valueX, cy));
    if (content.unit) {
        ctx.font = unitFont;
        ctx.fillStyle = unitColor;
        // Bottom-align the unit to the value's baseline-ish (top + value-unit).
        const uy = cy + (primaryPx - unitPx);
        withShadow(ctx, chrome.shadow, unitPx, () =>
            ctx.fillText(content.unit as string, innerX + valueFieldW + Math.round(unitPx * 0.3), uy),
        );
    }

    if (content.secondary) {
        ctx.font = secondaryFont;
        ctx.fillStyle = chrome.secondaryColor;
        withShadow(ctx, chrome.shadow, secondaryPx, () =>
            ctx.fillText(content.secondary as string, innerX, cy + primaryPx + secondaryGap),
        );
    }

    ctx.restore();
}

/**
 * No-fix placeholder for a text widget: the same plate chrome at the same
 * anchor, with the crossed-pin icon where the reading would be. `valueScale`
 * mirrors the widget's own so the placeholder keeps a similar footprint (the
 * width differs - readings vary anyway). Icon-only by design: an icon needs no
 * localization.
 */
export function drawNoFixBox(
    ctx: AnyCtx,
    frameWidth: number,
    frameHeight: number,
    opts: TextOverlayDrawOpts,
    style: OverlayStyleId,
    accent: string,
    valueScale: number,
    hero = false,
): void {
    const chrome = STYLE_CHROME[style];
    const scale = clamp(opts.scalePct, 50, 200) / 100;
    // Same hero multiplier drawWidgetBox applies to the speed readout in the
    // bold style: without it the placeholder renders at ~65% of the reading it
    // replaces, so the widget visibly shrinks and grows at every fix boundary.
    const heroMul = hero && chrome.heroSpeed ? HERO_SCALE : 1;
    const primaryPx = Math.max(10, Math.round(frameHeight * TEXT_OVERLAY_BASE_FONT_PCT * scale * valueScale * heroMul));
    const pad = chrome.plate ? Math.round(primaryPx * 0.36) : 0;
    const side = Math.round(primaryPx * 1.2);
    const boxW = side + pad * 2;
    const boxH = primaryPx + pad * 2;

    const xLeft = clamp(opts.xPct, 0, 1) * frameWidth;
    const yTop = clamp(opts.yPct, 0, 1) * frameHeight;
    const x = Math.min(Math.max(0, xLeft), Math.max(0, frameWidth - boxW));
    const y = Math.min(Math.max(0, yTop), Math.max(0, frameHeight - boxH));

    ctx.save();
    drawPlate(ctx, chrome, x, y, boxW, boxH, Math.round(primaryPx * 0.12));
    // Muted (unit) color, not the value color: the placeholder should read as
    // chrome, not as a reading. Shadowed like the text it replaces - on the
    // plate-less styles the icon sits straight on the video.
    withShadow(ctx, chrome.shadow, primaryPx, () =>
        drawNoFixIcon(ctx, x + boxW / 2, y + boxH / 2, primaryPx, resolveStyleColor(chrome.unitColor, accent)),
    );
    ctx.restore();
}

/**
 * Draws the coordinate widget: two monospace lines, "N 55.7521°" / "E 37.6173°",
 * with the hemisphere key (N/S/E/W) in the accent color and the value white.
 * Separate from drawWidgetBox because the per-key accent color is mid-string.
 * Latitude/longitude are formatted as absolute degrees + a hemisphere letter
 * (universal navigation notation; matches the design handoff). Skips drawing on
 * a non-finite reading.
 */
export function drawCoordsBox(
    ctx: AnyCtx,
    frameWidth: number,
    frameHeight: number,
    opts: TextOverlayDrawOpts,
    style: OverlayStyleId,
    accent: string,
    lat: number,
    lon: number,
    valueScale: number,
): void {
    const parts = formatCoordParts(lat, lon);
    if (!parts) return;
    const chrome = STYLE_CHROME[style];
    const scale = clamp(opts.scalePct, 50, 200) / 100;
    const px = Math.max(9, Math.round(frameHeight * TEXT_OVERLAY_BASE_FONT_PCT * scale * valueScale));
    const lineGap = Math.round(px * 0.3);
    const keyGap = Math.round(px * 0.4); // space between the key letter and value
    const pad = chrome.plate ? Math.round(px * 0.5) : 0;
    const font = composeFont(chrome.readWeight, px, chrome.readFont);
    const keyColor = resolveStyleColor(chrome.coordKeyColor, accent);
    const valColor = resolveStyleColor(chrome.valueColor, accent);

    ctx.save();
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.font = font;
    const keyW = Math.ceil(Math.max(measureTextWidth(ctx, parts.latKey), measureTextWidth(ctx, parts.lonKey)));
    const valW = Math.ceil(Math.max(measureTextWidth(ctx, parts.latVal), measureTextWidth(ctx, parts.lonVal)));
    const contentW = keyW + keyGap + valW;
    const contentH = px * 2 + lineGap;
    const boxW = contentW + pad * 2;
    const boxH = contentH + pad * 2;

    const xLeft = clamp(opts.xPct, 0, 1) * frameWidth;
    const yTop = clamp(opts.yPct, 0, 1) * frameHeight;
    const x = Math.min(Math.max(0, xLeft), Math.max(0, frameWidth - boxW));
    const y = Math.min(Math.max(0, yTop), Math.max(0, frameHeight - boxH));

    drawPlate(ctx, chrome, x, y, boxW, boxH, Math.round(px * 0.16));

    const innerX = x + pad;
    const valX = innerX + keyW + keyGap;
    const drawLine = (key: string, val: string, lineY: number): void => {
        ctx.font = font;
        ctx.fillStyle = keyColor;
        withShadow(ctx, chrome.shadow, px, () => ctx.fillText(key, innerX, lineY));
        ctx.fillStyle = valColor;
        withShadow(ctx, chrome.shadow, px, () => ctx.fillText(val, valX, lineY));
    };
    drawLine(parts.latKey, parts.latVal, y + pad);
    drawLine(parts.lonKey, parts.lonVal, y + pad + px + lineGap);
    ctx.restore();
}

/** Runs `draw` with the glass drop-shadow recipe applied, or plainly when the
 *  style has no shadow. Wraps arbitrary fills (value/unit/label) rather than a
 *  single string, so the recipe lives here; the watermark keeps its own subtler
 *  recipe (it sits on a fixed corner, not over busy telemetry). */
function withShadow(ctx: AnyCtx, shadow: boolean, fontPx: number, draw: () => void): void {
    if (!shadow) {
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        draw();
        return;
    }
    ctx.shadowColor = "rgba(0,0,0,0.65)";
    ctx.shadowBlur = Math.max(2, fontPx * 0.18);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = Math.max(1, Math.round(fontPx * 0.03));
    draw();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
}

// --- Formatters --------------------------------------------------------------
// These produce only the numeric value; the unit suffix and the month names are
// localized on the main thread (units.* / Intl) and passed in via the overlay
// args, since the worker has no i18n. Numbers use a plain "." decimal in every
// locale (a deliberate product call - see export-flow.ts), so toFixed is fine.

/** Speed value (no unit): m/s -> km/h or mph, rounded. "-" for an invalid
 *  reading. The unit string is supplied separately (OverlayPipelineArgs.unitSpeed). */
export function formatSpeedValue(
    speedMs: number,
    units: "metric" | "imperial",
    speedSource?: SpeedSample["speedSource"],
): string {
    const value = speedMs * 3.6 * (units === "imperial" ? 0.621371 : 1);
    return formatSpeedReading({ speedMs, speedSource }, value);
}

/** Distance value (no unit): meters -> km / miles, 1 decimal. The unit string
 *  is supplied separately (OverlayPipelineArgs.unitDistance). */
export function formatDistanceValue(meters: number, units: "metric" | "imperial"): string {
    if (!Number.isFinite(meters) || meters < 0) return "0.0";
    if (units === "imperial") return (meters / 1609.344).toFixed(1);
    return (meters / 1000).toFixed(1);
}

/** Hemisphere coordinate parts for the burned overlay's two-line widget:
 *  {latKey:"N"|"S", latVal:"55.7521°", lonKey:"E"|"W", lonVal:"37.6173°"}.
 *  Absolute degrees + a hemisphere letter (4 decimals, navigation notation).
 *  Returns null on a non-finite reading so the caller draws nothing. The keys
 *  stay Latin N/S/E/W in every locale - universal on a map, and the design mock
 *  shows them Latin even in Russian. */
export function formatCoordParts(
    lat: number,
    lon: number,
): { latKey: string; latVal: string; lonKey: string; lonVal: string } | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
        latKey: lat >= 0 ? "N" : "S",
        latVal: `${Math.abs(lat).toFixed(4)}°`,
        lonKey: lon >= 0 ? "E" : "W",
        lonVal: `${Math.abs(lon).toFixed(4)}°`,
    };
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

/**
 * Formats a frame epoch (unix seconds) into a wall-clock date+time, shifted by
 * tzOffsetMin (minutes). `monthsShort` is the localized Jan..Dec abbreviation
 * list resolved on the main thread (the worker has no Intl locale context). The
 * caller passes the display-clock offset (see export-flow.ts), so the burned
 * clock matches what the player showed rather than raw UTC.
 */
export function formatClock(
    epochSec: number,
    tzOffsetMin: number,
    monthsShort: readonly string[],
): { date: string; time: string } {
    if (!Number.isFinite(epochSec)) return { date: "-", time: "-" };
    const d = new Date((epochSec + tzOffsetMin * 60) * 1000);
    const date = `${d.getUTCDate()} ${monthsShort[d.getUTCMonth()] ?? ""} ${d.getUTCFullYear()}`;
    const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
    return { date, time };
}

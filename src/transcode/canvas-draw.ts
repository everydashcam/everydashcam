// Generic 2D-canvas math/path helpers shared across the transcode drawing
// modules (watermark, text overlay, map overlay). Kept in one place so the
// same rounded-rect recipe and NaN-safe clamp do not drift between modules.

type AnyCanvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// Text shaping is the single most expensive per-call operation the overlay
// widgets do, and the export loop repeats the SAME measurements every frame:
// the font is derived from the output height (constant for a run) and most
// strings repeat ("km/h", the reserve template, a speed that only changes a few
// times a second). One entry per (font, letterSpacing, text) triple is enough to
// collapse thousands of shaping calls per second into map lookups.
const textWidthCache = new Map<string, number>();
// Bound: a run's distinct strings are dominated by the changing numeric values,
// so the set is small - the cap only guards a pathological input (e.g. a
// coordinate readout at full precision on a long trip) from growing unbounded.
const TEXT_WIDTH_CACHE_MAX = 4096;

/**
 * ctx.measureText(text).width, memoized on the context's text state. Only the
 * font and letter spacing affect the advance width, so those plus the string
 * form the key; textAlign/baseline/fillStyle do not and are ignored.
 *
 * Callers must have set ctx.font (and any letterSpacing) BEFORE calling, exactly
 * as they would for a raw measureText.
 */
export function measureTextWidth(ctx: AnyCanvas2D, text: string): number {
    // letterSpacing is not in every lib.dom we build against; read it defensively
    // rather than assume "0px" - a stale entry would misplace every glyph.
    const spacing = (ctx as { letterSpacing?: string }).letterSpacing ?? "";
    const key = `${ctx.font}\u0000${spacing}\u0000${text}`;
    const hit = textWidthCache.get(key);
    if (hit !== undefined) return hit;
    const width = ctx.measureText(text).width;
    if (textWidthCache.size >= TEXT_WIDTH_CACHE_MAX) textWidthCache.clear();
    textWidthCache.set(key, width);
    return width;
}

/** Drops the memoized text widths. Module-level state, so tests reset it. */
export function _resetForTests(): void {
    textWidthCache.clear();
}

/**
 * Clamps n into [lo, hi]. NaN/Infinity map to lo - overlay placement comes
 * from user-controlled percentages, and a non-finite value must not leak into
 * canvas coordinates (it would silently break drawing).
 */
export function clamp(n: number, lo: number, hi: number): number {
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
}

/**
 * Builds a rounded-rect path on ctx (does not stroke/fill). radius is capped
 * to half the smaller side. CanvasRenderingContext2D.roundRect is not in all
 * target browsers, so the path is built explicitly via arcTo.
 */
export function roundRectPath(ctx: AnyCanvas2D, x: number, y: number, w: number, h: number, r: number): void {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
}

/** Builds a full-circle path centered at (cx, cy) (does not stroke/fill). */
export function circlePath(ctx: AnyCanvas2D, cx: number, cy: number, radius: number): void {
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(0, radius), 0, Math.PI * 2);
    ctx.closePath();
}

/**
 * Crossed-out location pin - the shared "no GPS fix" glyph for overlay
 * placeholders (an icon, so nothing to localize). Drawn centered at (cx, cy)
 * inside a sizePx square: stroked pin outline with a head dot, crossed by a
 * diagonal slash over a darker underlay so the slash reads on the pin itself.
 */
export function drawNoFixIcon(ctx: AnyCanvas2D, cx: number, cy: number, sizePx: number, color: string): void {
    const s = sizePx;
    const lineW = Math.max(1.5, s * 0.09);
    // Pin: head circle with the tip hanging below; tangent-ish joins at 45/135
    // degrees keep the silhouette clean without real tangent math.
    const headR = s * 0.26;
    const headX = cx;
    const headY = cy - s * 0.1;
    const tipY = cy + s * 0.42;
    const a1 = Math.PI * 0.25;
    const a2 = Math.PI * 0.75;

    ctx.save();
    ctx.lineWidth = lineW;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    ctx.beginPath();
    ctx.moveTo(cx, tipY);
    ctx.lineTo(headX + headR * Math.cos(a1), headY + headR * Math.sin(a1));
    // Anticlockwise from the right-lower tangent over the top to the left-lower.
    ctx.arc(headX, headY, headR, a1, a2, true);
    ctx.closePath();
    ctx.stroke();

    circlePath(ctx, headX, headY, headR * 0.32);
    ctx.fill();

    // Slash, corner to corner. The underlay separates it from the pin strokes
    // it crosses; drawn after the pin so the "off" reading wins.
    const ext = s * 0.46;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = lineW * 1.9;
    ctx.beginPath();
    ctx.moveTo(cx - ext, cy - ext);
    ctx.lineTo(cx + ext, cy + ext);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
    ctx.beginPath();
    ctx.moveTo(cx - ext, cy - ext);
    ctx.lineTo(cx + ext, cy + ext);
    ctx.stroke();
    ctx.restore();
}

// Ring widths are fractions of the radius so the live HUD, preview and
// encoded video keep the same proportions at every output resolution.
import type { MapShape } from "./transcode/types.js";

export type RadarTheme = "san-andreas" | "vice-city";
type Ring = readonly [innerRadius: number, outerRadius: number, color: string];

const RINGS: Record<RadarTheme, readonly Ring[]> = {
    "san-andreas": [[0.935, 1, "#121212"]],
    "vice-city": [
        [0.904, 0.925, "#231824"],
        [0.925, 0.98, "#e6a4cd"],
        [0.98, 1, "#231824"],
    ],
};

export function radarTheme(theme: string): RadarTheme | undefined {
    return theme === "san-andreas" || theme === "vice-city" ? theme : undefined;
}

/** Only an explicit switch to a game palette suggests a new shape. */
export function shapeForMapTheme(theme: string, current: MapShape): MapShape {
    return radarTheme(theme) ? "circle" : current;
}

export function setRadarFrame(element: HTMLElement, theme: RadarTheme | undefined): void {
    if (element.dataset.radar === theme) return;
    if (!theme) {
        delete element.dataset.radar;
        element.style.removeProperty("--radar-rim");
        element.style.removeProperty("--radar-inner-radius");
        return;
    }
    element.dataset.radar = theme;
    const shadows = [...RINGS[theme]]
        .reverse()
        .map(([inner, , color]) => `inset 0 0 0 ${(1 - inner) * 50}cqh ${color}`);
    element.style.setProperty("--radar-inner-radius", String(RINGS[theme][0]![0]));
    element.style.setProperty("--radar-rim", shadows.join(", "));
}

type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawRadarRim(
    ctx: DrawingContext,
    width: number,
    height: number,
    shape: MapShape,
    theme: RadarTheme,
): void {
    const radius = height / 2;
    for (const [inner, outer, color] of RINGS[theme]) {
        ctx.beginPath();
        const inset = radius * (1 - (inner + outer) / 2);
        if (shape === "circle") ctx.arc(radius, radius, radius - inset, 0, Math.PI * 2);
        else ctx.rect(inset, inset, width - inset * 2, height - inset * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = radius * (outer - inner);
        ctx.stroke();
    }
}

export function drawRadarArrow(ctx: DrawingContext, size: number, color: string, theme: RadarTheme): void {
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.scale(size, size);
    ctx.beginPath();
    if (theme === "vice-city") {
        // The widest point sits halfway down, with a tapered, rounded heel.
        ctx.moveTo(0, -0.445);
        ctx.bezierCurveTo(0.075, -0.28, 0.25, -0.075, 0.25, 0.055);
        ctx.bezierCurveTo(0.25, 0.19, 0.09, 0.38, 0, 0.38);
        ctx.bezierCurveTo(-0.09, 0.38, -0.25, 0.19, -0.25, 0.055);
        ctx.bezierCurveTo(-0.25, -0.075, -0.075, -0.28, 0, -0.445);
    } else {
        ctx.moveTo(0, -0.47);
        ctx.lineTo(0.33, 0.37);
        ctx.lineTo(0, 0.23);
        ctx.lineTo(-0.33, 0.37);
    }
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.lineWidth = 0.105;
    ctx.strokeStyle = "#171419";
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
}

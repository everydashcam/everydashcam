// Radar themes draw the map as a round in-car radar. Everything that sets one
// radar theme apart from another, apart from its map palette, lives in
// RADAR_SPECS so the viewer, export preview and encoded video read one source.
// Ring widths are fractions of the radius so the live HUD, preview and encoded
// video keep the same proportions at every output resolution.
import type { MapShape } from "./transcode/types.js";

export const RADAR_THEMES = ["la-92", "miami-86", "tuner-04"] as const;
export type RadarTheme = (typeof RADAR_THEMES)[number];
type Ring = readonly [innerRadius: number, outerRadius: number, color: string];

/** Stable ids of the marker colour swatches, independent of their labels. */
export type MarkerSwatchId = "white" | "black" | "gray" | "silver" | "blue" | "red" | "green" | "orange";

interface EndpointDot {
    fill: string;
    stroke: string;
}

export interface RadarSpec {
    rings: readonly Ring[];
    arrow: "notched" | "rounded" | "triangle";
    /** Default colour of the radar's own position marker. */
    markerColor: string;
    /** Outline of the trip start and end flags on this palette. */
    markerStroke: string;
    /** Swatches whose stock colour is replaced by the palette's own shade. */
    swatchColors?: Partial<Record<MarkerSwatchId, string>>;
    /** The route ends become map dots instead of flags; absent means no end markers. */
    endpointDots?: { start: EndpointDot; end: EndpointDot };
    /** "driving" keeps only water, parks and roads open to cars beneath the route. */
    basemap: "full" | "driving";
}

const RADAR_SPECS: Record<RadarTheme, RadarSpec> = {
    "la-92": {
        rings: [[0.935, 1, "#121212"]],
        arrow: "notched",
        markerColor: "#f4f4f2",
        markerStroke: "#0e0e0e",
        basemap: "full",
    },
    "miami-86": {
        rings: [
            [0.904, 0.925, "#231824"],
            [0.925, 0.98, "#e6a4cd"],
            [0.98, 1, "#231824"],
        ],
        arrow: "rounded",
        markerColor: "#f4f4f2",
        markerStroke: "#0e0e0e",
        basemap: "full",
    },
    "tuner-04": {
        rings: [
            [0.936, 0.944, "#524f45"],
            [0.944, 1, "#a39d8d"],
        ],
        arrow: "triangle",
        markerColor: "#59e044",
        markerStroke: "#131810",
        // The stock green is too dull against the dark asphalt palette.
        swatchColors: { green: "#59e044" },
        endpointDots: {
            start: { fill: "#5cc8e3", stroke: "#1189ce" },
            end: { fill: "#f6c26b", stroke: "#cb893c" },
        },
        basemap: "driving",
    },
};

export function radarTheme(theme: string): RadarTheme | undefined {
    return RADAR_THEMES.find((candidate) => candidate === theme);
}

export function isRadarTheme(theme: string): theme is RadarTheme {
    return radarTheme(theme) !== undefined;
}

export function radarSpec(theme: RadarTheme): Readonly<RadarSpec> {
    return RADAR_SPECS[theme];
}

/** Only an explicit switch to a radar theme suggests a new shape. */
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
    const { rings } = RADAR_SPECS[theme];
    const shadows = [...rings].reverse().map(([inner, , color]) => `inset 0 0 0 ${(1 - inner) * 50}cqh ${color}`);
    element.style.setProperty("--radar-inner-radius", String(rings[0]![0]));
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
    for (const [inner, outer, color] of RADAR_SPECS[theme].rings) {
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
    switch (RADAR_SPECS[theme].arrow) {
        case "rounded":
            // The widest point sits halfway down, with a tapered, rounded heel.
            ctx.moveTo(0, -0.445);
            ctx.bezierCurveTo(0.075, -0.28, 0.25, -0.075, 0.25, 0.055);
            ctx.bezierCurveTo(0.25, 0.19, 0.09, 0.38, 0, 0.38);
            ctx.bezierCurveTo(-0.09, 0.38, -0.25, 0.19, -0.25, 0.055);
            ctx.bezierCurveTo(-0.25, -0.075, -0.075, -0.28, 0, -0.445);
            break;
        case "triangle":
            ctx.moveTo(0, -0.4);
            ctx.lineTo(0.22, 0.34);
            ctx.lineTo(-0.22, 0.34);
            break;
        case "notched":
            ctx.moveTo(0, -0.47);
            ctx.lineTo(0.33, 0.37);
            ctx.lineTo(0, 0.23);
            ctx.lineTo(-0.33, 0.37);
            break;
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

// Trip start and end flags. The viewer places them as DOM markers and the
// export snapshot paints them onto its canvas; both read the artwork here so a
// flag looks the same in the player and in the saved video.

export type EndpointKind = "start" | "end";

export interface EndpointFlagColors {
    /** The flag cloth: green at the start, red at the finish. */
    fill: string;
    /** Pole and outline, chosen to read on the basemap palette. */
    stroke: string;
}

// Artwork in a 28x32 box. The pole foot touches the route point; the start
// flag waves left and the end flag right, so both stay legible when a trip
// returns to where it began.
const FLAG_WIDTH = 28;
const FLAG_HEIGHT = 32;
const POLE_FOOT_Y = 31;
const POLE_X: Record<EndpointKind, number> = { start: 27, end: 1 };
const POLE_WIDTH = 3;

interface FlagPart {
    path: string;
    fill?: keyof EndpointFlagColors;
    stroke?: keyof EndpointFlagColors;
}

const CLOTH: Record<EndpointKind, readonly FlagPart[]> = {
    start: [{ path: "M27 3H3L8 11L3 19H27Z", fill: "fill", stroke: "stroke" }],
    end: [
        { path: "M1 3H25V19H1Z", fill: "stroke" },
        {
            path: "M1 3h6v4H1zM13 3h6v4h-6zM7 7h6v4H7zM19 7h6v4h-6zM1 11h6v4H1zM13 11h6v4h-6zM7 15h6v4H7zM19 15h6v4h-6z",
            fill: "fill",
        },
        { path: "M1 3H25V19H1Z", stroke: "stroke" },
    ],
};

function polePath(kind: EndpointKind): string {
    return `M${POLE_X[kind]} 2V${POLE_FOOT_Y}`;
}

/** Inline SVG of the flag at `heightPx`, for a DOM marker. */
export function endpointFlagSvg(kind: EndpointKind, colors: EndpointFlagColors, heightPx = FLAG_HEIGHT): string {
    const widthPx = (heightPx * FLAG_WIDTH) / FLAG_HEIGHT;
    const cloth = CLOTH[kind]
        .map(
            (part) =>
                `<path d="${part.path}" fill="${part.fill ? colors[part.fill] : "none"}"${part.stroke ? ` stroke="${colors[part.stroke]}"` : ""}/>`,
        )
        .join("");
    return (
        `<svg viewBox="0 0 ${FLAG_WIDTH} ${FLAG_HEIGHT}" width="${widthPx}" height="${heightPx}" aria-hidden="true" stroke-linejoin="round">` +
        `<path d="${polePath(kind)}" stroke="${colors.stroke}" stroke-width="${POLE_WIDTH}" stroke-linecap="round"/>${cloth}</svg>`
    );
}

/**
 * MapLibre marker placement that puts the pole foot of a `heightPx` flag on
 * its coordinate: the box corner on the pole's side is the anchor, offset by
 * the foot's inset from that corner.
 */
export function endpointFlagAnchor(
    kind: EndpointKind,
    heightPx = FLAG_HEIGHT,
): { anchor: "bottom-right" | "bottom-left"; offset: [number, number] } {
    const scale = heightPx / FLAG_HEIGHT;
    const footBelow = (FLAG_HEIGHT - POLE_FOOT_Y) * scale;
    return kind === "start"
        ? { anchor: "bottom-right", offset: [(FLAG_WIDTH - POLE_X.start) * scale, footBelow] }
        : { anchor: "bottom-left", offset: [-POLE_X.end * scale, footBelow] };
}

/** Paints the flag with its pole foot at (x, y), upright like the viewer's flags on a tilted map. */
export function drawEndpointFlag(
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    kind: EndpointKind,
    colors: EndpointFlagColors,
    x: number,
    y: number,
    heightPx: number,
): void {
    const scale = heightPx / FLAG_HEIGHT;
    context.save();
    context.translate(x, y);
    context.scale(scale, scale);
    context.translate(-POLE_X[kind], -POLE_FOOT_Y);
    context.lineJoin = "round";
    context.lineCap = "round";
    context.lineWidth = POLE_WIDTH;
    context.strokeStyle = colors.stroke;
    context.stroke(new Path2D(polePath(kind)));
    context.lineWidth = 1;
    context.lineCap = "butt";
    for (const part of CLOTH[kind]) {
        const path = new Path2D(part.path);
        if (part.fill) {
            context.fillStyle = colors[part.fill];
            context.fill(path);
        }
        if (part.stroke) {
            context.strokeStyle = colors[part.stroke];
            context.stroke(path);
        }
    }
    context.restore();
}

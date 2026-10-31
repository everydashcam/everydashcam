// Runtime builder for inline Lucide-style SVG icons. Most icons in the app are
// authored statically in HTML (see CLAUDE.md); these are the few built at
// runtime from path data, sharing one source of truth for the SVG attributes.

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Lucide "x": the close / remove glyph, so no button falls back to a font "×". */
export const X_ICON_PATHS = ["M18 6 6 18", "m6 6 12 12"];

/**
 * Builds an inline Lucide icon (24x24 viewBox, currentColor stroke) from path
 * `d` strings. size sets both width and height in px. The caller may append
 * extra shapes (e.g. a <rect>) to the returned <svg> for composite glyphs.
 */
export function buildLucideIcon(paths: string[], size = 14): SVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    for (const d of paths) {
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", d);
        svg.appendChild(path);
    }
    return svg;
}

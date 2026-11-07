// Camera arrangement engine: packs the visible cameras into a frame so their
// pictures get as much area as possible. Pure and DOM-free - the viewer calls
// it with the screen box, the export editor and the transcode worker with the
// output frame, so the preview and the file come from one computation.
//
// A tile IS the camera's picture (same aspect ratio), so the only black or
// blurred margin left is the one around the whole composition. With at most
// four cameras the engine enumerates every candidate arrangement and scores
// it, instead of keeping thresholds tuned to one frame shape.

import type { Channel } from "./parsers/types.js";

/** "main": one large camera plus smaller ones; "equal": every camera at one height. */
export type CameraArrangementMode = "main" | "equal";

export type CameraTileRole = "main" | "thumb" | "equal";

/** Where the smaller cameras sit in "main" mode. */
export type CameraStrip = "bottom" | "right" | "overlay";

export interface LayoutRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Top-left corner of an overlay window as fractions of the main camera's
 *  picture, so the window stays on the picture when the frame changes shape. */
export interface OverlayPosition {
    x: number;
    y: number;
}

export interface LayoutCamera {
    channel: Channel;
    /** Width / height of the picture the tile shows (after the export crop). */
    aspect: number;
}

export interface CameraLayoutRequest {
    /** Frame size; the result uses the same units. */
    width: number;
    height: number;
    /** Visible cameras in display order. The first one is the main camera in "main" mode. */
    cameras: readonly LayoutCamera[];
    mode: CameraArrangementMode;
    /** Size of the smaller cameras relative to the main one (height ratio in a
     *  bottom row and over the main picture, width ratio in a right column).
     *  null picks the automatic size, which also grows into free space. */
    thumbScale: number | null;
    /** Lets "main" mode lay the smaller cameras over the main picture when a
     *  strip would cost it area. Never forces the overlay. */
    allowOverlay: boolean;
    overlayPositions?: Readonly<Partial<Record<Channel, OverlayPosition>>>;
    /** Space between adjacent tiles. */
    gap: number;
    /** Preferred smallest height of a smaller camera. Dropped when no
     *  arrangement can honour it. */
    minThumbHeight: number;
}

export interface CameraTileLayout extends LayoutRect {
    channel: Channel;
    role: CameraTileRole;
    /** True for a window drawn over the main picture. */
    overlay: boolean;
}

export interface CameraLayout {
    /** One entry per requested camera, in request order. */
    tiles: CameraTileLayout[];
    /** Box around the composition; overlays stay inside the main tile. */
    bounds: LayoutRect;
    /** Placement of the smaller cameras; null in "equal" mode or with one camera. */
    strip: CameraStrip | null;
}

/** Size of the smaller cameras before they grow into free space. */
export const AUTO_THUMB_SCALE = 0.25;
/** Automatic smaller cameras grow into otherwise empty frame space up to this
 *  size relative to the main camera. A user-chosen larger size raises it. */
const AUTO_GROW_LIMIT = 0.5;
export const THUMB_SCALE_MIN = 0.1;
export const THUMB_SCALE_MAX = 1;
/** Overlay windows replace a strip only when the strip would take more than
 *  this share of the main camera's area. */
const OVERLAY_MIN_GAIN = 0.03;
/** Candidates whose scores differ by less than this share are equal, so the
 *  tie-break rules (bottom row first, frame-like shape) decide. */
const SCORE_TIE_TOLERANCE = 0.01;
/** Margin of overlay windows from the main picture's edges and between each
 *  other, as a share of the main picture height. */
export const OVERLAY_MARGIN_SHARE = 0.025;

export const VIEWER_TILE_GAP_PX = 2;
export const VIEWER_MIN_THUMB_HEIGHT_PX = 72;

/** Smallest preferred height of a smaller camera in an output frame. Relative
 *  to the frame so 720p and 1080p exports of one clip look the same. */
export function outputMinThumbHeight(width: number, height: number): number {
    return Math.min(width, height) / 15;
}

const FALLBACK_ASPECT = 16 / 9;

function sanitizeAspect(aspect: number): number {
    return Number.isFinite(aspect) && aspect > 0 ? aspect : FALLBACK_ASPECT;
}

function clampThumbScale(scale: number): number {
    return Math.min(THUMB_SCALE_MAX, Math.max(THUMB_SCALE_MIN, scale));
}

/**
 * Lays out the requested cameras. A frame without area, or no cameras,
 * yields zero-size tiles at the frame origin so callers never special-case it.
 */
export function computeCameraLayout(request: CameraLayoutRequest): CameraLayout {
    const width = Math.max(0, request.width);
    const height = Math.max(0, request.height);
    const cameras = request.cameras.map((camera) => ({ ...camera, aspect: sanitizeAspect(camera.aspect) }));
    if (cameras.length === 0 || width <= 0 || height <= 0) {
        return {
            tiles: cameras.map((camera, index) => ({
                channel: camera.channel,
                role: cameras.length === 1 || request.mode === "equal" ? "equal" : index === 0 ? "main" : "thumb",
                overlay: false,
                x: 0,
                y: 0,
                w: 0,
                h: 0,
            })),
            bounds: { x: 0, y: 0, w: 0, h: 0 },
            strip: null,
        };
    }
    const gap = Math.max(0, request.gap);
    if (request.mode === "equal" || cameras.length === 1) {
        const role: CameraTileRole = cameras.length === 1 && request.mode === "main" ? "main" : "equal";
        return layoutEqual(width, height, cameras, gap, role);
    }
    return layoutMain(width, height, cameras, gap, request);
}

/* ------------------------------- equal mode ------------------------------- */

/** Ordered splits of `count` items into groups, larger first groups first so
 *  a tie keeps the fuller row on top. */
function compositions(count: number): number[][] {
    if (count === 0) return [[]];
    const out: number[][] = [];
    for (let first = count; first >= 1; first--) {
        for (const rest of compositions(count - first)) out.push([first, ...rest]);
    }
    return out;
}

interface EqualCandidate {
    tiles: LayoutRect[];
    bounds: LayoutRect;
    area: number;
    lines: number;
    perLine: number;
}

/** Cameras in rows (or columns, `vertical`) of one shared height, line sizes
 *  from `groups`. Returns null when the frame cannot hold the arrangement. */
function equalCandidate(
    width: number,
    height: number,
    aspects: readonly number[],
    groups: readonly number[],
    gap: number,
    vertical: boolean,
): EqualCandidate | null {
    const lines: number[][] = [];
    let next = 0;
    for (const size of groups) {
        lines.push(aspects.slice(next, next + size));
        next += size;
    }
    // Shared tile height h: a row needs h*sum(aspects) plus gaps of width; a
    // column of k tiles needs k*h plus gaps of height and is as wide as its
    // widest tile.
    let tileHeight: number;
    if (!vertical) {
        tileHeight = (height - gap * (lines.length - 1)) / lines.length;
        for (const line of lines) {
            const sum = line.reduce((a, b) => a + b, 0);
            tileHeight = Math.min(tileHeight, (width - gap * (line.length - 1)) / sum);
        }
    } else {
        const widest = lines.reduce((sum, line) => sum + Math.max(...line), 0);
        tileHeight = (width - gap * (lines.length - 1)) / widest;
        for (const line of lines) {
            tileHeight = Math.min(tileHeight, (height - gap * (line.length - 1)) / line.length);
        }
    }
    if (!(tileHeight > 0)) return null;
    const tiles: LayoutRect[] = [];
    let boundsW: number;
    let boundsH: number;
    if (!vertical) {
        const rowWidths = lines.map((line) => line.reduce((a, b) => a + b * tileHeight, 0) + gap * (line.length - 1));
        boundsW = Math.max(...rowWidths);
        boundsH = tileHeight * lines.length + gap * (lines.length - 1);
        let y = 0;
        lines.forEach((line, row) => {
            let x = (boundsW - rowWidths[row]!) / 2;
            for (const aspect of line) {
                tiles.push({ x, y, w: aspect * tileHeight, h: tileHeight });
                x += aspect * tileHeight + gap;
            }
            y += tileHeight + gap;
        });
    } else {
        const columnWidths = lines.map((line) => Math.max(...line) * tileHeight);
        const columnHeights = lines.map((line) => line.length * tileHeight + gap * (line.length - 1));
        boundsW = columnWidths.reduce((a, b) => a + b, 0) + gap * (lines.length - 1);
        boundsH = Math.max(...columnHeights);
        let x = 0;
        lines.forEach((line, column) => {
            let y = (boundsH - columnHeights[column]!) / 2;
            for (const aspect of line) {
                const w = aspect * tileHeight;
                tiles.push({ x: x + (columnWidths[column]! - w) / 2, y, w, h: tileHeight });
                y += tileHeight + gap;
            }
            x += columnWidths[column]! + gap;
        });
    }
    const area = aspects.reduce((sum, aspect) => sum + aspect * tileHeight * tileHeight, 0);
    return {
        tiles,
        bounds: { x: 0, y: 0, w: boundsW, h: boundsH },
        area,
        lines: lines.length,
        perLine: Math.max(...groups),
    };
}

function shapeDistance(bounds: LayoutRect, width: number, height: number): number {
    return Math.abs(Math.log(bounds.w / bounds.h / (width / height)));
}

function isBetterEqual(candidate: EqualCandidate, best: EqualCandidate, width: number, height: number): boolean {
    if (candidate.area > best.area * (1 + SCORE_TIE_TOLERANCE)) return true;
    if (candidate.area < best.area * (1 - SCORE_TIE_TOLERANCE)) return false;
    const shape = shapeDistance(candidate.bounds, width, height);
    const bestShape = shapeDistance(best.bounds, width, height);
    if (Math.abs(shape - bestShape) > 1e-3) return shape < bestShape;
    const balance = Math.abs(candidate.lines - candidate.perLine);
    const bestBalance = Math.abs(best.lines - best.perLine);
    return balance < bestBalance;
}

function layoutEqual(
    width: number,
    height: number,
    cameras: readonly LayoutCamera[],
    gap: number,
    role: CameraTileRole,
): CameraLayout {
    const aspects = cameras.map((camera) => camera.aspect);
    let best: EqualCandidate | null = null;
    for (const vertical of [false, true]) {
        for (const groups of compositions(cameras.length)) {
            const candidate = equalCandidate(width, height, aspects, groups, gap, vertical);
            if (candidate && (!best || isBetterEqual(candidate, best, width, height))) best = candidate;
        }
    }
    // Gaps alone can exceed a tiny frame; a gapless row always fits.
    const chosen = best ?? equalCandidate(width, height, aspects, [cameras.length], 0, false)!;
    return centered(width, height, {
        tiles: cameras.map((camera, index) => ({
            channel: camera.channel,
            role,
            overlay: false,
            ...chosen.tiles[index]!,
        })),
        bounds: chosen.bounds,
        strip: null,
    });
}

/* -------------------------------- main mode ------------------------------- */

interface MainCandidate {
    strip: CameraStrip;
    main: LayoutRect;
    thumbs: LayoutRect[];
    bounds: LayoutRect;
    mainArea: number;
}

/**
 * Main camera with the smaller ones in a row under it (`bottom`) or a column
 * right of it. The main camera is as large as the frame allows while the
 * smaller ones keep `scale` and `minThumb`; then the smaller ones grow into
 * the space left along the strip, up to `growLimit`. Null when it does not fit.
 */
function stripCandidate(
    strip: "bottom" | "right",
    width: number,
    height: number,
    mainAspect: number,
    thumbAspects: readonly number[],
    gap: number,
    scale: number,
    minThumb: number,
    growLimit: number,
): MainCandidate | null {
    const n = thumbAspects.length;
    const stripGaps = gap * (n - 1);
    // Bottom row: tiles share height t; the row needs t*sum(aspects) of width.
    // Right column: tiles share width t; the column needs t*sum(1/aspects) of height.
    const along = strip === "bottom" ? width : height; // strip length budget
    const across = strip === "bottom" ? height : width; // main + strip budget
    const stripUnit =
        strip === "bottom" ? thumbAspects.reduce((a, b) => a + b, 0) : thumbAspects.reduce((a, b) => a + 1 / b, 0);
    // Main extent along the "across" axis (height for bottom, width for right)
    // and its limit from the other axis.
    const mainLimit = strip === "bottom" ? width / mainAspect : height * mainAspect;
    // In the right column the minimum is a height, the strip unit a width.
    const minThumbExtent = strip === "bottom" ? minThumb : minThumb * Math.max(...thumbAspects);
    let mainExtent = Math.min(mainLimit, (across - gap) / (1 + scale), (along - stripGaps) / (scale * stripUnit));
    let thumbExtent = scale * mainExtent;
    if (thumbExtent < minThumbExtent) {
        if (minThumbExtent * stripUnit + stripGaps > along) return null;
        mainExtent = Math.min(mainLimit, across - gap - minThumbExtent);
        thumbExtent = minThumbExtent;
        if (mainExtent <= 0 || thumbExtent > mainExtent * THUMB_SCALE_MAX) return null;
    }
    if (!(mainExtent > 0)) return null;
    thumbExtent = Math.max(
        thumbExtent,
        Math.min(across - gap - mainExtent, growLimit * mainExtent, (along - stripGaps) / stripUnit),
    );
    const thumbSizes = thumbAspects.map((aspect) =>
        strip === "bottom" ? { w: aspect * thumbExtent, h: thumbExtent } : { w: thumbExtent, h: thumbExtent / aspect },
    );
    const stripLength = thumbSizes.reduce((sum, size) => sum + (strip === "bottom" ? size.w : size.h), 0) + stripGaps;
    const mainW = strip === "bottom" ? mainAspect * mainExtent : mainExtent;
    const mainH = strip === "bottom" ? mainExtent : mainExtent / mainAspect;
    const thumbs: LayoutRect[] = [];
    let main: LayoutRect;
    let bounds: LayoutRect;
    if (strip === "bottom") {
        const boundsW = Math.max(mainW, stripLength);
        main = { x: (boundsW - mainW) / 2, y: 0, w: mainW, h: mainH };
        let x = (boundsW - stripLength) / 2;
        for (const size of thumbSizes) {
            thumbs.push({ x, y: mainH + gap, ...size });
            x += size.w + gap;
        }
        bounds = { x: 0, y: 0, w: boundsW, h: mainH + gap + thumbExtent };
    } else {
        const boundsH = Math.max(mainH, stripLength);
        main = { x: 0, y: (boundsH - mainH) / 2, w: mainW, h: mainH };
        let y = (boundsH - stripLength) / 2;
        for (const size of thumbSizes) {
            thumbs.push({ x: mainW + gap, y, ...size });
            y += size.h + gap;
        }
        bounds = { x: 0, y: 0, w: mainW + gap + thumbExtent, h: boundsH };
    }
    return { strip, main, thumbs, bounds, mainArea: mainW * mainH };
}

/** Main camera filling the frame with the smaller ones as windows over it:
 *  at stored positions, else stacked up from the bottom-right corner. */
function overlayCandidate(
    width: number,
    height: number,
    mainAspect: number,
    thumbs: readonly LayoutCamera[],
    scale: number,
    minThumb: number,
    positions: Readonly<Partial<Record<Channel, OverlayPosition>>>,
): MainCandidate {
    const mainW = Math.min(width, height * mainAspect);
    const mainH = mainW / mainAspect;
    const main: LayoutRect = { x: 0, y: 0, w: mainW, h: mainH };
    const thumbH = Math.max(scale * mainH, Math.min(minThumb, AUTO_GROW_LIMIT * mainH));
    const margin = OVERLAY_MARGIN_SHARE * mainH;
    const rects: LayoutRect[] = [];
    let columnRight = mainW - margin;
    let columnWidth = 0;
    let stackTop = mainH - margin;
    for (const camera of thumbs) {
        const w = Math.min(camera.aspect * thumbH, mainW);
        const h = w / camera.aspect;
        const stored = positions[camera.channel];
        if (stored) {
            const x = Math.min(Math.max(0, stored.x * mainW), mainW - w);
            const y = Math.min(Math.max(0, stored.y * mainH), mainH - h);
            rects.push({ x, y, w, h });
            continue;
        }
        if (stackTop - h < margin && columnWidth > 0) {
            // The column is full: start the next one to its left.
            columnRight -= columnWidth + margin;
            columnWidth = 0;
            stackTop = mainH - margin;
        }
        rects.push({ x: Math.max(0, columnRight - w), y: Math.max(0, stackTop - h), w, h });
        stackTop -= h + margin;
        columnWidth = Math.max(columnWidth, w);
    }
    return { strip: "overlay", main, thumbs: rects, bounds: { ...main }, mainArea: mainW * mainH };
}

function layoutMain(
    width: number,
    height: number,
    cameras: readonly LayoutCamera[],
    gap: number,
    request: CameraLayoutRequest,
): CameraLayout {
    const [mainCamera, ...thumbCameras] = cameras as [LayoutCamera, ...LayoutCamera[]];
    const thumbAspects = thumbCameras.map((camera) => camera.aspect);
    const scale = request.thumbScale === null ? AUTO_THUMB_SCALE : clampThumbScale(request.thumbScale);
    const growLimit = Math.max(AUTO_GROW_LIMIT, scale);
    const minThumb = Math.max(0, request.minThumbHeight);
    const strips = (min: number): MainCandidate[] =>
        (["bottom", "right"] as const)
            .map((strip) =>
                stripCandidate(strip, width, height, mainCamera.aspect, thumbAspects, gap, scale, min, growLimit),
            )
            .filter((candidate): candidate is MainCandidate => candidate !== null);
    // The minimum size of the smaller cameras is soft: drop it only when no
    // strip can keep it, and then they shrink with the main camera.
    let candidates = strips(minThumb);
    if (candidates.length === 0) candidates = strips(0);
    // Bottom first: on a tie the row under the main camera wins.
    let best: MainCandidate | null = null;
    for (const candidate of candidates) {
        if (!best || candidate.mainArea > best.mainArea * (1 + SCORE_TIE_TOLERANCE)) best = candidate;
    }
    if (request.allowOverlay) {
        const overlay = overlayCandidate(
            width,
            height,
            mainCamera.aspect,
            thumbCameras,
            scale,
            minThumb,
            request.overlayPositions ?? {},
        );
        if (!best || best.mainArea < overlay.mainArea * (1 - OVERLAY_MIN_GAIN)) best = overlay;
    }
    // Only a degenerate frame (gaps wider than the frame) leaves no strip.
    best ??= overlayCandidate(width, height, mainCamera.aspect, thumbCameras, scale, 0, {});
    const chosen = best;
    const tiles: CameraTileLayout[] = [
        { channel: mainCamera.channel, role: "main", overlay: false, ...chosen.main },
        ...thumbCameras.map((camera, index) => ({
            channel: camera.channel,
            role: "thumb" as const,
            overlay: chosen.strip === "overlay",
            ...chosen.thumbs[index]!,
        })),
    ];
    return centered(width, height, { tiles, bounds: chosen.bounds, strip: chosen.strip });
}

/* -------------------------------- helpers -------------------------------- */

function centered(width: number, height: number, layout: CameraLayout): CameraLayout {
    const dx = (width - layout.bounds.w) / 2;
    const dy = (height - layout.bounds.h) / 2;
    return translateLayout(layout, dx, dy);
}

function translateLayout(layout: CameraLayout, dx: number, dy: number): CameraLayout {
    return {
        tiles: layout.tiles.map((tile) => ({ ...tile, x: tile.x + dx, y: tile.y + dy })),
        bounds: { ...layout.bounds, x: layout.bounds.x + dx, y: layout.bounds.y + dy },
        strip: layout.strip,
    };
}

/** The layout uniformly scaled by `factor` and shifted by (dx, dy) - an
 *  output-frame layout shown in a preview box. */
export function scaleCameraLayout(layout: CameraLayout, factor: number, dx = 0, dy = 0): CameraLayout {
    const scaleRect = <T extends LayoutRect>(rect: T): T => ({
        ...rect,
        x: rect.x * factor + dx,
        y: rect.y * factor + dy,
        w: rect.w * factor,
        h: rect.h * factor,
    });
    return { tiles: layout.tiles.map(scaleRect), bounds: scaleRect(layout.bounds), strip: layout.strip };
}

/** Whole-unit rect whose edges round independently, so tiles that touch keep
 *  touching after rounding. */
export function snapLayoutRect(rect: LayoutRect): LayoutRect {
    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    return { x, y, w: Math.round(rect.x + rect.w) - x, h: Math.round(rect.y + rect.h) - y };
}

/**
 * Thumb scale that gives the main camera `mainExtent` (its height under a
 * bottom row, its width beside a right column) when the composition fills the
 * frame along that axis - the inverse a draggable divider needs. Clamped to
 * the supported range.
 */
export function thumbScaleForMainExtent(
    strip: "bottom" | "right",
    width: number,
    height: number,
    gap: number,
    mainExtent: number,
): number {
    const across = strip === "bottom" ? height : width;
    if (!(mainExtent > 0)) return THUMB_SCALE_MAX;
    return clampThumbScale((across - gap - mainExtent) / mainExtent);
}

/** Thumb scale for an overlay window `thumbHeight` tall over a main picture
 *  `mainHeight` tall - the inverse a window resize handle needs. */
export function thumbScaleForOverlayHeight(mainHeight: number, thumbHeight: number): number {
    if (!(mainHeight > 0)) return AUTO_THUMB_SCALE;
    return clampThumbScale(thumbHeight / mainHeight);
}

/** Overlay position for a window whose top-left corner sits at (x, y) in a
 *  layout whose main tile is `main`. */
export function overlayPositionFor(main: LayoutRect, x: number, y: number): OverlayPosition {
    return {
        x: main.w > 0 ? Math.min(1, Math.max(0, (x - main.x) / main.w)) : 0,
        y: main.h > 0 ? Math.min(1, Math.max(0, (y - main.y) / main.h)) : 0,
    };
}

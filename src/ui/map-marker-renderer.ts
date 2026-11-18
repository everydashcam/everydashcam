import { drawRadarArrow, type RadarTheme } from "../map-radar.js";
import { mapMarkerAppearanceKey, type MapMarkerAppearance, type MapMarkerShape } from "./map-marker-pref.js";
import motorcycleOverheadSpriteUrl from "../assets/map-markers/motorcycle-overhead.webp?no-inline";
import motorcycleSpriteUrl from "../assets/map-markers/motorcycle.webp?no-inline";
import sedanOverheadSpriteUrl from "../assets/map-markers/sedan-overhead.webp?no-inline";
import sedanSpriteUrl from "../assets/map-markers/sedan.webp?no-inline";
import suvOverheadSpriteUrl from "../assets/map-markers/suv-overhead.webp?no-inline";
import suvSpriteUrl from "../assets/map-markers/suv.webp?no-inline";
import truckOverheadSpriteUrl from "../assets/map-markers/truck-overhead.webp?no-inline";
import truckSpriteUrl from "../assets/map-markers/truck.webp?no-inline";
import vanOverheadSpriteUrl from "../assets/map-markers/van-overhead.webp?no-inline";
import vanSpriteUrl from "../assets/map-markers/van.webp?no-inline";

const RENDER_SIZE = 192;
const VEHICLE_PADDING = 8;

type VehicleShape = Exclude<MapMarkerShape, "arrow">;
export type MapMarkerView = "overhead" | "perspective";

const VEHICLE_SPRITE_URLS = {
    perspective: {
        sedan: sedanSpriteUrl,
        suv: suvSpriteUrl,
        motorcycle: motorcycleSpriteUrl,
        van: vanSpriteUrl,
        truck: truckSpriteUrl,
    },
    overhead: {
        sedan: sedanOverheadSpriteUrl,
        suv: suvOverheadSpriteUrl,
        motorcycle: motorcycleOverheadSpriteUrl,
        van: vanOverheadSpriteUrl,
        truck: truckOverheadSpriteUrl,
    },
} as const satisfies Record<MapMarkerView, Record<VehicleShape, string>>;

const sourcePromises = new Map<string, Promise<HTMLImageElement>>();
const renderCache = new Map<string, Promise<HTMLCanvasElement>>();
const MAX_RENDER_CACHE_ENTRIES = 48;
const PITCH_FORESHORTENING_STRENGTH = 0.14;
const PERSPECTIVE_MIN_PITCH_DEG = 20;

export function mapMarkerViewForPitch(pitchDeg: number): MapMarkerView {
    return Number.isFinite(pitchDeg) && pitchDeg >= PERSPECTIVE_MIN_PITCH_DEG ? "perspective" : "overhead";
}

export function mapMarkerRenderKey(
    appearance: MapMarkerAppearance,
    view: MapMarkerView = "perspective",
    radar?: RadarTheme,
): string {
    const key = mapMarkerAppearanceKey(appearance);
    if (radar && appearance.shape === "arrow") return `${key}:${radar}`;
    return appearance.shape !== "arrow" && view === "overhead" ? `${key}:overhead` : key;
}

function loadVehicleSource(shape: VehicleShape, view: MapMarkerView): Promise<HTMLImageElement> {
    const key = `${shape}:${view}`;
    const cached = sourcePromises.get(key);
    if (cached) return cached;
    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.addEventListener("load", () => resolve(image), { once: true });
        image.addEventListener("error", () => reject(new Error(`map marker asset failed to load: ${key}`)), {
            once: true,
        });
        image.src = VEHICLE_SPRITE_URLS[view][shape];
    });
    sourcePromises.set(key, promise);
    return promise;
}

function hexToRgb(color: string): [number, number, number] {
    return [
        Number.parseInt(color.slice(1, 3), 16),
        Number.parseInt(color.slice(3, 5), 16),
        Number.parseInt(color.slice(5, 7), 16),
    ];
}

function rgbToHsl(red: number, green: number, blue: number): [number, number, number] {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    if (max === min) return [0, 0, lightness];
    const delta = max - min;
    const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    let hue = 0;
    if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
    else if (max === g) hue = ((b - r) / delta + 2) / 6;
    else hue = ((r - g) / delta + 4) / 6;
    return [hue * 360, saturation, lightness];
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
    const h = (((hue % 360) + 360) % 360) / 360;
    if (saturation === 0) {
        const gray = Math.round(lightness * 255);
        return [gray, gray, gray];
    }
    const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
    const p = 2 * lightness - q;
    const channel = (offset: number): number => {
        let t = h + offset;
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [channel(1 / 3), channel(0), channel(-1 / 3)].map((value) => Math.round(value * 255)) as [
        number,
        number,
        number,
    ];
}

export function recolorMapMarkerBodyPixel(
    red: number,
    green: number,
    blue: number,
    color: string,
): [number, number, number] {
    const [targetRed, targetGreen, targetBlue] = hexToRgb(color);
    const [targetHue, targetSaturation, targetLightness] = rgbToHsl(targetRed, targetGreen, targetBlue);
    const [, saturation, lightness] = rgbToHsl(red, green, blue);
    // Preserve part of the source paint's shading, but let the chosen color
    // drive most of the result. This keeps highlights/creases dimensional while
    // making custom white and black meaningfully light and dark.
    const adjustedLightness = Math.max(0.035, Math.min(0.96, lightness * 0.35 + targetLightness * 0.65));
    const adjustedSaturation = targetSaturation < 0.06 ? 0 : Math.min(1, targetSaturation * (0.78 + saturation * 0.22));
    return hslToRgb(targetHue, adjustedSaturation, adjustedLightness);
}

export function isMapMarkerBodyPixel(red: number, green: number, blue: number): boolean {
    const [hue, saturation] = rgbToHsl(red, green, blue);
    return hue >= 195 && hue <= 255 && saturation >= 0.34 && blue > red * 1.16 && blue > green * 1.04;
}

/**
 * Mild screen-space foreshortening for a marker over a pitched map. A literal
 * cos(pitch) projection makes it nearly unreadable at the 58-70° chase angles,
 * so blend only a hint toward that physical projection. The vehicle art has
 * baked volume already; a stronger second perspective looks double-tilted.
 */
export function mapMarkerPitchScale(pitchDeg: number): number {
    const pitch = Math.max(0, Math.min(70, Number.isFinite(pitchDeg) ? pitchDeg : 0));
    const projected = Math.cos((pitch * Math.PI) / 180);
    return 1 - (1 - projected) * PITCH_FORESHORTENING_STRENGTH;
}

function recolorVehicle(context: CanvasRenderingContext2D, color: string): void {
    const pixels = context.getImageData(0, 0, RENDER_SIZE, RENDER_SIZE);
    for (let index = 0; index < pixels.data.length; index += 4) {
        const red = pixels.data[index]!;
        const green = pixels.data[index + 1]!;
        const blue = pixels.data[index + 2]!;
        if (pixels.data[index + 3]! < 8 || !isMapMarkerBodyPixel(red, green, blue)) continue;
        const [nextRed, nextGreen, nextBlue] = recolorMapMarkerBodyPixel(red, green, blue, color);
        pixels.data[index] = nextRed;
        pixels.data[index + 1] = nextGreen;
        pixels.data[index + 2] = nextBlue;
    }
    context.putImageData(pixels, 0, 0);
}

function drawArrow(context: CanvasRenderingContext2D, color: string): void {
    const [red, green, blue] = hexToRgb(color);
    const mix = (target: number, amount: number): string =>
        `rgb(${[red, green, blue].map((channel) => Math.round(channel + (target - channel) * amount)).join(",")})`;
    const arrowPath = (offsetY = 0): void => {
        context.beginPath();
        context.moveTo(96, 13 + offsetY);
        context.bezierCurveTo(99, 14 + offsetY, 101, 17 + offsetY, 103, 21 + offsetY);
        context.lineTo(159, 151 + offsetY);
        context.bezierCurveTo(163, 160 + offsetY, 154, 169 + offsetY, 145, 164 + offsetY);
        context.lineTo(96, 140 + offsetY);
        context.lineTo(47, 164 + offsetY);
        context.bezierCurveTo(38, 169 + offsetY, 29, 160 + offsetY, 33, 151 + offsetY);
        context.lineTo(89, 21 + offsetY);
        context.bezierCurveTo(91, 17 + offsetY, 93, 14 + offsetY, 96, 13 + offsetY);
        context.closePath();
    };

    context.lineJoin = "round";
    context.lineCap = "round";
    context.save();
    context.filter = "blur(7px)";
    context.globalAlpha = 0.42;
    context.fillStyle = "#050706";
    arrowPath(10);
    context.fill();
    context.restore();

    arrowPath(7);
    context.fillStyle = "#151a18";
    context.strokeStyle = "rgba(255,255,255,.94)";
    context.lineWidth = 11;
    context.stroke();
    context.fill();

    const paint = context.createLinearGradient(45, 40, 151, 157);
    paint.addColorStop(0, mix(255, 0.34));
    paint.addColorStop(0.42, color);
    paint.addColorStop(1, mix(0, 0.38));
    arrowPath();
    context.fillStyle = paint;
    context.strokeStyle = "#101412";
    context.lineWidth = 5;
    context.stroke();
    context.fill();

    const bevel = context.createLinearGradient(58, 33, 132, 149);
    bevel.addColorStop(0, "rgba(255,255,255,.48)");
    bevel.addColorStop(0.45, "rgba(255,255,255,.08)");
    bevel.addColorStop(1, "rgba(0,0,0,.25)");
    context.beginPath();
    context.moveTo(96, 25);
    context.lineTo(146, 146);
    context.lineTo(96, 122);
    context.lineTo(46, 146);
    context.closePath();
    context.strokeStyle = bevel;
    context.lineWidth = 5;
    context.stroke();

    context.beginPath();
    context.moveTo(92, 25);
    context.lineTo(43, 145);
    context.strokeStyle = "rgba(255,255,255,.56)";
    context.lineWidth = 3;
    context.stroke();

    context.beginPath();
    context.moveTo(99, 31);
    context.lineTo(140, 132);
    context.strokeStyle = "rgba(255,255,255,.14)";
    context.lineWidth = 3;
    context.stroke();
}

async function buildRenderedMarker(
    appearance: MapMarkerAppearance,
    view: MapMarkerView,
    radar?: RadarTheme,
): Promise<HTMLCanvasElement> {
    const canvas = document.createElement("canvas");
    canvas.width = RENDER_SIZE;
    canvas.height = RENDER_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: appearance.shape !== "arrow" });
    if (!context) throw new Error("map marker canvas context unavailable");
    if (appearance.shape === "arrow") {
        if (radar) drawRadarArrow(context, RENDER_SIZE, appearance.color, radar);
        else drawArrow(context, appearance.color);
        return canvas;
    }
    let image: HTMLImageElement;
    try {
        image = await loadVehicleSource(appearance.shape, view);
    } catch {
        drawArrow(context, appearance.color);
        return canvas;
    }
    const scale = Math.min(
        (RENDER_SIZE - VEHICLE_PADDING * 2) / image.naturalWidth,
        (RENDER_SIZE - VEHICLE_PADDING * 2) / image.naturalHeight,
    );
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, (RENDER_SIZE - width) / 2, (RENDER_SIZE - height) / 2, width, height);
    recolorVehicle(context, appearance.color);
    return canvas;
}

export function renderMapMarkerImage(
    appearance: MapMarkerAppearance,
    view: MapMarkerView = "perspective",
    radar?: RadarTheme,
): Promise<HTMLCanvasElement> {
    const key = mapMarkerRenderKey(appearance, view, radar);
    const cached = renderCache.get(key);
    if (cached) return cached;
    const rendered = buildRenderedMarker(appearance, view, radar);
    if (renderCache.size >= MAX_RENDER_CACHE_ENTRIES) {
        const oldestKey = renderCache.keys().next().value;
        if (typeof oldestKey === "string") renderCache.delete(oldestKey);
    }
    renderCache.set(key, rendered);
    return rendered;
}

export async function renderMapMarkerIntoCanvas(
    canvas: HTMLCanvasElement,
    appearance: MapMarkerAppearance,
    view: MapMarkerView = "perspective",
    radar?: RadarTheme,
): Promise<void> {
    const key = mapMarkerRenderKey(appearance, view, radar);
    canvas.dataset.markerRenderKey = key;
    const image = await renderMapMarkerImage(appearance, view, radar);
    if (canvas.dataset.markerRenderKey !== key) return;
    canvas.width = RENDER_SIZE;
    canvas.height = RENDER_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, RENDER_SIZE, RENDER_SIZE);
    context.drawImage(image, 0, 0);
}

export async function drawMapMarker(
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    appearance: MapMarkerAppearance,
    cx: number,
    cy: number,
    bearingDeg: number,
    sizePx: number,
    pitchDeg = 0,
    radar?: RadarTheme,
): Promise<void> {
    const image = await renderMapMarkerImage(appearance, mapMarkerViewForPitch(pitchDeg), radar);
    context.save();
    context.translate(cx, cy);
    // Screen-space Y compression happens after local rotation, matching the
    // perspective of the pitched map plane for every marker heading.
    context.scale(1, mapMarkerPitchScale(pitchDeg));
    context.rotate((bearingDeg * Math.PI) / 180);
    context.drawImage(image, -sizePx / 2, -sizePx / 2, sizePx, sizePx);
    context.restore();
}

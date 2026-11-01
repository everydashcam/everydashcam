// Colour ramps mixed in OKLab. Canvas compositing (globalAlpha) blends in
// sRGB, which on the way from a neutral grey drags a red towards pink and a
// green towards mint. Mixing in OKLab from a neutral keeps the target's hue at
// every step, so a ramp only gains chroma and moves in lightness.
// Conversion matrices: https://bottosson.github.io/posts/oklab/

/** An opaque sRGB colour, 0-255 per channel. */
export type Rgb = readonly [red: number, green: number, blue: number];

type Oklab = readonly [lightness: number, a: number, b: number];

const HEX_RGB_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** Parses "#rrggbb", the form a canvas returns for an opaque fillStyle.
 *  Null for any other syntax, including colours with alpha. */
export function parseHexRgb(color: string): Rgb | null {
    const match = HEX_RGB_RE.exec(color.trim());
    if (!match) return null;
    return [Number.parseInt(match[1]!, 16), Number.parseInt(match[2]!, 16), Number.parseInt(match[3]!, 16)];
}

/** `top` painted at `alpha` over `base`, as canvas source-over compositing does. */
export function compositeOver(top: Rgb, alpha: number, base: Rgb): Rgb {
    return [
        base[0] + (top[0] - base[0]) * alpha,
        base[1] + (top[1] - base[1]) * alpha,
        base[2] + (top[2] - base[2]) * alpha,
    ];
}

/** `steps + 1` "#rrggbb" colours from `from` (index 0) to `to` (index
 *  `steps`), evenly spaced in OKLab. `steps` must be at least 1. */
export function oklabRamp(from: Rgb, to: Rgb, steps: number): string[] {
    const start = rgbToOklab(from);
    const end = rgbToOklab(to);
    const ramp: string[] = [];
    for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        ramp.push(
            rgbToHex(
                oklabToRgb([
                    start[0] + (end[0] - start[0]) * t,
                    start[1] + (end[1] - start[1]) * t,
                    start[2] + (end[2] - start[2]) * t,
                ]),
            ),
        );
    }
    return ramp;
}

function toLinear(channel: number): number {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(channel: number): number {
    // A mix of two in-gamut colours can land a hair outside sRGB.
    const c = Math.min(1, Math.max(0, channel));
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
}

function rgbToOklab(rgb: Rgb): Oklab {
    const r = toLinear(rgb[0]);
    const g = toLinear(rgb[1]);
    const b = toLinear(rgb[2]);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
}

function oklabToRgb([lightness, a, b]: Oklab): Rgb {
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
        fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
}

function rgbToHex(rgb: Rgb): string {
    return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

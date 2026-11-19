#!/usr/bin/env node
// Renders src/assets/map-theme-previews.webp, the sheet behind the map theme
// gallery in settings: one cell per MAP_THEME_CHOICES entry, in that order,
// all showing the same turn of Seyfullin Avenue in Almaty so the palettes
// compare like for like.
//
// The cells come from the app's own code: a Vite dev server serves the source
// modules, and headless Chromium imports them into the app page. Each cell is
// a mini-map at the cell's size - the inset style, route, flags and car - and
// radar palettes go through the export's ring compositor. Neon sits on the
// opaque ground full-size maps give it. "auto" splits the light and dark cells
// diagonally.
//
// WHEN TO RE-RUN: after adding or reordering a map theme, or after a visible
// change to map palettes, the route or the marker. Then review the image and
// update the settings-map-previews VRT baseline.
//
// NETWORK: map tiles, glyphs and sprites come from OpenFreeMap at run time,
// so the output follows the current OpenStreetMap data at this spot.
//
// PRECONDITIONS: Playwright's pinned Chromium
// (`npx playwright install --no-shell chromium`); WebGL must work headless.
//
// MANUAL RUN: npm run build:map-theme-previews
//
// CLI diagnostics go through console.* - this is a scripts/ CLI, not src/.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(ROOT, "src/assets/map-theme-previews.webp");
const PORT = 5297;

// The settings card shows 8:5 previews; cells are rendered at 2x for dense screens.
const CELL = { width: 192, height: 120, scale: 2 };
const WEBP_QUALITY = 0.86;
// Width of the ground each cell shows around the car.
const ZOOM_KM = 0.7;

// One carriageway of Seyfullin Avenue, south to north through the bend before
// the railway bridge (OpenStreetMap geometry, rounded to 1e-5 degrees).
const ROUTE = [
    [76.9309, 43.26896],
    [76.93083, 43.26971],
    [76.93056, 43.27192],
    [76.93048, 43.27244],
    [76.93037, 43.27305],
    [76.93032, 43.27341],
    [76.93028, 43.27395],
    [76.93029, 43.27419],
    [76.93034, 43.27439],
    [76.93038, 43.2745],
    [76.93049, 43.27466],
    [76.93067, 43.27488],
    [76.93089, 43.27513],
    [76.93138, 43.27561],
    [76.93159, 43.27585],
    [76.93191, 43.27618],
    [76.93243, 43.27695],
    [76.93291, 43.27769],
    [76.93427, 43.27969],
];
// The car sits in the bend, where the route turns from north to north-east.
const CAR_INDEX = 10;

const server = await createServer({
    root: ROOT,
    configFile: resolve(ROOT, "vite.config.ts"),
    logLevel: "error",
    server: { port: PORT, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({ channel: "chromium" });
try {
    const context = await browser.newContext({
        serviceWorkers: "block",
        deviceScaleFactor: CELL.scale,
        viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => console.error("[page]", error.message));
    await page.goto(`http://localhost:${PORT}/en/`);
    const dataUrl = await page.evaluate(renderSheet, {
        route: ROUTE,
        carIndex: CAR_INDEX,
        zoomKm: ZOOM_KM,
        cell: CELL,
        quality: WEBP_QUALITY,
    });
    const prefix = "data:image/webp;base64,";
    if (!dataUrl.startsWith(prefix)) throw new Error("browser did not encode webp");
    const bytes = Buffer.from(dataUrl.slice(prefix.length), "base64");
    writeFileSync(OUTPUT, bytes);
    console.log(`build-map-theme-previews: wrote ${OUTPUT} (${bytes.length} bytes)`);
} finally {
    await browser.close();
    await server.close();
}

/**
 * Runs in the page; dynamic imports resolve against the dev server's sources.
 * Each cell is drawn the way the player's mini-map draws itself, at the cell's
 * own size: the inset style, route, flags and marker sized by the inset table,
 * and radar palettes in the export's ring compositor.
 */
async function renderSheet({ route, carIndex, zoomKm, cell, quality }) {
    const { composeMapStyle } = await import("/src/ui/map-appearance.ts");
    const { loadMaplibre, loadMapStyle } = await import("/src/ui/viewer-map-registry.ts");
    const { MAP_THEME_CHOICES } = await import("/src/ui/map-view-pref.ts");
    const { DEFAULT_MAP_MARKER_APPEARANCE, markerForMapTheme } = await import("/src/ui/map-marker-pref.ts");
    const { drawMapMarker } = await import("/src/ui/map-marker-renderer.ts");
    const { drawEndpointFlag } = await import("/src/ui/map-endpoint-flag.ts");
    const { insetFlagHeightPx, insetMarkerSizePx, insetTrackWidthPx } = await import("/src/ui/map-inset-scale.ts");
    const { addSpeedTrack } = await import("/src/ui/map-track.ts");
    const { buildMercatorCumulativeDistances, buildSpeedGradient } = await import("/src/ui/speed-gradient.ts");
    const { radarSpec, radarTheme } = await import("/src/map-radar.ts");
    const { isTranslucentMapTheme, mapThemeColors, themeColors } = await import("/src/ui/theme.ts");
    const { drawMapOverlay } = await import("/src/transcode/map-overlay.ts");
    const { zoomForDiameterKm } = await import("/src/coordinates.ts");
    const maplibre = await loadMaplibre();

    const toRadians = (deg) => (deg * Math.PI) / 180;
    const bearing = ([lon1, lat1], [lon2, lat2]) => {
        const y = Math.sin(toRadians(lon2 - lon1)) * Math.cos(toRadians(lat2));
        const x =
            Math.cos(toRadians(lat1)) * Math.sin(toRadians(lat2)) -
            Math.sin(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.cos(toRadians(lon2 - lon1));
        return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    };
    // Speeds rise through the bend so the route shows its colour ramp.
    const records = route.map(([lon, lat], index) => ({
        unixSeconds: 1_700_000_000 + index * 4,
        active: true,
        lat,
        lon,
        bearingDeg: bearing(route[Math.max(0, index - 1)], route[Math.min(route.length - 1, index + 1)]),
        speedMs: 6 + index * 1.4,
        speedSource: "measured",
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename: "preview.mp4",
    }));
    const { cumDist, total } = buildMercatorCumulativeDistances(records);
    const track = { coords: route, gradient: buildSpeedGradient(records, cumDist, total) };
    const car = records[carIndex];
    const scale = window.devicePixelRatio;

    /** The inset map, `width` x `height` CSS px, with its route, flags and car. */
    async function renderInset(theme, width, height) {
        const radar = radarTheme(theme);
        const base = await loadMapStyle(theme, false, "preview", "openfreemap");
        if (!base) throw new Error(`map style ${theme} did not load`);
        const host = document.createElement("div");
        host.style.cssText = `position:fixed;left:-9999px;top:0;width:${width}px;height:${height}px`;
        document.body.append(host);
        const map = new maplibre.Map({
            container: host,
            style: composeMapStyle(base, { theme, preset: "classic", labelScale: 1, labelDensity: "standard" }, "mini"),
            center: [car.lon, car.lat],
            zoom: zoomForDiameterKm(car.lat, zoomKm, width),
            interactive: false,
            attributionControl: false,
            fadeDuration: 0,
            canvasContextAttributes: { preserveDrawingBuffer: true },
        });
        try {
            await new Promise((done) => map.once("style.load", done));
            addSpeedTrack(map, track, {
                sourceId: "preview-track",
                width: insetTrackWidthPx(height),
                opacity: 0.95,
                endpointDots: radar && radarSpec(radar).endpointDots,
            });
            await new Promise((done) => map.once("idle", done));
            const canvas = document.createElement("canvas");
            canvas.width = width * scale;
            canvas.height = height * scale;
            const context = canvas.getContext("2d");
            if (isTranslucentMapTheme(theme)) {
                context.fillStyle = mapThemeColors(theme).background;
                context.fillRect(0, 0, canvas.width, canvas.height);
            }
            context.drawImage(map.getCanvas(), 0, 0, canvas.width, canvas.height);
            context.scale(scale, scale);
            if (!radar) {
                const colors = themeColors();
                const stroke = mapThemeColors(theme).markerStroke;
                for (const [kind, point, fill] of [
                    ["start", route[0], colors.markerStart],
                    ["end", route[route.length - 1], colors.markerEnd],
                ]) {
                    const { x, y } = map.project(point);
                    drawEndpointFlag(context, kind, { fill, stroke }, x, y, insetFlagHeightPx(height));
                }
            }
            const marker = markerForMapTheme({ theme, marker: DEFAULT_MAP_MARKER_APPEARANCE });
            await drawMapMarker(
                context,
                marker,
                width / 2,
                height / 2,
                car.bearingDeg,
                insetMarkerSizePx(height, marker.size, radar !== undefined),
                0,
                radar,
            );
            return canvas;
        } finally {
            map.remove();
            host.remove();
        }
    }

    const width = cell.width * scale;
    const height = cell.height * scale;
    async function renderCell(theme) {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        const radar = radarTheme(theme);
        if (!radar) {
            context.drawImage(await renderInset(theme, cell.width, cell.height), 0, 0);
            return canvas;
        }
        // The export compositor sizes its slot as a quarter of the frame width.
        const frameWidth = height * 4;
        drawMapOverlay(context, await renderInset(theme, cell.height, cell.height), frameWidth, height, {
            radar,
            xPct: (width - height) / 2 / frameWidth,
            yPct: 0,
            scalePct: 100,
            shape: "circle",
        });
        return canvas;
    }

    const sheet = document.createElement("canvas");
    sheet.width = width * MAP_THEME_CHOICES.length;
    sheet.height = height;
    const context = sheet.getContext("2d");
    const cells = new Map();
    for (const theme of MAP_THEME_CHOICES) {
        if (theme !== "auto") cells.set(theme, await renderCell(theme));
    }
    MAP_THEME_CHOICES.forEach((theme, index) => {
        const left = index * width;
        if (theme !== "auto") {
            context.drawImage(cells.get(theme), left, 0);
            return;
        }
        // The interface decides between the two plain palettes.
        context.drawImage(cells.get("light"), left, 0);
        context.save();
        context.beginPath();
        context.moveTo(left + width * 0.62, 0);
        context.lineTo(left + width, 0);
        context.lineTo(left + width, height);
        context.lineTo(left + width * 0.38, height);
        context.closePath();
        context.clip();
        context.drawImage(cells.get("dark"), left, 0);
        context.restore();
    });
    return sheet.toDataURL("image/webp", quality);
}

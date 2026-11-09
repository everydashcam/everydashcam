// Transient route map for the loose-GPX assignment dialog. The local SVG is
// immediate and remains the offline/WebGL fallback; MapLibre replaces it with
// geographic context when the regular map stack is available.

import type * as maplibregl from "maplibre-gl";

import { probeWebGL } from "../capabilities.js";
import { projectTrackToViewport, unwrapTrackCoordinates } from "../coordinates.js";
import { createLogger } from "../log.js";
import { isValidGpsFix } from "../parser.js";
import type { GpsRecord } from "../parsers/types.js";
import { applyViewerMapStyle, loadMaplibre, loadMapStyle } from "./viewer-map-registry.js";
import { MapAttributionControl } from "./map-attribution-control.js";
import { getMapProvider, mapProviderErrorKey } from "./map-provider.js";
import { transformMapTileRequest } from "./map-tile-cache.js";
import { currentMapTheme, getCssVar } from "./theme.js";

const log = createLogger("gpx-route-preview");

const ROUTE_SOURCE_ID = "gpx-assignment-route";
const ROUTE_LINE_LAYER_ID = "gpx-assignment-route-line";
const ROUTE_POINT_LAYER_ID = "gpx-assignment-route-points";
const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_WIDTH = 640;
const SVG_HEIGHT = 360;
const SVG_PADDING = 36;
const MAX_PREVIEW_POINTS = 5000;

type PreviewCoordinate = [number, number];

function previewCoordinates(records: readonly GpsRecord[]): PreviewCoordinate[] {
    const coords: PreviewCoordinate[] = [];
    for (const record of records) {
        if (!isValidGpsFix(record)) continue;
        const previous = coords[coords.length - 1];
        if (previous && previous[0] === record.lon && previous[1] === record.lat) continue;
        coords.push([record.lon, record.lat]);
    }
    const unwrapped = unwrapTrackCoordinates(coords);
    if (unwrapped.length <= MAX_PREVIEW_POINTS) return unwrapped;
    const stride = Math.ceil(coords.length / MAX_PREVIEW_POINTS);
    const reduced = unwrapped.filter((_, index) => index % stride === 0);
    const last = unwrapped[unwrapped.length - 1]!;
    if (reduced[reduced.length - 1] !== last) reduced.push(last);
    return reduced;
}

function routeData(coords: readonly PreviewCoordinate[]): maplibregl.GeoJSONSourceSpecification["data"] {
    const first = coords[0];
    const last = coords[coords.length - 1];
    const features: Array<{
        type: "Feature";
        properties: { kind: "route" | "endpoint" };
        geometry:
            | { type: "LineString"; coordinates: PreviewCoordinate[] }
            | { type: "Point"; coordinates: PreviewCoordinate };
    }> = [];
    if (coords.length >= 2) {
        features.push({
            type: "Feature",
            properties: { kind: "route" },
            geometry: { type: "LineString", coordinates: [...coords] },
        });
    }
    if (first) {
        features.push({
            type: "Feature",
            properties: { kind: "endpoint" },
            geometry: { type: "Point", coordinates: first },
        });
    }
    if (last && last !== first) {
        features.push({
            type: "Feature",
            properties: { kind: "endpoint" },
            geometry: { type: "Point", coordinates: last },
        });
    }
    return { type: "FeatureCollection", features };
}

function appendEndpoint(svg: SVGSVGElement, x: number, y: number): void {
    const point = document.createElementNS(SVG_NS, "circle");
    point.classList.add("gpx-assignment-map-fallback__endpoint");
    point.setAttribute("cx", x.toFixed(2));
    point.setAttribute("cy", y.toFixed(2));
    point.setAttribute("r", "6");
    svg.appendChild(point);
}

function renderFallback(host: HTMLElement, coords: readonly PreviewCoordinate[]): void {
    host.querySelector(".gpx-assignment-map-fallback")?.remove();
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("gpx-assignment-map-fallback");
    svg.setAttribute("viewBox", `0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("aria-hidden", "true");
    host.prepend(svg);
    if (coords.length === 0) return;

    const points = projectTrackToViewport(coords, SVG_WIDTH, SVG_HEIGHT, SVG_PADDING);

    if (points.length >= 2) {
        const route = document.createElementNS(SVG_NS, "polyline");
        route.classList.add("gpx-assignment-map-fallback__route");
        route.setAttribute("points", points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" "));
        svg.appendChild(route);
    }
    appendEndpoint(svg, points[0]![0], points[0]![1]);
    if (points.length >= 2) appendEndpoint(svg, points[points.length - 1]![0], points[points.length - 1]![1]);
}

/** Owns one short-lived WebGL map and its immediate SVG fallback. */
export class GpxRoutePreview {
    private map: maplibregl.Map | null = null;
    private maplibre: typeof import("maplibre-gl") | null = null;
    private coords: PreviewCoordinate[] = [];
    private isReady = false;
    private isDisposed = false;
    private initStarted = false;
    private readonly seenErrors = new Set<string>();

    constructor(private readonly host: HTMLElement) {}

    show(records: readonly GpsRecord[]): void {
        this.coords = previewCoordinates(records);
        renderFallback(this.host, this.coords);
        if (this.isReady) {
            this.syncMapRoute();
            this.host.querySelector(".gpx-assignment-map-fallback")?.remove();
            return;
        }
        if (!this.initStarted && probeWebGL()) {
            this.initStarted = true;
            void this.initMap();
        }
    }

    dispose(): void {
        this.isDisposed = true;
        this.isReady = false;
        this.removeMap();
        this.maplibre = null;
        this.host.replaceChildren();
    }

    private async initMap(): Promise<void> {
        try {
            const theme = currentMapTheme();
            const provider = getMapProvider();
            const [maplibre, loadedStyle] = await Promise.all([
                loadMaplibre(),
                loadMapStyle(theme, false, "preview", provider),
            ]);
            if (this.isDisposed) return;
            // The SVG already provides the route offline. An empty MapLibre
            // canvas adds no geographic context and would draw a second route.
            if (!loadedStyle) return;
            this.maplibre = maplibre;

            const mapHost = document.createElement("div");
            mapHost.className = "gpx-assignment-maplibre";
            this.host.appendChild(mapHost);
            const map = new maplibre.Map({
                container: mapHost,
                style: applyViewerMapStyle(loadedStyle),
                center: this.coords[0] ?? [0, 0],
                zoom: 12,
                interactive: false,
                attributionControl: false,
                fadeDuration: 0,
                refreshExpiredTiles: true,
                crossSourceCollisions: false,
                validateStyle: false,
                transformRequest: transformMapTileRequest,
            });
            this.map = map;
            map.addControl(new MapAttributionControl(provider), "bottom-right");
            map.on("error", (event) => {
                const cause = (event as { error?: unknown }).error;
                const message = cause instanceof Error ? cause.message : String(cause);
                const errorKey = mapProviderErrorKey(cause);
                if (this.seenErrors.has(errorKey)) return;
                this.seenErrors.add(errorKey);
                log.warn("maplibre error", { message });
            });
            map.once("style.load", () => {
                if (this.isDisposed || this.map !== map) return;
                this.isReady = true;
                this.addMapLayers();
                this.syncMapRoute();
                mapHost.classList.add("is-ready");
                this.host.querySelector(".gpx-assignment-map-fallback")?.remove();
            });
        } catch (err) {
            if (this.isDisposed) return;
            log.warn("route preview map unavailable", {
                err: err instanceof Error ? err.message : String(err),
            });
            this.removeMap();
            this.host.querySelector(".gpx-assignment-maplibre")?.remove();
            renderFallback(this.host, this.coords);
        }
    }

    private removeMap(): void {
        const map = this.map;
        this.map = null;
        if (!map) return;
        try {
            map.remove();
        } catch (err) {
            log.warn("route preview cleanup failed", {
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private addMapLayers(): void {
        if (!this.map || this.map.getSource(ROUTE_SOURCE_ID)) return;
        this.map.addSource(ROUTE_SOURCE_ID, {
            type: "geojson",
            data: routeData(this.coords),
        });
        this.map.addLayer({
            id: ROUTE_LINE_LAYER_ID,
            type: "line",
            source: ROUTE_SOURCE_ID,
            filter: ["==", ["get", "kind"], "route"],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": getCssVar("--accent"),
                "line-width": 5,
                "line-opacity": 0.95,
            },
        });
        this.map.addLayer({
            id: ROUTE_POINT_LAYER_ID,
            type: "circle",
            source: ROUTE_SOURCE_ID,
            filter: ["==", ["get", "kind"], "endpoint"],
            paint: {
                "circle-radius": 5,
                "circle-color": getCssVar("--accent"),
                "circle-stroke-color": getCssVar("--bg-elev"),
                "circle-stroke-width": 2,
            },
        });
    }

    private syncMapRoute(): void {
        if (!this.map || !this.maplibre || !this.isReady) return;
        const source = this.map.getSource(ROUTE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
        source?.setData(routeData(this.coords));
        const first = this.coords[0];
        if (!first) return;
        if (this.coords.length === 1) {
            this.map.jumpTo({ center: first, zoom: 14 });
            return;
        }
        const bounds = this.coords.reduce(
            (current, coord) => current.extend(coord),
            new this.maplibre.LngLatBounds(first, first),
        );
        this.map.fitBounds(bounds, { padding: 36, maxZoom: 15, animate: false });
    }
}

// The map of all trips. While no trip is open it fills the viewer: every loaded
// trip is drawn as corridor lines whose width grows with the number of trips,
// trips too small to read fold into counted dots, and the camera starts on the
// whole library. A click on a road chooses a place; the list then keeps the
// trips through it (trip-map-search.ts) and the map stresses their corridors.
// Over an open trip the button by the search lays the same map over the
// player, which stays mounted, paused and inert until the map closes.
// Track geometry comes from trip-map-library.ts; style, provider and recovery
// are shared with the other viewer maps through the registry. The map
// instance lives only while the surface is shown.

import type * as maplibregl from "maplibre-gl";
import type { ExpressionSpecification, GeoJSONSource } from "maplibre-gl";

import { probeWebGL } from "../capabilities.js";
import { t } from "../i18n/index.js";
import { createLogger } from "../log.js";
import { bundleStepForZoom, type TripBundle } from "../trip-map/bundle.js";
import { farDotRadiusPx, foldFarTrips, type FarDot } from "../trip-map/far-dots.js";
import { FOLLOW_FIT_DURATION_MS, FOLLOW_FIT_PADDING_PX, shouldReframe, type ScreenBox } from "../trip-map/follow.js";
import { placeRadiusWorld, type PlaceCircle } from "../trip-map/queries.js";
import type { TripMapTrack } from "../trip-map/track-geometry.js";
import { tripNeedsRecordingMetadata } from "../trips.js";
import {
    emptyBounds,
    extendBounds,
    groundMetersPerWorldUnit,
    isEmptyBounds,
    worldToLat,
    worldToLon,
    worldUnitsPerPixel,
    worldX,
    worldY,
    type WorldBounds,
} from "../trip-map/world.js";
import { getUnits, subscribeUnitsChange } from "../units-pref.js";
import { dom } from "./dom.js";
import { subscribeExportState } from "./export-state.js";
import { formatShortDistance } from "./format.js";
import { MapAttributionControl } from "./map-attribution-control.js";
import { getMapProvider } from "./map-provider.js";
import { transformMapTileRequest } from "./map-tile-cache.js";
import { TRACK_HALO_WIDTH_PX, TRACK_OUTLINE_WIDTH_PX } from "./map-track.js";
import { isMobileLayout, MOBILE_LAYOUT_QUERY, prefersReducedMotion } from "./media-queries.js";
import { isAnyModalOpen } from "./modal-helper.js";
import { pausePlayback } from "./playback-pause.js";
import { state } from "./state.js";
import { subscribeThemeChange, themeColors } from "./theme.js";
import { subscribeTripMapLibrary, syncTripMapLibrary, tripMapEntries } from "./trip-map-library.js";
import { getTripMapPreferences, setTripMapPreferences, subscribeTripMapPreferences } from "./trip-map-pref.js";
import {
    countTripsThrough,
    setTripMapFrame,
    setTripMapPlace,
    subscribeTripMapScope,
    subscribeTripMapSearch,
    tripMapPassesFor,
    tripMapPlace,
    tripMapPlaceIds,
    tripMapScope,
    tripMapTracksInScope,
} from "./trip-map-search.js";
import { requestTripMapBundle } from "./trip-map-worker-client.js";
import {
    EMPTY_MAP_STYLE,
    loadMaplibre,
    registerViewerMap,
    retryMapStyle,
    subscribeMapStyleError,
    type MaplibreNamespace,
} from "./viewer-map-registry.js";

const log = createLogger("trip-map");

interface CorridorLayers {
    source: string;
    halo: string;
    outline: string;
    core: string;
}

const BASE_LAYERS: CorridorLayers = {
    source: "trip-map-lines",
    halo: "trip-map-lines-halo",
    outline: "trip-map-lines-outline",
    core: "trip-map-lines-core",
};
// Corridors of the trips through the chosen place, in full over the dimmed base.
const MATCHED_LAYERS: CorridorLayers = {
    source: "trip-map-matched",
    halo: "trip-map-matched-halo",
    outline: "trip-map-matched-outline",
    core: "trip-map-matched-core",
};
const PLACE_SOURCE_ID = "trip-map-place";
const PLACE_FILL_LAYER_ID = "trip-map-place-fill";
const PLACE_EDGE_LAYER_ID = "trip-map-place-edge";
const PLACE_LINE_LAYER_ID = "trip-map-place-line";
const HIGHLIGHT_SOURCE_ID = "trip-map-highlight";
const HIGHLIGHT_OUTLINE_LAYER_ID = "trip-map-highlight-outline";
const HIGHLIGHT_CORE_LAYER_ID = "trip-map-highlight-core";
const HIGHLIGHT_POINTS_LAYER_ID = "trip-map-highlight-points";

// Corridor geometry is recomputed at most this often while tracks keep
// arriving or the zoom keeps changing; each run costs up to a second of
// worker time on a large library.
const BUNDLE_MIN_INTERVAL_MS = 500;
// The start view and "show all" leave this much room around the library.
const FRAME_PADDING_PX = 60;
// A library of one short trip must not open at building level.
const FRAME_MAX_ZOOM = 15;
const DOT_ZOOM_PADDING_PX = 50;
// A group of dots zooms to its trips with this share of extra room around them.
const DOT_ZOOM_MARGIN = 0.1;
// A click chooses a circle this large on screen; afterwards it keeps its size
// in metres. The probe under the pointer previews the same circle.
const PLACE_RADIUS_PX = 18;
const PLACE_MIN_RADIUS_PX = 9;
const PLACE_CIRCLE_VERTICES = 72;
// The list follows the frame once the camera has rested this long, so a pan
// does not rebuild it on every frame.
const AREA_SETTLE_MS = 140;
// With a place chosen, the other corridors stay as a faint context.
const DIMMED_CORE_OPACITY = 0.38;
const DIMMED_CORE_MIN_WIDTH_PX = 1.2;
const DIMMED_CORE_WIDTH_SHARE = 0.4;
const HIGHLIGHT_OUTLINE_WIDTH_PX = 7;
const HIGHLIGHT_CORE_WIDTH_PX = 3.6;

interface ReadyTrack {
    id: number;
    track: TripMapTrack;
}

interface TripMapView {
    maplibre: MaplibreNamespace;
    map: maplibregl.Map;
    isStyleReady: boolean;
    bundle: TripBundle | null;
    matchedBundle: TripBundle | null;
    dots: maplibregl.Marker[];
    placeHandle: maplibregl.Marker | null;
    isDraggingHandle: boolean;
    /** The camera has shown the library at least once since following started. */
    hasFramed: boolean;
    /** No user touch since the start or the last "show all": new tracks may move the camera. */
    isFollowing: boolean;
    /** Latest corridor request; older answers are dropped. */
    bundleRequest: number;
    requestedStep: number | null;
    bundleTimer: ReturnType<typeof setTimeout> | null;
    lastBundleAt: number;
    areaTimer: ReturnType<typeof setTimeout> | null;
    probeFrame: number;
    probePoint: { point: maplibregl.Point; lngLat: maplibregl.LngLat } | null;
}

interface TripMapCallbacks {
    /** The map was turned on or off or became unavailable: the viewer placeholder must follow. */
    onSurfaceChange: () => void;
}

let callbacks: TripMapCallbacks = { onSurfaceChange: () => {} };
let view: TripMapView | null = null;
// Bumped by every creation attempt and teardown, so a creation still waiting
// for maplibre-gl gives up when the surface was hidden in the meantime.
let creation = 0;
// No WebGL context: the map stays off for the session and the viewer keeps
// its plain placeholder.
let isUnavailable = false;
/** Trip index under the pointer in the list, drawn on top of everything. */
let highlightedTrip: number | null = null;
/** The button by the search laid the map over the open trip. */
let isOverTrip = false;
/** Viewer layers this map made inert while it covers the open trip. */
let coveredLayers: HTMLElement[] = [];

/** The surface can exist here: a WebGL context works and the layout is not the phone one. */
export function isTripMapAvailable(): boolean {
    return !isUnavailable && !isMobileLayout();
}

function shouldShowTripMap(): boolean {
    if (!isTripMapAvailable() || state.trips.length === 0) return false;
    if (state.active === null) return getTripMapPreferences().isShownWithoutTrip;
    return isOverTrip;
}

/**
 * Shows or hides the map in the viewer and keeps its tracks current.
 * Idempotent; called whenever the trips, the open trip, export mode or the
 * preference change.
 */
export function syncTripMap(): void {
    // The map over a trip belongs to that trip outside export: without an
    // open trip, in export or on the phone layout it is gone for good.
    if (state.active === null || state.exportModeOpen || !isTripMapAvailable()) isOverTrip = false;
    const isShown = shouldShowTripMap();
    const isCoveringTrip = isShown && state.active !== null;
    dom.viewer.classList.toggle("has-trip-map", isShown);
    dom.viewer.classList.toggle("has-trip-map-over-trip", isCoveringTrip);
    coverTrip(isCoveringTrip);
    dom.tripMapToggle.hidden = !isTripMapAvailable();
    // Export owns the open trip's viewer.
    dom.tripMapToggle.disabled = state.active !== null && state.exportModeOpen;
    dom.tripMapToggle.setAttribute("aria-pressed", String(isShown));
    const closeLabel = t(isCoveringTrip ? "tripMap.backToVideo" : "tripMap.close");
    dom.tripMapClose.title = closeLabel;
    dom.tripMapClose.setAttribute("aria-label", closeLabel);
    // A chosen place keeps filtering the list while the map is hidden, so
    // its tracks must follow the trips either way.
    if (isShown || tripMapPlace()) syncTripMapLibrary(state.trips);
    if (!isShown) {
        destroyView();
        return;
    }
    if (view) syncTripMapStatus();
    else void createView();
}

/**
 * The map over the trip makes the rest of the viewer inert: the player stays
 * laid out underneath (no resize, no reload) but takes no focus, pointer or
 * keys. Playback pauses once, when the map comes up.
 */
function coverTrip(isCovering: boolean): void {
    if (isCovering === coveredLayers.length > 0) return;
    if (!isCovering) {
        for (const layer of coveredLayers) layer.inert = false;
        coveredLayers = [];
        return;
    }
    for (const layer of dom.viewer.children) {
        // A layer inert for another owner stays theirs to release.
        if (!(layer instanceof HTMLElement) || layer === dom.tripMapState || layer.inert) continue;
        layer.inert = true;
        coveredLayers.push(layer);
    }
    pausePlayback();
}

/** Takes the map off the open trip, if it covers one. Opening another trip starts here. */
export function closeTripMapOverTrip(): void {
    if (!isOverTrip) return;
    isOverTrip = false;
    syncTripMap();
}

/**
 * Esc, the close button or the button by the search give the video back.
 * Focus leaving the hidden map returns to that button; focus in the list
 * stays where the user works.
 */
function returnToVideo(): void {
    const focused = document.activeElement;
    const shouldMoveFocus = focused === null || focused === document.body || dom.tripMapState.contains(focused);
    closeTripMapOverTrip();
    if (shouldMoveFocus) dom.tripMapToggle.focus({ preventScroll: true });
}

function isTextEntry(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || target.matches("input, textarea, select");
}

/** "Show all" from outside the map: the whole library, following again. */
export function showAllTripsOnMap(): void {
    if (!view) return;
    view.isFollowing = true;
    syncTripMapStatus();
    scheduleAreaUpdate(view);
    if (fitWorldBounds(view, libraryBounds(readyTracks()), FRAME_PADDING_PX, FOLLOW_FIT_DURATION_MS))
        view.hasFramed = true;
}

function setShownWithoutTrip(isShown: boolean): void {
    setTripMapPreferences({ ...getTripMapPreferences(), isShownWithoutTrip: isShown });
}

async function createView(): Promise<void> {
    const generation = ++creation;
    let maplibre: MaplibreNamespace;
    try {
        maplibre = await loadMaplibre();
    } catch (error) {
        log.warn("trip map library failed to load", error instanceof Error ? error : { error: String(error) });
        return;
    }
    if (generation !== creation || view || !shouldShowTripMap()) return;
    // Same preflight as ensureMap in map.ts: degrade deterministically
    // instead of depending on how MapLibre fails without a context.
    if (!probeWebGL()) {
        markUnavailable();
        return;
    }
    let map: maplibregl.Map;
    try {
        map = new maplibre.Map({
            container: dom.tripMapCanvas,
            style: EMPTY_MAP_STYLE,
            center: [0, 20],
            zoom: 1,
            attributionControl: false,
            refreshExpiredTiles: true,
            crossSourceCollisions: false,
            // Styles are static and validated at build time (see ensureMap).
            validateStyle: false,
            transformRequest: transformMapTileRequest,
            // North-up and flat: the map answers "where", and a rotated
            // library is only harder to read.
            dragRotate: false,
            pitchWithRotate: false,
            touchPitch: false,
            maxPitch: 0,
        });
    } catch (error) {
        markUnavailable(error);
        return;
    }
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    const attribution = new MapAttributionControl(getMapProvider());
    map.addControl(attribution, "bottom-right");
    const scale = new maplibre.ScaleControl({ maxWidth: 120, unit: getUnits() });
    map.addControl(scale, "bottom-left");
    const unsubscribeUnits = subscribeUnitsChange((unit) => scale.setUnit(unit));
    map.once("remove", unsubscribeUnits);

    const current: TripMapView = {
        maplibre,
        map,
        isStyleReady: false,
        bundle: null,
        matchedBundle: null,
        dots: [],
        placeHandle: null,
        isDraggingHandle: false,
        hasFramed: false,
        isFollowing: true,
        bundleRequest: 0,
        requestedStep: null,
        bundleTimer: null,
        lastBundleAt: 0,
        areaTimer: null,
        probeFrame: 0,
        probePoint: null,
    };
    view = current;
    state.tripMap = map;
    map.on("styledataloading", () => {
        current.isStyleReady = false;
    });
    // A style swap drops every source; everything comes back from the last results.
    map.on("style.load", () => {
        current.isStyleReady = true;
        addLayers(current);
    });
    const noteUserMove = (event: { originalEvent?: unknown }): void => {
        if (event.originalEvent) stopFollowing(current);
    };
    map.on("dragstart", noteUserMove);
    map.on("zoomstart", noteUserMove);
    map.on("wheel", () => {
        stopFollowing(current);
    });
    map.on("dblclick", () => {
        stopFollowing(current);
    });
    map.on("zoom", () => {
        if (bundleStepForZoom(map.getZoom()) !== current.requestedStep) scheduleBundle(current);
    });
    map.on("moveend", () => scheduleAreaUpdate(current));
    map.on("resize", () => scheduleAreaUpdate(current));
    map.on("mousemove", (event) => {
        current.probePoint = { point: event.point, lngLat: event.lngLat };
        if (!current.probeFrame) current.probeFrame = requestAnimationFrame(() => updateProbe(current));
    });
    map.on("mouseout", () => {
        current.probePoint = null;
        hideProbe(current);
    });
    map.on("click", (event) => {
        // Markers sit in the canvas container; their own handlers own their clicks.
        if (event.originalEvent.target !== map.getCanvas()) return;
        stopFollowing(current);
        const circle = circleAt(current, event.lngLat);
        setTripMapPlace(countTripsThrough(circle) > 0 ? circle : null);
        hideProbe(current);
    });
    registerViewerMap({ map, surface: "trips", attribution });
    followLibrary(current);
    scheduleBundle(current);
    syncTripMapStatus();
    renderPlace(current);
}

function destroyView(): void {
    creation++;
    const current = view;
    if (!current) return;
    view = null;
    state.tripMap = null;
    if (current.bundleTimer !== null) clearTimeout(current.bundleTimer);
    if (current.areaTimer !== null) clearTimeout(current.areaTimer);
    if (current.probeFrame) cancelAnimationFrame(current.probeFrame);
    for (const marker of current.dots) marker.remove();
    current.placeHandle?.remove();
    hideProbe(current);
    // remove() also takes the map out of the viewer map registry.
    current.map.remove();
    // A hidden map no longer frames the list.
    setTripMapFrame(null);
}

function markUnavailable(error?: unknown): void {
    if (isUnavailable) return;
    isUnavailable = true;
    log.warn("trip map unavailable: no WebGL context", error instanceof Error ? error : { error: String(error) });
    syncTripMap();
    callbacks.onSurfaceChange();
}

/** Distinct simplified tracks of the trips the list's query and chips keep, in id order. */
function readyTracks(): ReadyTrack[] {
    return [...tripMapTracksInScope()].sort(([a], [b]) => a - b).map(([id, track]) => ({ id, track }));
}

/** A user touch ends following until "show all". */
function stopFollowing(current: TripMapView): void {
    if (!current.isFollowing) return;
    current.isFollowing = false;
    syncTripMapStatus();
    scheduleAreaUpdate(current);
}

function libraryBounds(tracks: readonly ReadyTrack[]): WorldBounds {
    const bounds = emptyBounds();
    for (const { track } of tracks) extendBounds(bounds, track.bounds);
    return bounds;
}

function lngLatBounds(bounds: WorldBounds): maplibregl.LngLatBoundsLike {
    return [
        [worldToLon(bounds.minX), worldToLat(bounds.maxY)],
        [worldToLon(bounds.maxX), worldToLat(bounds.minY)],
    ];
}

/** Fits `bounds` when the container is large enough to hold the padding. */
function fitWorldBounds(current: TripMapView, bounds: WorldBounds, padding: number, durationMs: number): boolean {
    if (isEmptyBounds(bounds)) return false;
    const container = current.map.getContainer();
    if (container.clientWidth <= padding * 2 || container.clientHeight <= padding * 2) return false;
    current.map.fitBounds(lngLatBounds(bounds), {
        padding,
        maxZoom: FRAME_MAX_ZOOM,
        duration: prefersReducedMotion() ? 0 : durationMs,
    });
    return true;
}

function screenBox(current: TripMapView, bounds: WorldBounds): ScreenBox {
    const corners = [
        current.map.project([worldToLon(bounds.minX), worldToLat(bounds.maxY)]),
        current.map.project([worldToLon(bounds.maxX), worldToLat(bounds.minY)]),
    ];
    return {
        minX: Math.min(corners[0]!.x, corners[1]!.x),
        minY: Math.min(corners[0]!.y, corners[1]!.y),
        maxX: Math.max(corners[0]!.x, corners[1]!.x),
        maxY: Math.max(corners[0]!.y, corners[1]!.y),
    };
}

/**
 * Keeps the whole library in frame while tracks keep arriving: the first
 * tracks set the start view at once, later ones move the camera only when
 * they no longer fit (see follow.ts). A user touch ends it.
 */
function followLibrary(current: TripMapView): void {
    const bounds = libraryBounds(readyTracks());
    if (isEmptyBounds(bounds)) return;
    const container = current.map.getContainer();
    const isNeeded = shouldReframe({
        isFollowing: current.isFollowing,
        hasFramed: current.hasFramed,
        tracksOnScreen: screenBox(current, bounds),
        viewportWidth: container.clientWidth,
        viewportHeight: container.clientHeight,
    });
    if (!isNeeded) return;
    const isStart = !current.hasFramed;
    const padding = isStart ? FRAME_PADDING_PX : FOLLOW_FIT_PADDING_PX;
    if (fitWorldBounds(current, bounds, padding, isStart ? 0 : FOLLOW_FIT_DURATION_MS)) current.hasFramed = true;
}

/** The visible frame in world coordinates; may extend past the world's edges. */
function viewFrame(current: TripMapView): WorldBounds {
    const bounds = current.map.getBounds();
    return {
        minX: worldX(bounds.getWest()),
        minY: worldY(bounds.getNorth()),
        maxX: worldX(bounds.getEast()),
        maxY: worldY(bounds.getSouth()),
    };
}

/**
 * The list follows the frame only after the user has touched the map. While
 * the camera follows the library, tracks arriving past the edge are in
 * flight to the frame, and trips must not leave the list without a user
 * action.
 */
function scheduleAreaUpdate(current: TripMapView): void {
    if (current.areaTimer !== null) clearTimeout(current.areaTimer);
    current.areaTimer = null;
    if (current.isFollowing) {
        setTripMapFrame(null);
        return;
    }
    current.areaTimer = setTimeout(() => {
        current.areaTimer = null;
        if (view === current) setTripMapFrame(viewFrame(current));
    }, AREA_SETTLE_MS);
}

function scheduleBundle(current: TripMapView, isUrgent = false): void {
    if (current.bundleTimer !== null) {
        if (!isUrgent) return;
        clearTimeout(current.bundleTimer);
    }
    const wait = isUrgent ? 0 : Math.max(0, current.lastBundleAt + BUNDLE_MIN_INTERVAL_MS - performance.now());
    current.bundleTimer = setTimeout(() => {
        current.bundleTimer = null;
        void refreshBundle(current);
    }, wait);
}

/** Recomputes corridor lines and far dots for the current zoom step, library and place. */
async function refreshBundle(current: TripMapView): Promise<void> {
    if (view !== current) return;
    current.lastBundleAt = performance.now();
    const step = bundleStepForZoom(current.map.getZoom());
    const tracks = readyTracks();
    const dots = foldFarTrips(
        tracks.map(({ id, track }) => ({ id, bounds: track.bounds })),
        step,
    );
    // A folded trip is drawn as its dot only; its few-pixel line would be noise.
    const folded = new Set(dots.flatMap((dot) => dot.tripIds));
    const ids = tracks.filter(({ id }) => !folded.has(id)).map(({ id }) => id);
    const placeIds = tripMapPlace() ? tripMapPlaceIds() : null;
    const matchedIds = placeIds ? ids.filter((id) => placeIds.has(id)) : [];
    const request = ++current.bundleRequest;
    current.requestedStep = step;
    let bundle: TripBundle;
    let matchedBundle: TripBundle | null = null;
    try {
        bundle = await requestTripMapBundle(step, ids);
        if (matchedIds.length > 0) matchedBundle = await requestTripMapBundle(step, matchedIds);
    } catch (error) {
        if (request === current.bundleRequest)
            log.warn("trip map corridors failed", error instanceof Error ? error : { error: String(error) });
        return;
    }
    if (view !== current || request !== current.bundleRequest) return;
    current.bundle = bundle;
    current.matchedBundle = matchedBundle;
    renderLines(current);
    renderDots(current, dots);
}

interface LinesData {
    type: "FeatureCollection";
    features: {
        type: "Feature";
        /** Core line width in pixels; the edge layers add to it. */
        properties: { w: number };
        geometry: { type: "MultiLineString"; coordinates: [number, number][][] };
    }[];
}

function linesData(bundle: TripBundle | null): LinesData {
    const features = (bundle?.lines ?? []).map((group) => {
        const coordinates: [number, number][][] = [];
        for (let line = 0; line + 1 < group.starts.length; line++) {
            const vertices: [number, number][] = [];
            for (let vertex = group.starts[line]!; vertex < group.starts[line + 1]!; vertex++) {
                vertices.push([group.coords[vertex * 2]!, group.coords[vertex * 2 + 1]!]);
            }
            coordinates.push(vertices);
        }
        return {
            type: "Feature" as const,
            properties: { w: group.width },
            geometry: { type: "MultiLineString" as const, coordinates },
        };
    });
    return { type: "FeatureCollection", features };
}

function corridorColors(layers: CorridorLayers): Record<string, string> {
    const colors = themeColors();
    return {
        [layers.halo]: colors.trackHalo,
        [layers.outline]: colors.trackOutline,
        [layers.core]: colors.trackCorridor,
    };
}

/**
 * Three passes over every corridor: all halos, then all outlines, then all
 * cores. Crossing corridors merge into one silhouette, and the outline shows
 * only on its outside, the same edge the trip's own route has.
 */
function addCorridorLayers(map: maplibregl.Map, layers: CorridorLayers, bundle: TripBundle | null): void {
    map.addSource(layers.source, { type: "geojson", data: linesData(bundle) });
    const width: ExpressionSpecification = ["get", "w"];
    const passes: { id: string; width: ExpressionSpecification }[] = [
        { id: layers.halo, width: ["+", width, 2 * (TRACK_OUTLINE_WIDTH_PX + TRACK_HALO_WIDTH_PX)] },
        { id: layers.outline, width: ["+", width, 2 * TRACK_OUTLINE_WIDTH_PX] },
        { id: layers.core, width },
    ];
    const colors = corridorColors(layers);
    for (const pass of passes) {
        map.addLayer({
            id: pass.id,
            type: "line",
            source: layers.source,
            layout: { "line-join": "round", "line-cap": "round" },
            paint: { "line-width": pass.width, "line-color": colors[pass.id]! },
        });
    }
}

function placeColors(): { fill: string; edge: string } {
    const colors = themeColors();
    return { fill: colors.trackCorridor, edge: colors.markerStroke };
}

function highlightColors(): { outline: string; core: string; start: string; end: string; pass: string } {
    const colors = themeColors();
    return {
        outline: colors.trackOutline,
        core: colors.trackHalo,
        start: colors.markerStart,
        end: colors.markerEnd,
        pass: colors.trackCorridor,
    };
}

function addLayers(current: TripMapView): void {
    const { map } = current;
    addCorridorLayers(map, BASE_LAYERS, current.bundle);
    map.addSource(PLACE_SOURCE_ID, { type: "geojson", data: placeData() });
    const place = placeColors();
    map.addLayer({
        id: PLACE_FILL_LAYER_ID,
        type: "fill",
        source: PLACE_SOURCE_ID,
        paint: { "fill-color": place.fill, "fill-opacity": 0.14 },
    });
    addCorridorLayers(map, MATCHED_LAYERS, current.matchedBundle);
    // A wide contrasting edge under a narrow accent one reads on every basemap.
    map.addLayer({
        id: PLACE_EDGE_LAYER_ID,
        type: "line",
        source: PLACE_SOURCE_ID,
        paint: { "line-color": place.edge, "line-width": 3.4 },
    });
    map.addLayer({
        id: PLACE_LINE_LAYER_ID,
        type: "line",
        source: PLACE_SOURCE_ID,
        paint: { "line-color": place.fill, "line-width": 2 },
    });
    const highlight = highlightColors();
    map.addSource(HIGHLIGHT_SOURCE_ID, { type: "geojson", data: highlightData() });
    const isRoute: ExpressionSpecification = ["==", ["get", "kind"], "route"];
    map.addLayer({
        id: HIGHLIGHT_OUTLINE_LAYER_ID,
        type: "line",
        source: HIGHLIGHT_SOURCE_ID,
        filter: isRoute,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": highlight.outline, "line-width": HIGHLIGHT_OUTLINE_WIDTH_PX },
    });
    // White inside a dark edge: an orange highlight would vanish in the orange corridors.
    map.addLayer({
        id: HIGHLIGHT_CORE_LAYER_ID,
        type: "line",
        source: HIGHLIGHT_SOURCE_ID,
        filter: isRoute,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": highlight.core, "line-width": HIGHLIGHT_CORE_WIDTH_PX },
    });
    map.addLayer({
        id: HIGHLIGHT_POINTS_LAYER_ID,
        type: "circle",
        source: HIGHLIGHT_SOURCE_ID,
        filter: ["!", isRoute],
        paint: {
            "circle-radius": ["match", ["get", "kind"], "pass", 4.5, 5],
            "circle-color": ["match", ["get", "kind"], "start", highlight.start, "end", highlight.end, highlight.pass],
            "circle-stroke-color": ["match", ["get", "kind"], "pass", highlight.outline, themeColors().chartSurface],
            "circle-stroke-width": ["match", ["get", "kind"], "pass", 1.6, 2],
        },
    });
    applyEmphasis(current);
}

function applyThemeColors(current: TripMapView): void {
    if (!current.isStyleReady) return;
    const { map } = current;
    for (const layers of [BASE_LAYERS, MATCHED_LAYERS]) {
        for (const [layerId, color] of Object.entries(corridorColors(layers))) {
            map.setPaintProperty(layerId, "line-color", color);
        }
    }
    const place = placeColors();
    map.setPaintProperty(PLACE_FILL_LAYER_ID, "fill-color", place.fill);
    map.setPaintProperty(PLACE_EDGE_LAYER_ID, "line-color", place.edge);
    map.setPaintProperty(PLACE_LINE_LAYER_ID, "line-color", place.fill);
    const highlight = highlightColors();
    map.setPaintProperty(HIGHLIGHT_OUTLINE_LAYER_ID, "line-color", highlight.outline);
    map.setPaintProperty(HIGHLIGHT_CORE_LAYER_ID, "line-color", highlight.core);
}

/** With a place chosen the base corridors fade to thin lines; the matched ones carry the full style. */
function applyEmphasis(current: TripMapView): void {
    if (!current.isStyleReady) return;
    const { map } = current;
    const isDimmed = tripMapPlace() !== null;
    const width: ExpressionSpecification = ["get", "w"];
    map.setPaintProperty(BASE_LAYERS.halo, "line-opacity", isDimmed ? 0 : 1);
    map.setPaintProperty(BASE_LAYERS.outline, "line-opacity", isDimmed ? 0 : 1);
    map.setPaintProperty(BASE_LAYERS.core, "line-opacity", isDimmed ? DIMMED_CORE_OPACITY : 1);
    map.setPaintProperty(
        BASE_LAYERS.core,
        "line-width",
        isDimmed ? ["max", DIMMED_CORE_MIN_WIDTH_PX, ["*", DIMMED_CORE_WIDTH_SHARE, width]] : width,
    );
}

function renderLines(current: TripMapView): void {
    if (!current.isStyleReady) return;
    const { map } = current;
    map.getSource<GeoJSONSource>(BASE_LAYERS.source)?.setData(linesData(current.bundle));
    map.getSource<GeoJSONSource>(MATCHED_LAYERS.source)?.setData(linesData(current.matchedBundle));
}

function renderDots(current: TripMapView, dots: readonly FarDot[]): void {
    for (const marker of current.dots) marker.remove();
    current.dots = dots.map((dot) => {
        const count = dot.tripIds.length;
        const element = document.createElement("button");
        element.type = "button";
        element.className = "trip-map-dot";
        element.style.setProperty("--trip-map-dot-size", `${farDotRadiusPx(count) * 2}px`);
        if (count > 1) element.textContent = String(count);
        const label = t("tripMap.dot", { n: count });
        element.title = label;
        element.setAttribute("aria-label", label);
        element.addEventListener("click", (event) => {
            event.stopPropagation();
            zoomToDot(current, dot);
        });
        return new current.maplibre.Marker({ element })
            .setLngLat([worldToLon(dot.x), worldToLat(dot.y)])
            .addTo(current.map);
    });
}

function zoomToDot(current: TripMapView, dot: FarDot): void {
    stopFollowing(current);
    const { bounds } = dot;
    const marginX = (bounds.maxX - bounds.minX) * DOT_ZOOM_MARGIN;
    const marginY = (bounds.maxY - bounds.minY) * DOT_ZOOM_MARGIN;
    fitWorldBounds(
        current,
        {
            minX: bounds.minX - marginX,
            minY: bounds.minY - marginY,
            maxX: bounds.maxX + marginX,
            maxY: bounds.maxY + marginY,
        },
        DOT_ZOOM_PADDING_PX,
        0,
    );
}

/** The click-sized circle around a point, in metres from here on. */
function circleAt(current: TripMapView, lngLat: maplibregl.LngLat): PlaceCircle {
    const x = worldX(lngLat.lng);
    const y = worldY(lngLat.lat);
    const radiusWorld = PLACE_RADIUS_PX * worldUnitsPerPixel(current.map.getZoom());
    return { x, y, radiusMeters: radiusWorld * groundMetersPerWorldUnit(y) };
}

function hideProbe(current: TripMapView): void {
    dom.tripMapProbe.hidden = true;
    dom.tripMapTip.hidden = true;
    current.map.getCanvas().style.cursor = "";
}

/** Before a place is chosen, the pointer shows the circle a click would choose and its trip count. */
function updateProbe(current: TripMapView): void {
    current.probeFrame = 0;
    const probe = current.probePoint;
    if (view !== current || !probe || tripMapPlace()) {
        hideProbe(current);
        return;
    }
    const count = countTripsThrough(circleAt(current, probe.lngLat));
    if (count === 0) {
        hideProbe(current);
        return;
    }
    const { x, y } = probe.point;
    dom.tripMapProbe.style.setProperty("--trip-map-probe-size", `${PLACE_RADIUS_PX * 2}px`);
    dom.tripMapProbe.style.transform = `translate(${x - PLACE_RADIUS_PX}px, ${y - PLACE_RADIUS_PX}px)`;
    dom.tripMapProbe.hidden = false;
    dom.tripMapTip.textContent = t("tripMap.probe", { n: count });
    dom.tripMapTip.style.transform = `translate(${x + 14}px, ${y}px) translateY(-130%)`;
    dom.tripMapTip.hidden = false;
    current.map.getCanvas().style.cursor = "pointer";
}

interface PlaceData {
    type: "FeatureCollection";
    features: {
        type: "Feature";
        properties: Record<string, never>;
        geometry: { type: "Polygon"; coordinates: [number, number][][] };
    }[];
}

function placeData(): PlaceData {
    const place = tripMapPlace();
    if (!place) return { type: "FeatureCollection", features: [] };
    const radius = placeRadiusWorld(place);
    const ring: [number, number][] = [];
    for (let k = 0; k <= PLACE_CIRCLE_VERTICES; k++) {
        const angle = (2 * Math.PI * k) / PLACE_CIRCLE_VERTICES;
        ring.push([worldToLon(place.x + radius * Math.cos(angle)), worldToLat(place.y + radius * Math.sin(angle))]);
    }
    return {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }],
    };
}

/** The radius handle sits on the circle to the north-east. */
function handleLngLat(place: PlaceCircle): [number, number] {
    const offset = placeRadiusWorld(place) * Math.SQRT1_2;
    return [worldToLon(place.x + offset), worldToLat(place.y - offset)];
}

function createPlaceHandle(current: TripMapView): maplibregl.Marker {
    const element = document.createElement("div");
    element.className = "trip-map-place-handle";
    element.title = t("tripMap.place.handle");
    const handle = new current.maplibre.Marker({ element, draggable: true });
    handle.on("dragstart", () => {
        current.isDraggingHandle = true;
        stopFollowing(current);
    });
    handle.on("drag", () => {
        const place = tripMapPlace();
        if (!place) return;
        const centre = current.map.project([worldToLon(place.x), worldToLat(place.y)]);
        const point = current.map.project(handle.getLngLat());
        const radiusPx = Math.max(PLACE_MIN_RADIUS_PX, Math.hypot(point.x - centre.x, point.y - centre.y));
        const radiusWorld = radiusPx * worldUnitsPerPixel(current.map.getZoom());
        setTripMapPlace({ ...place, radiusMeters: radiusWorld * groundMetersPerWorldUnit(place.y) });
    });
    handle.on("dragend", () => {
        current.isDraggingHandle = false;
        renderPlace(current);
    });
    return handle;
}

function renderPlace(current: TripMapView): void {
    const place = tripMapPlace();
    if (current.isStyleReady) current.map.getSource<GeoJSONSource>(PLACE_SOURCE_ID)?.setData(placeData());
    applyEmphasis(current);
    if (!place) {
        current.placeHandle?.remove();
        current.placeHandle = null;
        return;
    }
    if (current.isDraggingHandle) return;
    current.placeHandle ??= createPlaceHandle(current);
    current.placeHandle.setLngLat(handleLngLat(place)).addTo(current.map);
}

interface HighlightData {
    type: "FeatureCollection";
    features: {
        type: "Feature";
        properties: { kind: "route" | "start" | "end" | "pass" };
        geometry:
            | { type: "MultiLineString"; coordinates: [number, number][][] }
            | { type: "Point"; coordinates: [number, number] };
    }[];
}

/** The hovered list trip: its own simplified route, its ends and its passes through the place. */
function highlightData(): HighlightData {
    const empty: HighlightData = { type: "FeatureCollection", features: [] };
    if (highlightedTrip === null) return empty;
    const track = tripMapEntries()[highlightedTrip]?.track;
    if (!track || track.times.length === 0) return empty;
    const lngLat = (index: number): [number, number] => [
        worldToLon(track.points[index * 2]!),
        worldToLat(track.points[index * 2 + 1]!),
    ];
    const lines: [number, number][][] = [[lngLat(0)]];
    for (let index = 1; index < track.times.length; index++) {
        if (track.breaks[index - 1] === 1) lines.push([]);
        lines.at(-1)!.push(lngLat(index));
    }
    const features: HighlightData["features"] = [
        {
            type: "Feature",
            properties: { kind: "route" },
            geometry: { type: "MultiLineString", coordinates: lines.filter((line) => line.length > 1) },
        },
        { type: "Feature", properties: { kind: "start" }, geometry: { type: "Point", coordinates: lngLat(0) } },
        {
            type: "Feature",
            properties: { kind: "end" },
            geometry: { type: "Point", coordinates: lngLat(track.times.length - 1) },
        },
    ];
    for (const pass of tripMapPassesFor(highlightedTrip)) {
        features.push({
            type: "Feature",
            properties: { kind: "pass" },
            geometry: { type: "Point", coordinates: [worldToLon(pass.x), worldToLat(pass.y)] },
        });
    }
    return { type: "FeatureCollection", features };
}

function renderHighlight(): void {
    if (!view?.isStyleReady) return;
    view.map.getSource<GeoJSONSource>(HIGHLIGHT_SOURCE_ID)?.setData(highlightData());
}

/**
 * The counter and the "show all" button. While recordings are still being
 * read the counter shows how many trips are read, and "show all" is pressed
 * while the camera follows the arriving tracks; afterwards the counter says
 * how many trips have a route on the map.
 */
export function syncTripMapStatus(): void {
    if (!view) return;
    const scope = tripMapScope();
    const entries = tripMapEntries();
    let onMap = 0;
    let read = 0;
    for (const index of scope) {
        const hasRoute = Boolean(entries[index]?.track);
        if (hasRoute) onMap++;
        // A route can arrive from a GPS file before the video's own read ends.
        const trip = state.trips[index];
        if (hasRoute || (trip && !tripNeedsRecordingMetadata(trip))) read++;
    }
    const total = scope.length;
    const isReading = state.recordingAnalysisProgress !== null && read < total;
    dom.tripMapCounter.hidden = false;
    dom.tripMapCounterText.textContent = isReading
        ? t("tripMap.reading", { n: read, total })
        : t("tripMap.counter", { n: onMap, total });
    dom.tripMapCounter.classList.toggle("has-untracked", !isReading && onMap < total);
    dom.tripMapCounter.classList.toggle("is-reading", isReading);
    dom.tripMapCounterBar.hidden = !isReading;
    dom.tripMapCounterFill.style.transform = `scaleX(${total > 0 ? read / total : 0})`;
    const isFollowingReads = isReading && view.isFollowing;
    // A toggle only while there is something to follow.
    if (isReading) dom.tripMapFit.setAttribute("aria-pressed", String(isFollowingReads));
    else dom.tripMapFit.removeAttribute("aria-pressed");
    const fitLabel = t(isFollowingReads ? "tripMap.fit.following" : isReading ? "tripMap.fit.resume" : "tripMap.fit");
    dom.tripMapFit.title = fitLabel;
    dom.tripMapFit.setAttribute("aria-label", fitLabel);
}

/** The place bar under the search and the map's own hint follow the chosen place. */
function syncPlaceControls(): void {
    const place = tripMapPlace();
    dom.tripPlaceBar.hidden = place === null;
    dom.tripMapHint.hidden = place !== null;
    if (place)
        dom.tripPlaceRadius.textContent = t("tripMap.place.radius", {
            distance: formatShortDistance(place.radiusMeters),
        });
}

function onLibraryChange(): void {
    const current = view;
    if (!current) return;
    followLibrary(current);
    scheduleBundle(current);
    syncTripMapStatus();
    renderHighlight();
}

function onSearchChange(): void {
    syncPlaceControls();
    const current = view;
    if (!current) return;
    renderPlace(current);
    renderHighlight();
    // The matched corridors depend on the place; recompute them now, not on the throttle.
    scheduleBundle(current, true);
}

function showTripMapFromCard(): void {
    setShownWithoutTrip(true);
    // The card and its button are gone; keep the focus in the viewer.
    dom.tripMapState.focus({ preventScroll: true });
}

function setHighlightedTrip(tripIndex: number | null): void {
    if (tripIndex === highlightedTrip) return;
    highlightedTrip = tripIndex;
    renderHighlight();
}

/** Wires the controls once at startup; the map itself is created on first show. */
export function initTripMap(cb: TripMapCallbacks): void {
    callbacks = cb;
    subscribeTripMapPreferences(() => {
        syncTripMap();
        callbacks.onSurfaceChange();
    });
    window.matchMedia?.(MOBILE_LAYOUT_QUERY).addEventListener("change", () => {
        syncTripMap();
        callbacks.onSurfaceChange();
    });
    subscribeTripMapLibrary(onLibraryChange);
    // The list's query and chips changed what the map draws.
    subscribeTripMapScope(onLibraryChange);
    subscribeTripMapSearch(onSearchChange);
    subscribeUnitsChange(syncPlaceControls);
    subscribeThemeChange(() => {
        if (view) applyThemeColors(view);
    });
    subscribeExportState(syncTripMap);

    dom.tripMapToggle.addEventListener("click", () => {
        if (state.active === null) {
            setShownWithoutTrip(!shouldShowTripMap());
        } else if (isOverTrip) {
            returnToVideo();
        } else {
            isOverTrip = true;
            syncTripMap();
        }
    });
    dom.tripMapClose.addEventListener("click", () => {
        if (state.active !== null) {
            returnToVideo();
            return;
        }
        setShownWithoutTrip(false);
        // The placeholder card offers the way back; the closed map's button is gone.
        document.querySelector<HTMLElement>('[data-action="show-trip-map"]')?.focus({ preventScroll: true });
    });
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !isOverTrip || isAnyModalOpen()) return;
        // Escape in the search clears the search.
        if (isTextEntry(event.target)) return;
        event.preventDefault();
        returnToVideo();
    });
    document.getElementById("empty-state-card")?.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest('[data-action="show-trip-map"]'))
            showTripMapFromCard();
    });
    dom.tripMapFit.addEventListener("click", showAllTripsOnMap);
    dom.tripMapZoomIn.addEventListener("click", () => {
        if (!view) return;
        stopFollowing(view);
        view.map.zoomIn({ duration: prefersReducedMotion() ? 0 : 250 });
    });
    dom.tripMapZoomOut.addEventListener("click", () => {
        if (!view) return;
        stopFollowing(view);
        view.map.zoomOut({ duration: prefersReducedMotion() ? 0 : 250 });
    });
    dom.tripPlaceClear.addEventListener("click", () => {
        setTripMapPlace(null);
        dom.tripSearch.focus({ preventScroll: true });
    });

    // Hovering a trip in the list shows where it went.
    dom.list.addEventListener("pointerover", (event) => {
        const row = event.target instanceof Element ? event.target.closest<HTMLElement>("li.trip") : null;
        const index = row?.dataset.tripIndex === undefined ? null : Number(row.dataset.tripIndex);
        setHighlightedTrip(index !== null && Number.isInteger(index) ? index : null);
    });
    dom.list.addEventListener("pointerleave", () => setHighlightedTrip(null));

    subscribeMapStyleError((isShown) => {
        dom.tripMapStyleError.hidden = !isShown;
    });
    dom.tripMapStyleRetry.addEventListener("click", () => {
        dom.tripMapStyleRetry.disabled = true;
        void retryMapStyle().finally(() => {
            dom.tripMapStyleRetry.disabled = false;
        });
    });
    dom.tripMapStyleDismiss.addEventListener("click", () => {
        dom.tripMapStyleError.hidden = true;
    });
}

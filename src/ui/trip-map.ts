// The map of all trips. While no trip is open it fills the viewer: every loaded
// trip is drawn as corridor lines whose width grows with the number of trips,
// trips too small to read fold into counted dots, and the camera starts on the
// whole library. A click on a road chooses a place; the list then keeps the
// trips through it (trip-map-search.ts) and the map stresses their corridors.
// Over an open trip the button by the search lays the same map over the
// player, which stays mounted, paused and inert until the map closes. On
// phones the map is a tab of the trip list panel instead, with a sheet that
// holds the list once a place is chosen. The user's trip markers sit on the
// routes and open their trip at their moment.
// Track geometry comes from trip-map-library.ts; style, provider and recovery
// are shared with the other viewer maps through the registry. The map
// instance lives only while the surface is shown.

import type * as maplibregl from "maplibre-gl";
import type { ExpressionSpecification, GeoJSONSource } from "maplibre-gl";

import { probeWebGL } from "../capabilities.js";
import { t } from "../i18n/index.js";
import { createLogger } from "../log.js";
import { bundleStepForZoom, zoomStepForZoom, type TripBundle } from "../trip-map/bundle.js";
import { farDotRadiusPx, farTrips, groupFarDots, type FarDot, type FarDotTrip } from "../trip-map/far-dots.js";
import { FOLLOW_FIT_DURATION_MS, FOLLOW_FIT_PADDING_PX, shouldReframe, type ScreenBox } from "../trip-map/follow.js";
import { placeRadiusWorld, trackPositionAt, type PlaceCircle } from "../trip-map/queries.js";
import type { TripMapTrack } from "../trip-map/track-geometry.js";
import { tripNeedsRecordingMetadata, type Trip } from "../trips.js";
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
import { markersWithTrips, subscribeMarkers } from "./annotations.js";
import { dom } from "./dom.js";
import { subscribeExportState } from "./export-state.js";
import { formatMarkerMoment, formatShortDistance } from "./format.js";
import { MapAttributionControl } from "./map-attribution-control.js";
import { getMapProvider } from "./map-provider.js";
import { transformMapTileRequest } from "./map-tile-cache.js";
import { TRACK_HALO_WIDTH_PX, TRACK_OUTLINE_WIDTH_PX } from "./map-track.js";
import { isMobileLayout, MOBILE_LAYOUT_QUERY, prefersReducedMotion } from "./media-queries.js";
import { isTripListOnScreen, subscribeTripListPlacement } from "./mobile-drawer.js";
import { isAnyModalOpen } from "./modal-helper.js";
import { pausePlayback } from "./playback-pause.js";
import { state } from "./state.js";
import { subscribeThemeChange, themeColors } from "./theme.js";
import { subscribeTripMapLibrary, syncTripMapLibrary, tripMapEntries } from "./trip-map-library.js";
import { getTripMapPreferences, setTripMapPreferences, subscribeTripMapPreferences } from "./trip-map-pref.js";
import {
    startReadingTracks,
    stopReadingTracks,
    subscribeTrackRead,
    trackReadProgress,
    untrackedTrips,
    type TripGpsReader,
} from "./trip-map-read.js";
import {
    countTripsThrough,
    setTripMapFrame,
    setTripMapPlace,
    subscribeTripMapScope,
    subscribeTripMapSearch,
    tripMapPassesFor,
    tripMapPlace,
    tripMapPlaceIds,
    tripMapAreaCount,
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
// The start view and "show all" leave this much room around the library; a
// phone has little screen to spare.
const FRAME_PADDING_PX = 60;
const PHONE_FRAME_PADDING_PX = 24;
// Following the arriving tracks on a phone. Like FOLLOW_FIT_PADDING_PX on
// desktop it stays above the "still fits" margin of follow.ts (24 px): a fit
// that lands on that margin moves the camera again for every new track.
const PHONE_FOLLOW_FIT_PADDING_PX = 40;
// MapLibre's default clickTolerance: a release further than this from its
// press ended a pan.
const MAP_CLICK_TOLERANCE_PX = 3;
// A library of one short trip must not open at building level.
const FRAME_MAX_ZOOM = 15;
const DOT_ZOOM_PADDING_PX = 50;
// A click on a dot zooms closer than the start view may: stays within a few
// tens of metres share a dot at FRAME_MAX_ZOOM, and the click must split them.
// Here a dot's grid cell is about 12 m at 52°N.
const DOT_ZOOM_MAX = 17;
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
// lucide: bookmark, filled for the marker's white glyph.
const USER_MARKER_ICON =
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>';

interface UserMarkerPin {
    pin: maplibregl.Marker;
    element: HTMLButtonElement;
    lngLat: [number, number];
}

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
    /** The trips the drawn lines leave out as too small; the dots show them. */
    farTrips: FarDotTrip[];
    dots: maplibregl.Marker[];
    /** Zoom step the dots are grouped for. */
    dotStep: number | null;
    /** The user's trip markers on their routes. */
    /** By marker id: a rebuild moves and relabels them in place, so focus and an open card survive. */
    userMarkers: Map<string, UserMarkerPin>;
    markersTimer: ReturnType<typeof setTimeout> | null;
    lastMarkersAt: number;
    markerPopup: maplibregl.Popup | null;
    /** The marker whose card is open. */
    markerPopupId: string | null;
    placeHandle: maplibregl.Marker | null;
    isDraggingHandle: boolean;
    /** The camera has shown the library at least once since following started. */
    hasFramed: boolean;
    /** No user touch since the start or the last "show all": new tracks may move the camera. */
    isFollowing: boolean;
    /**
     * A corridor request is in the worker. One at a time: a run can take
     * longer than the throttle, and requests queued behind it would each be
     * stale by the time they ran, holding the drawn lines back until the
     * library stops changing.
     */
    isBundleRunning: boolean;
    /** What changed while a request ran: it runs again once the answer is back. */
    bundleRerun: "none" | "throttled" | "urgent";
    requestedStep: number | null;
    /** The trips through the place the last request stressed, as a comparable key. */
    requestedPlaceKey: string;
    bundleTimer: ReturnType<typeof setTimeout> | null;
    lastBundleAt: number;
    areaTimer: ReturnType<typeof setTimeout> | null;
    probeFrame: number;
    probePoint: { point: maplibregl.Point; lngLat: maplibregl.LngLat } | null;
}

interface TripMapCallbacks {
    /** The map was turned on or off or became unavailable: the viewer placeholder must follow. */
    onSurfaceChange: () => void;
    /** Opens the trip at `tripIndex` paused at the moment of its marker `markerId`. */
    onOpenMarker: (tripIndex: number, markerId: string) => void;
    /** Reads a trip's GPS track that waits inside its videos, for "Read now". */
    readTripGps: TripGpsReader;
}

let callbacks: TripMapCallbacks = {
    onSurfaceChange: () => {},
    onOpenMarker: () => {},
    readTripGps: async () => "busy",
};
let view: TripMapView | null = null;
// Bumped by every creation attempt and teardown, so a creation still waiting
// for maplibre-gl gives up when the surface was hidden in the meantime.
let creation = 0;
// No WebGL context: the map stays off for the session and the viewer keeps
// its plain placeholder.
let isUnavailable = false;
/** The trip under the pointer in the list, drawn on top of everything. Held by
 *  object: a regroup renumbers the trips while the pointer rests on a row. */
let highlightedTrip: Trip | null = null;
/** The button by the search laid the map over the open trip. */
let isOverTrip = false;
/** The marker whose card is open, for focus when Escape closes the card. */
let markerCardOpener: HTMLElement | null = null;
/** Viewer layers this map made inert while it covers the open trip. */
let coveredLayers: HTMLElement[] = [];
/** On phones the trip list panel shows the list or the map; not remembered between sessions. */
let phoneTab: "list" | "map" = "list";

/** The viewer surface can exist here: a WebGL context works and the layout is not the phone one. */
export function isTripMapAvailable(): boolean {
    return !isUnavailable && !isMobileLayout();
}

function shouldShowTripMap(): boolean {
    if (isUnavailable || state.trips.length === 0) return false;
    // A map in a closed drawer would only hold a graphics context.
    if (isMobileLayout()) return phoneTab === "map" && isTripListOnScreen();
    if (state.active === null) return getTripMapPreferences().isShownWithoutTrip;
    return isOverTrip;
}

/**
 * Shows or hides the map in the viewer and keeps its tracks current.
 * Idempotent; called whenever the trips, the open trip, export mode or the
 * preference change.
 */
export function syncTripMap(): void {
    const isPhone = isMobileLayout();
    // The map over a trip belongs to that trip outside export: without an
    // open trip, in export or on the phone layout it is gone for good.
    if (state.active === null || state.exportModeOpen || !isTripMapAvailable()) isOverTrip = false;
    placeSurface(isPhone);
    const isShown = shouldShowTripMap();
    const isInViewer = isShown && !isPhone;
    const isCoveringTrip = isInViewer && state.active !== null;
    dom.viewer.classList.toggle("has-trip-map", isInViewer);
    dom.viewer.classList.toggle("has-trip-map-over-trip", isCoveringTrip);
    coverTrip(isCoveringTrip);
    syncPhoneView(isPhone);
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

/**
 * The map surface lives in the viewer on desktop and in the trip list panel
 * on phones. A MapLibre instance does not survive its container moving, so a
 * layout change recreates it.
 */
function placeSurface(isPhone: boolean): void {
    const host = isPhone ? dom.tripMapPanel : dom.viewer;
    if (dom.tripMapState.parentElement === host) return;
    destroyView();
    if (isPhone) dom.tripMapPanel.prepend(dom.tripMapState);
    else dom.tripPreparation.before(dom.tripMapState);
}

/**
 * Phone tabs and the sheet. On the map tab the list and the place bar move
 * into the sheet: the same elements, so their delegated handlers and the
 * list's renders keep working without a copy.
 */
function syncPhoneView(isPhone: boolean): void {
    const hasTabs = isPhone && !isUnavailable;
    dom.tripViewTabs.hidden = !hasTabs;
    const isMapTab = hasTabs && phoneTab === "map";
    for (const [tab, isSelected] of [
        [dom.tripViewList, !isMapTab],
        [dom.tripViewMap, isMapTab],
    ] as const) {
        tab.setAttribute("aria-selected", String(isSelected));
        tab.tabIndex = isSelected ? 0 : -1;
    }
    dom.sidebar.classList.toggle("is-trip-map-view", isMapTab);
    dom.tripMapPanel.hidden = !isMapTab;
    if (isMapTab) {
        if (dom.list.parentElement !== dom.tripMapSheetList) dom.tripMapSheetList.append(dom.list);
        if (dom.tripPlaceBar.parentElement !== dom.tripMapSheetHead) dom.tripMapSheetHead.append(dom.tripPlaceBar);
    } else {
        if (dom.list.parentElement !== dom.sidebar) dom.tripAnalysisStatus.after(dom.list);
        if (dom.tripPlaceBar.parentElement !== dom.tripFilters) dom.tripFilterTray.before(dom.tripPlaceBar);
    }
    syncSheet();
}

/** Without a place the sheet invites a tap; with one it holds the list of trips through it. */
function syncSheet(): void {
    const place = tripMapPlace();
    dom.tripMapSheet.classList.toggle("has-place", place !== null);
    dom.tripMapSheetIdle.hidden = place !== null;
    dom.tripMapSheetList.hidden = place === null;
    if (place) return;
    const inArea = tripMapAreaCount();
    const hint = t("tripMap.sheet.hint");
    dom.tripMapSheetIdle.textContent = inArea === null ? hint : `${t("tripMap.sheet.inArea", { n: inArea })} ${hint}`;
}

function setPhoneTab(tab: "list" | "map"): void {
    if (phoneTab === tab) return;
    phoneTab = tab;
    syncTripMap();
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
    if (fitWorldBounds(view, libraryBounds(readyTracks()), framePadding(), FOLLOW_FIT_DURATION_MS))
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
        // Without the library there is no map this session: give the viewer
        // its placeholder back instead of an empty surface.
        markUnavailable(error, "trip map library failed to load");
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
        farTrips: [],
        dots: [],
        dotStep: null,
        userMarkers: new Map(),
        markersTimer: null,
        lastMarkersAt: 0,
        markerPopup: null,
        markerPopupId: null,
        placeHandle: null,
        isDraggingHandle: false,
        hasFramed: false,
        isFollowing: true,
        isBundleRunning: false,
        bundleRerun: "none",
        requestedStep: null,
        requestedPlaceKey: "",
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
    // Drags, pinches and arrow-key pans all start a move with the user's event.
    map.on("movestart", noteUserMove);
    map.on("zoomstart", noteUserMove);
    map.on("wheel", () => {
        stopFollowing(current);
    });
    map.on("dblclick", () => {
        stopFollowing(current);
    });
    map.on("zoom", () => {
        const zoom = map.getZoom();
        if (bundleStepForZoom(zoom) !== current.requestedStep) scheduleBundle(current);
        // Past the bundle's last step the lines stay; only the dots regroup.
        else if (zoomStepForZoom(zoom) !== current.dotStep) renderDots(current);
    });
    map.on("moveend", () => scheduleAreaUpdate(current));
    map.on("resize", () => {
        // A map created while the trip preparation hid it had no size to
        // frame the library in; it frames it once it shows.
        if (!current.hasFramed) followLibrary(current);
        scheduleAreaUpdate(current);
    });
    map.on("mousemove", (event) => {
        // Over a dot, a marker or the radius handle the pointer means that control.
        const isOverRoads = event.originalEvent.target === map.getCanvas();
        current.probePoint = isOverRoads ? { point: event.point, lngLat: event.lngLat } : null;
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
        choosePlace(current, countTripsThrough(circle) > 0 ? circle : null);
        hideProbe(current);
    });
    registerViewerMap({
        map,
        surface: "trips",
        attribution,
        // The style is gone with the context: writes wait for the restore's style.load.
        onContextLost: () => {
            current.isStyleReady = false;
        },
    });
    followLibrary(current);
    scheduleBundle(current);
    syncTripMapStatus();
    renderPlace(current);
    renderUserMarkers(current);
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
    if (current.markersTimer !== null) clearTimeout(current.markersTimer);
    for (const { pin } of current.userMarkers.values()) pin.remove();
    current.markerPopup?.remove();
    current.placeHandle?.remove();
    hideProbe(current);
    closeReadPanel();
    // remove() also takes the map out of the viewer map registry.
    current.map.remove();
    // A hidden map no longer frames the list.
    setTripMapFrame(null);
}

function markUnavailable(error?: unknown, reason = "trip map unavailable: no WebGL context"): void {
    if (isUnavailable) return;
    isUnavailable = true;
    log.warn(reason, error instanceof Error ? error : { error: String(error) });
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

/** The part of the map the phone sheet covers at the bottom; 0 on desktop. */
function sheetOverlapPx(): number {
    return isMobileLayout() ? dom.tripMapSheet.offsetHeight : 0;
}

/** Room around the framed library: the sheet's height comes on top at the bottom. */
function framePadding(
    desktopPx = FRAME_PADDING_PX,
    phonePx = PHONE_FRAME_PADDING_PX,
): Required<maplibregl.PaddingOptions> {
    const base = isMobileLayout() ? phonePx : desktopPx;
    return { top: base, right: base, bottom: base + sheetOverlapPx(), left: base };
}

/** Fits `bounds`, no closer than `maxZoom`, when the container is large enough to hold the padding. */
function fitWorldBounds(
    current: TripMapView,
    bounds: WorldBounds,
    padding: Required<maplibregl.PaddingOptions>,
    durationMs: number,
    maxZoom = FRAME_MAX_ZOOM,
): boolean {
    if (isEmptyBounds(bounds)) return false;
    const container = current.map.getContainer();
    if (container.clientWidth <= padding.left + padding.right || container.clientHeight <= padding.top + padding.bottom)
        return false;
    current.map.fitBounds(lngLatBounds(bounds), {
        padding,
        maxZoom,
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
        viewportHeight: container.clientHeight - sheetOverlapPx(),
    });
    if (!isNeeded) return;
    const isStart = !current.hasFramed;
    const padding = isStart ? framePadding() : framePadding(FOLLOW_FIT_PADDING_PX, PHONE_FOLLOW_FIT_PADDING_PX);
    if (fitWorldBounds(current, bounds, padding, isStart ? 0 : FOLLOW_FIT_DURATION_MS)) current.hasFramed = true;
}

/** The visible frame in world coordinates; may extend past the world's edges. */
function viewFrame(current: TripMapView): WorldBounds {
    const container = current.map.getContainer();
    // Routes under the phone sheet are out of view. The map never rotates or
    // tilts, so two corners make the frame.
    const topLeft = current.map.unproject([0, 0]);
    const bottomRight = current.map.unproject([
        container.clientWidth,
        Math.max(1, container.clientHeight - sheetOverlapPx()),
    ]);
    return {
        minX: worldX(topLeft.lng),
        minY: worldY(topLeft.lat),
        maxX: worldX(bottomRight.lng),
        maxY: worldY(bottomRight.lat),
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
        // Hidden while a trip is prepared: the collapsed canvas is no frame,
        // and the list keeps the last one until the map shows again.
        const container = current.map.getContainer();
        if (view !== current || container.clientWidth === 0 || container.clientHeight === 0) return;
        setTripMapFrame(viewFrame(current));
    }, AREA_SETTLE_MS);
}

function scheduleBundle(current: TripMapView, isUrgent = false): void {
    if (current.isBundleRunning) {
        if (isUrgent) current.bundleRerun = "urgent";
        else if (current.bundleRerun === "none") current.bundleRerun = "throttled";
        return;
    }
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

/** The trips through the chosen place, as a key that changes only when they do. */
function placeKey(): string {
    if (!tripMapPlace()) return "-";
    return [...tripMapPlaceIds()].sort((a, b) => a - b).join(",");
}

async function refreshBundle(current: TripMapView): Promise<void> {
    if (view !== current) return;
    current.isBundleRunning = true;
    try {
        await computeBundle(current);
    } finally {
        current.isBundleRunning = false;
        const rerun = current.bundleRerun;
        current.bundleRerun = "none";
        if (rerun !== "none" && view === current) scheduleBundle(current, rerun === "urgent");
    }
}

/**
 * Recomputes corridor lines and far dots for the current zoom step, library
 * and place. An answer that arrives after something changed is still drawn:
 * it is newer than what the map shows, and the rerun follows it.
 */
async function computeBundle(current: TripMapView): Promise<void> {
    current.lastBundleAt = performance.now();
    const step = bundleStepForZoom(current.map.getZoom());
    const tracks = readyTracks();
    const far = farTrips(
        tracks.map(({ id, track }) => ({ id, bounds: track.bounds })),
        step,
    );
    // A folded trip is drawn as its dot only; its few-pixel line would be noise.
    const folded = new Set(far.map(({ id }) => id));
    const ids = tracks.filter(({ id }) => !folded.has(id)).map(({ id }) => id);
    const placeIds = tripMapPlace() ? tripMapPlaceIds() : null;
    const matchedIds = placeIds ? ids.filter((id) => placeIds.has(id)) : [];
    current.requestedStep = step;
    current.requestedPlaceKey = placeKey();
    let bundle: TripBundle;
    let matchedBundle: TripBundle | null = null;
    try {
        bundle = await requestTripMapBundle(step, ids);
        if (matchedIds.length > 0) matchedBundle = await requestTripMapBundle(step, matchedIds);
    } catch (error) {
        if (view === current)
            log.warn("trip map corridors failed", error instanceof Error ? error : { error: String(error) });
        return;
    }
    if (view !== current) return;
    current.bundle = bundle;
    current.matchedBundle = matchedBundle;
    current.farTrips = far;
    renderLines(current);
    renderDots(current);
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

/** This map's own layers, top first, then their sources. */
function ownLayerIds(): { layers: string[]; sources: string[] } {
    const corridor = (layers: CorridorLayers): string[] => [layers.core, layers.outline, layers.halo];
    return {
        layers: [
            HIGHLIGHT_POINTS_LAYER_ID,
            HIGHLIGHT_CORE_LAYER_ID,
            HIGHLIGHT_OUTLINE_LAYER_ID,
            PLACE_LINE_LAYER_ID,
            PLACE_EDGE_LAYER_ID,
            ...corridor(MATCHED_LAYERS),
            PLACE_FILL_LAYER_ID,
            ...corridor(BASE_LAYERS),
        ],
        sources: [HIGHLIGHT_SOURCE_ID, MATCHED_LAYERS.source, PLACE_SOURCE_ID, BASE_LAYERS.source],
    };
}

function addLayers(current: TripMapView): void {
    const { map } = current;
    // A restored WebGL context brings back the old style with these layers and
    // their data from before the loss; rebuild them from the current results.
    const own = ownLayerIds();
    for (const id of own.layers) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of own.sources) if (map.getSource(id)) map.removeSource(id);
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

/**
 * Calls `onPress` for a click on a dot or a marker that was not a pan. MapLibre
 * starts dragging the map from a press anywhere in its canvas container, the
 * element rides along under the pointer, and the release still clicks it; the
 * map's own click drops such a release by its travel, and so does this.
 */
function onPressWithoutPan(element: HTMLElement, onPress: (event: MouseEvent) => void): void {
    let pressedAt: { x: number; y: number } | null = null;
    element.addEventListener("pointerdown", (event) => {
        pressedAt = { x: event.clientX, y: event.clientY };
    });
    element.addEventListener("click", (event) => {
        const start = pressedAt;
        pressedAt = null;
        // A keyboard click (detail 0) has no press and no travel.
        const travel = start && event.detail !== 0 ? Math.hypot(event.clientX - start.x, event.clientY - start.y) : 0;
        if (travel >= MAP_CLICK_TOLERANCE_PX) return;
        onPress(event);
    });
}

/** Groups the trips the drawn lines left out into dots at the camera's own zoom step. */
function renderDots(current: TripMapView): void {
    const zoomStep = zoomStepForZoom(current.map.getZoom());
    current.dotStep = zoomStep;
    for (const marker of current.dots) marker.remove();
    current.dots = groupFarDots(current.farTrips, zoomStep).map((dot) => {
        const count = dot.tripIds.length;
        const element = document.createElement("button");
        element.type = "button";
        element.className = "trip-map-dot";
        element.style.setProperty("--trip-map-dot-size", `${farDotRadiusPx(count) * 2}px`);
        if (count > 1) element.textContent = String(count);
        const label = t("tripMap.dot", { n: count });
        element.title = label;
        element.setAttribute("aria-label", label);
        onPressWithoutPan(element, (event) => {
            event.stopPropagation();
            zoomToDot(current, dot);
        });
        return new current.maplibre.Marker({ element })
            .setLngLat([worldToLon(dot.x), worldToLat(dot.y)])
            .addTo(current.map);
    });
}

/**
 * The user's markers of the drawn trips, each on its trip's route at the
 * marker's moment. Rebuilt whenever markers, tracks or the list's scope
 * change; a library holds tens of markers, not thousands.
 */
/**
 * Track arrivals redraw the markers at most every BUNDLE_MIN_INTERVAL_MS:
 * finding every marker's trip walks the whole library.
 */
function scheduleUserMarkers(current: TripMapView): void {
    if (current.markersTimer !== null) return;
    const wait = Math.max(0, current.lastMarkersAt + BUNDLE_MIN_INTERVAL_MS - performance.now());
    current.markersTimer = setTimeout(() => {
        current.markersTimer = null;
        if (view === current) renderUserMarkers(current);
    }, wait);
}

function renderUserMarkers(current: TripMapView): void {
    current.lastMarkersAt = performance.now();
    const isShown = getTripMapPreferences().shouldShowMarkers;
    dom.tripMapMarkers.setAttribute("aria-pressed", String(isShown));
    const placed = new Map<string, { title: string; lngLat: [number, number] }>();
    if (isShown) {
        const indexByTrip = new Map(state.trips.map((trip, index) => [trip, index]));
        const inScope = new Set(tripMapScope());
        const entries = tripMapEntries();
        for (const { marker, trip } of markersWithTrips()) {
            const index = indexByTrip.get(trip);
            const track = index === undefined || !inScope.has(index) ? null : entries[index]?.track;
            const position = track ? trackPositionAt(track, marker.utc / 1000) : null;
            if (!position) continue;
            const text = marker.text || t("marker.untitled");
            placed.set(marker.id, {
                title: `${text} · ${formatMarkerMoment(trip, marker.utc / 1000).date}`,
                lngLat: [worldToLon(position.x), worldToLat(position.y)],
            });
        }
    }
    for (const [id, item] of current.userMarkers) {
        if (placed.has(id)) continue;
        item.pin.remove();
        current.userMarkers.delete(id);
        // A card must not outlive its marker: deleted, or its trip left the list.
        if (current.markerPopupId === id) current.markerPopup?.remove();
    }
    for (const [id, next] of placed) {
        let item = current.userMarkers.get(id);
        if (!item) {
            const element = document.createElement("button");
            element.type = "button";
            element.className = "trip-map-user-marker";
            element.innerHTML = USER_MARKER_ICON;
            const created: UserMarkerPin = {
                pin: new current.maplibre.Marker({ element }),
                element,
                lngLat: next.lngLat,
            };
            onPressWithoutPan(element, (event) => {
                // The map's own click would close the card this opens.
                event.stopPropagation();
                // A touch: arriving tracks must not move the camera and close the card.
                stopFollowing(current);
                openMarkerCard(current, id, created.lngLat, element);
            });
            created.pin.setLngLat(next.lngLat).addTo(current.map);
            current.userMarkers.set(id, created);
            item = created;
        } else if (item.lngLat[0] !== next.lngLat[0] || item.lngLat[1] !== next.lngLat[1]) {
            item.lngLat = next.lngLat;
            item.pin.setLngLat(next.lngLat);
        }
        item.element.title = next.title;
        item.element.setAttribute("aria-label", next.title);
    }
}

/** A marker's card: its text, its moment in the trip, and a button that opens the trip there. */
function openMarkerCard(current: TripMapView, markerId: string, lngLat: [number, number], opener: HTMLElement): void {
    const located = markersWithTrips().find((item) => item.marker.id === markerId);
    if (!located) return;
    const { marker, trip } = located;
    const moment = formatMarkerMoment(trip, marker.utc / 1000);
    const card = document.createElement("div");
    card.className = "trip-map-marker-card";
    const title = document.createElement("strong");
    title.textContent = marker.text || t("marker.untitled");
    const detail = document.createElement("p");
    detail.textContent = moment.detail;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "dc-btn dc-btn--primary";
    open.textContent = t("tripMap.marker.open", { time: moment.clock });
    card.append(title, detail, open);
    current.markerPopup?.remove();
    const popup = new current.maplibre.Popup({
        className: "ez-popup trip-map-marker-popup",
        closeButton: false,
        // Any camera move puts the card away, the way the prototype does.
        closeOnMove: true,
        maxWidth: "none",
        offset: 14,
    })
        .setLngLat(lngLat)
        .setDOMContent(card)
        .addTo(current.map);
    current.markerPopup = popup;
    current.markerPopupId = markerId;
    hideProbe(current);
    popup.on("close", () => {
        if (current.markerPopup !== popup) return;
        current.markerPopup = null;
        current.markerPopupId = null;
    });
    open.addEventListener("click", () => {
        popup.remove();
        // Regrouping can move the marker to another trip index since the card opened.
        const latest = markersWithTrips().find((item) => item.marker.id === markerId);
        const tripIndex = latest ? state.trips.indexOf(latest.trip) : -1;
        if (latest && tripIndex >= 0) callbacks.onOpenMarker(tripIndex, markerId);
    });
    markerCardOpener = opener;
    open.focus({ preventScroll: true });
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
        framePadding(DOT_ZOOM_PADDING_PX),
        0,
        DOT_ZOOM_MAX,
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
    if (view !== current || !probe || tripMapPlace() || current.markerPopup) {
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
        choosePlace(current, { ...place, radiusMeters: radiusWorld * groundMetersPerWorldUnit(place.y) });
    });
    handle.on("dragend", () => {
        current.isDraggingHandle = false;
        renderPlace(current);
        syncPlaceControls();
    });
    return handle;
}

/**
 * Chooses (or with null, clears) the place from the map. The search speaks up
 * only when the matching trips or their pass times change, and a new circle
 * often keeps both: near a route's end or a stop the closest point stays the
 * same vertex, and a drag changes only the radius. The circle, its handle and
 * the radius label follow every choice here instead.
 */
function choosePlace(current: TripMapView, next: PlaceCircle | null): void {
    setTripMapPlace(next);
    renderPlace(current);
    syncPlaceControls();
}

/** A chosen place lifts the phone sheet; a circle tapped low on the map would end up under it. */
function keepPlaceAboveSheet(current: TripMapView): void {
    const place = tripMapPlace();
    const overlap = sheetOverlapPx();
    if (!place || overlap === 0) return;
    const centre = current.map.project([worldToLon(place.x), worldToLat(place.y)]);
    const visibleBottom = current.map.getContainer().clientHeight - overlap;
    const lowest = visibleBottom - PHONE_FRAME_PADDING_PX * 2;
    if (centre.y <= lowest) return;
    current.map.panBy([0, centre.y - visibleBottom / 2], { duration: prefersReducedMotion() ? 0 : 250 });
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
    const tripIndex = highlightedTrip ? state.trips.indexOf(highlightedTrip) : -1;
    if (tripIndex < 0) return empty;
    const track = tripMapEntries()[tripIndex]?.track;
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
    for (const pass of tripMapPassesFor(tripIndex)) {
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
 * how many trips have a route on the map. With trips missing from the map the
 * counter opens a panel that says why and offers "Read now"; while that reads,
 * the counter shows its progress.
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
    const isReadingRecordings = state.recordingAnalysisProgress !== null && read < total;
    const readNow = isReadingRecordings ? null : trackReadProgress();
    const isReading = isReadingRecordings || readNow !== null;
    dom.tripMapCounter.hidden = false;
    dom.tripMapCounterText.textContent = readNow
        ? t("tripMap.reading", { n: readNow.done, total: readNow.total })
        : isReadingRecordings
          ? t("tripMap.reading", { n: read, total })
          : t("tripMap.counter", { n: onMap, total });
    dom.tripMapCounter.classList.toggle("has-untracked", !isReading && onMap < total);
    dom.tripMapCounter.classList.toggle("is-reading", isReading);
    dom.tripMapCounterBar.hidden = !isReading;
    const share = readNow ? readNow.done / readNow.total : total > 0 ? read / total : 0;
    dom.tripMapCounterFill.style.transform = `scaleX(${share})`;
    // The recordings' own read settles most missing routes by itself; the
    // panel only has something to say once it is over.
    const canExplain = !isReadingRecordings && (readNow !== null || onMap < total);
    dom.tripMapCounter.disabled = !canExplain;
    if (canExplain) syncReadPanel();
    else closeReadPanel();
    const isFollowingReads = isReading && view.isFollowing;
    // A toggle only while there is something to follow.
    if (isReading) dom.tripMapFit.setAttribute("aria-pressed", String(isFollowingReads));
    else dom.tripMapFit.removeAttribute("aria-pressed");
    const fitLabel = t(isFollowingReads ? "tripMap.fit.following" : isReading ? "tripMap.fit.resume" : "tripMap.fit");
    dom.tripMapFit.title = fitLabel;
    dom.tripMapFit.setAttribute("aria-label", fitLabel);
}

function isReadPanelOpen(): boolean {
    return !dom.tripMapReadPanel.hidden;
}

function openReadPanel(): void {
    dom.tripMapReadPanel.hidden = false;
    dom.tripMapCounter.setAttribute("aria-expanded", "true");
    syncReadPanel();
}

/** Closes the panel; focus inside it goes back to the counter, or to the map once the counter has nothing to open. */
function closeReadPanel(): void {
    if (!isReadPanelOpen()) return;
    const hadFocus = dom.tripMapReadPanel.contains(document.activeElement);
    dom.tripMapReadPanel.hidden = true;
    dom.tripMapCounter.setAttribute("aria-expanded", "false");
    if (!hadFocus) return;
    (dom.tripMapCounter.disabled ? dom.tripMapState : dom.tripMapCounter).focus({ preventScroll: true });
}

/** Why trips are missing from the map, and "Read now" (or "Stop" while it reads). */
function syncReadPanel(): void {
    if (!isReadPanelOpen()) return;
    const counts = untrackedTrips();
    const isRunning = trackReadProgress() !== null;
    if (!isRunning && counts.withoutGps === 0 && counts.unread === 0) {
        closeReadPanel();
        return;
    }
    dom.tripMapReadNoGps.hidden = counts.withoutGps === 0;
    dom.tripMapReadNoGps.textContent = t("tripMap.read.noGps", { n: counts.withoutGps });
    dom.tripMapReadUnread.hidden = counts.unread === 0;
    dom.tripMapReadUnread.textContent = t("tripMap.read.unread", { n: counts.unread });
    const isButtonGone = !isRunning && counts.unread === 0;
    if (isButtonGone && document.activeElement === dom.tripMapReadNow)
        dom.tripMapCounter.focus({ preventScroll: true });
    dom.tripMapReadNow.hidden = isButtonGone;
    dom.tripMapReadNow.textContent = t(isRunning ? "tripMap.read.stop" : "tripMap.read.now");
    dom.tripMapReadNow.classList.toggle("dc-btn--primary", !isRunning);
    dom.tripMapReadNow.classList.toggle("dc-btn--secondary", isRunning);
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
    scheduleUserMarkers(current);
}

function onSearchChange(): void {
    syncPlaceControls();
    syncSheet();
    const current = view;
    if (!current) return;
    renderPlace(current);
    renderHighlight();
    // The matched corridors depend on the trips through the place; recompute
    // them now, not on the throttle. A pan that only changed the trips in
    // frame leaves the lines as they are.
    if (placeKey() !== current.requestedPlaceKey) scheduleBundle(current, true);
}

function showTripMapFromCard(): void {
    setShownWithoutTrip(true);
    // The card and its button are gone; keep the focus in the viewer.
    dom.tripMapState.focus({ preventScroll: true });
}

function setHighlightedTrip(trip: Trip | null): void {
    if (trip === highlightedTrip) return;
    highlightedTrip = trip;
    renderHighlight();
}

/** Wires the controls once at startup; the map itself is created on first show. */
export function initTripMap(cb: TripMapCallbacks): void {
    callbacks = cb;
    subscribeTripMapPreferences(() => {
        syncTripMap();
        callbacks.onSurfaceChange();
        if (view) renderUserMarkers(view);
    });
    subscribeMarkers(() => {
        if (view) renderUserMarkers(view);
    });
    window.matchMedia?.(MOBILE_LAYOUT_QUERY).addEventListener("change", () => {
        syncTripMap();
        callbacks.onSurfaceChange();
    });
    // On phones the map lives in the drawer: it exists only while the drawer
    // or the browse list is on screen.
    subscribeTripListPlacement(syncTripMap);
    dom.tripViewList.addEventListener("click", () => setPhoneTab("list"));
    dom.tripViewMap.addEventListener("click", () => setPhoneTab("map"));
    // Arrow keys move between the two tabs (WAI-ARIA tabs pattern).
    dom.tripViewTabs.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End")
            return;
        event.preventDefault();
        const next = phoneTab === "list" ? "map" : "list";
        const target = event.key === "Home" ? "list" : event.key === "End" ? "map" : next;
        setPhoneTab(target);
        (target === "map" ? dom.tripViewMap : dom.tripViewList).focus({ preventScroll: true });
    });
    // The phone sheet covers the bottom of the map: the credits and the scale
    // ride above it, and routes under it leave the area filter's frame.
    new ResizeObserver(() => {
        dom.tripMapPanel.style.setProperty("--trip-map-sheet-overlap", `${dom.tripMapSheet.offsetHeight}px`);
        if (!view) return;
        keepPlaceAboveSheet(view);
        scheduleAreaUpdate(view);
    }).observe(dom.tripMapSheet);
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
        // The trip being prepared owns the viewer; its card keeps the Cancel button.
        if (dom.viewer.classList.contains("preparing")) return;
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
    // The panel and the card close before anything else hears Escape: on a
    // phone the drawer holding the map would close with them.
    document.addEventListener(
        "keydown",
        (event) => {
            if (event.key !== "Escape" || event.defaultPrevented || isAnyModalOpen()) return;
            if (isReadPanelOpen()) {
                event.preventDefault();
                closeReadPanel();
            } else if (view?.markerPopup) {
                event.preventDefault();
                view.markerPopup.remove();
                if (markerCardOpener?.isConnected) markerCardOpener.focus({ preventScroll: true });
                markerCardOpener = null;
            }
        },
        true,
    );
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || event.defaultPrevented || isAnyModalOpen()) return;
        // Escape in the search clears the search.
        if (!isOverTrip || isTextEntry(event.target)) return;
        event.preventDefault();
        returnToVideo();
    });
    document.getElementById("empty-state-card")?.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest('[data-action="show-trip-map"]'))
            showTripMapFromCard();
    });
    subscribeTrackRead(syncTripMapStatus);
    dom.tripMapCounter.addEventListener("click", () => {
        if (isReadPanelOpen()) closeReadPanel();
        else openReadPanel();
    });
    dom.tripMapReadNow.addEventListener("click", () => {
        if (trackReadProgress()) stopReadingTracks();
        else startReadingTracks(callbacks.readTripGps);
    });
    // A press anywhere else puts the panel away, the way a menu goes.
    document.addEventListener("pointerdown", (event) => {
        if (!isReadPanelOpen() || !(event.target instanceof Node)) return;
        if (dom.tripMapReadPanel.contains(event.target) || dom.tripMapCounter.contains(event.target)) return;
        closeReadPanel();
    });
    dom.tripMapFit.addEventListener("click", showAllTripsOnMap);
    dom.tripMapMarkers.addEventListener("click", () => {
        const preferences = getTripMapPreferences();
        setTripMapPreferences({ ...preferences, shouldShowMarkers: !preferences.shouldShowMarkers });
    });
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
        // The bar is gone. On a phone the search would bring up the keyboard
        // over the map, so focus stays with the map tab there.
        (isMobileLayout() ? dom.tripViewMap : dom.tripSearch).focus({ preventScroll: true });
    });

    // Hovering a trip in the list shows where it went.
    dom.list.addEventListener("pointerover", (event) => {
        const row = event.target instanceof Element ? event.target.closest<HTMLElement>("li.trip") : null;
        const index = row?.dataset.tripIndex === undefined ? null : Number(row.dataset.tripIndex);
        setHighlightedTrip(index !== null && Number.isInteger(index) ? (state.trips[index] ?? null) : null);
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
